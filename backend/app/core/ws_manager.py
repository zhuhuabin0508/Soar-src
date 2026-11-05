"""WebSocket 连接管理器（单例）。

用于工作流执行进度的实时推送：
- 客户端连接 ``/ws/executions/{execution_id}`` 订阅指定执行的进度
- 执行引擎通过 ``broadcast(execution_id, message)`` 推送日志/轨迹/状态变更

设计要点：
- 同一 execution_id 可有多个客户端连接（多端查看同一执行）
- 连接断开时自动清理
- 推送失败不阻断执行（仅记日志）
"""
import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """WebSocket 连接管理器：按 execution_id 分组管理连接。"""

    def __init__(self) -> None:
        # {execution_id: [WebSocket, ...]}
        self._connections: dict[int, list[WebSocket]] = {}

    async def connect(self, execution_id: int, ws: WebSocket, subprotocol: str | None = None) -> None:
        """接受客户端连接并注册到 execution_id 分组。"""
        await ws.accept(subprotocol=subprotocol)
        if execution_id not in self._connections:
            self._connections[execution_id] = []
        self._connections[execution_id].append(ws)
        logger.info("WebSocket 连接已建立: execution_id=%s, 当前连接数=%d",
                     execution_id, len(self._connections[execution_id]))

    def disconnect(self, execution_id: int, ws: WebSocket) -> None:
        """断开连接并从分组中移除。"""
        conns = self._connections.get(execution_id)
        if conns:
            try:
                conns.remove(ws)
            except ValueError:
                pass
            if not conns:
                del self._connections[execution_id]
        logger.debug("WebSocket 断开: execution_id=%s", execution_id)

    async def broadcast(self, execution_id: int, message: dict[str, Any]) -> None:
        """向指定 execution_id 的所有客户端推送 JSON 消息。

        推送失败时移除失效连接，不抛异常。
        """
        conns = self._connections.get(execution_id)
        if not conns:
            return
        text = json.dumps(message, ensure_ascii=False, default=str)
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_text(text)
            except Exception as exc:  # noqa: BLE001
                logger.debug("推送失败，标记移除: %s", exc)
                dead.append(ws)
        for ws in dead:
            self.disconnect(execution_id, ws)

    async def broadcast_sync_safe(self, execution_id: int, message: dict[str, Any]) -> None:
        """同步上下文安全的推送包装（在同步回调中调用时使用）。

        由于 ``broadcast`` 是 async，在同步回调（如 log_callback）中无法直接 await，
        此方法用 ``asyncio.ensure_future`` 安排推送任务到事件循环。
        """
        import asyncio

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self.broadcast(execution_id, message))
            else:
                # 不在事件循环中（如 Celery 同步任务），跳过推送
                logger.debug("不在事件循环中，跳过 WebSocket 推送: execution_id=%s", execution_id)
        except RuntimeError:
            logger.debug("无事件循环，跳过 WebSocket 推送: execution_id=%s", execution_id)


# 全局单例
ws_manager = ConnectionManager()
