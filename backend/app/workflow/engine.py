"""工作流引擎：节点调度与状态机。

职责：
- 按默认节点图顺序执行，路由节点可指定下一跳
- 每个节点独立记录 workflow_node_logs（状态/输入/输出/耗时）+ 审计日志
- 单节点失败不中断整体实例：转异常处理节点
- 审批节点暂停（waiting_approval），审批回调后从 approval_result 恢复
- 恢复执行时从节点日志重建上下文（无需额外持久化）
"""
import json
import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.database import LinkageSessionLocal, close_db_session, linkage_db
from app.models.workflow_ban import (
    ApprovalTicket, BanRecord, WorkflowInstance, WorkflowNodeLog,
)
from app.workflow.audit import write_audit
from app.workflow.nodes import NODE_REGISTRY
from app.workflow.nodes.base import BaseNode

logger = logging.getLogger(__name__)

# 默认节点流（路由节点可用 NodeResult.next_key 覆盖下一跳）
NODE_FLOW: dict[str, Optional[str]] = {
    "event_trigger": "param_validate",
    "param_validate": "agent_analyze",
    "agent_analyze": "banned_check",
    "banned_check": "action_branch",
    "already_banned": "result_sync",
    "action_branch": "monitor_log",
    "direct_ban": "result_sync",
    "approval_ticket": "approval_result",  # 暂停后恢复的衔接
    "approval_result": "monitor_log",
    "execute_ban": "result_sync",
    "monitor_log": "result_sync",
    "result_sync": None,
    "error_handler": None,
}

# 防环保护
_MAX_STEPS = 30


def _node_order(db: Session, instance_id: int) -> int:
    """下一个节点序号（同实例日志计数）。"""
    count = db.query(WorkflowNodeLog).filter(WorkflowNodeLog.instance_id == instance_id).count()
    return count + 1


def _run_node(instance_id: int, ctx: dict[str, Any], key: str) -> Any:
    """执行单个节点：准备日志 → 执行（可释放连接）→ 落库结果。"""
    from app.workflow.nodes.base import NodeResult

    node: BaseNode = NODE_REGISTRY[key]
    log_id: int

    with linkage_db() as db:
        instance = (
            db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
        )
        if instance is None:
            raise RuntimeError(f"工作流实例不存在: {instance_id}")
        log = WorkflowNodeLog(
            instance_id=instance.id,
            node_name=node.name,
            node_key=key,
            node_order=_node_order(db, instance.id),
            status="running",
            start_time=beijing_now(),
        )
        db.add(log)
        db.flush()
        log_id = log.id
        instance.current_node = key

    db = LinkageSessionLocal()
    try:
        instance = (
            db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
        )
        if instance is None:
            raise RuntimeError(f"工作流实例不存在: {instance_id}")
        try:
            result = node.execute(db, instance, ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception("节点执行异常: instance=%s node=%s", instance_id, key)
            result = NodeResult(status="fail", action="error", error=f"节点执行异常: {exc}")
    finally:
        close_db_session(db)

    with linkage_db() as db:
        instance = (
            db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
        )
        log = db.query(WorkflowNodeLog).filter(WorkflowNodeLog.id == log_id).first()
        if log is not None:
            log.status = result.status
            log.end_time = beijing_now()
            log.output = node.jdump(result.output) if result.output else None
            log.error_msg = result.error or None
        if instance is not None:
            write_audit(
                db,
                action="workflow_node",
                resource_type="workflow_instance",
                resource_id=instance.id,
                detail={
                    "node": key,
                    "node_name": node.name,
                    "status": result.status,
                    "error": result.error or None,
                },
                result="success" if result.status != "fail" else "failed",
            )
    return result


def rebuild_context(db: Session, instance: WorkflowInstance) -> dict[str, Any]:
    """从节点日志重建实例上下文（审批恢复/重启后继续执行用）。"""
    ctx: dict[str, Any] = {}
    logs = (
        db.query(WorkflowNodeLog)
        .filter(WorkflowNodeLog.instance_id == instance.id)
        .order_by(WorkflowNodeLog.id.asc())
        .all()
    )
    for log in logs:
        if not log.output:
            continue
        try:
            output = json.loads(log.output)
        except (ValueError, TypeError):
            continue
        if log.node_key == "event_trigger" and isinstance(output.get("variables"), dict):
            ctx.update(output["variables"])
        elif log.node_key == "agent_analyze" and isinstance(output.get("decision"), dict):
            ctx["agent_decision"] = output["decision"]
        elif log.node_key == "approval_ticket":
            ctx["approval_ticket_id"] = output.get("ticket_id")
            ctx["ban_record_id"] = output.get("ban_record_id")
    return ctx


def run_instance(
    instance_id: int,
    *,
    start_key: str = "event_trigger",
    ctx: Optional[dict[str, Any]] = None,
) -> None:
    """运行（或恢复运行）一个工作流实例（按节点使用短会话）。

    Args:
        instance_id: 实例 ID。
        start_key: 起始节点（新实例 event_trigger；审批恢复 approval_result）。
        ctx: 共享上下文（None 时从节点日志重建）。
    """
    if ctx is None:
        with linkage_db() as db:
            instance = (
                db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
            )
            if instance is None:
                logger.error("run_instance: 实例不存在 id=%s", instance_id)
                return
            ctx = rebuild_context(db, instance)

    with linkage_db() as db:
        instance = (
            db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
        )
        if instance is None:
            return
        instance.status = "running"

    key: Optional[str] = start_key
    steps = 0
    while key is not None and steps < _MAX_STEPS:
        steps += 1
        result = _run_node(instance_id, ctx, key)

        if result.action == "pause":
            with linkage_db() as db:
                instance = (
                    db.query(WorkflowInstance)
                    .filter(WorkflowInstance.id == instance_id)
                    .first()
                )
                if instance is not None:
                    instance.status = "waiting_approval"
                    instance.current_node = "approval_result"
                    logger.info("实例 #%s 暂停等待审批: ip=%s", instance.id, instance.src_ip)
            return

        if result.action == "abort":
            with linkage_db() as db:
                instance = (
                    db.query(WorkflowInstance)
                    .filter(WorkflowInstance.id == instance_id)
                    .first()
                )
                if instance is None:
                    return
                if result.status == "skipped":
                    instance.status = "skipped"
                    instance.final_result = "skipped"
                    instance.error_msg = result.error[:2000] if result.error else None
                else:
                    instance.status = "escalated"
                    instance.final_result = ctx.get("final_result") or "escalated"
                instance.finished_at = beijing_now()
                logger.info("实例 #%s 终止: status=%s", instance.id, instance.status)
            return

        if result.action == "error":
            ctx["last_error"] = result.error or "未知错误"
            key = "error_handler"
            continue

        key = result.next_key or NODE_FLOW.get(key)

    if steps >= _MAX_STEPS:
        logger.error("实例 #%s 超过最大节点步数，强制结束", instance_id)
        with linkage_db() as db:
            instance = (
                db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
            )
            if instance is not None:
                instance.status = "error"
                instance.error_msg = "超过最大节点执行步数（疑似环路）"
                instance.finished_at = beijing_now()


def cancel_instance(db: Session, instance: WorkflowInstance, operator: str, reason: str) -> bool:
    """手动取消实例。已下发封禁（终态 success 且 final_result=banned）不可取消。"""
    if instance.status == "success" and instance.final_result == "banned":
        return False
    instance.status = "cancelled"
    instance.final_result = "cancelled"
    instance.error_msg = f"手动取消: {reason}"[:2000]
    instance.finished_at = beijing_now()
    # 取消关联待审批工单与待审批封禁记录
    ticket = (
        db.query(ApprovalTicket)
        .filter(ApprovalTicket.workflow_instance_id == instance.id, ApprovalTicket.status == "pending")
        .first()
    )
    if ticket is not None:
        ticket.status = "rejected"
        ticket.approver = operator
        ticket.approval_comment = f"实例手动取消: {reason}"
        ticket.approved_at = beijing_now()
    record = db.query(BanRecord).filter(
        BanRecord.source_instance_id == instance.id, BanRecord.status == "pending_approval",
    ).first()
    if record is not None:
        record.status = "cancelled"
    db.commit()
    write_audit(
        db, action="workflow_cancel", resource_type="workflow_instance", resource_id=instance.id,
        detail={"ip": instance.src_ip, "reason": reason}, operator=operator,
    )
    return True
