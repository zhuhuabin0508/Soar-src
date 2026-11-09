"""大屏 Redis 缓存与日汇总：随 API 进程内嵌定时刷新。

与 Celery Beat 任务复用同一套逻辑与 Redis 单飞锁；Beat 未启动时由 backend 兜底，
部署命令不变（只起 backend 即可逐步预热）。Beat 与 backend 同时存在时锁避免重复重算。
"""
from __future__ import annotations

import logging
import threading
import time

from app.config import settings

logger = logging.getLogger(__name__)

_SCHEDULER_STARTED = False
_SCHEDULER_LOCK = threading.Lock()
_STOP = threading.Event()
_ROLLUP_INTERVAL_SEC = 900
_ROLLUP_LOCK_KEY = "soar:lock:refresh:daily_stats:rollup"


def _refresh_dashboard() -> None:
    if not settings.DASHBOARD_CACHE_ENABLED:
        return
    from app.tasks.dashboard_cache_tasks import execute_refresh_dashboard_cache

    execute_refresh_dashboard_cache()


def _rollup_daily() -> None:
    if not settings.DAILY_STATS_ENABLED:
        return
    from app.core.dashboard_cache import release_refresh_lock, try_acquire_refresh_lock
    from app.tasks.daily_stats_tasks import execute_rollup_daily_stats

    if not try_acquire_refresh_lock(_ROLLUP_LOCK_KEY, ttl_sec=600):
        return
    try:
        execute_rollup_daily_stats()
    except Exception:  # noqa: BLE001
        logger.exception("backend 内嵌日汇总 rollup 失败")
    finally:
        release_refresh_lock(_ROLLUP_LOCK_KEY)


def _run_loop() -> None:
    interval = max(30, int(settings.DASHBOARD_CACHE_TTL_SEC or 60))
    next_rollup = time.monotonic() + 30.0
    logger.info(
        "大屏/日汇总内嵌调度已启动: cache_interval=%ss rollup_every=%ss",
        interval,
        _ROLLUP_INTERVAL_SEC,
    )
    while not _STOP.is_set():
        try:
            _refresh_dashboard()
        except Exception:  # noqa: BLE001
            logger.exception("backend 内嵌大屏缓存刷新失败")
        now = time.monotonic()
        if now >= next_rollup:
            try:
                _rollup_daily()
            except Exception:  # noqa: BLE001
                logger.exception("backend 内嵌日汇总调度失败")
            next_rollup = now + _ROLLUP_INTERVAL_SEC
        _STOP.wait(interval)


def start_dashboard_refresh_scheduler() -> None:
    """在 API 进程内启动守护线程（幂等）。"""
    global _SCHEDULER_STARTED
    if not settings.DASHBOARD_BACKEND_REFRESH:
        return
    if not settings.DASHBOARD_CACHE_ENABLED and not settings.DAILY_STATS_ENABLED:
        return
    with _SCHEDULER_LOCK:
        if _SCHEDULER_STARTED:
            return
        _SCHEDULER_STARTED = True
        _STOP.clear()
        threading.Thread(
            target=_run_loop,
            name="dashboard-refresh-scheduler",
            daemon=True,
        ).start()
