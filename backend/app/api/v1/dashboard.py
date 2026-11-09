"""大屏统计路由。

读路径优先 Redis 快照（Celery Beat 刷新）；重聚合逻辑见 ``app.core.dashboard_stats``。
"""
import logging
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.dashboard_cache import CacheKeys, resolve_cached_payload
from app.core.dashboard_stats import compute_ai_usage_stats, compute_dashboard_stats
from app.database import get_db
from app.dependencies import get_current_user, require_permission

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/dashboard",
    tags=["dashboard"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("dashboard", "view")),
) -> dict[str, Any]:
    """获取大屏统计数据（最近 7 天）。响应可含 ``cache`` 字段（built_at / stale）。"""
    return resolve_cached_payload(
        CacheKeys.STATS_7D,
        db,
        compute_dashboard_stats,
    )


@router.get("/ai-usage")
def get_ai_usage_stats(
    days: int = 7,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("dashboard", "view")),
) -> dict[str, Any]:
    """获取智能体与大模型使用情况统计（默认最近 7 天）。"""
    days = max(1, min(int(days), 90))
    return resolve_cached_payload(
        CacheKeys.ai_usage(days),
        db,
        lambda session: compute_ai_usage_stats(session, days=days),
        allow_live_cold_start=(days == 7),
    )
