"""椒图云锁资产同步 Celery 任务：主机清单 + 资产明细。

由 API 派发，API 先按设备创建两个 pending 批次（jiaotu_host / jiaotu_asset），
再调用本任务；任务按设备逐个执行，单设备失败不影响其它设备。
逐主机拉取详情耗时较长，任务时限放宽到 3 小时。
"""
from __future__ import annotations

import logging

from app.core.celery_app import celery_app
from app.core.jiaotu_asset_sync import sync_device_assets
from app.database import SessionLocal
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch

logger = logging.getLogger(__name__)


def _pending_batch(db, device_id: int, base: str):
    """取设备最近一个待执行批次（API 派发前已创建）。"""
    return (
        db.query(GovCloudImportBatch)
        .filter(
            GovCloudImportBatch.resource_type == f"{base}:{device_id}",
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
        batch.note = f"椒图资产同步失败: {error}"[:2000]
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("标记椒图同步批次失败时出错 batch=%s err=%s", batch_id, exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


@celery_app.task(name="sync_jiaotu_assets", soft_time_limit=10800, time_limit=11400)
def sync_jiaotu_assets(
    device_ids: list[int],
    user_id: int = 0,
    mode: str = "full",
    limit: int = 0,
) -> dict:
    """按设备同步椒图主机清单与资产明细。"""
    results: list[dict] = []
    db = SessionLocal()
    try:
        devices = (
            db.query(Device)
            .filter(
                Device.id.in_(device_ids or []),
                Device.auth_type == "jiaotu",
                Device.enabled.is_(True),
            )
            .order_by(Device.id)
            .all()
        )
        if not devices:
            logger.warning("椒图资产同步任务未找到可用设备: %s", device_ids)
            return {"results": []}

        for device in devices:
            host_batch = _pending_batch(db, device.id, "jiaotu_host")
            asset_batch = _pending_batch(db, device.id, "jiaotu_asset")
            if host_batch is None or asset_batch is None:
                results.append({
                    "device_id": device.id,
                    "device_name": device.name,
                    "status": "skipped",
                    "error": "没有待执行的同步批次",
                })
                continue
            try:
                results.append(
                    sync_device_assets(
                        db,
                        device,
                        host_batch.id,
                        asset_batch.id,
                        user_id=user_id,
                        mode=mode,
                        limit=limit,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "椒图资产同步失败 device=%s(%d) err=%s", device.name, device.id, exc,
                )
                _mark_batch_failed(db, host_batch.id, str(exc))
                _mark_batch_failed(db, asset_batch.id, str(exc))
                results.append({
                    "device_id": device.id,
                    "device_name": device.name,
                    "status": "failed",
                    "error": str(exc),
                })
    finally:
        db.close()

    logger.info(
        "椒图资产同步任务完成 results=%s",
        [(r.get("device_id"), r.get("asset_status") or r.get("status")) for r in results],
    )
    return {"results": results}
