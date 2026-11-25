"""天擎组件（终端软件）同步 Celery 任务。

由 API 派发，API 先按设备创建 pending 批次，再调用本任务；
任务按设备逐个执行，单设备失败不影响其它设备。
终端软件逐台拉取耗时较长（万级终端），任务时限放宽到 6 小时。
"""
from __future__ import annotations

import logging

from app.core.celery_app import celery_app
from app.core.tianqing_software_sync import sync_device_software
from app.database import SessionLocal
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch

logger = logging.getLogger(__name__)


def _pending_batch(db, device_id: int):
    """取设备最近一个待执行批次（API 派发前已创建）。"""
    return (
        db.query(GovCloudImportBatch)
        .filter(
            GovCloudImportBatch.resource_type == f"tianqing_software:{device_id}",
            GovCloudImportBatch.status.in_(("pending", "running")),
        )
        .order_by(GovCloudImportBatch.id.desc())
        .first()
    )


def _mark_batch_failed(db, batch_id: int, error: str) -> None:
    """把仍在 pending/running 的批次置为失败（兜底任务内部 try 之外的异常）。"""
    try:
        batch = (
            db.query(GovCloudImportBatch)
            .filter(GovCloudImportBatch.id == batch_id)
            .first()
        )
        if batch is None or (batch.status or "") not in ("pending", "running"):
            return
        batch.status = "failed"
        batch.phase = "失败"
        batch.percent = 100
        batch.note = f"组件同步失败: {error}"[:2000]
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("标记天擎组件同步批次失败时出错 batch=%s err=%s", batch_id, exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


@celery_app.task(name="sync_tianqing_software", soft_time_limit=21600, time_limit=22200)
def sync_tianqing_software(
    device_ids: list[int],
    user_id: int = 0,
    mode: str = "full",
    limit: int = 0,
) -> dict:
    """按设备同步天擎终端软件清单。"""
    results: list[dict] = []
    db = SessionLocal()
    try:
        devices = (
            db.query(Device)
            .filter(
                Device.id.in_(device_ids or []),
                Device.auth_type == "tianqing",
                Device.enabled.is_(True),
            )
            .order_by(Device.id)
            .all()
        )
        if not devices:
            logger.warning("天擎组件同步任务未找到可用设备: %s", device_ids)
            return {"results": []}

        for device in devices:
            batch = _pending_batch(db, device.id)
            if batch is None:
                results.append({
                    "device_id": device.id,
                    "device_name": device.name,
                    "status": "skipped",
                    "error": "没有待执行的同步批次",
                })
                continue
            try:
                results.append(
                    sync_device_software(
                        db,
                        device,
                        batch.id,
                        user_id=user_id,
                        mode=mode,
                        limit=limit,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "天擎组件同步失败 device=%s(%d) err=%s", device.name, device.id, exc,
                )
                _mark_batch_failed(db, batch.id, str(exc))
                results.append({
                    "device_id": device.id,
                    "device_name": device.name,
                    "status": "failed",
                    "error": str(exc),
                })
    finally:
        db.close()

    logger.info(
        "天擎组件同步任务完成 results=%s",
        [(r.get("device_id"), r.get("status")) for r in results],
    )
    return {"results": results}
