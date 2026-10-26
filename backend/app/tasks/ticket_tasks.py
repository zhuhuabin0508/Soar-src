"""工单节点停留超时扫描任务（阶段2）。

由 Celery beat 每 5 分钟触发一次（见 celery_app.py 的 beat_schedule）：
- 遍历所有进行中工单，判断当前节点是否停留超时并推送提醒
- 超时配置（timeout_minutes / remind_interval_minutes）优先取流程模板
  「最新已发布版」——超时提醒属于运营催促参数，模板修改发布后对
  存量进行中工单立即生效（业务流程结构仍用工单发起时的快照）；
  模板为草稿/被删/节点已被移除时回退工单快照
- 超时 → 精确投递给当前处理分组成员（不走通知规则路由，不广播）
- 重复提醒：节点 ``remind_interval_minutes`` > 0 时，超时期间每 N 分钟重复提醒；
  未配置或 0 则仅首次提醒
- 幂等与重置：first/last_reminded_at 与 remind_count 记录提醒进度；
  发起/流转时由 tickets.py 重置 arrived_at 与提醒进度

每个工单独立提交，单个工单提醒失败不影响其余扫描。
"""
import logging
from typing import Optional

from app.core.celery_app import celery_app
from app.core.timezone import beijing_now
from app.database import SessionLocal

logger = logging.getLogger(__name__)


def _node_timeout_config(snapshot, node_key: Optional[str]) -> tuple[Optional[int], int, bool]:
    """从流程结构（模板或快照）取当前节点的超时配置。

    Returns:
        (timeout_minutes, remind_interval_minutes, node_found)；
        节点未配置超时或值非法时 timeout_minutes 为 None（node_found=True 区别于节点不存在）。
    """
    if not node_key or not isinstance(snapshot, dict):
        return None, 0, False
    for n in snapshot.get("nodes") or []:
        if not isinstance(n, dict) or n.get("key") != node_key:
            continue
        if n.get("type") == "end":
            return None, 0, True
        tm = n.get("timeout_minutes")
        if isinstance(tm, bool) or not isinstance(tm, (int, float)) or tm <= 0:
            return None, 0, True
        rim = n.get("remind_interval_minutes")
        if isinstance(rim, bool) or not isinstance(rim, (int, float)) or rim < 0:
            rim = 0
        return int(tm), int(rim), True
    return None, 0, False


@celery_app.task(name="scan_ticket_timeouts")
def scan_ticket_timeouts() -> dict:
    """扫描进行中工单的节点停留超时并推送提醒。"""
    from app.models.notification import Notification
    from app.models.ticket import Ticket, TicketFlow, TicketGroup, TicketGroupMember

    db = SessionLocal()
    try:
        now = beijing_now()
        tickets = (
            db.query(Ticket)
            .filter(Ticket.status == "processing")
            .order_by(Ticket.id.asc())
            .all()
        )
        # 批量取涉及的流程模板当前内容：超时提醒参数跟随最新已发布版
        # （草稿不引用，与发起工单的语义一致），缺失时回退工单快照
        flow_ids = {t.flow_id for t in tickets if t.flow_id}
        flows_latest: dict[int, tuple[bool, dict]] = {}
        if flow_ids:
            for f in db.query(TicketFlow).filter(TicketFlow.id.in_(flow_ids)).all():
                flows_latest[f.id] = (bool(f.is_draft), f.nodes or {})
        scanned = reminded = 0
        for ticket in tickets:
            scanned += 1
            try:
                timeout_min = None
                interval_min = 0
                use_snapshot = True
                latest = flows_latest.get(ticket.flow_id)
                if latest is not None and not latest[0]:
                    tm, rim, found = _node_timeout_config(
                        latest[1], ticket.current_node_key
                    )
                    if found:
                        # 模板已发布且节点仍在：以模板为准
                        # （含显式未配置超时=不提醒，不回退快照）
                        timeout_min, interval_min = tm, rim
                        use_snapshot = False
                if use_snapshot:
                    # 模板草稿/被删/节点已被移除：回退发起时快照
                    timeout_min, interval_min, _ = _node_timeout_config(
                        ticket.flow_snapshot, ticket.current_node_key
                    )
                if not timeout_min or not ticket.arrived_at:
                    continue
                stay_minutes = (now - ticket.arrived_at).total_seconds() / 60
                if stay_minutes < timeout_min:
                    continue

                # 是否到达提醒时机：首次超时必提醒；此后按重复间隔（0 = 仅首次）
                if ticket.last_reminded_at is None:
                    due = True
                elif interval_min > 0:
                    due = (now - ticket.last_reminded_at).total_seconds() / 60 >= interval_min
                else:
                    due = False
                if not due:
                    continue

                # 待处理分组：并行会签=全部待签分组（CSV），旧数据回退 current_group_id
                raw_ids = getattr(ticket, "current_group_ids", None)
                if raw_ids:
                    gids = [int(x) for x in str(raw_ids).split(",") if x.strip().isdigit()]
                elif ticket.current_group_id:
                    gids = [ticket.current_group_id]
                else:
                    gids = []
                group_labels: list[str] = []
                user_ids: set[int] = set()
                for gid in gids:
                    group = (
                        db.query(TicketGroup)
                        .filter(TicketGroup.id == gid)
                        .first()
                    )
                    group_labels.append(group.name if group else f"分组{gid}")
                    rows = (
                        db.query(TicketGroupMember.user_id)
                        .filter(TicketGroupMember.group_id == gid)
                        .all()
                    )
                    user_ids |= {uid for (uid,) in rows if uid}
                group_label = "、".join(group_labels) or (
                    "无分组" if ticket.current_group_id is None else f"分组{ticket.current_group_id}"
                )
                # 精确投递给当前处理分组成员（不走通知规则路由，
                # 避免未配置规则时回退全员广播打扰无关人员）
                if not user_ids:
                    logger.warning(
                        "工单超时提醒无收件人（分组无成员）: id=%s group=%s",
                        ticket.id, ticket.current_group_id,
                    )
                    continue
                content = (
                    f"工单「{ticket.title}」在节点「{ticket.current_node_name}」"
                    f"已停留 {int(stay_minutes)} 分钟，超过 {timeout_min} 分钟阈值，"
                    f"请【{group_label}】尽快跟进处理"
                )
                for uid in sorted(user_ids):
                    db.add(Notification(
                        user_id=uid,
                        type="ticket",
                        title=f"工单超时提醒：{ticket.ticket_no}",
                        content=content,
                        related_type="ticket",
                        related_id=ticket.id,
                        created_by="system",
                    ))
                ticket.first_reminded_at = ticket.first_reminded_at or now
                ticket.last_reminded_at = now
                ticket.remind_count = (ticket.remind_count or 0) + 1
                db.commit()
                reminded += 1
                logger.info(
                    "工单超时提醒: id=%s no=%s node=%s stay=%.0fmin remind_count=%s",
                    ticket.id, ticket.ticket_no, ticket.current_node_key,
                    stay_minutes, ticket.remind_count,
                )
            except Exception:  # noqa: BLE001
                db.rollback()
                logger.exception("工单超时提醒失败: id=%s", ticket.id)
        if scanned:
            logger.info("工单超时扫描完成: scanned=%d reminded=%d", scanned, reminded)
        return {"scanned": scanned, "reminded": reminded}
    finally:
        db.close()
