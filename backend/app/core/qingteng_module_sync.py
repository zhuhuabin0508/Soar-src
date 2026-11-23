"""青藤资产明细同步：系统账号 / 用户组 / Web 应用 / Web 站点。

与组件同步（``qingteng_component_sync``）共用底层能力：
- 登录 ``_qingteng_login``、GET 签名 ``_qingteng_signheaders``、分页 ``iter_paged_rows``；
- 分页 500/页、1000 行分块 upsert、单模块行数上限、full 只清理成功模块。

数据落 ``qingteng_asset_items``：公共字段提升为列，模块差异字段进 ``payload``。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.qingteng_component_sync import (
    UPSERT_CHUNK,
    _norm_text,
    _norm_version,
    _to_int,
    build_source_id,
    iter_paged_rows,
)
from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import _qingteng_login, record_device_call
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.qingteng_asset_item import (
    ASSET_MODULE_LABELS,
    ASSET_MODULES,
    QINGTENG_ASSET_UPDATE_COLS,
    QingtengAssetItem,
)

logger = logging.getLogger(__name__)

# 单模块行数上限（触顶保留旧数据）
MAX_ROWS_PER_MODULE = {
    "account": 300_000,
    "accountgroup": 100_000,
    "webapp": 300_000,
    "website": 300_000,
}

# 模块 → 接口与字段口径
ASSET_MODULE_SPECS: dict[str, dict[str, Any]] = {
    "account": {
        "path": "/external/api/assets/account/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": (),
        "path_field": "home",
        "status_field": "status",
        "port_field": None,
    },
    "accountgroup": {
        "path": "/external/api/assets/accountgroup/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": (),
        "path_field": "",
        "status_field": "",
        "port_field": None,
    },
    "webapp": {
        "path": "/external/api/assets/webapp/{os}",
        "os_types": ("linux", "win"),
        "name_field": "appName",
        "version_fields": ("version",),
        "path_field": "webRoot",
        "status_field": "",
        "port_field": None,
    },
    "website": {
        "path": "/external/api/assets/website/{os}",
        "os_types": ("linux", "win"),
        # 站点接口没有名称字段，用 proto:port 合成
        "name_field": "",
        "version_fields": (),
        "path_field": "rootPath",
        "status_field": "type",
        "port_field": "port",
    },
}

# 主机上下文字段（不进入 payload）
_HOST_KEYS = frozenset({
    "agentId", "hostname", "displayIp", "internalIp", "externalIp", "connectionIp",
    "proxyIp", "bizGroupId", "bizGroup", "remark", "hostTagList", "hostTags",
    "whiteRuleEffect", "updatedTime",
})
_SKIP_PAYLOAD_KEYS = frozenset({"processes"})


def _module_name(row: dict, spec: dict) -> str:
    """取模块名称；Web 站点用 proto:port 合成。"""
    field = spec.get("name_field") or ""
    if field:
        return str(row.get(field) or "").strip()
    proto = str(row.get("proto") or "").strip()
    port = _to_int(row.get("port"))
    if port is not None:
        return f"{proto}:{port}" if proto else f"port:{port}"
    return str(row.get("type") or row.get("rootPath") or "").strip()


def _pick_version(row: dict, spec: dict) -> tuple[str, str]:
    for field in spec.get("version_fields") or ():
        raw = str(row.get(field) or "").strip()
        norm = _norm_version(raw)
        if norm:
            return raw, norm
    return "", ""


def _row_to_values(
    device: Device,
    row: dict,
    module: str,
    os_type: str,
    batch_id: int,
    now,
) -> Optional[dict]:
    """青藤模块 row → 入库 values；缺 agentId / 名称返回 None。"""
    spec = ASSET_MODULE_SPECS[module]
    agent_id = str(row.get("agentId") or "").strip()
    name = _module_name(row, spec)
    if not agent_id or not name:
        return None

    name_norm = _norm_text(name)
    version, version_norm = _pick_version(row, spec)
    path = str(row.get(spec.get("path_field") or "") or "").strip()
    port = _to_int(row.get(spec.get("port_field") or "")) if spec.get("port_field") else None
    status = str(row.get(spec.get("status_field") or "") or "")[:128]

    consumed = {spec.get("name_field"), *spec.get("version_fields", ())}
    for field in ("path_field", "status_field", "port_field"):
        if spec.get(field):
            consumed.add(spec[field])
    payload = {
        k: v
        for k, v in row.items()
        if k not in _HOST_KEYS and k not in consumed and k not in _SKIP_PAYLOAD_KEYS
    }

    return {
        "source_id": build_source_id(
            device.id, module, agent_id, name_norm, version_norm, path, port,
        ),
        "qingteng_device_id": device.id,
        "qingteng_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "module": module,
        "os_type": os_type,
        "agent_id": agent_id[:64],
        "hostname": str(row.get("hostname") or "")[:255],
        "display_ip": str(row.get("displayIp") or "")[:255],
        "internal_ip": str(row.get("internalIp") or "")[:255],
        "external_ip": str(row.get("externalIp") or "")[:255],
        "biz_group": str(row.get("bizGroup") or "")[:255],
        "name": name[:512],
        "name_norm": name_norm[:512],
        "version": version[:255],
        "version_norm": version_norm[:255],
        "port": port,
        "path": path[:1024],
        "status": status,
        "payload": payload,
        "created_at": now,
        "updated_at": now,
    }


def _flush_values(db: Session, values: list[dict], stats: dict[str, Any]) -> None:
    """分块 upsert，并统计新增/更新条数。"""
    if not values:
        return
    source_ids = [v["source_id"] for v in values]
    existing = {
        r[0]
        for r in db.query(QingtengAssetItem.source_id)
        .filter(QingtengAssetItem.source_id.in_(source_ids))
        .all()
    }
    stats["inserted"] = stats.get("inserted", 0) + len(set(source_ids) - existing)
    stats["updated"] = stats.get("updated", 0) + len(set(source_ids) & existing)

    stmt = insert(QingtengAssetItem).values(values)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["source_id"],
        set_={col: getattr(excluded, col) for col in QINGTENG_ASSET_UPDATE_COLS},
    )
    db.execute(stmt)


def sync_device_modules(
    db: Session,
    device: Device,
    batch_id: int,
    *,
    user_id: int = 0,
    mode: str = "full",
    modules: Optional[list[str]] = None,
) -> dict[str, Any]:
    """同步单台青藤设备的指定资产模块到指定批次。"""
    import_mode = mode if mode in ("full", "incremental") else "full"
    module_list = [m for m in ASSET_MODULES if not modules or m in modules]
    if not module_list:
        raise ValueError("未指定有效的资产模块")

    batch = db.query(GovCloudImportBatch).filter(GovCloudImportBatch.id == batch_id).first()
    if batch is None:
        raise ValueError(f"同步批次不存在: {batch_id}")
    expected_type = f"qingteng_asset:{device.id}"
    if batch.resource_type != expected_type:
        raise ValueError(f"批次与设备不匹配: {batch.resource_type} != {expected_type}")

    base_url = (device.api_url or "").rstrip("/")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()

    batch.status = "running"
    batch.phase = "登录青藤平台"
    batch.percent = 2
    batch.stats = {}
    db.commit()

    progress = 0
    stats: dict[str, Any] = {"modules": {}, "failed_modules": [], "truncated_modules": []}
    unique_ids: set[str] = set()
    failed_modules: list[str] = []
    truncated_modules: list[str] = []

    try:
        validate_outbound_url(base_url, field="青藤 api_url")
        comid, jwt, signkey = _qingteng_login(device, timeout, verify)
        with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
            for idx, module in enumerate(module_list):
                spec = ASSET_MODULE_SPECS[module]
                module_stats: dict[str, Any] = {
                    "rows": 0, "inserted": 0, "updated": 0,
                    "skipped": 0, "deleted": 0, "truncated": False, "error": "",
                }
                batch.phase = f"拉取{ASSET_MODULE_LABELS.get(module, module)}"
                batch.percent = min(95, 5 + int(90 * idx / len(module_list)))
                db.commit()

                buffer: list[dict] = []
                module_ids: set[str] = set()
                try:
                    now = beijing_now()
                    for os_type in spec["os_types"]:
                        path = spec["path"].format(os=os_type)
                        limit = MAX_ROWS_PER_MODULE.get(module, 300_000)
                        for row in iter_paged_rows(
                            client, base_url, comid, jwt, signkey,
                            path, limit, module_stats,
                        ):
                            values = _row_to_values(
                                device, row, module, os_type, batch.id, now,
                            )
                            if values is None:
                                module_stats["skipped"] += 1
                                continue
                            if values["source_id"] in module_ids:
                                continue
                            module_ids.add(values["source_id"])
                            buffer.append(values)
                            if len(buffer) >= UPSERT_CHUNK:
                                _flush_values(db, buffer, module_stats)
                                buffer = []
                    _flush_values(db, buffer, module_stats)
                    unique_ids |= module_ids

                    if module_stats["truncated"]:
                        truncated_modules.append(module)
                        stats["truncated_modules"].append(module)
                    elif import_mode == "full":
                        module_stats["deleted"] = (
                            db.query(QingtengAssetItem)
                            .filter(
                                QingtengAssetItem.qingteng_device_id == device.id,
                                QingtengAssetItem.module == module,
                                QingtengAssetItem.batch_id != batch.id,
                            )
                            .delete(synchronize_session=False)
                        )
                except Exception as exc:  # noqa: BLE001
                    db.rollback()
                    logger.warning(
                        "青藤资产同步失败 device=%s module=%s err=%s",
                        device.name, module, exc,
                    )
                    module_stats["error"] = str(exc)[:500]
                    module_stats["inserted"] = 0
                    module_stats["updated"] = 0
                    failed_modules.append(module)
                    stats["failed_modules"].append(module)
                stats["modules"][module] = module_stats
                batch.stats = dict(stats)
                progress += 1
                batch.percent = min(95, 5 + int(90 * progress / len(module_list)))
                db.commit()

        if len(failed_modules) == len(module_list):
            raise RuntimeError("所有资产模块拉取失败")

        now = beijing_now()
        live = int(
            db.query(func.count(QingtengAssetItem.id))
            .filter(QingtengAssetItem.qingteng_device_id == device.id)
            .scalar() or 0
        )
        live_synced = int(
            db.query(func.count(QingtengAssetItem.id))
            .filter(
                QingtengAssetItem.qingteng_device_id == device.id,
                QingtengAssetItem.module.in_(module_list),
            )
            .scalar() or 0
        )
        complete = not failed_modules and not truncated_modules
        consistent = complete and live_synced == len(unique_ids)

        batch.excel_rows = sum(int(s.get("rows") or 0) for s in stats["modules"].values())
        batch.unique_source_ids = len(unique_ids)
        batch.inserted = sum(int(s.get("inserted") or 0) for s in stats["modules"].values())
        batch.updated = sum(int(s.get("updated") or 0) for s in stats["modules"].values())
        batch.deleted = sum(int(s.get("deleted") or 0) for s in stats["modules"].values())
        batch.skipped = sum(int(s.get("skipped") or 0) for s in stats["modules"].values())
        batch.live_count = live
        batch.consistent = int(bool(consistent))
        batch.status = "success" if complete else "partial"
        batch.phase = "完成"
        batch.percent = 100
        batch.stats = dict(stats)
        batch.duration_ms = int((time.perf_counter() - started) * 1000)

        notes = [
            f"来源设备：{device.name}",
            f"同步模块：{','.join(module_list)}",
            "增量同步：仅新增/更新" if import_mode == "incremental" else "全量同步",
        ]
        if failed_modules:
            notes.append(
                f"失败模块：{','.join(ASSET_MODULE_LABELS.get(m, m) for m in failed_modules)}（已保留旧数据）"
            )
        if truncated_modules:
            notes.append(
                f"触顶模块：{','.join(ASSET_MODULE_LABELS.get(m, m) for m in truncated_modules)}（已保留旧数据）"
            )
        batch.note = "；".join(notes)

        device.status = "online"
        device.last_heartbeat = now
        device.last_test_error = None
        device.last_test_latency_ms = batch.duration_ms
        db.commit()

        record_device_call(
            db,
            device=device,
            action=None,
            source="module_sync",
            user_id=user_id,
            request_summary=f"GET /external/api/assets/{'|'.join(module_list)}/{{os}}",
            response_summary=f"rows={batch.excel_rows} unique={len(unique_ids)} live={live}",
            status="success" if complete else "partial",
            latency_ms=batch.duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        duration = int((time.perf_counter() - started) * 1000)
        try:
            batch = db.query(GovCloudImportBatch).filter(GovCloudImportBatch.id == batch_id).first()
            if batch is not None:
                batch.status = "failed"
                batch.phase = "失败"
                batch.percent = 100
                batch.note = f"资产同步失败: {exc}"[:2000]
                batch.duration_ms = duration
            device.status = "abnormal"
            device.last_test_error = f"资产同步失败: {exc}"[:2000]
            device.last_heartbeat = beijing_now()
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        record_device_call(
            db,
            device=device,
            action=None,
            source="module_sync",
            user_id=user_id,
            request_summary=f"GET /external/api/assets/modules mode={import_mode}",
            response_summary=None,
            status="failed",
            latency_ms=duration,
            error_message=str(exc)[:2000],
        )
        raise RuntimeError(f"资产同步失败: {exc}") from exc

    logger.info(
        "青藤资产同步完成 device=%s(%d) mode=%s modules=%s rows=%d unique=%d live=%d status=%s",
        device.name, device.id, import_mode, module_list,
        batch.excel_rows, len(unique_ids), live, batch.status,
    )
    return {
        "resource_type": f"qingteng_asset:{device.id}",
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
        "modules": module_list,
        "status": batch.status,
        "excel_rows": batch.excel_rows,
        "unique_source_ids": batch.unique_source_ids,
        "inserted": batch.inserted,
        "updated": batch.updated,
        "deleted": batch.deleted,
        "skipped": batch.skipped,
        "live_count": live,
        "consistent": bool(consistent),
        "duration_ms": batch.duration_ms,
        "stats": stats,
        "note": batch.note,
        "batch": batch.to_dict(),
    }
