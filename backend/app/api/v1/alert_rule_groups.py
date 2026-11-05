"""告警规则分组 API（XDR 列表页左侧分组树面板）。

- 列表：分组 + 规则计数（未分组/未知分组的规则归入「其他」计数）；
- 新建：名称唯一；
- 重命名：同步更新关联规则的 rule_group（规则按分组名冗余存储）；
- 删除：关联规则移入「其他」（「其他」分组不可删除）；
- 全部写操作接审计日志。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.api.v1.alert_rules import _log_audit
from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.alert_rule import AlertRule
from app.models.alert_rule_group import AlertRuleGroup

# 路由级基线：强制登录；权限按接口单独声明
# （列表=alert_rule:view，新建/重命名/删除=alert_rule:edit）
router = APIRouter(
    prefix="/alert-rule-groups",
    tags=["alert-rule-groups"],
    dependencies=[Depends(get_current_user)],
)

DEFAULT_GROUP = "其他"


class GroupBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


def _ensure_default_group(db: Session) -> None:
    """「其他」分组兜底存在（删除分组时规则移入目标）。"""
    if not db.query(AlertRuleGroup.id).filter(AlertRuleGroup.name == DEFAULT_GROUP).first():
        db.add(AlertRuleGroup(name=DEFAULT_GROUP, sort_order=990))


@router.get("")
def list_groups(
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """分组列表（含规则计数；按 sort_order 排序，「其他」固定最后）。"""
    _ensure_default_group(db)
    db.commit()
    groups = (
        db.query(AlertRuleGroup)
        .order_by(AlertRuleGroup.sort_order.asc(), AlertRuleGroup.id.asc())
        .all()
    )
    counts = dict(
        db.query(AlertRule.rule_group, sa_func.count(AlertRule.id))
        .group_by(AlertRule.rule_group)
        .all()
    )
    total = sum(counts.values())
    items = [
        {
            "id": g.id,
            "name": g.name,
            "count": counts.get(g.name, 0),
            "created_at": g.created_at.strftime("%Y-%m-%d %H:%M:%S") if g.created_at else None,
        }
        for g in groups
    ]
    return {"items": items, "total": total}


@router.post("")
def create_group(payload: GroupBody, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """新建分组（名称唯一）。"""
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail="分组名称不能为空")
    if db.query(AlertRuleGroup.id).filter(AlertRuleGroup.name == name).first():
        raise HTTPException(422, detail=f"分组「{name}」已存在")
    max_order = db.query(sa_func.max(AlertRuleGroup.sort_order)).scalar() or 0
    group = AlertRuleGroup(name=name, sort_order=max_order + 10)
    db.add(group)
    db.commit()
    db.refresh(group)
    _log_audit(request, "alert_rule_group.create", f"新建告警规则分组「{name}」", current_user)
    return {"id": group.id, "name": group.name}


@router.put("/{group_id}")
def rename_group(group_id: int, payload: GroupBody, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """重命名分组（同步更新关联规则的分组名）。"""
    group = db.query(AlertRuleGroup).filter(AlertRuleGroup.id == group_id).first()
    if not group:
        raise HTTPException(404, detail="分组不存在")
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(422, detail="分组名称不能为空")
    if new_name == group.name:
        return {"ok": True}
    dup = db.query(AlertRuleGroup.id).filter(AlertRuleGroup.name == new_name).first()
    if dup:
        raise HTTPException(422, detail=f"分组「{new_name}」已存在")
    old_name = group.name
    rules = db.query(AlertRule).filter(AlertRule.rule_group == old_name).all()
    for r in rules:
        r.rule_group = new_name
        r.updated_by = current_user.username
    group.name = new_name
    db.commit()
    _log_audit(request, "alert_rule_group.rename", f"重命名告警规则分组「{old_name}」→「{new_name}」（同步 {len(rules)} 条规则）", current_user)
    return {"ok": True, "moved_rules": len(rules)}


@router.delete("/{group_id}")
def delete_group(group_id: int, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """删除分组（关联规则移入「其他」；「其他」本身不可删除）。"""
    group = db.query(AlertRuleGroup).filter(AlertRuleGroup.id == group_id).first()
    if not group:
        raise HTTPException(404, detail="分组不存在")
    if group.name == DEFAULT_GROUP:
        raise HTTPException(422, detail="「其他」为默认分组，不可删除")
    rules = db.query(AlertRule).filter(AlertRule.rule_group == group.name).all()
    for r in rules:
        r.rule_group = DEFAULT_GROUP
        r.updated_by = current_user.username
    db.delete(group)
    db.commit()
    _log_audit(request, "alert_rule_group.delete", f"删除告警规则分组「{group.name}」（{len(rules)} 条规则移入「其他」）", current_user)
    return {"ok": True, "moved_rules": len(rules)}
