"""通知规则 API。

提供通知路由规则的 CRUD 管理：
- 列表查询（含分页、按 event_type / enabled 过滤）
- 创建 / 更新 / 删除 / 启用停用
- 查询可用事件类型清单（供前端下拉选择）

权限：需要 system_config.edit（管理员），查询（list）允许已登录用户查看。
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.notification_rule import NotificationRule
from app.models.user import User
from app.schemas.notification_rule import (
    NotificationRuleCreate,
    NotificationRuleOut,
    NotificationRuleUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/notification-rules",
    tags=["notification-rules"],
)

# 系统支持的事件类型清单（供前端下拉选择）。
# 覆盖所有走 dispatch_notification 规则路由的通知产生点（工单除外：
# 工单通知由工单模块精确投递给处理人/抄送人，不经过通知规则）。
# group 用于前端下拉分组展示。
EVENT_TYPES = [
    # 系统类
    {"value": "announcement", "label": "公告", "desc": "管理员发布公告", "group": "系统"},
    {"value": "system_update", "label": "系统更新", "desc": "系统版本升级时通知", "group": "系统"},
    {"value": "system_alert", "label": "系统资源告警", "desc": "CPU / 内存 / 磁盘超过阈值时通知", "group": "系统"},
    # 告警接入类
    {"value": "alert_high_risk", "label": "高危告警命中", "desc": "告警规则命中高危及以上告警时通知", "group": "告警接入"},
    {"value": "receiver_alert", "label": "日志接收异常", "desc": "日志接收器收流异常时通知", "group": "告警接入"},
    {"value": "parse_alert", "label": "解析成功率异常", "desc": "解析模板成功率低于阈值时通知", "group": "告警接入"},
    # 工作流类
    {"value": "execution_failed", "label": "工作流执行失败", "desc": "工作流执行失败时通知", "group": "工作流"},
    {"value": "approval_pending", "label": "待审批提醒", "desc": "产生待审批任务时通知", "group": "工作流"},
    {"value": "workflow_alert", "label": "封禁工作流告警", "desc": "熔断暂停 / 触发限频 / 审批超时驳回时通知", "group": "工作流"},
    {"value": "workflow", "label": "工作流运营通知", "desc": "自动解封 / 持续监控 / 实例异常时通知", "group": "工作流"},
    # 模型类
    {"value": "model_alert", "label": "模型健康异常", "desc": "模型健康检查失败或恢复时通知", "group": "模型"},
    # 工单类（工单通知由工单模块精确投递，不经过通知规则，但提醒偏好需要覆盖该类型）
    {"value": "ticket", "label": "工单处置提醒", "desc": "新工单流转待处置 / 催办 / 超时提醒时通知", "group": "工单"},
    # 反馈类
    {"value": "feedback", "label": "反馈提交", "desc": "用户提交新反馈时通知（回复/状态通知直达提交人，不走规则）", "group": "反馈"},
    # 通配
    {"value": "*", "label": "全部事件", "desc": "匹配所有通知事件（通配）", "group": "通用"},
]


@router.get("/event-types")
def list_event_types(
    current_user: User = Depends(get_current_user),
) -> dict:
    """返回系统支持的通知事件类型清单（供前端下拉选择）。"""
    return {"event_types": EVENT_TYPES}


@router.get("", response_model=list[NotificationRuleOut])
def list_rules(
    event_type: Optional[str] = Query(None, description="按事件类型过滤"),
    enabled: Optional[bool] = Query(None, description="按启用状态过滤"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[NotificationRule]:
    """获取通知规则列表。"""
    q = db.query(NotificationRule)
    if event_type is not None:
        q = q.filter(NotificationRule.event_type == event_type)
    if enabled is not None:
        q = q.filter(NotificationRule.enabled == enabled)
    return q.order_by(NotificationRule.created_at.desc()).all()


@router.post("", response_model=NotificationRuleOut, status_code=201)
def create_rule(
    payload: NotificationRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "edit")),
) -> NotificationRule:
    """创建通知规则。"""
    rule = NotificationRule(
        name=payload.name,
        description=payload.description,
        event_type=payload.event_type,
        target_user_ids=json.dumps(payload.target_user_ids or []),
        target_roles=json.dumps(payload.target_roles or []),
        enabled=payload.enabled,
        created_by=current_user.username,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    logger.info(
        "通知规则已创建: id=%s, name=%s, event_type=%s, created_by=%s",
        rule.id, rule.name, rule.event_type, current_user.username,
    )
    return rule


@router.put("/{rule_id}", response_model=NotificationRuleOut)
def update_rule(
    rule_id: int,
    payload: NotificationRuleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "edit")),
) -> NotificationRule:
    """更新通知规则（部分字段更新）。"""
    rule = db.query(NotificationRule).filter(NotificationRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="通知规则不存在")

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        rule.name = update_data["name"]
    if "description" in update_data:
        rule.description = update_data["description"]
    if "event_type" in update_data:
        rule.event_type = update_data["event_type"]
    if "target_user_ids" in update_data:
        rule.target_user_ids = json.dumps(update_data["target_user_ids"] or [])
    if "target_roles" in update_data:
        rule.target_roles = json.dumps(update_data["target_roles"] or [])
    if "enabled" in update_data:
        rule.enabled = update_data["enabled"]

    db.commit()
    db.refresh(rule)
    logger.info(
        "通知规则已更新: id=%s, name=%s, by=%s",
        rule.id, rule.name, current_user.username,
    )
    return rule


@router.delete("/{rule_id}", status_code=204)
def delete_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "edit")),
) -> None:
    """删除通知规则。"""
    rule = db.query(NotificationRule).filter(NotificationRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="通知规则不存在")
    db.delete(rule)
    db.commit()
    logger.info(
        "通知规则已删除: id=%s, name=%s, by=%s",
        rule.id, rule.name, current_user.username,
    )


@router.put("/{rule_id}/toggle", response_model=NotificationRuleOut)
def toggle_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "edit")),
) -> NotificationRule:
    """快速启停通知规则。"""
    rule = db.query(NotificationRule).filter(NotificationRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="通知规则不存在")
    rule.enabled = not rule.enabled
    db.commit()
    db.refresh(rule)
    logger.info(
        "通知规则切换: id=%s, enabled=%s, by=%s",
        rule.id, rule.enabled, current_user.username,
    )
    return rule
