"""个人通知提醒偏好 API 单测。

覆盖：
- GET /notifications/prefs：类型目录合并默认值（工单滑出、其余静默）、customized 标记
- PUT /notifications/prefs：upsert 单类型偏好（新增 / 覆盖）、非法类型与非法取值 422
- DELETE /notifications/prefs：恢复默认（清空个人偏好）
- 多用户隔离：A 的偏好不影响 B
- EVENT_TYPES 目录含工单类型（工单通知精确投递，偏好需覆盖该类型）

运行：python -m pytest tests/test_notification_prefs.py -v
"""
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.notifications import router as notifications_router
from app.api.v1.notification_rules import EVENT_TYPES
from app.database import Base, get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.models.user_notification_pref import UserNotificationPref

# ============ 测试基础设施：内存 SQLite + 依赖覆盖 ============
_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

Base.metadata.create_all(_engine, tables=[User.__table__, UserNotificationPref.__table__])

_app = FastAPI()
_app.include_router(notifications_router)


def _seed_user(username: str, uid: int) -> User:
    db = _TestSessionLocal()
    try:
        u = User(id=uid, username=username, password_hash="x", role="admin")
        db.add(u)
        db.commit()
        db.refresh(u)
        return u
    finally:
        db.close()


def _client(user: User) -> TestClient:
    """构造覆盖当前用户与测试库的 TestClient（admin 角色自动通过权限矩阵）。"""
    db = _TestSessionLocal()

    def _override_db():
        try:
            yield db
        finally:
            db.rollback()

    _app.dependency_overrides[get_db] = _override_db
    _app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(_app)


def _clear_prefs():
    db = _TestSessionLocal()
    try:
        db.query(UserNotificationPref).delete()
        db.commit()
    finally:
        db.close()


# ============ 类型目录与默认策略 ============

class TestEventTypesCatalog:
    def test_event_types_contains_ticket(self):
        """工单通知由工单模块精确投递，EVENT_TYPES 需收录 ticket 供个人偏好覆盖。"""
        values = [m["value"] for m in EVENT_TYPES]
        assert "ticket" in values


class TestGetPrefs:
    def test_returns_catalog_with_defaults(self):
        _clear_prefs()
        user = _seed_user("alice", 1)
        client = _client(user)

        res = client.get("/notifications/prefs")
        assert res.status_code == 200
        prefs = res.json()["prefs"]

        # 目录完整（除通配 * 外的所有事件类型）
        values = {p["event_type"] for p in prefs}
        expected = {m["value"] for m in EVENT_TYPES if m["value"] != "*"}
        assert values == expected

        by_type = {p["event_type"]: p for p in prefs}
        # 默认策略：工单滑出，公告/告警静默
        assert by_type["ticket"]["popup_mode"] == "toast"
        assert by_type["announcement"]["popup_mode"] == "silent"
        assert by_type["alert_high_risk"]["popup_mode"] == "silent"
        # 未配置时 customized=False
        assert all(p["customized"] is False for p in prefs)
        # 返回可选值清单
        modes = {m["value"] for m in res.json()["popup_modes"]}
        assert modes == {"toast", "silent"}

    def test_excludes_wildcard(self):
        _clear_prefs()
        user = _seed_user("bob", 2)
        client = _client(user)

        res = client.get("/notifications/prefs")
        values = {p["event_type"] for p in res.json()["prefs"]}
        assert "*" not in values


class TestUpdatePref:
    def test_upsert_creates_and_updates(self):
        _clear_prefs()
        user = _seed_user("carol", 3)
        client = _client(user)

        # 新增
        res = client.put("/notifications/prefs", json={"event_type": "announcement", "popup_mode": "toast"})
        assert res.status_code == 200
        assert res.json()["popup_mode"] == "toast"

        res = client.get("/notifications/prefs")
        by_type = {p["event_type"]: p for p in res.json()["prefs"]}
        assert by_type["announcement"]["popup_mode"] == "toast"
        assert by_type["announcement"]["customized"] is True
        # 其它类型不受影响（仍是默认值）
        assert by_type["ticket"]["popup_mode"] == "toast"

        # 覆盖（upsert，不产生重复行）
        res = client.put("/notifications/prefs", json={"event_type": "announcement", "popup_mode": "silent"})
        assert res.status_code == 200
        res = client.get("/notifications/prefs")
        by_type = {p["event_type"]: p for p in res.json()["prefs"]}
        assert by_type["announcement"]["popup_mode"] == "silent"

        db = _TestSessionLocal()
        try:
            assert db.query(UserNotificationPref).filter_by(user_id=3, event_type="announcement").count() == 1
        finally:
            db.close()

    def test_invalid_event_type_rejected(self):
        _clear_prefs()
        user = _seed_user("dave", 4)
        client = _client(user)

        res = client.put("/notifications/prefs", json={"event_type": "no_such_type", "popup_mode": "toast"})
        assert res.status_code == 422

    def test_wildcard_rejected(self):
        """通配 * 仅用于通知规则路由，个人偏好不接受。"""
        _clear_prefs()
        user = _seed_user("erin", 5)
        client = _client(user)

        res = client.put("/notifications/prefs", json={"event_type": "*", "popup_mode": "toast"})
        assert res.status_code == 422

    def test_invalid_popup_mode_rejected(self):
        _clear_prefs()
        user = _seed_user("frank", 6)
        client = _client(user)

        res = client.put("/notifications/prefs", json={"event_type": "ticket", "popup_mode": "popup"})
        assert res.status_code == 422

    def test_user_isolation(self):
        """A 的偏好只影响 A。"""
        _clear_prefs()
        alice = _seed_user("alice2", 11)
        bob = _seed_user("bob2", 12)

        ca = _client(alice)
        res = ca.put("/notifications/prefs", json={"event_type": "ticket", "popup_mode": "silent"})
        assert res.status_code == 200

        # Bob 仍是默认（工单滑出）
        cb = _client(bob)
        res = cb.get("/notifications/prefs")
        by_type = {p["event_type"]: p for p in res.json()["prefs"]}
        assert by_type["ticket"]["popup_mode"] == "toast"
        assert by_type["ticket"]["customized"] is False


class TestResetPrefs:
    def test_reset_restores_defaults(self):
        _clear_prefs()
        user = _seed_user("grace", 7)
        client = _client(user)

        client.put("/notifications/prefs", json={"event_type": "ticket", "popup_mode": "silent"})
        client.put("/notifications/prefs", json={"event_type": "announcement", "popup_mode": "toast"})

        res = client.delete("/notifications/prefs")
        assert res.status_code == 200
        assert res.json()["deleted_count"] == 2

        # 幂等：再删一次为 0
        res = client.delete("/notifications/prefs")
        assert res.status_code == 200
        assert res.json()["deleted_count"] == 0

        res = client.get("/notifications/prefs")
        prefs = res.json()["prefs"]
        by_type = {p["event_type"]: p for p in prefs}
        assert by_type["ticket"]["popup_mode"] == "toast"
        assert by_type["announcement"]["popup_mode"] == "silent"
        assert all(p["customized"] is False for p in prefs)

        db = _TestSessionLocal()
        try:
            assert db.query(UserNotificationPref).filter_by(user_id=7).count() == 0
        finally:
            db.close()
