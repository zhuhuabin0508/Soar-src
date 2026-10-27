"""青藤主机资产同步：登录设备管理中的青藤平台，分页拉取主机清单入库。

凭据与协议完全复用设备管理（devices 表 auth_type=qingteng）：
- 登录：``_qingteng_login``（POST /v1/api/auth 换 comId/jwt/signKey）
- 查询：GET /external/api/assets/host/{linux|win}?page&size，GET 签名复用
  ``_qingteng_signheaders``（参数按名升序拼接 + SHA1）

入库口径与政务云 Excel 导入一致：
- 批次表 GovCloudImportBatch：resource_type = "qingteng_host:<设备ID>"，每台青藤一个维度
- filename = "API同步:<设备名>"
- full 全量对齐：删除该设备下本次未出现的旧记录；incremental 仅新增/更新
- 一致性：库内该设备 live 数 == 本次唯一 source_id 数
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import (
    _qingteng_login,
    _qingteng_signheaders,
    record_device_call,
)
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.qingteng_host import (
    AGENT_STATUS_LABELS,
    OS_TYPES,
    QINGTENG_UPDATE_COLS,
    QingtengHostAsset,
)

logger = logging.getLogger(__name__)

# 青藤单页拉取条数（主机清单接口分页参数 size）
PAGE_SIZE = 500
# 入库分块，与政务云 Excel 导入一致
UPSERT_CHUNK = 500
# 单 OS 分页上限，防异常死循环（500 条/页 x 2000 页 = 100 万行）
MAX_PAGES = 2000

# 已消费的 API 字段（这些不进 extra）
_CONSUMED_KEYS = frozenset({
    "agentId", "displayIp", "connectionIp", "externalIp", "internalIp", "proxyIp",
    "hostname", "platform", "kernelVersion", "agentStatus", "onlineStatus",
    "lastOnlineTime", "offlineDays", "agentVersion", "bizGroupId", "bizGroup",
    "hostTagList", "remark", "chargeName", "hostLocation", "cpu", "memorySize",
    "memoryUsage", "diskSize", "diskUsage", "diskCount", "manufacturer",
    "productName", "serialNumber", "networkCards",
})


def get_qingteng_devices(db: Session) -> list[Device]:
    """纳入资产发现的青藤设备：已启用且 api_url/用户名已配置的 auth_type=qingteng 设备。

    设备管理页新增/启用青藤设备后，资产发现「青藤主机资产发现」来源自动多一张数据表卡片；
    停用设备后卡片消失（库内历史数据保留）。
    """
    rows = (
        db.query(Device)
        .filter(Device.auth_type == "qingteng", Device.enabled.is_(True))
        .order_by(Device.id)
        .all()
    )
    return [d for d in rows if (d.api_url or "").strip() and (d.username or "").strip()]


def _to_int(v) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _to_float(v) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def _agent_status_label(v) -> str:
    n = _to_int(v)
    return AGENT_STATUS_LABELS.get(n, "") if n is not None else ""


def _fmt_ts(v) -> str:
    if v is None:
        return ""
    s = str(v).strip().replace("T", " ")
    return s[:19]


def _row_to_values(device: Device, row: dict, os_type: str, batch_id: int, now) -> Optional[dict]:
    """青藤 API row → 入库 values；缺 agentId 返回 None（跳过）。"""
    agent_id = str(row.get("agentId") or "").strip()
    if not agent_id:
        return None
    cpu = row.get("cpu") if isinstance(row.get("cpu"), dict) else {}
    values = {
        "source_id": f"{device.id}:{agent_id}"[:160],
        "qingteng_device_id": device.id,
        "qingteng_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "created_at": now,
        "updated_at": now,
        "agent_id": agent_id[:64],
        "os_type": os_type,
        "hostname": str(row.get("hostname") or "")[:255],
        "display_ip": str(row.get("displayIp") or "")[:255],
        "connection_ip": str(row.get("connectionIp") or "")[:255],
        "external_ip": str(row.get("externalIp") or "")[:255],
        "internal_ip": str(row.get("internalIp") or "")[:255],
        "proxy_ip": str(row.get("proxyIp") or "")[:255],
        "platform": str(row.get("platform") or ""),
        "kernel_version": str(row.get("kernelVersion") or ""),
        "agent_status": _to_int(row.get("agentStatus")),
        "agent_status_label": _agent_status_label(row.get("agentStatus")),
        "online_status": _to_int(row.get("onlineStatus")),
        "last_online_time": _fmt_ts(row.get("lastOnlineTime")),
        "offline_days": _to_int(row.get("offlineDays")),
        "agent_version": str(row.get("agentVersion") or "")[:255],
        "biz_group_id": _to_int(row.get("bizGroupId")),
        "biz_group": str(row.get("bizGroup") or "")[:255],
        "host_tag_list": row.get("hostTagList") if isinstance(row.get("hostTagList"), list) else [],
        "remark": str(row.get("remark") or ""),
        "charge_name": str(row.get("chargeName") or "")[:128],
        "host_location": str(row.get("hostLocation") or "")[:128],
        "cpu_core": _to_int(cpu.get("core")),
        "cpu_brand": str(cpu.get("brand") or ""),
        "memory_size": _to_int(row.get("memorySize")),
        "memory_usage": _to_int(row.get("memoryUsage")),
        "disk_size": _to_int(row.get("diskSize")),
        "disk_usage": _to_float(row.get("diskUsage")),
        "disk_count": _to_int(row.get("diskCount")),
        "manufacturer": str(row.get("manufacturer") or "")[:255],
        "product_name": str(row.get("productName") or "")[:255],
        "serial_number": str(row.get("serialNumber") or "")[:255],
        "network_cards": row.get("networkCards") if isinstance(row.get("networkCards"), list) else [],
    }
    # API 未来新增字段兜底（青藤升级不丢字段）
    extra = {k: v for k, v in row.items() if k not in _CONSUMED_KEYS}
    values["extra"] = extra
    return values


def _fetch_all_hosts(client: httpx.Client, base_url: str, comid: str, jwt: str, signkey: str) -> list[tuple[str, dict]]:
    """分页拉取 linux + win 全量主机，返回 [(os_type, row), ...]。"""
    entries: list[tuple[str, dict]] = []
    for os_type in OS_TYPES:
        page = 0
        fetched = 0
        total = 0
        while page < MAX_PAGES:
            url = f"{base_url}/external/api/assets/host/{os_type}"
            headers, _, final_url = _qingteng_signheaders(
                comid, jwt, signkey, "GET", {"page": page, "size": PAGE_SIZE}, None, url,
            )
            resp = client.get(final_url, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(f"青藤主机查询失败 HTTP {resp.status_code}: {resp.text[:300]}")
            try:
                data = resp.json() or {}
            except Exception:  # noqa: BLE001
                raise RuntimeError(f"青藤主机查询返回非 JSON: {resp.text[:200]}") from None
            # 数据 API 契约（见 scripts/qingteng_api_manual.txt「数据api请求结果」）：
            # 成功 = HTTP 200 且返回 {total, rows}（无 success 字段，与登录接口不同）；
            # 失败 = HTTP != 200 且返回 {errorCode, errorMessage}
            error_msg = data.get("errorMessage") or data.get("errorDesc") or ""
            if data.get("errorCode") or error_msg:
                raise RuntimeError(
                    f"青藤主机查询失败: {data.get('errorCode') or ''} {error_msg or data}".strip()
                )
            if "rows" not in data and "total" not in data:
                raise RuntimeError(f"青藤主机查询返回格式异常: {str(data)[:200]}")
            page_rows = data.get("rows") or []
            for row in page_rows:
                entries.append((os_type, row))
            fetched += len(page_rows)
            total = int(data.get("total") or 0)
            if len(page_rows) < PAGE_SIZE or (total and fetched >= total):
                break
            page += 1
        logger.info("青藤主机拉取完成: os=%s total=%s fetched=%d", os_type, total, fetched)
    return entries


def sync_device_hosts(db: Session, device: Device, *, user_id: int = 0, mode: str = "full") -> dict:
    """同步单台青藤设备的主机清单入库。

    Args:
        db: 数据库会话。
        device: 青藤设备（auth_type=qingteng）。
        user_id: 触发同步的用户 ID（写批次/审计用）。
        mode: full 全量对齐（删除该设备下本次未出现的记录）/ incremental 增量。

    Returns:
        同步结果摘要（行数/增删改/一致性等，与 Excel 导入返回口径对齐）。

    Raises:
        RuntimeError: 登录失败 / 拉取失败 / 响应异常。
    """
    import_mode = mode if mode in ("full", "incremental") else "full"
    # validate_outbound_url 校验通过时返回 None（占位），不能把返回值当 URL 用
    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="青藤 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()

    phase = "登录青藤平台"
    try:
        comid, jwt, signkey = _qingteng_login(device, timeout, verify)
        phase = "拉取主机清单"
        with httpx.Client(timeout=timeout, verify=verify) as client:
            entries = _fetch_all_hosts(client, base_url, comid, jwt, signkey)

        phase = "写入数据库"
        now = beijing_now()
        values_map: dict[str, dict] = {}
        skipped = 0
        for os_type, row in entries:
            values = _row_to_values(device, row, os_type, 0, now)
            if values is None:
                skipped += 1
                continue
            values_map[values["source_id"]] = values
        unique_values = list(values_map.values())
        duplicate = len(entries) - skipped - len(unique_values)

        existing_ids = {
            r[0]
            for r in db.query(QingtengHostAsset.source_id)
            .filter(QingtengHostAsset.qingteng_device_id == device.id)
            .all()
        }
        unique_ids = set(values_map.keys())
        inserted = len(unique_ids - existing_ids)
        updated = len(unique_ids & existing_ids)
        deleted = len(existing_ids - unique_ids) if import_mode == "full" else 0

        batch = GovCloudImportBatch(
            resource_type=f"qingteng_host:{device.id}",
            filename=f"API同步:{device.name}"[:300],
            file_size=0,
            excel_rows=len(entries),
            unique_source_ids=len(unique_ids),
            inserted=inserted,
            updated=updated,
            deleted=deleted,
            skipped=skipped,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            note="",
            created_by=user_id,
            created_at=now,
        )
        db.add(batch)
        db.flush()

        for v in unique_values:
            v["batch_id"] = batch.id
        update_cols = [c for c in QINGTENG_UPDATE_COLS]
        for i in range(0, len(unique_values), UPSERT_CHUNK):
            chunk = unique_values[i:i + UPSERT_CHUNK]
            stmt = insert(QingtengHostAsset).values(chunk)
            excluded = stmt.excluded
            stmt = stmt.on_conflict_do_update(
                index_elements=["source_id"],
                set_={col: getattr(excluded, col) for col in update_cols},
            )
            db.execute(stmt)

        if import_mode == "full":
            db.query(QingtengHostAsset).filter(
                QingtengHostAsset.qingteng_device_id == device.id,
                QingtengHostAsset.batch_id != batch.id,
            ).delete(synchronize_session=False)

        live = int(
            db.query(func.count(QingtengHostAsset.id))
            .filter(QingtengHostAsset.qingteng_device_id == device.id)
            .scalar() or 0
        )
        consistent = (live == len(unique_ids) and skipped == 0) if import_mode == "full" else skipped == 0
        notes = [
            "全量同步：已删除青藤平台已不存在的主机记录" if import_mode == "full"
            else "增量同步：仅新增/更新，未删除库内既有记录",
            f"来源设备：{device.name}（linux + win）",
        ]
        if duplicate:
            notes.append(f"API 返回重复 agentId {duplicate} 条，已按最后一条保留")
        if skipped:
            notes.append(f"缺少 agentId 跳过 {skipped} 条")
        if not consistent and import_mode == "full":
            notes.append(f"同步后库内 {live} 与唯一 ID {len(unique_ids)} 不一致")
        batch.live_count = live
        batch.consistent = int(consistent)
        batch.note = "；".join(notes)

        # 同步成功视为一次心跳：更新设备连接状态
        device.status = "online"
        device.last_heartbeat = now
        device.last_test_error = None
        device.last_test_latency_ms = int((time.perf_counter() - started) * 1000)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        duration = int((time.perf_counter() - started) * 1000)
        # 标记设备异常并记录调用日志（单台失败不影响其它设备）
        try:
            device.status = "abnormal"
            device.last_test_error = f"资产同步失败({phase}): {exc}"[:2000]
            device.last_heartbeat = beijing_now()
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        record_device_call(
            db,
            device=device,
            action=None,
            source="asset_sync",
            user_id=user_id,
            request_summary=f"GET /external/api/assets/host/{{linux|win}} mode={import_mode}",
            response_summary=None,
            status="failed",
            latency_ms=duration,
            error_message=f"{phase}: {exc}"[:2000],
        )
        raise RuntimeError(f"{phase}失败: {exc}") from exc

    duration_ms = int((time.perf_counter() - started) * 1000)
    batch.duration_ms = duration_ms
    db.commit()
    record_device_call(
        db,
        device=device,
        action=None,
        source="asset_sync",
        user_id=user_id,
        request_summary=f"GET /external/api/assets/host/{{linux|win}} mode={import_mode}",
        response_summary=f"rows={len(entries)} unique={len(unique_ids)} live={live}",
        status="success",
        latency_ms=duration_ms,
    )
    logger.info(
        "青藤主机同步: device=%s(%d) mode=%s rows=%d unique=%d live=%d inserted=%d updated=%d deleted=%d consistent=%s",
        device.name, device.id, import_mode, len(entries), len(unique_ids), live,
        inserted, updated, deleted, consistent,
    )
    return {
        "resource_type": f"qingteng_host:{device.id}",
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
        "excel_rows": len(entries),
        "unique_source_ids": len(unique_ids),
        "inserted": inserted,
        "updated": updated,
        "deleted": deleted,
        "skipped": skipped,
        "live_count": live,
        "consistent": consistent,
        "duration_ms": duration_ms,
        "note": batch.note,
        "batch": batch.to_dict(),
    }
