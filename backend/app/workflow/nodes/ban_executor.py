"""直接封禁 / 执行封禁节点：调用封禁工具 record_ban 并写封禁记录。

失败重试 3 次（ban_client 内实现），仍失败转异常处理节点。
"""
from typing import Any

from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from datetime import timedelta

from app.models.banned_ip import BannedIP
from app.models.workflow_ban import BanRecord, WorkflowInstance
from app.database import close_db_session
from app.workflow import ban_client
from app.workflow.audit import write_audit
from .base import BaseNode, NodeResult


def execute_ban(db: Session, instance: WorkflowInstance, ctx: dict[str, Any], node_key: str, ban_source: str = "auto") -> NodeResult:
    """封禁执行公共逻辑（直接封禁与审批后执行封禁复用）。"""
    ip = str(ctx.get("ip") or "")
    decision = ctx.get("agent_decision") or {}
    ban_plan = decision.get("ban_plan") or {}

    instance_id = instance.id
    db.commit()
    close_db_session(db)

    try:
        record_id = ban_client.record_ban(ip, ban_plan)
    except ban_client.BanCallError as exc:
        return NodeResult(status="fail", action="error", output={"ip": ip, "ban_plan": ban_plan}, error=str(exc))

    from app.database import LinkageSessionLocal

    db = LinkageSessionLocal()
    try:
        instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
        if instance is None:
            return NodeResult(
                status="fail", action="error",
                output={"ip": ip, "record_id": record_id},
                error=f"封禁 API 已成功(record_id={record_id})但实例 #{instance_id} 不存在，请人工核对平台记录",
            )
        return _persist_ban_after_api(
            db, instance, ctx, node_key, ban_source, ip, ban_plan, record_id,
        )
    finally:
        close_db_session(db)


def _persist_ban_after_api(
    db: Session,
    instance: WorkflowInstance,
    ctx: dict[str, Any],
    node_key: str,
    ban_source: str,
    ip: str,
    ban_plan: dict,
    record_id: str,
) -> NodeResult:
    is_permanent = bool(ban_plan.get("is_permanent"))
    duration = int(ban_plan.get("ban_duration") or 3600)
    now = beijing_now()
    expire_time = None if is_permanent else now + timedelta(seconds=duration)

    # 写封禁记录（工作台数据源）：审批路径更新 pending_approval 记录为 active
    record = db.query(BanRecord).filter(
        BanRecord.source_instance_id == instance.id, BanRecord.ip == ip,
    ).first()
    if record is None:
        record = BanRecord(ip=ip, source_instance_id=instance.id)
        db.add(record)
    record.ban_level = str(ban_plan.get("ban_level") or "medium")
    record.ban_duration = duration
    record.is_permanent = is_permanent
    record.expire_time = expire_time
    record.reason = str(ban_plan.get("reason") or "")
    record.region = str(ban_plan.get("region") or "")
    record.record_id = record_id
    record.ban_source = ban_source
    record.status = "active"
    db.commit()

    # 同步 legacy 已封禁 IP 表（既有封禁工作台立即可见）
    legacy = db.query(BannedIP).filter(BannedIP.ip == ip).first()
    if legacy is None:
        legacy = BannedIP(ip=ip)
        db.add(legacy)
    legacy.ban_level = str(ban_plan.get("ban_level") or "medium")
    legacy.ban_duration = duration
    legacy.expired_at = expire_time or (now + timedelta(days=36500))
    legacy.region = str(ban_plan.get("region") or "")
    legacy.reason = str(ban_plan.get("reason") or "")
    legacy.status = "active"
    legacy.source = "agent"
    db.commit()

    write_audit(
        db, action="ban", resource_type="ban_record", resource_id=record.id,
        detail={"ip": ip, "ban_plan": ban_plan, "record_id": record_id, "instance_id": instance.id, "node": node_key},
    )
    ctx["ban_record_id"] = record.id
    return NodeResult(
        output={"ip": ip, "record_id": record_id, "ban_plan": ban_plan, "ban_record_id": record.id},
    )


class DirectBanNode(BaseNode):
    key = "direct_ban"
    name = "直接封禁"

    def execute(self, db: Session, instance: WorkflowInstance, ctx: dict[str, Any]) -> NodeResult:
        ctx["final_result"] = "banned"
        return execute_ban(db, instance, ctx, self.key)


class ExecuteBanNode(BaseNode):
    key = "execute_ban"
    name = "执行封禁"

    def execute(self, db: Session, instance: WorkflowInstance, ctx: dict[str, Any]) -> NodeResult:
        ctx["final_result"] = "banned"
        return execute_ban(db, instance, ctx, self.key, ban_source="approval")
