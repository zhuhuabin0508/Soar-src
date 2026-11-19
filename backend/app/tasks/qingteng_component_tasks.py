"""青藤组件同步 Celery 任务。

由 API ``POST /govcloud/qingteng/component-sync`` 派发：
- API 先按设备创建 pending 批次，再调用本任务；
- 任务按设备逐个执行，单设备失败不影响其它设备；
- 本期不注册 beat，后续可直接在 ``celery_app.beat_schedule`` 挂定时。

手动补跑示例：
    sync_qingteng_components.delay([7, 10], user_id=1, mode="full")
"""
from __future__ import annotations

import logging

from app.core.celery_app import celery_app
from app.core.qingteng_component_sync import sync_device_components
from app.database import SessionLocal
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch

logger = logging.getLogger(__name__)


def _pending_batch(db, device_id: int):
    """取设备最近一个待执行批次（API 派发前已创建）。"""
    return (
        db.query(GovCloudImportBatch)
        .filter(
            GovCloudImportBatch.resource_type == f"qingteng_component:{device_id}",
            GovCloudImportBatch.status.in_(("pending", "running")),
        )
        .order_by(GovCloudImportBatch.id.desc())
        .first()
    )


@celery_app.task(name="sync_qingteng_components", soft_time_limit=3600, time_limit=3900)
def sync_qingteng_components(
    device_ids: list[int],
    user_id: int = 0,
    mode: str = "full",
    sources: list[str] | None = None,
) -> dict:
    """按设备同步青藤组件清单。"""
    results: list[dict] = []
    db = SessionLocal()
    try:
        devices = (
            db.query(Device)
            .filter(
                Device.id.in_(device_ids or []),
                Device.auth_type == "qingteng",
                Device.enabled.is_(True),
            )
            .order_by(Device.id)
            .all()
        )
        if not devices:
            logger.warning("青藤组件同步任务未找到可用设备: %s", device_ids)
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
                    sync_device_components(
                        db,
                        device,
                        batch.id,
                        user_id=user_id,
                        mode=mode,
                        sources=sources,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "青藤组件同步失败 device=%s(%d) err=%s", device.name, device.id, exc,
                )
                results.append({
                    "device_id": device.id,
                    "device_name": device.name,
                    "status": "failed",
                    "error": str(exc),
                })
    finally:
        db.close()

    logger.info(
        "青藤组件同步任务完成 results=%s",
        [(r.get("device_id"), r.get("status")) for r in results],
    )
    return {"results": results}
