"""运营通知辅助：按通知规则路由写站内通知（通知中心可见、可配置）。"""
import logging

from sqlalchemy.orm import Session

from app.core.notification_dispatch import dispatch_notification

logger = logging.getLogger(__name__)


def notify_ops(db: Session, title: str, content: str, *, ntype: str = "workflow") -> None:
    """按通知规则路由发送运营通知，失败不影响主流程。

    - 事件类型默认 workflow（工作流运营通知），封禁工作流告警类调用方传 workflow_alert
    - 走 dispatch_notification：匹配启用的通知规则则定向投递，无匹配规则回退全员广播
    """
    try:
        dispatch_notification(
            db,
            event_type=ntype,
            title=title,
            content=content,
            created_by="system",
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("运营通知写入失败: %s", title)
