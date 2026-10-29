"""通知 WebSocket 实时推送。

链路：任意代码创建 Notification 并 commit → SQLAlchemy after_commit 钩子
→ Redis Pub/Sub（channel: soar:notifications）广播 → 各 API 进程的订阅协程
→ 推给目标用户在本进程持有的 WebSocket 连接 → 前端立即刷新铃铛并按偏好弹出提醒。

设计要点：
- 零侵入：通过 SQLAlchemy Session 事件钩子自动广播，现有/未来的通知创建点
  （dispatch_notification、工单流转、公告发布等）无需任何改动；
- 事务安全：只在 after_commit 后广播（回滚自动丢弃），订阅方收到时数据必然已提交；
- 多 worker 就绪：Redis Pub/Sub 中转，通知可由任意进程产生、推给任意进程持有的连接；
- 降级安全：Redis / WS 任何环节失败都不影响通知入库，前端保留 30s 轮询兜底。
"""
import asyncio
import json
import logging
from typing import Optional

from fastapi import WebSocket
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.redis_client import get_async_redis, get_redis
from app.models.notification import Notification

logger = logging.getLogger(__name__)

# Redis Pub/Sub 频道：通知事件广播
NOTIFICATION_CHANNEL = "soar:notifications"

# user_id -> 该用户在本进程的 WebSocket 连接集合（同一用户多标签页）
_connections: dict[int, set[WebSocket]] = {}
_listener_task: Optional[asyncio.Task] = None


def total_connections() -> int:
    """当前进程持有的 WS 连接总数（观测用）。"""
    return sum(len(v) for v in _connections.values())


def user_connection_count(user_id: int) -> int:
    """某用户当前在本进程的 WS 连接数（连接数上限校验用）。"""
    return len(_connections.get(user_id, ()))


def register_socket(user_id: int, ws: WebSocket) -> None:
    _connections.setdefault(user_id, set()).add(ws)
    logger.info("通知 WS 已连接: user_id=%s, 在线连接=%d", user_id, total_connections())


def unregister_socket(user_id: int, ws: WebSocket) -> None:
    conns = _connections.get(user_id)
    if conns is None:
        return
    conns.discard(ws)
    if not conns:
        _connections.pop(user_id, None)
    logger.info("通知 WS 已断开: user_id=%s, 在线连接=%d", user_id, total_connections())


async def _push_event(payload: dict) -> None:
    """把一条通知事件推给目标用户的所有在线连接（user_id=None 表示全员广播）。"""
    uid = payload.get("user_id")
    if uid is None:
        targets = [ws for conns in _connections.values() for ws in conns]
    else:
        targets = list(_connections.get(uid, ()))
    if not targets:
        return
    data = json.dumps(payload, ensure_ascii=False, default=str)
    for ws in targets:
        try:
            await ws.send_text(data)
        except Exception:  # noqa: BLE001 - 发送失败交给接收循环清理
            pass


def _publish_to_redis(notifications: list[Notification]) -> None:
    """同步发布新通知事件到 Redis（after_commit 钩子内调用，本地发布微秒级）。"""
    try:
        r = get_redis()
    except Exception:  # noqa: BLE001
        logger.warning("通知事件发布失败：Redis 客户端不可用（轮询兜底）", exc_info=True)
        return
    for n in notifications:
        try:
            payload = {
                "kind": "notification",
                "user_id": n.user_id,
                "id": n.id,
                "type": n.type,
                "title": n.title,
                "content": n.content,
                "related_type": n.related_type,
                "related_id": n.related_id,
                "created_by": n.created_by,
                "created_at": str(n.created_at) if n.created_at else None,
            }
            r.publish(NOTIFICATION_CHANNEL, json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:  # noqa: BLE001
            logger.warning("通知事件发布到 Redis 失败: id=%s（轮询兜底）", getattr(n, "id", "?"), exc_info=True)


# ===== SQLAlchemy 钩子：自动广播新通知（零侵入所有创建点） =====

_PENDING_KEY = "_ws_pending_notifications"


@event.listens_for(Session, "before_flush")
def _collect_new_notifications(session, flush_context, instances) -> None:
    """flush 前收集本次事务新增的 Notification（commit 内部会 flush，因此必经此钩子）。"""
    news = [obj for obj in session.new if isinstance(obj, Notification)]
    if news:
        session.info.setdefault(_PENDING_KEY, []).extend(news)


@event.listens_for(Session, "after_commit")
def _publish_committed_notifications(session) -> None:
    """事务提交后广播（保证订阅方读到的数据已落库）。"""
    pending = session.info.pop(_PENDING_KEY, None)
    if pending:
        _publish_to_redis(pending)


@event.listens_for(Session, "after_rollback")
def _discard_new_notifications(session) -> None:
    """事务回滚时丢弃待广播通知。"""
    session.info.pop(_PENDING_KEY, None)


# ===== Redis 订阅协程（每个 API 进程一个） =====


async def _listener_loop() -> None:
    """订阅 Redis 频道，把通知事件推给本进程的 WS 连接（支持多 worker 部署）。

    Redis 短暂不可用（重启/网络抖动）时按指数退避自动重连
    （1s → 2s → … → 30s 封顶），避免一次抖动让实时推送停摆到进程重启；
    重连期间前端由轮询兜底。客户端使用 ``get_async_redis`` 进程级单例，
    断线后由连接池在下次使用时自动重连，每轮仅需释放 pubsub。
    """
    backoff = 1.0
    while True:
        pubsub = None
        try:
            pubsub = get_async_redis().pubsub()
            await pubsub.subscribe(NOTIFICATION_CHANNEL)
            backoff = 1.0
            logger.info("通知 WS Redis 订阅已启动: channel=%s", NOTIFICATION_CHANNEL)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    payload = json.loads(msg.get("data"))
                except (TypeError, ValueError):
                    continue
                try:
                    await _push_event(payload)
                except Exception:  # noqa: BLE001
                    logger.warning("通知 WS 推送失败（轮询兜底）", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.warning(
                "通知 WS 订阅异常，%.0fs 后自动重连（期间轮询兜底）",
                backoff, exc_info=True,
            )
        finally:
            # 每轮释放 pubsub；客户端为进程级单例，由连接池自动重连复用
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:  # noqa: BLE001
                    pass
        # 退避等待（等待中被 cancel 会抛 CancelledError 结束任务）
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


def start_notification_ws_listener() -> None:
    """在 FastAPI lifespan 中启动订阅协程（幂等）。"""
    global _listener_task
    if _listener_task and not _listener_task.done():
        return
    _listener_task = asyncio.create_task(_listener_loop())


def stop_notification_ws_listener() -> None:
    """在 FastAPI lifespan 关闭时停止订阅协程。"""
    global _listener_task
    if _listener_task and not _listener_task.done():
        _listener_task.cancel()
