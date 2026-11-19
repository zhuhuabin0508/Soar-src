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


def test_import_and_publish_actions_defined():
    for mod in (
        "asset_list", "asset_templates", "asset_discovery", "ban_workflow",
        "device", "strategy", "duty_member", "ip_library", "alert_rule",
        "skill", "tool", "user", "workflow_list",
    ):
        assert "import" in PERMISSION_MODULES[mod], mod
    assert "publish" in PERMISSION_MODULES["report"]
    assert ACTION_LABELS.get("import") == "导入"
    assert ACTION_LABELS.get("publish") == "发布"


def test_import_is_inherited_from_edit_only():
    # 升级前导入复用了 edit：已有 edit 的角色应自动保留导入能力
    migrated = migrate_permissions({"asset_list": ["view", "edit"]})
    assert "import" in migrated["asset_list"]
    # 只有 view 的角色不得自动获得导入
    migrated = migrate_permissions({"asset_list": ["view"]})
    assert "import" not in migrated["asset_list"]


def test_alert_rule_view_inherited_from_alert():
    migrated = migrate_permissions({"alert": ["view", "handle"]})
    # 查看权限继承自 alert；原导出复用 view，故同时补 export
    assert migrated["alert_rule"] == ["view", "export"]


def test_chat_execute_inherited_from_agent_execute():
    # 有智能体执行权限的存量角色补对话执行权限
    migrated = migrate_permissions({"chat": ["view"], "agent": ["view", "execute"]})
    assert migrated["chat"] == ["view", "execute"]
    # 只读角色保留对话历史查看，但不自动获得发起对话能力
    migrated = migrate_permissions({"chat": ["view"], "agent": ["view"]})
    assert migrated["chat"] == ["view"]


def test_export_actions_defined_and_legacy_cleaned():
    for mod in (
        "asset_list", "asset_templates", "asset_discovery", "deliverable",
        "device", "duty_schedule", "ip_library", "alert_rule", "skill",
        "tool", "user", "audit_log", "report", "knowledge_base",
    ):
        assert "export" in PERMISSION_MODULES[mod], mod

    migrated = migrate_permissions({
        "duty": ["view"],
        "workflow": ["view"],
        "ticket_config": [],
        "alert": [],
        "asset_list": ["view", "bogus_action"],
    })
    # 旧键只用于迁移，不再落库
    assert "duty" not in migrated and "workflow" not in migrated
    assert "duty_member" in migrated and "workflow_list" in migrated
    # 空权限项与非法动作清理
    assert "ticket_config" not in migrated and "alert" not in migrated
    assert "bogus_action" not in migrated["asset_list"]
    # 原 view 可导出的模块自动补 export，保持升级前行为
    assert "export" in migrated["asset_list"]


def test_stale_actions_removed():
    # asset_discovery 无删除能力，ip_library 无编辑能力：权限点不得保留
    assert "delete" not in PERMISSION_MODULES["asset_discovery"]
    assert "edit" not in PERMISSION_MODULES["ip_library"]

    migrated = migrate_permissions({
        "asset_discovery": ["view", "edit", "delete"],
        "ip_library": ["view", "edit"],
    })
    assert "delete" not in migrated["asset_discovery"]
    assert "edit" not in migrated["ip_library"]
    # 清理非法动作后仍保留合法权限
    assert "view" in migrated["asset_discovery"]
    assert "view" in migrated["ip_library"]

    defaults = {role["name"]: role["permissions"] for role in DEFAULT_ROLES}
    assert "delete" not in defaults["analyst"]["asset_discovery"]
    assert "edit" not in defaults["analyst"]["ip_library"]


def test_new_action_grants_only_during_upgrade():
    # 升级迁移时：edit → import、view → export、agent.execute → chat.execute
    perms = {
        "asset_list": ["view"],
        "skill": ["edit"],
        "chat": ["view"],
        "agent": ["view", "execute"],
    }
    upgraded = migrate_permissions(perms)
    assert "export" in upgraded["asset_list"]
    assert "import" in upgraded["skill"]
    assert "execute" in upgraded["chat"]

    # 运行期/角色编辑：不得自动补权，否则管理员无法取消导入/导出
    runtime = migrate_permissions(perms, grant_new_actions=False)
    assert "export" not in runtime["asset_list"]
    assert "import" not in runtime["skill"]
    assert "execute" not in runtime["chat"]

    # 关闭补权后，旧键迁移与非法动作清理仍然生效
    legacy = migrate_permissions(
        {"duty": ["view"], "asset_list": ["view", "bogus"]},
        grant_new_actions=False,
    )
    assert "duty" not in legacy and "duty_member" in legacy
    assert "bogus" not in legacy["asset_list"]
