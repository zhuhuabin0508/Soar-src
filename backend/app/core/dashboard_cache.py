"""大屏与监控类接口的 Redis 快照读写。

Celery Beat 定时刷新；API 热路径优先读缓存，Redis 故障或 TTL 过期时回退上一份快照。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.redis_client import get_redis
from app.core.timezone import beijing_now_iso

logger = logging.getLogger(__name__)


class CacheKeys:
    """与架构文档一致的 Redis 键名。"""

    STATS_7D = "soar:cache:dashboard:stats:7d"
    AI_USAGE_7 = "soar:cache:dashboard:ai-usage:7"
    BAN_WORKFLOW_STATS = "soar:cache:ban_workflow:stats:today"
    MONITOR_OVERVIEW = "soar:cache:monitor:overview"
    EXECUTIONS_OVERVIEW_7 = "soar:cache:executions:overview:7"

    @staticmethod
    def ai_usage(days: int) -> str:
        return f"soar:cache:dashboard:ai-usage:{int(days)}"

    @staticmethod
    def executions_overview(days: int) -> str:
        return f"soar:cache:executions:overview:{int(days)}"

    @staticmethod
    def refresh_lock(cache_key: str) -> str:
        return f"soar:lock:refresh:{cache_key}"


def _meta_key(cache_key: str) -> str:
    return f"{cache_key}:meta"


def _last_key(cache_key: str) -> str:
    return f"{cache_key}:last"


def try_acquire_refresh_lock(cache_key: str, ttl_sec: int = 120) -> bool:
    """单飞锁，避免多 worker 同时重算同一份快照。"""
    try:
        return bool(
            get_redis().set(
                CacheKeys.refresh_lock(cache_key),
                "1",
                nx=True,
                ex=ttl_sec,
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard cache lock failed key=%s: %s", cache_key, exc)
        return True  # 无法加锁时仍尝试刷新，优于完全不更新


def release_refresh_lock(cache_key: str) -> None:
    try:
        get_redis().delete(CacheKeys.refresh_lock(cache_key))
    except Exception:  # noqa: BLE001
        pass


def set_snapshot(cache_key: str, body: dict[str, Any], ttl_sec: Optional[int] = None) -> None:
    """写入快照与 meta，并保留 longer-TTL 的 last 副本供 stale 回退。"""
    ttl = ttl_sec if ttl_sec is not None else settings.DASHBOARD_CACHE_TTL_SEC
    last_ttl = max(ttl * 48, 86400)
    r = get_redis()
    version = r.incr(f"{cache_key}:version")
    meta = {"built_at": beijing_now_iso(), "version": version, "stale": False}
    payload = json.dumps(body, ensure_ascii=False, default=str)
    meta_json = json.dumps(meta, ensure_ascii=False)
    pipe = r.pipeline()
    pipe.setex(cache_key, ttl, payload)
    pipe.setex(_meta_key(cache_key), ttl, meta_json)
    pipe.setex(_last_key(cache_key), last_ttl, payload)
    pipe.setex(f"{_last_key(cache_key)}:meta", last_ttl, meta_json)
    pipe.execute()


def _load_json(key: str) -> Optional[Any]:
    try:
        raw = get_redis().get(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard cache read failed key=%s: %s", key, exc)
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("dashboard cache json corrupt key=%s", key)
        return None


def _with_cache_field(body: dict[str, Any], meta: dict[str, Any], *, stale: bool) -> dict[str, Any]:
    cache_meta = {**meta, "stale": stale}
    return {**body, "cache": cache_meta}


def get_fresh_snapshot(cache_key: str) -> Optional[dict[str, Any]]:
    """TTL 内的快照；命中时附加 cache meta。"""
    body = _load_json(cache_key)
    if body is None:
        return None
    meta = _load_json(_meta_key(cache_key)) or {}
    return _with_cache_field(body, meta, stale=False)


def get_last_snapshot(cache_key: str) -> Optional[dict[str, Any]]:
    """上一份快照（较长 TTL），用于过期后的 stale 回退。"""
    body = _load_json(_last_key(cache_key))
    if body is None:
        return None
    meta = _load_json(f"{_last_key(cache_key)}:meta") or {}
    return _with_cache_field(body, meta, stale=True)


def resolve_cached_payload(
    cache_key: str,
    db: Session,
    compute: Callable[[Session], dict[str, Any]],
    *,
    allow_live_cold_start: bool = True,
) -> dict[str, Any]:
    """API 读路径：缓存 → stale last → 可选一次 live 计算（仅冷启动）。"""
    if not settings.DASHBOARD_CACHE_ENABLED:
        body = compute(db)
        return {
            **body,
            "cache": {
                "stale": True,
                "source": "live",
                "enabled": False,
            },
        }

    fresh = get_fresh_snapshot(cache_key)
    if fresh is not None:
        return fresh

    stale = get_last_snapshot(cache_key)
    if stale is not None:
        return stale

    if allow_live_cold_start:
        logger.warning(
            "dashboard cache cold miss, computing live once: key=%s",
            cache_key,
        )
        body = compute(db)
        return {
            **body,
            "cache": {
                "stale": True,
                "source": "live_cold_start",
                "built_at": beijing_now_iso(),
            },
        }

    return {
        "cache": {
            "stale": True,
            "source": "empty",
            "built_at": beijing_now_iso(),
        },
    }
