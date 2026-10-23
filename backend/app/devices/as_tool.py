"""把 Device / DeviceAction 投影为 Agent 工具（纯构建器，P2-2a）。

本模块只做构建（产出 ToolDescriptor），不接线：
- ToolRegistryBuilder._register_device_tools（enabled_devices）→ P2-3
- verification 的 device 工具分派 → P2-2b
- 语义 block_ip（默认设备解析）→ P2-4

设计要点：
- 写动作判定（架构 §6.4）：risk_level=high_risk 或 category ∈ {block, dispose}；
- 描述符标志（C1-6/C1-7）：写动作 mutating=True + verification="device_action" +
  parallel_safe=False + deferrable=False（核心）；读动作反之（可延迟）；
- coroutine 一律经 DeviceGateway（设备唯一执行缝，P2-1）；
- 只暴露「启用且在线」的设备（C1-12）；
- 描述写明「何时用」（C1-10，降 LLM 选错率）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

from app.agent.tool_builders import _build_args_model
from app.core.tools.descriptor import ToolDescriptor

# 写动作分类（架构 §6.4）：阻断类 / 处置类
_WRITE_CATEGORIES = frozenset({"block", "dispose"})


def is_write_action(action) -> bool:
    """写动作 = risk_level=high_risk 或 category ∈ {block, dispose}。"""
    return (getattr(action, "risk_level", "") or "").lower() == "high_risk" \
        or (getattr(action, "category", "") or "").lower() in _WRITE_CATEGORIES


def _parse_params_schema(action) -> list[dict]:
    """解析动作的 params_schema（JSON 数组），失败回退 []。"""
    try:
        parsed = json.loads(action.params_schema or "[]")
        if isinstance(parsed, list):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass
    return []


def is_core_write_action(action) -> bool:
    return is_write_action(action) and (
        (getattr(action, "category", "") or "").lower() in _WRITE_CATEGORIES
    )


def policy_for_action_id(db, action_id) -> tuple[str, tuple[str, str]] | None:
    """按已存储动作给出 (danger_level, required_permission)。查不到返回 None。"""
    try:
        aid = int(action_id)
    except (TypeError, ValueError):
        return None
    from app.models.device import DeviceAction

    action = db.query(DeviceAction).filter(DeviceAction.id == aid).first()
    if action is None:
        return None
    if is_write_action(action):
        return "high", ("device", "edit")
    return "low", ("device", "view")


def build_device_action_tool(
    db, device, action, *, agent_id: Optional[int] = None,
) -> ToolDescriptor:
    """投影工具：单个设备动作 → ``device_{device_id}_{action_id}``。

    设备/动作在构建期固化，LLM 只需填动作自身的参数。
    """
    write = is_write_action(action)
    args_schema = _build_args_model(
        f"device_action_{action.id}", _parse_params_schema(action)
    )
    _agent_id = agent_id

    async def _coroutine(**kwargs):
        from app.devices.gateway import DeviceGateway, build_idempotency_key
        key = None
        if write:
            key = build_idempotency_key(
                source="agent",
                device_id=device.id,
                action_type=action.action_type,
                params=kwargs,
                agent_id=_agent_id,
            )
        return await DeviceGateway.invoke(
            db, device.id, action_id=action.id, params=kwargs, source="agent",
            agent_id=_agent_id, idempotency_key=key,
        )

    kind = "写动作（会改变设备状态，需证据验证）" if write else "读动作（只读查询，无副作用）"
    description = (
        f"[设备动作] {device.name} · {action.name}"
        f"（action_type={action.action_type}，risk_level={action.risk_level or 'readonly'}，{kind}）。"
        f"何时用：需要对设备「{device.name}」执行 {action.action_type} 时调用。"
    )
    if action.description:
        description += f" {action.description}"

    return ToolDescriptor(
        name=f"device_{device.id}_{action.id}",
        description=description,
        args_schema=args_schema,
        coroutine=_coroutine,
        source="device",
        tool_source="device",
        tool_type="device",
        category=(action.category or None),
        mutating=write,
        risk_level="high" if write else "low",
        parallel_safe=not write,
        deferrable=not write,
        verification="device_action" if write else None,
        danger_level="high" if write else "low",
        required_permission=("device", "edit") if write else ("device", "view"),
    )


def build_list_devices_tool(db, allowed_device_ids: Optional[set[int]] = None) -> ToolDescriptor:
    """枚举工具：``list_devices``，列出启用且在线的设备（C1-12）。

    Args:
        allowed_device_ids: 若给定，仅返回本 Agent 勾选的设备（作用域收窄）。
    """
    async def _coroutine(**kwargs):
        from app.models.device import Device
        q = db.query(Device).filter(Device.enabled.is_(True), Device.status == "online")
        if allowed_device_ids:
            q = q.filter(Device.id.in_(allowed_device_ids))
        rows = q.all()
        return [
            {
                "id": d.id,
                "name": d.name,
                "type": d.type,
                "vendor": d.vendor,
                "description": d.description,
            }
            for d in rows
        ]

    return ToolDescriptor(
        name="list_devices",
        description=(
            "列出当前可用的安全设备（仅启用且在线的）。"
            "何时用：需要了解平台接入哪些防火墙/WAF/EDR 等设备、"
            "或需要设备 ID 供设备动作工具调用时使用。"
        ),
        args_schema=None,
        coroutine=_coroutine,
        source="device",
        tool_source="device",
        tool_type="device",
        mutating=False,
        parallel_safe=True,
        deferrable=False,
        required_permission=("device", "view"),
    )


def build_list_device_actions_tool(db, allowed_device_ids: Optional[set[int]] = None) -> ToolDescriptor:
    """枚举工具：``list_device_actions``，列出启用且设备在线的动作（可选按设备过滤）。

    Args:
        allowed_device_ids: 若给定，仅返回本 Agent 勾选设备的动作（作用域收窄）。
    """
    async def _coroutine(**kwargs):
        from app.models.device import Device, DeviceAction
        q = (
            db.query(DeviceAction)
            .join(Device, Device.id == DeviceAction.device_id)
            .filter(
                DeviceAction.enabled.is_(True),
                Device.enabled.is_(True),
                Device.status == "online",
            )
        )
        if allowed_device_ids:
            q = q.filter(DeviceAction.device_id.in_(allowed_device_ids))
        device_id = kwargs.get("device_id")
        if device_id:
            try:
                q = q.filter(DeviceAction.device_id == int(device_id))
            except (TypeError, ValueError):
                pass
        rows = q.all()
        return [
            {
                "id": a.id,
                "device_id": a.device_id,
                "name": a.name,
                "action_type": a.action_type,
                "category": a.category,
                "risk_level": a.risk_level,
                "description": a.description,
            }
            for a in rows
        ]

    return ToolDescriptor(
        name="list_device_actions",
        description=(
            "列出安全设备的可用动作（如 block_ip/unblock_ip 等，仅启用且设备在线的）。"
            "何时用：需要查看某设备支持哪些动作、或需要 action_type 供 device_action "
            "兜底工具调用时使用；传 device_id 只看该设备。"
        ),
        args_schema=None,
        parameters={
            "type": "object",
            "properties": {
                "device_id": {"type": "integer", "description": "可选，只看该设备"},
            },
        },
        coroutine=_coroutine,
        source="device",
        tool_source="device",
        tool_type="device",
        mutating=False,
        parallel_safe=True,
        deferrable=False,
        required_permission=("device", "view"),
    )


def build_device_action_facade_tool(
    db, allowed_device_ids: Optional[set[int]] = None,
    *, agent_id: Optional[int] = None,
) -> ToolDescriptor:
    """门面工具：``device_action``，按 device_id + action_type 兜底调用任意设备动作。

    Args:
        allowed_device_ids: 若给定，仅允许调用本 Agent 勾选的设备（作用域收窄，
            防越权：勾设备 3 却操作设备 5）。None=不限制（便于单测/运维）。
    """
    _agent_id = agent_id

    async def _coroutine(**kwargs):
        from app.devices.action_executor import find_device_action_by_type
        from app.devices.gateway import DeviceGateway, build_idempotency_key
        device_id = kwargs.pop("device_id", None)
        action_type = kwargs.pop("action_type", None)
        if device_id is None or not action_type:
            return {"error": "缺少必填参数：device_id 与 action_type"}
        try:
            device_id = int(device_id)
        except (TypeError, ValueError):
            return {"error": f"device_id 必须是整数: {device_id!r}"}
        if allowed_device_ids is not None and device_id not in allowed_device_ids:
            return {"error": f"设备 {device_id} 不在本智能体可用范围内（enabled_devices）"}
        params = kwargs.pop("params", None)
        if not isinstance(params, dict):
            params = dict(kwargs)
        elif kwargs:
            params = {**kwargs, **params}
        _device, action, err = find_device_action_by_type(db, device_id, str(action_type))
        if err:
            return {"error": err}
        key = None
        if is_write_action(action):
            key = build_idempotency_key(
                source="agent",
                device_id=device_id,
                action_type=str(action_type),
                params=params,
                agent_id=_agent_id,
            )
        return await DeviceGateway.invoke(
            db, device_id, action_id=action.id, params=params, source="agent",
            agent_id=_agent_id, idempotency_key=key,
        )

    return ToolDescriptor(
        name="device_action",
        description=(
            "[设备动作·兜底] 按 device_id + action_type 直接调用任意安全设备动作。"
            "何时用：仅当没有对应的投影工具（device_{设备ID}_{动作ID}）或语义工具"
            "（如 block_ip）可用时才用本工具；优先使用投影/语义工具。"
        ),
        args_schema=None,
        parameters={
            "type": "object",
            "properties": {
                "device_id": {"type": "integer", "description": "目标设备 ID"},
                "action_type": {
                    "type": "string",
                    "description": "动作类型，如 block_ip/unblock_ip/quarantine_host",
                },
                "params": {"type": "object", "description": "动作参数（可选）"},
            },
            "required": ["device_id", "action_type"],
        },
        coroutine=_coroutine,
        source="device",
        tool_source="device",
        tool_type="device",
        mutating=True,
        risk_level="high",
        parallel_safe=False,
        deferrable=False,
        verification="device_action",
        danger_level="high",
        required_permission=("device", "edit"),
    )


# ============================================================================
# P2-4a：语义 block_ip + 默认设备解析
# ============================================================================
# 装配条件（A1: enabled_devices 非空 / A2: 有能封的设备才给）与确认前置
# （直调 Gateway / 走工作流）留空待定，P2-4b 拍板后接入 _register_device_tools。
# 此处只实现解析 + 构建器，保证行为可测。
# ============================================================================

# tags 兜底匹配关键字（架构 §6.8：如「封禁」、「production」）
_BLOCK_TAGS = frozenset({"封禁", "生产", "production", "block"})


@dataclass
class BlockDeviceResolution:
    """默认封禁设备解析结果。"""
    device: Optional[object] = None
    action: Optional[object] = None
    error: Optional[str] = None
    hint: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.device is not None and self.action is not None


def _load_tags(device) -> list[str]:
    try:
        return json.loads(device.tags or "[]")
    except (json.JSONDecodeError, TypeError):
        return []


def _find_block_action(db, device_id: int):
    """查设备的启用 block_ip 动作（不存在返回 None）。"""
    from app.models.device import DeviceAction
    return (
        db.query(DeviceAction)
        .filter(
            DeviceAction.device_id == device_id,
            DeviceAction.action_type == "block_ip",
            DeviceAction.enabled.is_(True),
        )
        .first()
    )


def _device_blockable(db, device, allowed_device_ids: Optional[set[int]]) -> bool:
    """设备是否「可封禁」：在 allowed 范围内、启用、在线、有启用的 block_ip 动作。"""
    if allowed_device_ids is not None and device.id not in allowed_device_ids:
        return False
    if not getattr(device, "enabled", False):
        return False
    if getattr(device, "status", "") != "online":
        return False
    return _find_block_action(db, device.id) is not None


def resolve_default_block_device(
    db, agent, allowed_device_ids: Optional[set[int]] = None,
) -> BlockDeviceResolution:
    """解析默认封禁设备（架构 §6.8，三步）。

    1. ``Agent.variables.default_device_id``：在 allowed 范围内且启用+在线+有
       ``block_ip`` 动作 → 命中；
    2. 兜底（O1 = Y）：在 allowed 范围内、启用+在线、有 ``block_ip`` 动作的设备
       **唯一即用**；多台时再按 tags（``封禁``/``production``/``block``）消歧，
       仍不唯一 → 报错；
    3. 仍无法解析 → 返回结构化错误（不静默失败）。

    Args:
        db: 数据库 Session。
        agent: Agent ORM/SimpleNamespace（读取 ``variables``）。
        allowed_device_ids: 作用域（Agent.enabled_devices）；None=不限制。
    """
    from app.models.device import Device

    variables = getattr(agent, "variables", None) or {}
    default_id = variables.get("default_device_id")

    # ① default_device_id 显式指定
    if default_id is not None:
        try:
            default_id = int(default_id)
        except (TypeError, ValueError):
            return BlockDeviceResolution(
                error=f"default_device_id 非法: {default_id!r}",
                hint="请配置整数型设备 ID。",
            )
        device = db.query(Device).filter(Device.id == default_id).first()
        if device and _device_blockable(db, device, allowed_device_ids):
            return BlockDeviceResolution(device=device, action=_find_block_action(db, device.id))
        return BlockDeviceResolution(
            error=f"默认封禁设备 {default_id} 不可用（未启用/离线/无 block_ip 动作或不在本 Agent 设备范围内）",
            hint="请在 Agent.variables 中配置有效的 default_device_id，或确保该设备启用、在线且有 block_ip 动作。",
        )

    # ② 兜底（O1 = Y）：范围内「启用+在线+有 block_ip 动作」的设备
    #    唯一 → 直接用（不再要求打标签）；多台 → 先按 tags 消歧，仍不唯一则报错
    q = db.query(Device)
    if allowed_device_ids:
        q = q.filter(Device.id.in_(allowed_device_ids))
    q = q.filter(Device.enabled.is_(True), Device.status == "online")
    blockable = [d for d in q.all() if _find_block_action(db, d.id) is not None]

    if len(blockable) == 1:
        dev = blockable[0]
        return BlockDeviceResolution(device=dev, action=_find_block_action(db, dev.id))

    if len(blockable) > 1:
        tagged = [d for d in blockable if any(t in _BLOCK_TAGS for t in _load_tags(d))]
        if len(tagged) == 1:
            dev = tagged[0]
            return BlockDeviceResolution(device=dev, action=_find_block_action(db, dev.id))
        ids = [d.id for d in (tagged or blockable)]
        return BlockDeviceResolution(
            error=f"存在多个候选封禁设备 {ids}，无法自动选择",
            hint="请在 Agent.variables 中显式配置 default_device_id 指定唯一设备。",
        )

    # ③ 无法解析
    return BlockDeviceResolution(
        error="无法解析默认封禁设备",
        hint="请确保本智能体勾选（enabled_devices）的设备中至少有一台启用、在线且有 block_ip 动作；"
             "若有多台，给其中一台打「封禁/production」标签，或配置 Agent.variables.default_device_id。"
             "也可先用 list_devices 查看可用设备。",
    )


_BLOCK_IP_SCHEMA = [
    {"name": "ip", "type": "String", "required": True,
     "description": "要封禁的目标 IP 地址"},
    {"name": "duration", "type": "String", "required": False,
     "description": "封禁时长，如 30m / 1h / 永久（可选）"},
    {"name": "reason", "type": "String", "required": False,
     "description": "封禁理由（可选，用于审计）"},
]


def build_block_ip_tool(db, agent, allowed_device_ids: Optional[set[int]] = None) -> ToolDescriptor:
    """语义工具 ``block_ip(ip, duration, reason)``（架构 §6.8）。

    内部按 ``resolve_default_block_device`` 解析默认封禁设备，找到 ``block_ip``
    动作后调用 DeviceGateway。作用域收窄到 ``allowed_device_ids``（防越权）。
    验证复用封禁证据链（白名单 + 资产），见 verification.py。
    """
    args_model = _build_args_model("block_ip", _BLOCK_IP_SCHEMA)
    _agent_id = getattr(agent, "id", None)

    async def _coroutine(ip: str, duration: Optional[str] = None,
                         reason: Optional[str] = None, **kwargs):
        from app.devices.gateway import DeviceGateway, build_idempotency_key
        res = resolve_default_block_device(db, agent, allowed_device_ids)
        if not res.ok:
            return {"error": res.error, "hint": res.hint}
        params = {"ip": ip}
        if duration is not None:
            params["duration"] = duration
        if reason is not None:
            params["reason"] = reason
        key = build_idempotency_key(
            source="agent",
            device_id=res.device.id,
            action_type="block_ip",
            params=params,
            agent_id=_agent_id,
        )
        return await DeviceGateway.invoke(
            db, res.device.id, action_id=res.action.id, params=params, source="agent",
            agent_id=_agent_id, idempotency_key=key,
        )

    return ToolDescriptor(
        name="block_ip",
        description=(
            "[语义] 封禁目标 IP（自动解析默认封禁设备并下发 block_ip 动作）。"
            "何时用：研判确认恶意 IP 后执行封禁。无需手动指定设备 ID，系统按 "
            "Agent.variables.default_device_id 或「封禁」标签设备自动解析；"
            "若无法解析会返回错误，请先用 list_devices 查看或配置默认设备。"
        ),
        args_schema=args_model,
        coroutine=_coroutine,
        source="device",
        tool_source="device",
        tool_type="device",
        category="block",
        mutating=True,
        risk_level="high",
        parallel_safe=False,
        deferrable=False,
        verification="block_ip",
        danger_level="high",
        required_permission=("device", "edit"),
    )
