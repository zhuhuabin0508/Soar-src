"""跨系统文件接收管理端接口（JWT + file_receive 权限）。"""
import logging
import re
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.core.file_receive import service, storage
from app.core.file_receive.constants import (
    ACTIVE_STATUSES,
    BIZ_TYPES,
    DEFAULT_ALLOWED_EXTS,
    FORBIDDEN_EXTS,
    STATUS_LABELS,
)
from app.core.security import encrypt_device_secret
from app.core.timezone import BEIJING_TZ, beijing_now, to_beijing_iso
from app.database import get_db
from app.dependencies import require_permission
from app.models.file_receive import (
    FileReceiveEvent,
    FileReceiveObject,
    FileReceiveRecord,
    FileReceiveSource,
)
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/file-receive", tags=["file-receive"])

SOURCE_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$")


def _parse_dt(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    try:
        if len(raw) == 10:
            dt = datetime.fromisoformat(raw)
            if end_of_day:
                dt = dt + timedelta(days=1) - timedelta(seconds=1)
        else:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="时间格式非法，应为 ISO8601")
    if dt.tzinfo is not None:
        dt = dt.astimezone(BEIJING_TZ).replace(tzinfo=None)
    return dt


def _summary(db: Session) -> dict:
    today = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    base = db.query(FileReceiveRecord).filter(FileReceiveRecord.deleted_at.is_(None))
    today_total = base.filter(FileReceiveRecord.received_at >= today).count()
    today_success = base.filter(
        FileReceiveRecord.received_at >= today,
        FileReceiveRecord.status == "SUCCESS",
    ).count()
    today_failed = base.filter(
        FileReceiveRecord.received_at >= today,
        FileReceiveRecord.status == "FAILED",
    ).count()
    today_bytes = (
        db.query(func.coalesce(func.sum(FileReceiveRecord.file_size), 0))
        .filter(
            FileReceiveRecord.deleted_at.is_(None),
            FileReceiveRecord.received_at >= today,
            FileReceiveRecord.status == "SUCCESS",
        )
        .scalar()
        or 0
    )
    in_progress = base.filter(FileReceiveRecord.status.in_(ACTIVE_STATUSES)).count()
    terminal = today_success + today_failed
    return {
        "today_total": today_total,
        "today_success": today_success,
        "today_failed": today_failed,
        "success_rate": round(today_success / terminal, 4) if terminal else 0,
        "today_bytes": int(today_bytes),
        "in_progress": in_progress,
    }


def _source_dict(source: FileReceiveSource) -> dict:
    return {
        "id": source.id,
        "source_code": source.source_code,
        "source_name": source.source_name,
        "status": source.status,
        "access_key": source.access_key,
        "secret_hint": f"****{source.secret_hint}" if source.secret_hint else "",
        "allowed_ips": source.allowed_ips or [],
        "allowed_exts": source.allowed_exts or [],
        "qps": source.qps,
        "burst": source.burst,
        "max_concurrent_sessions": source.max_concurrent_sessions,
        "max_file_size_mb": source.max_file_size_mb,
        "session_ttl_minutes": source.session_ttl_minutes,
        "dedupe_scope": source.dedupe_scope,
        "scan_required": bool(source.scan_required),
        "contact": source.contact,
        "remark": source.remark,
        "last_push_at": to_beijing_iso(source.last_push_at),
        "created_at": to_beijing_iso(source.created_at),
    }


def _normalize_exts(value) -> list[str]:
    if value is None:
        return list(DEFAULT_ALLOWED_EXTS)
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="allowed_exts 必须是数组")
    result: list[str] = []
    for item in value:
        ext = str(item).strip().lower().lstrip(".")
        if not ext or not re.match(r"^[a-z0-9]{1,16}$", ext):
            raise HTTPException(status_code=400, detail=f"非法扩展名: {item}")
        if ext in FORBIDDEN_EXTS:
            raise HTTPException(status_code=400, detail=f"全局禁用扩展名: .{ext}")
        if ext not in result:
            result.append(ext)
    if not result:
        raise HTTPException(status_code=400, detail="至少允许一种文件扩展名")
    return result


def _normalize_ips(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="allowed_ips 必须是数组")
    import ipaddress

    result: list[str] = []
    for item in value:
        text = str(item).strip()
        if not text:
            continue
        try:
            ipaddress.ip_network(text, strict=False)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"非法 IP/CIDR: {text}")
        if text not in result:
            result.append(text)
    return result


def _positive_int(body: dict, key: str, default: int, *, minimum: int = 1, maximum: int = 100000) -> int:
    raw = body.get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{key} 必须是整数")
    if value < minimum or value > maximum:
        raise HTTPException(status_code=400, detail=f"{key} 应在 {minimum}-{maximum} 之间")
    return value


@router.get("/records")
def list_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    start_time: str | None = Query(None),
    end_time: str | None = Query(None),
    source_code: str | None = Query(None),
    status: str | None = Query(None),
    file_ext: str | None = Query(None),
    biz_type: str | None = Query(None),
    keyword: str | None = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "view")),
):
    """接收记录分页列表。"""
    service.recover_stuck_merging(db)
    query = db.query(FileReceiveRecord).filter(FileReceiveRecord.deleted_at.is_(None))
    dt_start = _parse_dt(start_time)
    dt_end = _parse_dt(end_time, end_of_day=True)
    if dt_start:
        query = query.filter(FileReceiveRecord.received_at >= dt_start)
    if dt_end:
        query = query.filter(FileReceiveRecord.received_at <= dt_end)
    if source_code:
        query = query.filter(FileReceiveRecord.source_code == source_code.strip())
    if status:
        statuses = [s.strip().upper() for s in status.split(",") if s.strip()]
        query = query.filter(FileReceiveRecord.status.in_(statuses))
    if file_ext:
        query = query.filter(FileReceiveRecord.file_ext == file_ext.strip().lower().lstrip("."))
    if biz_type:
        query = query.filter(FileReceiveRecord.biz_type == biz_type.strip())
    if keyword:
        kw = f"%{keyword.strip()}%"
        query = query.filter(
            or_(
                FileReceiveRecord.request_id.ilike(kw),
                FileReceiveRecord.file_name.ilike(kw),
                FileReceiveRecord.biz_no.ilike(kw),
            )
        )
    total = query.count()
    rows = (
        query.order_by(FileReceiveRecord.received_at.desc(), FileReceiveRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [service.record_summary(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "summary": _summary(db),
    }


@router.get("/records/{record_id}")
def get_record(
    record_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "view")),
):
    record = (
        db.query(FileReceiveRecord)
        .filter(FileReceiveRecord.id == record_id, FileReceiveRecord.deleted_at.is_(None))
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="接收记录不存在")
    return service.record_detail(db, record)


@router.get("/records/{record_id}/download")
def download_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("file_receive", "download")),
):
    record = (
        db.query(FileReceiveRecord)
        .filter(FileReceiveRecord.id == record_id, FileReceiveRecord.deleted_at.is_(None))
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="接收记录不存在")
    if not record.storage_path:
        raise HTTPException(status_code=404, detail="文件尚未接收完成")
    path = storage.abs_from_rel(record.storage_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="物理文件不存在")
    try:
        db.add(
            FileReceiveEvent(
                record_id=record.id,
                event_type="DOWNLOADED",
                status_from=record.status,
                status_to=record.status,
                message="管理端下载原文件",
                actor=current_user.username,
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("记录下载事件失败（忽略）: %s", exc)
        db.rollback()
    return FileResponse(
        path,
        filename=record.file_name,
        media_type="application/octet-stream",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.post("/records/{record_id}/retry")
def retry_record(
    record_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "manage")),
):
    record = (
        db.query(FileReceiveRecord)
        .filter(FileReceiveRecord.id == record_id, FileReceiveRecord.deleted_at.is_(None))
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="接收记录不存在")
    if record.status != "FAILED" or not record.retryable or not record.upload_id:
        raise HTTPException(status_code=409, detail="当前任务不支持重试")
    source = db.query(FileReceiveSource).filter(FileReceiveSource.id == record.source_id).first()
    if source is None:
        raise HTTPException(status_code=404, detail="来源系统不存在")
    result, _status = service.retry_receipt(db, source, record.upload_id)
    return result


@router.delete("/records/{record_id}")
def delete_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("file_receive", "delete")),
):
    record = (
        db.query(FileReceiveRecord)
        .filter(FileReceiveRecord.id == record_id, FileReceiveRecord.deleted_at.is_(None))
        .first()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="接收记录不存在")
    record.deleted_at = beijing_now()
    record.deleted_by = current_user.id
    if record.status in ACTIVE_STATUSES:
        storage.remove_record_temp(record.id)
    if record.object_id:
        obj = db.query(FileReceiveObject).filter(FileReceiveObject.id == record.object_id).first()
        if obj and obj.ref_count > 0:
            obj.ref_count -= 1
    db.add(
        FileReceiveEvent(
            record_id=record.id,
            event_type="DELETED",
            status_from=record.status,
            status_to=record.status,
            message="管理端删除接收记录（物理文件按保留策略清理）",
            actor=current_user.username,
        )
    )
    db.commit()
    return {"ok": True, "deleted": record_id}


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "view")),
):
    return _summary(db)


@router.get("/meta")
def get_meta(
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "view")),
):
    sources = db.query(FileReceiveSource).order_by(FileReceiveSource.id.asc()).all()
    return {
        "statuses": [{"value": k, "label": v} for k, v in STATUS_LABELS.items()],
        "biz_types": [{"value": k, "label": v["label"]} for k, v in BIZ_TYPES.items()],
        "allowed_exts": DEFAULT_ALLOWED_EXTS,
        "forbidden_exts": sorted(FORBIDDEN_EXTS),
        "sources": [
            {"source_code": s.source_code, "source_name": s.source_name, "status": s.status}
            for s in sources
        ],
    }


# ============ 来源系统管理 ============

@router.get("/sources")
def list_sources(
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "manage")),
):
    sources = db.query(FileReceiveSource).order_by(FileReceiveSource.id.asc()).all()
    return [_source_dict(s) for s in sources]


@router.post("/sources", status_code=201)
def create_source(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("file_receive", "manage")),
):
    source_code = str(body.get("source_code") or "").strip()
    if not SOURCE_CODE_RE.match(source_code):
        raise HTTPException(status_code=400, detail="source_code 需为 2-64 位字母数字/下划线/短横线")
    if db.query(FileReceiveSource).filter(FileReceiveSource.source_code == source_code).first():
        raise HTTPException(status_code=400, detail="来源编码已存在")
    source_name = str(body.get("source_name") or "").strip()
    if not (2 <= len(source_name) <= 128):
        raise HTTPException(status_code=400, detail="source_name 长度应为 2-128")

    access_key = "ak_" + secrets.token_hex(16)
    secret = "sk_" + secrets.token_hex(32)
    status = "active" if str(body.get("status") or "active") == "active" else "disabled"
    dedupe_scope = str(body.get("dedupe_scope") or "content")
    if dedupe_scope not in ("content", "request_id"):
        raise HTTPException(status_code=400, detail="dedupe_scope 仅支持 content/request_id")

    source = FileReceiveSource(
        source_code=source_code,
        source_name=source_name,
        access_key=access_key,
        secret_enc=encrypt_device_secret(secret),
        secret_hint=secret[-4:],
        status=status,
        allowed_ips=_normalize_ips(body.get("allowed_ips")),
        allowed_exts=_normalize_exts(body.get("allowed_exts")),
        qps=_positive_int(body, "qps", settings.FILE_RECEIVE_QPS_DEFAULT, minimum=1, maximum=1000),
        burst=_positive_int(body, "burst", settings.FILE_RECEIVE_BURST_DEFAULT, minimum=1, maximum=10000),
        max_concurrent_sessions=_positive_int(
            body, "max_concurrent_sessions", settings.FILE_RECEIVE_MAX_SESSIONS_PER_SOURCE,
            minimum=1, maximum=1000,
        ),
        max_file_size_mb=_positive_int(
            body, "max_file_size_mb", settings.FILE_RECEIVE_MAX_FILE_MB,
            minimum=1, maximum=settings.FILE_RECEIVE_MAX_FILE_MB,
        ),
        session_ttl_minutes=_positive_int(
            body, "session_ttl_minutes", settings.FILE_RECEIVE_SESSION_TTL_MINUTES,
            minimum=30, maximum=1440,
        ),
        dedupe_scope=dedupe_scope,
        scan_required=bool(body.get("scan_required", False)),
        contact=str(body.get("contact") or "")[:255],
        remark=str(body.get("remark") or "")[:500],
        created_by=current_user.id,
    )
    db.add(source)
    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("创建文件接收来源失败: %s", exc)
        raise HTTPException(status_code=400, detail="来源编码或 Access Key 冲突，请重试")
    db.refresh(source)
    data = _source_dict(source)
    # secret 只在创建响应中出现一次
    data["secret"] = secret
    return data


@router.put("/sources/{source_id}")
def update_source(
    source_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "manage")),
):
    source = db.query(FileReceiveSource).filter(FileReceiveSource.id == source_id).first()
    if source is None:
        raise HTTPException(status_code=404, detail="来源系统不存在")
    if body.get("source_code") and str(body["source_code"]).strip() != source.source_code:
        raise HTTPException(status_code=400, detail="来源编码创建后不可修改")
    if body.get("source_name") is not None:
        name = str(body["source_name"]).strip()
        if not (2 <= len(name) <= 128):
            raise HTTPException(status_code=400, detail="source_name 长度应为 2-128")
        source.source_name = name
    if body.get("status") is not None:
        source.status = "active" if str(body["status"]) == "active" else "disabled"
    if body.get("allowed_ips") is not None:
        source.allowed_ips = _normalize_ips(body["allowed_ips"])
    if body.get("allowed_exts") is not None:
        source.allowed_exts = _normalize_exts(body["allowed_exts"])
    if body.get("qps") is not None:
        source.qps = _positive_int(body, "qps", source.qps, minimum=1, maximum=1000)
    if body.get("burst") is not None:
        source.burst = _positive_int(body, "burst", source.burst, minimum=1, maximum=10000)
    if body.get("max_concurrent_sessions") is not None:
        source.max_concurrent_sessions = _positive_int(
            body, "max_concurrent_sessions", source.max_concurrent_sessions,
            minimum=1, maximum=1000,
        )
    if body.get("max_file_size_mb") is not None:
        source.max_file_size_mb = _positive_int(
            body, "max_file_size_mb", source.max_file_size_mb,
            minimum=1, maximum=settings.FILE_RECEIVE_MAX_FILE_MB,
        )
    if body.get("session_ttl_minutes") is not None:
        source.session_ttl_minutes = _positive_int(
            body, "session_ttl_minutes", source.session_ttl_minutes,
            minimum=30, maximum=1440,
        )
    if body.get("dedupe_scope") is not None:
        scope = str(body["dedupe_scope"])
        if scope not in ("content", "request_id"):
            raise HTTPException(status_code=400, detail="dedupe_scope 仅支持 content/request_id")
        source.dedupe_scope = scope
    if body.get("scan_required") is not None:
        source.scan_required = bool(body["scan_required"])
    if body.get("contact") is not None:
        source.contact = str(body["contact"])[:255]
    if body.get("remark") is not None:
        source.remark = str(body["remark"])[:500]
    db.commit()
    db.refresh(source)
    return _source_dict(source)


@router.delete("/sources/{source_id}")
def delete_source(
    source_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "manage")),
):
    source = db.query(FileReceiveSource).filter(FileReceiveSource.id == source_id).first()
    if source is None:
        raise HTTPException(status_code=404, detail="来源系统不存在")
    count = (
        db.query(func.count(FileReceiveRecord.id))
        .filter(FileReceiveRecord.source_id == source_id)
        .scalar()
        or 0
    )
    if count:
        raise HTTPException(status_code=400, detail="该来源存在接收记录，只能停用，不能删除")
    db.delete(source)
    db.commit()
    return {"ok": True, "deleted": source_id}


@router.post("/sources/{source_id}/rotate-secret")
def rotate_source_secret(
    source_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("file_receive", "manage")),
):
    source = db.query(FileReceiveSource).filter(FileReceiveSource.id == source_id).first()
    if source is None:
        raise HTTPException(status_code=404, detail="来源系统不存在")
    secret = "sk_" + secrets.token_hex(32)
    source.secret_enc_prev = source.secret_enc
    source.secret_enc = encrypt_device_secret(secret)
    source.secret_hint = secret[-4:]
    source.secret_rotated_at = beijing_now()
    db.commit()
    return {
        "id": source.id,
        "source_code": source.source_code,
        "access_key": source.access_key,
        "secret": secret,
        "secret_hint": f"****{source.secret_hint}",
    }
