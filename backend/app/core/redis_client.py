"""Redis 客户端单例。

供 Celery 任务（同步）与审批 API 共用同一 Redis 实例，
用于人工审批阻塞 / 唤醒信号传递；异步场景（通知 WS 订阅）
使用 ``get_async_redis`` 单例，避免各自散建连接。
"""
import logging
from functools import lru_cache

import redis.asyncio as aioredis
from redis import Redis

from app.config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_redis() -> Redis:
    """获取 Redis 同步客户端单例。

    使用 ``settings.REDIS_URL`` 构建连接，进程内复用同一实例。
    供 Celery 任务中的审批阻塞 ``brpop`` 与审批 API 的 ``lpush`` 信号共用。

    Returns:
        redis.Redis 同步客户端实例。
    """
    logger.info("创建 Redis 客户端单例: %s", settings.REDIS_URL)
    return Redis.from_url(settings.REDIS_URL, decode_responses=True)


@lru_cache(maxsize=1)
def get_async_redis() -> aioredis.Redis:
    """获取 Redis 异步客户端单例（通知 WS 订阅等异步场景）。

    与同步单例共用 ``settings.REDIS_URL`` 与 decode_responses 口径；
    连接由内部连接池管理，断线后在下次使用时自动重连，无需手动关闭。

    Returns:
        redis.asyncio.Redis 异步客户端实例。
    """
    logger.info("创建 Redis 异步客户端单例: %s", settings.REDIS_URL)
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)
