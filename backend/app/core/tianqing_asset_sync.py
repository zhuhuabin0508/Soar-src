"""奇安信天擎终端资产同步：通过天擎 ODP GraphQL 接口拉取终端清单入库。

凭据复用设备管理（devices 表 auth_type=tianqing）：
- ``api_url``：天擎 grpc-web 地址（一般端口 30081，注意不是控制台 30082）；
- ``api_key``：应用 AppKey；
- ``password``：应用 AppSecret（加密存储）；
- 组织 ID（oid）与资产 ID（asset_id）通过 ``/license_component/v1/get/asset`` 自动获取。

入库口径与青藤主机同步/政务云 Excel 导入一致：
- 批次表 ``GovCloudImportBatch``：resource_type = ``tianqing_endpoint:<设备ID>``，每台天擎一个维度；
- filename = ``API同步:<设备名>``；
- full 全量对齐：删除该设备下本次未出现的旧记录；incremental 仅新增/更新；
- 一致性：库内该设备 live 数 == 本次唯一 source_id 数。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from datetime import datetime, timedelta
from typing import Any, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.security import decrypt_device_secret, validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import record_device_call
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.tianqing_endpoint import (
    TIANQING_ARCH_LABELS,
    TIANQING_OS_LABELS,
    TIANQING_UPDATE_COLS,
    TianqingEndpointAsset,
)

logger = logging.getLogger(__name__)

# 单页拉取条数：ODP 文档建议不超过 1000
PAGE_SIZE = 1000
# 入库分块
UPSERT_CHUNK = 500
# 分页上限，防异常死循环（1000 条/页 x 500 页 = 50 万条）
MAX_PAGES = 500
# GraphQL 固定项目名
ODP_PROJECT = "skylar.business.odp"

# 已消费的 meta 字段（这些不进 extra）
_CONSUMED_META_KEYS = frozenset({
    "name", "ip", "report_ip", "mac", "tos", "client_type", "login_account",
    "domain", "computer_working_group", "system_language", "activation",
})


def get_tianqing_devices(db: Session) -> list[Device]:
    """纳入资产发现的天擎设备：已启用且 api_url / AppKey / AppSecret 已配置。"""
    rows = (
        db.query(Device)
        .filter(Device.auth_type == "tianqing", Device.enabled.is_(True))
        .order_by(Device.id)
        .all()
    )
    return [
        d for d in rows
        if (d.api_url or "").strip()
        and (d.api_key or "").strip()
        and (d.password or "").strip()
    ]


def _normalize_base_url(device: Device) -> str:
    """规范化 grpc-web 地址：允许省略 https://，去掉尾部斜杠。"""
    base = (device.api_url or "").strip().rstrip("/")
    if not base:
        raise ValueError("设备未配置 api_url（天擎 grpc-web 地址，一般端口 30081）")
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"
    return base


def _sign_headers(device: Device) -> dict[str, str]:
    """生成天擎 ODP 的 ZEUS-HMAC-SHA256 鉴权头。

    stringToSign = ``appKey:{appKey}&nonce:{nonce}&timestamp:{timestamp}``
    signature = HMAC-SHA256(AppSecret, stringToSign) 的十六进制小写。
    """
    app_key = decrypt_device_secret(device.api_key or "").strip()
    app_secret = decrypt_device_secret(device.password or "").strip()
    if not app_key or not app_secret:
        raise ValueError("设备未配置天擎 AppKey / AppSecret")
    nonce = str(secrets.randbelow(10**9))
    timestamp = str(int(time.time()))
    to_sign = f"appKey:{app_key}&nonce:{nonce}&timestamp:{timestamp}"
    signature = hmac.new(
        app_secret.encode("utf-8"), to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        "Authorization": (
            f"ZEUS-HMAC-SHA256 appKey={app_key},nonce={nonce},"
            f"timestamp={timestamp},version=1.0.0,signature={signature}"
        ),
    }


def _http_client(timeout: float, verify: bool) -> httpx.Client:
    # 设备对接走本机网络直连，忽略代理环境变量
    return httpx.Client(timeout=timeout, verify=verify, trust_env=False)


def get_asset_ids(device: Device, *, timeout: float = 30, verify: bool = False) -> tuple[str, str]:
    """获取天擎组织 ID（oid）与资产 ID（asset_id）。"""
    base_url = _normalize_base_url(device)
    validate_outbound_url(base_url, field="天擎 api_url")
    url = f"{base_url}/license_component/v1/get/asset"
    with _http_client(timeout, verify) as client:
        resp = client.get(url)
    if resp.status_code >= 400:
        raise RuntimeError(f"天擎获取组织/资产 ID 失败 HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json() or {}
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"天擎获取组织/资产 ID 返回非 JSON: {resp.text[:200]}") from None
    oid = str(data.get("asset_oid") or "").strip()
    asset_id = str(data.get("asset_id") or "").strip()
    if not oid or not asset_id:
        raise RuntimeError(f"天擎组织/资产 ID 响应缺少字段: {str(data)[:200]}")
    return oid, asset_id


def _gql(
    device: Device,
    query: str,
    *,
    timeout: float = 30,
    verify: bool = False,
    client: httpx.Client | None = None,
) -> dict:
    """执行天擎 ODP GraphQL 查询，返回 ``data``。

    传入 ``client`` 时复用连接（软件清单按终端逐台查询，避免每台重复 TLS 握手）。
    """
    base_url = _normalize_base_url(device)
    validate_outbound_url(base_url, field="天擎 api_url")
    url = f"{base_url}/Gql/S"
    payload = {"project": ODP_PROJECT, "query": query, "variables": {}}
    if client is not None:
        resp = client.post(url, headers=_sign_headers(device), json=payload)
    else:
        with _http_client(timeout, verify) as own_client:
            resp = own_client.post(url, headers=_sign_headers(device), json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"天擎 ODP 请求失败 HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        body = resp.json() or {}
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"天擎 ODP 返回非 JSON: {resp.text[:200]}") from None
    data = body.get("data")
    errors = body.get("errors") or []
    if data is None:
        first = (errors[0] or {}).get("message") if errors else ""
        raise RuntimeError(f"天擎 ODP 查询失败: {first or str(body)[:300]}")
    # 部分可选字段为空时 ODP 会返回 errors；只要 data 非空就继续使用
    if errors:
        logger.info("天擎 ODP 返回 %d 条字段级告警（忽略）", len(errors))
    return data


def get_version(device: Device, oid: str, asset_id: str, *, timeout: float = 30, verify: bool = False) -> str:
    query = (
        '{ product(key: { id: "skylar_console", asset_id: { oid: "%s", id: "%s" } }) '
        "{ ver { base_version } } }"
    ) % (oid, asset_id)
    data = _gql(device, query, timeout=timeout, verify=verify)
    return str(((data.get("product") or {}).get("ver") or {}).get("base_version") or "")


def _get_root_path(device: Device, oid: str, asset_id: str, *, timeout: float, verify: bool) -> str:
    query = (
        '{ tree(key: { id: "", asset_id: { oid: "%s", id: "%s" } }) { '
        "nodes(node_meta_filter: { is_root: true }, limit: 1, offset: 0) { "
        "relation_entitys { key { id } meta { name path } } } } }"
    ) % (oid, asset_id)
    data = _gql(device, query, timeout=timeout, verify=verify)
    nodes = (((data.get("tree") or {}).get("nodes") or {}).get("relation_entitys") or [])
    if not nodes:
        raise RuntimeError("天擎未返回根分组，无法拉取终端清单")
    path = str(((nodes[0].get("meta") or {})).get("path") or "").strip()
    if not path:
        raise RuntimeError("天擎根分组缺少 path，无法拉取终端清单")
    return path


def _clients_query(limit: int, offset: int, root_path: str) -> str:
    return (
        "{ free_clients(limit: %d, offset: %d, extra_filter: { "
        "order: [ { order_field: \"client.client_meta.client_id\", asc: true } ], "
        "ast_node: { and: { children: [ { leaf: { key: \"node_path\", operator: 6, "
        "string_value: \"%s\" } } ] } } }) { "
        "count relation_entitys { key { id } "
        "meta { name ip report_ip mac tos { os arch dist version { kernel_version version } } "
        "client_type login_account domain computer_working_group system_language activation } "
        "normal_node { relation_entity { meta { name path } } } "
        "online_info { is_online last_time } "
        "asset_version { main_program_version virus_version } } } }"
    ) % (limit, offset, root_path)


def fetch_all_terminals(
    device: Device,
    oid: str,
    asset_id: str,
    *,
    timeout: float = 30,
    verify: bool = False,
) -> tuple[list[dict], int]:
    """分页拉取全网终端，返回 (rows, 接口报告总数)。"""
    root_path = _get_root_path(device, oid, asset_id, timeout=timeout, verify=verify)
    rows: list[dict] = []
    total = 0
    offset = 0
    for _ in range(MAX_PAGES):
        data = _gql(
            device,
            _clients_query(PAGE_SIZE, offset, root_path),
            timeout=timeout,
            verify=verify,
        )
        payload = data.get("free_clients") or {}
        if not payload:
            # data 有值但 free_clients 为 null：视为接口异常，避免全量同步误删库内数据
            raise RuntimeError("天擎终端查询返回空数据（free_clients 为 null）")
        page_rows = payload.get("relation_entitys") or []
        total = int(payload.get("count") or 0)
        rows.extend(page_rows)
        offset += len(page_rows)
        if not page_rows or len(page_rows) < PAGE_SIZE or (total and offset >= total):
            break
    logger.info("天擎终端拉取完成: device=%s total=%s fetched=%d", device.name, total, len(rows))
    return rows, total


def _fmt_ts(v: Any) -> str:
    """ODP 时间转北京时间字符串。

    ODP 返回 UTC（如 ``2026-11-25T12:18:16.000604820Z``），统一转为
    ``YYYY-MM-DD HH:MM:SS`` 的北京时间；普通字符串原样截断。
    """
    if v is None:
        return ""
    s = str(v).strip()
    if s.endswith("Z"):
        base = s[:-1]
        if "." in base:
            base = base.split(".", 1)[0]
        try:
            dt = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S") + timedelta(hours=8)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    return s.replace("T", " ")[:19]


def _enum_label(mapping: dict[int, str], v: Any) -> str:
    try:
        return mapping.get(int(v), str(v))
    except (TypeError, ValueError):
        return str(v or "")


def _to_bool(v: Any) -> Optional[bool]:
    if v is None:
        return None
    return bool(v)


def _row_to_values(device: Device, row: dict, batch_id: int, now) -> Optional[dict]:
    """ODP terminal row → 入库 values；缺终端 ID 返回 None（跳过）。"""
    key = row.get("key") or {}
    client_id = str(key.get("id") or "").strip()
    if not client_id:
        return None
    meta = row.get("meta") or {}
    tos = meta.get("tos") or {}
    version = tos.get("version") or {}
    online = row.get("online_info") or {}
    asset_version = row.get("asset_version") or {}
    normal = ((row.get("normal_node") or {}).get("relation_entity") or {}).get("meta") or {}

    values = {
        "source_id": f"{device.id}:{client_id}"[:160],
        "tianqing_device_id": device.id,
        "tianqing_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "created_at": now,
        "updated_at": now,
        "client_id": client_id[:128],
        "computer_name": str(meta.get("name") or "")[:255],
        "ip": str(meta.get("ip") or "")[:64],
        "report_ip": str(meta.get("report_ip") or "")[:64],
        "mac": str(meta.get("mac") or "")[:64],
        "os_type": _enum_label(TIANQING_OS_LABELS, tos.get("os")),
        "os_name": str(tos.get("dist") or ""),
        "os_version": str(version.get("version") or "")[:255],
        "kernel_version": str(version.get("kernel_version") or ""),
        "arch": _enum_label(TIANQING_ARCH_LABELS, tos.get("arch")),
        "client_type": str(meta.get("client_type") or "")[:64],
        "group_name": str(normal.get("name") or "")[:255],
        "group_path": str(normal.get("path") or "")[:1024],
        "online_status": _to_bool(online.get("is_online")),
        "last_online_time": _fmt_ts(online.get("last_time")),
        "activation": _to_bool(meta.get("activation")),
        "login_account": str(meta.get("login_account") or "")[:128],
        "domain": str(meta.get("domain") or "")[:128],
        "computer_working_group": str(meta.get("computer_working_group") or "")[:128],
        "system_language": str(meta.get("system_language") or "")[:32],
        "main_program_version": str(asset_version.get("main_program_version") or "")[:64],
        "virus_version": str(asset_version.get("virus_version") or "")[:64],
    }
    # 未知 meta 字段兜底
    values["extra"] = {
        k: v for k, v in meta.items() if k not in _CONSUMED_META_KEYS
    }
    return values


def sync_device_endpoints(
    db: Session,
    device: Device,
    *,
    user_id: int = 0,
    mode: str = "full",
) -> dict:
    """同步单台天擎设备的终端清单入库。"""
    import_mode = mode if mode in ("full", "incremental") else "full"
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()
    phase = "获取组织/资产 ID"
    try:
        oid, asset_id = get_asset_ids(device, timeout=timeout, verify=verify)
        phase = "拉取终端清单"
        entries, api_total = fetch_all_terminals(
            device, oid, asset_id, timeout=timeout, verify=verify
        )

        phase = "写入数据库"
        now = beijing_now()
        values_map: dict[str, dict] = {}
        skipped = 0
        for row in entries:
            values = _row_to_values(device, row, 0, now)
            if values is None:
                skipped += 1
                continue
            values_map[values["source_id"]] = values
        unique_values = list(values_map.values())
        duplicate = len(entries) - skipped - len(unique_values)

        existing_ids = {
            r[0]
            for r in db.query(TianqingEndpointAsset.source_id)
            .filter(TianqingEndpointAsset.tianqing_device_id == device.id)
            .all()
        }
        unique_ids = set(values_map.keys())
        inserted = len(unique_ids - existing_ids)
        updated = len(unique_ids & existing_ids)
        deleted = len(existing_ids - unique_ids) if import_mode == "full" else 0

        batch = GovCloudImportBatch(
            resource_type=f"tianqing_endpoint:{device.id}",
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
        update_cols = [c for c in TIANQING_UPDATE_COLS]
        for i in range(0, len(unique_values), UPSERT_CHUNK):
            chunk = unique_values[i:i + UPSERT_CHUNK]
            stmt = insert(TianqingEndpointAsset).values(chunk)
            excluded = stmt.excluded
            stmt = stmt.on_conflict_do_update(
                index_elements=["source_id"],
                set_={col: getattr(excluded, col) for col in update_cols},
            )
            db.execute(stmt)

        if import_mode == "full":
            db.query(TianqingEndpointAsset).filter(
                TianqingEndpointAsset.tianqing_device_id == device.id,
                TianqingEndpointAsset.batch_id != batch.id,
            ).delete(synchronize_session=False)

        live = int(
            db.query(func.count(TianqingEndpointAsset.id))
            .filter(TianqingEndpointAsset.tianqing_device_id == device.id)
            .scalar() or 0
        )
        consistent = (live == len(unique_ids) and skipped == 0) if import_mode == "full" else skipped == 0
        notes = [
            "全量同步：已删除天擎平台已不存在的终端记录" if import_mode == "full"
            else "增量同步：仅新增/更新，未删除库内既有记录",
            f"来源设备：{device.name}",
            f"天擎接口报告终端总数：{api_total}",
        ]
        if duplicate:
            notes.append(f"API 返回重复终端 ID {duplicate} 条，已按最后一条保留")
        if skipped:
            notes.append(f"缺少终端 ID 跳过 {skipped} 条")
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
            request_summary="GET /license_component/v1/get/asset + POST /Gql/S",
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
        request_summary="POST /Gql/S free_clients",
        response_summary=f"rows={len(entries)} unique={len(unique_ids)} live={live}",
        status="success",
        latency_ms=duration_ms,
    )
    logger.info(
        "天擎终端同步: device=%s(%d) mode=%s rows=%d unique=%d live=%d "
        "inserted=%d updated=%d deleted=%d consistent=%s",
        device.name, device.id, import_mode, len(entries), len(unique_ids), live,
        inserted, updated, deleted, consistent,
    )
    return {
        "resource_type": f"tianqing_endpoint:{device.id}",
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
        "excel_rows": len(entries),
        "api_total": api_total,
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


def test_tianqing_connection(
    device: Device,
    *,
    timeout: float = 10,
    verify: bool = False,
) -> dict:
    """测试天擎 ODP 连通性：获取组织/资产 ID 并查询版本。"""
    started = time.perf_counter()
    oid, asset_id = get_asset_ids(device, timeout=timeout, verify=verify)
    version = get_version(device, oid, asset_id, timeout=timeout, verify=verify)
    return {
        "success": True,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "asset_oid": oid,
        "asset_id": asset_id,
        "version": version,
    }
