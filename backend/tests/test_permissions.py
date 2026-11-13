"""权限矩阵回归测试。

覆盖：
- 角色权限矩阵中新增动作（handle / pause）与中文标签
- alert:export 的升级迁移
- require_permission 对“有 view 无 edit/export”的角色返回 403，授权后放行

运行：python -m pytest tests/test_permissions.py -v
"""
import os
import sys

sys.path.insert(
    0,
    "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.permissions import (
    ACTION_LABELS,
    DEFAULT_ROLES,
    PERMISSION_MODULES,
    migrate_permissions,
)
from app.database import Base, get_db
from app.dependencies import get_current_user, require_permission
from app.models.role import Role
from app.models.user import User

_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_SessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


@pytest.fixture()
def viewer_user():
    """创建一个仅有 view 权限的测试用户。"""
    Base.metadata.create_all(bind=_engine, tables=[User.__table__, Role.__table__])
    db = _SessionLocal()
    try:
        db.query(User).delete()
        db.query(Role).delete()
        db.commit()
        role = Role(
            name="perm_test_viewer",
            description="权限测试只读角色",
            permissions={
                "knowledge_base": ["view"],
                "agent": ["view"],
                "alert": ["view"],
            },
            is_system=False,
        )
        db.add(role)
        db.commit()
        db.refresh(role)
        user = User(
            username="perm_test_viewer",
            password_hash="x",
            role="viewer",
            role_id=role.id,
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user
    finally:
        db.close()


@pytest.fixture()
def client(viewer_user):
    """挂载探针路由的测试客户端，覆盖 get_db / get_current_user。"""
    app = FastAPI()

    @app.get("/probe/kb")
    def _kb_view(_: User = Depends(require_permission("knowledge_base", "view"))):
        return {"ok": True}

    @app.post("/probe/kb")
    def _kb_edit(_: User = Depends(require_permission("knowledge_base", "edit"))):
        return {"ok": True}

    @app.post("/probe/agent")
    def _agent_edit(_: User = Depends(require_permission("agent", "edit"))):
        return {"ok": True}

    @app.post("/probe/alert-export")
    def _alert_export(_: User = Depends(require_permission("alert", "export"))):
        return {"ok": True}

    def _override_db():
        db = _SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: viewer_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_viewer_can_read_knowledge_base(client):
    assert client.get("/probe/kb").status_code == 200


def test_viewer_cannot_edit_knowledge_base(client):
    assert client.post("/probe/kb").status_code == 403


def test_viewer_cannot_create_agent_without_edit(client):
    assert client.post("/probe/agent").status_code == 403


def test_alert_export_requires_dedicated_action(client):
    # 角色只有 alert:view，导出应被拒绝
    assert client.post("/probe/alert-export").status_code == 403


def test_alert_export_is_not_auto_granted():
    # alert:export 必须是独立开关，migrate_permissions 不能因 view 自动补权
    migrated = migrate_permissions({"alert": ["view", "handle"]})
    assert "export" not in migrated["alert"]

    # 内置 analyst / viewer 默认具备导出能力，保持升级前行为
    defaults = {role["name"]: role["permissions"] for role in DEFAULT_ROLES}
    assert "export" in defaults["analyst"]["alert"]
    assert "export" in defaults["viewer"]["alert"]


def test_handle_and_pause_actions_defined():
    assert "handle" in PERMISSION_MODULES["alert"]
    assert "pause" in PERMISSION_MODULES["ticket"]
    assert ACTION_LABELS.get("handle") == "处置"
    assert ACTION_LABELS.get("pause") == "暂停/恢复"
