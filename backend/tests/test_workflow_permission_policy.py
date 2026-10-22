# -*- coding: utf-8 -*-
"""工作流权限按图推导（与危险推导对称）：防「包一层工作流」绕过模块权限。"""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.agent.workflow_as_tool import workflow_permissions
from app.core.tools.authz import required_permission_set, user_may_call


def _graph(*nodes):
    """nodes 元素：节点类型 str，或 (type, data_dict)。"""
    built = []
    for i, n in enumerate(nodes):
        ntype, data = (n, {}) if isinstance(n, str) else n
        built.append({"id": f"n{i}", "type": ntype, "data": data})
    return {"nodes": built}


class TestWorkflowPermissions:
    def test_empty_graph_has_no_extra_permission(self):
        assert workflow_permissions({}) == ()
        assert workflow_permissions(None) == ()

    def test_block_ip_node_requires_device_edit(self):
        assert workflow_permissions(_graph("block_ip")) == (("device", "edit"),)

    def test_device_action_node_requires_device_edit(self):
        assert workflow_permissions(_graph("device_action")) == (("device", "edit"),)

    def test_dedup_same_permission(self):
        graph = _graph("block_ip", "device_action")
        assert workflow_permissions(graph) == (("device", "edit"),)

    def test_unknown_tool_node_defaults_to_tool_execute(self):
        graph = _graph(("tool", {"tool_name": "no_such_tool"}))
        assert workflow_permissions(graph) == (("tool", "execute"),)

    def test_tool_node_resolves_lookup(self):
        graph = _graph(("tool", {"tool_name": "kb_search"}), ("tool", {"tool_name": "other"}))
        perms = workflow_permissions(
            graph, lambda name: ("kb", "edit") if name == "kb_search" else None
        )
        assert perms == (("kb", "edit"), ("tool", "execute"))

    def test_send_notification_not_gated(self):
        assert workflow_permissions(_graph("send_notification", "end")) == ()

    def test_union_of_distinct_permissions(self):
        graph = _graph("block_ip", ("tool", {"tool_name": "no_such_tool"}))
        assert workflow_permissions(graph) == (
            ("device", "edit"), ("tool", "execute"),
        )


class TestPermissionSetNormalization:
    def test_single_permission_wrapped(self):
        assert required_permission_set(("device", "edit")) == (("device", "edit"),)

    def test_plural_kept_as_is(self):
        perms = (("workflow_list", "execute"), ("device", "edit"))
        assert required_permission_set(perms) == perms

    def test_none_and_empty(self):
        assert required_permission_set(None) == ()
        assert required_permission_set(()) == ()


class TestUserMayCallPlural:
    """多权限 = 全部满足才放行（堵工作流封装绕过）。"""

    def _user(self, role="analyst"):
        return SimpleNamespace(id=2, role=role, role_id=None)

    def test_all_satisfied_passes(self):
        required = (("workflow_list", "execute"), ("tool", "execute"))
        assert user_may_call(self._user(), MagicMock(), required) is True

    def test_missing_one_denies(self):
        # analyst 无 device:edit → 含 block_ip 节点的工作流工具整体拒绝
        required = (("workflow_list", "execute"), ("device", "edit"))
        assert user_may_call(self._user(), MagicMock(), required) is False

    def test_single_permission_unchanged(self):
        assert user_may_call(self._user(), MagicMock(), ("tool", "execute")) is True
        assert user_may_call(self._user(), MagicMock(), ("device", "edit")) is False

    def test_admin_passes_plural(self):
        required = (("workflow_list", "execute"), ("device", "edit"))
        assert user_may_call(self._user(role="admin"), MagicMock(), required) is True
