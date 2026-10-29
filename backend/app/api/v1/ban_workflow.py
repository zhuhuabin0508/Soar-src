"""封禁工作流实例与触发规则管理 API。

- ``GET/POST /ban-workflow/instances*``：实例列表/详情（含全部节点日志、智能体调用、
  审批与封禁记录）/取消
- ``GET/POST/PUT/DELETE /ban-workflow/rules``：触发规则 CRUD（修改实时生效）
- ``GET /ban-workflow/approvals`` + ``POST .../approve|reject|escalate``：封禁审批中心
- ``GET /ban-workflow/banned-ips`` + ``POST .../{id}/unban``：封禁工作台（已封禁 IP 模块）
- ``GET /ban-workflow/circuit-breaker`` / ``POST .../reset``：熔断状态查询与人工恢复
- ``GET /ban-workflow/stats``：监控页工作流统计卡片数据
"""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.timezone import BEIJING_TZ, beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_permission, require_role
from app.models.alert_event import AlertEvent
from app.models.banned_ip import BannedIP
from app.models.ticket import Ticket
from app.models.user import User
from app.models.workflow_ban import (
    AgentInvocationLog, ApprovalTicket, BanRecord, MonitorLog,
    WorkflowInstance, WorkflowNodeLog, WorkflowTriggerRule,
)
from app.workflow import trigger as trigger_mod
from app.workflow.audit import write_audit
from app.workflow.engine import cancel_instance, run_instance
from app.workflow.nodes import NODE_LABELS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ban-workflow", tags=["ban-workflow"])

_INSTANCE_STATUS_LABELS = {
    "running": "运行中", "waiting_approval": "等待审批", "success": "已完成",
    "error": "异常", "skipped": "已跳过", "cancelled": "已取消", "escalated": "已升级",
}
_FINAL_RESULT_LABELS = {
    "banned": "已封禁", "already_banned": "已封禁(重复)", "waiting_approval": "待审批",
    "monitoring": "持续监控", "cancelled": "已取消", "error": "异常", "skipped": "已跳过",
    "escalated": "已升级",
}
_BAN_SOURCE_LABELS = {
    "auto": "自动封禁", "approval": "审批封禁", "manual": "手动封禁", "chat": "聊天封禁", "ticket": "工单同步",
}
# 工单智能体研判建议动作中文（工单同步封禁详情的研判结论展示用）
_TICKET_AGENT_ACTION_LABELS = {"ban": "建议封禁", "monitor": "观察监控", "ignore": "忽略（暂不处置）"}


def _jload(raw, default=None):
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return default if default is not None else raw


def _parse_dt(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except ValueError:
        return None


# ======================================================================
# 实例管理
# ======================================================================
@router.get("/instances", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_instances(
    status: str = Query("", description="running/waiting_approval/success/error/skipped/cancelled/escalated"),
    ip: str = Query("", description="源 IP 精确匹配"),
    rule_id: int = Query(0, description="触发规则 ID"),
    start_time: str = Query(""),
    end_time: str = Query(""),
    keyword: str = Query("", description="IP/告警名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """实例列表（分页 + 状态/IP/时间范围/触发规则筛选，全部后端执行）。"""
    query = db.query(WorkflowInstance)
    if status:
        query = query.filter(WorkflowInstance.status == status)
    if ip:
        query = query.filter(WorkflowInstance.src_ip == ip)
    if rule_id:
        query = query.filter(WorkflowInstance.trigger_rule_id == rule_id)
    st, et = _parse_dt(start_time), _parse_dt(end_time)
    if st:
        query = query.filter(WorkflowInstance.created_at >= st)
    if et:
        query = query.filter(WorkflowInstance.created_at < et)
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(WorkflowInstance.src_ip.ilike(like), WorkflowInstance.alert_uuid.ilike(like)))

    total = query.count()
    rows = (
        query.order_by(WorkflowInstance.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    # 触发规则名映射
    rule_names = {r.id: r.rule_name for r in db.query(WorkflowTriggerRule.id, WorkflowTriggerRule.rule_name).all()}
    # 触发告警名称映射
    alert_ids = [r.alert_id for r in rows if r.alert_id]
    alert_names = {}
    if alert_ids:
        for a in db.query(AlertEvent.id, AlertEvent.alert_name).filter(AlertEvent.id.in_(alert_ids)).all():
            alert_names[a.id] = a.alert_name or ""
    items = []
    for r in rows:
        duration_ms = None
        if r.finished_at and r.started_at:
            duration_ms = int((r.finished_at - r.started_at).total_seconds() * 1000)
        items.append({
            "id": r.id,
            "alert_id": r.alert_id,
            "alert_uuid": r.alert_uuid,
            "alert_name": alert_names.get(r.alert_id, ""),
            "src_ip": r.src_ip,
            "trigger_rule_id": r.trigger_rule_id,
            "trigger_rule_name": rule_names.get(r.trigger_rule_id, ""),
            "status": r.status,
            "status_label": _INSTANCE_STATUS_LABELS.get(r.status, r.status),
            "current_node": r.current_node,
            "current_node_label": NODE_LABELS.get(r.current_node, r.current_node),
            "final_result": r.final_result,
            "final_result_label": _FINAL_RESULT_LABELS.get(r.final_result or "", ""),
            "duration_ms": duration_ms,
            "error_msg": r.error_msg,
            "created_at": r.created_at,
            "finished_at": r.finished_at,
        })
    return {"total": total, "items": items, "page": page, "page_size": page_size}


@router.get("/instances/{instance_id}", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_instance(instance_id: int, db: Session = Depends(get_db)) -> dict:
    """实例详情：基础信息 + 全部节点日志时间线 + 智能体调用 + 审批 + 封禁/监控记录。"""
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="工作流实例不存在")

    nodes = (
        db.query(WorkflowNodeLog)
        .filter(WorkflowNodeLog.instance_id == instance_id)
        .order_by(WorkflowNodeLog.id.asc())
        .all()
    )
    node_logs = [{
        "id": n.id,
        "node_key": n.node_key,
        "node_name": n.node_name,
        "node_order": n.node_order,
        "status": n.status,
        "input": _jload(n.input),
        "output": _jload(n.output),
        "start_time": n.start_time,
        "end_time": n.end_time,
        "duration_ms": int((n.end_time - n.start_time).total_seconds() * 1000) if n.end_time and n.start_time else None,
        "error_msg": n.error_msg,
    } for n in nodes]

    agent_logs = (
        db.query(AgentInvocationLog)
        .filter(AgentInvocationLog.workflow_instance_id == instance_id)
        .order_by(AgentInvocationLog.id.asc())
        .all()
    )
    agent_invocations = [{
        "id": a.id,
        "node_key": a.node_key,
        "request_body": _jload(a.request_body),
        "response_body": _jload(a.response_body),
        "model_name": a.model_name,
        "input_tokens": a.input_tokens,
        "output_tokens": a.output_tokens,
        "duration_ms": a.duration_ms,
        "status": a.status,
        "error_msg": a.error_msg,
        "created_at": a.created_at,
    } for a in agent_logs]

    ticket = db.query(ApprovalTicket).filter(
        ApprovalTicket.workflow_instance_id == instance_id,
    ).order_by(ApprovalTicket.id.desc()).first()
    ban_record = db.query(BanRecord).filter(
        BanRecord.source_instance_id == instance_id,
    ).order_by(BanRecord.id.desc()).first()
    monitor = db.query(MonitorLog).filter(
        MonitorLog.instance_id == instance_id,
    ).order_by(MonitorLog.id.desc()).first()

    duration_ms = None
    if instance.finished_at and instance.started_at:
        duration_ms = int((instance.finished_at - instance.started_at).total_seconds() * 1000)
    alert_name = ""
    if instance.alert_id:
        alert_row = db.query(AlertEvent.alert_name).filter(AlertEvent.id == instance.alert_id).first()
        alert_name = (alert_row.alert_name if alert_row else "") or ""
    return {
        "id": instance.id,
        "alert_id": instance.alert_id,
        "alert_uuid": instance.alert_uuid,
        "alert_name": alert_name,
        "src_ip": instance.src_ip,
        "strategy_id": instance.strategy_id,
        "trigger_rule_id": instance.trigger_rule_id,
        "status": instance.status,
        "status_label": _INSTANCE_STATUS_LABELS.get(instance.status, instance.status),
        "current_node": instance.current_node,
        "current_node_label": NODE_LABELS.get(instance.current_node, instance.current_node),
        "final_result": instance.final_result,
        "final_result_label": _FINAL_RESULT_LABELS.get(instance.final_result or "", ""),
        "error_msg": instance.error_msg,
        "started_at": instance.started_at,
        "finished_at": instance.finished_at,
        "duration_ms": duration_ms,
        "created_at": instance.created_at,
        "node_logs": node_logs,
        "agent_invocations": agent_invocations,
        "approval_ticket": ({
            "id": ticket.id, "ip": ticket.ip, "status": ticket.status,
            "alert_summary": _jload(ticket.alert_summary),
            "agent_decision": _jload(ticket.agent_decision),
            "ban_plan": _jload(ticket.ban_plan),
            "asset_info": _jload(ticket.asset_info),
            "approver": ticket.approver, "approval_comment": ticket.approval_comment,
            "approved_at": ticket.approved_at, "deadline": ticket.deadline,
            "created_at": ticket.created_at,
        } if ticket else None),
        "ban_record": ({
            "id": ban_record.id, "ip": ban_record.ip, "ban_level": ban_record.ban_level,
            "ban_duration": ban_record.ban_duration, "is_permanent": ban_record.is_permanent,
            "expire_time": ban_record.expire_time, "reason": ban_record.reason,
            "record_id": ban_record.record_id, "status": ban_record.status,
            "created_at": ban_record.created_at,
        } if ban_record else None),
        "monitor_log": ({
            "id": monitor.id, "ip": monitor.ip, "risk_level": monitor.risk_level,
            "advice": monitor.advice, "reasons": _jload(monitor.reasons), "created_at": monitor.created_at,
        } if monitor else None),
    }


@router.post("/instances/{instance_id}/cancel", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def cancel_instance_api(
    instance_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """手动取消实例。运行中/等待审批可取消；已下发封禁不可取消（只能走解封）。"""
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="工作流实例不存在")
    if instance.status in ("success", "error", "skipped", "cancelled", "escalated"):
        raise HTTPException(status_code=400, detail="实例已结束，无需取消")
    if instance.status == "success" and instance.final_result == "banned":
        raise HTTPException(status_code=400, detail="已下发封禁的实例不可取消，请在封禁工作台解封")
    reason = str(body.get("reason") or "手动取消")
    ok = cancel_instance(db, instance, operator=user.username, reason=reason)
    write_audit(
        db, action="workflow_cancel", resource_type="workflow_instance", resource_id=instance_id,
        detail={"ip": instance.src_ip, "reason": reason},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return {"ok": ok, "status": "cancelled"}


# ======================================================================
# 触发规则管理（修改实时生效：worker 每次按需查库）
# ======================================================================
def _validate_conditions(conditions: dict) -> None:
    """校验条件结构。"""
    allowed = {"risk_levels", "min_severity", "directions", "src_ip_tags", "alert_name_keywords", "threat_classes"}
    unknown = set(conditions.keys()) - allowed
    if unknown:
        raise HTTPException(status_code=400, detail=f"不支持的条件字段: {', '.join(unknown)}")
    for key in ("risk_levels", "directions", "src_ip_tags", "alert_name_keywords", "threat_classes"):
        if key in conditions and not isinstance(conditions[key], list):
            raise HTTPException(status_code=400, detail=f"条件 {key} 必须为列表")
    if "min_severity" in conditions and conditions["min_severity"] is not None:
        try:
            int(conditions["min_severity"])
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="min_severity 必须为整数")


class RuleBody(BaseModel):
    rule_name: str = Field(..., min_length=1, max_length=128)
    status: str = Field("enabled", pattern="^(enabled|disabled)$")
    conditions: dict = Field(default_factory=dict)
    cooldown_minutes: int = Field(60, ge=1, le=14400)
    priority: int = Field(0, ge=0, le=1000)


@router.get("/rules", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_rules(db: Session = Depends(get_db)) -> list[dict]:
    """触发规则列表。"""
    rows = db.query(WorkflowTriggerRule).order_by(WorkflowTriggerRule.priority.desc()).all()
    return [{
        "id": r.id,
        "rule_name": r.rule_name,
        "status": r.status,
        "conditions": _jload(r.conditions, {}),
        "cooldown_minutes": r.cooldown_minutes,
        "priority": r.priority,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    } for r in rows]


@router.post("/rules", status_code=201, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def create_rule(body: RuleBody, db: Session = Depends(get_db)) -> dict:
    """创建触发规则（立即生效）。"""
    _validate_conditions(body.conditions)
    rule = WorkflowTriggerRule(
        rule_name=body.rule_name.strip(),
        status=body.status,
        conditions=json.dumps(body.conditions, ensure_ascii=False),
        cooldown_minutes=body.cooldown_minutes,
        priority=body.priority,
    )
    db.add(rule)
    db.commit()
    logger.info("触发规则创建: id=%s name=%s", rule.id, rule.rule_name)
    return {"id": rule.id, "rule_name": rule.rule_name}


@router.put("/rules/{rule_id}", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def update_rule(rule_id: int, body: RuleBody, db: Session = Depends(get_db)) -> dict:
    """更新触发规则（worker 按需查库，修改实时生效）。"""
    rule = db.query(WorkflowTriggerRule).filter(WorkflowTriggerRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="触发规则不存在")
    _validate_conditions(body.conditions)
    rule.rule_name = body.rule_name.strip()
    rule.status = body.status
    rule.conditions = json.dumps(body.conditions, ensure_ascii=False)
    rule.cooldown_minutes = body.cooldown_minutes
    rule.priority = body.priority
    db.commit()
    logger.info("触发规则更新: id=%s name=%s", rule.id, rule.rule_name)
    return {"ok": True}


@router.delete("/rules/{rule_id}", status_code=204, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def delete_rule(rule_id: int, db: Session = Depends(get_db)) -> None:
    """删除触发规则。"""
    rule = db.query(WorkflowTriggerRule).filter(WorkflowTriggerRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="触发规则不存在")
    db.delete(rule)
    db.commit()


# ======================================================================
# 熔断
# ======================================================================
@router.get("/circuit-breaker", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def circuit_breaker_state() -> dict:
    """熔断状态查询。"""
    return trigger_mod.get_circuit_state()


@router.post("/circuit-breaker/reset", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def circuit_breaker_reset(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """人工恢复熔断。"""
    state = trigger_mod.reset_circuit_breaker(operator=user.username)
    write_audit(
        db, action="circuit_breaker_reset", resource_type="ban_workflow", resource_id="circuit",
        detail={"result": state}, operator=user.username,
        ip_address=request.client.host if request.client else "", user_id=user.id,
    )
    return state


# ======================================================================
# 审批中心（封禁审批工单）
# ======================================================================
_TICKET_STATUS_LABELS = {
    "pending": "待审批", "approved": "已同意", "rejected": "已驳回",
    "escalated": "已升级", "timeout": "已超时",
}
_TAB_STATUS = {
    "pending": ["pending"],
    "approved": ["approved", "rejected", "escalated"],
    "timeout": ["timeout"],
}


def _ticket_item(t: ApprovalTicket) -> dict:
    """工单 → 前端列表项（含研判结论/封禁方案/剩余审批时间）。"""
    summary = _jload(t.alert_summary, {}) or {}
    decision = _jload(t.agent_decision, {}) or {}
    plan = _jload(t.ban_plan, {}) or {}
    remaining_ms = None
    if t.status == "pending" and t.deadline:
        remaining_ms = int((t.deadline - beijing_now()).total_seconds() * 1000)
    return {
        "id": t.id,
        "workflow_instance_id": t.workflow_instance_id,
        "ip": t.ip,
        "status": t.status,
        "status_label": _TICKET_STATUS_LABELS.get(t.status, t.status),
        "alert_name": summary.get("alert_name") or "",
        "risk_level": decision.get("risk_level") or summary.get("risk_level") or "",
        "action": decision.get("action") or "",
        "need_confirm": decision.get("need_confirm"),
        "ban_level": plan.get("ban_level") or "",
        "ban_duration": plan.get("ban_duration"),
        "is_permanent": plan.get("is_permanent"),
        "reasons": decision.get("reasons") or [],
        "monitoring_advice": decision.get("monitoring_advice") or "",
        "alert_summary": summary,
        "agent_decision": decision,
        "ban_plan": plan,
        "asset_info": _jload(t.asset_info, {}) or {},
        "approver": t.approver or "",
        "approval_comment": t.approval_comment or "",
        "approved_at": t.approved_at,
        "deadline": t.deadline,
        "remaining_ms": remaining_ms,
        "created_at": t.created_at,
    }


@router.get("/approvals", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_approvals(
    tab: str = Query("pending", description="pending（待审批）/ approved（已审批）/ timeout（已超时）"),
    keyword: str = Query("", description="IP / 告警名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """审批工单列表（三个 Tab + 关键词筛选 + 分页）。"""
    statuses = _TAB_STATUS.get(tab)
    if statuses is None:
        raise HTTPException(status_code=400, detail="tab 取值须为 pending / approved / timeout")
    query = db.query(ApprovalTicket).filter(ApprovalTicket.status.in_(statuses))
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(ApprovalTicket.ip.ilike(like), ApprovalTicket.alert_summary.ilike(like)))
    total = query.count()
    rows = (
        query.order_by(ApprovalTicket.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    counts = {
        key: db.query(ApprovalTicket).filter(ApprovalTicket.status.in_(sts)).count()
        for key, sts in _TAB_STATUS.items()
    }
    return {
        "total": total, "items": [_ticket_item(t) for t in rows],
        "page": page, "page_size": page_size, "counts": counts,
    }


@router.get("/approvals/{ticket_id}", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_approval(ticket_id: int, db: Session = Depends(get_db)) -> dict:
    """审批工单详情（完整研判结论与决策依据）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    item = _ticket_item(ticket)
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == ticket.workflow_instance_id).first()
    if instance is not None:
        item["instance_status"] = instance.status
        item["instance_status_label"] = _INSTANCE_STATUS_LABELS.get(instance.status, instance.status)
        item["final_result_label"] = _FINAL_RESULT_LABELS.get(instance.final_result or "", "")
    return item


def _apply_approval(
    db: Session,
    ticket_id: int,
    *,
    result: str,
    user: User,
    request: Request,
    comment: str = "",
) -> dict:
    """审批操作公共逻辑：更新工单 → 恢复实例执行 → 写审计（记录操作人与来源 IP）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    if ticket.status != "pending":
        raise HTTPException(status_code=400, detail=f"工单已处理（{_TICKET_STATUS_LABELS.get(ticket.status, ticket.status)}），不可重复操作")

    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == ticket.workflow_instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="关联工作流实例不存在")
    if instance.status != "waiting_approval":
        raise HTTPException(status_code=400, detail="实例不在等待审批状态，无法处理")

    ticket.status = result
    ticket.approver = user.username
    ticket.approval_comment = comment or ""
    ticket.approved_at = beijing_now()
    db.commit()

    # 恢复实例：approval_result 节点按工单状态路由（同意→执行封禁；驳回/超时→持续监控；升级→终止）
    run_instance(db, instance, start_key="approval_result")
    write_audit(
        db, action="approval", resource_type="approval_ticket", resource_id=ticket.id,
        detail={"result": result, "ip": ticket.ip, "comment": comment,
                "instance_id": instance.id, "final_result": instance.final_result},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return {
        "ok": True,
        "ticket_id": ticket.id,
        "result": result,
        "instance_status": instance.status,
        "final_result": instance.final_result,
        "final_result_label": _FINAL_RESULT_LABELS.get(instance.final_result or "", ""),
    }


@router.post("/approvals/{ticket_id}/approve", dependencies=[Depends(require_permission("approval", "approve"))])
def approve_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """同意封禁：触发执行封禁节点。"""
    return _apply_approval(db, ticket_id, result="approved", user=user, request=request,
                           comment=str(body.get("comment") or "同意封禁"))


@router.post("/approvals/{ticket_id}/reject", dependencies=[Depends(require_permission("approval", "approve"))])
def reject_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """驳回：需填写驳回原因，实例转持续监控。"""
    comment = str(body.get("reason") or body.get("comment") or "").strip()
    if not comment:
        raise HTTPException(status_code=400, detail="驳回需填写原因")
    return _apply_approval(db, ticket_id, result="rejected", user=user, request=request, comment=comment)


@router.post("/approvals/{ticket_id}/escalate", dependencies=[Depends(require_permission("approval", "approve"))])
def escalate_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """升级：转人工调查，实例终止（escalated）。"""
    return _apply_approval(db, ticket_id, result="escalated", user=user, request=request,
                           comment=str(body.get("comment") or "升级转人工调查"))


# ======================================================================
# 封禁工作台（已封禁 IP 模块，数据源 ban_records）
# ======================================================================
_RECORD_STATUS_LABELS = {
    "active": "生效中", "pending_approval": "待审批", "expired": "已解封",
    "unbanned": "已解封", "cancelled": "已取消",
}


def _record_risk_level(db: Session, instance_id: Optional[int]) -> str:
    """从智能体调用日志提取研判风险等级（列表徽章展示用）。"""
    if not instance_id:
        return ""
    log = (
        db.query(AgentInvocationLog)
        .filter(AgentInvocationLog.workflow_instance_id == instance_id, AgentInvocationLog.status == "success")
        .order_by(AgentInvocationLog.id.desc())
        .first()
    )
    if log is None or not log.response_body:
        return ""
    try:
        return str(json.loads(log.response_body).get("risk_level") or "")
    except (ValueError, TypeError):
        return ""


def _record_item(db: Session, r: BanRecord) -> dict:
    remaining_ms = None
    if r.status == "active" and r.expire_time and not r.is_permanent:
        remaining_ms = int((r.expire_time - beijing_now()).total_seconds() * 1000)
    alert_count = db.query(AlertEvent).filter(AlertEvent.src_ip.ilike(f'%"{r.ip}"%')).count()
    return {
        "id": r.id,
        "ip": r.ip,
        "risk_level": _record_risk_level(db, r.source_instance_id),
        "status": r.status,
        "status_label": _RECORD_STATUS_LABELS.get(r.status, r.status),
        "ban_level": r.ban_level,
        "is_permanent": r.is_permanent,
        "ban_duration": r.ban_duration,
        "reason": r.reason or "",
        "region": r.region or "",
        "record_id": r.record_id or "",
        "ban_source": r.ban_source or "auto",
        "ban_source_label": _BAN_SOURCE_LABELS.get(r.ban_source or "auto", r.ban_source or "auto"),
        "source_instance_id": r.source_instance_id,
        # 工单同步来源信息（ban_source=ticket 时有值）
        "ticket_id": r.ticket_id,
        "ticket_no": r.ticket_no,
        "ban_device": r.ban_device,
        "expire_time": r.expire_time,
        "remaining_ms": remaining_ms,
        "alert_count": alert_count,
        "unban_reason": r.unban_reason,
        "unban_operator": r.unban_operator,
        "unban_time": r.unban_time,
        "created_at": r.created_at,
    }


@router.get("/banned-ips", dependencies=[Depends(require_role("admin"))])
def list_banned_ips(
    status: str = Query("", description="active/pending_approval/expired/unbanned/cancelled"),
    ip: str = Query("", description="IP 关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """封禁工作台列表（分页 + 状态/IP 筛选）。"""
    query = db.query(BanRecord)
    if status:
        query = query.filter(BanRecord.status == status)
    if ip:
        query = query.filter(BanRecord.ip.ilike(f"%{ip}%"))
    total = query.count()
    rows = (
        query.order_by(BanRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {"total": total, "items": [_record_item(db, r) for r in rows], "page": page, "page_size": page_size}


@router.get("/banned-ips/{record_id}", dependencies=[Depends(require_role("admin"))])
def get_banned_ip(record_id: int, db: Session = Depends(get_db)) -> dict:
    """封禁记录详情：封禁方案 + 研判结论 + 决策依据 + 审批记录 + 关联告警列表。"""
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    item = _record_item(db, record)

    decision = {}
    ticket_item = None
    if record.source_instance_id:
        log = (
            db.query(AgentInvocationLog)
            .filter(AgentInvocationLog.workflow_instance_id == record.source_instance_id,
                    AgentInvocationLog.status == "success")
            .order_by(AgentInvocationLog.id.desc())
            .first()
        )
        if log is not None and log.response_body:
            decision = _jload(log.response_body, {}) or {}
        ticket = (
            db.query(ApprovalTicket)
            .filter(ApprovalTicket.workflow_instance_id == record.source_instance_id)
            .order_by(ApprovalTicket.id.desc())
            .first()
        )
        if ticket is not None:
            ticket_item = _ticket_item(ticket)
    # 工单同步来源（ban_source=ticket）：取该工单安全上下文中此 IP 的智能体研判结论
    if not decision and record.ticket_id:
        tk = db.query(Ticket).filter(Ticket.id == record.ticket_id).first()
        if tk is not None and isinstance(tk.enrichment_data, dict):
            for src in tk.enrichment_data.get("sources") or []:
                if (
                    isinstance(src, dict)
                    and src.get("ip") == record.ip
                    and isinstance(src.get("agent"), dict)
                    and not src["agent"].get("pending")
                ):
                    action = src["agent"].get("action")
                    # 中文键结构，与详情弹窗「审批记录」等板块的展示风格一致
                    decision = {
                        "风险等级": src["agent"].get("risk_level") or "未知",
                        "建议动作": _TICKET_AGENT_ACTION_LABELS.get(action, action or "未给出"),
                        "监控建议": src["agent"].get("monitoring_advice") or "无",
                        "研判理由": src["agent"].get("reasons") or [],
                        "来源工单": f"{tk.ticket_no} {tk.title}",
                    }
                    break
    item["agent_decision"] = decision
    item["approval_ticket"] = ticket_item

    # 关联告警列表（点击可跳转告警列表按 IP 过滤）
    alerts = (
        db.query(AlertEvent.id, AlertEvent.alert_name, AlertEvent.risk_level_name,
                 AlertEvent.risk_level, AlertEvent.occur_timestamp)
        .filter(AlertEvent.src_ip.ilike(f'%"{record.ip}"%'))
        .order_by(AlertEvent.id.desc())
        .limit(50)
        .all()
    )
    item["related_alerts"] = [{
        "id": a.id, "alert_name": a.alert_name or "", "risk_level": a.risk_level,
        "risk_level_name": a.risk_level_name or "", "occur_timestamp": a.occur_timestamp,
    } for a in alerts]
    return item


class UnbanBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500, description="解封原因（必填）")


@router.post("/banned-ips/{record_id}/unban", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def unban_ip(
    record_id: int, body: UnbanBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """解封：填写原因，记录操作人与时间；同步 legacy 工作台并写审计。"""
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    if record.status != "active":
        raise HTTPException(status_code=400, detail="仅生效中的封禁记录可解封")

    now = beijing_now()
    record.status = "unbanned"
    record.unban_reason = body.reason.strip()
    record.unban_operator = user.username
    record.unban_time = now
    # 同步 legacy 工作台
    legacy = db.query(BannedIP).filter(BannedIP.ip == record.ip).first()
    if legacy is not None:
        legacy.status = "unbanned"
    db.commit()

    write_audit(
        db, action="unban", resource_type="ban_record", resource_id=record.id,
        detail={"ip": record.ip, "reason": body.reason.strip(), "manual": True,
                "instance_id": record.source_instance_id},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return {"ok": True, "status": "unbanned", "unban_time": now}


# ----------------------------------------------------------------------
# 手动封禁（admin/有编辑权限即可发起；来源标记 manual）
# ----------------------------------------------------------------------
class ManualBanBody(BaseModel):
    ip: str = Field(
        ..., min_length=1, max_length=2048,
        description="封禁目标：单 IP / CIDR / 范围 / 多值（IPv4/IPv6）",
    )
    ban_level: str = Field("medium", description="封禁等级 low/medium/high/critical")
    ban_duration: int = Field(3600, gt=0, description="封禁时长（秒），is_permanent 时忽略")
    is_permanent: bool = Field(False, description="是否永久封禁")
    reason: str = Field(..., min_length=2, max_length=500, description="封禁原因（必填）")
    region: str = Field("", max_length=64, description="归属地区")


@router.post("/banned-ips", status_code=201, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def create_manual_ban(
    body: ManualBanBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """手动发起封禁：调用封禁工具下发 → 写 ban_records（ban_source=manual）→ 同步 legacy 工作台。"""
    # 封禁目标校验：支持单 IP / CIDR / 范围 / 多值（拒绝主机名/文本/通配）
    from app.core.ip_validation import validate_ban_target

    try:
        ip = validate_ban_target(body.ip, "封禁目标")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not ip:
        # 纯空白输入经归一化后为空串：不能带着空目标去下发封禁
        raise HTTPException(status_code=422, detail="封禁目标不能为空")
    # 已生效的封禁不重复下发
    existing = db.query(BanRecord).filter(BanRecord.ip == ip, BanRecord.status == "active").first()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"IP {ip} 已在封禁中（{_BAN_SOURCE_LABELS.get(existing.ban_source, '')}），请先解封再重新封禁")

    ban_plan = {
        "ban_level": body.ban_level,
        "ban_duration": body.ban_duration,
        "is_permanent": body.is_permanent,
        "reason": body.reason.strip(),
        "region": body.region.strip(),
    }
    # 调封禁工具下发（失败重试 3 次由 ban_client 内实现）
    from app.workflow import ban_client
    try:
        record_id = ban_client.record_ban(ip, ban_plan)
    except ban_client.BanCallError as exc:
        logger.error("手动封禁下发失败 ip=%s: %s", ip, exc)
        raise HTTPException(status_code=502, detail="封禁工具调用失败，请稍后重试或联系管理员")

    now = beijing_now()
    expire_time = None if body.is_permanent else now + timedelta(seconds=body.ban_duration)
    record = BanRecord(
        ip=ip,
        ban_level=body.ban_level,
        ban_duration=body.ban_duration,
        is_permanent=body.is_permanent,
        expire_time=expire_time,
        reason=body.reason.strip(),
        region=body.region.strip(),
        ban_source="manual",
        record_id=record_id,
        status="active",
    )
    db.add(record)
    # 同步 legacy 已封禁 IP 表
    legacy = db.query(BannedIP).filter(BannedIP.ip == ip).first()
    if legacy is None:
        legacy = BannedIP(ip=ip)
        db.add(legacy)
    legacy.ban_level = body.ban_level
    legacy.ban_duration = body.ban_duration
    legacy.expired_at = expire_time or (now + timedelta(days=36500))
    legacy.region = body.region.strip()
    legacy.reason = body.reason.strip()
    legacy.status = "active"
    legacy.source = "manual"
    db.commit()

    write_audit(
        db, action="manual_ban", resource_type="ban_record", resource_id=record.id,
        detail={"ip": ip, "ban_plan": ban_plan, "record_id": record_id},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return _record_item(db, record)


# ----------------------------------------------------------------------
# 删除（仅 admin）
# ----------------------------------------------------------------------
@router.delete("/banned-ips/{record_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
def delete_banned_ip(
    record_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> None:
    """删除封禁记录（仅 admin；不通知封禁工具，仅清工作台数据）。"""
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    snapshot = {"id": record.id, "ip": record.ip, "status": record.status, "record_id": record.record_id}
    db.delete(record)
    db.commit()
    write_audit(
        db, action="delete", resource_type="ban_record", resource_id=record_id,
        detail={"snapshot": snapshot},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )


@router.delete("/approvals/{ticket_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
def delete_approval_ticket(
    ticket_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> None:
    """删除审批工单（仅 admin；关联的 pending_approval 封禁记录一并置为 cancelled）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    snapshot = {"id": ticket.id, "ip": ticket.ip, "status": ticket.status}
    # 工作台关联待审批记录置为 cancelled
    if ticket.status == "pending":
        db.query(BanRecord).filter(
            BanRecord.source_instance_id == ticket.workflow_instance_id,
            BanRecord.status == "pending_approval",
        ).update({"status": "cancelled"}, synchronize_session=False)
    db.delete(ticket)
    db.commit()
    write_audit(
        db, action="delete", resource_type="approval_ticket", resource_id=ticket_id,
        detail={"snapshot": snapshot},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )


# ======================================================================
# 监控页统计卡片
# ======================================================================
@router.get("/stats", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def workflow_stats(db: Session = Depends(get_db)) -> dict:
    """工作流统计：今日触发实例数 / 自动封禁数 / 待审批数 / 审批通过率 / 平均研判耗时 + 熔断状态。"""
    today_start = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    q_today = db.query(WorkflowInstance).filter(WorkflowInstance.created_at >= today_start)
    today_instances = q_today.count()
    today_auto_bans = q_today.filter(WorkflowInstance.final_result == "banned").count()
    today_errors = q_today.filter(WorkflowInstance.status == "error").count()
    pending_approvals = (
        db.query(ApprovalTicket).filter(ApprovalTicket.status == "pending").count()
    )
    # 审批通过率：已出结论的工单中 approved 占比
    approved_n = db.query(ApprovalTicket).filter(ApprovalTicket.status == "approved").count()
    concluded_n = db.query(ApprovalTicket).filter(
        ApprovalTicket.status.in_(["approved", "rejected", "timeout"])
    ).count()
    approval_rate = round(approved_n * 100.0 / concluded_n, 1) if concluded_n else None
    # 平均研判耗时：今日成功智能体调用
    avg_row = (
        db.query(func.avg(AgentInvocationLog.duration_ms))
        .filter(AgentInvocationLog.status == "success", AgentInvocationLog.created_at >= today_start)
        .scalar()
    )
    avg_agent_ms = int(avg_row) if avg_row is not None else None
    # 今日持续监控数
    today_monitoring = q_today.filter(WorkflowInstance.final_result == "monitoring").count()
    return {
        "today_instances": today_instances,
        "today_auto_bans": today_auto_bans,
        "today_errors": today_errors,
        "today_monitoring": today_monitoring,
        "pending_approvals": pending_approvals,
        "approval_rate": approval_rate,
        "avg_agent_ms": avg_agent_ms,
        "circuit": trigger_mod.get_circuit_state(),
    }
