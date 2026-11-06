"""工具结果分类 —— 移植自 Hermes ``agent/tool_result_classification.py``。

分类工具是否有副作用、文件变更是否真正落地，供 guardrail 决策：

- 是否可安全重试（idempotent 工具失败后可重试，mutating 不行）
- 中断后是否可丢弃（no_effect 工具可丢，effect-capable 必须确认）
- block_ip 等写工具的结果是否真正生效（防"以为封了其实没封"）

SOAR 适配：

- 工具名替换为 Soar 实际工具
- ``FILE_MUTATING_TOOL_NAMES`` 改为 SOAR 写工具（block_ip / send_notification / device_action）
- 新增 ``SOAR_WRITE_TOOL_NAMES`` 集合，供 guardrail 判定 mutating
"""
from __future__ import annotations

import json
from typing import Any


# SOAR 写工具：会改变外部状态（防火墙、设备、通知、工作流）
SOAR_WRITE_TOOL_NAMES = frozenset({
    "block_ip", "send_notification", "device_action", "trigger_workflow_skill",
    "delegate_task", "memory_write", "execute_code",
})

# 文件变更工具（Hermes 原生概念，SOAR 中对应写 Execution.variables 的工具）
FILE_MUTATING_TOOL_NAMES = frozenset({
    "block_ip", "device_action", "trigger_workflow_skill", "memory_write",
})

# 无副作用工具：中断/挂起后可安全丢弃（不会留下外部状态）
# 未知/插件/MCP 工具默认 effect-capable
# 注意：query_xdr_openapi 支持 PUT/PATCH/DELETE，可能修改外部状态，
# 不能归入无副作用/可重试集合（保守按 effect-capable 处理）。
NO_EFFECT_TOOL_NAMES = frozenset({
    "check_whitelist", "get_asset_info", "get_threat_intel", "check_subnet",
    "search_knowledge_base", "query_kb_file", "read_file", "session_search",
    "memory_search", "tool_search", "tool_describe", "list_workflow_skills",
    "web_search", "web_extract",
    "search_xdr_api_docs", "query_xdr_api_doc",
})


def tool_may_have_side_effect(tool_name: str) -> bool:
    """工具是否可能有副作用。

    中断后：``False`` 的工具可安全丢弃，``True`` 的工具必须确认状态。
    未知工具默认 ``True``（保守）。
    """
    return tool_name not in NO_EFFECT_TOOL_NAMES


def is_idempotent_tool(tool_name: str) -> bool:
    """工具是否幂等（可安全重试）。

    幂等工具：重复调用产生相同结果，失败后可重试。
    非幂等工具（写操作）：重试可能产生重复副作用（如重复封禁、重复通知）。
    """
    return tool_name in NO_EFFECT_TOOL_NAMES


def is_mutating_tool(tool_name: str) -> bool:
    """工具是否变更外部状态。"""
    return tool_name in SOAR_WRITE_TOOL_NAMES


def file_mutation_result_landed(tool_name: str, result: Any) -> bool:
    """返回 True 当写工具的结果证明操作已落地。

    用于 guardrail 判断：写工具返回成功 ≠ 操作真正生效。
    例如 ``block_ip`` 应返回 ``{"blocked": true, "ip": "..."}``；
    若返回 ``{"error": ...}`` 或缺少 ``blocked`` 字段，视为未落地。
    """
    if tool_name not in FILE_MUTATING_TOOL_NAMES:
        return False

    # result 可能是 str（JSON）/ dict / 其他
    if isinstance(result, str):
        try:
            data = json.loads(result.strip())
        except Exception:
            return False
    elif isinstance(result, dict):
        data = result
    else:
        return False

    if not isinstance(data, dict) or data.get("error"):
        return False

    if tool_name == "block_ip":
        return data.get("blocked") is True or data.get("success") is True
    if tool_name == "device_action":
        return data.get("executed") is True or data.get("success") is True
    if tool_name == "trigger_workflow_skill":
        return data.get("status") in ("completed", "running", "interrupted")
    if tool_name == "memory_write":
        return data.get("success") is True
    return False


def classify_tool_failure(tool_name: str, result: Any) -> tuple[bool, str]:
    """安全回退分类器：判断工具结果是否表示失败。

    供 guardrail 在调用方未显式传 ``failed=`` 时使用。
    生产路径（``tool_engine._execute_one``）应显式传 ``failed=``，
    此函数供独立调用方（测试、工具）保持一致行为。

    Returns:
        ``(is_failed, hint_message)``。``hint_message`` 为简短失败提示
        （如 ``" [exit 1]"``），供日志展示。
    """
    if result is None:
        return False, ""

    # 写工具：检查是否真正落地
    if file_mutation_result_landed(tool_name, result):
        return False, ""

    # 字符串结果：检查 error 标记
    if isinstance(result, str):
        lower = result[:500].lower()
        if '"error"' in lower or '"failed"' in lower or result.startswith("Error"):
            return True, " [error]"
        return False, ""

    # dict 结果
    if isinstance(result, dict):
        if "error" in result:
            err = str(result.get("error", ""))[:100]
            return True, f" [error: {err}]"
        if result.get("success") is False:
            return True, " [failed]"
        return False, ""

    return False, ""


__all__ = [
    "SOAR_WRITE_TOOL_NAMES",
    "FILE_MUTATING_TOOL_NAMES",
    "NO_EFFECT_TOOL_NAMES",
    "tool_may_have_side_effect",
    "is_idempotent_tool",
    "is_mutating_tool",
    "file_mutation_result_landed",
    "classify_tool_failure",
]
