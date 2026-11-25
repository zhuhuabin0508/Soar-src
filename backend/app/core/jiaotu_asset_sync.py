"""奇安信椒图云锁资产同步：主机清单 + 单主机资产明细（安装包/端口/进程等）。

凭据复用设备管理（devices 表 auth_type=jiaotu）：
- ``api_url``：云锁管理中心地址，如 ``https://10.132.0.1:443``（可带 /api，自动去除）；
- ``api_key``：云锁「产品联动」授权码（加密存储），请求时放入 body.token。

同步口径与青藤/天擎一致：
- 批次 ``GovCloudImportBatch``：``jiaotu_host:<设备ID>`` 与 ``jiaotu_asset:<设备ID>``；
- 主机清单分页拉取后 upsert；单主机详情并发拉取，按模块拆分为资产明细；
- full 全量：删除本次未出现的主机与明细；详情拉取失败的主机保留旧数据；
- 明细模块：安装包 / 端口 / 进程 / 数据库 / Web 服务 / Web 框架 / 系统账号 /
  网络连接 / 启动服务。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from types import SimpleNamespace
from typing import Any, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.asset_upsert import bulk_upsert
from app.core.security import decrypt_device_secret, validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import record_device_call
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.jiaotu_asset_item import (
    JIAOTU_ASSET_UPDATE_COLS,
    JiaotuAssetItem,
)
from app.models.jiaotu_host import (
    JIAOTU_ADV_LABELS,
    JIAOTU_HOST_UPDATE_COLS,
    JIAOTU_OS_LABELS,
    JiaotuHostAsset,
)

logger = logging.getLogger(__name__)

# 主机清单分页（云锁接口 currentPage / maxResults）
PAGE_SIZE = 500
MAX_PAGES = 200
# 入库分块：单行字段较多，1000 行仍在 PostgreSQL 参数上限内
UPSERT_CHUNK = 1000
# 单主机详情并发与批次大小（可通过环境变量调节，默认 8，范围 1~32）
def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


FETCH_CONCURRENCY = _env_int("JIAOTU_FETCH_CONCURRENCY", 8, 1, 32)
FETCH_BATCH = FETCH_CONCURRENCY * 4
# 进度落库间隔（秒）
PROGRESS_COMMIT_SECONDS = 5.0
# 失败主机明细最多保留条数
MAX_FAILED_DETAILS = 100

HOST_LIST_PATH = "/api/assetSrv/zcMachineController/listMachineBaseInfos"
HOST_DETAIL_PATH = "/api/assetSrv/esZcController/zcForNGSOC"

# 已消费的主机字段（不进 extra）
_CONSUMED_HOST_KEYS = frozenset({
    "uuid", "machineName", "onlineStatus", "osType", "mac",
    "ifDelete", "intranetIp", "extranetIp", "advVersion", "softwareVersion",
})

# 模块 → 云锁详情字段与列映射（集中维护，新增模块只加配置）
ASSET_MODULE_SPECS: dict[str, dict[str, Any]] = {
    "install_package": {
        "key": "installPackages",
        "name": "installPackageName",
        "version": "installPackageVersion",
        "path": "installPath",
        "publisher": "company",
        "install_time": "installTime",
    },
    "port": {
        "key": "ports",
        "name": "processName",
        "port": "port",
        "protocol": "protocal",
        "status": "portStatus",
    },
    "process": {
        "key": "process",
        "name": "processName",
        "version": "processVersion",
        "start_user": "startUser",
    },
    "database": {
        "key": "databases",
        "name": "databaseName",
        "version": "databaseVersion",
        "port": "port",
        "path": "bindIp",
        "start_user": "startUser",
    },
    "web_server": {
        "key": "webServers",
        "name": "webServerName",
        "version": "webServerVersion",
        "port": "port",
        "path": "processPath",
        "start_user": "startUser",
        "status": "webServerType",
    },
    "web_frame": {
        "key": "webFrames",
        "name": "webFrameName",
        "version": "webFrameVersion",
        "path": "webFramePath",
    },
    "account": {
        "key": "users",
        "name": "userName",
    },
    "network_connection": {
        "key": "networkConnections",
        "name": "processName",
        "port": "port",
        "protocol": "protocal",
        "status": "connectStatus",
    },
    "start_service": {
        "key": "startServers",
        "name": "startItem",
        "path": "scriptPath",
        "publisher": "publisher",
        "status": "startStatus",
    },
}

_PLACEHOLDER_VERSIONS = frozenset({
    "", "-", "--", "unknown", "未知", "n/a", "na", "none", "null", "nil",
    "0", "0.0", "0.0.0", "?", "??", "not installed", "未采集", "未获取", "无",
})


def get_jiaotu_devices(db: Session) -> list[Device]:
    """纳入资产发现的椒图设备：已启用且 api_url / 授权码已配置。"""
    rows = (
        db.query(Device)
        .filter(Device.auth_type == "jiaotu", Device.enabled.is_(True))
        .order_by(Device.id)
        .all()
    )
    return [
        d for d in rows
        if (d.api_url or "").strip() and (d.api_key or "").strip()
    ]


def _normalize_base_url(device: Device) -> str:
    """规范化云锁地址：允许省略 https://，去掉尾部斜杠与 /api 后缀。"""
    base = (device.api_url or "").strip().rstrip("/")
    if not base:
        raise ValueError("设备未配置 api_url（椒图云锁地址，如 https://10.132.0.1:443）")
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"
    if base.lower().endswith("/api"):
        base = base[:-4].rstrip("/")
    return base


@lru_cache(maxsize=256)
def _decrypt_secret_cached(ciphertext: str) -> str:
    """凭据解密缓存：按密文缓存，避免逐主机请求重复 Fernet 解密。"""
    return decrypt_device_secret(ciphertext)


def _token(device: Device) -> str:
    token = _decrypt_secret_cached(device.api_key or "").strip()
    if not token:
        raise ValueError("设备未配置椒图云锁授权码（产品联动 Token）")
    return token


def _http_client(timeout: float, verify: bool) -> httpx.Client:
    # 设备对接走本机网络直连，忽略代理环境变量
    return httpx.Client(timeout=timeout, verify=verify, trust_env=False)


def _post(
    device: Device,
    path: str,
    payload: dict,
    *,
    timeout: float = 30,
    verify: bool = False,
    client: httpx.Client | None = None,
) -> dict:
    """执行云锁 POST 接口，校验 code 并返回 ``data``。"""
    base_url = _normalize_base_url(device)
    url = f"{base_url}{path}"
    validate_outbound_url(url, field="椒图 api_url")
    body = {"token": _token(device), **payload}
    if client is not None:
        resp = client.post(url, json=body)
    else:
        with _http_client(timeout, verify) as own_client:
            resp = own_client.post(url, json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f"椒图接口请求失败 HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json() or {}
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"椒图接口返回非 JSON: {resp.text[:200]}") from None
    code = str(data.get("code") or "")
    if code != "1":
        msg = data.get("msg") or data.get("message") or str(data)[:200]
        raise RuntimeError(f"椒图接口错误 code={code or '-'}: {msg}")
    return data.get("data") or {}


def fetch_hosts(
    device: Device,
    *,
    timeout: float = 30,
    verify: bool = False,
    limit: int = 0,
    client: httpx.Client | None = None,
) -> tuple[list[dict], int]:
    """分页拉取主机清单，返回 (rows, 接口报告总数)。"""
    rows: list[dict] = []
    seen: set[str] = set()
    total = 0
    page = 1
    for _ in range(MAX_PAGES):
        data = _post(
            device,
            HOST_LIST_PATH,
            {"currentPage": page, "maxResults": PAGE_SIZE},
            timeout=timeout,
            verify=verify,
            client=client,
        )
        page_rows = data.get("list") or []
        total = int(data.get("total") or 0)
        added = 0
        for row in page_rows:
            uuid = str(row.get("uuid") or "").strip()
            if not uuid or uuid in seen:
                continue
            seen.add(uuid)
            rows.append(row)
            added += 1
            if limit and len(rows) >= limit:
                break
        if limit and len(rows) >= limit:
            break
        if not page_rows:
            break
        # 不依赖单页条数（服务端可能限制 maxResults），按 total 或空页结束
        if total and len(rows) >= total:
            break
        if added == 0:
            break
        page += 1
    logger.info("椒图主机拉取完成: device=%s total=%s fetched=%d", device.name, total, len(rows))
    return rows, total


def fetch_host_detail(
    device: Device,
    host_ip: str,
    *,
    timeout: float = 30,
    verify: bool = False,
    client: httpx.Client | None = None,
) -> dict:
    """拉取单台主机资产详情（安装包/端口/进程/数据库/Web 等）。"""
    data = _post(
        device,
        HOST_DETAIL_PATH,
        {"hostIp": host_ip},
        timeout=timeout,
        verify=verify,
        client=client,
    )
    if not isinstance(data, dict) or not data:
        raise RuntimeError("椒图主机详情返回空数据")
    return data


def _norm_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().lower()


def _norm_version(value: Any) -> str:
    raw = unicodedata.normalize("NFKC", str(value or "")).strip()
    if raw.lower() in _PLACEHOLDER_VERSIONS:
        return ""
    if ":" in raw:
        head, _, tail = raw.partition(":")
        if head.isdigit() and tail:
            raw = tail.strip()
    if not raw or raw.lower() in _PLACEHOLDER_VERSIONS:
        return ""
    return raw.lower()


def _to_port(value: Any) -> Optional[int]:
    """从端口字段提取首个合法端口（Web 服务可能返回 9301/9401/...）。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        match = re.search(r"\b(\d{1,5})\b", str(value))
        if not match:
            return None
        port = int(match.group(1))
    return port if 1 <= port <= 65535 else None


def _enum_label(mapping: dict[int, str], value: Any) -> str:
    try:
        return mapping.get(int(value), str(value))
    except (TypeError, ValueError):
        return str(value or "")


def _to_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    try:
        return bool(int(value))
    except (TypeError, ValueError):
        text = str(value).strip().lower()
        if text in ("true", "yes", "1"):
            return True
        if text in ("false", "no", "0", ""):
            return False
        return None


def _host_values(device: Device, row: dict, batch_id: int, now) -> Optional[dict]:
    """云锁主机 row → 入库 values；缺 uuid 返回 None（跳过）。"""
    uuid = str(row.get("uuid") or "").strip()
    if not uuid:
        return None
    values = {
        "source_id": f"{device.id}:{uuid}"[:160],
        "jiaotu_device_id": device.id,
        "jiaotu_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "machine_uuid": uuid[:64],
        "machine_name": str(row.get("machineName") or "")[:255],
        "intranet_ip": str(row.get("intranetIp") or "")[:255],
        "extranet_ip": str(row.get("extranetIp") or "")[:255],
        "mac": str(row.get("mac") or "")[:64],
        "os_type": _enum_label(JIAOTU_OS_LABELS, row.get("osType")),
        "os_name": "",
        "online_status": _to_bool(row.get("onlineStatus")),
        "agent_version": str(row.get("softwareVersion") or "")[:64],
        "adv_version": _enum_label(JIAOTU_ADV_LABELS, row.get("advVersion")),
        "if_delete": _to_bool(row.get("ifDelete")),
        "manufacturer": "",
        "serial": "",
        "cpu": "",
        "memory_size": None,
        "extra": {k: v for k, v in row.items() if k not in _CONSUMED_HOST_KEYS},
        "created_at": now,
        "updated_at": now,
    }
    return values


def _detail_os_name(detail: dict) -> str:
    """从详情各模块的 operationSystem 提取操作系统名称。"""
    for key in ("users", "process", "webServers", "databases", "installPackages", "ports"):
        for item in detail.get(key) or []:
            os_name = str(item.get("operationSystem") or "").strip()
            if os_name:
                return os_name[:255]
    return ""


def _apply_hardware(values: dict, detail: dict) -> None:
    """把详情 hardware 合并进主机 values。"""
    hardware = detail.get("hardware") or {}
    if not isinstance(hardware, dict):
        return
    values["manufacturer"] = str(hardware.get("manufacturer") or "").strip()[:255]
    values["serial"] = str(hardware.get("serial") or "").strip()[:255]
    values["cpu"] = str(hardware.get("cpu") or "").strip()[:255]
    try:
        values["memory_size"] = int(hardware.get("memorySize")) if hardware.get("memorySize") is not None else None
    except (TypeError, ValueError):
        values["memory_size"] = None
    os_name = _detail_os_name(detail)
    if os_name:
        values["os_name"] = os_name


def _host_ip(host) -> str:
    """详情接口使用的主机 IP：优先内网 IP，其次出网 IP。"""
    for attr in ("intranet_ip", "extranet_ip"):
        ip = str(getattr(host, attr, "") or "").strip()
        if ip and ip not in ("0.0.0.0", "::", "127.0.0.1"):
            return ip
    return ""


def _update_host_hardware(db: Session, device_id: int, machine_uuid: str, detail: dict) -> None:
    """详情成功后回填主机硬件字段（仅更新有值的字段）。"""
    temp: dict[str, Any] = {"manufacturer": "", "serial": "", "cpu": "", "memory_size": None, "os_name": ""}
    _apply_hardware(temp, detail)
    updates = {k: v for k, v in temp.items() if v not in ("", None)}
    if not updates:
        return
    db.query(JiaotuHostAsset).filter(
        JiaotuHostAsset.jiaotu_device_id == device_id,
        JiaotuHostAsset.machine_uuid == machine_uuid,
    ).update(updates, synchronize_session=False)


def _asset_source_id(device_id: int, module: str, machine_uuid: str, item: dict) -> str:
    item_id = str(item.get("id") or "").strip()
    if not item_id:
        canonical = json.dumps(item, sort_keys=True, ensure_ascii=False, default=str)
        item_id = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:20]
    return f"{device_id}:{module}:{machine_uuid}:{item_id}"[:160]


def _asset_values(
    device: Device,
    host,
    module: str,
    item: dict,
    batch_id: int,
    now,
) -> Optional[dict]:
    """云锁详情条目 → 资产明细入库 values；无法识别名称返回 None。"""
    spec = ASSET_MODULE_SPECS[module]
    name = str(item.get(spec["name"]) or "").strip()
    version_field = spec.get("version")
    version = str(item.get(version_field) or "").strip() if version_field else ""
    port = _to_port(item.get(spec["port"])) if spec.get("port") else None

    # 部分模块名称可兜底（端口/网络连接可能缺进程名）
    if not name and module == "port":
        name = f"{item.get('protocal') or 'tcp'}:{item.get('port') or ''}".strip(":")
    if not name and module == "network_connection":
        name = f"{item.get('ip') or ''}:{item.get('port') or ''}".strip(":")
    if not name:
        return None

    path = str(item.get(spec.get("path") or "") or "").strip()
    publisher = str(item.get(spec.get("publisher") or "") or "").strip()
    start_user = str(item.get(spec.get("start_user") or "") or "").strip()
    protocol = str(item.get(spec.get("protocol") or "") or "").strip()
    status = str(item.get(spec.get("status") or "") or "").strip()
    install_time = str(item.get(spec.get("install_time") or "") or "").strip()

    if module == "account":
        status = "管理员" if str(item.get("isAdmin") or "") in ("1", "True", "true") else "普通用户"
    elif module == "network_connection":
        path = (
            f"{item.get('ip') or ''}:{item.get('port') or ''}"
            f"->{item.get('dstIp') or ''}:{item.get('dstPort') or ''}"
        )[:1024]

    name_norm = _norm_text(name)
    version_norm = _norm_version(version)
    machine_uuid = str(getattr(host, "machine_uuid", "") or "")

    return {
        "source_id": _asset_source_id(device.id, module, machine_uuid, item),
        "jiaotu_device_id": device.id,
        "jiaotu_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "module": module,
        "os_type": str(getattr(host, "os_type", "") or "")[:32],
        "machine_uuid": machine_uuid[:64],
        "machine_name": str(getattr(host, "machine_name", "") or "")[:255],
        "intranet_ip": str(getattr(host, "intranet_ip", "") or "")[:255],
        "extranet_ip": str(getattr(host, "extranet_ip", "") or "")[:255],
        "name": name[:512],
        "name_norm": name_norm[:512],
        "version": version[:255],
        "version_norm": version_norm[:255],
        "port": port,
        "protocol": protocol[:32],
        "path": path[:1024],
        "publisher": publisher[:255],
        "start_user": start_user[:128],
        "status": status[:128],
        "install_time": install_time[:32],
        "payload": item,
        "created_at": now,
        "updated_at": now,
    }


def _flush_hosts(
    db: Session,
    values: list[dict],
    stats: dict[str, Any],
    *,
    skip_unchanged: bool = False,
) -> None:
    if not values:
        return
    inserted = updated = 0
    for start in range(0, len(values), UPSERT_CHUNK):
        chunk = values[start:start + UPSERT_CHUNK]
        i, u = bulk_upsert(
            db,
            JiaotuHostAsset,
            chunk,
            update_cols=JIAOTU_HOST_UPDATE_COLS,
            skip_unchanged=skip_unchanged,
        )
        inserted += i
        updated += u
    stats["hosts_inserted"] = stats.get("hosts_inserted", 0) + inserted
    stats["hosts_updated"] = stats.get("hosts_updated", 0) + updated


def _flush_items(
    db: Session,
    values: list[dict],
    stats: dict[str, Any],
    *,
    skip_unchanged: bool = False,
) -> None:
    if not values:
        return
    inserted = updated = 0
    for start in range(0, len(values), UPSERT_CHUNK):
        chunk = values[start:start + UPSERT_CHUNK]
        i, u = bulk_upsert(
            db,
            JiaotuAssetItem,
            chunk,
            update_cols=JIAOTU_ASSET_UPDATE_COLS,
            skip_unchanged=skip_unchanged,
        )
        inserted += i
        updated += u
    stats["inserted"] = stats.get("inserted", 0) + inserted
    stats["updated"] = stats.get("updated", 0) + updated


def _get_batch(db: Session, batch_id: int, expected_type: str) -> GovCloudImportBatch:
    batch = db.query(GovCloudImportBatch).filter(GovCloudImportBatch.id == batch_id).first()
    if batch is None:
        raise ValueError(f"同步批次不存在: {batch_id}")
    if batch.resource_type != expected_type:
        raise ValueError(f"批次与设备不匹配: {batch.resource_type} != {expected_type}")
    return batch


def sync_device_assets(
    db: Session,
    device: Device,
    host_batch_id: int,
    asset_batch_id: int,
    *,
    user_id: int = 0,
    mode: str = "full",
    limit: int = 0,
) -> dict[str, Any]:
    """同步单台椒图设备的主机清单与资产明细。

    Args:
        db: 数据库会话。
        device: 椒图设备（auth_type=jiaotu）。
        host_batch_id: 主机批次 ID（status=pending）。
        asset_batch_id: 资产明细批次 ID（status=pending）。
        user_id: 触发用户 ID。
        mode: full 全量对齐 / incremental 仅新增更新。
        limit: 仅同步前 N 台主机（0 = 全部；大于 0 时不做全量删除）。
    """
    import_mode = mode if mode in ("full", "incremental") else "full"
    if limit < 0:
        limit = 0

    host_batch = _get_batch(db, host_batch_id, f"jiaotu_host:{device.id}")
    asset_batch = _get_batch(db, asset_batch_id, f"jiaotu_asset:{device.id}")

    base_url = _normalize_base_url(device)
    validate_outbound_url(base_url, field="椒图 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()

    host_batch.status = "running"
    host_batch.phase = "拉取主机清单"
    host_batch.percent = 1
    host_batch.stats = {}
    asset_batch.status = "pending"
    asset_batch.phase = "等待主机清单"
    asset_batch.percent = 0
    asset_batch.stats = {}
    db.commit()

    stats: dict[str, Any] = {
        "hosts_total": 0,
        "hosts_fetched": 0,
        "hosts_failed": 0,
        "hosts_skipped": 0,
        "failed_hosts": [],
        "modules": {},
        "rows": 0,
        "inserted": 0,
        "updated": 0,
        "skipped": 0,
        "deleted": 0,
    }
    unique_hosts = 0
    unique_items = 0
    failed_uuids: set[str] = set()
    limited = bool(limit)

    try:
        # ===== 阶段一：主机清单 =====
        host_rows, api_total = fetch_hosts(
            device, timeout=timeout, verify=verify, limit=limit,
        )
        if not host_rows:
            raise RuntimeError("椒图未返回任何主机，已保留旧数据")
        now = beijing_now()
        host_values: dict[str, dict] = {}
        for row in host_rows:
            values = _host_values(device, row, host_batch.id, now)
            if values is None:
                stats["hosts_skipped"] += 1
                continue
            host_values[values["source_id"]] = values
        unique_hosts = len(host_values)
        # 主机行数远小于明细（千级 vs 十万级）：始终刷新 batch_id，
        # 保证后续详情阶段能准确圈定本轮主机；硬件字段不参与覆盖。
        _flush_hosts(db, list(host_values.values()), stats)

        deleted_hosts = 0
        if import_mode == "full" and not limited:
            deleted_hosts = (
                db.query(JiaotuHostAsset)
                .filter(
                    JiaotuHostAsset.jiaotu_device_id == device.id,
                    JiaotuHostAsset.batch_id != host_batch.id,
                )
                .delete(synchronize_session=False)
            )
        stats["deleted"] = deleted_hosts

        live_hosts = int(
            db.query(func.count(JiaotuHostAsset.id))
            .filter(JiaotuHostAsset.jiaotu_device_id == device.id)
            .scalar() or 0
        )
        host_consistent = (
            not limited
            and import_mode == "full"
            and live_hosts == unique_hosts
            and stats["hosts_skipped"] == 0
        )
        host_batch.excel_rows = len(host_rows)
        host_batch.unique_source_ids = unique_hosts
        host_batch.inserted = stats["hosts_inserted"]
        host_batch.updated = stats["hosts_updated"]
        host_batch.deleted = deleted_hosts
        host_batch.skipped = stats["hosts_skipped"]
        host_batch.live_count = live_hosts
        host_batch.consistent = int(host_consistent)
        host_batch.status = "partial" if limited else "success"
        host_batch.phase = "部分完成" if limited else "完成"
        host_batch.percent = 100
        host_batch.duration_ms = int((time.perf_counter() - started) * 1000)
        host_notes = [
            f"来源设备：{device.name}",
            f"接口报告主机总数：{api_total}",
            "增量同步：仅新增/更新" if import_mode == "incremental" else "全量同步",
        ]
        if limited:
            host_notes.append(f"仅同步前 {limit} 台主机，未做全量删除")
        if stats["hosts_skipped"]:
            host_notes.append(f"缺少主机 UUID 跳过 {stats['hosts_skipped']} 条")
        host_batch.note = "；".join(host_notes)
        host_batch.stats = {"hosts_total": api_total, "hosts_fetched": len(host_rows)}
        db.commit()

        # ===== 阶段二：逐主机资产详情 =====
        asset_batch.status = "running"
        asset_batch.phase = "拉取主机资产明细 0/0"
        asset_batch.percent = 2
        db.commit()

        hosts = (
            db.query(
                JiaotuHostAsset.machine_uuid,
                JiaotuHostAsset.machine_name,
                JiaotuHostAsset.intranet_ip,
                JiaotuHostAsset.extranet_ip,
                JiaotuHostAsset.os_type,
            )
            # 仅处理本轮主机清单中的主机（增量/limit 场景不重复拉取库内旧主机）
            .filter(
                JiaotuHostAsset.jiaotu_device_id == device.id,
                JiaotuHostAsset.batch_id == host_batch.id,
            )
            .order_by(JiaotuHostAsset.id)
        ).all()
        total_hosts = len(hosts)
        stats["hosts_total"] = total_hosts
        if not total_hosts:
            raise RuntimeError("库内没有椒图主机，无法同步资产明细")

        buffer: dict[str, dict] = {}
        last_commit = time.monotonic()
        finished = 0
        # 线程池只使用纯值快照，避免 Worker 线程访问已过期的 ORM 实例触发数据库刷新
        device_snapshot = SimpleNamespace(
            id=device.id,
            name=device.name,
            api_url=device.api_url,
            api_key=device.api_key,
            password=device.password,
        )
        with _http_client(timeout, verify) as client, ThreadPoolExecutor(
            max_workers=FETCH_CONCURRENCY
        ) as pool:
            for start in range(0, total_hosts, FETCH_BATCH):
                chunk = hosts[start:start + FETCH_BATCH]
                pending = []
                for host in chunk:
                    ip = _host_ip(host)
                    if not ip:
                        pending.append((host, None, "主机无可用内网/出网 IP"))
                        continue
                    pending.append((
                        host,
                        pool.submit(
                            fetch_host_detail,
                            device_snapshot, ip,
                            timeout=timeout, verify=verify, client=client,
                        ),
                        "",
                    ))
                for host, future, precheck_error in pending:
                    finished += 1
                    uuid = str(host.machine_uuid or "")
                    if future is None:
                        error = precheck_error
                        failed_uuids.add(uuid)
                        stats["hosts_failed"] = len(failed_uuids)
                        if len(stats["failed_hosts"]) < MAX_FAILED_DETAILS:
                            stats["failed_hosts"].append({
                                "machine_uuid": uuid,
                                "machine_name": str(host.machine_name or ""),
                                "error": error[:200],
                            })
                        logger.warning(
                            "椒图主机详情跳过 device=%s host=%s err=%s",
                            device.name, host.machine_name, error,
                        )
                    else:
                        try:
                            detail = future.result()
                        except Exception as exc:  # noqa: BLE001
                            failed_uuids.add(uuid)
                            stats["hosts_failed"] = len(failed_uuids)
                            if len(stats["failed_hosts"]) < MAX_FAILED_DETAILS:
                                stats["failed_hosts"].append({
                                    "machine_uuid": uuid,
                                    "machine_name": str(host.machine_name or ""),
                                    "error": str(exc)[:200],
                                })
                            logger.warning(
                                "椒图主机详情拉取失败 device=%s host=%s err=%s",
                                device.name, host.machine_name, exc,
                            )
                        else:
                            _update_host_hardware(db, device_snapshot.id, uuid, detail)
                            local_ids: set[str] = set()
                            for module, spec in ASSET_MODULE_SPECS.items():
                                items = detail.get(spec["key"]) or []
                                module_count = 0
                                for item in items:
                                    if not isinstance(item, dict):
                                        continue
                                    values = _asset_values(
                                        device_snapshot, host, module, item,
                                        asset_batch.id, now,
                                    )
                                    if values is None:
                                        stats["skipped"] += 1
                                        continue
                                    sid = values["source_id"]
                                    if sid in buffer or sid in local_ids:
                                        continue
                                    local_ids.add(sid)
                                    buffer[sid] = values
                                    module_count += 1
                                if module_count:
                                    stats["modules"][module] = (
                                        stats["modules"].get(module, 0) + module_count
                                    )
                                stats["rows"] += module_count
                                unique_items += module_count

                    stats["hosts_fetched"] = finished
                    asset_batch.phase = f"拉取主机资产明细 {finished}/{total_hosts}"
                    asset_batch.percent = min(96, 2 + int(94 * finished / total_hosts))

                    if len(buffer) >= UPSERT_CHUNK:
                        _flush_items(
                            db, list(buffer.values()), stats,
                            skip_unchanged=import_mode == "incremental",
                        )
                        buffer.clear()
                    if (
                        time.monotonic() - last_commit >= PROGRESS_COMMIT_SECONDS
                        or finished == total_hosts
                    ):
                        asset_batch.stats = dict(stats)
                        db.commit()
                        last_commit = time.monotonic()

        if buffer:
            _flush_items(
                db, list(buffer.values()), stats,
                skip_unchanged=import_mode == "incremental",
            )
            buffer.clear()

        # 全量删除：本次未出现且主机详情处理成功的旧明细
        deleted_items = 0
        if import_mode == "full" and not limited:
            delete_query = db.query(JiaotuAssetItem).filter(
                JiaotuAssetItem.jiaotu_device_id == device.id,
                JiaotuAssetItem.batch_id != asset_batch.id,
            )
            if failed_uuids:
                delete_query = delete_query.filter(
                    JiaotuAssetItem.machine_uuid.notin_(failed_uuids)
                )
            deleted_items = delete_query.delete(synchronize_session=False)
        stats["deleted"] = deleted_items

        live_items = int(
            db.query(func.count(JiaotuAssetItem.id))
            .filter(JiaotuAssetItem.jiaotu_device_id == device.id)
            .scalar() or 0
        )
        complete = not failed_uuids
        asset_consistent = (
            complete
            and not limited
            and import_mode == "full"
            and stats["skipped"] == 0
            and live_items == unique_items
        )
        asset_batch.excel_rows = stats["rows"]
        asset_batch.unique_source_ids = unique_items
        asset_batch.inserted = stats["inserted"]
        asset_batch.updated = stats["updated"]
        asset_batch.deleted = deleted_items
        asset_batch.skipped = stats["skipped"]
        asset_batch.live_count = live_items
        asset_batch.consistent = int(asset_consistent)
        asset_batch.status = "success" if complete and not limited else "partial"
        asset_batch.phase = "完成" if complete and not limited else "部分完成"
        asset_batch.percent = 100
        asset_batch.stats = dict(stats)
        asset_batch.duration_ms = int((time.perf_counter() - started) * 1000)
        asset_notes = [
            f"来源设备：{device.name}",
            f"主机范围：{total_hosts} 台",
            "增量同步：仅新增/更新" if import_mode == "incremental" else "全量同步",
        ]
        if failed_uuids:
            asset_notes.append(f"详情拉取失败主机 {len(failed_uuids)} 台（已保留旧数据）")
        if limited:
            asset_notes.append(f"仅同步前 {limit} 台主机，未做全量删除")
        if stats["skipped"]:
            asset_notes.append(f"无法识别名称跳过 {stats['skipped']} 条")
        asset_batch.note = "；".join(asset_notes)

        device.status = "online"
        device.last_heartbeat = beijing_now()
        device.last_test_error = None
        device.last_test_latency_ms = asset_batch.duration_ms
        db.commit()

        record_device_call(
            db,
            device=device,
            action=None,
            source="asset_sync",
            user_id=user_id,
            request_summary=f"POST {HOST_LIST_PATH} + {HOST_DETAIL_PATH}",
            response_summary=(
                f"hosts={live_hosts} failed={len(failed_uuids)} "
                f"items={live_items}"
            ),
            status="success" if asset_batch.status == "success" else "partial",
            latency_ms=asset_batch.duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        duration = int((time.perf_counter() - started) * 1000)
        try:
            for batch_id, label in ((host_batch_id, "主机"), (asset_batch_id, "资产明细")):
                batch = db.query(GovCloudImportBatch).filter(
                    GovCloudImportBatch.id == batch_id
                ).first()
                if batch is not None and (batch.status or "") not in ("success", "partial"):
                    batch.status = "failed"
                    batch.phase = "失败"
                    batch.percent = 100
                    batch.note = f"椒图{label}同步失败: {exc}"[:2000]
                    batch.stats = dict(stats)
                    batch.duration_ms = duration
            device.status = "abnormal"
            device.last_test_error = f"椒图资产同步失败: {exc}"[:2000]
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
            request_summary=f"POST {HOST_LIST_PATH} + {HOST_DETAIL_PATH}",
            response_summary=None,
            status="failed",
            latency_ms=duration,
            error_message=str(exc)[:2000],
        )
        raise RuntimeError(f"椒图资产同步失败: {exc}") from exc

    logger.info(
        "椒图资产同步完成 device=%s(%d) mode=%s hosts=%d items=%d status=%s",
        device.name, device.id, import_mode, live_hosts, live_items, asset_batch.status,
    )
    return {
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
        "host_status": host_batch.status,
        "asset_status": asset_batch.status,
        "api_total": api_total,
        "hosts_fetched": len(host_rows),
        "hosts_failed": len(failed_uuids),
        "host_live_count": live_hosts,
        "asset_rows": stats["rows"],
        "asset_unique": unique_items,
        "asset_live_count": live_items,
        "consistent": bool(asset_consistent),
        "duration_ms": asset_batch.duration_ms,
        "stats": stats,
        "note": asset_batch.note,
        "host_batch": host_batch.to_dict(),
        "asset_batch": asset_batch.to_dict(),
    }


def test_jiaotu_connection(
    device: Device,
    *,
    timeout: float = 10,
    verify: bool = False,
) -> dict:
    """测试椒图连通性：拉取 1 台主机验证授权码与地址。"""
    started = time.perf_counter()
    data = _post(
        device,
        HOST_LIST_PATH,
        {"currentPage": 1, "maxResults": 1},
        timeout=timeout,
        verify=verify,
    )
    rows = data.get("list") or []
    return {
        "success": True,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "total": int(data.get("total") or 0),
        "sample_host": str((rows[0] or {}).get("machineName") or "") if rows else "",
    }
