"""设备日志接收（被动接入）API。

供"对方设备主动推送日志"场景配置 syslog/kafka 等接收器，并查看
接收情况（指标 / 接收日志 / 运行状态）与触发接收异常通知。

主要端点：
- ``GET/POST /log-receivers``：全局接收器列表 / 创建
- ``GET /devices/{id}/receivers``：某设备的接收器列表（供设备对接页使用）
- ``GET/PUT/DELETE /log-receivers/{id}``：详情 / 更新 / 删除
- ``POST /log-receivers/{id}/reload``：应用配置（启动/停止/重启监听）
- ``GET /log-receivers/metrics``：接收指标（按接收器按小时）
- ``GET /log-receivers/receive-logs``：接收日志明细
- ``GET /log-receivers/summary``：接收情况总览
"""
import json
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.log_receiver_manager import (
    adapter_registry,
    get_receiver_runtime_status,
    start_receiver_sync,
)
from app.core.log_receiver_manager.entry_registry import (
    LISTEN_PROTOCOLS,
    entry_registry,
)
from app.core.timezone import BEIJING_TZ, beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.models.device import Device
from app.models.log_receiver import (
    DeviceReceiveLog,
    DeviceReceiveMetric,
    LogReceiver,
)
from app.models.log_source_entry import LogSourceEntry
from app.models.parse_strategy import ParseStrategy
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/log-receivers",
    tags=["log-receivers"],
)


# ============ Schemas ============
class LogReceiverBase(BaseModel):
    """接收器创建/更新请求体（仅协议相关字段，公共校验在 handler 内）。"""

    device_id: int | None = Field(
        None,
        description="默认归属设备 ID（监听型 syslog/snmp_trap/netflow/pcap 可空，归属走来源条目；拉取型必填）",
    )
    name: str = Field(..., description="接收器名称，如 syslog-514")
    protocol: str = Field("syslog", description="源类型(接收协议): syslog/kafka/jdbc/snmp_trap/netflow/rest_api/pcap/file_tail")
    enabled: bool = Field(True, description="是否启用")
    syslog_port: int | None = Field(None, ge=1, le=65535, description="syslog 监听端口")
    syslog_proto: str = Field("udp", description="syslog 传输: udp/tcp")
    syslog_bind: str = Field("0.0.0.0", description="syslog 监听地址")
    kafka_bootstrap: str = Field("", description="kafka bootstrap servers（逗号分隔）")
    kafka_topic: str = Field("", description="kafka topic（逗号分隔）")
    kafka_group: str = Field("soar-ingest", description="kafka 消费组")
    kafka_security: str = Field("", description="kafka 安全配置 JSON")
    # 新源类型（jdbc/snmp_trap/netflow/rest_api/pcap/file_tail）的适配器参数统一走本字段；
    # syslog/kafka 兼容走上方扁平字段，本字段可为空
    adapter_config: dict = Field(default_factory=dict, description="适配器实例配置（JSON 对象：适配器参数 + 可选 pipeline 覆盖段）")
    format: str = Field("json", description="内容格式: json/raw")
    strategy_id: int | None = Field(None, description="手动绑定的解析策略 ID（NULL/0=自动匹配，>0 固定用该策略解析）")
    notify_interval_minutes: int = Field(0, ge=0, description="异常通知间隔（分钟）：0=仅首次通知一次，>0=异常期间每 N 分钟重复提醒")
    description: str = Field("", description="描述")


class ReceiverReloadResponse(BaseModel):
    id: int
    status: str
    message: str


class SourceEntryUpdate(BaseModel):
    """来源条目更新请求体（全部字段可选，仅更新显式提供的字段）。"""

    name: str | None = Field(None, description="条目名称（空则回退来源 IP）")
    device_id: int | None = Field(None, description="关联设备 ID（0=解除关联）")
    enabled: bool | None = Field(None, description="是否启用（停用=丢弃该来源日志）")
    strategy_id: int | None = Field(None, description="条目级解析策略 ID（0/NULL=跟随接收器，>0 固定用该策略）")
    # 条目级流水线覆盖：{"pipeline": {"filter": {...}, "enricher": {...}, "translator": {...}}}
    entry_config: dict | None = Field(None, description="条目级流水线覆盖 JSON")


class SourceEntryBatchDelete(BaseModel):
    ids: list[int] = Field(..., description="要删除的来源条目 ID 列表")


# ============ 内部工具 ============
def _parse_adapter_config(raw: str | None) -> dict:
    """解析 adapter_config JSON 列（异常容错为空 dict）。"""
    try:
        cfg = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def _serialize(
    rec: LogReceiver,
    runtime: dict | None = None,
    entries_map: dict | None = None,
    today_map: dict | None = None,
) -> dict:
    rr = runtime or get_receiver_runtime_status(rec.id)
    if entries_map is not None:
        entries_count = int(entries_map.get(rec.id, 0))
    else:
        entries_count = (
            db_count_entries(rec.id) if rec.protocol in LISTEN_PROTOCOLS else 0
        )
    today = (today_map or {}).get(rec.id, {})
    adapter_cfg = _parse_adapter_config(getattr(rec, "adapter_config", None))
    discovery = adapter_cfg.get("entry_discovery")
    if discovery is None:
        discovery = rec.protocol in LISTEN_PROTOCOLS
    return {
        "id": rec.id,
        "device_id": rec.device_id,
        "device_name": rec.device_name,
        "name": rec.name,
        "protocol": rec.protocol,
        "enabled": bool(rec.enabled),
        "syslog_port": rec.syslog_port,
        "syslog_proto": rec.syslog_proto,
        "syslog_bind": rec.syslog_bind,
        "kafka_bootstrap": rec.kafka_bootstrap,
        "kafka_topic": rec.kafka_topic,
        "kafka_group": rec.kafka_group,
        "kafka_security": rec.kafka_security,
        "adapter_config": adapter_cfg,
        "format": rec.format,
        "strategy_id": rec.strategy_id,
        "notify_interval_minutes": rec.notify_interval_minutes,
        "description": rec.description,
        "status": rec.status,
        "alive": rr.get("alive", False),
        "last_received_at": rec.last_received_at,
        "last_error": rec.last_error,
        "received_count": rec.received_count,
        "error_count": rec.error_count,
        # 今日接收/失败（device_receive_metrics 按小时聚合，stat_hour 为北京时间）
        "today_total": int(today.get("today_total", 0)),
        "today_fail": int(today.get("today_fail", 0)),
        # 来源条目（仅监听型接收器有意义；拉取型恒 0）
        "entries_count": entries_count,
        "entry_discovery": bool(discovery),
        "created_at": rec.created_at,
        "updated_at": rec.updated_at,
    }


def db_count_entries(receiver_id: int) -> int:
    """单接收器条目数（_serialize 单条场景使用；列表场景走 GROUP BY 批量）。"""
    from app.database import SessionLocal

    s = SessionLocal()
    try:
        return (
            s.query(LogSourceEntry)
            .filter(LogSourceEntry.receiver_id == receiver_id)
            .count()
        )
    finally:
        s.close()


def _serialize_entry(rec: LogSourceEntry, device_name: str = "") -> dict:
    return {
        "id": rec.id,
        "receiver_id": rec.receiver_id,
        "source_ip": rec.source_ip,
        "name": rec.name,
        "device_id": rec.device_id,
        "device_name": device_name,
        "enabled": bool(rec.enabled),
        "strategy_id": rec.strategy_id,
        "entry_config": _parse_adapter_config(getattr(rec, "entry_config", None)),
        "auto_created": bool(rec.auto_created),
        "received_count": rec.received_count,
        "last_received_at": rec.last_received_at,
        "created_at": rec.created_at,
        "updated_at": rec.updated_at,
    }


def _device_names_map(db: Session, rows) -> dict:
    """批量取条目关联设备名（避免 N+1）。"""
    dev_ids = {r.device_id for r in rows if r.device_id}
    if not dev_ids:
        return {}
    return {
        d.id: d.name
        for d in db.query(Device).filter(Device.id.in_(dev_ids)).all()
    }


def _validate_payload(body: LogReceiverBase) -> None:
    """协议相关参数校验（注册表驱动）。

    - 未知源类型 → 422（注册表报"不支持的接收协议"）；
    - 拉取型协议（kafka/jdbc/rest_api/file_tail）缺 device_id → 422
      （监听型可空，日志到达后按来源条目归属设备）；
    - 新源类型缺必填配置键 → 422（适配器 required_config_keys 中文逐条报错）；
    - syslog/kafka 保留旧扁平字段校验分支（既有前端/脚本零改动）。
    """
    protocol = body.protocol.lower()
    if protocol not in LISTEN_PROTOCOLS and not body.device_id:
        raise HTTPException(
            status_code=422,
            detail="拉取型源（kafka/jdbc/rest_api/file_tail）必须绑定默认归属设备（device_id）",
        )
    # 监听地址必须是单个合法 IP（IPv4/IPv6），空值等价 0.0.0.0
    from app.core.ip_validation import validate_listen_bind

    try:
        if protocol == "syslog":
            validate_listen_bind(body.syslog_bind, "syslog 监听地址")
        elif protocol in ("snmp_trap", "netflow"):
            validate_listen_bind(
                (body.adapter_config or {}).get("bind"),
                f"{protocol} 监听地址",
            )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if protocol in ("syslog", "kafka"):
        if protocol == "syslog":
            if not body.syslog_port:
                raise HTTPException(status_code=422, detail="syslog 协议必须配置监听端口 syslog_port")
        else:  # kafka
            if not body.kafka_bootstrap or not body.kafka_topic:
                raise HTTPException(status_code=422, detail="kafka 协议必须配置 kafka_bootstrap 与 kafka_topic")
        return
    # 新源类型：注册表校验（未注册协议 / 缺必配键）
    errors = adapter_registry.validate_config(protocol, dict(body.adapter_config or {}))
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))


def _listener_endpoint(bind, port) -> tuple[str, int] | None:
    """规范化绑端口源类型的监听端点为 (bind, port)；无端口返回 None。"""
    if not port:
        return None
    try:
        port = int(port)
    except (ValueError, TypeError):
        return None
    if not (1 <= port <= 65535):
        return None
    b = (str(bind) if bind else "").strip() or "0.0.0.0"
    return b, port


def _body_endpoint(protocol: str, body: LogReceiverBase) -> tuple[str, int] | None:
    """请求体的监听端点（syslog 走扁平列，snmp_trap/netflow 走 adapter_config）。"""
    if protocol == "syslog":
        return _listener_endpoint(body.syslog_bind, body.syslog_port)
    if protocol in ("snmp_trap", "netflow"):
        cfg = body.adapter_config or {}
        return _listener_endpoint(cfg.get("bind"), cfg.get("port"))
    return None


def _rec_endpoint(rec: LogReceiver) -> tuple[str, int] | None:
    """DB 记录的监听端点。"""
    protocol = (rec.protocol or "").lower()
    if protocol == "syslog":
        return _listener_endpoint(rec.syslog_bind, rec.syslog_port)
    if protocol in ("snmp_trap", "netflow"):
        cfg = _parse_adapter_config(getattr(rec, "adapter_config", None))
        return _listener_endpoint(cfg.get("bind"), cfg.get("port"))
    return None


def _check_port_conflict(db: Session, body: LogReceiverBase, exclude_id: int | None = None) -> None:
    """绑端口源类型（syslog/snmp_trap/netflow）的监听端点唯一性校验（409）。

    项目硬约束：每个接收器必须独占 bind:port 组合，避免端口冲突导致
    日志误归属（来源 IP 不参与判定，仅作记录字段）。
    """
    protocol = body.protocol.lower()
    endpoint = _body_endpoint(protocol, body)
    if endpoint is None:
        return
    rows = db.query(LogReceiver).filter(LogReceiver.enabled == 1).all()
    for rec in rows:
        if exclude_id is not None and rec.id == exclude_id:
            continue
        if _rec_endpoint(rec) == endpoint:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"监听地址端口冲突：{endpoint[0]}:{endpoint[1]} 已被接收器"
                    f"「{rec.name}」(ID={rec.id}) 占用，请为不同设备配置独立的监听端口或绑定地址"
                ),
            )


def _apply_fields(rec: LogReceiver, body: LogReceiverBase, device: Device | None) -> None:
    # 监听型接收器可空（归属走来源条目）；拉取型必填已由 _validate_payload 校验
    rec.device_id = device.id if device else None
    rec.device_name = device.name if device else ""
    rec.name = body.name.strip()
    rec.protocol = body.protocol.lower()
    rec.enabled = 1 if body.enabled else 0
    rec.syslog_port = body.syslog_port
    rec.syslog_proto = body.syslog_proto
    rec.syslog_bind = body.syslog_bind
    rec.kafka_bootstrap = body.kafka_bootstrap
    rec.kafka_topic = body.kafka_topic
    rec.kafka_group = body.kafka_group
    rec.kafka_security = body.kafka_security
    # 新源类型适配器配置（JSON 列；拉取类适配器运行中会节流回写轮询水位）
    rec.adapter_config = json.dumps(body.adapter_config or {}, ensure_ascii=False)
    rec.format = body.format
    rec.strategy_id = body.strategy_id
    rec.notify_interval_minutes = body.notify_interval_minutes
    rec.description = body.description


def _entries_count_map(db: Session, rows) -> dict:
    """批量统计各接收器条目数（一次 GROUP BY，避免列表 N+1）。"""
    if not rows:
        return {}
    gm = (
        db.query(LogSourceEntry.receiver_id, func.count(LogSourceEntry.id))
        .group_by(LogSourceEntry.receiver_id)
        .all()
    )
    return {rid: int(cnt) for rid, cnt in gm}


def _today_receiver_stats_map(db: Session) -> dict[int, dict]:
    """各接收器今日接收/失败统计（按小时聚合表 GROUP BY，stat_hour 为北京时间）。"""
    today_prefix = beijing_now().strftime("%Y-%m-%dT")
    rows = (
        db.query(
            DeviceReceiveMetric.receiver_id,
            func.sum(DeviceReceiveMetric.total_count),
            func.sum(DeviceReceiveMetric.fail_count),
        )
        .filter(DeviceReceiveMetric.stat_hour.like(today_prefix + "%"))
        .group_by(DeviceReceiveMetric.receiver_id)
        .all()
    )
    return {
        rid: {"today_total": int(t or 0), "today_fail": int(f or 0)}
        for rid, t, f in rows
    }


# ============ 全局列表 / 创建 ============
@router.get("", dependencies=[Depends(get_current_user)])
def list_receivers(
    device_id: int = Query(0, description="按设备过滤"),
    protocol: str = Query("", description="按源类型过滤: syslog/kafka/jdbc/snmp_trap/netflow/rest_api/pcap/file_tail"),
    db: Session = Depends(get_db),
) -> list[dict]:
    q = db.query(LogReceiver)
    if device_id:
        q = q.filter(LogReceiver.device_id == device_id)
    if protocol:
        q = q.filter(LogReceiver.protocol == protocol)
    rows = q.order_by(LogReceiver.id.desc()).all()
    entries_map = _entries_count_map(db, rows)
    today_map = _today_receiver_stats_map(db)
    return [_serialize(r, entries_map=entries_map, today_map=today_map) for r in rows]


@router.get("/summary", dependencies=[Depends(get_current_user)])
def receiver_summary(db: Session = Depends(get_db)) -> dict:
    """接收情况总览：接收器数 / 运行中数 / 异常数 / 今日接收与失败数。"""
    rows = db.query(LogReceiver).all()
    # 健康 = syslog 已 listening / kafka 已 running；binding/connecting 为过渡态不计入
    running = sum(1 for r in rows if r.status in ("listening", "running") and bool(r.enabled))
    abnormal = sum(
        1 for r in rows
        if r.status in ("start_failed", "failed", "stopped") and bool(r.enabled)
    )

    today_prefix = beijing_now().strftime("%Y-%m-%dT")
    mrows = (
        db.query(DeviceReceiveMetric)
        .filter(DeviceReceiveMetric.stat_hour.like(today_prefix + "%"))
        .all()
    )
    today_total = sum(m.total_count or 0 for m in mrows)
    today_fail = sum(m.fail_count or 0 for m in mrows)

    return {
        "receiver_count": len(rows),
        "running_count": running,
        "abnormal_count": abnormal,
        "today_total": today_total,
        "today_fail": today_fail,
    }


@router.get("/source-types", dependencies=[Depends(get_current_user)])
def list_source_types() -> list[dict]:
    """全部已注册源类型元数据（前端动态渲染下拉与配置表单）。"""
    return adapter_registry.source_types()


@router.post("", status_code=201)
def create_receiver(
    body: LogReceiverBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """创建接收器并立即应用（启动监听）。"""
    _validate_payload(body)
    _check_port_conflict(db, body)
    device = None
    if body.device_id:
        device = db.query(Device).filter(Device.id == body.device_id).first()
        if not device:
            raise HTTPException(status_code=404, detail="设备不存在")
    dup = (
        db.query(LogReceiver)
        .filter(LogReceiver.device_id == body.device_id, LogReceiver.name == body.name.strip())
        .first()
    )
    if dup:
        raise HTTPException(
            status_code=409,
            detail=f"已存在同名接收器: {body.name}",
        )
    rec = LogReceiver()
    _apply_fields(rec, body, device)
    # 先停用，等校验通过后再启动（避免端口冲突导致失败时留下异常状态）
    rec.enabled = 1 if body.enabled else 0
    db.add(rec)
    db.commit()
    db.refresh(rec)
    logger.info("日志接收器创建: id=%s device=%s protocol=%s", rec.id, device.name if device else "(条目归属)", rec.protocol)

    # 应用配置（启动监听并同步核实 bind/connect 结果）
    if rec.enabled:
        result = start_receiver_sync(rec.id)
        if result == "failed":
            # 端口占用/连接失败：回滚本次创建，避免留下无效接收器
            db.refresh(rec)
            error = (rec.last_error or "") or "绑定/连接失败"
            db.query(DeviceReceiveLog).filter(DeviceReceiveLog.receiver_id == rec.id).delete()
            db.delete(rec)
            db.commit()
            raise HTTPException(status_code=409, detail=f"接收器启动失败：{error}")
    db.refresh(rec)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="create",
        resource_type="log_receiver",
        resource_id=rec.id,
        detail={
            "name": rec.name,
            "protocol": rec.protocol,
            "listen": f"{rec.syslog_bind}:{rec.syslog_port}" if rec.syslog_port else "",
            "enabled": bool(rec.enabled),
        },
        ip_address=get_client_ip(request),
    )
    return _serialize(rec)


# ============ 设备维度接收器（供设备对接页使用） ============
@router.get("/by-device/{device_id}", dependencies=[Depends(get_current_user)])
def list_receivers_by_device(device_id: int, db: Session = Depends(get_db)) -> list[dict]:
    rows = (
        db.query(LogReceiver)
        .filter(LogReceiver.device_id == device_id)
        .order_by(LogReceiver.id.desc())
        .all()
    )
    entries_map = _entries_count_map(db, rows)
    today_map = _today_receiver_stats_map(db)
    return [_serialize(r, entries_map=entries_map, today_map=today_map) for r in rows]


# ============ 指标 & 接收日志（静态路径，需在 /{receiver_id} 之前注册） ============
@router.get("/metrics", dependencies=[Depends(get_current_user)])
def receive_metrics(
    hours: int = Query(24, ge=1, le=720, description="最近 N 小时"),
    receiver_id: int = Query(0, description="按接收器过滤"),
    db: Session = Depends(get_db),
) -> list[dict]:
    since = (datetime.now(BEIJING_TZ) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H")
    q = db.query(DeviceReceiveMetric).filter(DeviceReceiveMetric.stat_hour >= since)
    if receiver_id:
        q = q.filter(DeviceReceiveMetric.receiver_id == receiver_id)
    rows = q.order_by(DeviceReceiveMetric.stat_hour.desc()).all()
    return [
        {
            "stat_hour": m.stat_hour,
            "receiver_id": m.receiver_id,
            "receiver_name": m.receiver_name,
            "device_id": m.device_id,
            "protocol": m.protocol,
            "total_count": m.total_count,
            "success_count": m.success_count,
            "partial_count": m.partial_count,
            "fail_count": m.fail_count,
        }
        for m in rows
    ]


@router.get("/receive-logs", dependencies=[Depends(get_current_user)])
def receive_logs(
    receiver_id: int = Query(0, description="按接收器过滤"),
    device_id: int = Query(0, description="按设备过滤"),
    source_ip: str = Query("", description="按来源地址过滤（来源条目明细复用）"),
    parse_status: str = Query("", description="解析状态过滤: success/partial/fail/received"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    q = db.query(DeviceReceiveLog)
    if receiver_id:
        q = q.filter(DeviceReceiveLog.receiver_id == receiver_id)
    if device_id:
        q = q.filter(DeviceReceiveLog.device_id == device_id)
    if source_ip.strip():
        q = q.filter(DeviceReceiveLog.source_ip == source_ip.strip())
    if parse_status:
        q = q.filter(DeviceReceiveLog.parse_status == parse_status)
    total = q.count()
    rows = (
        q.order_by(DeviceReceiveLog.received_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "receiver_id": r.receiver_id,
                "device_id": r.device_id,
                "device_name": r.device_name,
                "protocol": r.protocol,
                "raw_data": r.raw_data,
                "source_ip": r.source_ip,
                "parse_status": r.parse_status,
                "parse_error": r.parse_error,
                "alert_id": r.alert_id,
                # 解析命中信息（详情页「解析结果」面板展示）
                "strategy_id": r.strategy_id,
                "strategy_name": r.strategy_name,
                "rule_id": r.rule_id,
                "log_type": r.log_type,
                "parsed_fields": r.parsed_fields,
                "received_at": r.received_at,
            }
            for r in rows
        ],
    }


# ============ 来源条目（监听型接收器按来源 IP 自动发现；静态路径先于 /{receiver_id} 注册） ============
@router.get("/{receiver_id}/entries", dependencies=[Depends(get_current_user)])
def list_source_entries(
    receiver_id: int,
    search: str = Query("", description="按来源 IP / 名称过滤"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """某接收器下全部来源条目（含接收统计与配置状态）。"""
    if not db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first():
        raise HTTPException(status_code=404, detail="接收器不存在")
    q = db.query(LogSourceEntry).filter(LogSourceEntry.receiver_id == receiver_id)
    if search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(or_(
            LogSourceEntry.source_ip.like(like),
            LogSourceEntry.name.like(like),
        ))
    total = q.count()
    rows = (
        q.order_by(LogSourceEntry.last_received_at.desc(), LogSourceEntry.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    names = _device_names_map(db, rows)
    return {
        "total": total,
        "items": [_serialize_entry(r, names.get(r.device_id, "")) for r in rows],
    }


# ============ 全局数据源条目（数据源条目页：跨接收器列表 / 条目详情） ============
# /entries 与 /entries/{entry_id} 为静态路径，必须先于 /{receiver_id} 注册
def _entry_today_stats_map(db: Session) -> dict[tuple[int, str], dict]:
    """各 (receiver_id, source_ip) 今日接收/解析成功/失败统计（接收明细按日聚合）。

    口径说明：一条日志事件在 device_receive_logs 中先写 ``received`` 中间态行，
    解析完成再写终态行（success/partial/fail/unknown），两行同事务提交。
    今日统计只数终态行、排除 ``received`` 中间态行，与条目累计计数
    （entry_registry.bump 每事件一次）同口径，避免同一事件被计两次。

    - today_parsed = success + partial（部分解析同样完成入库）；
    - today_failed = fail + unknown（unknown 为类型识别失败，按失败口径累计）；
    - received_at 由数据库 server_default 写入，"今日"用 CURRENT_DATE 同源比较，
      避免容器/数据库时区差异导致错位。
    """
    parsed_expr = case(
        (DeviceReceiveLog.parse_status.in_(("success", "partial")), 1),
        else_=0,
    )
    failed_expr = case(
        (DeviceReceiveLog.parse_status.in_(("fail", "unknown")), 1),
        else_=0,
    )
    rows = (
        db.query(
            DeviceReceiveLog.receiver_id,
            DeviceReceiveLog.source_ip,
            func.count(DeviceReceiveLog.id),
            func.sum(parsed_expr),
            func.sum(failed_expr),
        )
        .filter(
            DeviceReceiveLog.received_at >= func.current_date(),
            DeviceReceiveLog.parse_status != "received",
        )
        .group_by(DeviceReceiveLog.receiver_id, DeviceReceiveLog.source_ip)
        .all()
    )
    return {
        (rid, ip or ""): {
            "today_received": int(t or 0),
            "today_parsed": int(s or 0),
            "today_failed": int(f or 0),
        }
        for rid, ip, t, s, f in rows
    }


def _entry_status(rec: LogSourceEntry, today: dict) -> str:
    """条目状态：待配置 pending / 已接入 active / 解析异常 parse_error（停用单列 disabled）。

    - 解析异常：今日存在解析失败日志（fail/unknown > 0），即使另有成功也计入，
      便于及时发现模板规则漏配/校验误伤（与统计卡片口径一致）；
    - 待配置：自动发现后尚未做过任何手工配置（未绑设备、未固定模板）；
    - 已接入：其余正常情形。
    """
    if not rec.enabled:
        return "disabled"
    if today.get("today_failed", 0) > 0:
        return "parse_error"
    if rec.auto_created and not rec.strategy_id and not rec.device_id:
        return "pending"
    return "active"


def _serialize_entry_page(
    rec: LogSourceEntry,
    receiver: LogReceiver | None,
    device: Device | None,
    strategy_names: dict[int, str],
    today: dict,
) -> dict:
    """数据源条目页行序列化（含所属接收器、绑定设备类型、模板解析链、今日统计与三态状态）。"""
    receiver_strategy_id = receiver.strategy_id if receiver else None
    # 模板解析优先级链：条目 → 接收器 → 自动匹配（Classifier）
    if rec.strategy_id:
        bound_source, bound_id = "entry", rec.strategy_id
    elif receiver_strategy_id:
        bound_source, bound_id = "receiver", receiver_strategy_id
    else:
        bound_source, bound_id = "auto", None
    return {
        "id": rec.id,
        "receiver_id": rec.receiver_id,
        "receiver_name": receiver.name if receiver else f"#{rec.receiver_id}",
        "receiver_protocol": receiver.protocol if receiver else "",
        "receiver_strategy_id": receiver_strategy_id,
        "source_ip": rec.source_ip,
        "name": rec.name or rec.source_ip,
        "device_id": rec.device_id,
        "device_name": device.name if device else "",
        "device_type": device.type if device else "",
        "device_vendor": device.vendor if device else "",
        "enabled": bool(rec.enabled),
        "strategy_id": rec.strategy_id,
        "entry_config": _parse_adapter_config(getattr(rec, "entry_config", None)),
        "auto_created": bool(rec.auto_created),
        "received_count": rec.received_count,
        "today_received": int(today.get("today_received", 0)),
        "today_parsed": int(today.get("today_parsed", 0)),
        "today_failed": int(today.get("today_failed", 0)),
        "last_received_at": rec.last_received_at,
        "status": _entry_status(rec, today),
        "bound_strategy_id": bound_id,
        "bound_strategy_name": strategy_names.get(bound_id, "") if bound_id else "",
        "bound_strategy_source": bound_source,
        "created_at": rec.created_at,
        "updated_at": rec.updated_at,
    }


@router.get("/entries", dependencies=[Depends(get_current_user)])
def list_all_source_entries(
    receiver_id: int = Query(0, description="按接收器过滤"),
    search: str = Query("", description="按来源 IP / 名称过滤"),
    status: str = Query("", description="状态过滤: pending/active/parse_error/disabled"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """全局数据源条目列表（跨接收器，含三态状态与今日接收/解析统计）。"""
    q = db.query(LogSourceEntry)
    if receiver_id:
        q = q.filter(LogSourceEntry.receiver_id == receiver_id)
    if search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(or_(
            LogSourceEntry.source_ip.like(like),
            LogSourceEntry.name.like(like),
        ))
    rows = q.order_by(
        LogSourceEntry.last_received_at.desc(), LogSourceEntry.id.desc()
    ).all()
    # 三态状态依赖今日统计：先一次 GROUP BY 批量算统计，再内存过滤 + 分页
    # （条目量级为每接收器默认上限 1000，全量载入可接受）
    today_map = _entry_today_stats_map(db)
    status_counts = {"pending": 0, "active": 0, "parse_error": 0, "disabled": 0}
    for r in rows:
        status_counts[_entry_status(r, today_map.get((r.receiver_id, r.source_ip), {}))] += 1
    if status:
        rows = [r for r in rows if _entry_status(r, today_map.get((r.receiver_id, r.source_ip), {})) == status]
    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    recv_ids = {r.receiver_id for r in page_rows}
    receivers = {
        x.id: x for x in db.query(LogReceiver).filter(LogReceiver.id.in_(recv_ids)).all()
    } if recv_ids else {}
    dev_ids = {r.device_id for r in page_rows if r.device_id}
    devices = {
        d.id: d for d in db.query(Device).filter(Device.id.in_(dev_ids)).all()
    } if dev_ids else {}
    strategy_names = {s.id: s.strategy_name for s in db.query(ParseStrategy).all()}
    return {
        "total": total,
        "status_counts": status_counts,
        "items": [
            _serialize_entry_page(
                r,
                receivers.get(r.receiver_id),
                devices.get(r.device_id),
                strategy_names,
                today_map.get((r.receiver_id, r.source_ip), {}),
            )
            for r in page_rows
        ],
    }


@router.get("/entries/{entry_id}", dependencies=[Depends(get_current_user)])
def get_source_entry_detail(entry_id: int, db: Session = Depends(get_db)) -> dict:
    """数据源条目详情（条目详情页三 Tab 的主数据源）。"""
    rec = db.query(LogSourceEntry).filter(LogSourceEntry.id == entry_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="来源条目不存在")
    receiver = db.query(LogReceiver).filter(LogReceiver.id == rec.receiver_id).first()
    device = (
        db.query(Device).filter(Device.id == rec.device_id).first()
        if rec.device_id else None
    )
    strategy_names = {s.id: s.strategy_name for s in db.query(ParseStrategy).all()}
    today_map = _entry_today_stats_map(db)
    return _serialize_entry_page(
        rec, receiver, device, strategy_names,
        today_map.get((rec.receiver_id, rec.source_ip), {}),
    )


# ============ 条目失败样本下钻（成功率列点击：原因四分类 + 样本列表） ============
# 失败原因分类 → 中文标签（与模板维度 ingest.py 保持一致）
ENTRY_REASON_LABELS = {
    "no_template": "无匹配模板",
    "missing_field": "字段缺失",
    "validation_failed": "校验不通过",
    "format_error": "格式异常",
    "other": "其他",
}


def _classify_receive_failure(parse_status: str, error_msg: str) -> str:
    """条目失败原因四分类（基于接收明细的解析状态与错误文本）。"""
    if (parse_status or "") == "unknown":
        return "no_template"
    msg = error_msg or ""
    low = msg.lower()
    if "无匹配" in msg or "类型识别" in msg or "unknown" in low or "no_strategy" in low:
        return "no_template"
    if "缺失" in msg or "missing" in low:
        return "missing_field"
    if "校验" in msg or "正则" in msg or "valid" in low:
        return "validation_failed"
    if "json" in low or "格式" in msg or "不是" in msg or "format" in low:
        return "format_error"
    return "other"


def _entry_failure_reason_filter(reason: str):
    """原因 → SQLAlchemy 过滤条件（条目维度基于 parse_error 文本匹配）。"""
    err = DeviceReceiveLog.parse_error
    unknown_like = or_(
        DeviceReceiveLog.parse_status == "unknown",
        err.ilike("%无匹配%"), err.ilike("%类型识别%"),
        err.ilike("%unknown%"), err.ilike("%no_strategy%"),
    )
    if reason == "no_template":
        return unknown_like
    if reason == "missing_field":
        return or_(err.ilike("%缺失%"), err.ilike("%missing%"))
    if reason == "validation_failed":
        return or_(err.ilike("%校验%"), err.ilike("%正则%"), err.ilike("%valid%"))
    if reason == "format_error":
        return or_(err.ilike("%json%"), err.ilike("%格式%"), err.ilike("%不是%"), err.ilike("%format%"))
    if reason == "other":
        return and_(~unknown_like, ~or_(
            err.ilike("%缺失%"), err.ilike("%missing%"),
            err.ilike("%校验%"), err.ilike("%正则%"), err.ilike("%valid%"),
            err.ilike("%json%"), err.ilike("%格式%"), err.ilike("%不是%"), err.ilike("%format%"),
        ))
    return None


@router.get("/entries/{entry_id}/failure-samples", dependencies=[Depends(get_current_user)])
def entry_failure_samples(
    entry_id: int,
    reason: str = Query("", description="失败原因分类过滤"),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """条目失败样本下钻：该来源今日起失败明细 + 原因分类统计（分页，可按原因筛选）。"""
    rec = db.query(LogSourceEntry).filter(LogSourceEntry.id == entry_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="来源条目不存在")
    base = db.query(DeviceReceiveLog).filter(
        DeviceReceiveLog.receiver_id == rec.receiver_id,
        DeviceReceiveLog.source_ip == rec.source_ip,
        DeviceReceiveLog.parse_status.in_(("fail", "unknown")),
    )

    # 原因分类统计（全量）
    stats = {k: 0 for k in ENTRY_REASON_LABELS}
    for st, msg in (
        base.with_entities(DeviceReceiveLog.parse_status, DeviceReceiveLog.parse_error).all()
    ):
        stats[_classify_receive_failure(st or "", msg or "")] += 1

    query = base
    if reason:
        cond = _entry_failure_reason_filter(reason)
        if cond is not None:
            query = query.filter(cond)

    total = query.count()
    rows = (
        query.order_by(DeviceReceiveLog.received_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "stats": stats,
        "reason_labels": ENTRY_REASON_LABELS,
        "entry": {"id": rec.id, "source_ip": rec.source_ip, "receiver_id": rec.receiver_id},
        "items": [
            {
                "id": r.id,
                "received_at": r.received_at,
                "parse_status": r.parse_status,
                "reason_class": _classify_receive_failure(r.parse_status or "", r.parse_error or ""),
                "reason_label": ENTRY_REASON_LABELS.get(
                    _classify_receive_failure(r.parse_status or "", r.parse_error or ""), "其他"
                ),
                "error_msg": r.parse_error,
                "raw_data": r.raw_data,
            }
            for r in rows
        ],
    }


@router.put("/entries/{entry_id}", dependencies=[Depends(require_role("admin"))])
def update_source_entry(
    entry_id: int,
    body: SourceEntryUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """更新来源条目（名称/关联设备/启停/解析策略/流水线覆盖），同进程缓存立即失效。"""
    rec = db.query(LogSourceEntry).filter(LogSourceEntry.id == entry_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="来源条目不存在")
    changes: dict = {}
    if body.name is not None:
        new_name = body.name.strip() or rec.source_ip
        if new_name != rec.name:
            changes["name"] = {"old": rec.name, "new": new_name}
        rec.name = new_name
    if body.device_id is not None:
        if body.device_id and not db.query(Device).filter(Device.id == body.device_id).first():
            raise HTTPException(status_code=404, detail="设备不存在")
        new_device = body.device_id or None
        if new_device != rec.device_id:
            changes["device_id"] = {"old": rec.device_id, "new": new_device}
        rec.device_id = new_device
    if body.enabled is not None:
        new_enabled = 1 if body.enabled else 0
        if new_enabled != rec.enabled:
            changes["enabled"] = {"old": bool(rec.enabled), "new": body.enabled}
        rec.enabled = new_enabled
    if body.strategy_id is not None:
        if body.strategy_id and not db.query(ParseStrategy).filter(ParseStrategy.id == body.strategy_id).first():
            raise HTTPException(status_code=404, detail="解析策略不存在")
        # 0/None = 跟随接收器（条目级不覆盖）
        new_strategy = body.strategy_id or None
        if new_strategy != rec.strategy_id:
            changes["strategy_id"] = {"old": rec.strategy_id, "new": new_strategy}
        rec.strategy_id = new_strategy
    if body.entry_config is not None:
        new_config = json.dumps(body.entry_config or {}, ensure_ascii=False)
        if new_config != rec.entry_config:
            changes["entry_config"] = "modified"
        rec.entry_config = new_config
    rec.auto_created = 0  # 手工配置过即视为已管理
    db.commit()
    db.refresh(rec)
    entry_registry.invalidate(rec.receiver_id, rec.source_ip)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        resource_type="log_source_entry",
        resource_id=rec.id,
        detail={"name": rec.name, "source_ip": rec.source_ip, "changes": changes},
        ip_address=get_client_ip(request),
    )
    logger.info(
        "来源条目更新: id=%s receiver=%s source_ip=%s", rec.id, rec.receiver_id, rec.source_ip,
    )
    dev = db.query(Device).filter(Device.id == rec.device_id).first() if rec.device_id else None
    return _serialize_entry(rec, dev.name if dev else "")


@router.delete("/entries/{entry_id}", status_code=204)
def delete_source_entry(
    entry_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> None:
    """删除来源条目（该来源再次发日志时会按发现开关重新自动创建）。"""
    rec = db.query(LogSourceEntry).filter(LogSourceEntry.id == entry_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="来源条目不存在")
    entry_registry.invalidate(rec.receiver_id, rec.source_ip)
    db.delete(rec)
    db.commit()
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="delete",
        resource_type="log_source_entry",
        resource_id=entry_id,
        detail={"name": rec.name, "source_ip": rec.source_ip, "receiver_id": rec.receiver_id},
        ip_address=get_client_ip(request),
    )
    logger.info("来源条目删除: id=%s receiver=%s source_ip=%s", entry_id, rec.receiver_id, rec.source_ip)


@router.post("/{receiver_id}/entries/batch-delete")
def batch_delete_source_entries(
    receiver_id: int,
    body: SourceEntryBatchDelete,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """批量删除某接收器下的来源条目。"""
    if not body.ids:
        return {"deleted": 0}
    rows = (
        db.query(LogSourceEntry)
        .filter(LogSourceEntry.receiver_id == receiver_id, LogSourceEntry.id.in_(body.ids))
        .all()
    )
    # 审计信息需在删除前收集（提交后 ORM 对象过期不可再访问属性）
    audit_ids = [r.id for r in rows]
    audit_ips = [r.source_ip for r in rows]
    for r in rows:
        entry_registry.invalidate(r.receiver_id, r.source_ip)
    db.query(LogSourceEntry).filter(
        LogSourceEntry.receiver_id == receiver_id,
        LogSourceEntry.id.in_(body.ids),
    ).delete(synchronize_session=False)
    db.commit()
    if rows:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="delete",
            resource_type="log_source_entry",
            resource_id=receiver_id,
            detail={
                "operation": "batch_delete",
                "receiver_id": receiver_id,
                "count": len(rows),
                "ids": audit_ids,
                "source_ips": audit_ips,
            },
            ip_address=get_client_ip(request),
        )
    logger.info("来源条目批量删除: receiver=%s ids=%s", receiver_id, body.ids)
    return {"deleted": len(rows)}


# ============ 详情 / 更新 / 删除 / 启停 ============
@router.get("/{receiver_id}", dependencies=[Depends(get_current_user)])
def get_receiver(receiver_id: int, db: Session = Depends(get_db)) -> dict:
    rec = db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="接收器不存在")
    return _serialize(rec)


@router.put("/{receiver_id}")
def update_receiver(
    receiver_id: int,
    body: LogReceiverBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """更新接收器，若被启用则重启监听以应用新配置。"""
    rec = db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="接收器不存在")
    _validate_payload(body)
    _check_port_conflict(db, body, exclude_id=receiver_id)
    device = None
    if body.device_id:
        device = db.query(Device).filter(Device.id == body.device_id).first()
        if not device:
            raise HTTPException(status_code=404, detail="设备不存在")

    # 记录字段级变更（敏感/大 JSON 字段只记"已修改"）
    changes: dict = {}
    simple_map = {
        "name": body.name.strip(), "protocol": body.protocol.lower(),
        "enabled": 1 if body.enabled else 0, "device_id": device.id if device else None,
        "syslog_port": body.syslog_port, "syslog_proto": body.syslog_proto,
        "syslog_bind": body.syslog_bind, "format": body.format,
        "strategy_id": body.strategy_id,
        "notify_interval_minutes": body.notify_interval_minutes,
        "description": body.description,
        "kafka_bootstrap": body.kafka_bootstrap, "kafka_topic": body.kafka_topic,
        "kafka_group": body.kafka_group,
    }
    for fname, new_val in simple_map.items():
        old_val = getattr(rec, fname)
        if old_val != new_val:
            changes[fname] = {"old": old_val, "new": new_val}
    if json.dumps(body.kafka_security or {}, ensure_ascii=False) != (rec.kafka_security or "{}"):
        changes["kafka_security"] = "modified"
    if json.dumps(body.adapter_config or {}, ensure_ascii=False) != (rec.adapter_config or "{}"):
        changes["adapter_config"] = "modified"

    _apply_fields(rec, body, device)
    db.commit()
    logger.info("日志接收器更新: id=%s", rec.id)

    # 应用配置：停掉旧线程再按需要重启（start_receiver_sync 内部会停止旧代线程）
    if rec.enabled:
        result = start_receiver_sync(rec.id)
        if result == "failed":
            db.refresh(rec)
            raise HTTPException(
                status_code=409,
                detail=f"接收器更新后启动失败：{rec.last_error or '绑定/连接失败'}",
            )
    else:
        from app.core.log_receiver_manager import stop_receiver_thread

        stop_receiver_thread(rec.id)
        rec.status = "stopped"
        db.commit()

    db.refresh(rec)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        resource_type="log_receiver",
        resource_id=rec.id,
        detail={"name": rec.name, "changes": changes},
        ip_address=get_client_ip(request),
    )
    return _serialize(rec)


@router.patch("/{receiver_id}/reload")
def reload_receiver(
    receiver_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> ReceiverReloadResponse:
    """启停/重启指定接收器的监听线程。"""
    rec = db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="接收器不存在")
    from app.core.log_receiver_manager import stop_receiver_thread

    if rec.enabled:
        result = start_receiver_sync(rec.id)
        if result == "failed":
            rec.status = "failed"
            db.commit()
            db.refresh(rec)
            return ReceiverReloadResponse(
                id=rec.id, status="failed",
                message=f"接收器启动失败：{rec.last_error or '绑定/连接失败'}",
            )
        db.refresh(rec)
        log_audit(
            db, user_id=user.id, username=user.username, action="execute",
            resource_type="log_receiver", resource_id=rec.id,
            detail={"operation": "reload", "name": rec.name, "status": "running"},
            ip_address=get_client_ip(request),
        )
        return ReceiverReloadResponse(id=rec.id, status="running", message="接收器已启动")
    stop_receiver_thread(rec.id)
    rec.status = "stopped"
    db.commit()
    log_audit(
        db, user_id=user.id, username=user.username, action="execute",
        resource_type="log_receiver", resource_id=rec.id,
        detail={"operation": "reload", "name": rec.name, "status": "stopped"},
        ip_address=get_client_ip(request),
    )
    return ReceiverReloadResponse(id=rec.id, status="stopped", message="接收器已停止")


@router.delete("/{receiver_id}", status_code=204)
def delete_receiver(
    receiver_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> None:
    """删除接收器并停止监听。"""
    rec = db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="接收器不存在")
    from app.core.log_receiver_manager import stop_receiver_thread

    receiver_name = rec.name
    stop_receiver_thread(rec.id)
    # 级联清理该接收器的接收明细、聚合指标与来源条目（孤儿数据）
    db.query(DeviceReceiveLog).filter(DeviceReceiveLog.receiver_id == receiver_id).delete()
    db.query(DeviceReceiveMetric).filter(DeviceReceiveMetric.receiver_id == receiver_id).delete()
    db.query(LogSourceEntry).filter(LogSourceEntry.receiver_id == receiver_id).delete(synchronize_session=False)
    entry_registry.invalidate(receiver_id)
    db.delete(rec)
    db.commit()
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="delete",
        resource_type="log_receiver",
        resource_id=receiver_id,
        detail={"name": receiver_name},
        ip_address=get_client_ip(request),
    )
    logger.info("日志接收器删除: id=%s", receiver_id)
