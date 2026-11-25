"""奇安信天擎终端软件资产同步：逐台终端拉取软件清单入库。

数据来源：ODP GraphQL ``softid_clientid``（按终端 client_id 分页查询）。
终端范围复用 ``tianqing_endpoints`` 已同步的终端，避免重复拉取全网清单。

设计要点：
- 批次 ``GovCloudImportBatch``：resource_type = ``tianqing_software:<设备ID>``；
- 逐台终端串行拉取（ODP 单终端接口），复用 HTTP 连接降低开销；
- 每 500 条分块 upsert，进度（终端数 / 百分比 / 失败终端）实时写批次供前端轮询；
- full 全量：删除本次未出现且终端拉取成功的旧记录；拉取失败的终端保留旧数据；
- 软件身份按 ``soft_id``（缺失时按名称+版本）生成，软件升级原地更新。
"""
from __future__ import annotations

import hashlib
import logging
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.security import validate_outbound_url
from app.core.tianqing_asset_sync import _fmt_ts, _gql, _http_client, get_asset_ids
from app.core.timezone import beijing_now
from app.devices.action_executor import record_device_call
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.tianqing_endpoint import TianqingEndpointAsset
from app.models.tianqing_software import (
    TIANQING_SOFTWARE_UPDATE_COLS,
    TianqingSoftwareAsset,
)

logger = logging.getLogger(__name__)

# 单页拉取条数：ODP 文档建议不超过 1000
PAGE_SIZE = 1000
# 单终端分页上限，防异常死循环（1000 条/页 x 20 页 = 2 万条软件）
MAX_PAGES_PER_CLIENT = 20
# 入库分块
UPSERT_CHUNK = 500
# 进度落库间隔（秒）：终端逐台拉取，避免每台都 commit
PROGRESS_COMMIT_SECONDS = 5.0
# 并发拉取终端数：万级终端串行耗时过长；DB 写入仍在主线程，仅网络请求并行
FETCH_CONCURRENCY = 8
FETCH_BATCH = FETCH_CONCURRENCY * 4
# 失败终端明细最多保留条数（stats 仅用于排障展示）
MAX_FAILED_DETAILS = 100

# 已消费的软件字段（这些不进 extra）
_CONSUMED_SOFT_KEYS = frozenset({
    "corp", "install_time", "soft_name", "version", "soft_id",
    "install_source", "is_update", "license", "newest_ver", "size",
})

_PLACEHOLDER_VERSIONS = frozenset({
    "", "-", "--", "unknown", "未知", "n/a", "na", "none", "null", "nil",
    "0", "0.0", "0.0.0", "?", "??", "not installed", "未采集", "未获取", "无",
})

_BJ_TZ = timezone(timedelta(hours=8))


def _norm_text(value: Any) -> str:
    """软件名归一化：NFKC、去首尾空白、小写。"""
    return unicodedata.normalize("NFKC", str(value or "")).strip().lower()


def _norm_version(value: Any) -> str:
    """版本轻量归一：去 epoch、占位值归一为空。"""
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


def _gql_str(value: Any) -> str:
    """GraphQL 字符串转义（client_id / oid / asset_id 均来自接口或设备配置）。"""
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _fmt_install_time(value: Any) -> str:
    """安装时间格式化：ODP 返回 Unix 秒级时间戳（字符串），统一转北京时间。"""
    s = str(value or "").strip()
    if s in ("", "0", "0.0"):
        return ""
    if s.isdigit() and len(s) >= 10:
        try:
            dt = datetime.fromtimestamp(int(s), tz=_BJ_TZ)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            pass
    return _fmt_ts(value)


def build_source_id(
    device_id: int,
    client_id: str,
    soft_id: str,
    name_norm: str,
    version_norm: str,
) -> str:
    """软件唯一键：优先按天擎软件 ID，缺 ID 时按名称+版本（升级原地更新）。"""
    identity = soft_id or f"{name_norm}|{version_norm}"
    digest = hashlib.sha1(identity.encode("utf-8")).hexdigest()[:20]
    return f"{device_id}:{client_id}:{digest}"[:160]


def _software_query(client_id: str, oid: str, asset_id: str, limit: int, offset: int) -> str:
    return (
        '{ softid_clientid(req_filter:{client_id:{id:"%s", asset_id:{oid:"%s", id:"%s"}}, '
        'option:"1"}, limit:%d, offset:%d){ collects { corp install_time soft_name version '
        "soft_id{id} install_source is_update license newest_ver size } } }"
    ) % (_gql_str(client_id), _gql_str(oid), _gql_str(asset_id), limit, offset)


def fetch_client_software(
    device: Device,
    oid: str,
    asset_id: str,
    client_id: str,
    *,
    timeout: float = 30,
    verify: bool = False,
    client=None,
) -> list[dict]:
    """分页拉取单台终端的软件清单。

    Raises:
        RuntimeError: 接口返回 ``softid_clientid`` 为 null（终端离线/接口异常），
            调用方应保留该终端旧数据而不是当作「无软件」清空。
    """
    rows: list[dict] = []
    offset = 0
    for _ in range(MAX_PAGES_PER_CLIENT):
        data = _gql(
            device,
            _software_query(client_id, oid, asset_id, PAGE_SIZE, offset),
            timeout=timeout,
            verify=verify,
            client=client,
        )
        payload = data.get("softid_clientid")
        if payload is None:
            raise RuntimeError("天擎终端软件查询返回空数据（softid_clientid 为 null）")
        page_rows = payload.get("collects") or []
        rows.extend(page_rows)
        offset += len(page_rows)
        if len(page_rows) < PAGE_SIZE:
            break
    return rows


def _row_to_values(
    device: Device,
    endpoint,
    row: dict,
    batch_id: int,
    now,
) -> Optional[dict]:
    """ODP 软件 row → 入库 values；缺软件名返回 None（跳过）。"""
    soft_name = str(row.get("soft_name") or "").strip()
    if not soft_name:
        return None
    soft_id_raw = row.get("soft_id")
    if isinstance(soft_id_raw, dict):
        soft_id = str(soft_id_raw.get("id") or "").strip()
    else:
        soft_id = str(soft_id_raw or "").strip()
    version = str(row.get("version") or "").strip()
    name_norm = _norm_text(soft_name)
    version_norm = _norm_version(version)
    client_id = str(getattr(endpoint, "client_id", "") or "")
    is_update = row.get("is_update")

    return {
        "source_id": build_source_id(
            device.id, client_id, soft_id, name_norm, version_norm,
        ),
        "tianqing_device_id": device.id,
        "tianqing_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "client_id": client_id[:128],
        "computer_name": str(getattr(endpoint, "computer_name", "") or "")[:255],
        "ip": str(getattr(endpoint, "ip", "") or "")[:64],
        "os_type": str(getattr(endpoint, "os_type", "") or "")[:32],
        "group_name": str(getattr(endpoint, "group_name", "") or "")[:255],
        "soft_name": soft_name[:512],
        "name_norm": name_norm[:512],
        "version": version[:255],
        "version_norm": version_norm[:255],
        "soft_id": soft_id[:64],
        "corp": str(row.get("corp") or "")[:255],
        "install_source": str(row.get("install_source") or "")[:128],
        "install_time": _fmt_install_time(row.get("install_time")),
        "license": str(row.get("license") or "")[:64],
        "newest_ver": str(row.get("newest_ver") or "")[:255],
        "size": str(row.get("size") or "")[:32],
        "is_update": bool(is_update) if is_update is not None else None,
        "extra": {k: v for k, v in row.items() if k not in _CONSUMED_SOFT_KEYS},
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
        for r in db.query(TianqingSoftwareAsset.source_id)
        .filter(TianqingSoftwareAsset.source_id.in_(source_ids))
        .all()
    }
    stats["inserted"] = stats.get("inserted", 0) + len(set(source_ids) - existing)
    stats["updated"] = stats.get("updated", 0) + len(set(source_ids) & existing)

    stmt = insert(TianqingSoftwareAsset).values(values)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["source_id"],
        set_={col: getattr(excluded, col) for col in TIANQING_SOFTWARE_UPDATE_COLS},
    )
    db.execute(stmt)


def sync_device_software(
    db: Session,
    device: Device,
    batch_id: int,
    *,
    user_id: int = 0,
    mode: str = "full",
    limit: int = 0,
) -> dict[str, Any]:
    """同步单台天擎设备的终端软件清单到指定批次。

    Args:
        db: 数据库会话。
        device: 天擎设备（auth_type=tianqing）。
        batch_id: 预先创建的批次 ID（status=pending）。
        user_id: 触发用户 ID。
        mode: full 全量对齐 / incremental 仅新增更新。
        limit: 仅同步前 N 台终端（0 = 全部；大于 0 时不做全量删除）。

    Raises:
        ValueError: 批次不存在 / 与设备不匹配。
        RuntimeError: 未同步终端 / 组织资产 ID 获取失败 / 所有终端拉取失败。
    """
    import_mode = mode if mode in ("full", "incremental") else "full"
    if limit < 0:
        limit = 0

    batch = db.query(GovCloudImportBatch).filter(GovCloudImportBatch.id == batch_id).first()
    if batch is None:
        raise ValueError(f"同步批次不存在: {batch_id}")
    expected_type = f"tianqing_software:{device.id}"
    if batch.resource_type != expected_type:
        raise ValueError(f"批次与设备不匹配: {batch.resource_type} != {expected_type}")

    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="天擎 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()

    batch.status = "running"
    batch.phase = "获取组织/资产 ID"
    batch.percent = 1
    batch.stats = {}
    db.commit()

    stats: dict[str, Any] = {
        "terminals_total": 0,
        "terminals_done": 0,
        "terminals_failed": 0,
        "failed_terminals": [],
        "rows": 0,
        "inserted": 0,
        "updated": 0,
        "skipped": 0,
        "deleted": 0,
    }
    unique_count = 0
    failed_clients: set[str] = set()
    buffer: dict[str, dict] = {}
    last_commit = time.monotonic()

    try:
        oid, asset_id = get_asset_ids(device, timeout=timeout, verify=verify)

        endpoints_query = (
            db.query(
                TianqingEndpointAsset.client_id,
                TianqingEndpointAsset.computer_name,
                TianqingEndpointAsset.ip,
                TianqingEndpointAsset.os_type,
                TianqingEndpointAsset.group_name,
            )
            .filter(
                TianqingEndpointAsset.tianqing_device_id == device.id,
                TianqingEndpointAsset.client_id != "",
            )
            .order_by(TianqingEndpointAsset.id)
        )
        if limit:
            endpoints_query = endpoints_query.limit(limit)
        endpoints = endpoints_query.all()
        total = len(endpoints)
        if not total:
            raise RuntimeError("库内没有天擎终端，请先同步天擎终端后再同步组件")

        stats["terminals_total"] = total
        batch.phase = f"拉取终端软件 0/{total}"
        batch.percent = 3
        batch.stats = dict(stats)
        db.commit()

        now = beijing_now()
        # 分批并发拉取终端软件；DB 写入仍在主线程顺序执行
        with _http_client(timeout, verify) as client, ThreadPoolExecutor(
            max_workers=FETCH_CONCURRENCY
        ) as pool:
            finished = 0
            for start in range(0, total, FETCH_BATCH):
                chunk = endpoints[start:start + FETCH_BATCH]
                pending = [
                    (
                        endpoint,
                        pool.submit(
                            fetch_client_software,
                            device, oid, asset_id, str(endpoint.client_id or ""),
                            timeout=timeout, verify=verify, client=client,
                        ),
                    )
                    for endpoint in chunk
                ]
                for endpoint, future in pending:
                    finished += 1
                    client_id = str(endpoint.client_id or "")
                    try:
                        rows = future.result()
                    except Exception as exc:  # noqa: BLE001
                        # 网络/接口异常：保留该终端旧数据，继续其它终端
                        failed_clients.add(client_id)
                        stats["terminals_failed"] = len(failed_clients)
                        if len(stats["failed_terminals"]) < MAX_FAILED_DETAILS:
                            stats["failed_terminals"].append({
                                "client_id": client_id,
                                "computer_name": str(endpoint.computer_name or ""),
                                "error": str(exc)[:200],
                            })
                        logger.warning(
                            "天擎终端软件拉取失败 device=%s client=%s err=%s",
                            device.name, client_id, exc,
                        )
                    else:
                        stats["rows"] += len(rows)
                        client_ids: set[str] = set()
                        for row in rows:
                            values = _row_to_values(device, endpoint, row, batch.id, now)
                            if values is None:
                                stats["skipped"] += 1
                                continue
                            sid = values["source_id"]
                            if sid in client_ids:
                                continue
                            client_ids.add(sid)
                            buffer[sid] = values
                        unique_count += len(client_ids)

                    stats["terminals_done"] = finished
                    batch.phase = f"拉取终端软件 {finished}/{total}"
                    batch.percent = min(96, 3 + int(93 * finished / total))

                    if len(buffer) >= UPSERT_CHUNK:
                        _flush_values(db, list(buffer.values()), stats)
                        buffer.clear()
                    if (
                        time.monotonic() - last_commit >= PROGRESS_COMMIT_SECONDS
                        or finished == total
                    ):
                        batch.stats = dict(stats)
                        db.commit()
                        last_commit = time.monotonic()

        if buffer:
            _flush_values(db, list(buffer.values()), stats)
            buffer.clear()

        if len(failed_clients) == total:
            raise RuntimeError("所有终端软件拉取失败，已保留旧数据")

        # 全量对齐：删除本次未出现的旧记录；拉取失败的终端保留旧数据
        deleted = 0
        if import_mode == "full" and not limit:
            delete_query = db.query(TianqingSoftwareAsset).filter(
                TianqingSoftwareAsset.tianqing_device_id == device.id,
                TianqingSoftwareAsset.batch_id != batch.id,
            )
            if failed_clients:
                delete_query = delete_query.filter(
                    TianqingSoftwareAsset.client_id.notin_(failed_clients)
                )
            deleted = delete_query.delete(synchronize_session=False)
        stats["deleted"] = deleted

        live = int(
            db.query(func.count(TianqingSoftwareAsset.id))
            .filter(TianqingSoftwareAsset.tianqing_device_id == device.id)
            .scalar() or 0
        )
        complete = not failed_clients
        limited = bool(limit)
        consistent = (
            complete
            and not limited
            and stats["skipped"] == 0
            and import_mode == "full"
            and live == unique_count
        )

        batch.excel_rows = stats["rows"]
        batch.unique_source_ids = unique_count
        batch.inserted = stats["inserted"]
        batch.updated = stats["updated"]
        batch.deleted = deleted
        batch.skipped = stats["skipped"]
        batch.live_count = live
        batch.consistent = int(consistent)
        # 仅同步部分终端（调试）不算完成，标记 partial 避免误显示「已对齐」
        batch.status = "success" if complete and not limited else "partial"
        batch.phase = "完成" if complete and not limited else "部分完成"
        batch.percent = 100
        batch.stats = dict(stats)
        batch.duration_ms = int((time.perf_counter() - started) * 1000)

        notes = [
            f"来源设备：{device.name}",
            f"终端范围：{total} 台"
            + (f"（仅前 {limit} 台，未做全量删除）" if limit else ""),
            "增量同步：仅新增/更新" if import_mode == "incremental" else "全量同步",
        ]
        if failed_clients:
            notes.append(f"拉取失败终端 {len(failed_clients)} 台（已保留旧数据）")
        if stats["skipped"]:
            notes.append(f"缺少软件名跳过 {stats['skipped']} 条")
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
            source="software_sync",
            user_id=user_id,
            request_summary="POST /Gql/S softid_clientid",
            response_summary=(
                f"terminals={total} failed={len(failed_clients)} "
                f"rows={stats['rows']} live={live}"
            ),
            status="success" if batch.status == "success" else "partial",
            latency_ms=batch.duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        duration = int((time.perf_counter() - started) * 1000)
        try:
            batch = db.query(GovCloudImportBatch).filter(
                GovCloudImportBatch.id == batch_id
            ).first()
            if batch is not None:
                batch.status = "failed"
                batch.phase = "失败"
                batch.percent = 100
                batch.note = f"组件同步失败: {exc}"[:2000]
                batch.stats = dict(stats)
                batch.duration_ms = duration
            device.status = "abnormal"
            device.last_test_error = f"组件同步失败: {exc}"[:2000]
            device.last_heartbeat = beijing_now()
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        record_device_call(
            db,
            device=device,
            action=None,
            source="software_sync",
            user_id=user_id,
            request_summary="POST /Gql/S softid_clientid",
            response_summary=None,
            status="failed",
            latency_ms=duration,
            error_message=str(exc)[:2000],
        )
        raise RuntimeError(f"组件同步失败: {exc}") from exc

    logger.info(
        "天擎组件同步完成 device=%s(%d) mode=%s terminals=%d failed=%d "
        "rows=%d unique=%d live=%d status=%s",
        device.name, device.id, import_mode, total, len(failed_clients),
        batch.excel_rows, unique_count, live, batch.status,
    )
    return {
        "resource_type": f"tianqing_software:{device.id}",
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
        "status": batch.status,
        "terminals_total": total,
        "terminals_failed": len(failed_clients),
        "excel_rows": batch.excel_rows,
        "unique_source_ids": unique_count,
        "inserted": batch.inserted,
        "updated": batch.updated,
        "deleted": deleted,
        "skipped": batch.skipped,
        "live_count": live,
        "consistent": bool(consistent),
        "duration_ms": batch.duration_ms,
        "stats": stats,
        "note": batch.note,
        "batch": batch.to_dict(),
    }
