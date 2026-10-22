from __future__ import annotations

import re
from typing import Any, Callable, Optional

GLOBAL_WORKFLOW_TOOL_NAMES = frozenset({
    "trigger_workflow_skill",
    "list_workflow_skills",
})


def make_tool_name(workflow_id: int, name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", name or "").strip("_")
    slug = slug[:40]
    if slug and re.match(r"^[A-Za-z]", slug):
        return f"workflow_{workflow_id}_{slug}"
    return f"workflow_{workflow_id}"


def infer_parameters(graph_config: Any) -> dict:
    properties: dict[str, Any] = {}
    required: list[str] = []
    nodes = []
    if isinstance(graph_config, dict):
        nodes = graph_config.get("nodes") or []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = node.get("data") or {}
        ntype = node.get("type") or data.get("type") or ""
        if ntype not in ("webhook_trigger", "manual_trigger", "start"):
            continue
        for item in (data.get("body_params") or []) + (data.get("entry_form") or []):
            if not isinstance(item, dict):
                continue
            pname = (item.get("name") or "").strip()
            if not pname or pname in properties:
                continue
            properties[pname] = {
                "type": "string",
                "description": item.get("description") or pname,
            }
            if item.get("required"):
                required.append(pname)
        break
    if not properties:
        properties = {
            "input": {
                "type": "object",
                "description": "工作流输入参数",
            }
        }
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": True,
    }
    if required:
        schema["required"] = required
    return schema


# ============================================================================
# 工作流 → 危险等级 / 自门控（供确认闸使用）
# ============================================================================

# 节点类型 → 危险等级（保守映射：不确定的一律 high，避免绕过确认）
_DANGER_NODE_TYPES = {
    "block_ip": "high",
    "device_action": "high",
    "tool": "high",              # 图内调工具，具体工具未知 → 保守 high
    "send_notification": "low",
}
_DANGER_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
# 自带人工审批的节点 → 该工作流「自门控」，Agent 侧不再二次确认
_APPROVAL_NODE_TYPES = frozenset({"human_review", "approval_ticket"})


def _iter_nodes(graph_config: Any) -> list[dict]:
    if isinstance(graph_config, dict):
        return [n for n in (graph_config.get("nodes") or []) if isinstance(n, dict)]
    return []


def _node_type(node: dict) -> str:
    data = node.get("data") or {}
    return str(node.get("type") or data.get("type") or "")


def workflow_danger(graph_config: Any) -> str:
    """工作流危险等级 = 图内节点的最高危险（无节点 → low）。"""
    levels = [_DANGER_NODE_TYPES.get(_node_type(n), "low") for n in _iter_nodes(graph_config)]
    if not levels:
        return "low"
    return max(levels, key=lambda x: _DANGER_RANK.get(x, 0))


def workflow_self_gates(graph_config: Any) -> bool:
    """图内是否含 human_review / approval_ticket 节点（自带人工审批）。"""
    return any(_node_type(n) in _APPROVAL_NODE_TYPES for n in _iter_nodes(graph_config))


# ============================================================================
# 工作流 → 所需权限（供角色权限闸使用，与危险推导对称）
# ============================================================================

# 节点类型 → 需要的权限 (module, action) 序列。
# 与 danger 推导对称：danger 按图传播防「绕过确认」，权限按图传播防「绕过模块权限」
# （否则仅 workflow_list:execute 的角色可触发含 block_ip 的工作流，侧写绕过 device:edit）。
# send_notification 不设权限门槛：与其 danger=low 的定性一致，避免大面积破坏现有运营工作流。
_PERMISSION_NODE_TYPES: dict[str, tuple[tuple[str, str], ...]] = {
    "block_ip": (("device", "edit"),),
    "device_action": (("device", "edit"),),
}

# tool 节点权限解析记忆（ToolCatalog.preset_name_index 每次重建，装配为高频路径）
_PRESET_PERMISSION_CACHE: dict[str, Optional[tuple[str, str]]] = {}


def _preset_tool_permission(name: str) -> Optional[tuple[str, str]]:
    """按内置目录解析工具名 → 声明权限；未声明或不在目录返回 None（默认 tool:execute）。"""
    if name in _PRESET_PERMISSION_CACHE:
        return _PRESET_PERMISSION_CACHE[name]
    declared: Optional[tuple[str, str]] = None
    try:
        from app.core.tools.catalog import ToolCatalog

        preset = ToolCatalog.preset_name_index().get(name, {})
        raw = preset.get("required_permission")
        if isinstance(raw, (list, tuple)) and len(raw) == 2:
            declared = (str(raw[0]), str(raw[1]))
    except Exception:  # 解析失败按默认口径（tool:execute）兜底
        declared = None
    _PRESET_PERMISSION_CACHE[name] = declared
    return declared


def workflow_permissions(
    graph_config: Any,
    tool_permission_lookup: Optional[Callable[[str], Optional[tuple[str, str]]]] = None,
) -> tuple[tuple[str, str], ...]:
    """工作流所需权限 = 图内各节点所需权限的并集（触发者须全部满足，空 = 无额外门槛）。

    - block_ip / device_action → device:edit
    - tool 节点 → 按 data.tool_name 解析（解析不到按默认 tool:execute，与 DB 工具口径一致）
    - 其余节点（含 send_notification）不设门槛，与危险映射的低危定性一致
    - 调用方：registry_builder（workflow_{id}_{name} 工具）与 platform/approval
      （trigger_workflow_skill 审批执行路径），基线 workflow_list:execute 由调用方自带
    """
    lookup = tool_permission_lookup or _preset_tool_permission
    perms: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for node in _iter_nodes(graph_config):
        ntype = _node_type(node)
        data = node.get("data") or {}
        required: tuple[tuple[str, str], ...] = ()
        if ntype in _PERMISSION_NODE_TYPES:
            required = _PERMISSION_NODE_TYPES[ntype]
        elif ntype == "tool":
            name = str(data.get("tool_name") or "").strip()
            required = (lookup(name) or ("tool", "execute"),)
        for perm in required:
            if perm not in seen:
                seen.add(perm)
                perms.append(perm)
    return tuple(perms)


async def invoke_workflow_as_tool(
    *,
    db,
    workflow_id: int,
    agent_id: Optional[int],
    payload: dict,
) -> dict:
    from app.core.security import decrypt_env_value
    from app.core.workflow_runner import run_workflow
    from app.models.execution import Execution
    from app.models.workflow import Workflow

    wf = (
        db.query(Workflow)
        .filter(Workflow.id == workflow_id, Workflow.enabled.is_(True))
        .first()
    )
    if wf is None:
        return {"error": f"Workflow {workflow_id} not found or disabled"}

    execution = Execution(
        workflow_id=workflow_id,
        trigger_type="agent_tool",
        status="running",
        agent_id=agent_id,
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    env_vars = {
        v["name"]: decrypt_env_value(v.get("value") or "")
        for v in (wf.env_vars or [])
        if isinstance(v, dict) and v.get("name")
    }
    result = await run_workflow(
        graph_config=wf.graph_config,
        payload=payload if isinstance(payload, dict) else {"input": payload},
        execution_id=execution.id,
        workflow_id=workflow_id,
        env_vars=env_vars,
    )
    execution.status = result.get("status", "failed")
    execution.result = result
    db.commit()
    return result
