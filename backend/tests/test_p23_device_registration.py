# -*- coding: utf-8 -*-
"""P2-3 单测：enabled_devices 装配 + 作用域收窄（防越权）。"""
import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.core.tools.registry_builder import ToolRegistryBuilder
from app.devices.as_tool import build_device_action_facade_tool


def _agent(**kwargs):
    defaults = dict(
        id=1, enabled_tools=[], enabled_kbs=[], enabled_asset_types=[],
        enabled_skills=[], enabled_workflows=[], enabled_devices=None,
        tool_configs={},
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _device(id=3, status="online", enabled=True):
    return SimpleNamespace(id=id, name=f"设备{id}", type="firewall",
                           vendor="v", enabled=enabled, status=status, description="")


def _action(id, device_id=3, action_type="block_ip", category="block",
            risk_level="high_risk", enabled=True):
    return SimpleNamespace(
        id=id, device_id=device_id, name=f"动作{id}", action_type=action_type,
        category=category, risk_level=risk_level, params_schema="[]",
        description="", enabled=enabled,
    )


def _match(row, expr) -> bool:
    """评估单个 SQLAlchemy filter 表达式是否匹配 row（SimpleNamespace）。

    支持 in_ / is_ / eq / ne；其他表达式默认 True（不过滤）。
    """
    try:
        left = expr.left
        key = getattr(left, "key", None)
        if key is None:
            return True
        val = getattr(row, key, None)
        op_name = getattr(expr.operator, "__name__", "")
        right = expr.right
        if op_name == "in_op":
            if hasattr(right, "element"):
                rv = list(right.element)
            elif hasattr(right, "value"):
                rv = right.value
            else:
                rv = list(right)
            return val in rv
        if op_name in ("is_", "eq"):
            rv = right.value if hasattr(right, "value") else right
            return val == rv
        if op_name == "ne":
            rv = right.value if hasattr(right, "value") else right
            return val != rv
    except Exception:
        pass
    return True


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows
        self._filters = []

    def filter(self, *clauses):
        self._filters.extend(clauses)
        return self

    def all(self):
        return [r for r in self._rows if all(_match(r, c) for c in self._filters)]


def _fake_db(devices, actions):
    """假 db：query(Device) 返回 devices，query(DeviceAction) 返回 actions，
    并按 filter 表达式真实过滤（离线/禁用设备会被排除）。"""
    from app.models.device import Device, DeviceAction
    db = MagicMock()
    db.query.side_effect = lambda m: _FakeQuery(devices) if m is Device else _FakeQuery(actions)
    return db


# ============================================================================
# 门面作用域收窄（防越权：勾设备 3 却操作设备 5）
# ============================================================================

class TestFacadeScope:
    def test_facade_blocks_out_of_scope_device(self):
        tool = build_device_action_facade_tool(None, allowed_device_ids={3})
        out = asyncio.run(tool.coroutine(device_id=5, action_type="block_ip"))
        assert isinstance(out, dict) and "error" in out
        assert "5" in out["error"]
        assert "enabled_devices" in out["error"]

    def test_facade_allows_in_scope_device(self):
        tool = build_device_action_facade_tool(None, allowed_device_ids={3})
        action = _action(id=7, device_id=3, category="block", risk_level="high_risk")
        with patch(
            "app.devices.action_executor.find_device_action_by_type",
            return_value=(None, action, None),
        ), patch("app.devices.gateway.DeviceGateway.invoke") as mock_invoke:
            mock_invoke.return_value = {"ok": True}
            out = asyncio.run(tool.coroutine(device_id=3, action_type="block_ip", ip="1.1.1.1"))
        assert out == {"ok": True}
        mock_invoke.assert_called_once()
        kwargs = mock_invoke.call_args.kwargs
        assert kwargs.get("idempotency_key")
        assert kwargs.get("action_id") == 7

    def test_facade_none_allowed_unrestricted(self):
        tool = build_device_action_facade_tool(None, allowed_device_ids=None)
        action = _action(id=1, device_id=999, category="block", risk_level="high_risk")
        with patch(
            "app.devices.action_executor.find_device_action_by_type",
            return_value=(None, action, None),
        ), patch("app.devices.gateway.DeviceGateway.invoke") as mock_invoke:
            mock_invoke.return_value = {"ok": True}
            out = asyncio.run(tool.coroutine(device_id=999, action_type="block_ip"))
        assert out == {"ok": True}


# ============================================================================
# registry_builder._register_device_tools 装配逻辑
# ============================================================================

_DEVICE_TOOL_NAMES = ("list_devices", "list_device_actions", "device_action")


def _device_tool_names(registry):
    return [n for n in registry if n.startswith("device_") or n in _DEVICE_TOOL_NAMES]


class TestDeviceRegistration:
    def test_enabled_devices_assembles_projections_enums_facade(self):
        devices = [_device(id=3)]
        actions = [_action(id=7, device_id=3), _action(id=8, device_id=3)]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        names = set(registry)
        # 枚举 + 门面
        assert {"list_devices", "list_device_actions", "device_action"} <= names
        # 两个动作投影
        assert {"device_3_7", "device_3_8"} <= names

    def test_many_reads_keep_core_write_drop_read_projection(self):
        from app.core.tools.registry_builder import MAX_PROJECTION_READS_PER_DEVICE

        devices = [_device(id=3)]
        reads = [
            _action(id=i, device_id=3, action_type="list_hosts", category="query", risk_level="readonly")
            for i in range(1, MAX_PROJECTION_READS_PER_DEVICE + 2)
        ]
        writes = [_action(id=90, device_id=3)]
        db = _fake_db(devices, reads + writes)
        registry = ToolRegistryBuilder(db, _agent(enabled_devices=[3])).build()
        assert "device_3_90" in registry
        assert "list_device_actions" in registry
        assert not any(n.startswith("device_3_") and n != "device_3_90" for n in registry)

    def test_enabled_devices_empty_no_device_tools(self):
        db = _fake_db([], [])
        agent = _agent(enabled_devices=[])
        registry = ToolRegistryBuilder(db, agent).build()
        assert _device_tool_names(registry) == []

    def test_enabled_devices_none_no_device_tools(self):
        # A-4 兼容：既有 Agent 无 enabled_devices 列值 → 不装配
        db = _fake_db([], [])
        agent = _agent()  # enabled_devices=None
        registry = ToolRegistryBuilder(db, agent).build()
        assert _device_tool_names(registry) == []

    def test_offline_device_no_projection_but_enums_exist(self):
        devices = [_device(id=3, status="offline")]
        actions = [_action(id=7, device_id=3)]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        names = set(registry)
        # 枚举工具仍在（告知 LLM 可用设备范围）
        assert "list_devices" in names
        assert "list_device_actions" in names
        # 离线设备不投影动作
        assert "device_3_7" not in names
        # 勾选设备全离线 → 门面也不暴露
        assert "device_action" not in names

    def test_disabled_device_filtered(self):
        devices = [_device(id=3, enabled=False)]
        actions = [_action(id=7, device_id=3)]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        assert "device_3_7" not in registry
        assert "device_action" not in registry

    def test_disabled_action_filtered(self):
        devices = [_device(id=3)]
        actions = [_action(id=7, device_id=3, enabled=False)]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        assert "device_3_7" not in registry

    def test_invalid_device_ids_ignored(self):
        devices = [_device(id=3)]
        actions = [_action(id=7, device_id=3)]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3, "abc", None, "5x"])
        registry = ToolRegistryBuilder(db, agent).build()
        assert "device_3_7" in registry

    def test_non_core_write_not_projected(self):
        devices = [_device(id=3)]
        actions = [
            _action(id=7, device_id=3, category="block", risk_level="high_risk"),
            _action(
                id=9, device_id=3, action_type="custom_write",
                category="other", risk_level="high_risk",
            ),
            _action(
                id=8, device_id=3, action_type="query_logs",
                category="query", risk_level="readonly",
            ),
        ]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        assert "device_3_7" in registry
        assert "device_3_8" in registry
        assert "device_3_9" not in registry
        assert "device_action" in registry


# ============================================================================
# 派生治理集合：写投影进 never_parallel + verification；读投影不进
# ============================================================================

class TestDerivedGovernance:
    def test_write_projection_in_never_parallel_and_verify(self):
        from app.core.tools.derive import (
            never_parallel_names, write_tools_requiring_verification,
        )
        devices = [_device(id=3)]
        actions = [
            _action(id=7, device_id=3, category="block", risk_level="high_risk"),   # 写
            _action(id=8, device_id=3, action_type="query_logs", category="query",
                    risk_level="readonly"),  # 读
        ]
        db = _fake_db(devices, actions)
        agent = _agent(enabled_devices=[3])
        registry = ToolRegistryBuilder(db, agent).build()
        never = never_parallel_names(registry)
        verify = write_tools_requiring_verification(registry)
        # 写动作：进 barrier + 验证
        assert "device_3_7" in never
        assert "device_3_7" in verify
        # 读动作：可并行、不验证
        assert "device_3_8" not in never
        assert "device_3_8" not in verify
        # 门面：写动作
        assert "device_action" in never
        assert "device_action" in verify


# ============================================================================
# P2-4b：语义 block_ip 装配（§11.1 = A2）
# ============================================================================

class TestBlockIpAssembly:
    def test_assembled_when_blockable_device_exists(self):
        db = _fake_db([_device(id=3)], [_action(id=7, device_id=3, action_type="block_ip")])
        registry = ToolRegistryBuilder(db, _agent(enabled_devices=[3])).build()
        assert "block_ip" in registry
        assert registry["block_ip"].danger_level == "high"

    def test_not_assembled_when_no_block_action(self):
        db = _fake_db(
            [_device(id=3)],
            [_action(id=7, device_id=3, action_type="query_logs",
                     category="query", risk_level="readonly")],
        )
        registry = ToolRegistryBuilder(db, _agent(enabled_devices=[3])).build()
        assert "block_ip" not in registry

    def test_not_assembled_when_device_offline(self):
        db = _fake_db([_device(id=3, status="offline")],
                      [_action(id=7, device_id=3, action_type="block_ip")])
        registry = ToolRegistryBuilder(db, _agent(enabled_devices=[3])).build()
        assert "block_ip" not in registry

    def test_not_assembled_without_enabled_devices(self):
        db = _fake_db([_device(id=3)], [_action(id=7, device_id=3, action_type="block_ip")])
        registry = ToolRegistryBuilder(db, _agent(enabled_devices=[])).build()
        assert "block_ip" not in registry
