"""大屏 / 监控 Redis 快照定时刷新（Celery Beat）。"""
from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy.orm import Session

from app.api.v1.monitor import compute_monitor_overview
from app.config import settings
from app.core.celery_app import celery_app
from app.core.dashboard_cache import (
    CacheKeys,
    release_refresh_lock,
    set_snapshot,
    try_acquire_refresh_lock,
)
from app.core.dashboard_stats import (
    compute_ai_usage_stats,
    compute_ban_workflow_stats,
    compute_dashboard_stats,
    compute_executions_overview,
)
from app.database import SessionLocal

logger = logging.getLogger(__name__)


def _refresh_one(
    cache_key: str,
    compute: Callable[[Session], dict],
    ttl_sec: int | None = None,
) -> bool:
    if not try_acquire_refresh_lock(cache_key):
        logger.debug("skip dashboard refresh, lock held: %s", cache_key)
        return False
    db = SessionLocal()
    try:
        body = compute(db)
        set_snapshot(cache_key, body, ttl_sec=ttl_sec)
        logger.info("dashboard cache refreshed: %s", cache_key)
        return True
    except Exception:
        logger.exception("dashboard cache refresh failed: %s", cache_key)
        return False
    finally:
        db.close()
        release_refresh_lock(cache_key)


@celery_app.task(name="refresh_dashboard_cache")
def refresh_dashboard_cache() -> dict[str, bool]:
    """刷新首批大屏/监控快照（Beat 约每 60s 一次）。"""
    if not settings.DASHBOARD_CACHE_ENABLED:
        return {"skipped": True}

    ttl = settings.DASHBOARD_CACHE_TTL_SEC
    results = {
        "stats_7d": _refresh_one(CacheKeys.STATS_7D, compute_dashboard_stats, ttl),
        "ai_usage_7": _refresh_one(
            CacheKeys.AI_USAGE_7,
            lambda db: compute_ai_usage_stats(db, days=7),
            ttl,
        ),
        "ban_workflow": _refresh_one(
            CacheKeys.BAN_WORKFLOW_STATS,
            compute_ban_workflow_stats,
            ttl,
        ),
        "monitor_overview": _refresh_one(
            CacheKeys.MONITOR_OVERVIEW,
            compute_monitor_overview,
            ttl,
        ),
        "executions_7": _refresh_one(
            CacheKeys.EXECUTIONS_OVERVIEW_7,
            lambda db: compute_executions_overview(db, days=7),
            ttl,
        ),
    }
    return results
