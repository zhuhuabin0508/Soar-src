"""子代理委派器 —— 移植自 Hermes ``tools/delegate_tool.py`` + ``agent/delegation_context.py``。

Spawns 子 ``HermesAgentExecutor`` 实例，拥有隔离的上下文、继承的工具集（剥离
blocked tools）、独立的迭代预算。父代理上下文只看到委派调用与汇总结果，永远
看不到子代理的中间工具调用或推理——但通过 live transcript + SSE 嵌套事件
可实时观察子代理工作过程。

核心设计（与 Hermes 一致）：

* **隔离上下文**：子代理获得全新对话（无父历史）、自己的 task_id、聚焦的
  system prompt（由 goal + context 构建）。
* **工具集继承与剥离**：子代理继承父代理的 enabled_tools，但移除 blocked tools
  （``delegate_task`` 自身——禁止递归委派；``clarify``——子代理不能与用户交互；
  ``memory_write``——不写共享记忆；写工具可选剥离）。
* **深度限制**：``ContextVar`` 跟踪委派深度，默认 ``MAX_DELEGATION_DEPTH=1``
  （父→子；孙代理被拒）。递归构造 ``HermesAgentExecutor``，共享父 agent 配置，
  独立预算。
* **结果回灌**：子代理结果作为 ``{"role":"tool","name":"delegate_task",...}``
  消息回灌父代理上下文，供 LLM 下一步推理。
* **实时日志**：子代理执行过程经 ``LiveTranscriptWriter`` 写 append-only transcript
  文件（脱敏），同时通过 SSE ``delegate`` 事件实时回传父代理。

Soar 适配点：

1. 子代理用 Soar 的 ``HermesAgentExecutor``（非 Hermes AIAgent）。
2. 脱敏用 Soar 的 ``redact.py``（已覆盖主流 LLM provider API Key + Bearer/JWT）。
3. 无 Kanban env scrubbing（Hermes 专有，Soar 无此需求）。
4. 子代理 system prompt 中英双语，适配 SOAR 中文场景。
5. ``delegate_task`` 作为 ``delegate`` source 工具（核心工具，永不延迟）。
"""
from __future__ import annotations

import json
import logging
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, AsyncIterator, Dict, List, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_DELEGATION_DEPTH",
    "DELEGATE_BLOCKED_TOOLS",
    "DELEGATE_TASK_SCHEMA",
    "Delegator",
    "ChildAgentConfig",
    "get_delegation_depth",
    "delegation_depth_context",
    "get_delegate_tool_schema",
    "build_child_system_prompt",
]


# ============================================================================
# 委派深度跟踪（ContextVar）
# ============================================================================

# 跟踪当前执行上下文的委派深度。0 = 顶层 agent；1 = 一次委派的子代理；2 = 孙代理。
# ContextVar 天然支持 asyncio 任务隔离——每个子代理在独立 task 中运行时深度独立。
_DELEGATION_DEPTH: ContextVar[int] = ContextVar(
    "soar_delegation_depth",
    default=0,
)

# 默认最大委派深度：1 = 扁平（父→子；孙代理被拒）。
# 与 Hermes MAX_DEPTH=1 一致——更深的树会乘以 API 成本，默认扁平，提升深度需显式 opt-in。
MAX_DELEGATION_DEPTH = 1


def get_delegation_depth() -> int:
    """返回当前上下文的委派深度。"""
    return _DELEGATION_DEPTH.get()


@contextmanager
def delegation_depth_context(depth: int):
    """在当前上下文设置委派深度。子代理构造时用 parent_depth + 1 调用。"""
    token = _DELEGATION_DEPTH.set(depth)
    try:
        yield
    finally:
        _DELEGATION_DEPTH.reset(token)


# ============================================================================
# 子代理 blocked tools
# ============================================================================

# 子代理永远不能拥有的工具：
# - delegate_task：禁止递归委派（防无限递归 + 成本爆炸）
# - clarify：子代理不能与用户交互（会阻塞父代理）
# - memory_write：不写共享记忆（隔离副作用）
# - send_notification：无跨平台副作用
# - trigger_workflow_skill：不触发工作流（隔离副作用，避免循环触发）
DELEGATE_BLOCKED_TOOLS = frozenset({
    "delegate_task",
    "clarify",
    "memory_write",
    "send_notification",
    "trigger_workflow_skill",
})


# ============================================================================
# delegate_task 工具 schema
# ============================================================================

DELEGATE_TASK_SCHEMA = {
    "type": "function",
    "function": {
        "name": "delegate_task",
        "description": (
            "委派一个或多个子代理在隔离上下文中执行任务。"
            "子代理拥有独立的对话历史（看不到父代理历史）、继承的工具集（剥离部分工具）、"
            "独立的迭代预算。"
            "适用于：并行调研多个方向、把重复性子任务交给子代理、保持父上下文简洁。"
            "\n\n单任务：提供 goal（+可选 context）。"
            "批量：提供 tasks 数组 [{goal, context}, ...]（并行执行，汇总结果）。"
            "完成后返回汇总结果，父代理可继续推理。"
            "\n\n注意：子代理看不到你的对话历史，goal 必须 self-contained。"
            "子代理不能委派其他子代理（delegate_task 对子代理不可用）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": (
                        "子代理要完成的目标。必须具体且 self-contained——"
                        "子代理对你的对话历史一无所知。"
                    ),
                },
                "context": {
                    "type": "string",
                    "description": (
                        "子代理需要的背景信息：文件路径、错误消息、项目结构、约束。"
                        "越具体，子代理表现越好。"
                    ),
                },
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "goal": {"type": "string", "description": "任务目标"},
                            "context": {"type": "string", "description": "任务特定背景"},
                        },
                        "required": ["goal"],
                    },
                    "description": (
                        "批量任务数组。提供时忽略顶层 goal/context，"
                        "每个任务独立执行后汇总。"
                    ),
                },
            },
            "required": [],
        },
    },
}


def get_delegate_tool_schema() -> dict:
    """返回 delegate_task 工具的 OpenAI 格式 schema。"""
    return DELEGATE_TASK_SCHEMA


# ============================================================================
# 子代理配置包装器
# ============================================================================


class ChildAgentConfig:
    """子代理配置：包装父 agent，覆盖特定属性。

    显式设置的属性（enabled_tools/enabled_skills/name）优先；
    其余属性（model_config_id/temperature/tool_configs 等）通过 ``__getattr__``
    委托给父 agent，保证子代理继承父代理的模型与工具配置。
    """

    def __init__(
        self,
        parent_agent,
        *,
        enabled_tools: list[str],
        name: Optional[str] = None,
    ):
        self._parent = parent_agent
        # 显式覆盖：剥离 blocked tools 后的工具集
        self.enabled_tools = enabled_tools
        # 子代理不注入技能（保持聚焦，避免技能副作用）
        self.enabled_skills: list = []
        # 子代理标识（供日志/审计）
        self.name = name or f"{parent_agent.name}/子代理"

    def __getattr__(self, name: str) -> Any:
        """未显式设置的属性委托给父 agent。

        ``__getattr__`` 仅在常规属性查找失败时调用，所以实例上已设置的
        enabled_tools/enabled_skills/name 不会被委托。
        """
        return getattr(self._parent, name)


def _strip_blocked_tools(tools: list[str]) -> list[str]:
    """从工具列表中移除子代理 blocked tools。"""
    return [t for t in tools if t not in DELEGATE_BLOCKED_TOOLS]


def build_child_system_prompt(
    goal: str,
    context: Optional[str],
    parent_agent,
) -> str:
    """构建子代理的聚焦 system prompt。

    与 Hermes ``_build_child_system_prompt`` 思路一致：从 goal + context 构建
    聚焦提示词，子代理不知道父代理对话历史。

    Args:
        goal: 任务目标
        context: 背景信息（可选）
        parent_agent: 父代理（继承 tone_style 等）

    Returns:
        子代理 system prompt 字符串
    """
    parts = [
        "你是一个被委派的子代理，负责完成父代理分配的特定任务。",
        "你看不到父代理的对话历史，只有以下任务目标和背景信息。",
        f"\n## 任务目标\n{goal}",
    ]
    if context:
        parts.append(f"\n## 背景信息\n{context}")

    parts.append("\n## 约束")
    parts.append("- 完成任务后直接给出结果，不要询问用户（clarify 工具不可用）。")
    parts.append("- 不要触发其他子代理委派（delegate_task 不可用）。")
    parts.append("- 不要写共享记忆（memory_write 不可用）。")
    parts.append("- 聚焦当前任务，高效使用工具，避免不必要的探索。")

    tone = getattr(parent_agent, "tone_style", "")
    if tone:
        parts.append(f"- 语气风格：{tone}")

    parts.append("\n## 输出要求")
    parts.append("完成任务后，用简洁清晰的文本总结你的发现和结论。")
    parts.append("这个总结将作为委派结果返回给父代理。")

    return "\n".join(parts)


# 单个子代理结果回灌父上下文的字符预算：子代理倾向返回整表数据，
# 会把父上下文撑爆（实测多任务汇总后达数万字符，拖慢父代理每次推理）。
# 结论与关键统计足够，明细数据父代理可自行再查。
_DELEGATE_RESULT_MAX_CHARS = 8000


def _cap_delegation_result(text: str, budget: int = _DELEGATE_RESULT_MAX_CHARS) -> str:
    """把子代理结果截断到预算内，并注明完整内容所在 transcript。"""
    if not isinstance(text, str) or len(text) <= budget:
        return text
    return (
        text[:budget]
        + f"\n...[子代理结果过长（原始 {len(text)} 字符），已截断；"
        "父代理如需明细请自行调用工具查询，不要依赖子代理转述全部数据]"
    )


# ============================================================================
# 委派器
# ============================================================================


class Delegator:
    """子代理委派器。

    持有父代理共享配置（db/user/log_handler），``delegate()`` 方法构造子代理
    执行器并运行，yield 子代理事件（含 subagent_id 元数据），最后 yield
    ``_result`` 事件携带汇总结果。

    用法（在父 executor 的 ``_handle_delegate_call`` 中）::

        async for event in self.delegator.delegate(tc.arguments, parent_executor=self):
            if event.get("type") == "_result":
                result_content = event["content"]
            else:
                yield make_event("delegate", result=event)
    """

    def __init__(
        self,
        db,
        user,
        log_handler=None,
        *,
        max_depth: int = MAX_DELEGATION_DEPTH,
        child_max_iterations: int = 5,
    ):
        """初始化委派器。

        Args:
            db: 数据库会话
            user: 当前用户
            log_handler: 日志回调 (level, message)
            max_depth: 最大委派深度（默认 1 = 扁平）
            child_max_iterations: 子代理最大迭代轮数（独立预算）
        """
        self.db = db
        self.user = user
        self.log_handler = log_handler
        self.max_depth = max_depth
        self.child_max_iterations = child_max_iterations

    def _log(self, level: str, message: str) -> None:
        if self.log_handler is not None:
            try:
                self.log_handler(level, message)
            except Exception:  # noqa: BLE001
                pass

    async def delegate(
        self,
        args: dict,
        *,
        parent_executor,
    ) -> AsyncIterator[dict]:
        """委派子代理执行任务。

        Args:
            args: delegate_task 工具参数（goal/context/tasks）
            parent_executor: 父 HermesAgentExecutor 实例（用于继承配置）

        Yields:
            子代理事件 dict（含 ``subagent_id``/``task_index``/``event`` 元数据），
            最后 yield ``{"type": "_result", "content": ...}`` 携带汇总结果。
        """
        # 1. 解析参数
        goal = str(args.get("goal") or "").strip()
        context = str(args.get("context") or "").strip()
        tasks = args.get("tasks")

        if tasks and isinstance(tasks, list):
            task_list = [
                {
                    "goal": str(t.get("goal") or "").strip(),
                    "context": str(t.get("context") or "").strip(),
                }
                for t in tasks
                if isinstance(t, dict) and t.get("goal")
            ]
        elif goal:
            task_list = [{"goal": goal, "context": context}]
        else:
            yield {
                "type": "_result",
                "content": json.dumps(
                    {"error": "delegate_task 需要 'goal' 或 'tasks' 参数"},
                    ensure_ascii=False,
                ),
            }
            return

        # 2. 深度检查
        parent_depth = get_delegation_depth()
        if parent_depth >= self.max_depth:
            self._log(
                "warning",
                f"委派深度超限: depth={parent_depth}, max={self.max_depth}",
            )
            yield {
                "type": "_result",
                "content": json.dumps(
                    {
                        "error": f"委派深度超限（当前 {parent_depth}，最大 {self.max_depth}）",
                        "depth": parent_depth,
                        "max_depth": self.max_depth,
                    },
                    ensure_ascii=False,
                ),
            }
            return

        # 3. 创建 live transcripts
        from app.agent.hermes.delegation_live_log import (
            create_live_transcripts,
            update_manifest_statuses,
        )

        delegation_id, writers, paths = create_live_transcripts(task_list)
        if delegation_id:
            self._log("info", f"委派 {delegation_id}: {len(task_list)} 个子任务, transcript={paths}")

        # 4. 逐任务执行子代理
        #    （当前串行执行；批量 tasks 可后续扩展为 asyncio.gather 并行）
        results: List[Dict[str, Any]] = []
        parent_agent = parent_executor.agent

        for i, task in enumerate(task_list):
            subagent_id = f"sa-{i}-{uuid.uuid4().hex[:8]}"
            writer = writers[i] if i < len(writers) else None
            task_goal = task["goal"]
            task_context = task.get("context", "")

            self._log("info", f"子代理 {subagent_id} 启动: goal={task_goal[:80]}")

            # yield start 事件
            yield {
                "type": "delegate",
                "subagent_id": subagent_id,
                "task_index": i,
                "event": {
                    "type": "start",
                    "message": f"子代理 {subagent_id} 启动: {task_goal[:100]}",
                },
            }

            # 4a. 构建子代理配置
            parent_tools = list(getattr(parent_agent, "enabled_tools", None) or [])
            child_tools = _strip_blocked_tools(parent_tools)
            child_agent = ChildAgentConfig(
                parent_agent,
                enabled_tools=child_tools,
            )
            child_prompt = build_child_system_prompt(task_goal, task_context, parent_agent)

            # 4b. 构造子代理执行器
            #     延迟导入避免循环依赖
            from app.agent.hermes.executor import HermesAgentExecutor

            try:
                child_executor = HermesAgentExecutor(
                    db=self.db,
                    agent=child_agent,
                    user=self.user,
                    system_prompt=child_prompt,
                    max_iterations=self.child_max_iterations,
                    enable_memory=False,
                    log_handler=self.log_handler,
                )
            except Exception as exc:  # noqa: BLE001
                self._log("error", f"子代理 {subagent_id} 构造失败: {exc}")
                if writer:
                    writer.marker(f"init error: {exc}")
                results.append({
                    "task_index": i,
                    "goal": task_goal,
                    "status": "failed",
                    "exit_reason": "init_error",
                    "error": str(exc),
                    "result": "",
                })
                yield {
                    "type": "delegate",
                    "subagent_id": subagent_id,
                    "task_index": i,
                    "event": {"type": "error", "message": f"子代理构造失败: {exc}"},
                }
                continue

            # 4c. 在委派深度上下文中运行子代理
            child_result = ""
            child_status = "completed"
            exit_reason = None
            try:
                with delegation_depth_context(parent_depth + 1):
                    async for event in child_executor.run(task_goal):
                        # 转发到 transcript writer
                        if writer is not None:
                            try:
                                writer.observe(
                                    event.type,
                                    tool_name=event.tool_name,
                                    preview=event.content or event.message,
                                    result=event.result,
                                    is_error=(event.type == "error"),
                                )
                            except Exception:  # noqa: BLE001
                                pass

                        # 提取结果
                        if event.type == "done":
                            child_result = event.content or ""
                        elif event.type == "error":
                            child_result = event.message or "子代理执行错误"
                            child_status = "failed"
                            exit_reason = "error"

                        # yield 嵌套事件
                        yield {
                            "type": "delegate",
                            "subagent_id": subagent_id,
                            "task_index": i,
                            "event": _event_to_dict(event),
                        }
            except Exception as exc:  # noqa: BLE001
                self._log("error", f"子代理 {subagent_id} 执行异常: {exc}")
                child_result = f"子代理执行异常: {exc}"
                child_status = "failed"
                exit_reason = "exception"
                yield {
                    "type": "delegate",
                    "subagent_id": subagent_id,
                    "task_index": i,
                    "event": {"type": "error", "message": str(exc)},
                }

            # 4d. transcript 终止标记
            if writer is not None:
                try:
                    writer.finalize({
                        "status": child_status,
                        "exit_reason": exit_reason,
                        "error": child_result if child_status == "failed" else "",
                    })
                except Exception:  # noqa: BLE001
                    pass

            self._log(
                "info",
                f"子代理 {subagent_id} 完成: status={child_status}, "
                f"result_len={len(child_result)}",
            )

            results.append({
                "task_index": i,
                "goal": task_goal,
                "status": child_status,
                "exit_reason": exit_reason,
                "result": child_result,
            })

        # 5. 更新 manifest 状态
        if delegation_id:
            try:
                update_manifest_statuses(delegation_id, results)
            except Exception:  # noqa: BLE001
                pass

        # 6. 构建汇总结果（每个任务结果截断到预算，防止父上下文被整表数据撑爆）
        if len(results) == 1:
            # 单任务：直接返回结果文本
            content = _cap_delegation_result(results[0]["result"])
            if results[0]["status"] == "failed":
                content = json.dumps({
                    "status": "failed",
                    "error": results[0]["result"],
                    "goal": results[0]["goal"],
                }, ensure_ascii=False)
        else:
            # 批量：返回 JSON 汇总
            content = json.dumps({
                "delegation_id": delegation_id,
                "task_count": len(results),
                "tasks": [
                    {
                        "goal": r["goal"],
                        "status": r["status"],
                        "result": _cap_delegation_result(r["result"]),
                    }
                    for r in results
                ],
                "transcript_paths": paths if paths else None,
            }, ensure_ascii=False)

        yield {"type": "_result", "content": content}


def _event_to_dict(event) -> dict:
    """把 SSEEventDict 转为可序列化 dict（供嵌套 delegate 事件）。"""
    try:
        from dataclasses import asdict
        return {k: v for k, v in asdict(event).items() if v not in ("", None, [], {})}
    except Exception:  # noqa: BLE001
        return {"type": getattr(event, "type", "unknown"),
                "content": str(getattr(event, "content", "")),
                "message": str(getattr(event, "message", ""))}
