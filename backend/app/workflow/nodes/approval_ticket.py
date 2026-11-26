"""审批工单节点：创建审批工单并暂停实例（waiting_approval）。

工单内容含告警摘要、研判结论、封禁方案、资产信息、决策依据；
同时写一条 pending_approval 封禁记录（工作台"待审批"状态）。
超时时间 24 小时，超时由定时任务自动驳回。
"""
import json
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.core.ip_region import resolve_ban_region
from app.core.timezone import beijing_now
from app.models.alert_event import AlertEvent
from app.models.workflow_ban import ApprovalTicket, BanRecord, WorkflowInstance
from app.workflow.audit import write_audit
from .base import BaseNode, NodeResult

# 审批超时（小时）
APPROVAL_TIMEOUT_HOURS = 24


def _asset_info(alert: Any) -> dict:
    """从告警提取资产信息摘要。"""
    def _load(raw: Any) -> Any:
        if isinstance(raw, str) and raw:
            try:
                return json.loads(raw)
            except (ValueError, TypeError):
                return raw
        return raw

    return {
        "host_ip": _load(alert.host_ip) if alert else None,
        "asset_id": alert.asset_id if alert else None,
        "relate_asset_type": alert.relate_asset_type_name if alert else None,
        "user_name": alert.user_name if alert else None,
        "account_name": alert.account_name if alert else None,
    }


class ApprovalTicketNode(BaseNode):
    key = "approval_ticket"
    name = "审批工单"

    def execute(self, db: Session, instance: WorkflowInstance, ctx: dict[str, Any]) -> NodeResult:
        ip = str(ctx.get("ip") or "")
        decision = ctx.get("agent_decision") or {}
        ban_plan = decision.get("ban_plan") or {}
        alert = db.query(AlertEvent).filter(AlertEvent.id == instance.alert_id).first()

        summary = {
            "alert_name": ctx.get("alert_name") or "",
            "risk_level": ctx.get("risk_level") or "",
            "threat_class": ctx.get("alert_type") or "",
            "src_country": ctx.get("src_country") or "",
            "occur_timestamp": ctx.get("occur_timestamp") or "",
            "alert_uuid": ctx.get("alert_uuid") or "",
        }

        ticket = ApprovalTicket(
            workflow_instance_id=instance.id,
            ip=ip,
            alert_summary=json.dumps(summary, ensure_ascii=False),
            agent_decision=json.dumps(decision, ensure_ascii=False),
            ban_plan=json.dumps(ban_plan, ensure_ascii=False),
            asset_info=json.dumps(_asset_info(alert), ensure_ascii=False),
            status="pending",
            deadline=beijing_now() + timedelta(hours=APPROVAL_TIMEOUT_HOURS),
        )
        db.add(ticket)

        # 工作台待审批记录
        record = BanRecord(
            ip=ip,
            ban_level=str(ban_plan.get("ban_level") or "medium"),
            ban_duration=int(ban_plan.get("ban_duration") or 3600),
            is_permanent=bool(ban_plan.get("is_permanent")),
            reason=str(ban_plan.get("reason") or ""),
            region=str(ban_plan.get("region") or "") or resolve_ban_region(db, ip),
            source_instance_id=instance.id,
            ban_source="approval",
            status="pending_approval",
        )
        db.add(record)
        db.commit()

        ctx["approval_ticket_id"] = ticket.id
        ctx["ban_record_id"] = record.id
        write_audit(
            db, action="workflow_node", resource_type="approval_ticket", resource_id=ticket.id,
            detail={"node": self.key, "ip": ip, "instance_id": instance.id, "result": "ticket_created"},
        )
        # action=pause：实例暂停等待审批，审批回调后从 approval_result 节点恢复
        return NodeResult(
            output={"ticket_id": ticket.id, "ip": ip, "deadline": str(ticket.deadline), "ban_record_id": record.id},
            action="pause",
        )
