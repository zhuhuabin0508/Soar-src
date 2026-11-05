"""用户管理回归测试：用户名修改、创建与删除用户。

覆盖：
- PUT /users/{id} 可修改登录用户名，并校验重名冲突（不区分大小写）
- 非管理员不可修改用户名，但仍可更新其它基础资料
- 用户名空白/长度边界校验
- POST /users 创建时统一去空格，并拒绝大小写不同的重名
- DELETE /users/{id} 清理关联数据，同时保留反馈/工单等业务记录并解绑会悬空的引用
- 旧部署缺少 agent_memories 等表时，删除用户不应 500

运行：python -m pytest tests/test_user_management.py -v
"""
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1 import users as users_module
from app.api.v1.users import router as users_router
from app.database import Base, get_db
from app.dependencies import get_current_user
from app.models.agent_memory import AgentMemory
from app.models.chat_message import ChatMessage
from app.models.chat_session import ChatSession
from app.models.feedback import Feedback
from app.models.notification import Notification
from app.models.notification_rule import NotificationRule
from app.models.resource_share import ResourceShare
from app.models.role import Role
from app.models.system_config import SystemConfig
from app.models.ticket import TicketCc, TicketGroupMember
from app.models.user import User
from app.models.user_notification_pref import UserNotificationPref

_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

# 测试固定使用 SQLite 内存库（SQLite 不校验外键目标表是否存在）。
# 若未来切换 PostgreSQL：需同时创建被外键引用的表
# （ticket_groups / ticket_flows / tickets / agents / llm_configs 等）。
_TABLES = [
    User.__table__,
    Role.__table__,
    SystemConfig.__table__,
    AgentMemory.__table__,
    TicketGroupMember.__table__,
    ChatMessage.__table__,
    ChatSession.__table__,
    UserNotificationPref.__table__,
    Notification.__table__,
    NotificationRule.__table__,
    Feedback.__table__,
    ResourceShare.__table__,
    TicketCc.__table__,
]
Base.metadata.create_all(_engine, tables=_TABLES)

_app = FastAPI()
_app.include_router(users_router)


def _reset_db():
    """重建内存表，避免用例相互污染。"""
    Base.metadata.drop_all(_engine, tables=_TABLES)
    Base.metadata.create_all(_engine, tables=_TABLES)


def _seed_user(uid: int, username: str, role: str = "analyst", role_id: int | None = None) -> User:
    db = _TestSessionLocal()
    try:
        user = User(id=uid, username=username, password_hash="x", role=role, role_id=role_id)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        db.close()


def _seed_user_manager_role(role_id: int = 9) -> None:
    """拥有 user:view/edit 但非 admin 的自定义角色。"""
    db = _TestSessionLocal()
    try:
        db.add(Role(
            id=role_id,
            name="user_manager",
            permissions={"user": ["view", "edit"]},
            is_system=False,
        ))
        db.commit()
    finally:
        db.close()


def _client(current_user: User) -> TestClient:
    """每个请求使用独立 session，避免测试之间共享事务/连接。"""

    def _override_db():
        db = _TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    _app.dependency_overrides[get_db] = _override_db
    _app.dependency_overrides[get_current_user] = lambda: current_user
    return TestClient(_app)


def _user_by_id(uid: int) -> User | None:
    db = _TestSessionLocal()
    try:
        return db.query(User).filter(User.id == uid).first()
    finally:
        db.close()


def test_update_username_takes_effect():
    _reset_db()
    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "old_name")
    client = _client(admin)

    resp = client.put("/users/2", json={"username": "  new_name  "})

    assert resp.status_code == 200, resp.text
    assert resp.json()["username"] == "new_name"
    assert _user_by_id(2).username == "new_name"


def test_update_username_rejects_duplicate_case_insensitively():
    _reset_db()
    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "old_name")
    client = _client(admin)

    resp = client.put("/users/2", json={"username": "Admin"})

    assert resp.status_code == 409, resp.text
    assert _user_by_id(2).username == "old_name"


def test_update_username_rejects_invalid_boundaries():
    _reset_db()
    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "old_name")
    client = _client(admin)

    # 全空白通过 schema 的 min_length，但接口去空格后应返回 400
    assert client.put("/users/2", json={"username": "  "}).status_code == 400
    # 长度由 schema 拦截（422）
    assert client.put("/users/2", json={"username": "a"}).status_code == 422
    assert client.put("/users/2", json={"username": "x" * 65}).status_code == 422
    assert _user_by_id(2).username == "old_name"


def test_update_username_only_admin_can_change():
    _reset_db()
    _seed_user_manager_role()
    operator = _seed_user(1, "operator", role="analyst", role_id=9)
    _seed_user(2, "target")
    client = _client(operator)

    denied = client.put("/users/2", json={"username": "hacked"})
    assert denied.status_code == 403, denied.text
    assert _user_by_id(2).username == "target"

    # 非管理员提交未变化的用户名仍允许更新其它基础资料
    ok = client.put("/users/2", json={"username": "target", "display_name": "新显示名"})
    assert ok.status_code == 200, ok.text
    assert _user_by_id(2).display_name == "新显示名"


def test_create_user_normalizes_and_rejects_case_insensitive_duplicate(monkeypatch):
    # CI 环境可能缺少 bcrypt backend，创建用户只校验请求处理逻辑，替换密码哈希实现
    monkeypatch.setattr(users_module, "hash_password", lambda _pw: "x")
    _reset_db()
    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "existing")
    client = _client(admin)

    created = client.post("/users", json={
        "username": "  trimmed_user  ",
        "password": "Str0ng@Pass",
    })
    assert created.status_code == 201, created.text
    assert created.json()["username"] == "trimmed_user"

    duplicate = client.post("/users", json={
        "username": "EXISTING",
        "password": "Str0ng@Pass",
    })
    assert duplicate.status_code == 409, duplicate.text


def test_delete_user_cleans_related_rows_and_keeps_business_data():
    _reset_db()
    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "to_delete")
    _seed_user(3, "other_user")

    db = _TestSessionLocal()
    db.add_all([
        TicketGroupMember(group_id=1, user_id=2),
        AgentMemory(user_id=2, agent_id=1, content="mem"),
        ChatSession(agent_id=1, user_id=2, session_id="s1"),
        ChatMessage(agent_id=1, user_id=2, session_id="s1", role="user", content="hi"),
        UserNotificationPref(user_id=2, event_type="ticket"),
        Notification(user_id=2, type="system_alert", title="提醒"),
        ResourceShare(resource_type="workflow", resource_id=1, shared_with=2, granted_by=1),
        ResourceShare(resource_type="workflow", resource_id=2, shared_with=1, granted_by=2),
        TicketCc(ticket_id=99, target_type="user", target_id=2, target_name="to_delete"),
        Feedback(user_id=2, type="bug", title="问题", description="描述", assignee_id=2),
        NotificationRule(name="反馈通知", event_type="feedback", target_user_ids="[1, 2]"),
        # 其他用户的数据必须保留，验证删除隔离性
        ChatSession(agent_id=1, user_id=3, session_id="s3"),
        ChatMessage(agent_id=1, user_id=3, session_id="s3", role="user", content="keep"),
        Notification(user_id=3, type="system_alert", title="保留"),
        Feedback(user_id=3, type="bug", title="保留反馈", description="描述", assignee_id=3),
    ])
    db.commit()
    db.close()

    resp = _client(admin).delete("/users/2")

    assert resp.status_code == 204, resp.text
    assert _user_by_id(2) is None

    db = _TestSessionLocal()
    try:
        assert db.query(TicketGroupMember).filter(TicketGroupMember.user_id == 2).count() == 0
        assert db.query(AgentMemory).filter(AgentMemory.user_id == 2).count() == 0
        assert db.query(ChatSession).filter(ChatSession.user_id == 2).count() == 0
        assert db.query(ChatMessage).filter(ChatMessage.user_id == 2).count() == 0
        assert db.query(UserNotificationPref).filter(UserNotificationPref.user_id == 2).count() == 0
        assert db.query(Notification).filter(Notification.user_id == 2).count() == 0
        assert db.query(ResourceShare).filter(
            (ResourceShare.shared_with == 2) | (ResourceShare.granted_by == 2)
        ).count() == 0
        assert db.query(TicketCc).filter(
            TicketCc.target_type == "user", TicketCc.target_id == 2
        ).count() == 0

        # 业务记录保留：反馈仍在，但处理人引用被清空
        feedback = db.query(Feedback).filter(Feedback.user_id == 2).one()
        assert feedback.assignee_id is None
        # 通知规则中移除已删除用户
        rule = db.query(NotificationRule).one()
        assert rule.get_target_user_ids() == [1]

        # 其他用户数据不受影响
        assert db.query(ChatSession).filter(ChatSession.user_id == 3).count() == 1
        assert db.query(ChatMessage).filter(ChatMessage.user_id == 3).count() == 1
        assert db.query(Notification).filter(Notification.user_id == 3).count() == 1
        kept_feedback = db.query(Feedback).filter(Feedback.user_id == 3).one()
        assert kept_feedback.assignee_id == 3
    finally:
        db.close()


def test_delete_user_skips_missing_optional_table():
    """旧部署可能尚未创建 agent_memories，删除用户不应因此 500。"""
    _reset_db()
    Base.metadata.drop_all(_engine, tables=[AgentMemory.__table__])

    admin = _seed_user(1, "admin", role="admin")
    _seed_user(2, "to_delete")
    db = _TestSessionLocal()
    db.add(TicketGroupMember(group_id=1, user_id=2))
    db.commit()
    db.close()

    resp = _client(admin).delete("/users/2")

    assert resp.status_code == 204, resp.text
    assert _user_by_id(2) is None
