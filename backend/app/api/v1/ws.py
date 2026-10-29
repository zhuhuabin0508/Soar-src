"""WebSocket 端点：通知实时推送。

浏览器 WebSocket 无法携带自定义 Authorization 头，token 经 WebSocket 子协议传递：
前端 ``new WebSocket(url, ["bearer", token])`` → 握手头 ``Sec-WebSocket-Protocol: bearer, <JWT>``。
这样 token 不出现在 URL 中，不会落入 uvicorn/nginx 的访问日志（query 参数会被完整记录）。
query 参数 ``?token=`` 仅作调试兜底保留。

鉴权逻辑与 HTTP 的 get_current_user 对齐：decode JWT → 拒绝 otp_pending →
jti 黑名单 → 用户存在且启用；失败以 4401 关闭码拒绝握手。

协议（服务端 → 客户端均为 JSON 文本帧）：
- 下行 ``{"kind": "notification", ...通知字段}``：新通知到达信号
  （前端收到后立即刷新铃铛并按个人偏好分流提醒，不在 WS 层做提醒决策）
- 上行 ``{"type": "ping"}`` / 下行 ``{"type": "pong"}``：应用层心跳，
  客户端应每 30s 发一次，服务端 90s 未收到任何消息则断开（防僵尸连接）

关闭码：4401 鉴权失败（前端停止重连）；4429 超单用户连接上限
（前端继续退避重连，关闭其他标签页释放名额后自动恢复，期间轮询兜底）。
"""
import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.notification_ws import (
    register_socket,
    unregister_socket,
    user_connection_count,
)
from app.core.security import decode_access_token
from app.database import SessionLocal
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()

# 心跳超时（秒）：客户端 30s 一跳，预留 3 个周期余量
HEARTBEAT_TIMEOUT = 90

# 单用户并发 WS 连接数上限：正常多标签页使用远达不到，防同一账号刷连接滥用
MAX_CONNECTIONS_PER_USER = 10


def _extract_token(ws: WebSocket, query_token: str) -> str:
    """提取鉴权 token：子协议头优先（不落访问日志），query 参数兜底（调试用）。"""
    if query_token:
        return query_token
    header = ws.headers.get("sec-websocket-protocol", "")
    parts = [p.strip() for p in header.split(",") if p.strip()]
    # 前端 new WebSocket(url, ["bearer", token]) → 头值 "bearer, <jwt>"
    if len(parts) >= 2 and parts[0].lower() == "bearer":
        return parts[1]
    return ""


def _authenticate(token: str) -> int | None:
    """校验 token，返回 user_id；失败返回 None（与 get_current_user 同口径）。"""
    payload = decode_access_token(token)
    if not payload:
        return None
    # OTP 待验证 token 不能用于 WS 鉴权
    if payload.get("type") == "otp_pending":
        return None
    # 登出 / 刷新 / 强制下线后的 token 立即失效
    jti = payload.get("jti")
    if jti:
        try:
            from app.core.session import is_token_blacklisted

            if is_token_blacklisted(jti):
                return None
        except Exception:  # noqa: BLE001 - Redis 不可用时降级放行（与 HTTP 依赖一致）
            pass
    try:
        uid = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        return None
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == uid).first()
        if user is None or not user.is_active:
            return None
        return uid
    finally:
        db.close()


@router.websocket("/ws/notifications")
async def ws_notifications(ws: WebSocket, token: str = ""):
    # 子协议头优先（不落访问日志），query 兜底（调试）
    effective = _extract_token(ws, token)
    # 客户端请求了子协议时必须 echo（否则浏览器会立即断开），未请求则不设置
    requested = ws.headers.get("sec-websocket-protocol", "")
    subprotocol = "bearer" if requested else None
    uid = _authenticate(effective)
    if uid is None:
        # 4401：鉴权失败（前端收到后不再重连，等待轮询兜底/重新登录）。
        # 先 accept 再 close：未 accept 直接 close 时 uvicorn 会以 HTTP 403 拒绝握手，
        # 浏览器只能看到 1006，读不到 4401，无法区分「鉴权失败」与「网络中断」。
        await ws.accept(subprotocol=subprotocol)
        await ws.close(code=4401)
        return

    if user_connection_count(uid) >= MAX_CONNECTIONS_PER_USER:
        # 4429：超单用户连接上限（前端按退避继续重连，轮询兜底不丢通知；
        # 关闭其他标签页释放名额后重连自动恢复）
        logger.warning("通知 WS 超单用户连接上限: user_id=%s", uid)
        await ws.accept(subprotocol=subprotocol)
        await ws.close(code=4429, reason="too many connections")
        return

    await ws.accept(subprotocol=subprotocol)
    register_socket(uid, ws)
    try:
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT)
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except (asyncio.TimeoutError, WebSocketDisconnect):
        pass
    except Exception as exc:  # noqa: BLE001
        logger.info("通知 WS 连接异常结束: user_id=%s, err=%s", uid, exc)
    finally:
        unregister_socket(uid, ws)
