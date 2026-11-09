"""日汇总滚动任务（Celery Beat）。"""
from __future__ import annotations

import logging

from app.config import settings
from app.core.celery_app import celery_app
from app.core.daily_stats_rollup import rollup_recent_days
from app.database import SessionLocal

logger = logging.getLogger(__name__)


@celery_app.task(name="rollup_daily_stats")
def rollup_daily_stats() -> dict:
    """滚动重算最近 N 天执行/模型调用日汇总。"""
    if not settings.DAILY_STATS_ENABLED:
        return {"skipped": True}
    days = max(1, int(settings.DAILY_STATS_ROLLUP_DAYS))
    db = SessionLocal()
    try:
        result = rollup_recent_days(db, days=days)
        logger.info("daily stats rollup done: %s", result)
        return result
    except Exception:
        logger.exception("daily stats rollup failed")
        raise
    finally:
        db.close()
