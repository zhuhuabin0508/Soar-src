"""开放 API 资源目录（唯一权威来源）。

声明平台对外开放了哪些数据资源、支持哪些过滤参数，管理端（授权勾选）与
网关端（统一数据端点）共用此目录，确保「开放了什么数据」口径一致。

安全约定：
- 所有 handler 均为**只读查询**，输出字段做白名单裁剪，剔除原始设备 JSON
  （devices/extensions/raw_data/extra_fields 等）与敏感字段。
- 统一分页约定：``page``（默认1）/ ``page_size``（默认20，上限100）。
- 统一时间过滤：``start_time`` / ``end_time``（ISO 字符串或 ``YYYY-MM-DD HH:MM:SS``）。
"""
import logging
from datetime import datetime
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.core.timezone import BEIJING_TZ, to_beijing_iso

logger = logging.getLogger(__name__)

# 分页上限（防止第三方一次性拉全表）
MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20


# ============ 通用工具 ============

def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """解析时间过滤参数（容错：非法格式返回 None 并忽略该过滤）。

    fromisoformat 优先完整解析：前缀截断的 strptime 分支会静默丢弃
    "+HH:MM" 时区偏移（按 naive 字面量直解导致最多 8 小时窗口偏移），
    仅在 fromisoformat 不支持时作为宽松格式兜底。
    """
    if not value:
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
        logger.warning("开放 API 时间参数解析失败（忽略）: %s", value)
        return None
    # aware → 北京时区 naive：DB 列为北京时间字面量（无 tzinfo），
    # 直接比较会依赖会话时区解释，导致过滤窗口偏移
    if dt.tzinfo is not None:
        dt = dt.astimezone(BEIJING_TZ).replace(tzinfo=None)
    return dt


def _parse_pagination(params: dict) -> tuple[int, int]:
    """解析分页参数并夹紧到安全区间。"""
    try:
        page = max(1, int(params.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = int(params.get("page_size", DEFAULT_PAGE_SIZE))
    except (TypeError, ValueError):
        page_size = DEFAULT_PAGE_SIZE
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    return page, page_size


def _apply_time_filter(query, column, params: dict, start_key: str = "start_time", end_key: str = "end_time"):
    """给 query 附加时间范围过滤（按指定时间列）。"""
    start = _parse_dt(params.get(start_key))
    end = _parse_dt(params.get(end_key))
    if start is not None:
        query = query.filter(column >= start)
    if end is not None:
        query = query.filter(column <= end)
    return query


def _iso(value) -> Optional[str]:
    """datetime 列转 ISO 字符串（None 安全）。"""
    return to_beijing_iso(value) if hasattr(value, "isoformat") else value


# ============ 资源 handler（只读查询 + 字段白名单裁剪） ============

def list_alerts(db: Session, params: dict) -> tuple[list[dict], int]:
    """告警事件列表（过滤：处置状态/风险等级/发生时间范围）。"""
    from app.models.alert_event import AlertEvent

    page, page_size = _parse_pagination(params)
    query = db.query(AlertEvent)
    deal_status = params.get("deal_status")
    if deal_status not in (None, ""):
        try:
            query = query.filter(AlertEvent.deal_status == int(deal_status))
        except (TypeError, ValueError):
            pass
    risk_level = params.get("risk_level")
    if risk_level not in (None, ""):
        try:
            query = query.filter(AlertEvent.risk_level == int(risk_level))
        except (TypeError, ValueError):
            pass
    keyword = str(params.get("keyword", "")).strip()
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            AlertEvent.alert_name.like(like) | AlertEvent.uuid.like(like) | AlertEvent.src_ip.like(like)
        )
    query = _apply_time_filter(query, AlertEvent.occur_timestamp, params)

    total = query.count()
    rows = (
        query.order_by(AlertEvent.occur_timestamp.desc().nullslast(), AlertEvent.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            "id": r.id,
            "uuid": r.uuid,
            "alert_name": r.alert_name,
            "description": (r.description or "")[:500],
            "device_type": r.device_type,
            "alert_rule_name": r.alert_rule_name,
            "src_ip": r.src_ip,
            "dst_ip": r.dst_ip,
            "src_port": r.src_port,
            "dst_port": r.dst_port,
            "protocol": r.protocol,
            "direction_name": r.direction_name,
            "risk_level_name": r.risk_level_name,
            "severity": r.severity,
            "threat_class": r.threat_class,
            "threat_type": r.threat_type,
            "attack_state_name": r.attack_state_name,
            "deal_status": r.deal_status,
            "deal_status_name": r.deal_status_name,
            "assignee_name": r.assignee_name,
            "handled_at": _iso(r.handled_at),
            "aggregation_count": r.aggregation_count,
            "occur_timestamp": _iso(r.occur_timestamp),
            "first_timestamp": _iso(r.first_timestamp),
            "last_timestamp": _iso(r.last_timestamp),
            "created_at": _iso(r.created_at),
        }
        for r in rows
    ]
    return items, total


def list_assets(db: Session, params: dict) -> tuple[list[dict], int]:
    """资产清单列表（过滤：资产类型/生命周期状态/关键字/创建时间范围）。"""
    from app.models.asset import Asset

    page, page_size = _parse_pagination(params)
    query = db.query(Asset)
    if params.get("asset_type") not in (None, ""):
        query = query.filter(Asset.asset_type == params["asset_type"])
    if params.get("status") not in (None, ""):
        query = query.filter(Asset.status == params["status"])
    if params.get("criticality") not in (None, ""):
        query = query.filter(Asset.criticality == params["criticality"])
    keyword = str(params.get("keyword", "")).strip()
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            Asset.name.like(like) | Asset.identifier.like(like) | Asset.ip.like(like)
        )
    query = _apply_time_filter(query, Asset.created_at, params)

    total = query.count()
    rows = (
        query.order_by(Asset.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            "id": r.id,
            "name": r.name,
            "identifier": r.identifier,
            "identifier_type": r.identifier_type,
            "asset_type": r.asset_type,
            "type_code": r.type_code,
            "ip": r.ip,
            "department": r.department,
            "owner": r.owner,
            "location": r.location,
            "criticality": r.criticality,
            "status": r.status,
            "source": r.source,
            "created_at": _iso(r.created_at),
            "updated_at": _iso(r.updated_at),
        }
        for r in rows
    ]
    return items, total


def list_banned_ips(db: Session, params: dict) -> tuple[list[dict], int]:
    """封禁 IP 记录列表（过滤：状态/封禁等级/IP模糊/创建时间范围）。"""
    from app.models.banned_ip import BannedIP

    page, page_size = _parse_pagination(params)
    query = db.query(BannedIP)
    if params.get("status") not in (None, ""):
        query = query.filter(BannedIP.status == params["status"])
    if params.get("ban_level") not in (None, ""):
        query = query.filter(BannedIP.ban_level == params["ban_level"])
    if params.get("ip") not in (None, ""):
        query = query.filter(BannedIP.ip.like(f"%{params['ip']}%"))
    query = _apply_time_filter(query, BannedIP.created_at, params)

    total = query.count()
    rows = (
        query.order_by(BannedIP.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            "id": r.id,
            "ip": r.ip,
            "ban_level": r.ban_level,
            "ban_duration": r.ban_duration,
            "expired_at": _iso(r.expired_at),
            "region": r.region,
            "violation_count": r.violation_count,
            "reason": r.reason,
            "status": r.status,
            "source": r.source,
            "device_name": r.device_name,
            "created_at": _iso(r.created_at),
            "updated_at": _iso(r.updated_at),
        }
        for r in rows
    ]
    return items, total


def list_tickets(db: Session, params: dict) -> tuple[list[dict], int]:
    """安全工单列表（过滤：状态/优先级/创建时间范围）。"""
    from app.models.ticket import Ticket

    page, page_size = _parse_pagination(params)
    # 排除归档工单（与前端列表口径一致）
    query = db.query(Ticket).filter(Ticket.archived.is_(False))
    if params.get("status") not in (None, ""):
        query = query.filter(Ticket.status == params["status"])
    if params.get("priority") not in (None, ""):
        query = query.filter(Ticket.priority == params["priority"])
    keyword = str(params.get("keyword", "")).strip()
    if keyword:
        query = query.filter(Ticket.title.like(f"%{keyword}%"))
    query = _apply_time_filter(query, Ticket.created_at, params)

    total = query.count()
    rows = (
        query.order_by(Ticket.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            "id": r.id,
            "ticket_no": r.ticket_no,
            "title": r.title,
            "flow_name": r.flow_name,
            "status": r.status,
            "priority": r.priority,
            "current_node_name": r.current_node_name,
            "created_by_name": r.created_by_name,
            "related_alert_uuid": r.related_alert_uuid,
            "created_at": _iso(r.created_at),
            "updated_at": _iso(r.updated_at),
            "closed_at": _iso(r.closed_at),
        }
        for r in rows
    ]
    return items, total


def list_executions(db: Session, params: dict) -> tuple[list[dict], int]:
    """工作流执行记录列表（过滤：状态/触发类型/创建时间范围）。"""
    from app.models.execution import Execution
    from app.models.workflow import Workflow

    page, page_size = _parse_pagination(params)
    query = db.query(Execution)
    if params.get("status") not in (None, ""):
        query = query.filter(Execution.status == params["status"])
    if params.get("trigger_type") not in (None, ""):
        query = query.filter(Execution.trigger_type == params["trigger_type"])
    query = _apply_time_filter(query, Execution.created_at, params)

    total = query.count()
    rows = (
        query.order_by(Execution.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    wf_ids = {r.workflow_id for r in rows if r.workflow_id}
    wf_names = {}
    if wf_ids:
        for w in db.query(Workflow.id, Workflow.name).filter(Workflow.id.in_(wf_ids)).all():
            wf_names[w.id] = w.name
    items = [
        {
            "id": r.id,
            "workflow_id": r.workflow_id,
            "workflow_name": wf_names.get(r.workflow_id, ""),
            "status": r.status,
            "trigger_type": r.trigger_type,
            "created_at": _iso(r.created_at),
            "finished_at": _iso(r.finished_at),
        }
        for r in rows
    ]
    return items, total


def get_ticket_monitor(db: Session, params: dict) -> tuple[dict, int]:
    """工单监控大屏聚合数据（与内部大屏 ``GET /tickets/monitor`` 同源同口径）。

    支持参数：
    - ``flow_id``：指定流程模板 ID（缺省自动选取进行中工单最多的流程）
    - ``light``：轻量模式，仅返回 kpi + latest（供高频轮询）
    - ``include_drill``：是否下发下钻工单集（0/1，默认 1）
    - ``drill_limit``：下钻集条数上限（100~2000，默认 2000）
    """
    from app.api.v1.tickets import ticket_monitor_payload

    flow_id = None
    if params.get("flow_id") not in (None, ""):
        try:
            flow_id = int(params["flow_id"])
        except (TypeError, ValueError):
            pass
    light = str(params.get("light", "")).strip().lower() in ("1", "true", "yes")
    include_drill = str(params.get("include_drill", "1")).strip().lower() not in ("0", "false", "no")
    try:
        drill_limit = max(100, min(int(params.get("drill_limit", 2000)), 2000))
    except (TypeError, ValueError):
        drill_limit = 2000

    payload = ticket_monitor_payload(
        db, flow_id=flow_id, light=light, include_drill=include_drill, drill_limit=drill_limit
    )
    return payload, 1


def get_dashboard_stats(db: Session, params: dict) -> tuple[dict, int]:
    """安全统计汇总（聚合指标，不分页）。"""
    from app.models.alert_event import AlertEvent
    from app.models.banned_ip import BannedIP
    from app.models.execution import Execution
    from app.models.ticket import Ticket

    from app.core.timezone import beijing_now

    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    alert_total = db.query(AlertEvent).count()
    alert_today = db.query(AlertEvent).filter(AlertEvent.occur_timestamp >= today_start).count()
    # 处置状态口径与 alerts.py 一致：0=未处置/待确认
    alert_unhandled = db.query(AlertEvent).filter(AlertEvent.deal_status == 0).count()
    ban_total = db.query(BannedIP).count()
    ban_active = db.query(BannedIP).filter(BannedIP.status == "active").count()
    ticket_total = db.query(Ticket).filter(Ticket.archived.is_(False)).count()
    ticket_processing = (
        db.query(Ticket)
        .filter(Ticket.archived.is_(False), Ticket.status.in_(("processing", "paused")))
        .count()
    )
    exec_total = db.query(Execution).count()
    exec_success = db.query(Execution).filter(Execution.status == "success").count()

    stats = {
        "generated_at": _iso(now),
        "alerts": {"total": alert_total, "today": alert_today, "unhandled": alert_unhandled},
        "banned_ips": {"total": ban_total, "active": ban_active},
        "tickets": {"total": ticket_total, "processing": ticket_processing},
        "executions": {"total": exec_total, "success": exec_success},
    }
    return stats, 1


# ============ 资源目录 ============

Handler = Callable[[Session, dict], tuple[Any, int]]

OPEN_API_RESOURCES: dict[str, dict] = {
    "alerts": {
        "name": "告警事件",
        "description": "标准化告警列表：告警名称、等级、威胁类型、源/目的IP、处置状态、发生时间等",
        "filters": ["deal_status", "risk_level", "keyword", "start_time", "end_time", "page", "page_size"],
        "handler": list_alerts,
    },
    "assets": {
        "name": "资产清单",
        "description": "资产名称、IP、类型、部门、负责人、重要性、生命周期状态等",
        "filters": ["asset_type", "status", "criticality", "keyword", "start_time", "end_time", "page", "page_size"],
        "handler": list_assets,
    },
    "banned_ips": {
        "name": "封禁记录",
        "description": "IP封禁记录：封禁等级、时长、到期时间、原因、来源设备、当前状态",
        "filters": ["status", "ban_level", "ip", "start_time", "end_time", "page", "page_size"],
        "handler": list_banned_ips,
    },
    "tickets": {
        "name": "安全工单",
        "description": "工单编号、标题、流程、状态、优先级、当前节点、发起人、关联告警等",
        "filters": ["status", "priority", "keyword", "start_time", "end_time", "page", "page_size"],
        "handler": list_tickets,
    },
    "executions": {
        "name": "执行记录",
        "description": "工作流执行历史：工作流名称、状态、触发类型、开始/完成时间",
        "filters": ["status", "trigger_type", "start_time", "end_time", "page", "page_size"],
        "handler": list_executions,
    },
    "dashboard_stats": {
        "name": "安全统计汇总",
        "description": "聚合指标：告警总量/今日新增/未处置、封禁总量/生效中、工单总量/进行中、执行总量/成功数",
        "filters": [],
        "handler": get_dashboard_stats,
    },
    "ticket_monitor": {
        "name": "工单监控大屏",
        "description": "工单监控大屏聚合数据：KPI、新增/关闭趋势、优先级/类型分布、团队排名、来源平台、封禁IP、流转节点、最新工单（可 flow_id/light/include_drill/drill_limit 控制）",
        "filters": ["flow_id", "light", "include_drill", "drill_limit"],
        "handler": get_ticket_monitor,
    },
}


def get_resource(code: str) -> Optional[dict]:
    """按编码获取资源定义（不存在返回 None）。"""
    return OPEN_API_RESOURCES.get(code)


def resource_catalog(codes: Optional[list[str]] = None) -> list[dict]:
    """资源目录列表（codes 提供时仅返回授权子集）。

    供管理端勾选授权与网关端 ``GET /open`` 自助发现使用。
    """
    result = []
    for code, meta in OPEN_API_RESOURCES.items():
        if codes is not None and code not in codes:
            continue
        result.append(
            {
                "code": code,
                "name": meta["name"],
                "description": meta["description"],
                "filters": meta["filters"],
            }
        )
    return result
