"""个人通知提醒偏好模型。

记录每个用户对每种通知类型的提醒方式偏好：
- popup_mode = 'toast'   → 右侧滑出提醒（弹通知卡片，可点击跳转）
- popup_mode = 'silent'  → 仅铃铛查看（不弹窗，只有铃铛徽章计数）

与「通知规则」（notification_rule，决定谁收到通知）正交：
通知规则由管理员配置路由，本表是用户自己的提醒方式偏好。

默认策略（未配置时）见 DEFAULT_POPUP_MODES：
工单类默认滑出（新工单处置时效性要求高），其余类型默认静默。
"""
from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint, func

from app.database import Base

# 提醒方式取值
POPUP_MODE_TOAST = "toast"
POPUP_MODE_SILENT = "silent"
POPUP_MODES = (POPUP_MODE_TOAST, POPUP_MODE_SILENT)

# 默认提醒策略：工单默认滑出，其余（公告/告警/执行失败等）默认静默
DEFAULT_POPUP_MODES = {
    "ticket": POPUP_MODE_TOAST,
}
DEFAULT_POPUP_MODE = POPUP_MODE_SILENT


def default_popup_mode(event_type: str) -> str:
    """返回某通知类型的默认提醒方式（未配置偏好时使用）。"""
    return DEFAULT_POPUP_MODES.get(event_type, DEFAULT_POPUP_MODE)


class UserNotificationPref(Base):
    """用户通知提醒偏好：每用户 × 每类型一条。"""

    __tablename__ = "user_notification_prefs"
    __table_args__ = (
        UniqueConstraint("user_id", "event_type", name="uq_user_notif_pref"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)
    # 通知类型：announcement / system_alert / ticket 等（EVENT_TYPES 目录内）
    event_type = Column(String(50), nullable=False)
    # 提醒方式：toast（右侧滑出）/ silent（仅铃铛）
    popup_mode = Column(String(20), nullable=False, default=POPUP_MODE_SILENT)
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    def __repr__(self) -> str:
        return (
            f"<UserNotificationPref id={self.id} user_id={self.user_id} "
            f"event_type={self.event_type!r} popup_mode={self.popup_mode!r}>"
        )
