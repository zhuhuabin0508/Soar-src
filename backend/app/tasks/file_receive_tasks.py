"""跨系统文件接收 Celery 任务：过期清理与监控告警。"""
from __future__ import annotations

import logging
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, or_

from app.config import settings
from app.core.celery_app import celery_app
from app.core.file_receive import service, storage
from app.core.notification_dispatch import dispatch_notification
from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.models.file_receive import (
    FileReceiveAccessLog,
    FileReceiveEvent,
    FileReceiveObject,
    FileReceiveRecord,
)

logger = logging.getLogger(__name__)

_ALERT_LOCK = threading.Lock()
_ALERT_LOCAL: dict[str, float] = {}


def _should_alert(rule: str) -> bool:
    """同一规则 30 分钟内只告警一次；Redis 不可用时降级进程内缓存。"""
    key = f"fr:alert:{rule}"
    try:
        from app.core.redis_client import get_redis

        return bool(get_redis().set(key, "1", nx=True, ex=1800))
    except Exception:  # noqa: BLE001
        now = time.time()
        with _ALERT_LOCK:
            if _ALERT_LOCAL.get(key, 0) > now:
                return False
            _ALERT_LOCAL[key] = now + 1800
            return True


def _cleanup_old_dirs(base: Path, older_than_hours: int) -> int:
    if not base.exists():
        return 0
    cutoff = time.time() - older_than_hours * 3600
    removed = 0
    for child in base.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


@celery_app.task(name="cleanup_file_receive")
def cleanup_file_receive() -> dict:
    """清理过期上传会话、孤儿临时目录、无引用对象与历史访问日志。"""
    db = SessionLocal()
    now = beijing_now()
    result = {
        "expired_sessions": 0,
        "stuck_merging": 0,
        "orphan_dirs": 0,
        "objects": 0,
        "access_logs": 0,
    }
    try:
        expired = (
            db.query(FileReceiveRecord)
            .filter(
                FileReceiveRecord.status.in_(("INIT", "UPLOADING")),
                FileReceiveRecord.expires_at.isnot(None),
                FileReceiveRecord.expires_at < now,
            )
            .limit(500)
            .all()
        )
        for record in expired:
            record.status = "EXPIRED"
            record.error_code = "FR-STATE-001"
            record.error_message = "上传会话超时，已自动过期"
            record.completed_at = now
            record.updated_at = now
            db.add(
                FileReceiveEvent(
                    record_id=record.id,
                    event_type="EXPIRED",
                    status_from="UPLOADING",
                    status_to="EXPIRED",
                    message="上传会话超时，已自动过期",
                    actor="system",
                )
            )
            storage.remove_record_temp(record.id)
            result["expired_sessions"] += 1
        db.commit()

        result["stuck_merging"] = service.recover_stuck_merging(db)

        root = storage.storage_root()
        result["orphan_dirs"] += _cleanup_old_dirs(
            root / "tmp", max(1, int(settings.FILE_RECEIVE_TEMP_RETENTION_HOURS))
        )
        result["orphan_dirs"] += _cleanup_old_dirs(
            root / "staging", max(1, int(settings.FILE_RECEIVE_TEMP_RETENTION_HOURS))
        )

        retention_cutoff = now - timedelta(days=max(1, int(settings.FILE_RECEIVE_RETENTION_DAYS)))
        objects = (
            db.query(FileReceiveObject)
            .filter(
                FileReceiveObject.ref_count <= 0,
                FileReceiveObject.status == "active",
                FileReceiveObject.created_at < retention_cutoff,
            )
            .limit(200)
            .all()
        )
        for obj in objects:
            try:
                path = storage.abs_from_rel(obj.storage_path)
                if path.exists():
                    path.unlink()
            except Exception as exc:  # noqa: BLE001
                logger.warning("清理无引用对象文件失败: %s (%s)", obj.storage_path, exc)
                continue
            db.delete(obj)
            result["objects"] += 1
        db.commit()

        log_cutoff = now - timedelta(days=90)
        result["access_logs"] = (
            db.query(FileReceiveAccessLog)
            .filter(FileReceiveAccessLog.created_at < log_cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        logger.info("文件接收清理完成: %s", result)
        return result
    except Exception:
        db.rollback()
        logger.exception("文件接收清理任务失败")
        raise
    finally:
        db.close()


def _notify(db, level: str, title: str, content: str) -> None:
    dispatch_notification(
        db,
        event_type="file_receive_alert",
        title=f"[文件接收][{level}] {title}",
        content=content,
        related_type="file_receive",
        created_by="system",
    )


def _disk_usage_pct() -> float:
    try:
        return storage.disk_usage_pct()
    except Exception:  # noqa: BLE001
        return 0.0


@celery_app.task(name="scan_file_receive_alerts")
def scan_file_receive_alerts() -> dict:
    """扫描文件接收成功率、磁盘水位、积压与签名异常，按规则派发通知。"""
    db = SessionLocal()
    now = beijing_now()
    since = now - timedelta(minutes=5)
    fired: list[str] = []
    try:
        success = (
            db.query(func.count(FileReceiveRecord.id))
            .filter(
                FileReceiveRecord.received_at >= since,
                FileReceiveRecord.status == "SUCCESS",
                FileReceiveRecord.deleted_at.is_(None),
            )
            .scalar()
            or 0
        )
        failed = (
            db.query(func.count(FileReceiveRecord.id))
            .filter(
                FileReceiveRecord.received_at >= since,
                FileReceiveRecord.status == "FAILED",
                FileReceiveRecord.deleted_at.is_(None),
            )
            .scalar()
            or 0
        )
        # 成功率只统计已产生终态的接收任务，避免在途上传拉低成功率造成误告警
        total = success + failed
        rate = (success / total) if total else 1.0
        disk_pct = _disk_usage_pct()
        pending_merge = (
            db.query(func.count(FileReceiveRecord.id))
            .filter(FileReceiveRecord.status == "MERGING")
            .scalar()
            or 0
        )
        stuck_cutoff = now - timedelta(minutes=10)
        stuck_merge = (
            db.query(func.count(FileReceiveRecord.id))
            .filter(
                FileReceiveRecord.status == "MERGING",
                FileReceiveRecord.updated_at < stuck_cutoff,
            )
            .scalar()
            or 0
        )
        signature_fail = (
            db.query(func.count(FileReceiveAccessLog.id))
            .filter(
                FileReceiveAccessLog.created_at >= since,
                FileReceiveAccessLog.status_code == 401,
                or_(
                    FileReceiveAccessLog.error_code.like("FR-SIGN%"),
                    FileReceiveAccessLog.error_code.like("FR-AUTH%"),
                ),
            )
            .scalar()
            or 0
        )
        write_fail = (
            db.query(func.count(FileReceiveRecord.id))
            .filter(
                FileReceiveRecord.completed_at >= since,
                FileReceiveRecord.error_code.in_(("FR-FILE-002", "FR-STORAGE-001")),
            )
            .scalar()
            or 0
        )

        if total >= 5 and rate < 0.90 and _should_alert("success_rate_critical"):
            _notify(
                db, "P1",
                "文件接收成功率低于 90%",
                f"最近 5 分钟共 {total} 笔，成功 {success} 笔，失败 {failed} 笔，成功率 {rate:.1%}。",
            )
            fired.append("success_rate_critical")
        elif total >= 5 and rate < 0.98 and _should_alert("success_rate_warning"):
            _notify(
                db, "P2",
                "文件接收成功率低于 98%",
                f"最近 5 分钟共 {total} 笔，成功率 {rate:.1%}，请关注失败原因。",
            )
            fired.append("success_rate_warning")

        if disk_pct >= 95 and _should_alert("disk_critical"):
            _notify(
                db, "P1",
                "文件接收存储空间即将耗尽",
                f"存储卷使用率 {disk_pct:.1f}%，已暂停接收新任务，请立即扩容或清理。",
            )
            fired.append("disk_critical")
        elif disk_pct >= 85 and _should_alert("disk_warning"):
            _notify(
                db, "P2",
                "文件接收存储空间偏高",
                f"存储卷使用率 {disk_pct:.1f}%，建议清理过期文件或扩容。",
            )
            fired.append("disk_warning")

        if stuck_merge > 0 and _should_alert("stuck_merge"):
            _notify(
                db, "P1",
                "文件接收合并任务卡住",
                f"有 {stuck_merge} 个任务处于合并中超过 10 分钟，请检查 worker/磁盘 I/O。",
            )
            fired.append("stuck_merge")

        if pending_merge >= 20 and _should_alert("merge_backlog"):
            _notify(
                db, "P2",
                "文件接收合并任务积压",
                f"当前合并中任务 {pending_merge} 个，已触发准入收紧，请检查合并并发与磁盘。",
            )
            fired.append("merge_backlog")

        if signature_fail >= 100 and _should_alert("signature_abuse"):
            _notify(
                db, "P1",
                "文件接收签名失败激增",
                f"最近 5 分钟签名/认证失败 {signature_fail} 次，疑似来源配置错误或攻击。",
            )
            fired.append("signature_abuse")

        if write_fail >= 5 and _should_alert("write_failures"):
            _notify(
                db, "P1",
                "文件接收落盘失败",
                f"最近 5 分钟合并/存储失败 {write_fail} 次，请检查磁盘、权限与文件系统。",
            )
            fired.append("write_failures")

        db.commit()
        return {
            "fired": fired,
            "success_rate": round(rate, 4),
            "total": total,
            "failed": failed,
            "disk_pct": round(disk_pct, 1),
            "pending_merge": pending_merge,
            "stuck_merge": stuck_merge,
            "signature_fail": signature_fail,
            "write_fail": write_fail,
        }
    except Exception:
        db.rollback()
        logger.exception("文件接收告警扫描失败")
        raise
    finally:
        db.close()
