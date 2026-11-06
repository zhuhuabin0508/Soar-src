"""Agent 运行时统一入口（invoke_agent / invoke_agent_sse）。"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, AsyncIterator, Optional

from sqlalchemy.orm import Session

from app.agent.prompt_assembler import assemble_system_prompt
from app.models.agent import Agent
from app.workflow.agent_client import REQUIRED_FIELDS as BAN_RISK_REQUIRED_FIELDS

logger = logging.getLogger(__name__)

OUTPUT_MODE_CHAT = "chat"
OUTPUT_MODE_SOC_DECISION = "soc_decision"
OUTPUT_MODE_BAN_RISK_ANALYZE = "ban_risk_analyze"


@dataclass
class RunContext:
    agent_id: int
    engine: str
    channel: str
    output_mode: str
    user_id: Optional[int] = None
    stream: bool = False


@dataclass
class AgentInvokeResult:
    response: str = ""
    messages: list = field(default_factory=list)
    logs: list = field(default_factory=list)
    decision: Optional[dict] = None
    raw: Optional[dict] = None


def resolve_runtime_user(db: Session):
    from app.config import settings
    from app.models.user import User

    uid = int(getattr(settings, "WORKFLOW_SYSTEM_USER_ID", 0) or 0)
    if uid > 0:
        try:
            user = db.query(User).filter(User.id == uid).first()
            if user is not None:
                return user
        except Exception:  # noqa: BLE001
            pass
    return SimpleNamespace(id=0, username="runtime-system")


def resolve_output_mode(agent: Agent) -> str:
    raw = (getattr(agent, "output_mode", None) or OUTPUT_MODE_CHAT).strip()
    if raw in (OUTPUT_MODE_CHAT, OUTPUT_MODE_SOC_DECISION, OUTPUT_MODE_BAN_RISK_ANALYZE):
        return raw
    return OUTPUT_MODE_CHAT


def agent_uses_soc_decision(agent: Agent) -> bool:
    return resolve_output_mode(agent) == OUTPUT_MODE_SOC_DECISION


def workflow_result_from_invoke(result: AgentInvokeResult, *, output_mode: str) -> dict:
    decision = result.decision or {}
    if output_mode == OUTPUT_MODE_SOC_DECISION and decision:
        response = result.response or decision.get("reason") or decision.get("decision") or ""
        return {
            "response": response,
            "decision": decision.get("decision"),
            "target_ip": decision.get("target_ip"),
            "reason": decision.get("reason"),
            "duration": decision.get("duration"),
            "messages": result.messages,
            "logs": (result.raw or {}).get("logs") or [],
        }
    if output_mode == OUTPUT_MODE_BAN_RISK_ANALYZE and decision:
        return {
            "response": result.response,
            "messages": result.messages,
            "logs": [],
            **decision,
        }
    return {
        "response": result.response,
        "messages": result.messages,
        "logs": [],
    }


async def invoke_agent_for_workflow(
    db: Session,
    agent: Agent,
    user_message: str,
    input_data: dict,
    *,
    channel: str = "workflow",
    session_key: str | None = None,
    override=None,
) -> dict:
    output_mode = resolve_output_mode(agent)
    if output_mode == OUTPUT_MODE_SOC_DECISION:
        alert_data = dict(input_data) if isinstance(input_data, dict) else {"input": input_data}
        if isinstance(input_data, str):
            try:
                parsed = json.loads(input_data)
                if isinstance(parsed, dict):
                    alert_data = parsed
            except (json.JSONDecodeError, TypeError):
                alert_data = {"input": user_message, **(alert_data if isinstance(alert_data, dict) else {})}
        if "input" not in alert_data and user_message:
            alert_data.setdefault("input", user_message)
        invoke_input = alert_data
    elif output_mode == OUTPUT_MODE_BAN_RISK_ANALYZE:
        alert_data = dict(input_data) if isinstance(input_data, dict) else {"input": input_data}
        invoke_input = alert_data
    else:
        invoke_input = user_message
        output_mode = OUTPUT_MODE_CHAT
    session_id = session_key or f"wf_agent_{agent.id}"
    result = await invoke_agent(
        db=db,
        agent=agent,
        input=invoke_input,
        user=resolve_runtime_user(db),
        channel=channel,
        output_mode=output_mode,
        session_id=session_id,
        override=override,
    )
    return workflow_result_from_invoke(result, output_mode=output_mode)


def resolve_engine(agent: Agent) -> str:
    # 平台唯一推理引擎为 Hermes；engine 列仅作兼容，异常值统一按 Hermes 路由
    raw = (getattr(agent, "engine", None) or "hermes").lower()
    if raw != "hermes":
        logger.warning(
            "agent_id=%s engine=%s 非受支持引擎，已路由到 hermes",
            agent.id,
            raw,
        )
    return "hermes"


def adapt_soc_decision(content: str, src_ip: str = "unknown") -> dict:
    from app.agent.output_adapt import _parse_action_decision_from_content

    return _parse_action_decision_from_content(content, src_ip)


def sanitize_override(override, *, channel: str):
    if override is None or channel == "test":
        return override
    for name in ("system_prompt", "model_config_id"):
        if getattr(override, name, None) is not None:
            setattr(override, name, None)
            logger.info("正式对话忽略覆盖字段: %s", name)
    return override


def adapt_ban_risk_analyze(content: str) -> dict:
    from app.agent.output_adapt import _extract_json_object
    from app.workflow.agent_client import AgentCallError

    candidate = _extract_json_object(content)
    if candidate is None:
        candidate = (content or "").strip()
    if not candidate:
        raise AgentCallError("响应为空，无法解析 ban_risk_analyze JSON")
    try:
        data = json.loads(candidate)
    except (json.JSONDecodeError, TypeError) as exc:
        # 附实际输出片段便于定位智能体输出不符合契约的问题
        snippet = candidate if len(candidate) <= 120 else f"{candidate[:120]}…"
        raise AgentCallError(
            f"响应 JSON 解析失败: {exc}（输出前120字符: {snippet!r}）"
        ) from exc
    if not isinstance(data, dict):
        raise AgentCallError("响应不是 JSON 对象")
    missing = [f for f in BAN_RISK_REQUIRED_FIELDS if f not in data]
    if missing:
        raise AgentCallError(f"响应缺少必填字段: {', '.join(missing)}")
    return data


def _log_invoke(ctx: RunContext) -> None:
    logger.info(
        "invoke_agent agent_id=%s engine=%s channel=%s output_mode=%s stream=%s user_id=%s",
        ctx.agent_id,
        ctx.engine,
        ctx.channel,
        ctx.output_mode,
        ctx.stream,
        ctx.user_id,
    )


def _load_agent(db: Session, agent_id: int | None, agent: Agent | None) -> Agent:
    if agent is not None:
        return agent
    if agent_id is None:
        raise ValueError("agent_id or agent is required")
    row = db.query(Agent).filter(Agent.id == agent_id).first()
    if row is None:
        raise ValueError(f"Agent not found: {agent_id}")
    return row


def _normalize_user(user):
    if user is not None:
        return user
    return SimpleNamespace(id=0, username="runtime-system")


def _parse_input(input_data: str | dict) -> tuple[str, dict]:
    if isinstance(input_data, dict):
        return json.dumps(input_data, ensure_ascii=False), input_data
    text = input_data or ""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return text, parsed
    except (json.JSONDecodeError, TypeError):
        pass
    return text, {"input": text}


def _resolve_system_prompt(
    db: Session,
    agent: Agent,
    override,
    *,
    for_decision: bool = False,
) -> str | None:
    if override is not None and getattr(override, "system_prompt", None) is not None:
        # 自定义 system_prompt 也不能绕过当前时间块（与常规组装路径保持一致）
        from app.agent.prompt_assembler import _append_time_block

        return _append_time_block(override.system_prompt)
    if for_decision:
        return assemble_system_prompt(db, agent, allow_none=True)
    return assemble_system_prompt(
        db,
        agent,
        fallback_prompt="你是一个智能助手，请根据用户输入给出有帮助的回答。",
    )


def build_hermes_executor(
    db: Session,
    agent: Agent,
    user,
    *,
    override=None,
    system_prompt: str | None = None,
):
    from app.agent.hermes import HermesAgentExecutor

    if system_prompt is None:
        system_prompt = _resolve_system_prompt(db, agent, override)
    return HermesAgentExecutor(
        db=db,
        agent=agent,
        user=_normalize_user(user),
        override=override,
        system_prompt=system_prompt,
    )


async def _collect_hermes_text(executor, user_message: str, session_id: str) -> str:
    final_text = ""
    async for event in executor.run(user_message, session_id=session_id):
        etype = event.get("type") if isinstance(event, dict) else getattr(event, "type", None)
        if etype == "done":
            final_text = (
                event.get("content", "")
                if isinstance(event, dict)
                else getattr(event, "content", "")
            ) or final_text
        elif etype == "error":
            msg = (
                event.get("message", "hermes error")
                if isinstance(event, dict)
                else getattr(event, "message", "hermes error")
            )
            raise RuntimeError(msg)
    return final_text


async def invoke_agent(
    *,
    db: Session,
    agent_id: int | None = None,
    agent: Agent | None = None,
    input: str | dict,
    user,
    channel: str = "api",
    stream: bool = False,
    output_mode: str = OUTPUT_MODE_CHAT,
    override=None,
    session_id: str = "default",
    history: list[dict] | None = None,
) -> AgentInvokeResult:
    if stream:
        raise ValueError("stream=True 请使用 invoke_agent_sse()")

    agent = _load_agent(db, agent_id, agent)
    engine = resolve_engine(agent)
    user = _normalize_user(user)
    user_id = getattr(user, "id", None)

    ctx = RunContext(
        agent_id=agent.id,
        engine=engine,
        channel=channel,
        output_mode=output_mode,
        user_id=user_id,
        stream=False,
    )
    _log_invoke(ctx)

    user_message, payload = _parse_input(input)
    for_decision = output_mode in (OUTPUT_MODE_SOC_DECISION, OUTPUT_MODE_BAN_RISK_ANALYZE)
    system_prompt = _resolve_system_prompt(db, agent, override, for_decision=for_decision)
    executor = build_hermes_executor(
        db, agent, user, override=override, system_prompt=system_prompt
    )
    if history:
        executor.load_history(history)

    final_text = await _collect_hermes_text(executor, user_message, session_id)
    new_messages = executor.get_new_messages()

    if output_mode == OUTPUT_MODE_SOC_DECISION:
        src_ip = (
            payload.get("src_ip")
            or payload.get("ip")
            or payload.get("target_ip")
            or "unknown"
        )
        decision = adapt_soc_decision(final_text, str(src_ip))
        return AgentInvokeResult(
            response=final_text,
            messages=new_messages,
            decision=decision,
            raw={**decision, "messages": new_messages, "logs": []},
        )

    if output_mode == OUTPUT_MODE_BAN_RISK_ANALYZE:
        decision = adapt_ban_risk_analyze(final_text)
        return AgentInvokeResult(
            response=final_text,
            messages=new_messages,
            decision=decision,
            raw=decision,
        )

    return AgentInvokeResult(
        response=final_text,
        messages=new_messages,
        raw={"response": final_text, "messages": new_messages},
    )


async def invoke_agent_sse(
    *,
    db: Session,
    agent_id: int | None = None,
    agent: Agent | None = None,
    input: str | dict,
    user,
    channel: str = "api",
    override=None,
    session_id: str = "default",
    history: list[dict] | None = None,
    executor_holder: list | None = None,
) -> AsyncIterator[str]:
    agent = _load_agent(db, agent_id, agent)
    engine = resolve_engine(agent)
    user = _normalize_user(user)
    user_id = getattr(user, "id", None)

    ctx = RunContext(
        agent_id=agent.id,
        engine=engine,
        channel=channel,
        output_mode=OUTPUT_MODE_CHAT,
        user_id=user_id,
        stream=True,
    )
    _log_invoke(ctx)

    user_message, _payload = _parse_input(input)
    system_prompt = _resolve_system_prompt(db, agent, override)
    executor = build_hermes_executor(
        db, agent, user, override=override, system_prompt=system_prompt
    )
    if history:
        executor.load_history(history)
    if executor_holder is not None:
        executor_holder.append(executor)

    from app.agent.hermes.sse import sse_stream

    async for chunk in sse_stream(executor, user_message, session_id=session_id):
        yield chunk
