"""通知 WebSocket 实时推送单测。

覆盖：
- ``_extract_token``：子协议头解析（bearer, <jwt>）、query 参数优先、非 bearer 前缀不取
- SQLAlchemy 钩子：before_flush 收集 / after_commit 发布 / 回滚丢弃（零侵入创建点）
- ``_push_event``：定向推送（user_id）/ 全员广播（user_id=None）/ 无在线连接静默
- ``register/unregister``：连接注册与计数
- WS 端点集成：无效 token 以 4401 关闭、有效 token ping/pong、token 经子协议传递、禁用用户拒绝

Redis Pub/Sub → WS 的跨进程全链路依赖真实 Redis 与运行中的事件循环，
由容器内手动 E2E 验证（创建通知 commit → 毫秒级收到推送），不在单测范围。

运行：python -m pytest tests/test_notification_ws.py -v
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1 import ws as ws_api
from app.core import notification_ws
from app.core.security import create_access_token
from app.database import Base
from app.models.notification import Notification
from app.models.user import User

# ============ 测试基础设施：内存 SQLite + 独立小 app（无 lifespan，不连 Redis） ============
_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

Base.metadata.create_all(_engine, tables=[User.__table__, Notification.__table__])

_app = FastAPI()
_app.include_router(ws_api.router)


def _seed_user(uid: int = 1, active: bool = True) -> None:
    db = _TestSessionLocal()
    try:
        if not db.query(User).filter(User.id == uid).first():
            db.add(User(id=uid, username=f"u{uid}", password_hash="x", role="admin", is_active=active))
            db.commit()
    finally:
        db.close()


def _make_token(uid: int = 1) -> str:
    """签发测试 JWT（同进程同 settings，decode 必然成功）。"""
    return create_access_token(uid, f"u{uid}", "admin")[0]


@pytest.fixture()
def ws_client(monkeypatch):
    """挂 ws.router 的 TestClient，鉴权查库替换为内存 SQLite。"""
    _seed_user(1)
    monkeypatch.setattr(ws_api, "SessionLocal", _TestSessionLocal)
    return TestClient(_app)


class _FakeWS:
    """记录 send_text 调用的假 WebSocket（不真实收发）。"""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, data: str) -> None:
        self.sent.append(data)


def _fake_ws_with_protocol(header: str):
    """构造带子协议头的假 WebSocket（headers 用 dict，key 小写）。"""
    headers = {"sec-websocket-protocol": header} if header else {}
    return SimpleNamespace(headers=headers)


# ============ token 提取：子协议头优先，query 兜底 ============

class TestExtractToken:
    def test_query_token_takes_priority(self):
        fake = _fake_ws_with_protocol("bearer, subproto-token")
        assert ws_api._extract_token(fake, "query-token") == "query-token"

    def test_subprotocol_bearer_scheme(self):
        fake = _fake_ws_with_protocol("bearer, eyJhbGciOiJIUzI1NiJ9.payload.sig")
        assert ws_api._extract_token(fake, "") == "eyJhbGciOiJIUzI1NiJ9.payload.sig"

    def test_subprotocol_case_insensitive_bearer(self):
        fake = _fake_ws_with_protocol("BEARER, tok")
        assert ws_api._extract_token(fake, "") == "tok"

    def test_subprotocol_without_bearer_prefix_rejected(self):
        """首项非 bearer 时不得误读（避免吞掉其它用途的子协议值）。"""
        fake = _fake_ws_with_protocol("chat.v2, somevalue")
        assert ws_api._extract_token(fake, "") == ""

    def test_empty_everywhere(self):
        assert ws_api._extract_token(_fake_ws_with_protocol(""), "") == ""


# ============ SQLAlchemy 钩子：收集 / 提交发布 / 回滚丢弃 ============

class TestSessionHooks:
    def _cleanup(self):
        db = _TestSessionLocal()
        try:
            db.query(Notification).delete()
            db.commit()
        finally:
            db.close()

    def test_commit_publishes_new_notification(self, monkeypatch):
        # 在钩子时机（session 未关闭）提取字段，避免 close 后访问过期属性
        published = []
        monkeypatch.setattr(
            notification_ws,
            "_publish_to_redis",
            lambda items: published.extend((n.id, n.title) for n in items),
        )
        try:
            db = _TestSessionLocal()
            try:
                db.add(Notification(user_id=1, type="system_update", title="钩子测试", content="c"))
                db.commit()
            finally:
                db.close()
            assert len(published) == 1
            assert published[0][1] == "钩子测试"
            # id 已在 commit 后回填（payload 需要）
            assert published[0][0] is not None
        finally:
            self._cleanup()

    def test_rollback_discards(self, monkeypatch):
        published = []
        monkeypatch.setattr(notification_ws, "_publish_to_redis", lambda items: published.extend(items))
        db = _TestSessionLocal()
        try:
            db.add(Notification(user_id=1, type="announcement", title="会被回滚"))
            db.rollback()
        finally:
            db.close()
        assert published == []

    def test_read_only_session_not_publish(self, monkeypatch):
        """查询/提交非 Notification 时不触发发布。"""
        published = []
        monkeypatch.setattr(notification_ws, "_publish_to_redis", lambda items: published.extend(items))
        db = _TestSessionLocal()
        try:
            db.add(User(id=900, username="hook_user", password_hash="x", role="analyst"))
            db.commit()
        finally:
            db.close()
        assert published == []
        db = _TestSessionLocal()
        try:
            db.query(User).filter(User.id == 900).delete()
            db.commit()
        finally:
            db.close()


# ============ 推送路由：定向 / 广播 / 无连接 ============

class TestPushEvent:
    def test_targeted_and_broadcast(self):
        async def run():
            a, b = _FakeWS(), _FakeWS()
            try:
                notification_ws.register_socket(100, a)
                notification_ws.register_socket(200, b)
                # 定向：只推给 user 100
                await notification_ws._push_event({"kind": "notification", "user_id": 100, "id": 1})
                assert len(a.sent) == 1 and len(b.sent) == 0
                # 广播（user_id=None）：全员收到
                await notification_ws._push_event({"kind": "notification", "user_id": None, "id": 2})
                assert len(a.sent) == 2 and len(b.sent) == 1
                payload = json.loads(a.sent[0])
                assert payload["id"] == 1 and payload["kind"] == "notification"
            finally:
                notification_ws.unregister_socket(100, a)
                notification_ws.unregister_socket(200, b)

        asyncio.run(run())

    def test_no_connection_is_silent(self):
        """无在线连接时静默返回（不抛异常）。"""
        asyncio.run(notification_ws._push_event({"kind": "notification", "user_id": 999, "id": 3}))


class TestConnectionRegistry:
    def test_register_unregister_counts(self):
        ws1, ws2 = _FakeWS(), _FakeWS()
        assert notification_ws.total_connections() == 0
        notification_ws.register_socket(7, ws1)
        notification_ws.register_socket(7, ws2)  # 同一用户多标签页
        assert notification_ws.total_connections() == 2
        notification_ws.unregister_socket(7, ws1)
        assert notification_ws.total_connections() == 1
        notification_ws.unregister_socket(7, ws2)
        assert notification_ws.total_connections() == 0

    def test_unregister_unknown_is_noop(self):
        notification_ws.unregister_socket(12345, _FakeWS())


# ============ WS 端点集成（TestClient 内存握手，无 Redis） ============

def _expect_close_4401(session) -> None:
    """断言服务端以 4401 关闭（Starlette 0.38 receive() 对 close 帧返回 dict 而非抛异常）。"""
    msg = session.receive()
    assert msg["type"] == "websocket.close"
    assert msg.get("code") == 4401


class TestWsEndpoint:
    def test_invalid_token_closed_with_4401(self, ws_client):
        with ws_client.websocket_connect("/ws/notifications?token=invalid-token") as s:
            _expect_close_4401(s)

    def test_missing_token_closed_with_4401(self, ws_client):
        with ws_client.websocket_connect("/ws/notifications") as s:
            _expect_close_4401(s)

    def test_valid_token_ping_pong(self, ws_client):
        token = _make_token(1)
        with ws_client.websocket_connect(f"/ws/notifications?token={token}") as s:
            s.send_json({"type": "ping"})
            assert s.receive_json() == {"type": "pong"}

    def test_token_via_subprotocol(self, ws_client):
        """主路径：token 经子协议头传递（不落访问日志）。"""
        token = _make_token(1)
        with ws_client.websocket_connect(
            "/ws/notifications", subprotocols=["bearer", token]
        ) as s:
            s.send_json({"type": "ping"})
            assert s.receive_json() == {"type": "pong"}

    def test_invalid_token_via_subprotocol_closed_with_4401(self, ws_client):
        with ws_client.websocket_connect(
            "/ws/notifications", subprotocols=["bearer", "not-a-jwt"]
        ) as s:
            _expect_close_4401(s)

    def test_inactive_user_rejected(self, monkeypatch):
        _seed_user(42, active=False)
        monkeypatch.setattr(ws_api, "SessionLocal", _TestSessionLocal)
        client = TestClient(_app)
        token = _make_token(42)
        with client.websocket_connect(f"/ws/notifications?token={token}") as s:
            _expect_close_4401(s)
