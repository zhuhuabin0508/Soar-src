"""封禁工作流并发控制：Redis 全局限流 + 进程内配置。

避免告警风暴时联动池与 LLM 并发无限增长；Redis 不可用时降级为仅进程内 worker 并行。
"""
from __future__ import annotations

import logging

from app.config import settings

logger = logging.getLogger(__name__)

_REDIS_KEY = "soar:limit:workflow_inflight"


def try_acquire_workflow_inflight() -> bool:
    """占用一个联动执行槽位，成功返回 True。"""
    limit = int(getattr(settings, "WORKFLOW_INFLIGHT_LIMIT", 12) or 12)
    if limit <= 0:
        return True
    try:
        from app.core.redis_client import get_redis

        r = get_redis()
        n = r.incr(_REDIS_KEY)
        if n > limit:
            r.decr(_REDIS_KEY)
            logger.warning("联动在途数达上限 %s，拒绝新执行", limit)
            return False
        return True
    except Exception:  # noqa: BLE001
        logger.debug("联动在途限流不可用，降级放行", exc_info=True)
        return True


def release_workflow_inflight() -> None:
    """释放一个联动执行槽位。"""
    try:
        from app.core.redis_client import get_redis

        r = get_redis()
        cur = r.decr(_REDIS_KEY)
        if cur is not None and int(cur) < 0:
            r.set(_REDIS_KEY, 0)
    except Exception:  # noqa: BLE001
        logger.debug("释放在途槽位失败", exc_info=True)
