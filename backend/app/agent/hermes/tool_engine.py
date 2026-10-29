"""HermesToolEngine：工具注册表 + 分段并行执行器。

复用 ``app.agent.decision`` 的工具构造逻辑（_build_db_tools / _build_kb_tool /
_build_file_query_tool），但不直接返回 LangChain StructuredTool，而是抽取
(name, description, args_schema, coroutine) 四元组存入 ToolEntry 注册表。

执行时按 ``tool_dispatch.plan_tool_batch_segments`` 分段：
- 并行段用 ``asyncio.gather(return_exceptions=True)``
- 顺序段串行
- 结果按 original_index 回填保证 emission 顺序

Stage B 扩展点（guardrails / budget / middleware）通过 _execute_one 的钩子接入。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Optional

from app.agent.hermes.budget import BudgetConfig, maybe_persist_tool_result
from app.agent.hermes.guardrails import (
    ToolCallGuardrailConfig,
    ToolCallGuardrailController,
    append_toolguard_guidance,
    toolguard_synthetic_result,
)
from app.agent.hermes.middleware import (
    MiddlewareContext,
    MiddlewareRegistry,
    ShortCircuitResult,
    ToolCallRequest,
    ToolCallResponse,
)
from app.agent.hermes.threat_scanner import scan_tool_result
from app.agent.hermes.tool_dispatch import plan_tool_batch_segments
from app.agent.hermes.tool_search import (
    ToolSearchConfig,
    default_tool_search_config,
    dispatch_tool_describe,
    dispatch_tool_search,
    is_bridge_tool,
    resolve_underlying_call,
)
from app.agent.hermes.types import ToolCall, ToolEntry, ToolResult
from app.agent.hermes.verification import (
    WRITE_TOOLS_REQUIRING_VERIFICATION,
    VerificationConfig,
    VerificationResult,
    verify_write_tool,
)

logger = logging.getLogger(__name__)


def _coerce_primitive_args(args: dict) -> dict:
    """对 args_schema=None 的工具参数做轻量类型强转。

    LLM 常把数值参数传成字符串（如 ``"20"``），某些动态注册的工具没有
    pydantic args_schema 做强转。此处对纯数字字符串 → int，浮点字符串 → float，
    ``"true"``/``"false"`` → bool 做启发式转换，减少类型错误。
    """
    if not isinstance(args, dict):
        return args
    coerced: dict[str, Any] = {}
    for k, v in args.items():
        if isinstance(v, str):
            low = v.strip().lower()
            if low in ("true", "false"):
                coerced[k] = low == "true"
            elif v.strip() and v.strip().lstrip("-").isdigit():
                try:
                    coerced[k] = int(v.strip())
                except ValueError:
                    coerced[k] = v
            else:
                try:
                    f = float(v)
                    if "." in v or "e" in v.lower():
                        coerced[k] = f
                    else:
                        coerced[k] = v
                except (ValueError, TypeError):
                    coerced[k] = v
        else:
            coerced[k] = v
    return coerced


class HermesToolEngine:
    """工具注册表 + 分段并行执行器。"""

    def __init__(
        self,
        db,
        agent,
        log_handler: Optional[Callable] = None,
        *,
        user: Optional[Any] = None,
        middleware_registry: Optional[MiddlewareRegistry] = None,
        guardrail_config: Optional[ToolCallGuardrailConfig] = None,
        budget_config: Optional[BudgetConfig] = None,
        verification_config: Optional[VerificationConfig] = None,
        tool_timeout_sec: float = 30.0,
    ):
        """初始化工具引擎。

        Args:
            db: 数据库会话
            agent: Agent ORM 实例
            log_handler: 可选日志回调 (level, message)
            user: 当前对话用户（用于工具命名空间注入 current_user_id，文件归属隔离）
            middleware_registry: 中间件注册表（Stage B）；None 表示不启用中间件
            guardrail_config: 工具循环守卫配置（Stage B）；None 表示不启用守卫
            budget_config: 工具结果预算配置（Stage B）；None 表示不启用持久化
            verification_config: 写操作证据验证配置（Stage B）；None 表示不启用验证
        """
        self.db = db
        self.agent = agent
        self.log_handler = log_handler
        self.tool_timeout_sec = tool_timeout_sec
        # 当前对话用户 id（工具沙箱 current_user_id，文件归属 created_by）
        self.user_id = getattr(user, "id", None) if user is not None else None

        # Stage B 配置（不可变，跨 turn 复用）
        self.middleware_registry = middleware_registry
        self.budget_config = budget_config
        self.verification_config = verification_config

        # per-turn 状态（由 reset_for_turn 重置/注入）
        self.guardrail_controller: Optional[ToolCallGuardrailController] = (
            ToolCallGuardrailController(guardrail_config) if guardrail_config is not None else None
        )
        self.middleware_ctx: Optional[MiddlewareContext] = None
        # Execution.variables 引用，供 budget 持久化大工具结果
        self.variables: Optional[dict] = None

        # tool_search（渐进式工具披露）状态
        # 装配激活后，_full_tool_defs / _source_map 供桥接工具 dispatch 重建目录与分类
        # 从 Agent.tool_configs.tool_search 读取用户配置；缺省回退到 default（auto/10%）
        tool_configs = getattr(agent, "tool_configs", None) or {}
        raw_ts_cfg = tool_configs.get("tool_search") if isinstance(tool_configs, dict) else None
        self.tool_search_config: ToolSearchConfig = ToolSearchConfig.from_raw(raw_ts_cfg)
        self._assembly_result = None  # AssemblyResult（最近一次装配结果，供观测）
        self._full_tool_defs: list[dict] = []  # 装配前的完整 tool-defs（含核心+可延迟）
        self._source_map: dict[str, str] = {}  # 工具名 → source（供桥接 dispatch）

        self._registry: dict[str, ToolEntry] = {}
        self._build_registry()

    def reset_for_turn(
        self,
        *,
        middleware_ctx: Optional[MiddlewareContext] = None,
        variables: Optional[dict] = None,
    ) -> None:
        """每个 ReAct turn 开始时重置 per-turn 状态。

        - guardrail_controller：清空本 turn 的失败/无进展计数器
        - middleware_ctx：注入本 turn 的中间件上下文（含 tool_history）
        - variables：注入 Execution.variables 引用（供 budget 持久化）

        Args:
            middleware_ctx: 本 turn 的中间件上下文；None 保留原值
            variables: Execution.variables 字典引用；None 保留原值
        """
        if self.guardrail_controller is not None:
            self.guardrail_controller.reset_for_turn()
        if middleware_ctx is not None:
            self.middleware_ctx = middleware_ctx
        if variables is not None:
            self.variables = variables

    def _build_registry(self) -> None:
        """从 Agent 配置构建工具注册表。"""
        # 1. DB 工具（code + http；framework 类型由 executor 注入，不在此注册）
        self._register_db_tools()
        # 2. 知识库工具
        self._register_kb_tools()
        # 3. 资产检索工具（启用 search_assets 即注册；检索全部类型，见 _register_asset_tools）
        self._register_asset_tools()
        self._register_workflow_tools()
        # 注意：内置安全工具（check_whitelist 等）已迁移为 DB code 类型工具，
        # 由 _register_db_tools 统一加载，不再需要 _register_builtin_tools 兜底。
        logger.info(
            "HermesToolEngine 注册表构建完成: agent_id=%s, tools=%s",
            self.agent.id,
            list(self._registry.keys()),
        )

    def _register_db_tools(self) -> None:
        """注册 DB 中的 code/http 工具（跳过 framework 类型，后者由 executor 注入）。"""
        enabled_tools = self.agent.enabled_tools or []
        if not enabled_tools:
            return
        from app.models.tool import Tool

        for name in enabled_tools:
            tool = self.db.query(Tool).filter(Tool.name == name, Tool.enabled.is_(True)).first()
            if tool is None:
                logger.warning("DB 工具未找到或未启用: %s", name)
                continue
            # framework 类型工具（delegate_task/clarify 等）由 executor 作为 extra_tool_defs
            # 注入并在 _react_loop 中拦截处理，不走 tool_engine 执行管线
            if (tool.tool_type or "code").lower() == "framework":
                continue
            if name == "search_assets":
                continue
            try:
                from app.core.tool_runner import load_tool_function

                run_fn = load_tool_function(
                    tool,
                    enabled_kbs=self.agent.enabled_kbs or [],
                    agent_id=self.agent.id,
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

            # 判断并行安全性：HTTP 工具默认 barrier，code 工具按名称判断
            parallel_safe = self._is_parallel_safe(name)
            # 不可信包装：HTTP 工具结果可能含外部内容
            untrusted = tool_type == "http" or name.startswith("http_") or name.startswith("openapi_")

            self._registry[name] = ToolEntry(
                name=name,
                description=tool.description or f"DB 工具 {name}",
                args_schema=args_model,
                coroutine=self._make_safe_coroutine(run_fn, name),
                source=source,
                parallel_safe=parallel_safe,
                untrusted=untrusted,
            )

    def _register_kb_tools(self) -> None:
        """注册知识库检索工具。"""
        enabled_kbs = self.agent.enabled_kbs or []
        if not enabled_kbs:
            return

        # search_knowledge_base
        from app.agent.tool_builders import _build_kb_tool

        kb_tool = _build_kb_tool(enabled_kbs)
        if kb_tool is not None:
            self._registry["search_knowledge_base"] = ToolEntry(
                name="search_knowledge_base",
                description=kb_tool.description,
                args_schema=kb_tool.args_schema,
                coroutine=kb_tool.coroutine,
                source="kb",
                parallel_safe=True,
                untrusted=True,  # KB 结果含外部文档内容
            )

        # query_kb_file
        from app.agent.tool_builders import _build_file_query_tool

        file_tool = _build_file_query_tool(enabled_kbs)
        if file_tool is not None:
            self._registry["query_kb_file"] = ToolEntry(
                name="query_kb_file",
                description=file_tool.description,
                args_schema=file_tool.args_schema,
                coroutine=file_tool.coroutine,
                source="kb",
                parallel_safe=True,
                untrusted=True,
            )

    def _register_asset_tools(self) -> None:
        """注册资产检索工具（检索全部资产清单类型 + 资产发现，不按类型勾选过滤）。

        注册条件：工具列表启用 ``search_assets``，或历史配置勾选过资产类型
        （``enabled_asset_types`` 已废弃，仅作为老智能体的兼容开关）。
        复用 ``app.agent.tool_builders._build_asset_tool`` 构造工具，抽取
        (name, description, args_schema, coroutine) 注册为 ToolEntry。
        source="asset" 为核心来源（永不延迟，见 tool_search.py）。
        """
        enabled_tools = self.agent.enabled_tools or []
        legacy_asset_types = self.agent.enabled_asset_types or []
        if "search_assets" not in enabled_tools and not legacy_asset_types:
            return
        from app.agent.tool_builders import _build_asset_tool

        asset_tool = _build_asset_tool()
        if asset_tool is not None:
            self._registry["search_assets"] = ToolEntry(
                name="search_assets",
                description=asset_tool.description,
                args_schema=asset_tool.args_schema,
                coroutine=asset_tool.coroutine,
                source="asset",          # 核心来源，永不延迟（见 tool_search.py）
                parallel_safe=True,      # 只读检索，并行安全
                untrusted=True,          # 资产数据可能含外部来源
            )

    @staticmethod
    def _is_parallel_safe(name: str) -> bool:
        """判断工具是否并行安全（按名称规则）。"""
        from app.agent.hermes.tool_dispatch import _NEVER_PARALLEL_TOOLS, _PARALLEL_SAFE_TOOLS, _PARALLEL_SAFE_PREFIXES

        if name in _NEVER_PARALLEL_TOOLS:
            return False
        if name in _PARALLEL_SAFE_TOOLS:
            return True
        return any(name.startswith(prefix) for prefix in _PARALLEL_SAFE_PREFIXES)

    @staticmethod
    def _make_safe_coroutine(run_fn: Callable, name: str) -> Callable:
        """包装工具协程，捕获异常返回 {"error": ...} 而非抛出。"""

        async def _safe_coroutine(**kwargs):
            try:
                return await run_fn(**kwargs)
            except Exception as exc:  # noqa: BLE001
                logger.exception("工具 %s 执行异常: %s", name, exc)
                return {"error": str(exc)}

        return _safe_coroutine

    # ========================================================================
    # 工具列表（供 LLM bind_tools）
    # ========================================================================

    def list_tools(self) -> list[dict]:
        """返回工具清单（含 name/description/parameters）。

        用于日志和调试。
        """
        result: list[dict] = []
        for entry in self._registry.values():
            params = {}
            if entry.args_schema is not None:
                try:
                    schema = entry.args_schema.model_json_schema()
                    params = schema.get("properties", {})
                except Exception:
                    params = {}
            result.append({
                "name": entry.name,
                "description": entry.description,
                "parameters": params,
                "source": entry.source,
                "parallel_safe": entry.parallel_safe,
            })
        return result

    def get_openai_tools(self) -> list[dict]:
        """返回 OpenAI function-calling 兼容的 tool schema 列表。

        格式：``[{"type": "function", "function": {"name", "description", "parameters"}}]``
        供 LLM ``bind_tools`` 使用。
        """
        tools: list[dict] = []
        for entry in self._registry.values():
            if entry.args_schema is not None:
                try:
                    parameters = entry.args_schema.model_json_schema()
                except Exception:
                    parameters = {"type": "object", "properties": {}}
            else:
                parameters = entry.parameters or {"type": "object", "properties": {}, "additionalProperties": True}

            tools.append({
                "type": "function",
                "function": {
                    "name": entry.name,
                    "description": entry.description,
                    "parameters": parameters,
                },
            })
        return tools

    def _build_source_map(self) -> dict[str, str]:
        """从注册表构建 工具名 → source 映射（供 tool_search 分类与 dispatch）。"""
        return {name: entry.source for name, entry in self._registry.items()}

    def get_assembled_openai_tools(
        self,
        *,
        context_length: Optional[int] = None,
        extra_tool_defs: Optional[list[dict]] = None,
        extra_source_map: Optional[dict[str, str]] = None,
    ) -> list[dict]:
        """返回装配后的 OpenAI tool schema 列表（含 tool_search 桥接替换）。

        当可延迟工具 token 超过阈值时，把 ``db_code``/``db_http``/
        ``openapi_dynamic``/``workflow`` 来源的工具替换为三个桥接工具
        (``tool_search``/``tool_describe``/``tool_call``)，节省上下文。

        装配结果与完整 tool_defs / source_map 缓存到实例，供桥接 dispatch 使用。

        Args:
            context_length: 模型上下文窗口大小（token）；None 时 auto 模式回退到 20K 门槛
            extra_tool_defs: 额外工具 schema（如技能触发/列表工具），追加到列表末尾
            extra_source_map: 额外工具的 source 映射

        Returns:
            模型实际可见的 tool-defs 列表
        """
        from app.agent.hermes.tool_search import assemble_tool_defs

        # 1. 完整 tool_defs（registry + 额外工具）
        full_defs = self.get_openai_tools()
        if extra_tool_defs:
            full_defs.extend(extra_tool_defs)

        # 2. source_map（registry + 额外）
        source_map = self._build_source_map()
        if extra_source_map:
            source_map.update(extra_source_map)

        # 3. 装配（阈值门控）
        result = assemble_tool_defs(
            full_defs,
            source_map=source_map,
            context_length=context_length,
            config=self.tool_search_config,
        )

        # 4. 缓存供桥接 dispatch 使用
        self._assembly_result = result
        self._full_tool_defs = full_defs
        self._source_map = source_map

        if result.activated:
            self._log_tool(
                "info",
                f"tool_search 已激活: 核心 {result.visible_count} 个, "
                f"延迟 {result.deferred_count} 个 (~{result.deferred_tokens} token, "
                f"阈值 ~{result.threshold_tokens} token)",
            )
        elif result.deferred_count > 0:
            self._log_tool(
                "debug",
                f"tool_search 未激活（低于阈值）: 可延迟 {result.deferred_count} 个, "
                f"~{result.deferred_tokens} token < 阈值 ~{result.threshold_tokens} token",
            )

        return result.tool_defs

    def has_tool(self, name: str) -> bool:
        """检查工具是否在注册表中。"""
        return name in self._registry

    def get_tool(self, name: str) -> Optional[ToolEntry]:
        """获取工具条目。"""
        return self._registry.get(name)

    # ========================================================================
    # 工具执行（分段并行）
    # ========================================================================

    async def execute_tool_calls(
        self,
        tool_calls: list[ToolCall],
        *,
        interrupt_event: Optional[asyncio.Event] = None,
    ) -> list[ToolResult]:
        """按分段策略执行工具调用。

        并行段用 ``asyncio.gather(return_exceptions=True)``，
        顺序段串行。结果按 ``original_index`` 回填保证顺序。

        Args:
            tool_calls: LLM 返回的工具调用列表
            interrupt_event: 可选中断信号（set 后停止执行后续工具）

        Returns:
            ToolResult 列表，顺序与 tool_calls 一致
        """
        if not tool_calls:
            return []

        # 中断检查
        if interrupt_event is not None and interrupt_event.is_set():
            return [
                ToolResult(
                    tool_call_id=tc.id,
                    name=tc.name,
                    content={"error": "Tool execution cancelled by user interrupt", "status": "cancelled"},
                    is_error=True,
                )
                for tc in tool_calls
            ]

        segments = plan_tool_batch_segments(tool_calls)
        results: list[Optional[ToolResult]] = [None] * len(tool_calls)

        for kind, calls in segments:
            if interrupt_event is not None and interrupt_event.is_set():
                # 填充剩余为 cancelled
                for tc in calls:
                    if results[tc.original_index] is None:
                        results[tc.original_index] = ToolResult(
                            tool_call_id=tc.id,
                            name=tc.name,
                            content={"error": "Tool execution cancelled by user interrupt", "status": "cancelled"},
                            is_error=True,
                        )
                continue

            if kind == "parallel":
                logger.info("并行执行 %d 个工具: %s", len(calls), [tc.name for tc in calls])
                gathered = await asyncio.gather(
                    *(self._execute_one(tc) for tc in calls),
                    return_exceptions=True,
                )
                for tc, res in zip(calls, gathered):
                    if isinstance(res, Exception):
                        results[tc.original_index] = ToolResult(
                            tool_call_id=tc.id,
                            name=tc.name,
                            content={"error": f"Tool execution raised: {res}"},
                            is_error=True,
                        )
                    else:
                        results[tc.original_index] = res
            else:  # sequential
                logger.info("顺序执行 %d 个工具: %s", len(calls), [tc.name for tc in calls])
                for tc in calls:
                    if interrupt_event is not None and interrupt_event.is_set():
                        results[tc.original_index] = ToolResult(
                            tool_call_id=tc.id,
                            name=tc.name,
                            content={"error": "Tool execution cancelled by user interrupt", "status": "cancelled"},
                            is_error=True,
                        )
                        continue
                    try:
                        results[tc.original_index] = await self._execute_one(tc)
                    except Exception as exc:  # noqa: BLE001
                        results[tc.original_index] = ToolResult(
                            tool_call_id=tc.id,
                            name=tc.name,
                            content={"error": f"Tool execution raised: {exc}"},
                            is_error=True,
                        )

        # 填充 None（理论上不应出现，但兜底）
        for i, r in enumerate(results):
            if r is None:
                results[i] = ToolResult(
                    tool_call_id=tool_calls[i].id,
                    name=tool_calls[i].name,
                    content={"error": "Tool result missing (unexpected)"},
                    is_error=True,
                )

        return results  # type: ignore[return-value]

    async def _execute_one(self, tc: ToolCall) -> ToolResult:
        """执行单个工具调用（Stage B 完整版）。

        流程：
        1. 查注册表 → 未命中时 fuzzy_match 自动纠正或返回 did-you-mean
        2. middleware before_tool_call（可短路返回合成结果）
        3. guardrail before_call（可 block 返回合成错误）
        4. verification verify_write_tool（写工具证据验证，可 blocked/needs_clarification）
        5. 执行工具 coroutine
        6. guardrail after_call（可 warn 追加指导 / halt 标记终止 turn）
        7. untrusted 不可信包装
        8. threat_scanner 扫描（记录 threat_findings，不阻断）
        9. budget maybe_persist（超大结果持久化到 variables）
        10. middleware after_tool_call（可改写结果）
        """
        start_time = time.time()

        # ── 桥接工具拦截（tool_search 装配激活时） ──
        # tool_search / tool_describe / tool_call 不在 _registry，单独分发。
        # tool_call 解析出底层工具后递归 _execute_one，走完整 Stage B 管线
        # （guardrail / middleware / verification / threat_scanner / budget 全触发）。
        if is_bridge_tool(tc.name):
            return await self._execute_bridge_tool(tc, start_time)

        entry = self._registry.get(tc.name)

        # 1. 工具名未命中 → fuzzy_match 自动纠正
        if entry is None:
            from app.agent.hermes.fuzzy_tool_match import fuzzy_match_tool_name

            registered = list(self._registry.keys())
            fuzzy = fuzzy_match_tool_name(tc.name, registered)
            if fuzzy.is_match and fuzzy.matched_name is not None:
                self._log_tool(
                    "info",
                    f"工具名模糊匹配: {tc.name} -> {fuzzy.matched_name} "
                    f"(策略={fuzzy.strategy}, 置信度={fuzzy.confidence:.2f})",
                )
                entry = self._registry[fuzzy.matched_name]
                effective_name = fuzzy.matched_name
            else:
                duration_ms = int((time.time() - start_time) * 1000)
                return ToolResult(
                    tool_call_id=tc.id,
                    name=tc.name,
                    content={"error": f"Unknown tool: {tc.name}", "hint": fuzzy.to_hint()},
                    is_error=True,
                    duration_ms=duration_ms,
                )
        else:
            effective_name = tc.name

        # 中间件上下文（executor 注入；未注入时现场兜底构造）
        ctx = self.middleware_ctx
        if ctx is None and self.middleware_registry is not None:
            ctx = MiddlewareContext(
                agent_id=getattr(self.agent, "id", 0),
                user_id=0,
                session_id="",
            )

        # 2. middleware before_tool_call（可短路）
        if self.middleware_registry is not None and ctx is not None:
            request = ToolCallRequest(
                tool_name=effective_name,
                arguments=tc.arguments,
                tool_call_id=tc.id,
            )
            short_circuit = self.middleware_registry.invoke_before_tool_call(request, ctx)
            if short_circuit is not None:
                sc_result: ToolCallResponse = short_circuit.result
                duration_ms = int((time.time() - start_time) * 1000)
                self._log_tool("info", f"工具 {effective_name} 被中间件短路: {short_circuit.reason}")
                return ToolResult(
                    tool_call_id=tc.id,
                    name=tc.name,
                    content=self._stringify(sc_result.result),
                    is_error=sc_result.is_error,
                    duration_ms=duration_ms,
                    guardrail_action="allow",
                )

        # 3. guardrail before_call（可 block）
        guard_decision = None
        if self.guardrail_controller is not None:
            guard_decision = self.guardrail_controller.before_call(effective_name, tc.arguments)
            if guard_decision.should_halt:
                duration_ms = int((time.time() - start_time) * 1000)
                self._log_tool("warning", f"工具 {effective_name} 被守卫阻断: {guard_decision.code}")
                return ToolResult(
                    tool_call_id=tc.id,
                    name=tc.name,
                    content=toolguard_synthetic_result(guard_decision),
                    is_error=True,
                    duration_ms=duration_ms,
                    guardrail_action=guard_decision.action,
                )

        # 4. verification：写工具证据验证
        if self.verification_config is not None and effective_name in WRITE_TOOLS_REQUIRING_VERIFICATION:
            verify_context = {
                "tool_history": ctx.tool_history if ctx is not None else [],
                "confirmed_facts": ctx.confirmed_facts if ctx is not None else {},
            }
            v_result = verify_write_tool(
                effective_name,
                tc.arguments,
                context=verify_context,
                config=self.verification_config,
            )
            if not v_result.approved:
                duration_ms = int((time.time() - start_time) * 1000)
                v_content: dict = {
                    "error": v_result.message,
                    "verification_code": v_result.code,
                    "missing_evidence": v_result.missing_evidence,
                }
                if v_result.clarification_question:
                    v_content["clarification_question"] = v_result.clarification_question
                if v_result.clarification_choices:
                    v_content["clarification_choices"] = v_result.clarification_choices
                self._log_tool("warning", f"写工具 {effective_name} 验证未通过: {v_result.code}")
                return ToolResult(
                    tool_call_id=tc.id,
                    name=tc.name,
                    content=v_content,
                    is_error=True,
                    duration_ms=duration_ms,
                    guardrail_action="allow",
                )

        # 5. 执行工具
        # 先用 args_schema 做类型强转：LLM 常把数值参数传成字符串（如 limit="20"），
        # 直接 **tc.arguments 会触发 min(int, str) 等类型错误。
        # pydantic 校验会把 "20" 强转为 int 20；校验失败时回退原始参数交由工具自行处理。
        call_args = tc.arguments
        if entry.args_schema is not None:
            try:
                validated = entry.args_schema(**call_args)
                call_args = (
                    validated.model_dump()
                    if hasattr(validated, "model_dump")
                    else validated.dict()
                )
            except Exception:  # noqa: BLE001
                pass
        else:
            # args_schema=None 的工具（workflow/dynamic）也做轻量类型强转：
            # 纯数字字符串 → int，浮点字符串 → float，"true"/"false" → bool
            call_args = _coerce_primitive_args(call_args)

        # 工具执行超时保护：防止死循环或卡住的网络请求阻塞整个 ReAct 循环
        tool_timeout = float(getattr(self, "tool_timeout_sec", 30.0))
        try:
            raw_result = await asyncio.wait_for(
                entry.coroutine(**call_args), timeout=tool_timeout
            )
            is_error = isinstance(raw_result, dict) and "error" in raw_result
        except asyncio.TimeoutError:
            logger.warning("工具 %s 执行超时（%ss），已终止", effective_name, tool_timeout)
            raw_result = {"error": f"工具执行超时（{tool_timeout:.0f}秒），已终止"}
            is_error = True
        except Exception as exc:  # noqa: BLE001
            logger.exception("工具 %s 执行异常: %s", effective_name, exc)
            raw_result = {"error": str(exc)}
            is_error = True

        # 6. guardrail after_call（可 warn / halt）
        guard_action = "allow"
        if self.guardrail_controller is not None:
            guard_decision = self.guardrail_controller.after_call(
                effective_name, tc.arguments, raw_result, failed=is_error,
            )
            guard_action = guard_decision.action

        # 累积 tool_history（供后续工具的 verification 查询证据链）
        # 核心职责，不依赖 AuditMiddleware —— 即使未配置任何中间件，verification 也能工作
        if ctx is not None:
            ctx.tool_history.append({
                "name": effective_name,
                "tool_call_id": tc.id,
                "result": raw_result,
                "is_error": is_error,
            })

        # 7. untrusted 不可信包装
        from app.agent.hermes.untrusted import maybe_wrap_untrusted

        wrapped = maybe_wrap_untrusted(effective_name, raw_result)
        result_str = self._stringify(wrapped)

        # 追加 guardrail warn 指导（halt 由 executor 检查 halt_decision 终止 turn）
        if guard_decision is not None and guard_decision.action == "warn":
            result_str = append_toolguard_guidance(result_str, guard_decision)

        # 8. threat_scanner 扫描（记录，不阻断）
        threat_findings: list[str] = []
        try:
            threat_findings = scan_tool_result(effective_name, result_str)
            if threat_findings:
                self._log_tool("warning", f"工具 {effective_name} 结果检出威胁模式: {threat_findings}")
        except Exception as exc:  # noqa: BLE001
            logger.debug("威胁扫描异常 %s: %s", effective_name, exc)

        # 9. budget maybe_persist（超大结果持久化到 Execution.variables）
        persisted_ref = ""
        persisted = False
        if self.budget_config is not None:
            result_str, ref_key = maybe_persist_tool_result(
                content=result_str,
                tool_name=effective_name,
                tool_use_id=tc.id,
                variables=self.variables,
                config=self.budget_config,
            )
            if ref_key is not None:
                persisted_ref = ref_key
                persisted = True

        # 10. middleware after_tool_call（可改写结果）
        if self.middleware_registry is not None and ctx is not None:
            response = ToolCallResponse(
                tool_name=effective_name,
                tool_call_id=tc.id,
                result=result_str,
                is_error=is_error,
                duration_ms=int((time.time() - start_time) * 1000),
            )
            response = self.middleware_registry.invoke_after_tool_call(response, ctx)
            result_str = response.result if isinstance(response.result, str) else self._stringify(response.result)
            is_error = response.is_error

        duration_ms = int((time.time() - start_time) * 1000)
        logger.info(
            "工具执行完成: name=%s, duration=%dms, is_error=%s, persisted=%s, threats=%d, guard=%s",
            effective_name, duration_ms, is_error, persisted, len(threat_findings), guard_action,
        )

        # 工具生成的输出文件（如 expand_risk_detail 的展开表）：从原始结果提取，
        # 供 executor 推送 file 事件（内容已字符串化，须在此处原始 dict 上提取）
        from app.agent.decision import _extract_generated_file

        generated_file = _extract_generated_file(raw_result) if not is_error else None

        return ToolResult(
            tool_call_id=tc.id,
            name=tc.name,
            content=result_str,
            is_error=is_error,
            duration_ms=duration_ms,
            persisted=persisted,
            full_result_ref=persisted_ref,
            threat_findings=threat_findings,
            guardrail_action=guard_action,
            generated_file=generated_file,
        )

    async def _execute_bridge_tool(self, tc: ToolCall, start_time: float) -> ToolResult:
        """执行桥接工具（``tool_search`` / ``tool_describe`` / ``tool_call``）。

        - ``tool_search`` / ``tool_describe``：直接调用 dispatch 函数返回 JSON，
          不走 Stage B 管线（它们是元工具，只读取已缓存的目录）。
        - ``tool_call``：解析底层工具名+参数，构造新 ToolCall 递归走
          ``_execute_one`` 完整管线（guardrail/middleware/verification/
          threat_scanner/budget 全触发），保证写工具安全防护一致。

        Args:
            tc: 桥接工具调用（name 为 tool_search/tool_describe/tool_call）
            start_time: 调用开始时间戳

        Returns:
            ToolResult。``tool_call`` 的结果 name 为底层工具名（供展示）。
        """
        args = tc.arguments or {}

        # ── tool_search：BM25 检索延迟工具目录 ──
        if tc.name == "tool_search":
            content = dispatch_tool_search(
                args,
                full_tool_defs=self._full_tool_defs,
                source_map=self._source_map,
                config=self.tool_search_config,
            )
            self._log_tool(
                "info",
                f"桥接 tool_search: query={args.get('query')!r}, limit={args.get('limit')}",
            )
            return ToolResult(
                tool_call_id=tc.id,
                name=tc.name,
                content=content,
                is_error=False,
                duration_ms=int((time.time() - start_time) * 1000),
            )

        # ── tool_describe：返回工具完整 schema ──
        if tc.name == "tool_describe":
            content = dispatch_tool_describe(
                args,
                full_tool_defs=self._full_tool_defs,
                source_map=self._source_map,
            )
            self._log_tool(
                "info",
                f"桥接 tool_describe: name={args.get('name')!r}",
            )
            return ToolResult(
                tool_call_id=tc.id,
                name=tc.name,
                content=content,
                is_error=False,
                duration_ms=int((time.time() - start_time) * 1000),
            )

        # ── tool_call：解析底层工具并递归执行 ──
        underlying_name, underlying_args, err = resolve_underlying_call(
            args, source_map=self._source_map,
        )
        if err is not None:
            duration_ms = int((time.time() - start_time) * 1000)
            self._log_tool("warning", f"桥接 tool_call 解析失败: {err}")
            return ToolResult(
                tool_call_id=tc.id,
                name=tc.name,
                content={"error": err, "hint": "请先用 tool_search 查找工具，再用 tool_describe 查看参数"},
                is_error=True,
                duration_ms=duration_ms,
            )

        self._log_tool("info", f"桥接 tool_call: -> {underlying_name}")
        # 构造底层 ToolCall：保留 id/original_index（LLM 据此关联结果），
        # 替换 name/arguments 为底层工具
        underlying_tc = ToolCall(
            original_index=tc.original_index,
            id=tc.id,
            name=underlying_name,
            arguments=underlying_args,
            malformed=False,
            raw_arguments=tc.raw_arguments,
        )
        # 递归走完整 Stage B 管线（此时 is_bridge_tool(underlying_name) 为 False，
        # 会进入正常 registry 查找 + 守卫 + 验证 + 不可信包装 + 威胁扫描 + 预算）
        return await self._execute_one(underlying_tc)

    @staticmethod
    def _stringify(value: Any) -> str:
        """把任意工具结果序列化为字符串（供 budget/threat_scan/middleware 统一处理）。"""
        import json as _json

        if isinstance(value, str):
            return value
        if isinstance(value, (dict, list)):
            return _json.dumps(value, ensure_ascii=False, default=str)
        if value is None:
            return ""
        return str(value)

    def _log_tool(self, level: str, message: str) -> None:
        """工具相关日志（含 log_handler 回调）。"""
        logger.log(getattr(logging, level.upper(), logging.INFO), message)
        if self.log_handler is not None:
            try:
                self.log_handler(level, message)
            except Exception:  # noqa: BLE001
                pass

    # ========================================================================
    # 动态工具注册（OpenAPI / 工作流包装）
    # ========================================================================

    def register_openapi(self, spec_text: str, base_url: str = "") -> list[str]:
        """从 OpenAPI spec 动态注册工具（不入库，仅本次会话内存态）。

        复用 ``tools_manage._parse_openapi_spec`` /
        ``_extract_operations_from_openapi`` / ``build_from_operation`` 逻辑。

        Args:
            spec_text: OpenAPI/Swagger JSON 或 YAML 字符串
            base_url: API 基础 URL

        Returns:
            注册成功的工具名列表
        """
        try:
            from app.api.v1.tools_manage import (
                _parse_openapi_spec,
                _extract_operations_from_openapi,
                build_from_operation,
            )
        except ImportError:
            logger.warning("OpenAPI 导入模块不可用，跳过动态注册")
            return []

        spec = _parse_openapi_spec(spec_text)
        if spec is None:
            return []

        operations = _extract_operations_from_openapi(spec, base_url)
        registered: list[str] = []
        for op in operations:
            try:
                tool_config = build_from_operation(op)
                name = tool_config.get("name", "")
                if not name or name in self._registry:
                    continue
                # 构造 HTTP 工具协程（简化版，实际执行走 tool_http_runner）
                self._registry[name] = ToolEntry(
                    name=name,
                    description=tool_config.get("description", ""),
                    args_schema=None,
                    coroutine=self._make_openapi_coroutine(tool_config),
                    source="openapi_dynamic",
                    parallel_safe=False,  # OpenAPI 动态工具默认 barrier
                    untrusted=True,
                )
                registered.append(name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("OpenAPI 工具注册失败: %s", exc)
        logger.info("OpenAPI 动态注册 %d 个工具: %s", len(registered), registered)
        return registered

    @staticmethod
    def _make_openapi_coroutine(tool_config: dict) -> Callable:
        """构造 OpenAPI 工具的执行协程。"""

        async def _coroutine(**kwargs):
            from app.core.tool_http_runner import run_http_tool

            return await run_http_tool(tool_config, kwargs)

        return _coroutine

    def _register_workflow_tools(self) -> None:
        from app.agent.workflow_as_tool import infer_parameters, make_tool_name
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
            desc = (wf.description or "").strip() or f"运行已发布工作流：{wf.name}"
            self.register_workflow_as_tool(
                wf.id,
                make_tool_name(wf.id, wf.name),
                desc,
                parameters=infer_parameters(wf.graph_config),
            )

    def register_workflow_as_tool(
        self,
        workflow_id: int,
        tool_name: str,
        description: str,
        parameters: Optional[dict] = None,
    ) -> None:
        from app.agent.workflow_as_tool import invoke_workflow_as_tool

        async def _coroutine(**kwargs):
            return await invoke_workflow_as_tool(
                db=self.db,
                workflow_id=workflow_id,
                agent_id=getattr(self.agent, "id", None),
                payload=kwargs,
            )

        self._registry[tool_name] = ToolEntry(
            name=tool_name,
            description=description,
            args_schema=None,
            coroutine=_coroutine,
            source="workflow",
            parallel_safe=False,
            untrusted=False,
            parameters=parameters,
        )
