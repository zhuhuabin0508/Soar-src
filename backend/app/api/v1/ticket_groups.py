"""工单处理分组管理 API。

把系统现有人员账号自定义分组（如"监测预警组 / 研判分析组 / 应急处置组"），
供流程模板节点绑定与工单流转使用。

权限：``ticket_config:view`` 可查看，``ticket_config:edit`` 可增删改。
所有写操作记录审计日志。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.ticket import Ticket, TicketFlow, TicketGroup, TicketGroupMember
from app.models.user import User
from app.schemas.ticket import GroupCreate, GroupMembersUpdate, GroupUpdate
from app.workflow.audit import write_audit

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/ticket-config/groups",
    tags=["ticket-config"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("ticket_config", "view")),
    ],
)


# ============ 辅助 ============

def _get_group_or_404(db: Session, group_id: int) -> TicketGroup:
    group = db.query(TicketGroup).filter(TicketGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    return group


def _validate_user_ids(db: Session, user_ids: list[int]) -> list[int]:
    """校验用户 ID 列表全部存在且启用，返回去重后的 ID。"""
    ids: list[int] = []
    for uid in user_ids:
        if uid not in ids:
            ids.append(uid)
    if not ids:
        return []
    existing = {
        uid for (uid,) in db.query(User.id).filter(User.id.in_(ids), User.is_active.is_(True)).all()
    }
    missing = [uid for uid in ids if uid not in existing]
    if missing:
        raise HTTPException(status_code=400, detail=f"用户不存在或已停用：ID {missing}")
    return ids


def _group_payload(db: Session, group: TicketGroup) -> dict:
    """分组 + 成员列表（含用户名/显示名）。"""
    rows = (
        db.query(TicketGroupMember, User)
        .join(User, User.id == TicketGroupMember.user_id)
        .filter(TicketGroupMember.group_id == group.id)
        .order_by(TicketGroupMember.id)
        .all()
    )
    members = [
        {
            "user_id": m.user_id,
            "username": u.username,
            "display_name": u.display_name or u.username,
            "department": u.department or "",
        }
        for m, u in rows
    ]
    data = group.to_dict()
    data["members"] = members
    data["member_count"] = len(members)
    return data


# ============ 接口 ============

@router.get("")
def list_groups(db: Session = Depends(get_db)) -> dict:
    """分组列表（含成员），供配置页与工单发起/详情页取分组信息。"""
    groups = (
        db.query(TicketGroup)
        .order_by(TicketGroup.enabled.desc(), TicketGroup.id.asc())
        .all()
    )
    return {"items": [_group_payload(db, g) for g in groups]}


@router.post("", status_code=201)
def create_group(
    body: GroupCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """创建分组（含初始成员）。"""
    name = sanitize_text(body.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")
    if db.query(TicketGroup).filter(TicketGroup.name == name).first():
        raise HTTPException(status_code=400, detail=f"分组名称「{name}」已存在")

    member_ids = _validate_user_ids(db, body.member_ids)
    group = TicketGroup(
        name=name,
        description=sanitize_text(body.description) if body.description else None,
        enabled=body.enabled,
    )
    db.add(group)
    db.flush()
    for uid in member_ids:
        db.add(TicketGroupMember(group_id=group.id, user_id=uid))
    db.commit()
    db.refresh(group)
    write_audit(
        db, action="ticket_group_create", resource_type="ticket_group", resource_id=group.id,
        detail={"name": name, "member_ids": member_ids},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("创建工单分组: id=%s name=%s members=%d, operator=%s",
                group.id, name, len(member_ids), current_user.username)
    return _group_payload(db, group)


@router.put("/{group_id}")
def update_group(
    group_id: int,
    body: GroupUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """更新分组基础信息（名称/描述/启停）。"""
    group = _get_group_or_404(db, group_id)
    if body.name is not None:
        name = sanitize_text(body.name).strip()
        if not name:
            raise HTTPException(status_code=400, detail="分组名称不能为空")
        dup = db.query(TicketGroup).filter(TicketGroup.name == name, TicketGroup.id != group_id).first()
        if dup:
            raise HTTPException(status_code=400, detail=f"分组名称「{name}」已存在")
        group.name = name
    if body.description is not None:
        group.description = sanitize_text(body.description) or None
    if body.enabled is not None:
        group.enabled = body.enabled
    db.commit()
    db.refresh(group)
    write_audit(
        db, action="ticket_group_update", resource_type="ticket_group", resource_id=group.id,
        detail={"name": group.name, "enabled": group.enabled},
        operator=current_user.username, user_id=current_user.id,
    )
    return _group_payload(db, group)


@router.delete("/{group_id}")
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """删除分组：有进行中工单停留在该分组时禁止删除（历史工单记录不受影响）。"""
    group = _get_group_or_404(db, group_id)
    pending = (
        db.query(func.count(Ticket.id))
        .filter(
            Ticket.status.in_(("processing", "paused")),
            Ticket.current_group_id == group_id,
        )
        .scalar()
    )
    if pending:
        raise HTTPException(
            status_code=400,
            detail=f"有 {pending} 条进行中工单正停留在该分组，禁止删除",
        )
    db.query(TicketGroupMember).filter(TicketGroupMember.group_id == group_id).delete()
    db.delete(group)
    db.commit()
    write_audit(
        db, action="ticket_group_delete", resource_type="ticket_group", resource_id=group_id,
        detail={"name": group.name},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("删除工单分组: id=%s name=%s, operator=%s", group_id, group.name, current_user.username)
    return {"deleted": group_id}


@router.put("/{group_id}/members")
def update_group_members(
    group_id: int,
    body: GroupMembersUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """全量设置分组成员（前端勾选提交，做差集增删）。"""
    group = _get_group_or_404(db, group_id)
    new_ids = set(_validate_user_ids(db, body.user_ids))
    old_rows = db.query(TicketGroupMember).filter(TicketGroupMember.group_id == group_id).all()
    old_ids = {r.user_id for r in old_rows}
    for r in old_rows:
        if r.user_id not in new_ids:
            db.delete(r)
    for uid in new_ids - old_ids:
        db.add(TicketGroupMember(group_id=group_id, user_id=uid))
    db.commit()
    db.refresh(group)
    write_audit(
        db, action="ticket_group_members_update", resource_type="ticket_group", resource_id=group_id,
        detail={"name": group.name, "added": sorted(new_ids - old_ids), "removed": sorted(old_ids - new_ids)},
        operator=current_user.username, user_id=current_user.id,
    )
    return _group_payload(db, group)
