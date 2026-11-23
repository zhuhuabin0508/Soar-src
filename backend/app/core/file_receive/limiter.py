"""来源级限流、并发会话限制与合并槽位背压。"""
import logging
import threading
import time
import uuid
from contextlib import contextmanager

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.file_receive.constants import ACTIVE_STATUSES
from app.core.file_receive.errors import FileReceiveError

logger = logging.getLogger(__name__)

_TOKEN_BUCKET_LUA = """
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity end
if ts == nil then ts = now end
tokens = math.min(capacity, tokens + (now - ts) / 1000.0 * rate)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 60000)
return allowed
"""

_LEASE_LUA = """
local now = tonumber(ARGV[2])
local lease_ms = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], now + lease_ms, ARGV[1])
return 1
"""

_local_buckets: dict[str, tuple[float, int]] = {}
_local_lock = threading.Lock()
_merge_semaphore = threading.BoundedSemaphore(max(1, int(settings.FILE_RECEIVE_MERGE_CONCURRENCY)))
_upload_semaphore = threading.BoundedSemaphore(max(1, int(settings.FILE_RECEIVE_GLOBAL_UPLOAD_CONCURRENCY)))


def _check_qps_local(key: str, rate: int, capacity: int) -> bool:
    now = time.time()
    with _local_lock:
        tokens, ts = _local_buckets.get(key, (float(capacity), now))
        tokens = min(float(capacity), tokens + (now - ts) * rate)
        if tokens < 1:
            _local_buckets[key] = (tokens, now)
            return False
        _local_buckets[key] = (tokens - 1, now)
        return True


def check_qps(source) -> None:
    """来源级令牌桶限流；Redis 不可用时降级为进程内令牌桶。"""
    rate = max(1, int(source.qps or settings.FILE_RECEIVE_QPS_DEFAULT))
    capacity = max(rate, int(source.burst or settings.FILE_RECEIVE_BURST_DEFAULT))
    key = f"fr:tb:{source.id}"
    allowed = True
    try:
        from app.core.redis_client import get_redis

        result = get_redis().eval(
            _TOKEN_BUCKET_LUA, 1, key,
            int(time.time() * 1000), rate, capacity, 1,
        )
        allowed = bool(int(result or 0))
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件接收 QPS 检查 Redis 不可用，降级进程内限流: %s", exc)
        allowed = _check_qps_local(key, rate, capacity)
    if not allowed:
        raise FileReceiveError(
            "FR-LIMIT-001",
            429,
            f"来源调用频率超过配额（{rate} 次/秒），请稍后重试",
            retryable=True,
            retry_after=1,
        )


def check_session_limit(db: Session, source) -> None:
    """来源并发会话上限检查（INIT/UPLOADING 计数）。"""
    from app.models.file_receive import FileReceiveRecord

    limit = max(1, int(source.max_concurrent_sessions or settings.FILE_RECEIVE_MAX_SESSIONS_PER_SOURCE))
    count = (
        db.query(func.count(FileReceiveRecord.id))
        .filter(
            FileReceiveRecord.source_id == source.id,
            FileReceiveRecord.status.in_(ACTIVE_STATUSES),
            FileReceiveRecord.deleted_at.is_(None),
        )
        .scalar()
        or 0
    )
    if count >= limit:
        raise FileReceiveError(
            "FR-LIMIT-002",
            429,
            f"来源并发上传会话数已达上限（{limit}），请完成现有上传后重试",
            retryable=True,
            retry_after=30,
        )


def _lease_key(kind: str) -> str:
    return f"fr:leases:{kind}"


def _local_semaphore(kind: str) -> threading.BoundedSemaphore:
    return _merge_semaphore if kind == "merge" else _upload_semaphore


def _acquire_lease(kind: str, member: str, limit: int, lease_ms: int) -> str | None:
    """获取集群级租约；Redis 不可用时退化为进程内信号量。"""
    try:
        from app.core.redis_client import get_redis

        result = get_redis().eval(
            _LEASE_LUA, 1, _lease_key(kind),
            member, int(time.time() * 1000), lease_ms, max(1, limit),
        )
        return "redis" if int(result or 0) else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件接收租约 Redis 不可用，降级进程内信号量: %s", exc)
    sem = _local_semaphore(kind)
    return "local" if sem.acquire(timeout=0.2) else None


def _release_lease(kind: str, member: str, backend: str) -> None:
    if backend == "local":
        _local_semaphore(kind).release()
        return
    try:
        from app.core.redis_client import get_redis

        get_redis().zrem(_lease_key(kind), member)
    except Exception as exc:  # noqa: BLE001
        logger.warning("释放文件接收租约失败（等待自动过期）: %s", exc)


@contextmanager
def _lease(kind: str, record_id: int, limit: int, lease_ms: int):
    # 合并按记录占一个槽位；分片上传每次请求占一个槽位（同一记录可并发多片）
    member = f"{record_id}:{uuid.uuid4().hex[:8]}" if kind == "upload" else str(record_id)
    backend = _acquire_lease(kind, member, limit, lease_ms)
    if backend is None:
        if kind == "merge":
            raise FileReceiveError(
                "FR-BUSY-002",
                503,
                "合并通道繁忙，请稍后重试 complete",
                retryable=True,
                retry_after=10,
            )
        raise FileReceiveError(
            "FR-BUSY-001",
            503,
            "上传通道繁忙，请稍后重试",
            retryable=True,
            retry_after=5,
        )
    try:
        yield
    finally:
        _release_lease(kind, member, backend)


def merge_slot(record_id: int):
    """合并槽位：Redis ZSET 租约，跨 backend 实例生效。"""
    return _lease(
        "merge",
        record_id,
        max(1, int(settings.FILE_RECEIVE_MERGE_CONCURRENCY)),
        lease_ms=5 * 60 * 1000,
    )


def upload_slot(record_id: int):
    """分片上传槽位：Redis ZSET 租约，跨实例限制并发大文件上传。"""
    return _lease(
        "upload",
        record_id,
        max(1, int(settings.FILE_RECEIVE_GLOBAL_UPLOAD_CONCURRENCY)),
        lease_ms=2 * 60 * 1000,
    )
