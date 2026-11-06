"""工单暂停到期提醒与自动处置扫描。

由 Celery beat 每 5 分钟触发（见 ``celery_app.py`` 的 ``scan-ticket-pauses``）：

1. 到期前提醒：按暂停策略的 ``remind_percents``（默认 50% / 80%）与
   ``remind_before_expire_minutes`` 分阶段提醒，``remind_stage`` 保证幂等；
2. 到期处置：按 ``timeout_policy`` 执行自动恢复 / 恢复并升级 / 恢复并转办 /
   恢复并自动取消；
3. 每个暂停记录独立事务，单条失败不影响其余；恢复失败（脏数据）升级管理员。

暂停中的工单不参与节点停留超时提醒（``scan_ticket_timeouts`` 仅处理 processing）。
"""
import logging
from datetime import timedelta

from app.core.celery_app import celery_app
from app.core.timezone import beijing_now
from app.database import SessionLocal

logger = logging.getLogger(__name__)

# 默认提醒阈值（百分比），可被暂停策略快照覆盖
DEFAULT_REMIND_PERCENTS = (50, 80)
DEFAULT_REMIND_BEFORE_EXPIRE_MINUTES = 240
# remind_stage 负值表示"到期自动处置失败已升级"，用于阻止下一轮重复升级
FAILED_STAGE = -1


def _system_actor(db):
    """系统自动处置使用的操作人：优先取启用中的管理员账号。"""
    from app.models.user import User

    row = (
        db.query(User.id, User.username)
        .filter(User.role == "admin", User.is_active.is_(True))
        .order_by(User.id.asc())
        .first()
    )
    if row:
        return int(row[0]), "系统自动处置"
    return 0, "系统自动处置"


def _group_ids(ticket) -> set[int]:
    raw = ticket.current_group_ids or ""
    ids = {int(part) for part in raw.split(",") if part.strip().isdigit()}
    if not ids and ticket.current_group_id:
        ids.add(ticket.current_group_id)
    return ids


def _recipients(db, ticket, pause, *, include_admins: bool = False) -> list[int]:
    """提醒对象：暂停人 + 认领人 + 当前分组成员；用户反馈类补充发起人。"""
    from app.models.ticket import TicketGroupMember
    from app.models.user import User

    ids: set[int] = set()
    if pause.paused_by_id:
        ids.add(pause.paused_by_id)
    if ticket.claimed_by_id:
        ids.add(ticket.claimed_by_id)
    if ticket.created_by_id and pause.pause_type == "user_feedback":
        ids.add(ticket.created_by_id)
    group_ids = _group_ids(ticket)
    if group_ids:
        for (uid,) in db.query(TicketGroupMember.user_id).filter(
            TicketGroupMember.group_id.in_(group_ids)
        ):
            ids.add(uid)
    if include_admins:
        for (uid,) in db.query(User.id).filter(
            User.role == "admin", User.is_active.is_(True)
        ):
            ids.add(uid)
    return sorted(uid for uid in ids if uid)


def _notify(db, ticket, user_ids: list[int], title: str, content: str) -> None:
    from app.models.notification import Notification

    for uid in user_ids:
        db.add(Notification(
            user_id=uid,
            type="system_alert",
            title=title,
            content=content,
            related_type="ticket",
            related_id=ticket.id,
            created_by="system",
        ))


def _add_record(db, ticket, pause, action: str, field_values: dict, comment: str) -> None:
    from app.models.ticket import TicketNodeRecord

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id,
        handler_id=0,
        handler_name="系统自动处置",
        action=action,
        field_values=field_values,
        comment=comment,
    ))


def _remind_stage(pause, now, remind_before_minutes: int) -> int:
    """计算当前应处提醒阶段：0=未到，1/2=百分比阈值，末位=到期前提醒。"""
    percent_stages = list((pause.policy_snapshot or {}).get("remind_percents") or DEFAULT_REMIND_PERCENTS)
    percent_stages = sorted(
        int(p) for p in percent_stages
        if isinstance(p, (int, float)) and not isinstance(p, bool) and 0 < int(p) < 100
    ) or list(DEFAULT_REMIND_PERCENTS)
    total_seconds = max(1, int((pause.expire_at - pause.paused_at).total_seconds()))
    elapsed_seconds = max(0, int((now - pause.paused_at).total_seconds()))
    percent = elapsed_seconds * 100 / total_seconds

    stage = 0
    for idx, threshold in enumerate(percent_stages, start=1):
        if percent >= threshold:
            stage = idx
    final_stage = len(percent_stages) + 1
    if now < pause.expire_at and (pause.expire_at - now) <= timedelta(minutes=remind_before_minutes):
        stage = max(stage, final_stage)
    return stage


def _fallback_group(db, config) -> int | None:
    from app.models.ticket import TicketGroup

    gid = config.get("fallback_group_id")
    if not isinstance(gid, int) or isinstance(gid, bool):
        return None
    group = db.query(TicketGroup).filter(
        TicketGroup.id == gid, TicketGroup.enabled.is_(True)
    ).first()
    return gid if group else None


def _resume_ticket(db, ticket, pause, *, policy: str, remark: str):
    """系统身份恢复暂停，返回恢复记录。"""
    from app.core.ticket_pause import resume_pause

    actor_id, actor_name = _system_actor(db)
    if not actor_id:
        # 找不到管理员时退化为暂停人身份，保证恢复仍可执行
        actor_id = pause.paused_by_id or 0
    return resume_pause(
        db, ticket,
        user_id=actor_id,
        user_name=actor_name,
        my_group_ids=set(),
        is_admin_user=True,
        comment=remark,
        force=True,
        resume_mode="timeout",
    )


def _escalate(db, ticket, pause, reason: str) -> None:
    from app.models.user import User

    admin_ids = [
        uid for (uid,) in db.query(User.id).filter(
            User.role == "admin", User.is_active.is_(True)
        )
    ]
    if not admin_ids:
        logger.warning("工单暂停超期但未找到管理员: ticket=%s pause=%s", ticket.id, pause.id)
        return
    _notify(
        db, ticket, sorted(set(admin_ids)),
        title=f"工单暂停超期需介入：{ticket.ticket_no}",
        content=(
            f"工单「{ticket.title}」的暂停已到期，自动处置未完成：{reason}。"
            f"暂停类型：{pause.pause_type}，暂停人：{pause.paused_by_name}，请及时介入。"
        ),
    )
    _add_record(
        db, ticket, pause, "pause_expire",
        {"result": "escalated", "reason": reason},
        f"暂停超期，已升级管理员：{reason}",
    )


def _apply_timeout_policy(db, ticket, pause, config) -> str:
    """执行到期策略，返回处置结果标识。"""
    policy = (pause.policy_snapshot or {}).get("timeout_policy") or "auto_resume"
    auto_close = bool((pause.policy_snapshot or {}).get("auto_close"))

    try:
        if policy == "auto_close" and pause.pause_type == "duplicate_merge" and auto_close:
            _resume_ticket(db, ticket, pause, policy=policy, remark="暂停超时，系统自动取消重复工单")
            ticket.status = "cancelled"
            ticket.closed_at = beijing_now()
            _add_record(
                db, ticket, pause, "cancel",
                {"result": "auto_close"},
                "暂停超时且未确认主单，系统自动取消重复工单",
            )
            _notify(
                db, ticket, _recipients(db, ticket, pause, include_admins=True),
                title=f"工单已自动取消：{ticket.ticket_no}",
                content=f"重复工单「{ticket.title}」暂停超时且未确认主单，系统已自动取消。",
            )
            return "auto_close"

        if policy == "auto_transfer":
            group_id = _fallback_group(db, config)
            parallel = len(_group_ids(ticket)) > 1
            if group_id and not parallel:
                _resume_ticket(db, ticket, pause, policy=policy, remark="暂停超时，系统自动转办")
                ticket.current_group_id = group_id
                ticket.current_group_ids = f",{group_id},"
                ticket.claimed_by_id = None
                ticket.arrived_at = beijing_now()
                ticket.first_reminded_at = None
                ticket.last_reminded_at = None
                ticket.remind_count = 0
                _add_record(
                    db, ticket, pause, "transfer",
                    {"result": "auto_transfer", "group_id": group_id},
                    "暂停超时，系统自动转办至兜底分组",
                )
                _notify(
                    db, ticket, _recipients(db, ticket, pause, include_admins=True),
                    title=f"工单已自动转办：{ticket.ticket_no}",
                    content=f"工单「{ticket.title}」暂停超时，已自动转办至兜底分组，请继续处理。",
                )
                return "auto_transfer"
            # 兜底分组缺失或并行会签节点：降级为恢复并升级
            _resume_ticket(db, ticket, pause, policy=policy, remark="暂停超时，系统自动恢复（转办降级）")
            _escalate(db, ticket, pause, "未配置有效兜底分组或当前为并行会签节点，已降级为自动恢复")
            return "auto_resume_escalate"

        if policy == "auto_resume_escalate":
            _resume_ticket(db, ticket, pause, policy=policy, remark="暂停超时，系统自动恢复")
            _escalate(db, ticket, pause, "暂停已到期，已自动恢复")
            return "auto_resume_escalate"

        # 默认：自动恢复
        _resume_ticket(db, ticket, pause, policy=policy, remark="暂停超时，系统自动恢复")
        _notify(
            db, ticket, _recipients(db, ticket, pause),
            title=f"工单已自动恢复：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」的暂停已到期，系统已自动恢复，"
                f"当前节点：{ticket.current_node_name or '--'}，请继续处理。"
            ),
        )
        return "auto_resume"
    except Exception:  # noqa: BLE001
        logger.exception("工单暂停到期处置失败: ticket=%s pause=%s policy=%s", ticket.id, pause.id, policy)
        # 恢复失败时保持 paused 并升级管理员（事务由外层 rollback 后重试）
        raise


@celery_app.task(name="scan_ticket_pauses")
def scan_ticket_pauses() -> dict:
    """扫描活动暂停：到期提醒 + 到期自动处置。"""
    from app.core.ticket_pause import get_pause_config
    from app.models.ticket import Ticket, TicketPause

    db = SessionLocal()
    stats = {"scanned": 0, "reminded": 0, "resumed": 0, "escalated": 0, "failed": 0}
    try:
        now = beijing_now()
        config = get_pause_config(db)
        remind_before = int(config.get("remind_before_expire_minutes") or DEFAULT_REMIND_BEFORE_EXPIRE_MINUTES)
        pause_ids = [
            pid for (pid,) in db.query(TicketPause.id)
            .filter(TicketPause.status == "active")
            .order_by(TicketPause.id.asc())
            .all()
        ]
        for pause_id in pause_ids:
            try:
                # 行锁 + skip_locked：多实例/重叠扫描时同一暂停只被一个 worker 处理
                pause = (
                    db.query(TicketPause)
                    .filter(TicketPause.id == pause_id)
                    .with_for_update(skip_locked=True)
                    .first()
                )
                if not pause or pause.status != "active":
                    db.rollback()
                    continue
                if int(pause.remind_stage or 0) < 0:
                    # 已升级过管理员，避免每轮重复通知与追加时间线
                    db.rollback()
                    continue
                ticket = (
                    db.query(Ticket)
                    .filter(Ticket.id == pause.ticket_id)
                    .with_for_update()
                    .first()
                )
                stats["scanned"] += 1
                if not ticket or ticket.status != "paused":
                    # 暂停记录与工单状态不一致：关闭脏记录，避免无限扫描
                    pause.status = "cancelled"
                    pause.active_key = None
                    db.commit()
                    logger.warning("关闭失配的暂停记录: pause=%s ticket=%s", pause.id, pause.ticket_id)
                    continue

                if now < pause.expire_at:
                    stage = _remind_stage(pause, now, remind_before)
                    if stage > int(pause.remind_stage or 0):
                        label = (pause.policy_snapshot or {}).get("label") or pause.pause_type
                        _notify(
                            db, ticket, _recipients(db, ticket, pause),
                            title=f"工单暂停即将到期：{ticket.ticket_no}",
                            content=(
                                f"工单「{ticket.title}」暂停（{label}）将于 "
                                f"{pause.expire_at.strftime('%Y-%m-%d %H:%M')} 到期，"
                                f"请及时补充信息或恢复工单。"
                            ),
                        )
                        _add_record(
                            db, ticket, pause, "pause_remind",
                            {"stage": stage, "expire_at": pause.expire_at.isoformat()},
                            f"暂停到期提醒（第 {stage} 阶段）",
                        )
                        pause.remind_stage = stage
                        pause.last_reminded_at = now
                        stats["reminded"] += 1
                        db.commit()
                    continue

                # 已到期：执行策略
                result = _apply_timeout_policy(db, ticket, pause, config)
                pause.status = "expired"
                pause.resumed_at = pause.resumed_at or now
                pause.duration_minutes = max(
                    0, int((now - (pause.paused_at or now)).total_seconds() // 60)
                )
                db.commit()
                stats["resumed"] += 1
                if result in ("auto_resume_escalate", "auto_transfer"):
                    stats["escalated"] += 1
                logger.info(
                    "暂停到期处置: ticket=%s pause=%s result=%s", ticket.id, pause.id, result
                )
            except Exception:  # noqa: BLE001
                db.rollback()
                stats["failed"] += 1
                logger.exception("暂停扫描处理失败: pause=%s", pause_id)
                # 单条失败后尝试升级管理员（独立事务）
                try:
                    pause = db.query(TicketPause).filter(TicketPause.id == pause_id).first()
                    ticket = db.query(Ticket).filter(Ticket.id == pause.ticket_id).first() if pause else None
                    if ticket and pause and pause.status == "active" and now >= pause.expire_at:
                        _escalate(db, ticket, pause, "自动处置执行失败，请人工恢复")
                        pause.remind_stage = FAILED_STAGE
                        db.commit()
                        stats["escalated"] += 1
                except Exception:  # noqa: BLE001
                    db.rollback()
                    logger.exception("暂停失败升级管理员也失败: pause=%s", pause_id)
        return stats
    finally:
        db.close()


__all__ = ["scan_ticket_pauses"]
