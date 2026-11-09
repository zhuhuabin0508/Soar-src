"""HermesAgentExecutor：Hermes 风格 ReAct 执行器。

集成 ToolEngine + SkillEngine（+ Stage B 的 Compressor + Memory + Delegator）。

主循环：
1. 预取记忆（Stage B 接入）
2. while budget.consume():
   a. 压缩上下文（Stage B 接入）
   b. 调 LLM（含 tools）
   c. 拦截响应：
      - 纯文本且无 tool_calls → 最终回答，结束
      - tool_calls → tool_engine.execute_tool_calls，拼结果消息
      - trigger_workflow_skill → skill_engine.trigger_skill
   d. 同步记忆（Stage B 接入）
3. 预算耗尽 → grace call 让 LLM 给出最终答案

SSE 事件契约：start → (token | tool_start | tool_end | skill_interrupt)* → done | error
"""
from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Callable, Optional

from app.agent.hermes.sse import SSEEventDict, make_event
from app.agent.hermes.types import IterationBudget, ToolCall
from app.agent.hermes.delegator import Delegator

logger = logging.getLogger(__name__)


class HermesAgentExecutor:
    """Hermes 风格 ReAct 执行器。"""

    def __init__(
        self,
        db,
        agent,
        user,
        *,
        system_prompt: Optional[str] = None,
        max_iterations: Optional[int] = None,
        context_turns: Optional[int] = None,
        enable_memory: Optional[bool] = None,
        log_handler: Optional[Callable] = None,
        override: Any = None,
    ):
        """初始化执行器。

        Args:
            db: 数据库会话
            agent: Agent ORM 实例（engine 应为 "hermes"）
            user: 当前用户
            system_prompt: 自定义系统提示词；None 则用 assemble_system_prompt 组装
            max_iterations: 最大迭代轮数；None 用 agent.max_iterations
            context_turns: 上下文轮数；None 用 agent.context_turns
            enable_memory: 记忆开关；None 用 agent.enable_memory
            log_handler: 日志回调 (level, message)
            override: 会话级参数覆盖（ChatOverride 实例）；None 时走 Agent 配置。
                含 model_config_id/temperature/max_tokens/top_p 等字段，按需启用。
        """
        self.db = db
        self._session_factory = None
        self.agent = agent
        self.user = user
        self.log_handler = log_handler
        self.override = override  # 会话级参数覆盖（Playground 调试用）

        # 配置
        self.max_iterations = max_iterations or agent.max_iterations or 5
        self.context_turns = context_turns or agent.context_turns or 10
        self.enable_memory = enable_memory if enable_memory is not None else (agent.enable_memory or False)
        self.session_id: str = ""

        # 构建 LLM
        self.llm = self._build_llm()
        if self.llm is None:
            raise RuntimeError("LLM 创建失败，请检查 Agent 的 model_config_id 或环境变量")

        # 缓存模型监控元数据（供 ModelCallTimer 记录调用指标）
        self._model_meta = self._resolve_model_meta()

        # 流式调用结果缓存（_call_llm_stream 完成后写入，供 _react_loop 读取）
        self._streamed_response = None
        # Token 用量累积（每次 _call_llm_stream 后更新，供监控记录读取）
        self._token_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        # ReAct 迭代次数（供监控记录读取）
        self._iteration_count = 0
        # 思维链字符数累积（供监控记录读取）
        self._thinking_chars = 0

        # 构建 system prompt
        if system_prompt is not None:
            self.system_prompt = system_prompt
        else:
            from app.agent.prompt_assembler import assemble_system_prompt

            self.system_prompt = assemble_system_prompt(
                db, agent, fallback_prompt="你是一个智能助手，请根据用户输入给出有帮助的回答。"
            )

        # Stage B 配置：从 Agent.tool_configs 加载中间件 / 守卫 / 验证配置
        tool_configs = getattr(agent, "tool_configs", None) or {}
        from app.agent.hermes.budget import budget_for_context_window
        from app.agent.hermes.guardrails import ToolCallGuardrailConfig
        from app.agent.hermes.middleware import MiddlewareContext, MiddlewareRegistry
        from app.agent.hermes.verification import VerificationConfig

        self.middleware_registry = MiddlewareRegistry.from_agent_config(tool_configs)
        self.guardrail_config = ToolCallGuardrailConfig.from_mapping(tool_configs.get("guardrails"))
        self.verification_config = VerificationConfig.from_mapping(tool_configs.get("verification"))
        # 模型上下文窗口未存库，用默认预算（200K token 基准；budget_for_context_window(None) 降级为 DEFAULT_BUDGET）
        self.budget_config = budget_for_context_window(None)

        # 构建工具引擎（注入 Stage B 配置）
        from app.agent.hermes.tool_engine import HermesToolEngine

        self.tool_engine = HermesToolEngine(
            db,
            agent,
            log_handler=log_handler,
            user=user,
            middleware_registry=self.middleware_registry,
            guardrail_config=self.guardrail_config,
            budget_config=self.budget_config,
            verification_config=self.verification_config,
        )

        # 绑定工具到 LLM
        # 框架级工具（trigger_workflow_skill/list_workflow_skills/delegate_task/clarify）
        # 从 DB 加载 schema（tool_type='framework'），作为额外工具传入装配器。
        # 这些工具是核心工具（永不延迟），在 _react_loop 中被拦截走专属处理方法。
        from app.agent.hermes.skill_engine import WorkflowSkillBridge
        from app.models.tool import Tool as ToolModel

        self.skill_engine = WorkflowSkillBridge(db, agent, user, log_handler=log_handler)

        # 从 DB 查询启用的框架级工具，构造 OpenAI tool-defs
        framework_tools = db.query(ToolModel).filter(
            ToolModel.tool_type == "framework",
            ToolModel.enabled.is_(True),
        ).all()
        # 构建类框架工具（智能体创建助手专用）仅对显式启用的智能体可见，
        # 避免这些创建能力暴露给所有 hermes 智能体
        from app.agent.hermes.builder import BUILDER_TOOL_NAMES
        from app.agent.workflow_as_tool import GLOBAL_WORKFLOW_TOOL_NAMES

        enabled_tool_names = set(agent.enabled_tools or [])
        framework_tools = [
            t for t in framework_tools
            if (t.name not in BUILDER_TOOL_NAMES or t.name in enabled_tool_names)
            and (t.name not in GLOBAL_WORKFLOW_TOOL_NAMES or t.name in enabled_tool_names)
        ]
        extra_tool_defs = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description or "",
                    "parameters": t.parameters_schema or {"type": "object", "properties": {}},
                },
            }
            for t in framework_tools
        ]
        # 框架级工具全部标记为核心 source（永不延迟，直接调用）
        # delegate_task 单独标记为 "delegate"（用于子代理工具剥离逻辑）
        extra_source_map = {
            t.name: ("delegate" if t.name == "delegate_task" else "builtin")
            for t in framework_tools
        }
        # get_assembled_openai_tools 会按阈值门控决定是否激活 tool_search 桥接：
        # 可延迟工具（db_code/db_http/openapi_dynamic/workflow）token 超阈值时
        # 替换为 tool_search/tool_describe/tool_call 三个桥接工具
        openai_tools = self.tool_engine.get_assembled_openai_tools(
            extra_tool_defs=extra_tool_defs,
            extra_source_map=extra_source_map,
        )

        if openai_tools:
            try:
                # parallel_tool_calls=False：强制 LLM 每轮只调用一个工具，
                # 确保按提示词定义的顺序执行（如先查资产，未命中再查威胁情报），
                # 避免 LLM 自主并行调用导致流程错乱。OpenAI 兼容 API 均支持此参数。
                self.llm_with_tools = self.llm.bind_tools(
                    openai_tools, parallel_tool_calls=False
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("bind_tools(parallel_tool_calls=False) 失败，回退默认: %s", exc)
                try:
                    self.llm_with_tools = self.llm.bind_tools(openai_tools)
                except Exception as exc2:  # noqa: BLE001
                    logger.warning("bind_tools 失败（降级为无工具）: %s", exc2)
                    self.llm_with_tools = self.llm
        else:
            self.llm_with_tools = self.llm

        # 迭代预算
        self.budget = IterationBudget(self.max_iterations)

        # 消息历史（OpenAI 格式）
        self.messages: list[dict] = []
        self._init_messages()

        # Stage B/C 扩展点
        self.context_compressor = None  # Stage B: ContextCompressor
        self.memory_manager = None  # Stage B: MemoryManager
        # Stage C: 子代理委派器（递归构造 HermesAgentExecutor，独立预算，SSE 转发）
        self.delegator = Delegator(
            db=db,
            user=user,
            log_handler=log_handler,
            child_max_iterations=min(self.max_iterations, 5),
        )
        # 中间件上下文（per-turn，由 _react_loop 构造并注入 tool_engine）
        self.middleware_ctx: Optional[MiddlewareContext] = None
        # Execution.variables 引用（供 budget 持久化大工具结果；None 时降级为内联截断）
        self._execution_variables: Optional[dict] = None

    def set_execution_variables(self, variables: dict) -> None:
        """注入 Execution.variables 引用，供 budget 持久化大工具结果。

        由 API 路由在创建 Execution 后调用。未调用时 budget 降级为内联截断
        （结果不丢失，但不可通过 query_persisted_result 取回全量）。
        """
        self._execution_variables = variables

    def _build_llm(self):
        """创建 LLM 实例。"""
        from app.api.v1.agents import _create_llm

        llm, err = _create_llm(self.agent, self.db, override=self.override)
        if llm is None:
            logger.error("LLM 创建失败: %s", err)
            return None
        return llm

    def _resolve_model_meta(self) -> dict:
        """解析当前 Agent 使用的模型配置元数据，供监控记录使用。

        override.model_config_id 优先于 agent.model_config_id（让监控记录反映实际使用的模型）。

        Returns:
            ``{"model_config_id", "model_name", "provider"}``，解析失败时各字段为空/None。
        """
        meta = {"model_config_id": None, "model_name": "", "provider": ""}
        try:
            # override 优先：Playground 切换模型后，监控记录应反映实际使用的模型
            cfg_id = (
                self.override.model_config_id
                if (self.override and getattr(self.override, "model_config_id", None) is not None)
                else getattr(self.agent, "model_config_id", None)
            )
            meta["model_config_id"] = cfg_id
            if cfg_id:
                from app.models.llm_config import LLMConfig

                cfg = self.db.query(LLMConfig).filter(LLMConfig.id == cfg_id).first()
                if cfg is not None:
                    meta["model_name"] = cfg.model_name or ""
                    meta["provider"] = cfg.provider or ""
        except Exception as exc:  # noqa: BLE001
            logger.debug("解析模型元数据失败: %s", exc)
        return meta

    def _init_messages(self) -> None:
        """初始化消息列表。"""
        self.messages = [
            {"role": "system", "content": self.system_prompt},
        ]
        # 已注入的历史消息条数（load_history 设置）。
        # get_new_messages 据此返回 system+history 之后的新增消息，供持久化。
        self._history_len = 0

    def load_history(self, history: list[dict]) -> None:
        """注入历史对话消息（OpenAI 格式，不含 system）。

        在 sse_stream 调用 executor.run() 之前由 API 路由调用，使本轮 LLM 能
        看到历史 user/assistant/tool 消息（多轮对话上下文）。history 追加到
        system 消息之后；随后 run() 追加的当前 user_input 与 ReAct 产生的新消息
        均位于历史之后，get_new_messages 可据此返回本轮新增消息供持久化。

        Args:
            history: OpenAI 格式消息字典列表（role 为 user/assistant/tool）。
                assistant 消息可含 tool_calls；tool 消息含 tool_call_id/name。
        """
        if not history:
            self._history_len = 0
            return
        # 仅保留合法角色，丢弃可能的 system 消息（避免重复）
        clean = [m for m in history if m.get("role") in ("user", "assistant", "tool")]
        self.messages.extend(clean)
        self._history_len = len(clean)

    def get_new_messages(self) -> list[dict]:
        """返回本轮新增的消息（system + 历史之后的部分）。

        流式结束后由 API 路由调用，将本轮 user_input + assistant + tool 消息
        持久化到 chat_messages 表，供下一轮加载。

        Returns:
            OpenAI 格式消息字典列表（含本轮 user 输入及其后续所有消息）。
        """
        # self.messages = [system] + history + [本轮新消息...]
        start = 1 + self._history_len
        return self.messages[start:]

    def _log(self, level: str, message: str) -> None:
        """输出日志并回调。"""
        logger.log(getattr(logging, level.upper(), logging.INFO), message)
        if self.log_handler is not None:
            try:
                self.log_handler(level, message)
            except Exception:  # noqa: BLE001
                pass

    def _release_db_for_io(self) -> None:
        """长 I/O（LLM）前释放 ORM 会话连接；联动链路启用 session_factory。"""
        if getattr(self, "_session_factory", None) is None and self.db is None:
            return
        from app.database import close_db_session

        if self.db is not None:
            close_db_session(self.db)
            self.db = None
        if self.tool_engine is not None and self.tool_engine.db is not None:
            close_db_session(self.tool_engine.db)
            self.tool_engine.db = None

    # ========================================================================
    # 主循环
    # ========================================================================

    async def run(
        self,
        user_input: str,
        *,
        session_id: str = "",
    ) -> AsyncIterator[SSEEventDict]:
        """主循环，yield SSE 事件。

        Args:
            user_input: 用户输入
            session_id: 会话 ID

        Yields:
            SSEEventDict 事件
        """
        self.session_id = session_id
        self._log("info", f"Hermes 引擎启动: agent_id={self.agent.id}, session={session_id}")

        # 1. 预取记忆（Stage B 接入）
        memory_block = ""
        if self.enable_memory and self.memory_manager is not None:
            try:
                memory_block = await self.memory_manager.prefetch_all(
                    user_input,
                    user_id=self.user.id,
                    agent_id=self.agent.id,
                    session_id=session_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("记忆预取失败: %s", exc)

        # 2. 追加用户消息
        user_content = user_input
        if memory_block:
            user_content = f"{user_input}\n\n[相关记忆]\n{memory_block}"
        self.messages.append({"role": "user", "content": user_content})

        yield make_event("start", message="Hermes 引擎已启动")

        # 3. ReAct 循环
        try:
            async for event in self._react_loop():
                yield event
        except Exception as exc:  # noqa: BLE001
            logger.exception("ReAct 循环异常: %s", exc)
            yield make_event("error", message=f"执行异常: {exc}")

    async def _react_loop(self) -> AsyncIterator[SSEEventDict]:
        """ReAct 主循环。"""
        from app.agent.hermes.middleware import MiddlewareContext

        while self.budget.consume():
            self._iteration_count += 1
            self._log(
                "info",
                f"ReAct 迭代 {self.budget.used}/{self.budget.max_total}，消息数={len(self.messages)}",
            )

            # Stage B: 构造 per-turn 中间件上下文 + 重置 tool_engine per-turn 状态
            # tool_history 在 turn 内累积（供 verification 查询证据链 + guardrail 计数）
            self.middleware_ctx = MiddlewareContext(
                agent_id=getattr(self.agent, "id", 0),
                user_id=getattr(self.user, "id", 0),
                session_id=self.session_id,
            )
            self.tool_engine.reset_for_turn(
                middleware_ctx=self.middleware_ctx,
                variables=self._execution_variables,
            )

            # Stage B: 上下文压缩
            if self.context_compressor is not None:
                try:
                    self.messages = await self.context_compressor.maybe_compress(self.messages, self.llm)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("上下文压缩失败: %s", exc)

            # 调 LLM（流式）
            try:
                async for event in self._call_llm_stream():
                    yield event
                response = self._streamed_response
            except Exception as exc:  # noqa: BLE001
                logger.exception("LLM 调用失败: %s", exc)
                yield make_event("error", message=f"LLM 调用失败: {exc}")
                return

            # 拦截响应
            content, tool_calls, thinking = self._parse_response(response)

            # 输出思考过程（如果有 <think> 块且流式未已输出）
            # 注：流式过程中已通过状态机分流 thinking 内容，
            # 但若模型将 think 内容放在 reasoning_content 而非 <think> 标签中，
            # _parse_response 仍可能提取到 thinking，此处补充输出。
            if thinking:
                yield make_event("thinking", content=thinking)

            # 追加 assistant 消息
            assistant_msg: dict = {"role": "assistant", "content": content or ""}
            if tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": tc.raw_arguments},
                    }
                    for tc in tool_calls
                ]
            self.messages.append(assistant_msg)

            # 无 tool_calls → 最终回答（token 已在流式过程中输出）
            if not tool_calls:

                # 同步记忆（Stage B 接入）
                if self.enable_memory and self.memory_manager is not None:
                    try:
                        await self.memory_manager.sync_all(
                            self.messages,
                            user_id=self.user.id,
                            agent_id=self.agent.id,
                            session_id=self.session_id,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("记忆同步失败: %s", exc)

                yield make_event("done", content=content or "", message="完成", usage=self._token_usage)
                return

            # 有 tool_calls → 执行
            yield make_event("status", message=f"正在执行 {len(tool_calls)} 个工具调用...")

            # 分离普通工具调用、技能触发、子代理委派、澄清问答、构建类工具
            normal_calls: list[ToolCall] = []
            skill_calls: list[ToolCall] = []
            delegate_calls: list[ToolCall] = []
            clarify_calls: list[ToolCall] = []
            builder_calls: list[ToolCall] = []
            from app.agent.hermes.builder import BUILDER_TOOL_NAMES

            for tc in tool_calls:
                if tc.name == "trigger_workflow_skill":
                    skill_calls.append(tc)
                elif tc.name == "list_workflow_skills":
                    # 直接返回技能列表，不走工具引擎
                    skills = self.skill_engine.list_workflow_skills()
                    self.messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "name": tc.name,
                        "content": str(skills),
                    })
                elif tc.name == "delegate_task":
                    # Stage C: 子代理委派（独立处理，递归构造子 executor）
                    delegate_calls.append(tc)
                elif tc.name == "clarify":
                    # 框架级工具：澄清问答，走专属处理（不走 tool_engine）
                    clarify_calls.append(tc)
                elif tc.name in BUILDER_TOOL_NAMES:
                    # 构建类框架工具：创建工具/技能/智能体（走受信任处理，不走沙箱）
                    builder_calls.append(tc)
                else:
                    normal_calls.append(tc)

            # 执行普通工具
            if normal_calls:
                async for event in self._execute_tools(normal_calls):
                    yield event

            # 执行技能触发
            for tc in skill_calls:
                async for event in self._handle_skill_call(tc):
                    yield event

            # 执行子代理委派（Stage C）
            for tc in delegate_calls:
                async for event in self._handle_delegate_call(tc):
                    yield event

            # 执行澄清问答（向用户提问，等待回答）
            for tc in clarify_calls:
                async for event in self._handle_clarify_call(tc):
                    yield event

            # 执行构建类框架工具（创建工具/技能/智能体）
            for tc in builder_calls:
                async for event in self._handle_builder_call(tc):
                    yield event

            # Stage B: guardrail halt 检查（工具循环严重，终止 turn 进 grace call）
            guard_ctrl = self.tool_engine.guardrail_controller
            if guard_ctrl is not None and guard_ctrl.halt_decision is not None:
                halt = guard_ctrl.halt_decision
                self._log("warning", f"工具循环硬停止: {halt.message}")
                yield make_event("status", message=f"工具循环硬停止: {halt.message}")
                break

        # 预算耗尽 → grace call
        self._log("info", "迭代预算耗尽，执行 grace call")
        async for event in self._grace_call():
            yield event

    async def _call_llm(self):
        """调用 LLM，返回响应（Stage B：中间件 + 错误分类重试）。

        流程：
        1. middleware before_llm_call（可改写 messages / 短路）
        2. 转换为 LangChain 消息
        3. ainvoke + error_classifier 分类重试（最多 3 次重试，指数退避）
        4. middleware after_llm_call（审计）
        """
        import asyncio as _asyncio

        from app.agent.hermes.middleware import LLMCallRequest, LLMCallResponse

        # Stage B: 中间件 before_llm_call（可能改写 messages 或短路，如 rate_limit）
        messages_to_send = self.messages
        if self.middleware_registry is not None and self.middleware_ctx is not None:
            llm_request = LLMCallRequest(
                messages=self.messages,
                tools=[],  # 工具 schema 已 bind 到 llm_with_tools，此处不重复
                model=str(getattr(self.agent, "model_config_id", "") or ""),
            )
            short_circuit = self.middleware_registry.invoke_before_llm_call(llm_request, self.middleware_ctx)
            if short_circuit is not None:
                # 短路（如 rate_limited）：抛异常由 _react_loop 捕获报错
                raise RuntimeError(f"LLM 调用被中间件短路: {short_circuit.reason}")
            # 中间件可能改写了 messages（RedactMiddleware 内部调 sanitize_messages 脱敏 + 消毒）
            messages_to_send = llm_request.messages

        # 转换为 LangChain 消息格式
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
            ToolMessage,
        )

        lc_messages = []
        for msg in messages_to_send:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                tc = msg.get("tool_calls")
                if tc:
                    # self.messages 中 tool_calls 为 OpenAI 格式：
                    #   {"id":..., "type":"function", "function":{"name":..., "arguments":"<json str>"}}
                    # LangChain AIMessage 期望的 tool_calls 格式：
                    #   {"id":..., "type":"tool_call", "name":..., "args":{...}}
                    # 直接传 OpenAI 格式会报 tool_call() got an unexpected keyword argument 'function'
                    import json as _json

                    lc_tc = []
                    for raw in tc:
                        if isinstance(raw, dict) and "function" in raw:
                            fn = raw["function"]
                            args_raw = fn.get("arguments", "{}")
                            if isinstance(args_raw, str):
                                try:
                                    args = _json.loads(args_raw) if args_raw else {}
                                except _json.JSONDecodeError:
                                    args = {}
                            else:
                                args = args_raw or {}
                            lc_tc.append({
                                "id": raw.get("id", ""),
                                "type": "tool_call",
                                "name": fn.get("name", ""),
                                "args": args,
                            })
                        else:
                            # 已是 LangChain 格式，原样保留
                            lc_tc.append(raw)
                    lc_messages.append(AIMessage(content=content, tool_calls=lc_tc))
                else:
                    lc_messages.append(AIMessage(content=content))
            elif role == "tool":
                lc_messages.append(ToolMessage(
                    content=content,
                    tool_call_id=msg.get("tool_call_id", ""),
                    name=msg.get("name", ""),
                ))

        # Stage B: 错误分类 + 重试
        from app.agent.hermes.error_classifier import classify_llm_error, should_retry_error
        from app.core.model_call_monitor import ModelCallTimer

        attempt = 0
        response = None
        while True:
            attempt += 1
            try:
                # 推理期间不持有数据库连接
                self._release_db_for_io()
                with ModelCallTimer(
                    model_config_id=self._model_meta.get("model_config_id"),
                    model_name=self._model_meta.get("model_name", ""),
                    provider=self._model_meta.get("provider", ""),
                    trigger_type="agent_test",
                    agent_id=getattr(self.agent, "id", None),
                ) as timer:
                    response = await self.llm_with_tools.ainvoke(lc_messages)
                    timer.set_response(response)
                break
            except Exception as exc:  # noqa: BLE001
                # 提取状态码 / 响应体（不同 SDK 异常结构不同）
                status_code = (
                    getattr(exc, "status_code", None)
                    or getattr(exc, "code", None)
                    or getattr(getattr(exc, "response", None), "status_code", None)
                )
                resp_body = getattr(exc, "response", None)
                resp_body_str = str(resp_body) if resp_body is not None else None
                classification = classify_llm_error(
                    exc, status_code=status_code, response_body=resp_body_str,
                )
                self._log(
                    "warning",
                    f"LLM 调用失败(尝试 {attempt}): type={classification.kind}, "
                    f"retry={classification.should_retry}, msg={classification.message}",
                )
                # context_length 错误：需压缩上下文（当前无 compressor，直接抛出）
                if classification.needs_context_compression:
                    raise RuntimeError(
                        f"LLM 上下文超长，需压缩上下文后重试: {classification.message}"
                    ) from exc
                if not should_retry_error(classification, attempt):
                    raise
                # 指数退避（尊重 retry-after）
                retry_after = classification.retry_after_s or (2.0 ** attempt)
                await _asyncio.sleep(min(retry_after, 30.0))

        # Stage B: 中间件 after_llm_call（审计记录）
        if self.middleware_registry is not None and self.middleware_ctx is not None:
            llm_response = LLMCallResponse(
                content=getattr(response, "content", "") or "",
                tool_calls=[],
                model=str(getattr(self.agent, "model_config_id", "") or ""),
            )
            self.middleware_registry.invoke_after_llm_call(llm_response, self.middleware_ctx)

        return response

    async def _call_llm_stream(self) -> AsyncIterator[SSEEventDict]:
        """流式调用 LLM，逐 token yield 事件。

        **优先使用原生 OpenAI async client 进行流式调用**，以支持 ``reasoning_content``
        字段（GLM-5.2 / DeepSeek-R1 等推理模型的思维链）。LangChain 0.2.0 的
        ``astream()`` 会丢弃 ``reasoning_content``，导致推理阶段（可能长达数十秒）
        无任何事件输出，用户感知为"卡住"。

        原生路径从 ``delta.reasoning_content`` 提取思维链 → ``thinking`` 事件，
        从 ``delta.content`` 提取正文 → ``token`` 事件（含 ``<think>`` 标签过滤）。
        非 OpenAI 兼容模型（如 Anthropic）回退到 LangChain ``astream()``。

        完成后设置 ``self._streamed_response``。

        重试策略：连接阶段（首个 chunk 前）失败可重试；流开始后不重试。

        Yields:
            ``token`` / ``thinking`` 事件
        """
        import asyncio as _asyncio
        import json as _json

        from app.agent.hermes.middleware import LLMCallRequest, LLMCallResponse
        from langchain_core.messages import AIMessage

        # 1. 中间件 before_llm_call（与 _call_llm 相同）
        messages_to_send = self.messages
        if self.middleware_registry is not None and self.middleware_ctx is not None:
            llm_request = LLMCallRequest(
                messages=self.messages,
                tools=[],
                model=str(getattr(self.agent, "model_config_id", "") or ""),
            )
            short_circuit = self.middleware_registry.invoke_before_llm_call(
                llm_request, self.middleware_ctx
            )
            if short_circuit is not None:
                raise RuntimeError(f"LLM 调用被中间件短路: {short_circuit.reason}")
            messages_to_send = llm_request.messages

        # 2. 准备 OpenAI 格式消息（self.messages 已是 OpenAI dict 格式）
        openai_messages: list[dict] = []
        for msg in messages_to_send:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            # 确保 content 是字符串（某些模型返回 list）
            if isinstance(content, list):
                content = _json.dumps(content, ensure_ascii=False)
            m: dict = {"role": role, "content": content or ""}
            if role == "assistant" and msg.get("tool_calls"):
                m["tool_calls"] = msg["tool_calls"]  # 已是 OpenAI 格式
            elif role == "tool":
                m["tool_call_id"] = msg.get("tool_call_id", "")
            openai_messages.append(m)

        # 3. 获取工具定义（bind_tools 存储在 kwargs["tools"]）
        bound_kwargs = getattr(self.llm_with_tools, "kwargs", {}) or {}
        tool_defs = bound_kwargs.get("tools")

        # 4. 流式调用 + 重试（仅连接阶段重试）
        from app.agent.hermes.error_classifier import classify_llm_error, should_retry_error
        from app.core.model_call_monitor import ModelCallTimer

        # 检查是否可用原生 OpenAI streaming（支持 reasoning_content）
        raw_async_client = getattr(self.llm, "async_client", None)
        use_raw_stream = raw_async_client is not None and hasattr(raw_async_client, "create")

        attempt = 0
        streaming_started = False

        # <think> 块过滤状态机（content 中可能内嵌 <think> 标签）
        THINK_OPEN = "<think>"
        THINK_CLOSE = "</think>"
        in_think_block = False
        tag_buffer = ""

        # 响应累积
        full_content = ""
        full_reasoning = ""
        tool_calls_acc: dict[int, dict] = {}  # index → {id, name, arguments}

        while True:
            attempt += 1
            try:
                self._release_db_for_io()
                with ModelCallTimer(
                    model_config_id=self._model_meta.get("model_config_id"),
                    model_name=self._model_meta.get("model_name", ""),
                    provider=self._model_meta.get("provider", ""),
                    trigger_type="agent_test",
                    agent_id=getattr(self.agent, "id", None),
                ) as timer:
                    if use_raw_stream:
                        # ===== 原生 OpenAI streaming（支持 reasoning_content） =====
                        api_kwargs: dict = {
                            "model": self.llm.model_name,
                            "messages": openai_messages,
                            "stream": True,
                        }
                        # 传递 temperature / max_tokens（None 时不传）
                        if self.llm.temperature is not None:
                            api_kwargs["temperature"] = self.llm.temperature
                        if self.llm.max_tokens is not None:
                            api_kwargs["max_tokens"] = self.llm.max_tokens
                        if tool_defs:
                            api_kwargs["tools"] = tool_defs
                        # 请求流式返回 token 用量（最后一个 chunk 包含 usage）
                        api_kwargs["stream_options"] = {"include_usage": True}

                        stream = await raw_async_client.create(**api_kwargs)
                        streaming_started = True

                        async for chunk in stream:
                            # 捕获 token 用量（include_usage=True 时最后一个 chunk 包含 usage）
                            chunk_usage = getattr(chunk, "usage", None)
                            if chunk_usage:
                                self._token_usage = {
                                    "input_tokens": getattr(chunk_usage, "prompt_tokens", 0) or 0,
                                    "output_tokens": getattr(chunk_usage, "completion_tokens", 0) or 0,
                                    "total_tokens": getattr(chunk_usage, "total_tokens", 0) or 0,
                                }
                            if not chunk.choices:
                                continue
                            delta = chunk.choices[0].delta

                            # ★ 提取 reasoning_content → thinking 事件
                            # GLM-5.2 / DeepSeek-R1 等推理模型将思维链放在此字段，
                            # 而非 content。LangChain 0.2.0 的 astream() 会丢弃它。
                            reasoning = getattr(delta, "reasoning_content", None) or ""
                            if reasoning:
                                full_reasoning += reasoning
                                self._thinking_chars += len(reasoning)
                                yield make_event("thinking", content=reasoning)

                            # 提取 content → token 事件（带 <think> 标签过滤）
                            token = delta.content or ""
                            if token:
                                full_content += token
                                tag_buffer += token
                                while tag_buffer:
                                    if not in_think_block:
                                        idx = tag_buffer.find(THINK_OPEN)
                                        if idx == -1:
                                            safe = len(tag_buffer) - (len(THINK_OPEN) - 1)
                                            if safe > 0:
                                                yield make_event("token", content=tag_buffer[:safe])
                                                tag_buffer = tag_buffer[safe:]
                                            else:
                                                break
                                        else:
                                            if idx > 0:
                                                yield make_event("token", content=tag_buffer[:idx])
                                            tag_buffer = tag_buffer[idx + len(THINK_OPEN):]
                                            in_think_block = True
                                    else:
                                        idx = tag_buffer.find(THINK_CLOSE)
                                        if idx == -1:
                                            safe = len(tag_buffer) - (len(THINK_CLOSE) - 1)
                                            if safe > 0:
                                                yield make_event("thinking", content=tag_buffer[:safe])
                                                tag_buffer = tag_buffer[safe:]
                                            else:
                                                break
                                        else:
                                            if idx > 0:
                                                yield make_event("thinking", content=tag_buffer[:idx])
                                            tag_buffer = tag_buffer[idx + len(THINK_CLOSE):]
                                            in_think_block = False

                            # 累积 tool_calls（OpenAI 流式分片发送）
                            if delta.tool_calls:
                                for tc in delta.tool_calls:
                                    idx = tc.index
                                    if idx not in tool_calls_acc:
                                        tool_calls_acc[idx] = {
                                            "id": tc.id or "",
                                            "name": "",
                                            "arguments": "",
                                        }
                                    if tc.function:
                                        if tc.function.name:
                                            tool_calls_acc[idx]["name"] = tc.function.name
                                        if tc.function.arguments:
                                            tool_calls_acc[idx]["arguments"] += tc.function.arguments

                        timer.set_response(AIMessage(content=full_content))
                    else:
                        # ===== LangChain astream() 回退（Anthropic 等非 OpenAI 模型） =====
                        from langchain_core.messages import (
                            AIMessageChunk,
                            HumanMessage,
                            SystemMessage,
                            ToolMessage,
                        )

                        lc_messages = []
                        for msg in messages_to_send:
                            role = msg.get("role", "user")
                            content = msg.get("content", "")
                            if role == "system":
                                lc_messages.append(SystemMessage(content=content))
                            elif role == "user":
                                lc_messages.append(HumanMessage(content=content))
                            elif role == "assistant":
                                tc = msg.get("tool_calls")
                                if tc:
                                    lc_tc = []
                                    for raw in tc:
                                        if isinstance(raw, dict) and "function" in raw:
                                            fn = raw["function"]
                                            args_raw = fn.get("arguments", "{}")
                                            if isinstance(args_raw, str):
                                                try:
                                                    args = _json.loads(args_raw) if args_raw else {}
                                                except _json.JSONDecodeError:
                                                    args = {}
                                            else:
                                                args = args_raw or {}
                                            lc_tc.append({
                                                "id": raw.get("id", ""),
                                                "type": "tool_call",
                                                "name": fn.get("name", ""),
                                                "args": args,
                                            })
                                        else:
                                            lc_tc.append(raw)
                                    lc_messages.append(AIMessage(content=content, tool_calls=lc_tc))
                                else:
                                    lc_messages.append(AIMessage(content=content))
                            elif role == "tool":
                                lc_messages.append(ToolMessage(
                                    content=content,
                                    tool_call_id=msg.get("tool_call_id", ""),
                                    name=msg.get("name", ""),
                                ))

                        full_chunk: AIMessageChunk | None = None
                        async for chunk in self.llm_with_tools.astream(lc_messages):
                            streaming_started = True
                            if full_chunk is None:
                                full_chunk = chunk
                            else:
                                full_chunk = full_chunk + chunk

                            token = getattr(chunk, "content", "") or ""
                            if not token:
                                continue

                            tag_buffer += token
                            while tag_buffer:
                                if not in_think_block:
                                    idx = tag_buffer.find(THINK_OPEN)
                                    if idx == -1:
                                        safe = len(tag_buffer) - (len(THINK_OPEN) - 1)
                                        if safe > 0:
                                            yield make_event("token", content=tag_buffer[:safe])
                                            tag_buffer = tag_buffer[safe:]
                                        else:
                                            break
                                    else:
                                        if idx > 0:
                                            yield make_event("token", content=tag_buffer[:idx])
                                        tag_buffer = tag_buffer[idx + len(THINK_OPEN):]
                                        in_think_block = True
                                else:
                                    idx = tag_buffer.find(THINK_CLOSE)
                                    if idx == -1:
                                        safe = len(tag_buffer) - (len(THINK_CLOSE) - 1)
                                        if safe > 0:
                                            yield make_event("thinking", content=tag_buffer[:safe])
                                            tag_buffer = tag_buffer[safe:]
                                        else:
                                            break
                                    else:
                                        if idx > 0:
                                            yield make_event("thinking", content=tag_buffer[:idx])
                                        tag_buffer = tag_buffer[idx + len(THINK_CLOSE):]
                                        in_think_block = False

                        if full_chunk is not None:
                            full_content = getattr(full_chunk, "content", "") or ""
                            raw_tool_calls = getattr(full_chunk, "tool_calls", None) or []
                            for i, tc in enumerate(raw_tool_calls):
                                tool_calls_acc[i] = {
                                    "id": tc.get("id", "") if isinstance(tc, dict) else getattr(tc, "id", ""),
                                    "name": tc.get("name", "") if isinstance(tc, dict) else getattr(tc, "name", ""),
                                    "arguments": _json.dumps(
                                        tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {}),
                                        ensure_ascii=False,
                                    ),
                                }
                            timer.set_response(full_chunk)
                break
            except Exception as exc:  # noqa: BLE001
                if streaming_started:
                    logger.exception("流式 LLM 调用中途失败: %s", exc)
                    raise
                # 连接阶段失败，尝试重试
                status_code = (
                    getattr(exc, "status_code", None)
                    or getattr(exc, "code", None)
                    or getattr(getattr(exc, "response", None), "status_code", None)
                )
                resp_body = getattr(exc, "response", None)
                resp_body_str = str(resp_body) if resp_body is not None else None
                classification = classify_llm_error(
                    exc, status_code=status_code, response_body=resp_body_str,
                )
                self._log(
                    "warning",
                    f"LLM 流式调用失败(尝试 {attempt}): type={classification.kind}, "
                    f"retry={classification.should_retry}, msg={classification.message}",
                )
                if classification.needs_context_compression:
                    raise RuntimeError(
                        f"LLM 上下文超长，需压缩上下文后重试: {classification.message}"
                    ) from exc
                if not should_retry_error(classification, attempt):
                    raise
                retry_after = classification.retry_after_s or (2.0 ** attempt)
                await _asyncio.sleep(min(retry_after, 30.0))

        # 输出缓冲区剩余内容
        if tag_buffer:
            if in_think_block:
                yield make_event("thinking", content=tag_buffer)
            else:
                yield make_event("token", content=tag_buffer)

        # 5. 构造完整 AIMessage
        # 将累积的 tool_calls 转为 LangChain 格式
        lc_tool_calls = []
        for idx in sorted(tool_calls_acc.keys()):
            tc = tool_calls_acc[idx]
            args_str = tc.get("arguments", "")
            try:
                args = _json.loads(args_str) if args_str else {}
            except _json.JSONDecodeError:
                args = {}
            lc_tool_calls.append({
                "id": tc.get("id", f"call_{idx}"),
                "type": "tool_call",
                "name": tc.get("name", ""),
                "args": args,
            })

        # 剥离 <think> 块后的正文（reasoning_content 已通过 thinking 事件输出，
        # 此处仅处理 content 中可能内嵌的 <think> 标签）
        from app.agent.hermes.think_scrubber import strip_think_blocks

        clean_content = strip_think_blocks(full_content)
        response = AIMessage(content=clean_content, tool_calls=lc_tool_calls)

        # 6. 中间件 after_llm_call（审计记录）
        if self.middleware_registry is not None and self.middleware_ctx is not None:
            llm_response = LLMCallResponse(
                content=clean_content,
                tool_calls=[],
                model=str(getattr(self.agent, "model_config_id", "") or ""),
            )
            self.middleware_registry.invoke_after_llm_call(llm_response, self.middleware_ctx)

        self._streamed_response = response

    def _parse_response(self, response) -> tuple[str, list[ToolCall], str]:
        """解析 LLM 响应，返回 (content, tool_calls, thinking)。

        Args:
            response: LangChain AIMessage

        Returns:
            (文本内容, ToolCall 列表, 思考过程文本)
            thinking 为 ``<think>...</think>`` 块内提取的内容，无思维块时为空串。
        """
        content = getattr(response, "content", "") or ""
        # 提取思维块内容（供前端展示思考过程），再做流式状态机清洗防破坏 JSON 解析
        from app.agent.hermes.think_scrubber import extract_think_blocks, strip_think_blocks

        thinking, content = extract_think_blocks(content)
        content = strip_think_blocks(content)
        raw_tool_calls = getattr(response, "tool_calls", None) or []

        tool_calls: list[ToolCall] = []
        for idx, tc in enumerate(raw_tool_calls):
            # LangChain ToolCall 格式：{"name": ..., "args": ..., "id": ...}
            if isinstance(tc, dict):
                name = tc.get("name", "")
                args = tc.get("args", {})
                tc_id = tc.get("id", f"call_{idx}")
                raw_args = tc.get("args", {})
            else:
                # pydantic 对象
                name = getattr(tc, "name", "")
                args = getattr(tc, "args", {})
                tc_id = getattr(tc, "id", f"call_{idx}")
                raw_args = args

            # 序列化 raw_arguments
            import json

            if isinstance(raw_args, str):
                raw_arguments = raw_args
            else:
                raw_arguments = json.dumps(raw_args, ensure_ascii=False, default=str)

            # 参数解析（含 JSON 容错）
            from app.agent.hermes.json_repair import parse_json_safely

            if isinstance(args, dict):
                parsed_args = args
                malformed = False
            elif isinstance(args, str):
                parsed_args, malformed = parse_json_safely(args)
            else:
                parsed_args = {}
                malformed = True

            tool_calls.append(ToolCall(
                original_index=idx,
                id=tc_id,
                name=name,
                arguments=parsed_args,
                malformed=malformed,
                raw_arguments=raw_arguments,
            ))

        return content, tool_calls, thinking

    async def _execute_tools(self, tool_calls: list[ToolCall]) -> AsyncIterator[SSEEventDict]:
        """执行工具调用并 yield 事件。"""
        # yield tool_start 事件
        for tc in tool_calls:
            yield make_event(
                "tool_start",
                tool_name=tc.name,
                tool_call_id=tc.id,
                args=tc.arguments,
                message=f"开始执行工具: {tc.name}",
            )

        # 执行
        results = await self.tool_engine.execute_tool_calls(tool_calls)

        # yield tool_end 事件 + 拼回消息
        import json

        turn_tool_messages: list[dict] = []
        for tc, result in zip(tool_calls, results):
            # 结果内容序列化（tool_engine._execute_one 已统一为 str，此处兜底）
            if isinstance(result.content, str):
                content_str = result.content
            else:
                content_str = json.dumps(result.content, ensure_ascii=False, default=str)

            yield make_event(
                "tool_end",
                tool_name=tc.name,
                tool_call_id=tc.id,
                result=result.content,
                message=f"工具 {tc.name} 完成" + ("（错误）" if result.is_error else ""),
            )

            # 工具生成的输出文件（如 expand_risk_detail 的展开表）：追加 file 事件，
            # 前端在消息气泡内渲染下载卡片
            if getattr(result, "generated_file", None):
                yield make_event("file", **result.generated_file)

            # 拼回 messages
            tool_msg = {
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.name,
                "content": content_str,
            }
            self.messages.append(tool_msg)
            turn_tool_messages.append(tool_msg)

        # Stage B: per-turn 聚合预算（Layer 3）—— 总量超预算则把最大结果持久化到 variables
        # enforce_turn_budget 原地修改 tool_msg["content"]（dict 同引用，self.messages 同步生效）
        if self.budget_config is not None and turn_tool_messages:
            from app.agent.hermes.budget import enforce_turn_budget

            enforce_turn_budget(
                turn_tool_messages,
                variables=self._execution_variables,
                config=self.budget_config,
            )

    async def _handle_builder_call(self, tc: ToolCall) -> AsyncIterator[SSEEventDict]:
        """处理构建类框架工具（创建工具/技能/智能体）。

        由受信任的 builder 模块执行（不走代码沙箱），创建的资源归属对话用户，
        工具代码存储前经 validate_tool_code 静态审查。
        """
        import json as _json

        from app.agent.hermes.builder import run_builder_tool

        yield make_event(
            "tool_start",
            tool_name=tc.name,
            tool_call_id=tc.id,
            args=tc.arguments,
            message=f"正在执行 {tc.name} ...",
        )
        content = ""
        try:
            result = await run_builder_tool(tc, self.db, self.user)
            content = _json.dumps(result, ensure_ascii=False, default=str)
            is_error = not result.get("ok", True)
        except Exception as exc:  # noqa: BLE001
            logger.exception("构建工具 %s 异常: %s", tc.name, exc)
            content = _json.dumps({"ok": False, "error": f"执行异常：{exc}"}, ensure_ascii=False)
            is_error = True
        yield make_event(
            "tool_end",
            tool_name=tc.name,
            tool_call_id=tc.id,
            result=content,
            message=f"工具 {tc.name} 完成" + ("（错误）" if is_error else ""),
        )
        self.messages.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "name": tc.name,
            "content": content,
        })

    async def _handle_skill_call(self, tc: ToolCall) -> AsyncIterator[SSEEventDict]:
        """处理 trigger_workflow_skill 工具调用。"""
        workflow_id = tc.arguments.get("workflow_id")
        payload = tc.arguments.get("input", {})
        resume_token = tc.arguments.get("resume_token")

        if workflow_id is None:
            self.messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.name,
                "content": '{"error": "missing workflow_id"}',
            })
            return

        try:
            if resume_token:
                # 恢复技能
                ctx = await self.skill_engine.resume_skill(resume_token, "approve")
            else:
                # 触发技能
                ctx = await self.skill_engine.trigger_skill(
                    workflow_id=int(workflow_id),
                    payload=payload if isinstance(payload, dict) else {},
                )

            # 根据状态 yield 事件
            if ctx.status == "interrupted":
                yield make_event(
                    "skill_interrupt",
                    skill={
                        "skill_run_id": ctx.skill_run_id,
                        "execution_id": ctx.execution_id,
                        "interrupt_node_id": ctx.interrupt_node_id,
                        "pending_approval": ctx.pending_approval,
                    },
                    message=f"技能中断等待审批: execution_id={ctx.execution_id}",
                )
                content = f'{{"status": "interrupted", "skill_run_id": "{ctx.skill_run_id}", "execution_id": {ctx.execution_id}, "message": "技能已中断，等待人工审批"}}'
            elif ctx.status == "completed":
                import json

                content = json.dumps(
                    {
                        "status": "completed",
                        "skill_run_id": ctx.skill_run_id,
                        "node_outputs": ctx.node_outputs,
                    },
                    ensure_ascii=False,
                    default=str,
                )
            else:
                import json

                content = json.dumps(
                    {"status": ctx.status, "skill_run_id": ctx.skill_run_id},
                    ensure_ascii=False,
                    default=str,
                )

            self.messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.name,
                "content": content,
            })

        except Exception as exc:  # noqa: BLE001
            logger.exception("技能调用异常: %s", exc)
            self.messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.name,
                "content": f'{{"error": "{exc}"}}',
            })

    async def _handle_clarify_call(self, tc: ToolCall) -> AsyncIterator[SSEEventDict]:
        """处理 clarify 工具调用（框架级工具：向用户提问）。

        在流式对话场景中，SSE 是单向的（服务端→客户端），无法等待用户实时回答。
        因此处理策略为：
        1. 发送 clarify 事件（前端可弹出输入框或展示问题）
        2. 将问题作为 tool result 返回给 LLM，告知"已向用户提问，请在下一轮对话中等待用户回答"
        3. LLM 收到后应输出问题文本并结束当前轮次，等待用户下一轮输入
        """
        import json

        question = tc.arguments.get("question", "")
        choices = tc.arguments.get("choices")

        # 发送 clarify 事件（前端可据此渲染提问 UI）
        yield make_event(
            "clarify",
            question=question,
            choices=choices,
            tool_call_id=tc.id,
        )

        # tool_start + tool_end 事件（保持与其他工具一致的事件序列）
        yield make_event(
            "tool_start",
            tool_name="clarify",
            tool_call_id=tc.id,
            args=tc.arguments,
            message="向用户提问",
        )

        result = json.dumps({
            "question": question,
            "choices": choices,
            "status": "已向用户提问，等待用户在下一轮对话中回答",
        }, ensure_ascii=False)

        yield make_event(
            "tool_end",
            tool_name="clarify",
            tool_call_id=tc.id,
            result=result,
            message="clarify 完成（等待用户回答）",
        )

        # 拼回 messages：告知 LLM 已提问，应输出问题并结束当前轮次
        self.messages.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "name": "clarify",
            "content": result,
        })

    async def _handle_delegate_call(self, tc: ToolCall) -> AsyncIterator[SSEEventDict]:
        """处理 delegate_task 工具调用（Stage C: 子代理委派）。

        流程：
        1. yield tool_start 事件
        2. 调用 Delegator.delegate() 递归构造子代理执行器
        3. 子代理事件以嵌套 ``delegate`` SSE 事件实时转发（含 subagent_id）
        4. 汇总结果作为 tool 消息回灌 self.messages
        5. yield tool_end 事件

        子代理拥有独立预算、隔离上下文、剥离的工具集（无 delegate_task/clarify/
        memory_write 等）。委派深度由 ContextVar 跟踪，超限时返回错误。
        """
        import json

        yield make_event(
            "tool_start",
            tool_name="delegate_task",
            tool_call_id=tc.id,
            args=tc.arguments,
            message="开始委派子代理...",
        )

        result_content = ""
        try:
            async for event in self.delegator.delegate(tc.arguments, parent_executor=self):
                if event.get("type") == "_result":
                    # 汇总结果（Delegator 最后 yield 的事件）
                    result_content = event.get("content", "")
                else:
                    # 嵌套子代理事件，以 delegate 类型转发
                    yield make_event("delegate", result=event)
        except Exception as exc:  # noqa: BLE001
            logger.exception("子代理委派异常: %s", exc)
            result_content = json.dumps(
                {"error": f"委派执行异常: {exc}"}, ensure_ascii=False,
            )
            yield make_event("error", message=f"委派执行异常: {exc}")

        # 结果回灌为 tool 消息（供 LLM 下一步推理）
        self.messages.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "name": "delegate_task",
            "content": result_content,
        })

        yield make_event(
            "tool_end",
            tool_name="delegate_task",
            tool_call_id=tc.id,
            result=result_content,
            message="子代理委派完成",
        )

    async def _grace_call(self) -> AsyncIterator[SSEEventDict]:
        """预算耗尽时的一次 grace call：注入提示让 LLM 给出最终答案（流式）。"""
        self.messages.append({
            "role": "system",
            "content": "已达到最大迭代次数。请基于已收集的信息，直接给出最终回答，不要再调用工具。",
        })

        try:
            from app.core.model_call_monitor import ModelCallTimer

            # <think> 块过滤状态机
            THINK_OPEN = "<think>"
            THINK_CLOSE = "</think>"
            in_think_block = False
            tag_buffer = ""
            full_content = ""

            with ModelCallTimer(
                model_config_id=self._model_meta.get("model_config_id"),
                model_name=self._model_meta.get("model_name", ""),
                provider=self._model_meta.get("provider", ""),
                trigger_type="agent_test",
                agent_id=getattr(self.agent, "id", None),
            ) as timer:
                from langchain_core.messages import AIMessageChunk

                full_chunk: AIMessageChunk | None = None
                async for chunk in self.llm_with_tools.astream(
                    self._to_langchain_messages(self.messages)
                ):
                    if full_chunk is None:
                        full_chunk = chunk
                    else:
                        full_chunk = full_chunk + chunk

                    token = getattr(chunk, "content", "") or ""
                    if not token:
                        continue
                    full_content += token

                    # <think> 块过滤
                    tag_buffer += token
                    while tag_buffer:
                        if not in_think_block:
                            idx = tag_buffer.find(THINK_OPEN)
                            if idx == -1:
                                safe = len(tag_buffer) - (len(THINK_OPEN) - 1)
                                if safe > 0:
                                    yield make_event("token", content=tag_buffer[:safe])
                                    tag_buffer = tag_buffer[safe:]
                                else:
                                    break
                            else:
                                if idx > 0:
                                    yield make_event("token", content=tag_buffer[:idx])
                                tag_buffer = tag_buffer[idx + len(THINK_OPEN):]
                                in_think_block = True
                        else:
                            idx = tag_buffer.find(THINK_CLOSE)
                            if idx == -1:
                                safe = len(tag_buffer) - (len(THINK_CLOSE) - 1)
                                if safe > 0:
                                    yield make_event("thinking", content=tag_buffer[:safe])
                                    tag_buffer = tag_buffer[safe:]
                                else:
                                    break
                            else:
                                if idx > 0:
                                    yield make_event("thinking", content=tag_buffer[:idx])
                                tag_buffer = tag_buffer[idx + len(THINK_CLOSE):]
                                in_think_block = False

                if full_chunk is not None:
                    timer.set_response(full_chunk)

            # 输出缓冲区剩余内容
            if tag_buffer:
                if in_think_block:
                    yield make_event("thinking", content=tag_buffer)
                else:
                    yield make_event("token", content=tag_buffer)

            # 清洗思维块后的最终内容
            from app.agent.hermes.think_scrubber import strip_think_blocks
            clean_content = strip_think_blocks(full_content)
            yield make_event("done", content=clean_content, message="完成（已达迭代上限）", usage=self._token_usage)
        except Exception as exc:  # noqa: BLE001
            logger.exception("grace call 失败: %s", exc)
            yield make_event("error", message=f"grace call 失败: {exc}")

    @staticmethod
    def _to_langchain_messages(messages: list[dict]):
        """转换为 LangChain 消息格式（不带 tool_calls 的简化版）。"""
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
            ToolMessage,
        )

        lc_messages = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))
            elif role == "tool":
                lc_messages.append(ToolMessage(
                    content=content,
                    tool_call_id=msg.get("tool_call_id", ""),
                    name=msg.get("name", ""),
                ))
        return lc_messages
