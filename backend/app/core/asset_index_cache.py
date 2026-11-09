"""资产清单匹配索引：跨进程 Redis 版本 + 单写者重建。

写操作调用 ``invalidate_asset_index()`` 递增版本；读路径 ``ensure_asset_index(db)``
优先加载与当前版本一致的 Redis 快照，避免多 worker 各自全表 SELECT。
"""
from __future__ import annotations

import ipaddress
import json
import logging
import time
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)

KEY_VERSION = "soar:asset:index:version"
KEY_DATA = "soar:asset:index:data"
KEY_LOCK = "soar:lock:refresh:asset:index"
_LOCK_TTL = 120
_DATA_TTL = 86400


def _serialize_nets(nets: list) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item, aid, name in nets:
        if item[0] == "net":
            out.append({"k": "net", "n": str(item[1]), "aid": aid, "name": name or ""})
        else:
            out.append({
                "k": "range",
                "s": str(item[1]),
                "e": str(item[2]),
                "aid": aid,
                "name": name or "",
            })
    return out


def _deserialize_nets(rows: list[dict[str, Any]]) -> list:
    nets: list = []
    for row in rows:
        if row.get("k") == "net":
            nets.append(
                (("net", ipaddress.ip_network(row["n"], strict=False)), row["aid"], row.get("name") or "")
            )
        elif row.get("k") == "range":
            nets.append(
                (
                    ("range", ipaddress.ip_address(row["s"]), ipaddress.ip_address(row["e"])),
                    row["aid"],
                    row.get("name") or "",
                )
            )
    nets.sort(key=lambda x: str(x[0][1]))
    return nets


def get_redis_version() -> int:
    try:
        return int(get_redis().get(KEY_VERSION) or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("asset index version read failed: %s", exc)
        return 0


def bump_asset_index_version() -> int:
    try:
        return int(get_redis().incr(KEY_VERSION))
    except Exception as exc:  # noqa: BLE001
        logger.warning("asset index version bump failed: %s", exc)
        return 0


def _try_lock() -> bool:
    try:
        return bool(get_redis().set(KEY_LOCK, "1", nx=True, ex=_LOCK_TTL))
    except Exception:  # noqa: BLE001
        return True


def _release_lock() -> None:
    try:
        get_redis().delete(KEY_LOCK)
    except Exception:  # noqa: BLE001
        pass


def _publish_index(version: int, single: dict, nets: list) -> None:
    payload = {
        "version": version,
        "single": {k: [v[0], v[1] or ""] for k, v in single.items()},
        "nets": _serialize_nets(nets),
    }
    get_redis().setex(KEY_DATA, _DATA_TTL, json.dumps(payload, ensure_ascii=False))


def _load_index_from_redis(version: int) -> dict[str, Any] | None:
    try:
        raw = get_redis().get(KEY_DATA)
    except Exception as exc:  # noqa: BLE001
        logger.warning("asset index payload read failed: %s", exc)
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if int(data.get("version") or -1) != version:
        return None
    single = {k: (v[0], v[1]) for k, v in (data.get("single") or {}).items()}
    nets = _deserialize_nets(data.get("nets") or [])
    return {"single": single, "nets": nets}


def ensure_asset_index(db: Session) -> dict[str, Any]:
    """返回 ``{single, nets}``；多进程下尽量复用 Redis 快照。"""
    from app.core.log_receiver_manager.pipeline import enricher_stage as es

    ttl = es._ASSET_INDEX_TTL_S  # noqa: SLF001

    if not settings.ASSET_INDEX_REDIS_ENABLED:
        with es._asset_index_lock:  # noqa: SLF001
            if time.time() - es._asset_index_cache["built_at"] > ttl:  # noqa: SLF001
                es._build_asset_index(db)  # noqa: SLF001
            return {
                "single": dict(es._asset_index_cache["single"]),  # noqa: SLF001
                "nets": list(es._asset_index_cache["nets"]),  # noqa: SLF001
            }

    version = get_redis_version()
    with es._asset_index_lock:  # noqa: SLF001
        local_ver = getattr(es, "_asset_index_version", -1)
        fresh = time.time() - es._asset_index_cache["built_at"] <= ttl  # noqa: SLF001
        if local_ver == version and fresh and es._asset_index_cache["single"]:  # noqa: SLF001
            return {
                "single": dict(es._asset_index_cache["single"]),  # noqa: SLF001
                "nets": list(es._asset_index_cache["nets"]),  # noqa: SLF001
            }

    loaded = _load_index_from_redis(version)
    if loaded is not None:
        with es._asset_index_lock:  # noqa: SLF001
            es._asset_index_cache["single"] = loaded["single"]  # noqa: SLF001
            es._asset_index_cache["nets"] = loaded["nets"]  # noqa: SLF001
            es._asset_index_cache["built_at"] = time.time()  # noqa: SLF001
            es._asset_index_version = version  # type: ignore[attr-defined]
        return {"single": dict(loaded["single"]), "nets": list(loaded["nets"])}

    if _try_lock():
        try:
            with es._asset_index_lock:  # noqa: SLF001
                es._build_asset_index(db)  # noqa: SLF001
                single = dict(es._asset_index_cache["single"])  # noqa: SLF001
                nets = list(es._asset_index_cache["nets"])  # noqa: SLF001
                es._asset_index_cache["built_at"] = time.time()  # noqa: SLF001
                es._asset_index_version = version  # type: ignore[attr-defined]
            try:
                _publish_index(version, single, nets)
            except Exception:  # noqa: BLE001
                logger.exception("asset index publish to redis failed")
            return {"single": single, "nets": nets}
        finally:
            _release_lock()

    # 其它进程正在构建：短暂等待后重试 Redis，仍失败则本进程本地构建（降级）
    time.sleep(0.05)
    loaded = _load_index_from_redis(version)
    if loaded is not None:
        with es._asset_index_lock:  # noqa: SLF001
            es._asset_index_cache.update(  # noqa: SLF001
                single=loaded["single"],
                nets=loaded["nets"],
                built_at=time.time(),
            )
            es._asset_index_version = version  # type: ignore[attr-defined]
        return {"single": dict(loaded["single"]), "nets": list(loaded["nets"])}

    logger.warning("asset index redis miss after lock wait, local build fallback")
    with es._asset_index_lock:  # noqa: SLF001
        es._build_asset_index(db)  # noqa: SLF001
        return {
            "single": dict(es._asset_index_cache["single"]),  # noqa: SLF001
            "nets": list(es._asset_index_cache["nets"]),  # noqa: SLF001
        }
