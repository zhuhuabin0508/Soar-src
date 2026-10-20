# -*- coding: utf-8 -*-
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.core.tools.authz import user_may_call
from app.core.tools.descriptor import ToolDescriptor
from app.core.tools.registry_builder import ToolRegistryBuilder
from app.devices.as_tool import build_block_ip_tool, build_list_devices_tool


def _user(role="analyst", role_id=None, user_id=2):
    return SimpleNamespace(id=user_id, role=role, role_id=role_id)


def _agent():
    return SimpleNamespace(
        id=1, enabled_tools=[], enabled_kbs=[], enabled_asset_types=[],
        enabled_workflows=[], enabled_devices=[],
    )


def _desc(name, required):
    return ToolDescriptor(
        name=name, description="", args_schema=None, coroutine=None,
        required_permission=required,
    )


def test_analyst_cannot_call_device_edit():
    user = _user()
    assert user_may_call(user, MagicMock(), ("device", "view")) is True
    assert user_may_call(user, MagicMock(), ("device", "edit")) is False
    assert user_may_call(user, MagicMock(), ("tool", "execute")) is True
    assert user_may_call(user, MagicMock(), ("workflow_list", "execute")) is True
    assert user_may_call(user, MagicMock(), None) is True


def test_admin_can_call_device_edit():
    assert user_may_call(_user(role="admin", user_id=1), MagicMock(), ("device", "edit")) is True


def test_system_principal_skips_permission():
    assert user_may_call(None, MagicMock(), ("device", "edit")) is True


def test_filter_drops_block_ip_for_analyst():
    builder = ToolRegistryBuilder(MagicMock(), _agent(), user=_user())
    registry = {
        "list_devices": _desc("list_devices", ("device", "view")),
        "block_ip": _desc("block_ip", ("device", "edit")),
        "nmap_scan": _desc("nmap_scan", ("tool", "execute")),
    }
    kept = builder._filter_for_user(registry)
    assert set(kept) == {"list_devices", "nmap_scan"}


def test_filter_drops_critical_for_chat_user():
    builder = ToolRegistryBuilder(MagicMock(), _agent(), user=_user())
    registry = {
        "scan": _desc("scan", None),
        "wipe": ToolDescriptor(
            name="wipe", description="", args_schema=None, coroutine=None,
            danger_level="critical", required_permission=None,
        ),
    }
    kept = builder._filter_for_user(registry)
    assert set(kept) == {"scan"}


def test_no_user_does_not_filter():
    builder = ToolRegistryBuilder(MagicMock(), _agent())
    registry = {"block_ip": _desc("block_ip", ("device", "edit"))}
    assert builder.user is None
    assert set(builder._filter_for_user(registry)) == {"block_ip"}


def test_device_descriptors_declare_permission():
    read_tool = build_list_devices_tool(MagicMock(), {1})
    assert read_tool.required_permission == ("device", "view")
    write_tool = build_block_ip_tool(MagicMock(), _agent(), {1})
    assert write_tool.required_permission == ("device", "edit")
    assert write_tool.danger_level == "high"


def test_block_ip_on_firewall_is_not_a_callable_preset():
    from app.core.tools.catalog import ToolCatalog

    assert "block_ip_on_firewall" in ToolCatalog.removed_names()
    assert "block_ip_on_firewall" not in ToolCatalog.preset_name_index()
