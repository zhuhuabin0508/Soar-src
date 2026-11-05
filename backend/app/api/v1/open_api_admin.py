"""API 开放平台管理路由（管理员使用，JWT + 权限矩阵 ``open_api`` 模块）。

- 应用/密钥/授权 CRUD（密钥明文仅创建与重置时一次性返回）
- 资源目录（可授权的开放资源）
- 调用统计看板（时间序列/按应用/按资源聚合/成功率/耗时）
- 调用日志查询

所有管理写操作记录审计日志（resource_type=open_api_app）。
"""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from app.core.audit import log_audit
from app.core.open_api_auth import generate_key_pair, hash_secret
from app.core.open_api_registry import OPEN_API_RESOURCES, resource_catalog
from app.core.timezone import BEIJING_TZ, beijing_now, to_beijing_iso
from app.database import get_db
from app.dependencies import require_permission
from app.models.open_api import OpenApiApp, OpenApiCallLog, OpenApiScope
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/open-admin", tags=["open-api-admin"])


# ============ 请求体模型 ============

class AppCreateBody(BaseModel):
    app_name: str = Field(..., min_length=2, max_length=64, description="应用名称（唯一）")
    description: str = Field("", max_length=255)
    resource_codes: list[str] = Field(default_factory=list, description="授权资源编码列表")
    rate_limit_per_minute: int = Field(60, ge=1, le=10000, description="每分钟调用配额")
    allowed_ips: list[str] = Field(default_factory=list, description="IP 白名单（空=不限）")
    expires_at: Optional[str] = Field(None, description="过期时间（可选，ISO/日期字符串）")


class AppUpdateBody(BaseModel):
    app_name: Optional[str] = Field(None, min_length=2, max_length=64)
    description: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field(None, pattern="^(active|disabled)$")
    rate_limit_per_minute: Optional[int] = Field(None, ge=1, le=10000)
    allowed_ips: Optional[list[str]] = None
    expires_at: Optional[str] = None
    resource_codes: Optional[list[str]] = None
    clear_expires: bool = Field(False, description="清除过期时间（expires_at 传空时配合使用）")


# ============ 工具 ============

def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """解析时间字符串（非法抛 400，区别于查询侧的容错忽略）。

    fromisoformat 优先完整解析：前缀截断的 strptime 分支会静默丢弃
    "+HH:MM" 时区偏移（按 naive 字面量直解导致最多 8 小时窗口偏移），
    仅在 fromisoformat 不支持时作为宽松格式兜底。
    """
    if value in (None, ""):
        return None
    dt: Optional[datetime] = None
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(str(value)[: len(fmt) + 2], fmt)
                break
            except ValueError:
                continue
    if dt is None:
        raise HTTPException(status_code=400, detail=f"时间格式错误: {value}") from None
    # aware → 北京时区 naive：DB 列为北京时间字面量（无 tzinfo），
    # 直接比较会依赖会话时区解释，导致过滤窗口偏移
    if dt.tzinfo is not None:
        dt = dt.astimezone(BEIJING_TZ).replace(tzinfo=None)
    return dt


def _validate_ips(ips: Optional[list[str]]) -> list[str]:
    """校验 IP 白名单格式（非法抛 400），返回去空格后的有效列表。

    后端必须兜底校验：白名单是安全判据，录错格式会导致全拒或校验失效。
    """
    import ipaddress

    cleaned = []
    for ip in ips or []:
        v = (ip or "").strip()
        if not v:
            continue
        try:
            ipaddress.ip_address(v)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"IP 白名单含非法地址: {v}")
        cleaned.append(v)
    return cleaned


def _validate_resource_codes(codes: list[str]) -> None:
    """校验授权资源编码全部在目录内。"""
    unknown = [c for c in codes if c not in OPEN_API_RESOURCES]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"未知的资源编码: {unknown}，可用编码见 GET /api/v1/open-admin/resources",
        )


def _app_dict(app: OpenApiApp, codes: list[str]) -> dict:
    try:
        allowed_ips = json.loads(app.allowed_ips or "[]")
    except (TypeError, ValueError):
        allowed_ips = []
    return {
        "id": app.id,
        "app_name": app.app_name,
        "description": app.description,
        "access_key": app.access_key,
        "status": app.status,
        "rate_limit_per_minute": app.rate_limit_per_minute,
        "allowed_ips": allowed_ips,
        "expires_at": to_beijing_iso(app.expires_at),
        "total_calls": app.total_calls,
        "last_call_at": to_beijing_iso(app.last_call_at),
        "created_by": app.created_by,
        "created_at": to_beijing_iso(app.created_at),
        "resource_codes": sorted(codes),
    }


def _app_scopes(db: Session, app_id: int) -> list[str]:
    return [
        row[0]
        for row in db.query(OpenApiScope.resource_code)
        .filter(OpenApiScope.app_id == app_id)
        .all()
    ]


def _log_admin_audit(db: Session, user: User, request: Request, action: str,
                      resource_id=None, detail=None, result: str = "success") -> None:
    from app.core.audit import get_client_ip

    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action=action,
        resource_type="open_api_app",
        resource_id=resource_id,
        detail=detail,
        ip_address=get_client_ip(request),
        result=result,
    )


# ============ 应用管理 ============

@router.get("/apps")
def list_apps(
    _user: User = Depends(require_permission("open_api", "view")),
    db: Session = Depends(get_db),
):
    """应用列表（含授权资源、调用统计；secret 绝不返回）。"""
    apps = db.query(OpenApiApp).order_by(OpenApiApp.id.desc()).all()
    # 一次查询取全部 scope，内存聚合避免 N+1
    scopes: dict[int, list[str]] = {}
    for row in db.query(OpenApiScope.app_id, OpenApiScope.resource_code).all():
        scopes.setdefault(row[0], []).append(row[1])
    return {
        "code": 0,
        "message": "ok",
        "data": {
            "items": [_app_dict(a, scopes.get(a.id, [])) for a in apps],
            "total": len(apps),
        },
    }


@router.post("/apps")
def create_app(
    body: AppCreateBody,
    request: Request,
    user: User = Depends(require_permission("open_api", "edit")),
    db: Session = Depends(get_db),
):
    """创建应用：生成密钥，**响应一次性返回 secret 明文**。"""
    _validate_resource_codes(body.resource_codes)
    if db.query(OpenApiApp).filter(OpenApiApp.app_name == body.app_name).first():
        raise HTTPException(status_code=400, detail=f"应用名称已存在: {body.app_name}")

    access_key, secret, secret_hash = generate_key_pair()
    app = OpenApiApp(
        app_name=body.app_name,
        description=body.description,
        access_key=access_key,
        secret_hash=secret_hash,
        status="active",
        rate_limit_per_minute=body.rate_limit_per_minute,
        allowed_ips=json.dumps(_validate_ips(body.allowed_ips), ensure_ascii=False),
        expires_at=_parse_dt(body.expires_at),
        created_by=user.id,
    )
    db.add(app)
    db.flush()
    for code in body.resource_codes:
        db.add(OpenApiScope(app_id=app.id, resource_code=code))
    db.commit()

    _log_admin_audit(db, user, request, "create", app.id,
                     {"app_name": app.app_name, "resource_codes": body.resource_codes})

    result = _app_dict(app, _app_scopes(db, app.id))
    result["secret"] = secret  # 仅此一次返回明文
    return {"code": 0, "message": "ok", "data": result}


@router.put("/apps/{app_id}")
def update_app(
    app_id: int,
    body: AppUpdateBody,
    request: Request,
    user: User = Depends(require_permission("open_api", "edit")),
    db: Session = Depends(get_db),
):
    """更新应用（名称/描述/状态/限流/白名单/过期时间/授权资源全量替换）。"""
    app = db.get(OpenApiApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="应用不存在")

    changes: dict = {}
    if body.app_name is not None and body.app_name != app.app_name:
        if db.query(OpenApiApp).filter(OpenApiApp.app_name == body.app_name, OpenApiApp.id != app_id).first():
            raise HTTPException(status_code=400, detail=f"应用名称已存在: {body.app_name}")
        changes["app_name"] = body.app_name
        app.app_name = body.app_name
    if body.description is not None:
        app.description = body.description
        changes["description"] = body.description
    if body.status is not None:
        changes["status"] = body.status
        app.status = body.status
    if body.rate_limit_per_minute is not None:
        changes["rate_limit_per_minute"] = body.rate_limit_per_minute
        app.rate_limit_per_minute = body.rate_limit_per_minute
    if body.allowed_ips is not None:
        valid_ips = _validate_ips(body.allowed_ips)
        changes["allowed_ips"] = valid_ips
        app.allowed_ips = json.dumps(valid_ips, ensure_ascii=False)
    if body.clear_expires:
        app.expires_at = None
        changes["expires_at"] = None
    elif body.expires_at is not None:
        app.expires_at = _parse_dt(body.expires_at)
        changes["expires_at"] = to_beijing_iso(app.expires_at)
    if body.resource_codes is not None:
        _validate_resource_codes(body.resource_codes)
        current = set(_app_scopes(db, app_id))
        target = set(body.resource_codes)
        for code in current - target:
            db.query(OpenApiScope).filter(
                OpenApiScope.app_id == app_id, OpenApiScope.resource_code == code
            ).delete(synchronize_session=False)
        for code in target - current:
            db.add(OpenApiScope(app_id=app_id, resource_code=code))
        changes["resource_codes"] = sorted(target)

    db.commit()
    if changes:
        _log_admin_audit(db, user, request, "update", app_id, changes)
    return {"code": 0, "message": "ok", "data": _app_dict(app, _app_scopes(db, app_id))}


@router.delete("/apps/{app_id}")
def delete_app(
    app_id: int,
    request: Request,
    user: User = Depends(require_permission("open_api", "edit")),
    db: Session = Depends(get_db),
):
    """删除应用（授权级联删除，调用日志保留）。"""
    app = db.get(OpenApiApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="应用不存在")
    name = app.app_name
    db.query(OpenApiScope).filter(OpenApiScope.app_id == app_id).delete(synchronize_session=False)
    db.delete(app)
    db.commit()
    _log_admin_audit(db, user, request, "delete", app_id, {"app_name": name})
    return {"code": 0, "message": "ok"}


@router.post("/apps/{app_id}/rotate-secret")
def rotate_secret(
    app_id: int,
    request: Request,
    user: User = Depends(require_permission("open_api", "edit")),
    db: Session = Depends(get_db),
):
    """重置密钥：旧 secret 立即失效，**响应一次性返回新 secret 明文**。"""
    app = db.get(OpenApiApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="应用不存在")

    access_key, secret, secret_hash = generate_key_pair()
    app.access_key = access_key
    app.secret_hash = secret_hash
    db.commit()
    _log_admin_audit(db, user, request, "rotate_secret", app_id, {"app_name": app.app_name})

    result = _app_dict(app, _app_scopes(db, app_id))
    result["secret"] = secret  # 仅此一次返回明文
    return {"code": 0, "message": "ok", "data": result}


# ============ 资源目录 ============

@router.get("/resources")
def list_resources(
    _user: User = Depends(require_permission("open_api", "view")),
):
    """全部可授权的开放资源目录（管理页勾选授权用）。"""
    return {
        "code": 0,
        "message": "ok",
        "data": {"items": resource_catalog(), "total": len(OPEN_API_RESOURCES)},
    }


# ============ 调用统计 ============

@router.get("/stats")
def get_stats(
    period: str = Query("24h", pattern="^(24h|7d)$", description="统计周期"),
    _user: User = Depends(require_permission("open_api", "view")),
    db: Session = Depends(get_db),
):
    """调用统计看板：概览卡片 + 时间序列 + 按应用/按资源聚合。"""
    now = beijing_now()
    if period == "24h":
        # 近 24 小时：按小时分桶
        period_start = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=23)
        step = timedelta(hours=1)
        fmt = "%H:00"
    else:
        # 近 7 天：按天分桶（对齐到 0 点）
        period_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)
        step = timedelta(days=1)
        fmt = "%m-%d"
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # ---- 分组聚合（SQL 端完成）：单条查询按（时间桶, 资源, 应用）分组，
    # 结果行数 = 桶数 × 资源数 × 应用数，远小于原始日志行数，
    # 避免高调用量周期（默认配额打满 7 天可达数十万行）全量载入内存
    unit = "hour" if period == "24h" else "day"
    bucket_col = func.date_trunc(unit, OpenApiCallLog.created_at).label("bucket")
    rows = (
        db.query(
            bucket_col,
            OpenApiCallLog.resource_code,
            OpenApiCallLog.app_id,
            OpenApiCallLog.app_name,
            func.count().label("calls"),
            func.sum(
                case(
                    (
                        and_(
                            OpenApiCallLog.status_code >= 200,
                            OpenApiCallLog.status_code < 300,
                        ),
                        1,
                    ),
                    else_=0,
                )
            ).label("success"),
            func.coalesce(func.sum(OpenApiCallLog.response_ms), 0).label("ms_sum"),
        )
        .filter(OpenApiCallLog.created_at >= period_start)
        .group_by(bucket_col, OpenApiCallLog.resource_code, OpenApiCallLog.app_id, OpenApiCallLog.app_name)
        .all()
    )

    # ---- 概览 ----
    today_calls = (
        db.query(func.count(OpenApiCallLog.id))
        .filter(OpenApiCallLog.created_at >= today_start)
        .scalar()
        or 0
    )
    total_calls = sum(r.calls for r in rows)
    success_calls = sum(r.success or 0 for r in rows)
    avg_ms = round(sum(r.ms_sum or 0 for r in rows) / total_calls, 1) if total_calls else 0
    active_apps = len({r.app_id for r in rows if r.app_id is not None})

    # ---- 时间序列 ----
    buckets: dict[datetime, dict] = {}
    t = period_start
    while t <= now:
        buckets[t] = {"label": t.strftime(fmt), "total": 0, "success": 0, "failed": 0}
        t += step
    for r in rows:
        b = buckets.get(r.bucket)
        if b is None:
            continue
        success = r.success or 0
        b["total"] += r.calls
        b["success"] += success
        b["failed"] += r.calls - success
    timeseries = list(buckets.values())

    # ---- 按资源 / 按应用聚合 ----
    by_resource: dict[str, dict] = {}
    by_app: dict = {}
    for r in rows:
        success = r.success or 0
        rc = r.resource_code or "unknown"
        agg = by_resource.setdefault(rc, {"resource_code": rc, "calls": 0, "success": 0, "response_ms_sum": 0})
        agg["calls"] += r.calls
        agg["success"] += success
        agg["response_ms_sum"] += r.ms_sum or 0
        if r.app_id is not None:
            aagg = by_app.setdefault(
                r.app_id,
                {
                    "app_id": r.app_id,
                    "app_name": r.app_name,
                    "calls": 0,
                    "success": 0,
                    "response_ms_sum": 0,
                    "_bucket": r.bucket,
                },
            )
            aagg["calls"] += r.calls
            aagg["success"] += success
            aagg["response_ms_sum"] += r.ms_sum or 0
            # 周期内应用改名时取最近一次调用的名称快照（旧行为取首行随机名）
            if r.bucket > aagg["_bucket"]:
                aagg["_bucket"] = r.bucket
                aagg["app_name"] = r.app_name

    def _finalize(d: dict) -> list[dict]:
        out = []
        for v in d.values():
            v["success_rate"] = round(v["success"] / v["calls"] * 100, 1) if v["calls"] else 0
            v["avg_response_ms"] = round(v["response_ms_sum"] / v["calls"], 1) if v["calls"] else 0
            out.append({k: val for k, val in v.items() if k not in ("response_ms_sum", "_bucket")})
        out.sort(key=lambda x: -x["calls"])
        return out

    return {
        "code": 0,
        "message": "ok",
        "data": {
            "period": period,
            "overview": {
                "today_calls": today_calls,
                "period_calls": total_calls,
                "success_rate": round(success_calls / total_calls * 100, 1) if total_calls else 0,
                "avg_response_ms": avg_ms,
                "active_apps": active_apps,
            },
            "timeseries": timeseries,
            "by_resource": _finalize(by_resource),
            "by_app": _finalize(by_app),
        },
    }


# ============ 调用日志 ============

@router.get("/call-logs")
def list_call_logs(
    app_id: Optional[int] = Query(None, description="按应用过滤"),
    resource_code: Optional[str] = Query(None, description="按资源过滤"),
    status_group: str = Query("all", pattern="^(all|2xx|4xx|5xx)$", description="按状态码段过滤"),
    client_ip: Optional[str] = Query(None, description="按客户端 IP 过滤"),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _user: User = Depends(require_permission("open_api", "view")),
    db: Session = Depends(get_db),
):
    """调用日志分页列表（含鉴权拒绝记录）。"""
    query = db.query(OpenApiCallLog)
    if app_id is not None:
        query = query.filter(OpenApiCallLog.app_id == app_id)
    if resource_code:
        query = query.filter(OpenApiCallLog.resource_code == resource_code)
    if status_group != "all":
        prefix = int(status_group[0])
        query = query.filter(
            OpenApiCallLog.status_code >= prefix * 100,
            OpenApiCallLog.status_code < (prefix + 1) * 100,
        )
    if client_ip:
        query = query.filter(OpenApiCallLog.client_ip.like(f"%{client_ip}%"))
    start = _parse_dt(start_time)
    if start is not None:
        query = query.filter(OpenApiCallLog.created_at >= start)
    end = _parse_dt(end_time)
    if end is not None:
        query = query.filter(OpenApiCallLog.created_at <= end)

    total = query.count()
    rows = (
        query.order_by(OpenApiCallLog.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            "id": r.id,
            "app_id": r.app_id,
            "app_name": r.app_name,
            "resource_code": r.resource_code,
            "method": r.method,
            "path": r.path,
            "query_params": r.query_params,
            "status_code": r.status_code,
            "response_ms": r.response_ms,
            "client_ip": r.client_ip,
            "user_agent": r.user_agent,
            "error_message": r.error_message,
            "created_at": to_beijing_iso(r.created_at),
        }
        for r in rows
    ]
    return {"code": 0, "message": "ok", "data": {"items": items, "total": total, "page": page, "page_size": page_size}}
