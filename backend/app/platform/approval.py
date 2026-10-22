"""Agent 高危工具的对话内确认。

对话弹出确认 → 当前用户确认/拒绝 → 当场执行或取消。
ApprovalTicket(kind=agent_tool) 仅作审计与防重放，不进入工作台审批中心。
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

DEDUP_WINDOW_MINUTES = 30
CREDENTIAL_TTL_MINUTES = 15

KIND_AGENT_TOOL = "agent_tool"


def make_dedup_key(*, tool_name: str, arguments: dict | None,
                   agent_id: Optional[int], session_id: Optional[str]) -> str:
    """去重键 = hash(工具名 + 参数 + agent_id + session_id)。"""
    raw = "|".join([
        tool_name or "",
        json.dumps(arguments or {}, sort_keys=True, ensure_ascii=False),
        str(agent_id or 0),
        session_id or "",
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:64]


def create_tool_approval(
    db: Session,
    *,
    tool_name: str,
    arguments: dict | None,
    danger_level: str,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
    session_id: Optional[str] = None,
    window_minutes: int = DEDUP_WINDOW_MINUTES,
):
    """为一次 Agent 高危工具调用创建（或复用）审批工单。返回 ApprovalTicket。"""
    from app.models.workflow_ban import ApprovalTicket

    key = make_dedup_key(tool_name=tool_name, arguments=arguments,
                         agent_id=agent_id, session_id=session_id)

    cutoff = beijing_now() - timedelta(minutes=window_minutes)
    existing = (
        db.query(ApprovalTicket)
        .filter(
            ApprovalTicket.kind == KIND_AGENT_TOOL,
            ApprovalTicket.dedup_key == key,
            ApprovalTicket.status == "pending",
            ApprovalTicket.created_at >= cutoff,
        )
        .order_by(ApprovalTicket.id.desc())
        .first()
    )
    if existing is not None:
        existing.deadline = beijing_now() + timedelta(minutes=CREDENTIAL_TTL_MINUTES)
        db.commit()
        return existing

    ticket = ApprovalTicket(
        kind=KIND_AGENT_TOOL,
        workflow_instance_id=0,      # 哨兵：非工作流工单
        ip="",                       # 哨兵：非按 IP 封禁
        status="pending",
        tool_name=tool_name,
        tool_arguments=json.dumps(arguments or {}, ensure_ascii=False),
        agent_id=agent_id,
        session_id=session_id,
        requested_by=user_id,
        dedup_key=key,
        alert_summary=f"Agent 高危工具确认：{tool_name}（danger={danger_level}）",
        deadline=beijing_now() + timedelta(minutes=CREDENTIAL_TTL_MINUTES),
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    return ticket


def _load_agent_tool_ticket(db: Session, ticket_id: int, *, agent_id: int, for_update: bool = False):
    from app.models.workflow_ban import ApprovalTicket

    q = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id)
    if for_update:
        q = q.with_for_update()
    ticket = q.first()
    if ticket is None:
        raise ValueError("确认工单不存在")
    if (ticket.kind or "") != KIND_AGENT_TOOL:
        raise ValueError("非 Agent 工具确认工单")
    if ticket.agent_id is not None and int(ticket.agent_id) != int(agent_id):
        raise ValueError("工单与当前智能体不匹配")
    return ticket


def _claim_pending_ticket(db: Session, ticket, *, user, decision: str, comment: str):
    if ticket.status != "pending":
        raise ValueError(f"工单已处理（{ticket.status}），不可重复操作")
    if decision == "approved" and ticket.result is not None:
        raise ValueError("工单已执行过，不可重复确认")
    ticket.status = decision
    ticket.approver = getattr(user, "username", None) or str(getattr(user, "id", ""))
    ticket.approval_comment = comment
    ticket.approved_at = beijing_now()
    if decision == "approved":
        ticket.result = json.dumps({"status": "executing"}, ensure_ascii=False)
    db.flush()


async def _execute_claimed_tool(db: Session, ticket, *, agent_id: int, user, args: dict) -> dict[str, Any]:
    if (ticket.tool_name or "") == "trigger_workflow_skill":
        from app.models.agent import Agent
        from app.agent.hermes.skill_engine import WorkflowSkillBridge
        from app.agent.workflow_as_tool import (
            workflow_danger, workflow_permissions, workflow_self_gates,
        )
        from app.core.tools.call_gateway import authorize_tool_call
        from app.models.workflow import Workflow

        _danger = "high"
        _self_gating = False
        _wf = None
        try:
            _wf_id = int(args.get("workflow_id"))
        except (TypeError, ValueError):
            _wf_id = None
        if _wf_id is not None:
            _wf = db.query(Workflow).filter(Workflow.id == _wf_id).first()
        if _wf is not None and getattr(_wf, "graph_config", None) is not None:
            _danger = workflow_danger(_wf.graph_config)
            _self_gating = workflow_self_gates(_wf.graph_config)
        # 权限按图推导（与 registry_builder 口径一致）：基线 + 图内节点权限并集，
        # 防 trigger_workflow_skill 侧写绕过模块权限
        _required = (("workflow_list", "execute"),)
        if _wf is not None and getattr(_wf, "graph_config", None) is not None:
            _required = _required + workflow_permissions(_wf.graph_config)
        _decision = authorize_tool_call(
            db,
            tool_name=ticket.tool_name,
            arguments=args,
            danger_level=_danger,
            required_permission=_required,
            user=user,
            approved_ticket_id=ticket.id,
            self_gating=_self_gating,
        )
        if not _decision.allow:
            return {"ok": False, "error": _decision.reason, "content": None, "raw_content": None}

        agent = db.query(Agent).filter(Agent.id == (ticket.agent_id or agent_id)).first()
        if agent is None:
            return {"ok": False, "error": "Agent 不存在", "content": None, "raw_content": None}
        bridge = WorkflowSkillBridge(db, agent, user)
        resume_token = args.get("resume_token")
        try:
            if resume_token:
                ctx = await bridge.resume_skill(resume_token, "approve")
            else:
                wf_id = int(args.get("workflow_id"))
                payload = args.get("input", {})
                ctx = await bridge.trigger_skill(
                    workflow_id=wf_id,
                    payload=payload if isinstance(payload, dict) else {},
                )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "content": None, "raw_content": None}
        content = {
            "status": ctx.status,
            "skill_run_id": getattr(ctx, "skill_run_id", None),
            "execution_id": getattr(ctx, "execution_id", None),
            "node_outputs": getattr(ctx, "node_outputs", None),
            "pending_approval": getattr(ctx, "pending_approval", None),
        }
        return {
            "ok": ctx.status in ("completed", "interrupted"),
            "error": "" if ctx.status in ("completed", "interrupted") else f"技能状态: {ctx.status}",
            "content": content,
            "raw_content": content,
        }

    from app.platform.tool_runtime import invoke_tool

    inv = await invoke_tool(
        ticket.tool_name,
        args,
        db=db,
        agent_id=ticket.agent_id or agent_id,
        user=user,
        verify=False,
        approved_ticket_id=ticket.id,
    )
    return {
        "ok": inv.ok,
        "error": inv.error,
        "content": inv.content,
        "raw_content": inv.raw_content,
    }


async def confirm_and_execute_tool(
    db: Session,
    *,
    ticket_id: int,
    agent_id: int,
    user,
) -> dict[str, Any]:
    """对话内确认：当前用户批准后当场执行工具（一次性凭据）。"""
    from app.workflow.audit import write_audit

    ticket = _load_agent_tool_ticket(db, ticket_id, agent_id=agent_id, for_update=True)
    _claim_pending_ticket(
        db, ticket, user=user, decision="approved", comment="对话内确认",
    )
    db.commit()

    try:
        args = json.loads(ticket.tool_arguments or "{}")
    except Exception:  # noqa: BLE001
        args = {}

    payload = await _execute_claimed_tool(
        db, ticket, agent_id=agent_id, user=user, args=args,
    )
    try:
        ticket.result = json.dumps(payload, ensure_ascii=False, default=str)[:8000]
    except Exception:  # noqa: BLE001
        ticket.result = json.dumps({"ok": payload.get("ok"), "error": payload.get("error")})[:8000]
    ticket.result_delivered = False
    db.commit()

    try:
        write_audit(
            db,
            action="tool_confirm",
            resource_type="approval_ticket",
            resource_id=ticket.id,
            detail={
                "result": "approved",
                "tool_name": ticket.tool_name,
                "agent_id": agent_id,
                "ok": payload.get("ok"),
            },
            operator=ticket.approver,
            user_id=getattr(user, "id", None),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("写工具确认审计失败: %s", exc)

    return {
        "ok": bool(payload.get("ok")),
        "ticket_id": ticket.id,
        "tool_name": ticket.tool_name,
        "approver": ticket.approver,
        "decision": "approved",
        "result": payload,
    }


def reject_tool_confirmation(
    db: Session,
    *,
    ticket_id: int,
    agent_id: int,
    user,
    comment: str = "",
) -> dict[str, Any]:
    """对话内拒绝：记录当前用户，不执行工具。"""
    from app.workflow.audit import write_audit

    ticket = _load_agent_tool_ticket(db, ticket_id, agent_id=agent_id, for_update=True)
    _claim_pending_ticket(
        db, ticket, user=user, decision="rejected",
        comment=comment or "对话内拒绝",
    )
    payload = {
        "ok": False,
        "status": "rejected",
        "comment": ticket.approval_comment,
        "approver": ticket.approver,
    }
    ticket.result = json.dumps(payload, ensure_ascii=False)
    ticket.result_delivered = False
    db.commit()

    try:
        write_audit(
            db,
            action="tool_reject",
            resource_type="approval_ticket",
            resource_id=ticket.id,
            detail={
                "result": "rejected",
                "tool_name": ticket.tool_name,
                "agent_id": agent_id,
                "comment": ticket.approval_comment,
            },
            operator=ticket.approver,
            user_id=getattr(user, "id", None),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("写工具拒绝审计失败: %s", exc)

    return {
        "ok": True,
        "ticket_id": ticket.id,
        "tool_name": ticket.tool_name,
        "approver": ticket.approver,
        "decision": "rejected",
        "result": payload,
    }
