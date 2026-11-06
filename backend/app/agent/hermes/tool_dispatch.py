"""分段感知并行调度（对标 Hermes ``_plan_tool_batch_segments``）。

把一批 tool_calls 拆成「并行安全段」与「顺序屏障段」，
保留 LLM 的 emission 顺序，避免写工具并行执行导致冲突。

规则：
- 写工具（block_ip / send_notification 等）→ barrier（顺序执行）
- 参数解析失败 → barrier
- 只读工具（check_whitelist / get_threat_intel 等）→ parallel-safe
- 前缀匹配 query_/get_/list_/search_ → parallel-safe
- 未知工具 → barrier
- 并行段 <2 个调用降级为 sequential
- 相邻 sequential 段合并
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.agent.hermes.types import ToolCall

logger = logging.getLogger(__name__)

# 不可并行的工具（交互式/写操作）：默认全部 Soar 写工具都是 barrier
_NEVER_PARALLEL_TOOLS = frozenset({
    "block_ip",
    "send_notification",
    "device_action",
    "execute_code",
    "delegate_task",
    "trigger_workflow_skill",
    "memory_write",
    "query_persisted_result",  # 写 Execution.variables
})

# 并行安全的工具：只读查询类
# XDR 工具（query_xdr_api_doc 等）同时匹配 query_/search_ 前缀，
# 此处显式列入便于审计
_PARALLEL_SAFE_TOOLS = frozenset({
    "check_whitelist",
    "get_asset_info",
    "get_threat_intel",
    "check_subnet",
    "search_knowledge_base",
    "query_kb_file",
    "web_search",
    "web_extract",
    "read_file",
    "session_search",
    "memory_search",
    "tool_search",
    "tool_describe",
    "search_xdr_api_docs",
    "query_xdr_api_doc",
})

# 前缀匹配（OpenAPI 动态工具默认 barrier，除非显式标记只读）
_PARALLEL_SAFE_PREFIXES = ("query_", "get_", "list_", "search_")

# XDR OpenAPI 工具支持 PUT/PATCH/DELETE：写方法必须串行（且不自动重试），
# 查询类（GET/POST）仍可并行
_XDR_OPENAPI_TOOL = "query_xdr_openapi"
_XDR_WRITE_METHODS = frozenset({"PUT", "PATCH", "DELETE"})


def _is_xdr_write_call(tool_call: "ToolCall") -> bool:
    """按 method 参数判定 query_xdr_openapi 是否为写操作。"""
    arguments = getattr(tool_call, "arguments", None)
    if not isinstance(arguments, dict):
        return False
    return str(arguments.get("method") or "GET").upper() in _XDR_WRITE_METHODS


def plan_tool_batch_segments(tool_calls: list["ToolCall"]) -> list[tuple[str, list["ToolCall"]]]:
    """分段：``[("parallel", calls), ("sequential", calls), ...]``。

    规则与 Hermes 一致：
    - ``_NEVER_PARALLEL_TOOLS`` → barrier
    - 参数解析失败（malformed=True）→ barrier
    - ``_PARALLEL_SAFE_TOOLS`` 或匹配 ``_PARALLEL_SAFE_PREFIXES`` → 可并行
    - 未知工具 → barrier
    - 并行段 <2 个调用降级为 sequential
    - 相邻 sequential 段合并

    保留原顺序（original_index 递增）。

    Args:
        tool_calls: LLM 返回的工具调用列表

    Returns:
        分段列表，每段为 (kind, calls)，kind ∈ {"parallel", "sequential"}
    """
    # 原始结构：list of [kind, calls] pairs，返回时转为 tuple
    segments: list[list] = []
    current_parallel: list["ToolCall"] = []

    def _close_parallel() -> None:
        nonlocal current_parallel
        if current_parallel:
            segments.append(["parallel", current_parallel])
            current_parallel = []

    def _add_sequential(tc: "ToolCall") -> None:
        _close_parallel()
        if segments and segments[-1][0] == "sequential":
            segments[-1][1].append(tc)
        else:
            segments.append(["sequential", [tc]])

    for tc in tool_calls:
        tool_name = tc.name

        # 写工具 → barrier
        if tool_name in _NEVER_PARALLEL_TOOLS:
            _add_sequential(tc)
            continue

        # 参数解析失败 → barrier
        if tc.malformed:
            logger.debug(
                "工具 %s 参数解析失败（malformed），降级为 sequential barrier",
                tool_name,
            )
            _add_sequential(tc)
            continue

        # XDR OpenAPI：写方法（PUT/PATCH/DELETE）→ barrier；查询类可并行
        if tool_name == _XDR_OPENAPI_TOOL:
            if _is_xdr_write_call(tc):
                logger.info("XDR 写方法调用降级为 sequential: %s", tc.name)
                _add_sequential(tc)
            else:
                current_parallel.append(tc)
            continue

        # 显式并行安全工具
        if tool_name in _PARALLEL_SAFE_TOOLS:
            current_parallel.append(tc)
            continue

        # 前缀匹配（query_/get_/list_/search_）
        if any(tool_name.startswith(prefix) for prefix in _PARALLEL_SAFE_PREFIXES):
            current_parallel.append(tc)
            continue

        # 未知工具 → barrier（保守策略）
        _add_sequential(tc)

    _close_parallel()

    # 归一化：并行段 <2 降级为 sequential；合并相邻 sequential
    normalized: list[list] = []
    for kind, calls in segments:
        if kind == "parallel" and len(calls) < 2:
            kind = "sequential"
        if normalized and normalized[-1][0] == "sequential" and kind == "sequential":
            normalized[-1][1].extend(calls)
        else:
            normalized.append([kind, calls])

    result = [(kind, calls) for kind, calls in normalized]

    # 日志：分段结果
    if result:
        for kind, calls in result:
            logger.info(
                "工具调度分段: kind=%s, count=%d, tools=%s",
                kind,
                len(calls),
                [tc.name for tc in calls],
            )

    return result


def should_parallelize(tool_calls: list["ToolCall"]) -> bool:
    """判断整批是否可并行（同质情况下的简化视图）。

    Args:
        tool_calls: 工具调用列表

    Returns:
        True 当且仅当 planner 产生单一全并行段
    """
    if len(tool_calls) <= 1:
        return False
    segments = plan_tool_batch_segments(tool_calls)
    return len(segments) == 1 and segments[0][0] == "parallel"
