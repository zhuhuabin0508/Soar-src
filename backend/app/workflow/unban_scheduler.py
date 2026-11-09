"""到期解封与审批超时定时任务（后台线程，每分钟扫描）。

- 解封：ban_records 中 status=active 且 expire_time 已过 → expired，
  同步 legacy banned_ips，写审计
- 审批超时：approval_tickets 中 status=pending 且 deadline 已过 → timeout（默认驳回），
  实例恢复执行（进持续监控节点）并通知运营
"""
import json
import logging
import threading
from typing import Any

from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.models.banned_ip import BannedIP
from app.models.workflow_ban import ApprovalTicket, BanRecord, WorkflowInstance
from app.workflow.audit import write_audit
from app.workflow.notify import notify_ops

logger = logging.getLogger(__name__)

_SCAN_INTERVAL_SECONDS = 60


def _unban_device_best_effort(db, record: BanRecord) -> tuple[str, bool]:
    """到期解封时联动设备解封（best-effort，失败只告警不影响平台解封）。

    仅处理「导入封禁 / 手动封禁 / 工单同步」且已记录封堵设备的记录
    （本平台真实下发过；工单封禁同步自联动安博通下发后，设备下发成功才落生效中
    记录并记录实际设备名），自动/审批记录只落平台数据，不对设备发无效解封请求。

    Returns:
        ``(device_name, unblocked)``；未联动设备时返回 ``("", False)``。
    """
    if not (record.ban_device or "").strip():
        return "", False
    if (record.ban_source or "") not in ("import", "manual", "ticket"):
        return "", False
    from app.devices import ban_target

    try:
        device, action, err = ban_target.resolve_unblock_device(db, record.ban_device)
        if err or device is None or action is None:
            logger.warning(
                "到期解封跳过设备联动（记录 #%s, ip=%s）: %s", record.id, record.ip, err,
            )
            return "", False
        result = ban_target.run_unblock(
            db, device, action, ip=record.ip, source="unban_scheduler",
        )
        ok, err = ban_target.check_unblock_result(result)
        if not ok:
            logger.warning(
                "到期解封设备下发失败（记录 #%s, ip=%s, device=%s）: %s",
                record.id, record.ip, device.name, err,
            )
            return "", False
        return device.name, True
    except Exception:  # noqa: BLE001
        logger.exception("到期解封设备联动异常（记录 #%s, ip=%s）", record.id, record.ip)
        return "", False


def scan_expired_bans() -> int:
    """扫描到期封禁记录并自动解封，返回处理条数。

    已真实下发设备的记录先 best-effort 联动设备解封，避免设备侧黑名单残留
    （永久条目不会到期，但定时/有限时长条目到期后必须清理设备侧条目）。
    """
    db = SessionLocal()
    try:
        now = beijing_now()
        rows = (
            db.query(BanRecord)
            .filter(BanRecord.status == "active", BanRecord.expire_time.isnot(None), BanRecord.expire_time <= now)
            .all()
        )
        for record in rows:
            device_name, unblocked = _unban_device_best_effort(db, record)
            record.status = "expired"
            record.unban_reason = "封禁到期自动解封"
            record.unban_operator = "system"
            record.unban_time = now
            # 同步 legacy 工作台
            legacy = db.query(BannedIP).filter(BannedIP.ip == record.ip).first()
            if legacy is not None:
                legacy.status = "expired"
            write_audit(
                db, action="unban", resource_type="ban_record", resource_id=record.id,
                detail={
                    "ip": record.ip, "reason": "封禁到期自动解封", "auto": True,
                    "device": device_name, "device_unblocked": unblocked,
                },
            )
            notify_ops(db, f"IP {record.ip} 封禁到期已自动解封", f"封禁记录 #{record.id} 到期自动解封（原因：封禁时长结束）。")
        if rows:
            db.commit()
            logger.info("到期自动解封: %d 条", len(rows))
        return len(rows)
    finally:
        db.close()


def scan_approval_timeout() -> int:
    """扫描超时审批工单：默认驳回 → 实例恢复执行（持续监控）并通知运营。"""
    from app.workflow.engine import run_instance

    db = SessionLocal()
    try:
        now = beijing_now()
        tickets = (
            db.query(ApprovalTicket)
            .filter(ApprovalTicket.status == "pending", ApprovalTicket.deadline.isnot(None), ApprovalTicket.deadline <= now)
            .all()
        )
        resumed = 0
        for ticket in tickets:
            ticket.status = "timeout"
            ticket.approver = "system"
            ticket.approval_comment = "超过 24 小时未处理，默认驳回转持续监控"
            ticket.approved_at = now
            # 待审批封禁记录取消
            db.query(BanRecord).filter(
                BanRecord.source_instance_id == ticket.workflow_instance_id,
                BanRecord.status == "pending_approval",
            ).update({"status": "cancelled"})
            write_audit(
                db, action="approval", resource_type="approval_ticket", resource_id=ticket.id,
                detail={"result": "timeout", "ip": ticket.ip, "auto": True},
            )
            notify_ops(
                db, f"封禁审批超时自动驳回: {ticket.ip}",
                f"审批工单 #{ticket.id}（IP {ticket.ip}）超过 24 小时未处理，已默认驳回，实例转持续监控。",
                ntype="workflow_alert",
            )
            db.commit()

            # 恢复实例执行（approval_result → monitor_log）
            instance = db.query(WorkflowInstance).filter(
                WorkflowInstance.id == ticket.workflow_instance_id,
            ).first()
            if instance is not None and instance.status == "waiting_approval":
                run_instance(instance.id, start_key="approval_result")
                resumed += 1
        if tickets:
            logger.info("审批超时处理: %d 单，恢复实例 %d 个", len(tickets), resumed)
        return len(tickets)
    finally:
        db.close()


def _scheduler_loop() -> None:
    import time
    while True:
        try:
            scan_expired_bans()
        except Exception:  # noqa: BLE001
            logger.exception("到期解封扫描失败")
        try:
            scan_approval_timeout()
        except Exception:  # noqa: BLE001
            logger.exception("审批超时扫描失败")
        time.sleep(_SCAN_INTERVAL_SECONDS)


_started = False
_lock = threading.Lock()


def start_unban_scheduler() -> None:
    """启动定时任务线程（幂等，main lifespan 调用）。"""
    global _started
    with _lock:
        if _started:
            return
        _started = True
        threading.Thread(target=_scheduler_loop, name="ban-unban-scheduler", daemon=True).start()
        logger.info("到期解封/审批超时调度器已启动")
