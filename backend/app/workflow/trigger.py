"""告警入库事件订阅与触发规则匹配。

机制：
- ``publish_alert_ingested(fields)``：解析引擎入库成功后调用（进程内队列，不阻塞入库；
  发布失败只记日志，不回滚入库）
- 后台 worker 线程消费事件：规则匹配（AND 条件）→ 冷却/幂等/限频/熔断检查
  → 创建 workflow_instance → 引擎执行
- 熔断：连续 10 个实例在智能体节点失败 → 暂停触发并通知运营，人工恢复
"""
import json
import logging
import queue
import threading
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.config import settings
from app.database import LinkageSessionLocal, SessionLocal, close_db_session
from app.workflow.concurrency import release_workflow_inflight, try_acquire_workflow_inflight
from app.models.alert_event import AlertEvent
from app.models.system_config import SystemConfig
from app.models.workflow_ban import WorkflowInstance, WorkflowTriggerRule
from app.workflow.audit import write_audit
from app.workflow.notify import notify_ops

logger = logging.getLogger(__name__)

# 进程内事件队列（发布方不阻塞）
_event_queue: "queue.Queue[dict]" = queue.Queue()

# 熔断状态（进程内存，重启复位；人工恢复走 API）
_CIRCUIT_FAIL_THRESHOLD = 10
_circuit_lock = threading.Lock()
_circuit_fail_streak = 0
_circuit_paused = False

# 限频配置键与默认值
_RATE_LIMIT_KEY = "workflow_instance_rate_limit"
_DEFAULT_RATE_LIMIT = 20
_last_throttle_notify: Optional[Any] = None


# ======================================================================
# 事件发布（入库主流程调用，必须永不抛错）
# ======================================================================
def publish_alert_ingested(fields: dict[str, Any]) -> None:
    """发布 alert.ingested 事件（进程内异步队列）。

    parse_status 为 success / partial 均触发；发布失败只记日志。
    """
    try:
        _event_queue.put({
            "alert_id": fields.get("id"),
            "alert_uuid": fields.get("uuid"),
            "src_ip": fields.get("src_ip"),
            "strategy_id": fields.get("strategy_id"),
            "parse_status": fields.get("parse_status"),
        })
    except Exception:  # noqa: BLE001
        logger.exception("alert.ingested 事件发布失败（不影响入库）")


# ======================================================================
# 熔断
# ======================================================================
def record_agent_outcome(*, ok: bool) -> None:
    """智能体节点结果上报：成功清零连败；连败达阈值暂停触发并通知运营。"""
    global _circuit_fail_streak, _circuit_paused
    with _circuit_lock:
        if ok:
            _circuit_fail_streak = 0
            return
        _circuit_fail_streak += 1
        if _circuit_fail_streak >= _CIRCUIT_FAIL_THRESHOLD and not _circuit_paused:
            _circuit_paused = True
            paused_streak = _circuit_fail_streak
            _notify_circuit_open_async(paused_streak)


def _notify_circuit_open_async(streak: int) -> None:
    """熔断通知（独立线程写库，避免占用引擎会话）。"""
    def _run() -> None:
        db = SessionLocal()
        try:
            notify_ops(
                db, "封禁工作流已熔断暂停",
                f"智能体研判连续失败 {streak} 次，已暂停触发新实例，请在实例管理页人工恢复。",
                ntype="workflow_alert",
            )
        finally:
            db.close()

    threading.Thread(target=_run, daemon=True).start()


def get_circuit_state() -> dict:
    """熔断状态查询。"""
    with _circuit_lock:
        return {
            "paused": _circuit_paused,
            "fail_streak": _circuit_fail_streak,
            "threshold": _CIRCUIT_FAIL_THRESHOLD,
        }


def reset_circuit_breaker(operator: str = "admin") -> dict:
    """人工恢复熔断（清零连败计数并恢复触发）。"""
    global _circuit_fail_streak, _circuit_paused
    with _circuit_lock:
        _circuit_fail_streak = 0
        _circuit_paused = False
    logger.info("熔断已人工恢复: operator=%s", operator)
    return {"paused": False, "fail_streak": 0}


# ======================================================================
# 规则匹配
# ======================================================================
def _load_list(raw: Any) -> list:
    """条件字段 → 列表（JSON 字符串或原生列表）。"""
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw:
        try:
            v = json.loads(raw)
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
    return []


def match_rules(db: Session, alert: AlertEvent) -> Optional[WorkflowTriggerRule]:
    """逐条评估启用的触发规则（条件 AND），多条命中取优先级最高的一条。"""
    rules = (
        db.query(WorkflowTriggerRule)
        .filter(WorkflowTriggerRule.status == "enabled")
        .order_by(WorkflowTriggerRule.priority.desc(), WorkflowTriggerRule.id.asc())
        .all()
    )
    for rule in rules:
        try:
            conditions = json.loads(rule.conditions or "{}")
        except (ValueError, TypeError):
            conditions = {}
        if _rule_matches(alert, conditions):
            return rule
    return None


def _rule_matches(alert: AlertEvent, cond: dict) -> bool:
    """单条规则匹配：全部条件 AND；未配置的条件视为通过。

    direction 等字段在标准模型中为字符串存储，条件值可能为 int，
    统一转 str 比较避免类型不匹配漏判。
    """
    risk_levels = _load_list(cond.get("risk_levels"))
    if risk_levels and str(alert.risk_level) not in {str(v) for v in risk_levels}:
        return False
    min_severity = cond.get("min_severity")
    if min_severity is not None and (alert.severity or 0) < int(min_severity):
        return False
    directions = _load_list(cond.get("directions"))
    if directions and str(alert.direction) not in {str(v) for v in directions}:
        return False
    src_ip_tags = _load_list(cond.get("src_ip_tags"))
    if src_ip_tags:
        alert_tags = _load_list(alert.src_ip_tag)
        if not set(str(t) for t in alert_tags) & set(str(t) for t in src_ip_tags):
            return False
    keywords = _load_list(cond.get("alert_name_keywords"))
    if keywords and not any(str(k) in (alert.alert_name or "") for k in keywords):
        return False
    threat_classes = _load_list(cond.get("threat_classes"))
    if threat_classes and (alert.threat_class or "") not in threat_classes:
        return False
    return True


# ======================================================================
# 冷却 / 幂等 / 限频
# ======================================================================
def _first_ip(src_ip: Any) -> str:
    """src_ip（JSON 数组字符串/单值）→ 首个 IP。"""
    if not src_ip:
        return ""
    s = str(src_ip)
    if s.startswith("["):
        try:
            arr = json.loads(s)
            return str(arr[0]) if arr else ""
        except (ValueError, TypeError):
            return s
    return s


def _in_cooldown(db: Session, alert: AlertEvent, cooldown_minutes: int) -> bool:
    """同一源 IP 冷却期内是否已有触发实例（按告警 occur_timestamp 判断）。"""
    since = (alert.occur_timestamp or beijing_now()) - timedelta(minutes=cooldown_minutes)
    row = (
        db.query(WorkflowInstance.id)
        .join(AlertEvent, AlertEvent.id == WorkflowInstance.alert_id)
        .filter(WorkflowInstance.src_ip == _first_ip(alert.src_ip))
        .filter(AlertEvent.occur_timestamp >= since)
        .filter(AlertEvent.occur_timestamp < alert.occur_timestamp)
        .first()
    )
    return row is not None


def _rate_limit(db: Session) -> int:
    """读取限频阈值（SystemConfig 可配，默认 20/分钟）。"""
    cfg = db.query(SystemConfig).filter(SystemConfig.key == _RATE_LIMIT_KEY).first()
    if cfg and cfg.value:
        try:
            return max(1, int(cfg.value))
        except ValueError:
            pass
    return _DEFAULT_RATE_LIMIT


def _over_rate_limit(db: Session) -> bool:
    """最近 1 分钟新建实例数是否超阈值。"""
    limit = _rate_limit(db)
    recent = (
        db.query(WorkflowInstance.id)
        .filter(WorkflowInstance.created_at >= beijing_now() - timedelta(minutes=1))
        .count()
    )
    return recent >= limit


# 在途槽位满时延后重跑实例（避免已建单却永久不封禁）
_INFLIGHT_RETRY_SEC = 5
_INFLIGHT_RETRY_MAX = 120  # 约 10 分钟


def _defer_run_instance(instance_id: int, attempt: int = 0) -> None:
    """在途满时延后执行；低频封禁场景下最终会跑到 record_ban。"""
    if try_acquire_workflow_inflight():
        from app.workflow.engine import run_instance

        try:
            run_instance(instance_id)
        finally:
            release_workflow_inflight()
        return
    if attempt >= _INFLIGHT_RETRY_MAX:
        db_fail = LinkageSessionLocal()
        try:
            inst = db_fail.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
            if inst is not None and inst.status == "running":
                inst.status = "error"
                inst.error_msg = "联动并发长时间满载，实例执行超时（请人工核对是否需补封禁）"
                inst.finished_at = beijing_now()
                db_fail.commit()
        finally:
            db_fail.close()
        logger.error("实例 #%s 在途重试耗尽，已标记 error", instance_id)
        return
    logger.info(
        "联动在途满，%ss 后重试实例 #%s (attempt=%s)",
        _INFLIGHT_RETRY_SEC, instance_id, attempt + 1,
    )
    threading.Timer(
        _INFLIGHT_RETRY_SEC,
        lambda: _defer_run_instance(instance_id, attempt + 1),
    ).start()


# ======================================================================
# 后台 worker
# ======================================================================
def _process_event(event: dict[str, Any]) -> None:
    """处理单条入库事件：规则匹配 → 去重/冷却/限频/熔断 → 建实例 → 执行。"""
    from app.workflow.engine import run_instance

    # run_instance 会跨越整个工作流执行（含 LLM 研判/设备调用，分钟级），
    # 必须用联动专用池，避免长时间占用主池拖垮 API 请求
    db = LinkageSessionLocal()
    try:
        alert = db.query(AlertEvent).filter(AlertEvent.id == event.get("alert_id")).first()
        if alert is None:
            return
        # 幂等兜底：同 alert_uuid 已有实例则跳过
        exists = db.query(WorkflowInstance.id).filter(
            WorkflowInstance.alert_uuid == alert.uuid,
        ).first() if alert.uuid else None
        if exists:
            logger.debug("重复 alert_uuid 跳过触发: %s", alert.uuid)
            return

        # 熔断暂停：不创建新实例
        if get_circuit_state()["paused"]:
            logger.warning("熔断暂停中，跳过触发: alert=%s", alert.uuid)
            write_audit(db, action="workflow_trigger_skipped", resource_type="alert_event",
                        resource_id=alert.id, detail={"reason": "circuit_breaker_open"})
            return

        rule = match_rules(db, alert)
        if rule is None:
            return

        src_ip = _first_ip(alert.src_ip)
        # 冷却期检查
        if _in_cooldown(db, alert, rule.cooldown_minutes or 60):
            logger.info("冷却期内跳过触发: ip=%s rule=%s", src_ip, rule.rule_name)
            write_audit(db, action="workflow_trigger_skipped", resource_type="alert_event",
                        resource_id=alert.id, detail={"reason": "cooldown", "ip": src_ip, "rule": rule.rule_name})
            return
        # 触发风暴保护
        if _over_rate_limit(db):
            logger.warning("触发限频：超出每分钟阈值，仅记录不执行: ip=%s", src_ip)
            write_audit(db, action="workflow_trigger_skipped", resource_type="alert_event",
                        resource_id=alert.id, detail={"reason": "rate_limited", "ip": src_ip})
            notify_ops(
                db, "封禁工作流触发限频",
                f"每分钟新建实例数已达阈值，IP {src_ip} 的触发仅记录未执行，请检查告警风暴。",
                ntype="workflow_alert",
            )
            return

        instance = WorkflowInstance(
            alert_id=alert.id,
            alert_uuid=alert.uuid,
            src_ip=src_ip,
            strategy_id=alert.strategy_id,
            trigger_rule_id=rule.id,
            status="running",
        )
        db.add(instance)
        try:
            db.commit()
        except IntegrityError:
            # alert_uuid 唯一索引兜底（并发幂等）
            db.rollback()
            logger.info("alert_uuid 唯一索引拦截重复触发: %s", alert.uuid)
            return

        write_audit(db, action="workflow_trigger", resource_type="workflow_instance",
                    resource_id=instance.id,
                    detail={"ip": src_ip, "rule": rule.rule_name, "alert_uuid": alert.uuid})
        logger.info("工作流实例已创建: id=%s ip=%s rule=%s", instance.id, src_ip, rule.rule_name)

        instance_id = instance.id
        close_db_session(db)
        db = None

        if not try_acquire_workflow_inflight():
            _defer_run_instance(instance_id)
            return

        try:
            run_instance(instance_id)
        finally:
            release_workflow_inflight()
    finally:
        if db is not None:
            close_db_session(db)


def _worker_loop(worker_id: int = 0) -> None:
    """事件消费主循环。"""
    while True:
        event = _event_queue.get()
        try:
            _process_event(event)
        except Exception:  # noqa: BLE001
            logger.exception("工作流触发处理异常(worker=%s): %s", worker_id, event)


_worker_started = False
_worker_lock = threading.Lock()


def start_trigger_worker() -> None:
    """启动触发 worker 后台线程（幂等，main lifespan 调用）。"""
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
        n = max(1, int(getattr(settings, "WORKFLOW_TRIGGER_CONCURRENCY", 2) or 2))
        for i in range(n):
            threading.Thread(
                target=_worker_loop,
                args=(i,),
                name=f"ban-workflow-trigger-{i}",
                daemon=True,
            ).start()
        logger.info("封禁工作流触发 worker 已启动: concurrency=%s", n)
