"""青藤组件清单同步：pkg / app / dbinfo / jar_pkg / webframe 落库。

协议复用设备管理（auth_type=qingteng）：
- 登录 ``_qingteng_login``，GET 签名 ``_qingteng_signheaders``；
- 分页 500/页，流式处理，每 1000 行分块 upsert；
- 单源行数上限，触顶标记 truncated 并保留旧数据；
- full 模式只清理「本次成功且未截断」来源的旧行，失败源不会误删。

与主机同步一致：批次写 ``GovCloudImportBatch``，成功后更新设备心跳，
失败写 ``device_call_logs`` 并置设备异常。
"""
from __future__ import annotations

import hashlib
import logging
import time
import unicodedata
from typing import Any, Iterable, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.qingteng_component_search import _parse
from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import _qingteng_login, _qingteng_signheaders, record_device_call
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch
from app.models.qingteng_component import (
    COMPONENT_SOURCE_LABELS,
    COMPONENT_SOURCES,
    QINGTENG_COMPONENT_UPDATE_COLS,
    QingtengComponentAsset,
)

logger = logging.getLogger(__name__)

PAGE_SIZE = 500
MAX_PAGES = 4000
UPSERT_CHUNK = 1000
# 单源行数上限：触顶后停止拉取并保留旧数据（full 模式不删除）
MAX_ROWS_PER_SOURCE = {
    "pkg": 500_000,
    "app": 300_000,
    "dbinfo": 300_000,
    "jar_pkg": 300_000,
    "webframe": 300_000,
}

# 各来源的接口与字段口径（集中维护 Windows/Linux 差异）
COMPONENT_SYNC_SPECS: dict[str, dict[str, Any]] = {
    "pkg": {
        "label": "安装包",
        "path": "/external/api/assets/pkg/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": ("version", "productVersion"),
        "path_field": "path",
        "type_field": "type",
        "publisher_field": "publisher",
        "port_field": None,
    },
    "app": {
        "label": "软件应用",
        "path": "/external/api/assets/app/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": ("version",),
        "path_field": "binPath",
        "type_field": "",
        "publisher_field": "",
        "port_field": None,
    },
    "dbinfo": {
        "label": "数据库",
        "path": "/external/api/assets/dbinfo/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": ("version",),
        "path_field": "confPath",
        "type_field": "protoType",
        "publisher_field": "",
        "port_field": "port",
    },
    "jar_pkg": {
        "label": "Jar 包",
        "path": "/external/api/assets/jar_pkg/linux",
        "os_types": ("linux",),
        "name_field": "name",
        "version_fields": ("version",),
        "path_field": "path",
        "type_field": "type",
        "publisher_field": "",
        "port_field": None,
    },
    "webframe": {
        "label": "Web 框架",
        "path": "/external/api/assets/webframe/{os}",
        "os_types": ("linux", "win"),
        "name_field": "name",
        "version_fields": ("version",),
        "path_field": "webAppDir",
        "type_field": "type",
        "publisher_field": "",
        "port_field": None,
    },
}

# 主机上下文字段（不进入 extra）
_HOST_KEYS = frozenset({
    "agentId", "hostname", "displayIp", "internalIp", "externalIp", "connectionIp",
    "proxyIp", "bizGroupId", "bizGroup", "remark", "hostTagList", "hostTags",
    "whiteRuleEffect", "updatedTime",
})
# 体积大且与组件版本无关的字段（不进入 extra）
_SKIP_EXTRA_KEYS = frozenset({"processes"})

_PLACEHOLDER_VERSIONS = frozenset({
    "", "-", "--", "unknown", "未知", "n/a", "na", "none", "null", "nil",
    "0", "0.0", "0.0.0", "?", "??", "not installed", "未采集", "未获取", "无",
})


def _norm_text(value: Any) -> str:
    """组件名归一化：NFKC、去首尾空白、小写。"""
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


def _to_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _pick_version(row: dict, spec: dict) -> tuple[str, str]:
    """按优先级取第一个有效版本，返回 (原始版本, 归一化版本)。"""
    for field in spec.get("version_fields") or ():
        raw = str(row.get(field) or "").strip()
        norm = _norm_version(raw)
        if norm:
            return raw, norm
    return "", ""


def build_source_id(
    device_id: int,
    source_type: str,
    agent_id: str,
    name_norm: str,
    version_norm: str,
    path: str,
    port: Optional[int],
) -> str:
    """组件唯一键：同路径/端口升级原地更新，无路径时按版本区分多版本。"""
    identity = name_norm + "|" + (path or (f"port:{port}" if port is not None else version_norm))
    digest = hashlib.sha1(identity.encode("utf-8")).hexdigest()[:20]
    return f"{device_id}:{source_type}:{agent_id}:{digest}"[:160]


def _row_to_values(
    device: Device,
    row: dict,
    source_type: str,
    os_type: str,
    batch_id: int,
    now,
) -> Optional[dict]:
    """青藤组件 row → 入库 values；缺 agentId / 组件名返回 None。"""
    spec = COMPONENT_SYNC_SPECS[source_type]
    agent_id = str(row.get("agentId") or "").strip()
    name = str(row.get(spec["name_field"]) or "").strip()
    if not agent_id or not name:
        return None

    name_norm = _norm_text(name)
    version, version_norm = _pick_version(row, spec)
    path = str(row.get(spec.get("path_field") or "") or "").strip()
    port = _to_int(row.get(spec.get("port_field") or "")) if spec.get("port_field") else None

    consumed = {spec["name_field"], *spec.get("version_fields", ())}
    for field in ("path_field", "type_field", "publisher_field", "port_field"):
        if spec.get(field):
            consumed.add(spec[field])
    extra = {
        k: v
        for k, v in row.items()
        if k not in _HOST_KEYS and k not in consumed and k not in _SKIP_EXTRA_KEYS
    }

    return {
        "source_id": build_source_id(
            device.id, source_type, agent_id, name_norm, version_norm, path, port,
        ),
        "qingteng_device_id": device.id,
        "qingteng_device_name": (device.name or "")[:255],
        "batch_id": batch_id,
        "source_type": source_type,
        "os_type": os_type,
        "agent_id": agent_id[:64],
        "hostname": str(row.get("hostname") or "")[:255],
        "display_ip": str(row.get("displayIp") or "")[:255],
        "internal_ip": str(row.get("internalIp") or "")[:255],
        "external_ip": str(row.get("externalIp") or "")[:255],
        "biz_group": str(row.get("bizGroup") or "")[:255],
        "remark": str(row.get("remark") or ""),
        "name": name[:512],
        "name_norm": name_norm[:512],
        "version": version[:255],
        "version_norm": version_norm[:255],
        "component_type": str(row.get(spec.get("type_field") or "") or "")[:64],
        "path": path[:1024],
        "port": port,
        "publisher": str(row.get(spec.get("publisher_field") or "") or "")[:255],
        "uname": str(row.get("uname") or "")[:128],
        "install_time": str(row.get("installTime") or "")[:32],
        "extra": extra,
        "created_at": now,
        "updated_at": now,
    }


def iter_paged_rows(
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    path: str,
    limit: int,
    stats: dict[str, Any],
) -> Iterable[dict]:
    """通用分页拉取（生成器）：去重、触顶标记、接口忽略分页时提前退出。"""
    seen: set[str] = set()
    emitted = 0
    page = 0

    while page < MAX_PAGES:
        query = {"page": page, "size": PAGE_SIZE}
        headers, _, final_url = _qingteng_signheaders(
            comid, jwt, signkey, "GET", query, None, f"{base_url}{path}",
        )
        resp = client.get(final_url, headers=headers)
        data = _parse(resp, path)
        page_rows = data.get("rows") or []
        if not page_rows:
            break

        added = 0
        for row in page_rows:
            key = str(row.get("id") or "") or "|".join(
                str(row.get(k) or "")
                for k in ("agentId", "name", "version", "productVersion", "path", "port")
            )
            if key in seen:
                continue
            seen.add(key)
            added += 1
            emitted += 1
            stats["rows"] = stats.get("rows", 0) + 1
            yield row
            if emitted >= limit:
                stats["truncated"] = True
                logger.warning(
                    "青藤资产同步触顶 path=%s limit=%d，保留旧数据", path, limit,
                )
                return

        total = int(data.get("total") or 0)
        if added == 0 or len(page_rows) < PAGE_SIZE:
            break
        page += 1
        if total and emitted >= total:
            break


def _iter_source_rows(
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    source_type: str,
    os_type: str,
    stats: dict[str, Any],
) -> Iterable[dict]:
    """分页拉取单个来源 + OS 的组件清单。"""
    spec = COMPONENT_SYNC_SPECS[source_type]
    path = spec["path"].format(os=os_type)
    limit = MAX_ROWS_PER_SOURCE.get(source_type, 300_000)
    yield from iter_paged_rows(
        client, base_url, comid, jwt, signkey, path, limit, stats,
    )


def _flush_values(db: Session, values: list[dict], stats: dict[str, Any]) -> None:
    """分块 upsert，并统计新增/更新条数。"""
    if not values:
        return
    source_ids = [v["source_id"] for v in values]
    existing = {
        r[0]
        for r in db.query(QingtengComponentAsset.source_id)
        .filter(QingtengComponentAsset.source_id.in_(source_ids))
        .all()
    }
    stats["inserted"] = stats.get("inserted", 0) + len(set(source_ids) - existing)
    stats["updated"] = stats.get("updated", 0) + len(set(source_ids) & existing)

    stmt = insert(QingtengComponentAsset).values(values)
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=["source_id"],
        set_={col: getattr(excluded, col) for col in QINGTENG_COMPONENT_UPDATE_COLS},
    )
    db.execute(stmt)


def sync_device_components(
    db: Session,
    device: Device,
    batch_id: int,
    *,
    user_id: int = 0,
    mode: str = "full",
    sources: Optional[list[str]] = None,
) -> dict[str, Any]:
    """同步单台青藤设备的组件清单到指定批次。

    Args:
        db: 数据库会话。
        device: 青藤设备（auth_type=qingteng）。
        batch_id: 预先创建的批次 ID（status=pending）。
        user_id: 触发用户 ID。
        mode: full 全量对齐 / incremental 仅新增更新。
        sources: 限定来源类型；为空表示全部五类。

    Returns:
        同步结果摘要；批次表已同步更新进度与统计。

    Raises:
        ValueError: 批次不存在或来源非法。
        RuntimeError: 登录失败 / 无任何来源成功。
    """
    import_mode = mode if mode in ("full", "incremental") else "full"
    source_list = [s for s in COMPONENT_SOURCES if not sources or s in sources]
    if not source_list:
        raise ValueError("未指定有效的组件来源类型")

    batch = db.query(GovCloudImportBatch).filter(GovCloudImportBatch.id == batch_id).first()
    if batch is None:
        raise ValueError(f"同步批次不存在: {batch_id}")
    expected_type = f"qingteng_component:{device.id}"
    if batch.resource_type != expected_type:
        raise ValueError(f"批次与设备不匹配: {batch.resource_type} != {expected_type}")

    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="青藤 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    started = time.perf_counter()

    batch.status = "running"
    batch.phase = "登录青藤平台"
    batch.percent = 2
    batch.stats = {}
    db.commit()

    progress = 0
    stats: dict[str, Any] = {"sources": {}, "failed_sources": [], "truncated_sources": []}
    unique_ids: set[str] = set()
    failed_sources: list[str] = []
    truncated_sources: list[str] = []

    try:
        comid, jwt, signkey = _qingteng_login(device, timeout, verify)
        with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
            for idx, source_type in enumerate(source_list):
                spec = COMPONENT_SYNC_SPECS[source_type]
                source_stats: dict[str, Any] = {
                    "rows": 0, "inserted": 0, "updated": 0,
                    "skipped": 0, "deleted": 0, "truncated": False, "error": "",
                }
                batch.phase = f"拉取{spec['label']}"
                batch.percent = min(95, 5 + int(90 * idx / len(source_list)))
                db.commit()

                buffer: list[dict] = []
                source_ids: set[str] = set()
                try:
                    now = beijing_now()
                    for os_type in spec["os_types"]:
                        for row in _iter_source_rows(
                            client, base_url, comid, jwt, signkey,
                            source_type, os_type, source_stats,
                        ):
                            values = _row_to_values(
                                device, row, source_type, os_type, batch.id, now,
                            )
                            if values is None:
                                source_stats["skipped"] += 1
                                continue
                            if values["source_id"] in source_ids:
                                continue
                            source_ids.add(values["source_id"])
                            buffer.append(values)
                            if len(buffer) >= UPSERT_CHUNK:
                                _flush_values(db, buffer, source_stats)
                                buffer = []
                    _flush_values(db, buffer, source_stats)
                    # 该来源成功后才计入全局唯一 ID（失败来源已回滚，不参与一致性）
                    unique_ids |= source_ids

                    if source_stats["truncated"]:
                        truncated_sources.append(source_type)
                        stats["truncated_sources"].append(source_type)
                    elif import_mode == "full":
                        source_stats["deleted"] = (
                            db.query(QingtengComponentAsset)
                            .filter(
                                QingtengComponentAsset.qingteng_device_id == device.id,
                                QingtengComponentAsset.source_type == source_type,
                                QingtengComponentAsset.batch_id != batch.id,
                            )
                            .delete(synchronize_session=False)
                        )
                except Exception as exc:  # noqa: BLE001
                    db.rollback()
                    logger.warning(
                        "青藤组件同步失败 device=%s source=%s err=%s",
                        device.name, source_type, exc,
                    )
                    source_stats["error"] = str(exc)[:500]
                    # 该来源的 upsert 已随 rollback 撤销，计数归零
                    source_stats["inserted"] = 0
                    source_stats["updated"] = 0
                    failed_sources.append(source_type)
                    stats["failed_sources"].append(source_type)
                stats["sources"][source_type] = source_stats
                batch.stats = dict(stats)
                progress += 1
                batch.percent = min(95, 5 + int(90 * progress / len(source_list)))
                db.commit()

        if len(failed_sources) == len(source_list):
            raise RuntimeError("所有组件来源拉取失败")

        now = beijing_now()
        live = int(
            db.query(func.count(QingtengComponentAsset.id))
            .filter(QingtengComponentAsset.qingteng_device_id == device.id)
            .scalar() or 0
        )
        live_synced = int(
            db.query(func.count(QingtengComponentAsset.id))
            .filter(
                QingtengComponentAsset.qingteng_device_id == device.id,
                QingtengComponentAsset.source_type.in_(source_list),
            )
            .scalar() or 0
        )
        complete = not failed_sources and not truncated_sources
        consistent = complete and live_synced == len(unique_ids)

        batch.excel_rows = sum(int(s.get("rows") or 0) for s in stats["sources"].values())
        batch.unique_source_ids = len(unique_ids)
        batch.inserted = sum(int(s.get("inserted") or 0) for s in stats["sources"].values())
        batch.updated = sum(int(s.get("updated") or 0) for s in stats["sources"].values())
        batch.deleted = sum(int(s.get("deleted") or 0) for s in stats["sources"].values())
        batch.skipped = sum(int(s.get("skipped") or 0) for s in stats["sources"].values())
        batch.live_count = live
        batch.consistent = int(bool(consistent))
        batch.status = "success" if complete else "partial"
        batch.phase = "完成"
        batch.percent = 100
        batch.stats = dict(stats)
        batch.duration_ms = int((time.perf_counter() - started) * 1000)

        notes = [
            f"来源设备：{device.name}",
            f"同步来源：{','.join(source_list)}",
            "增量同步：仅新增/更新" if import_mode == "incremental" else "全量同步",
        ]
        if failed_sources:
            notes.append(f"失败来源：{','.join(COMPONENT_SOURCE_LABELS.get(s, s) for s in failed_sources)}（已保留旧数据）")
        if truncated_sources:
            notes.append(f"触顶来源：{','.join(COMPONENT_SOURCE_LABELS.get(s, s) for s in truncated_sources)}（已保留旧数据）")
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
            source="component_sync",
            user_id=user_id,
            request_summary=(
                "GET /external/api/assets/{pkg|app|dbinfo|jar_pkg|webframe}/{os} "
                f"mode={import_mode}"
            ),
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
                batch.note = f"组件同步失败: {exc}"[:2000]
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
            source="component_sync",
            user_id=user_id,
            request_summary=f"GET /external/api/assets/components mode={import_mode}",
            response_summary=None,
            status="failed",
            latency_ms=duration,
            error_message=str(exc)[:2000],
        )
        raise RuntimeError(f"组件同步失败: {exc}") from exc

    logger.info(
        "青藤组件同步完成 device=%s(%d) mode=%s rows=%d unique=%d live=%d status=%s",
        device.name, device.id, import_mode, batch.excel_rows, len(unique_ids), live, batch.status,
    )
    return {
        "resource_type": f"qingteng_component:{device.id}",
        "device_id": device.id,
        "device_name": device.name,
        "import_mode": import_mode,
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
