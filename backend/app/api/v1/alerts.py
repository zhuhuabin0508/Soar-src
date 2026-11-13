"""标准告警列表 API。

- ``GET /alerts``：分页列表（筛选/排序全部后端执行，深分页用延迟关联）。
- ``GET /alerts/{id}``：详情（JSON 字段全部反序列化返回）。
- ``GET /alerts/stats``：列表页顶部统计卡片。
- ``POST /alerts/export``：CSV 导出（文件名 告警列表_YYYYMMDD_HHmmss.csv）。
"""
import csv
import io
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.alert_event import AlertEvent
from app.models.alert_handle_log import AlertHandleLog
from app.models.ingestion_metric import IngestionMetric
from app.models.parse_error import ParseErrorQueue
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/alerts", tags=["alerts"])

# 支持排序的列（表头排序白名单）
SORTABLE_COLUMNS = {
    "occur_timestamp": AlertEvent.occur_timestamp,
    "risk_level": AlertEvent.risk_level,
    "severity": AlertEvent.severity,
    "created_at": AlertEvent.created_at,
}

# JSON 文本字段 → 反序列化（列表/详情共用，体积可控）
_JSON_FIELDS = (
    "devices", "host_ip", "risk_tag", "src_ip", "dst_ip",
    "attck_technique", "extensions",
)
# 详情专有 JSON 字段（体积大，列表模式不返回）
_JSON_FIELDS_DETAIL = ("parse_warnings", "threat_define")


def _load_json(raw: Any) -> Any:
    """JSON 字符串 → 对象；解析失败原样返回，空/非字符串直接返回。"""
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return raw

# 导出 CSV 列（表头 → 取值字段）
_EXPORT_COLUMNS = [
    ("告警名称", "alert_name"), ("风险等级", "risk_level_name"), ("严重度", "severity"),
    ("置信度", "confidence"), ("设备类型", "device_type"), ("攻击状态", "attack_state_name"),
    ("源IP", "src_ip"), ("源端口", "src_port"), ("目的IP", "dst_ip"), ("目的端口", "dst_port"),
    ("方向", "direction_name"), ("协议", "protocol"), ("攻击阶段", "stage_name"),
    ("威胁大类", "threat_class"), ("威胁类型", "threat_type"),
    ("处置状态", "deal_status_name"), ("解析状态", "parse_status"),
    ("发生时间", "occur_timestamp"), ("上报时间", "upload_time"), ("uuid", "uuid"),
]


def _parse_int_list(raw: str) -> list[int]:
    """逗号分隔整数串 → int 列表（忽略非法片段）。"""
    if not raw:
        return []
    out = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            try:
                out.append(int(part))
            except ValueError:
                continue
    return out


def _parse_dt(raw: str) -> Optional[datetime]:
    """ISO 字符串 → 北京时间 naive datetime（与库内存储一致）。"""
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is not None:
            dt = dt.astimezone(tz=None).replace(tzinfo=None)
        return dt
    except ValueError:
        return None


def _build_query(
    db: Session,
    *,
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    risk_levels: list[int],
    attack_states: list[int],
    deal_statuses: list[int],
    stages: list[int],
    directions: list[int],
    keyword: str,
    parse_status: str,
    device_type: str,
):
    """构造告警列表筛选查询（列表/统计/导出共用）。"""
    query = db.query(AlertEvent)
    if start_time is not None:
        query = query.filter(AlertEvent.occur_timestamp >= start_time)
    if end_time is not None:
        query = query.filter(AlertEvent.occur_timestamp < end_time)
    if risk_levels:
        query = query.filter(AlertEvent.risk_level.in_(risk_levels))
    if attack_states:
        query = query.filter(AlertEvent.attack_state.in_(attack_states))
    if deal_statuses:
        query = query.filter(AlertEvent.deal_status.in_(deal_statuses))
    if stages:
        query = query.filter(AlertEvent.stage.in_(stages))
    if directions:
        query = query.filter(AlertEvent.direction.in_(directions))
    if parse_status:
        query = query.filter(AlertEvent.parse_status == parse_status)
    if device_type:
        query = query.filter(AlertEvent.device_type == device_type)
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            or_(
                AlertEvent.alert_name.ilike(like),
                AlertEvent.src_ip.ilike(like),
                AlertEvent.dst_ip.ilike(like),
            )
        )
    return query


def _serialize(row: AlertEvent, *, full: bool = False, list_mode: bool = False) -> dict[str, Any]:
    """行序列化。

    - 默认：轻量常用字段（导出等内部场景）。
    - ``list_mode=True``（列表接口）：全量普通字段供前端「显示列」自定义，
      剔除超大/详情专用文本字段（raw_data / base_content / proof_description /
      parse_warnings / threat_define），中等 JSON 字段反序列化，控制分页响应体积。
    - ``full=True``（详情）：全部字段（含大文本）+ JSON 字段反序列化。
    """
    data: dict[str, Any] = {
        "id": row.id,
        "uuid": row.uuid,
        "alert_name": row.alert_name,
        "risk_level": row.risk_level,
        "risk_level_name": row.risk_level_name,
        "severity": row.severity,
        "confidence": row.confidence,
        "device_type": row.device_type,
        "rule_id": row.rule_id,
        "log_type": row.log_type,
        "alert_rule_id": row.alert_rule_id,
        "alert_rule_name": row.alert_rule_name,
        "attack_state": row.attack_state,
        "attack_state_name": row.attack_state_name,
        "src_ip": row.src_ip,
        "src_port": row.src_port,
        "dst_ip": row.dst_ip,
        "dst_port": row.dst_port,
        "direction": row.direction,
        "direction_name": row.direction_name,
        "protocol": row.protocol,
        "stage": row.stage,
        "stage_name": row.stage_name,
        "deal_status": row.deal_status,
        "deal_status_name": row.deal_status_name,
        "assignee_id": row.assignee_id,
        "assignee_name": row.assignee_name,
        "handled_at": row.handled_at,
        "parse_status": row.parse_status,
        "occur_timestamp": row.occur_timestamp,
        "created_at": row.created_at,
        # 告警聚合（XDR：同键同窗合并计数，1=未聚合）
        "aggregation_count": row.aggregation_count if row.aggregation_count is not None else 1,
    }
    if not (full or list_mode):
        return data
    # ===== 全量普通字段（列表/详情共用；大文本仅详情返回）=====
    data.update({
        "seq_id": row.seq_id,
        "tenant": row.tenant,
        "customer": row.customer,
        "data_version": row.data_version,
        "strategy_id": row.strategy_id,
        "agent_id": row.agent_id,
        "asset_id": row.asset_id,
        "region_id": row.region_id,
        "relate_asset_type": row.relate_asset_type,
        "relate_asset_type_name": row.relate_asset_type_name,
        "relate_asset_id": row.relate_asset_id,
        "relate_asset_name": row.relate_asset_name,
        "relate_asset_ip": row.relate_asset_ip,
        "group_id": row.group_id,
        "subject_type": row.subject_type,
        "user_name": row.user_name,
        "account_id": row.account_id,
        "account_name": row.account_name,
        "first_timestamp": row.first_timestamp,
        "last_timestamp": row.last_timestamp,
        "upload_timestamp": row.upload_timestamp,
        "upload_time": row.upload_time,
        "upload_time_raw": row.upload_time_raw,
        "time_region": row.time_region,
        "description": row.description,
        "recommendation": row.recommendation,
        "src_asset_id": row.src_asset_id,
        "src_ip_tag": row.src_ip_tag,
        "src_ip_tag_name": row.src_ip_tag_name,
        "src_region_id": row.src_region_id,
        "src_region_name": row.src_region_name,
        "dst_asset_id": row.dst_asset_id,
        "dst_region_id": row.dst_region_id,
        "dst_region_name": row.dst_region_name,
        "xff_client_ip": row.xff_client_ip,
        "src_country": row.src_country,
        "src_province": row.src_province,
        "src_city": row.src_city,
        "threat_class": row.threat_class,
        "threat_type": row.threat_type,
        "threat_sub_type": row.threat_sub_type,
        "proof_type": row.proof_type,
    })
    # 中等 JSON 字段：反序列化（列表/详情共用）
    for field in _JSON_FIELDS:
        data[field] = _load_json(getattr(row, field, None))
    if not full:
        return data
    # ===== 详情专有：超大文本字段 + 详情 JSON 字段 =====
    data.update({
        "proof_description": row.proof_description,
        "base_content": row.base_content,
    })
    for field in _JSON_FIELDS_DETAIL:
        data[field] = _load_json(getattr(row, field, None))
    # raw_data 单独处理：尝试格式化为对象（前端再做格式化高亮）；空串统一为 None
    data["raw_data"] = _load_json(row.raw_data) if row.raw_data else None
    return data


@router.get("", dependencies=[Depends(require_permission("alert", "view"))])
def list_alerts(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort: str = Query("occur_timestamp", description="排序字段：occur_timestamp/risk_level/severity/created_at"),
    order: str = Query("desc", description="asc / desc"),
    start_time: str = Query("", description="发生时间起（ISO），默认最近24小时"),
    end_time: str = Query("", description="发生时间止（ISO）"),
    risk_levels: str = Query("", description="风险等级多选，逗号分隔"),
    attack_states: str = Query("", description="攻击状态多选，逗号分隔"),
    deal_statuses: str = Query("", description="处置状态多选，逗号分隔"),
    stages: str = Query("", description="告警阶段多选，逗号分隔"),
    directions: str = Query("", description="访问方向多选，逗号分隔"),
    keyword: str = Query("", description="源IP/目的IP/告警名称模糊匹配"),
    parse_status: str = Query("", description="success/partial/fail"),
    device_type: str = Query("", description="设备类型"),
    db: Session = Depends(get_db),
) -> dict:
    """分页查询告警（深分页用延迟关联：先取 id 子查询再回表）。"""
    st = _parse_dt(start_time)
    et = _parse_dt(end_time)
    if st is None and et is None:
        st = beijing_now() - timedelta(hours=24)

    query = _build_query(
        db,
        start_time=st, end_time=et,
        risk_levels=_parse_int_list(risk_levels),
        attack_states=_parse_int_list(attack_states),
        deal_statuses=_parse_int_list(deal_statuses),
        stages=_parse_int_list(stages),
        directions=_parse_int_list(directions),
        keyword=keyword.strip(),
        parse_status=parse_status,
        device_type=device_type,
    )
    total = query.count()

    col = SORTABLE_COLUMNS.get(sort)
    if col is None:
        col = AlertEvent.occur_timestamp
    order_col = col.desc() if str(order).lower() == "desc" else col.asc()

    # 延迟关联：offset/limit 只作用在 id 子查询上，大偏移时避免整行扫描排序
    subq = (
        query.with_entities(AlertEvent.id)
        .order_by(order_col, AlertEvent.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .subquery()
    )
    rows = (
        db.query(AlertEvent)
        .join(subq, AlertEvent.id == subq.c.id)
        .order_by(order_col, AlertEvent.id.desc())
        .all()
    )
    return {
        "total": total,
        "items": [_serialize(r, list_mode=True) for r in rows],
        "page": page,
        "page_size": page_size,
    }


@router.get("/stats", dependencies=[Depends(require_permission("alert", "view"))])
def alert_stats(db: Session = Depends(get_db)) -> dict:
    """列表页顶部统计卡片：今日告警总数（对比昨日）、今日高危及以上、解析失败数、接入设备类型数。"""
    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)

    today_total = db.query(func.count(AlertEvent.id)).filter(
        AlertEvent.occur_timestamp >= today_start,
        AlertEvent.occur_timestamp < now,
    ).scalar() or 0
    yesterday_total = db.query(func.count(AlertEvent.id)).filter(
        AlertEvent.occur_timestamp >= yesterday_start,
        AlertEvent.occur_timestamp < today_start,
    ).scalar() or 0
    # 高危及以上：risk_level 0=严重 1=高危
    today_high = db.query(func.count(AlertEvent.id)).filter(
        AlertEvent.occur_timestamp >= today_start,
        AlertEvent.occur_timestamp < now,
        AlertEvent.risk_level.in_([0, 1]),
    ).scalar() or 0
    # 解析失败数：今日入库指标 fail（含无匹配策略）
    today_fail = db.query(func.coalesce(func.sum(IngestionMetric.fail_count), 0)).filter(
        IngestionMetric.stat_hour >= today_start.strftime("%Y-%m-%dT%H"),
    ).scalar() or 0
    # 接入设备类型数：告警表中出现过的设备类型
    device_types = db.query(AlertEvent.device_type).filter(
        AlertEvent.device_type != "",
    ).distinct().all()

    delta = today_total - yesterday_total if yesterday_total else (today_total if today_total else 0)

    # 近24小时告警趋势（统计卡片 sparkline）：整点小时标签 + 逐小时告警数
    # Python 端按小时分组（避免 PG to_char 等 DB 专属函数，SQLite 测试环境同样可用）
    trend_hours = [(now - timedelta(hours=i)).strftime("%Y-%m-%dT%H") for i in range(24)]
    trend_start = (now - timedelta(hours=23)).replace(minute=0, second=0, microsecond=0)
    ts_rows = db.query(AlertEvent.occur_timestamp).filter(
        AlertEvent.occur_timestamp >= trend_start,
        AlertEvent.occur_timestamp < now,
    ).all()
    by_hour: dict[str, int] = {}
    for (ts,) in ts_rows:
        if ts is None:
            continue
        key = ts.strftime("%Y-%m-%dT%H")
        by_hour[key] = by_hour.get(key, 0) + 1
    trend_24h = [{"hour": h, "total": by_hour.get(h, 0)} for h in reversed(trend_hours)]

    return {
        "today_total": today_total,
        "yesterday_total": yesterday_total,
        "delta": delta,
        "today_high": today_high,
        "today_fail": int(today_fail),
        "device_type_count": len(device_types),
        "device_types": sorted({t[0] for t in device_types}),
        "trend_24h": trend_24h,
    }


@router.get("/{alert_id}", dependencies=[Depends(require_permission("alert", "view"))])
def get_alert(alert_id: int, db: Session = Depends(get_db)) -> dict:
    """告警详情：全部字段 + JSON 字段反序列化。"""
    row = db.query(AlertEvent).filter(AlertEvent.id == alert_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="告警不存在或已被删除")
    return _serialize(row, full=True)


@router.post("/export", dependencies=[Depends(require_permission("alert", "export"))])
def export_alerts(
    body: dict,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """按当前筛选条件导出 CSV（UTF-8 BOM，Excel 可直接打开）。"""
    st = _parse_dt(str(body.get("start_time") or ""))
    et = _parse_dt(str(body.get("end_time") or ""))
    if st is None and et is None:
        st = beijing_now() - timedelta(hours=24)
    query = _build_query(
        db,
        start_time=st, end_time=et,
        risk_levels=_parse_int_list(str(body.get("risk_levels") or "")),
        attack_states=_parse_int_list(str(body.get("attack_states") or "")),
        deal_statuses=_parse_int_list(str(body.get("deal_statuses") or "")),
        stages=_parse_int_list(str(body.get("stages") or "")),
        directions=_parse_int_list(str(body.get("directions") or "")),
        keyword=str(body.get("keyword") or "").strip(),
        parse_status=str(body.get("parse_status") or ""),
        device_type=str(body.get("device_type") or ""),
    )
    sort = str(body.get("sort") or "occur_timestamp")
    col = SORTABLE_COLUMNS.get(sort, AlertEvent.occur_timestamp)
    order_col = col.desc() if str(body.get("order") or "desc").lower() != "asc" else col.asc()
    rows = query.order_by(order_col, AlertEvent.id.desc()).limit(10000).all()

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM
    writer = csv.writer(buf)
    writer.writerow([h for h, _ in _EXPORT_COLUMNS])
    for row in rows:
        cells = []
        for _, field in _EXPORT_COLUMNS:
            val = getattr(row, field, None)
            if isinstance(val, datetime):
                val = val.strftime("%Y-%m-%d %H:%M:%S")
            elif val is None:
                val = ""
            cells.append(str(val))
        writer.writerow(cells)

    filename = f"告警列表_{beijing_now().strftime('%Y%m%d_%H%M%S')}.csv"
    content = buf.getvalue()
    from urllib.parse import quote
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "Content-Length": str(len(content.encode("utf-8"))),
        },
    )


# ============ 处置闭环 ============

# 状态机流转规则：key=当前状态 → value=允许到达的目标状态集合
# 0=未处置/待确认, 70=处置中, 20=已关闭/已完成, 30=已加白, 40=已驳回,
# 50=已忽略, 60=已遏制, 80=误报
_TRANSITIONS: dict[int, set[int]] = {
    0: {0, 10, 70, 20, 30, 40, 50, 60, 80},  # 待确认 → 自身(指派/备注)/生成事件/处置中/各终态
    10: {10, 70, 0, 20, 30, 40, 50, 60, 80}, # 生成事件 → 自身/处置中/退回/各终态
    70: {70, 0, 10, 20, 30, 40, 50, 60, 80}, # 处置中 → 自身(指派/备注)/退回/各终态
    20: {20, 70},                             # 已关闭 → 自身(备注)/重新打开
    30: {30, 70, 0},                          # 已加白 → 自身/重新打开
    40: {40, 70, 0},                          # 已驳回 → 自身/重新打开
    50: {50, 70, 0},                          # 已忽略 → 自身/重新打开
    60: {60, 70, 0},                          # 已遏制 → 自身/重新打开
    80: {80, 70, 0},                          # 误报 → 自身/重新打开
}

_DEAL_STATUS_NAMES: dict[int, str] = {
    0: "未处置", 10: "生成事件", 20: "已完成", 30: "已加白",
    40: "已驳回", 50: "已忽略", 60: "已遏制", 70: "处置中", 80: "误报",
}


class HandleBody(BaseModel):
    """告警处置请求体。"""
    to_status: int = Field(..., description="目标处置状态")
    assignee_id: int | None = Field(None, description="指派处理人 ID（NULL=不变更）")
    comment: str = Field("", description="处置备注")


class BatchHandleBody(BaseModel):
    """批量处置请求体。"""
    alert_ids: list[int] = Field(..., description="告警 ID 列表")
    to_status: int = Field(..., description="目标处置状态")
    assignee_id: int | None = Field(None, description="指派处理人 ID")
    comment: str = Field("", description="处置备注")


def _resolve_assignee_name(db: Session, assignee_id: int | None) -> str:
    """根据 user_id 查询 display_name/username，找不到返回空串。"""
    if not assignee_id:
        return ""
    u = db.query(User).filter(User.id == assignee_id).first()
    if u is None:
        return ""
    return u.display_name or u.username


def _do_handle(
    db: Session,
    alert: AlertEvent,
    body: HandleBody,
    operator_id: int,
    operator_name: str,
) -> AlertHandleLog:
    """执行单条告警处置：校验状态机 → 更新告警 → 写日志 → 返回日志记录。"""
    from_status = alert.deal_status if alert.deal_status is not None else 0
    allowed = _TRANSITIONS.get(from_status, set())
    if body.to_status not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"不允许的状态流转：{_DEAL_STATUS_NAMES.get(from_status, str(from_status))} "
            f"→ {_DEAL_STATUS_NAMES.get(body.to_status, str(body.to_status))}",
        )

    # 确定指派变更
    from_assignee = alert.assignee_name or ""
    to_assignee = from_assignee
    if body.assignee_id is not None:
        to_assignee = _resolve_assignee_name(db, body.assignee_id)

    now = beijing_now()

    # 更新告警主记录
    alert.deal_status = body.to_status
    alert.deal_status_name = _DEAL_STATUS_NAMES.get(body.to_status, str(body.to_status))
    if body.assignee_id is not None:
        alert.assignee_id = body.assignee_id
        alert.assignee_name = to_assignee
    alert.handled_at = now

    # 确定操作类型
    if body.to_status == 70 and from_status in (20, 30, 40, 50, 60, 80):
        action = "reopen"
    elif body.to_status == 20:
        action = "close"
    elif body.assignee_id is not None and from_status == body.to_status:
        action = "assign"
    elif body.to_status != from_status:
        action = "status_change"
    else:
        action = "comment"

    log = AlertHandleLog(
        alert_id=alert.id,
        action=action,
        from_status=from_status,
        to_status=body.to_status,
        from_assignee=from_assignee,
        to_assignee=to_assignee,
        operator_id=operator_id,
        operator_name=operator_name,
        comment=body.comment,
        created_at=now,
    )
    db.add(log)
    db.flush()
    return log


@router.post("/{alert_id}/handle", dependencies=[Depends(require_permission("alert", "handle"))])
def handle_alert(
    alert_id: int,
    body: HandleBody,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> dict:
    """单条告警处置：变更状态 + 指派 + 备注，写处置日志与审计。"""
    alert = db.query(AlertEvent).filter(AlertEvent.id == alert_id).first()
    if alert is None:
        raise HTTPException(status_code=404, detail="告警不存在或已被删除")

    log = _do_handle(db, alert, body, user.id, user.display_name or user.username)
    db.commit()

    ip = get_client_ip(request)
    log_audit(
        db, user.id, user.username, "handle", "alert", alert_id,
        {"to_status": body.to_status, "assignee_id": body.assignee_id, "comment": body.comment},
        ip,
    )
    db.commit()

    return {
        "id": alert.id,
        "deal_status": alert.deal_status,
        "deal_status_name": alert.deal_status_name,
        "assignee_id": alert.assignee_id,
        "assignee_name": alert.assignee_name,
        "handled_at": alert.handled_at,
        "log_id": log.id,
    }


@router.post("/batch-handle", dependencies=[Depends(require_permission("alert", "handle"))])
def batch_handle_alerts(
    body: BatchHandleBody,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> dict:
    """批量处置告警：对每条告警执行状态变更+指派+备注。"""
    if not body.alert_ids:
        raise HTTPException(status_code=422, detail="alert_ids 不能为空")
    if len(body.alert_ids) > 500:
        raise HTTPException(status_code=422, detail="单次批量最多 500 条")

    handle_body = HandleBody(to_status=body.to_status, assignee_id=body.assignee_id, comment=body.comment)
    alerts = db.query(AlertEvent).filter(AlertEvent.id.in_(body.alert_ids)).all()
    succeeded: list[int] = []
    skipped: list[dict] = []
    for alert in alerts:
        from_status = alert.deal_status if alert.deal_status is not None else 0
        allowed = _TRANSITIONS.get(from_status, set())
        if body.to_status not in allowed:
            skipped.append({
                "alert_id": alert.id,
                "reason": f"不允许的状态流转：{_DEAL_STATUS_NAMES.get(from_status, str(from_status))} "
                          f"→ {_DEAL_STATUS_NAMES.get(body.to_status, str(body.to_status))}",
            })
            continue
        _do_handle(db, alert, handle_body, user.id, user.display_name or user.username)
        succeeded.append(alert.id)

    db.commit()

    ip = get_client_ip(request)
    log_audit(
        db, user.id, user.username, "batch_handle", "alert", 0,
        {"count": len(succeeded), "to_status": body.to_status, "assignee_id": body.assignee_id},
        ip,
    )
    db.commit()

    return {"succeeded": succeeded, "skipped": skipped}


@router.get("/{alert_id}/handle-logs", dependencies=[Depends(require_permission("alert", "view"))])
def get_handle_logs(
    alert_id: int,
    db: Session = Depends(get_db),
) -> list[dict]:
    """告警处置时间线：按操作时间降序返回处置日志列表。"""
    logs = (
        db.query(AlertHandleLog)
        .filter(AlertHandleLog.alert_id == alert_id)
        .order_by(AlertHandleLog.created_at.desc())
        .all()
    )
    return [
        {
            "id": log.id,
            "action": log.action,
            "from_status": log.from_status,
            "to_status": log.to_status,
            "from_status_name": _DEAL_STATUS_NAMES.get(log.from_status, str(log.from_status)) if log.from_status is not None else "",
            "to_status_name": _DEAL_STATUS_NAMES.get(log.to_status, str(log.to_status)) if log.to_status is not None else "",
            "from_assignee": log.from_assignee,
            "to_assignee": log.to_assignee,
            "operator_id": log.operator_id,
            "operator_name": log.operator_name,
            "comment": log.comment,
            "created_at": log.created_at,
        }
        for log in logs
    ]
