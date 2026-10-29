"""通知中心 API。

提供：
- 当前用户通知列表查询（含广播，分页 + 未读计数）
- 未读通知计数
- 单条 / 全部标记已读
- 单条通知删除
- 管理员发布公告（创建通知）
- 个人提醒偏好（每类型：右侧滑出 / 仅铃铛）
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.notification import Notification
from app.models.user import User
from app.models.user_notification_pref import (
    POPUP_MODES,
    POPUP_MODE_SILENT,
    POPUP_MODE_TOAST,
    UserNotificationPref,
    default_popup_mode,
)
from app.schemas.notification import (
    NotificationCreate,
    NotificationListResponse,
    NotificationOut,
)

logger = logging.getLogger(__name__)

# 路由级基线：强制登录；权限按接口单独声明
# （列表/未读计数/已读/删除自己的通知=notification:view，
#   创建通知/发布公告=system_config:edit）
router = APIRouter(
    prefix="/notifications",
    tags=["notifications"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> NotificationListResponse:
    """获取当前用户的通知列表（含全员广播）。"""
    visibility = (Notification.user_id == current_user.id) | (Notification.user_id.is_(None))

    q = db.query(Notification).filter(visibility)
    total = q.count()

    unread_count = (
        db.query(Notification)
        .filter(visibility, Notification.is_read.is_(False))
        .count()
    )

    notifications = (
        q.order_by(Notification.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    return NotificationListResponse(
        notifications=[NotificationOut.model_validate(n) for n in notifications],
        total=total,
        unread_count=unread_count,
    )


@router.get("/unread-count")
def get_unread_count(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """获取当前用户未读通知数量（含全员广播）。"""
    visibility = (Notification.user_id == current_user.id) | (Notification.user_id.is_(None))
    unread_count = (
        db.query(Notification)
        .filter(visibility, Notification.is_read.is_(False))
        .count()
    )
    return {"unread_count": unread_count}


class NotificationPrefUpdate(BaseModel):
    """更新单类型提醒偏好。"""

    event_type: str = Field(..., min_length=1, max_length=50)
    popup_mode: str = Field(..., description="toast（右侧滑出）/ silent（仅铃铛）")


@router.get("/prefs")
def get_prefs(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """获取当前用户的通知提醒偏好（按类型目录合并默认值）。"""
    from app.api.v1.notification_rules import EVENT_TYPES

    # 用户已配置的偏好（不含通配 *，个人偏好按具体类型生效）
    rows = (
        db.query(UserNotificationPref)
        .filter(UserNotificationPref.user_id == current_user.id)
        .all()
    )
    user_prefs = {r.event_type: r.popup_mode for r in rows}

    prefs = []
    for meta in EVENT_TYPES:
        if meta["value"] == "*":
            continue  # 通配仅用于通知规则路由，个人偏好不适用
        prefs.append(
            {
                "event_type": meta["value"],
                "label": meta["label"],
                "desc": meta["desc"],
                "group": meta["group"],
                # 已配置用用户值，否则按类型默认策略（工单滑出，其余静默）
                "popup_mode": user_prefs.get(meta["value"], default_popup_mode(meta["value"])),
                "customized": meta["value"] in user_prefs,
            }
        )
    return {
        "prefs": prefs,
        "popup_modes": [
            {"value": POPUP_MODE_TOAST, "label": "右侧滑出"},
            {"value": POPUP_MODE_SILENT, "label": "仅铃铛"},
        ],
    }


@router.put("/prefs")
def update_pref(
    payload: NotificationPrefUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """更新当前用户某通知类型的提醒方式（不存在则新增，存在则覆盖）。"""
    from app.api.v1.notification_rules import EVENT_TYPES

    valid_types = {m["value"] for m in EVENT_TYPES if m["value"] != "*"}
    if payload.event_type not in valid_types:
        raise HTTPException(status_code=422, detail=f"不支持的通知类型：{payload.event_type}")
    if payload.popup_mode not in POPUP_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"提醒方式仅支持 {' / '.join(POPUP_MODES)}",
        )

    row = (
        db.query(UserNotificationPref)
        .filter(
            UserNotificationPref.user_id == current_user.id,
            UserNotificationPref.event_type == payload.event_type,
        )
        .first()
    )
    if row:
        row.popup_mode = payload.popup_mode
    else:
        row = UserNotificationPref(
            user_id=current_user.id,
            event_type=payload.event_type,
            popup_mode=payload.popup_mode,
        )
        db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # 并发首存撞 (user_id, event_type) 唯一约束：另一请求已插入同类型行，
        # 回滚后转为覆盖更新，保证幂等
        db.rollback()
        row = (
            db.query(UserNotificationPref)
            .filter(
                UserNotificationPref.user_id == current_user.id,
                UserNotificationPref.event_type == payload.event_type,
            )
            .first()
        )
        if row is None:  # 极端：并发插入方又已删除，让调用方重试
            raise HTTPException(status_code=409, detail="偏好保存冲突，请重试")
        row.popup_mode = payload.popup_mode
        db.commit()

    logger.info(
        "通知提醒偏好已更新: user_id=%s, event_type=%s, popup_mode=%s",
        current_user.id, payload.event_type, payload.popup_mode,
    )
    return {
        "success": True,
        "event_type": payload.event_type,
        "popup_mode": payload.popup_mode,
    }


@router.delete("/prefs")
def reset_prefs(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """恢复默认：清空当前用户全部提醒偏好（回到工单滑出、其余静默）。"""
    deleted = (
        db.query(UserNotificationPref)
        .filter(UserNotificationPref.user_id == current_user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    logger.info("通知提醒偏好已重置: user_id=%s, 清除 %d 条", current_user.id, deleted)
    return {"success": True, "deleted_count": deleted}


@router.put("/read-all")
def mark_all_as_read(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """标记当前用户所有通知（含广播）为已读。"""
    visibility = (Notification.user_id == current_user.id) | (Notification.user_id.is_(None))
    updated = (
        db.query(Notification)
        .filter(visibility, Notification.is_read.is_(False))
        .update({Notification.is_read: True}, synchronize_session=False)
    )
    db.commit()
    return {"success": True, "updated_count": updated}


@router.put("/{notification_id}/read")
def mark_as_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> dict:
    """标记单条通知为已读（需验证归属当前用户或为广播）。"""
    n = db.query(Notification).filter(Notification.id == notification_id).first()
    if n is None:
        raise HTTPException(status_code=404, detail="通知不存在")
    if not ((n.user_id == current_user.id) or (n.user_id is None)):
        raise HTTPException(status_code=404, detail="通知不存在")

    if not n.is_read:
        n.is_read = True
        db.commit()
    return {"success": True}


@router.delete("/{notification_id}", status_code=204)
def delete_notification(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("notification", "view")),
) -> None:
    """删除单条通知（需验证归属当前用户或为广播）。"""
    n = db.query(Notification).filter(Notification.id == notification_id).first()
    if n is None:
        raise HTTPException(status_code=404, detail="通知不存在")
    if not ((n.user_id == current_user.id) or (n.user_id is None)):
        raise HTTPException(status_code=404, detail="通知不存在")

    db.delete(n)
    db.commit()


@router.post("", response_model=NotificationOut, status_code=201)
def create_notification(
    payload: NotificationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("system_config", "edit")),
) -> Notification:
    """创建通知 / 发布公告（仅管理员可用）。

    - 指定 user_id：直接创建给该用户
    - user_id 为 None（公告）：走 dispatch_notification 规则路由（event_type=announcement）
    """
    # 公告类型（user_id 为空）走规则路由，按通知规则分发给目标用户/角色
    if payload.user_id is None:
        from app.core.notification_dispatch import dispatch_notification

        created = dispatch_notification(
            db,
            event_type="announcement",
            title=payload.title,
            content=payload.content,
            related_type=payload.related_type,
            related_id=payload.related_id,
            created_by=current_user.username,
        )
        if not created:
            # 极端情况：规则路由未产出通知（不应发生），回退广播
            n = Notification(
                user_id=None,
                type=payload.type,
                title=payload.title,
                content=payload.content,
                related_type=payload.related_type,
                related_id=payload.related_id,
                created_by=current_user.username,
            )
            db.add(n)
            db.commit()
            db.refresh(n)
            return n
        logger.info(
            "公告已通过规则路由派发: event_type=announcement, created_by=%s, 派发 %d 条",
            current_user.username, len(created),
        )
        return created[0]

    # 指定用户：直接创建
    n = Notification(
        user_id=payload.user_id,
        type=payload.type,
        title=payload.title,
        content=payload.content,
        related_type=payload.related_type,
        related_id=payload.related_id,
        created_by=current_user.username,
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    logger.info(
        "通知已创建: id=%s, type=%s, user_id=%s, created_by=%s",
        n.id, n.type, n.user_id, n.created_by,
    )
    return n
