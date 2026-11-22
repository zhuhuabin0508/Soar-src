"""工单价值评分 API。

提供两类能力：
1. 评分规则配置（``/ticket-scores/rule``）：读取当前规则、保存新版本、版本历史与
   指定版本快照。读取需 ``ticket_config:view``，保存需 ``ticket_config:edit``。
2. 工单评分（``/ticket-scores/tickets/{id}``）：读取评分状态（规则 + 已提交结果 +
   按最新规则折算）、提交评分。读取需 ``ticket:view``，提交需 ``ticket:score``。

评分提交后不可重复（工单唯一 + 409），规则变更只影响之后的评分与展示折算，
历史结果按提交时规则快照保留；所有写操作落审计日志。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip
from app.core.ticket_score import (
    ScoreRuleError,
    build_ticket_score_state,
    default_rule_payload,
    get_score_rule,
    get_score_rule_version,
    list_score_rule_versions,
    save_score_rule,
    submit_ticket_score,
)
from app.database import get_db
from app.dependencies import has_permission_for_user, require_permission
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.ticket_score import TicketScoreRuleUpdate, TicketScoreSubmit
from app.workflow.audit import write_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ticket-scores", tags=["ticket-scores"])


def _score_error(exc: ScoreRuleError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


def _get_ticket_or_404(db: Session, ticket_id: int, *, for_update: bool = False) -> Ticket:
    query = db.query(Ticket).filter(Ticket.id == ticket_id)
    if for_update:
        query = query.with_for_update()
    ticket = query.first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在")
    return ticket


# ============ 评分规则 ============

@router.get("/rule")
def get_rule(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "view")),
) -> dict:
    """当前生效评分规则（未自定义时返回内置默认规则，version=0）。"""
    return get_score_rule(db)


@router.get("/rule/default")
def get_default_rule(
    current_user: User = Depends(require_permission("ticket_config", "view")),
) -> dict:
    """内置默认规则（version=0），供配置页「恢复默认」载入。"""
    return default_rule_payload()


@router.put("/rule")
def update_rule(
    body: TicketScoreRuleUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """保存评分规则：校验后生成新版本并落审计日志。"""
    try:
        rule = save_score_rule(db, body.config, note=body.note or "", operator=current_user)
    except ScoreRuleError as exc:
        db.rollback()
        raise _score_error(exc) from exc

    write_audit(
        db,
        action="ticket_score_rule_update",
        resource_type="ticket_config",
        resource_id=rule.get("version"),
        detail={
            "version": rule.get("version"),
            "note": rule.get("note") or "",
            "dimensions": [
                {"key": d["key"], "name": d["name"], "weight": d["weight"]}
                for d in rule.get("dimensions") or []
            ],
            "factor_cap": rule.get("factor_cap"),
        },
        operator=current_user.username,
        user_id=current_user.id,
        ip_address=get_client_ip(request),
    )
    logger.info(
        "更新工单评分规则: version=%s operator=%s", rule.get("version"), current_user.username,
    )
    return rule


@router.get("/rule/versions")
def get_rule_versions(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "view")),
) -> dict:
    """规则版本列表（倒序，仅元信息）。"""
    return list_score_rule_versions(db, limit=limit)


@router.get("/rule/versions/{version}")
def get_rule_version_detail(
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "view")),
) -> dict:
    """指定版本的完整规则快照（用于对比与历史结果解释）。"""
    payload = get_score_rule_version(db, version)
    if payload is None:
        raise HTTPException(status_code=404, detail="规则版本不存在")
    return payload


# ============ 工单评分 ============

@router.get("/options")
def get_score_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "view")),
) -> dict:
    """评分筛选项：当前规则版本与分级列表（ticket:view 即可读取，用于列表筛选）。"""
    rule = get_score_rule(db)
    return {
        "rule_version": int(rule.get("version") or 0),
        "grades": [
            {
                "key": g["key"],
                "label": g["label"],
                "color": g.get("color") or "slate",
                "min": g["min"],
            }
            for g in rule.get("grades") or []
        ],
    }


@router.get("/tickets/{ticket_id}")
def get_ticket_score_state(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "view")),
) -> dict:
    """工单评分状态：当前规则、已提交结果、按最新规则折算与可评分标记。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    can_score = has_permission_for_user(db, current_user, "ticket", "score")
    return build_ticket_score_state(db, ticket, can_score_action=can_score)


@router.post("/tickets/{ticket_id}")
def create_ticket_score(
    ticket_id: int,
    body: TicketScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "score")),
) -> dict:
    """提交工单评分：仅已完成工单、每单仅一次，返回最新评分状态。"""
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    try:
        result = submit_ticket_score(
            db, ticket, current_user,
            dimension_scores=body.dimension_scores,
            factor_keys=body.factor_keys,
            override_keys=body.override_keys,
            comment=body.comment,
        )
    except ScoreRuleError as exc:
        db.rollback()
        if exc.status_code == 409:
            write_audit(
                db,
                action="ticket_score_rejected",
                resource_type="ticket",
                resource_id=ticket.id,
                detail={"reason": exc.message, "ticket_no": ticket.ticket_no},
                operator=current_user.username,
                user_id=current_user.id,
                ip_address=get_client_ip(request),
                result="failed",
            )
        raise _score_error(exc) from exc

    row = result["row"]
    write_audit(
        db,
        action="ticket_score_submit",
        resource_type="ticket",
        resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no,
            "rule_version": row.rule_version,
            "dimension_scores": row.dimension_scores,
            "factor_keys": row.factor_keys,
            "override_keys": row.override_keys,
            "base_score": row.base_score,
            "final_score": row.final_score,
            "grade": row.grade,
        },
        operator=current_user.username,
        user_id=current_user.id,
        ip_address=get_client_ip(request),
    )
    logger.info(
        "工单评分提交: ticket=%s score=%s grade=%s operator=%s",
        ticket.ticket_no, row.final_score, row.grade, current_user.username,
    )
    return build_ticket_score_state(db, ticket, can_score_action=True)
