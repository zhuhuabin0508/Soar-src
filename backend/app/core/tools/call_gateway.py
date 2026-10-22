"""进程内工具调用网关。执行前重读契约等级，不信任对话传入的风险标记。"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

_TIERS = {
    "low": "L0",
    "medium": "L1",
    "high": "L2",
    "critical": "L3",
}


def tier_of(danger_level: str | None) -> str:
    return _TIERS.get((danger_level or "low").lower(), "L0")


@dataclass
class GatewayDecision:
    allow: bool
    reason: str
    tier: str


def authorize_tool_call(
    db,
    *,
    tool_name: str,
    arguments: dict | None,
    danger_level: str,
    required_permission: tuple[str, str] | tuple[tuple[str, str], ...] | None,
    user,
    approved_ticket_id: Optional[int] = None,
    self_gating: bool = False,
) -> GatewayDecision:
    tier = tier_of(danger_level)
    entry = "workflow" if user is None else "agent"
    if entry == "workflow":
        _audit(db, user, tool_name, entry, tier, True, "工作流入口放行")
        return GatewayDecision(True, "工作流入口放行", tier)
    if tier == "L3":
        reason = "对话入口不允许执行最高危工具"
        _audit(db, user, tool_name, entry, tier, False, reason)
        return GatewayDecision(False, reason, tier)
    from app.core.tools.authz import required_permission_set, user_may_call

    if not user_may_call(user, db, required_permission):
        needs = required_permission_set(required_permission)
        need_text = "、".join(f"{m}:{a}" for m, a in needs) or "-"
        reason = f"当前角色无权调用 {tool_name}，需要 {need_text}"
        _audit(db, user, tool_name, entry, tier, False, reason)
        return GatewayDecision(False, reason, tier)
    if tier in ("L0", "L1") or self_gating:
        if approved_ticket_id is not None:
            ok, reason = _consume_credential(
                db,
                tool_name=tool_name,
                arguments=arguments or {},
                user=user,
                approved_ticket_id=approved_ticket_id,
            )
            if not ok:
                _audit(db, user, tool_name, entry, tier, False, reason)
                return GatewayDecision(False, reason, tier)
        _audit(db, user, tool_name, entry, tier, True, "放行")
        return GatewayDecision(True, "放行", tier)
    ok, reason = _consume_credential(
        db,
        tool_name=tool_name,
        arguments=arguments or {},
        user=user,
        approved_ticket_id=approved_ticket_id,
    )
    _audit(db, user, tool_name, entry, tier, ok, reason)
    return GatewayDecision(ok, reason, tier)


def _consume_credential(
    db,
    *,
    tool_name: str,
    arguments: dict,
    user,
    approved_ticket_id: Optional[int],
) -> tuple[bool, str]:
    if approved_ticket_id is None:
        return False, "缺少一次性凭证"
    from app.core.timezone import beijing_now
    from app.models.workflow_ban import ApprovalTicket
    from app.platform.approval import KIND_AGENT_TOOL, make_dedup_key

    ticket = (
        db.query(ApprovalTicket)
        .filter(ApprovalTicket.id == approved_ticket_id)
        .with_for_update()
        .first()
    )
    if ticket is None or (ticket.kind or "") != KIND_AGENT_TOOL:
        return False, "一次性凭证无效"
    if ticket.status != "approved" or (ticket.tool_name or "") != tool_name:
        return False, "一次性凭证无效"
    if ticket.deadline is None or ticket.deadline < beijing_now():
        return False, "一次性凭证已过期"
    user_id = getattr(user, "id", None)
    if user_id is None or ticket.requested_by is None or int(ticket.requested_by) != int(user_id):
        return False, "一次性凭证与当前用户不一致"
    expected = make_dedup_key(
        tool_name=tool_name,
        arguments=arguments,
        agent_id=ticket.agent_id,
        session_id=ticket.session_id,
    )
    if (ticket.dedup_key or "") != expected:
        return False, "一次性凭证与参数不一致"
    try:
        stored = json.loads(ticket.tool_arguments or "{}")
    except Exception:  # noqa: BLE001
        stored = None
    if not isinstance(stored, dict):
        return False, "一次性凭证与参数不一致"
    if json.dumps(stored, sort_keys=True, ensure_ascii=False) != json.dumps(
        arguments or {}, sort_keys=True, ensure_ascii=False
    ):
        return False, "一次性凭证与参数不一致"
    try:
        prev = json.loads(ticket.result) if isinstance(ticket.result, str) else (ticket.result or {})
    except Exception:  # noqa: BLE001
        prev = {}
    if not (isinstance(prev, dict) and prev.get("status") == "executing"):
        return False, "一次性凭证已使用"
    ticket.result = json.dumps({"status": "consumed"}, ensure_ascii=False)
    db.flush()
    return True, "凭证有效"


def _audit(db, user, tool_name: str, entry: str, tier: str, allow: bool, reason: str) -> None:
    from app.workflow.audit import write_audit

    try:
        write_audit(
            db,
            action="tool_call_gateway",
            resource_type="tool",
            resource_id=tool_name,
            detail={
                "tool_name": tool_name,
                "entry": entry,
                "tier": tier,
                "allow": allow,
                "reason": reason,
            },
            operator=getattr(user, "username", None) or "system",
            result="success" if allow else "denied",
            user_id=getattr(user, "id", None) if user is not None else None,
            commit=False,
        )
    except Exception:  # noqa: BLE001
        logger.warning("工具调用网关审计失败: tool=%s", tool_name)
