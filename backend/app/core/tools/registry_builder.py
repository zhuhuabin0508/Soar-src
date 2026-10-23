"""唯一工具装配工厂：模块→工具契约的唯一登记点。"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from app.core.tools.descriptor import ToolDescriptor
from app.core.tools.governance_legacy import (
    LEGACY_NEVER_PARALLEL,
    LEGACY_PARALLEL_SAFE,
    PARALLEL_SAFE_PREFIXES,
)

logger = logging.getLogger(__name__)

MAX_PROJECTION_READS_PER_DEVICE = 20


def descriptor_to_tool_entry(d: ToolDescriptor):
    from app.agent.hermes.types import ToolEntry

    return ToolEntry(
        name=d.name,
        description=d.description,
        args_schema=d.args_schema,
        coroutine=d.coroutine,
        source=d.source,
        parallel_safe=d.parallel_safe,
        untrusted=d.untrusted,
        parameters=d.parameters,
    )


class ToolRegistryBuilder:
    """唯一工具装配工厂。

    agent=None 时为**系统级注册表**：仅含全部启用的 DB 工具；
    KB / 资产 / 工作流 / 设备类工具因需显式勾选，系统级不含
    （调用方须传 agent / agent_id 才能装配）。
    """
    def __init__(
        self,
        db,
        agent,
        *,
        user: Optional[Any] = None,
        user_id: Optional[int] = None,
    ):
        self.db = db
        self.agent = agent
        if user_id is not None:
            self.user_id = user_id
        else:
            self.user_id = getattr(user, "id", None) if user is not None else None
        self.user = user
        self._preset_index: Optional[dict[str, dict]] = None

    def build(self) -> dict[str, ToolDescriptor]:
        registry: dict[str, ToolDescriptor] = {}
        self._register_db_tools(registry)
        self._register_kb_tools(registry)
        self._register_asset_tools(registry)
        self._register_workflow_tools(registry)
        self._register_device_tools(registry)
        if self.user is not None:
            registry = self._filter_for_user(registry)
        return registry

    def _filter_for_user(self, registry: dict[str, ToolDescriptor]) -> dict[str, ToolDescriptor]:
        from app.core.tools.authz import user_may_call

        kept: dict[str, ToolDescriptor] = {}
        for name, desc in registry.items():
            if (desc.danger_level or "low").lower() == "critical":
                logger.info(
                    "工具因最高危未装配到对话: name=%s user_id=%s",
                    name,
                    getattr(self.user, "id", None),
                )
                continue
            if user_may_call(self.user, self.db, desc.required_permission):
                kept[name] = desc
            else:
                logger.info(
                    "工具因角色权限未装配: name=%s need=%s user_id=%s",
                    name,
                    desc.required_permission,
                    getattr(self.user, "id", None),
                )
        return kept

    def _preset_meta(self, name: str) -> dict:
        if self._preset_index is None:
            from app.core.tools.catalog import ToolCatalog

            self._preset_index = ToolCatalog.preset_name_index()
        return self._preset_index.get(name, {})

    @staticmethod
    def _resolve_parallel_safe(name: str, preset: dict) -> bool:
        if name in LEGACY_NEVER_PARALLEL:
            return False
        if "parallel_safe" in preset:
            return bool(preset["parallel_safe"])
        if name in LEGACY_PARALLEL_SAFE:
            return True
        return any(name.startswith(prefix) for prefix in PARALLEL_SAFE_PREFIXES)

    def _governance_from_preset(self, name: str, preset: dict) -> dict[str, Any]:
        return {
            "mutating": bool(preset.get("mutating", False)),
            "risk_level": str(preset.get("risk_level", "low")),
            "parallel_safe": self._resolve_parallel_safe(name, preset),
            "deferrable": bool(preset.get("deferrable", False)),
            "verification": preset.get("verification"),
        }

    @staticmethod
    def _make_safe_coroutine(run_fn: Callable, name: str) -> Callable:
        async def _safe_coroutine(**kwargs):
            try:
                return await run_fn(**kwargs)
            except Exception as exc:  # noqa: BLE001
                logger.exception("工具 %s 执行异常: %s", name, exc)
                return {"error": str(exc)}

        return _safe_coroutine

    def _register_db_tools(self, registry: dict[str, ToolDescriptor]) -> None:
        from app.models.tool import Tool

        if self.agent is None:
            # 系统级（管理 API / 脚本直调）：注册全部启用工具，不按 agent 过滤
            names = [t.name for t in self.db.query(Tool).filter(Tool.enabled.is_(True)).all()]
        else:
            names = self.agent.enabled_tools or []
        if not names:
            return

        for name in names:
            tool = self.db.query(Tool).filter(Tool.name == name, Tool.enabled.is_(True)).first()
            if tool is None:
                logger.warning("DB 工具未找到或未启用: %s", name)
                continue
            if (tool.tool_type or "code").lower() == "framework":
                continue
            if name == "search_assets":
                continue
            try:
                from app.core.tool_runner import load_tool_function

                run_fn = load_tool_function(
                    tool,
                    enabled_kbs=(self.agent.enabled_kbs or []) if self.agent is not None else [],
                    agent_id=getattr(self.agent, "id", None),
                    user_id=self.user_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("DB 工具加载失败: %s, error=%s", name, exc)
                continue

            from app.agent.tool_builders import _build_args_model

            args_model = _build_args_model(tool.name, tool.parameters_schema)
            tool_type = (getattr(tool, "tool_type", "code") or "code").lower()
            if getattr(tool, "is_preset", False):
                source = "builtin"
            elif tool_type == "http":
                source = "db_http"
            else:
                source = "db_code"

            preset = self._preset_meta(name)
            gov = self._governance_from_preset(name, preset)
            declared = preset.get("required_permission")
            if isinstance(declared, (list, tuple)) and len(declared) == 2:
                required_permission = (str(declared[0]), str(declared[1]))
            else:
                required_permission = ("tool", "execute")
            if not preset:
                gov["parallel_safe"] = self._resolve_parallel_safe(name, {})
            # deferrable 与 tool_search 原 source 判定逐字节等价：
            # 仅用户自建 code/http（db_code/db_http）可延迟；builtin 预设工具
            # （source=builtin）在原判定中属核心工具、永不延迟。此处以 source 判定
            # 为准，覆盖预设元数据的 deferrable 标志（security 预设标了 True，但原
            # tool_search 对 builtin 判为核心，保留原行为以满足 A-4 逐字节回归）。
            gov["deferrable"] = source in ("db_code", "db_http")
            untrusted = tool_type == "http" or name.startswith("http_") or name.startswith("openapi_")
            tool_source = getattr(tool, "tool_source", None) or preset.get("tool_source") or "builtin"

            registry[name] = ToolDescriptor(
                name=name,
                description=tool.description or f"DB 工具 {name}",
                args_schema=args_model,
                coroutine=self._make_safe_coroutine(run_fn, name),
                source=source,
                tool_source=str(tool_source),
                tool_type=tool_type,
                category=getattr(tool, "category", None) or preset.get("category"),
                mutating=gov["mutating"],
                risk_level=gov["risk_level"],
                parallel_safe=gov["parallel_safe"],
                deferrable=gov["deferrable"],
                verification=gov["verification"],
                untrusted=untrusted,
                danger_level=("high" if (gov["mutating"] and gov["verification"]) else "low"),
                required_permission=required_permission,
            )

    def _register_kb_tools(self, registry: dict[str, ToolDescriptor]) -> None:
        if self.agent is None:
            return
        enabled_kbs = self.agent.enabled_kbs or []
        if not enabled_kbs:
            return
        from app.agent.tool_builders import _build_file_query_tool, _build_kb_tool

        kb_tool = _build_kb_tool(enabled_kbs)
        if kb_tool is not None:
            registry["search_knowledge_base"] = ToolDescriptor(
                name="search_knowledge_base",
                description=kb_tool.description,
                args_schema=kb_tool.args_schema,
                coroutine=kb_tool.coroutine,
                source="kb",
                parallel_safe=True,
                untrusted=True,
                required_permission=("knowledge_base", "view"),
            )
        file_tool = _build_file_query_tool(enabled_kbs)
        if file_tool is not None:
            registry["query_kb_file"] = ToolDescriptor(
                name="query_kb_file",
                description=file_tool.description,
                args_schema=file_tool.args_schema,
                coroutine=file_tool.coroutine,
                source="kb",
                parallel_safe=True,
                untrusted=True,
                required_permission=("knowledge_base", "view"),
            )

    def _register_asset_tools(self, registry: dict[str, ToolDescriptor]) -> None:
        if self.agent is None:
            return
        enabled_asset_types = self.agent.enabled_asset_types or []
        if not enabled_asset_types:
            return
        from app.agent.tool_builders import _build_asset_tool

        asset_tool = _build_asset_tool(enabled_asset_types)
        if asset_tool is not None:
            preset = self._preset_meta("search_assets")
            gov = self._governance_from_preset("search_assets", preset)
            registry["search_assets"] = ToolDescriptor(
                name="search_assets",
                description=asset_tool.description,
                args_schema=asset_tool.args_schema,
                coroutine=asset_tool.coroutine,
                source="asset",
                parallel_safe=gov.get("parallel_safe", True),
                mutating=gov.get("mutating", False),
                untrusted=True,
                required_permission=("asset_list", "view"),
            )

    def _register_workflow_tools(self, registry: dict[str, ToolDescriptor]) -> None:
        if self.agent is None:
            return
        from app.agent.workflow_as_tool import (
            infer_parameters, invoke_workflow_as_tool, make_tool_name,
            workflow_danger, workflow_permissions, workflow_self_gates,
        )
        from app.models.workflow import Workflow

        for raw_id in getattr(self.agent, "enabled_workflows", None) or []:
            try:
                wf_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            wf = (
                self.db.query(Workflow)
                .filter(Workflow.id == wf_id, Workflow.enabled.is_(True))
                .first()
            )
            if wf is None:
                continue
            tool_name = make_tool_name(wf.id, wf.name)
            desc = (wf.description or "").strip() or f"运行已发布工作流：{wf.name}"
            parameters = infer_parameters(wf.graph_config)

            async def _coroutine(workflow_id=wf_id, **kwargs):
                return await invoke_workflow_as_tool(
                    db=self.db,
                    workflow_id=workflow_id,
                    agent_id=getattr(self.agent, "id", None),
                    payload=kwargs,
                )

            registry[tool_name] = ToolDescriptor(
                name=tool_name,
                description=desc,
                args_schema=None,
                coroutine=_coroutine,
                source="workflow",
                parallel_safe=False,
                mutating=True,
                deferrable=True,
                danger_level=workflow_danger(wf.graph_config),
                # 权限按图推导（与 danger 对称）：基线 workflow_list:execute +
                # 图内节点的权限并集，防「包一层工作流」侧写绕过模块权限（如 device:edit）
                required_permission=(
                    (("workflow_list", "execute"),)
                    + workflow_permissions(wf.graph_config)
                ),
                extra={"self_gating": workflow_self_gates(wf.graph_config)},
                parameters=parameters,
            )

    def _register_device_tools(self, registry: dict[str, ToolDescriptor]) -> None:
        """装配设备工具（P2-3，C1-5）。

        主配置入口为 ``Agent.enabled_devices``（设备 id 列表）。勾选设备后装配：
          1. 枚举工具 ``list_devices`` / ``list_device_actions``（作用域收窄到勾选设备）；
          2. 每台「启用且在线」设备的所有启用动作投影 ``device_{device_id}_{action_id}``；
          3. 门面 ``device_action``（作用域收窄，防越权操作未勾选设备）；
          4. 语义工具 ``block_ip``（**仅当存在「启用+在线+有 block_ip 动作」的设备**才装配，§11.1 = A2）。

        既有 Agent 无 enabled_devices 列值（NULL）→ 空 → 不装配任何 device 工具，
        保证 A-4 逐字节回归安全。
        """
        if self.agent is None:
            return
        enabled_ids = getattr(self.agent, "enabled_devices", None) or []
        if not enabled_ids:
            return

        from app.devices.as_tool import (
            build_block_ip_tool,
            build_device_action_facade_tool, build_device_action_tool,
            build_list_device_actions_tool, build_list_devices_tool,
            is_core_write_action, is_write_action,
        )
        from app.models.device import Device, DeviceAction

        allowed = {int(i) for i in enabled_ids if str(i).strip().isdigit()}
        if not allowed:
            return

        agent_id = getattr(self.agent, "id", None)

        registry["list_devices"] = build_list_devices_tool(self.db, allowed)
        registry["list_device_actions"] = build_list_device_actions_tool(self.db, allowed)

        devices = (
            self.db.query(Device)
            .filter(Device.id.in_(allowed), Device.enabled.is_(True), Device.status == "online")
            .all()
        )
        has_blockable = False
        for device in devices:
            actions = (
                self.db.query(DeviceAction)
                .filter(DeviceAction.device_id == device.id, DeviceAction.enabled.is_(True))
                .all()
            )
            writes = []
            reads = []
            for action in actions:
                if (getattr(action, "action_type", "") or "").lower() == "block_ip":
                    has_blockable = True
                if is_write_action(action) and not is_core_write_action(action):
                    continue
                if is_core_write_action(action):
                    writes.append(action)
                else:
                    reads.append(action)
            if len(reads) > MAX_PROJECTION_READS_PER_DEVICE:
                logger.warning(
                    "设备 %s(id=%s) 读动作 %d 个，超过投影上限 %d，改为枚举/门面",
                    device.name, device.id, len(reads), MAX_PROJECTION_READS_PER_DEVICE,
                )
                reads = []
            for action in writes + reads:
                desc = build_device_action_tool(
                    self.db, device, action, agent_id=agent_id,
                )
                registry[desc.name] = desc

        if devices:
            registry["device_action"] = build_device_action_facade_tool(
                self.db, allowed, agent_id=agent_id,
            )

        # 语义工具 block_ip：仅当范围内存在可封设备才装配（§11.1 = A2）
        if has_blockable:
            registry["block_ip"] = build_block_ip_tool(self.db, self.agent, allowed)
