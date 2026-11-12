"""深信服 XDR 设备动作工具集定义（一个动作一个智能体工具）。

工具定义由 ``SANGFOR_XDR_ACTIONS`` 自动生成，命名规则见
``app.tools.xdr_action_tools.build_action_key``：

- ``/api/xdr/v1/alerts/list``        → ``xdr_alerts_list``
- ``/api/xdr/v1/incidents/trends``   → ``xdr_incidents_trends``
- ``/api/xdr/v1/alerts/countFusion`` → ``xdr_alerts_count_fusion``

每个工具：
- parameters_schema 来自动作 params_schema（类型映射为工具协议类型，
  必填项/默认值/枚举/说明齐全；被错误平铺的嵌套字段已剔除）；
- 代码仅透传参数到统一入口 ``run_xdr_action``（沙箱注入，禁止 import），
  认证签名、超时、重试、异常处理与审计日志均在该入口内完成；
- description 包含功能说明、使用场景、返回结构与示例调用，便于智能体
  自主选择工具。
"""
from typing import Any

from app.tools.xdr_action_tools import (
    XDR_ACTION_DEFINITIONS,
    XDR_ACTION_NESTED_FIELDS,
    XDR_ACTION_PARAM_SCHEMAS,
    build_action_key,
)

# 动作参数类型 → 工具协议类型（tool_builders._TYPE_MAP 支持的类型）
_TYPE_MAP = {
    "integer": "Integer",
    "int": "Integer",
    "long": "Integer",
    "number": "Number",
    "float": "Number",
    "double": "Number",
    "boolean": "Boolean",
    "bool": "Boolean",
    "array": "Array",
    "list": "Array",
    "object": "Object",
    "json": "Object",
    "dict": "Object",
    "string": "String",
    "str": "String",
    "ip": "String",
    "cidr": "String",
}

_RETURN_HINT = (
    "返回结构化结果：{ok, status, http_status, code, message, data, error, "
    "latency_ms, device, action}。ok=true 时 data 为已解包的 XDR 业务数据"
    "（原始响应在 raw_response）；ok=false 时按 error.type 处理："
    "validation_error（参数错误，修正后重试）、device_not_configured/"
    "device_ambiguous（设备未配置或多台需指定 device_id）、auth_error（联动码/"
    "签名/权限）、http_error/not_found_error（接口或路径错误）、server_error/"
    "timeout/connection_error/rate_limited（retryable=true，可稍后重试）、"
    "business_error（HTTP 成功但 XDR 业务码失败）。"
)


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _usage_hint(action_def: dict[str, Any]) -> str:
    risk = str(action_def.get("risk_level") or "readonly").lower()
    if risk in ("medium", "high"):
        return (
            "处置/变更类写操作：仅在用户明确要求、且已向其确认目标与影响后调用，"
            "执行前不要自行推断处置范围。"
        )
    return (
        "安全告警/安全事件数据的查询、统计与研判取数；只读操作可与其他查询工具"
        "并行调用，结果可直接用于分析、报表或后续处置。"
    )


def _build_parameters(key: str) -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for p in XDR_ACTION_PARAM_SCHEMAS.get(key) or []:
        type_name = str(p.get("type") or "string").lower()
        description = p.get("description") or p.get("label") or p["name"]
        # 与 validate_action_params 的回填口径一致：空容器默认值（[] / {} /
        # 空串）不下发也不渲染，非空默认值工具层会回填、此处展示
        if "default" in p and p.get("default") not in (None, "", [], {}):
            description = f"{description}（默认值: {p['default']}）"
        item: dict[str, Any] = {
            "name": p["name"],
            "type": _TYPE_MAP.get(type_name, "String"),
            "required": bool(p.get("required")),
            "description": description,
        }
        if "default" in p:
            item["default"] = p["default"]
        if isinstance(p.get("enum"), list) and p["enum"]:
            item["enum"] = p["enum"]
        params.append(item)
    # 多台 XDR 设备时用于指定目标；单台设备可省略
    params.append(
        {
            "name": "device_id",
            "type": "Integer",
            "required": False,
            "description": "可选，目标 XDR 设备 ID；仅一台已启用 XDR 设备时可省略",
        }
    )
    return params


def _build_description(action_def: dict[str, Any], key: str) -> str:
    name = action_def.get("name") or key
    method = action_def.get("http_method") or "POST"
    path = action_def.get("api_path") or ""
    risk = str(action_def.get("risk_level") or "readonly").lower()

    lines: list[str] = []
    if risk in ("medium", "high"):
        lines.append("【处置类动作：执行前必须向用户确认目标与影响】")
    lines.append(f"{name}（{method} {path}）。")
    if action_def.get("description"):
        lines.append(str(action_def["description"]).strip())
    lines.append(f"使用场景：{_usage_hint(action_def)}")

    nested = XDR_ACTION_NESTED_FIELDS.get(key) or []
    if nested:
        lines.append(
            "注意："
            + "、".join(nested)
            + " 是父级数组/对象内的元素字段，不属于顶层参数，请放在对应的父级结构中传递。"
        )
    lines.append(_RETURN_HINT)
    if action_def.get("example_payload"):
        lines.append("示例调用：" + _truncate(str(action_def["example_payload"]), 600))
    else:
        lines.append(
            f"示例调用：{method} {path}，params 按上表参数传入；无必填参数时传 {{}} 即可。"
        )
    return "\n".join(lines)


def _build_tool(action_def: dict[str, Any]) -> dict[str, Any]:
    key = build_action_key(action_def["api_path"])
    code = (
        "async def run(**kwargs):\n"
        "    params = dict(kwargs)\n"
        "    device_id = params.pop('device_id', None)\n"
        f"    return await run_xdr_action(action_key={key!r}, params=params, "
        "device_id=device_id)\n"
    )
    return {
        "name": key,
        "description": _build_description(action_def, key),
        "parameters_schema": _build_parameters(key),
        "code": code,
        "tool_type": "code",
        "category": "xdr",
        "tags": ["XDR", "深信服", action_def.get("name") or key],
        "enabled": True,
        "is_preset": True,
    }


XDR_ACTION_TOOLS: list[dict[str, Any]] = [
    _build_tool(action_def) for action_def in XDR_ACTION_DEFINITIONS.values()
]
