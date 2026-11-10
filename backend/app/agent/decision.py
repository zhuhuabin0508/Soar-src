"""SOC 决策解析、Mock 降级与遗留 ``run_agent_decision`` 转发。

新调用请使用 ``app.platform.agent_runtime.invoke_agent`` / ``invoke_agent_sse``。
本模块保留 ``_parse_action_decision_from_content``、工具构建与 ``run_agent_decision``（已废弃，转发 runtime）。
"""
import json
import logging
from typing import Any, AsyncGenerator, Optional

from pydantic import BaseModel, Field, create_model

from app.agent.output_adapt import (
    _DEFAULT_BLOCK_DURATION,
    _extract_json_object,
    _parse_action_decision_from_content,
)
from app.agent.tool_builders import (
    _build_args_model,
    _build_asset_tool,
    _build_db_tools,
    _build_file_query_tool,
    _build_kb_tool,
    execute_search_assets,
)
from app.config import settings
from app.tools.context_tools import (
    check_subnet,
    check_whitelist,
    get_asset_info,
    get_threat_intel,
)

logger = logging.getLogger(__name__)


def _extract_generated_file(tool_output) -> Optional[dict]:
    """从工具输出中提取生成的文件信息（供前端在消息气泡内渲染下载卡片）。

    兼容两种输出形状：``run()`` 直接返回的 ``{"output_file": ...}``，
    或经 ``run_tool`` 包装的 ``{"result": {"output_file": ...}}``。

    Returns:
        ``{"file_id", "file_name", "rows", "columns"}``；无输出文件时返回 None。
    """
    if not tool_output:
        return None
    data = tool_output if isinstance(tool_output, dict) else None
    if not data:
        return None
    # generate_document / append_document 直接返回 {ok, file_id, file_name, ...}，
    # 识别该形状让前端在消息气泡内渲染下载卡片
    if data.get("ok") and data.get("file_id"):
        return {
            "file_id": data["file_id"],
            "file_name": data.get("file_name") or "",
        }
    inner = data.get("result")
    if isinstance(inner, dict) and inner.get("output_file"):
        data = inner
    out_name = data.get("output_file")
    if not out_name:
        return None
    out_name = str(out_name)
    # 查上传库获取 file_id（工具保存输出时会注册 AgentFile）
    from app.database import SessionLocal
    from app.models.agent_file import AgentFile

    db = SessionLocal()
    try:
        rec = db.query(AgentFile).filter(AgentFile.original_name == out_name).first()
        file_id = rec.id if rec else None
    finally:
        db.close()
    if not file_id:
        return None
    info: dict = {"file_id": file_id, "file_name": out_name}
    if data.get("rows") is not None:
        info["rows"] = data.get("rows")
    if data.get("columns") is not None:
        info["columns"] = data.get("columns")
    return info


def _new_log(level: str, message: str) -> dict[str, str]:
    """构造一条日志记录。"""
    return {"level": level, "message": message}


def _load_llm_config(db, model_config_id: Optional[int]):
    """按优先级加载 LLM 配置：指定 id > is_default > None。"""
    from app.models.llm_config import LLMConfig

    if model_config_id is not None:
        cfg = db.query(LLMConfig).filter(LLMConfig.id == model_config_id).first()
        if cfg is not None:
            logger.info("使用指定 LLMConfig: id=%s, name=%s", cfg.id, cfg.name)
            return cfg
        logger.warning("指定 LLMConfig 不存在: id=%s", model_config_id)
    # 取默认配置
    cfg = db.query(LLMConfig).filter(LLMConfig.is_default.is_(True)).first()
    if cfg is not None:
        logger.info("使用默认 LLMConfig: id=%s, name=%s", cfg.id, cfg.name)
        return cfg
    logger.info("未找到 DB LLMConfig，将尝试环境变量 ANTHROPIC_API_KEY")
    return None




async def _mock_decision(alert_data: dict, logs: list[dict[str, str]]) -> dict:
    """规则化 Mock 决策路径。

    直接调用 4 个上下文工具查询源 IP，并基于规则生成决策。
    无需 LLM 与 API Key，适用于开发与测试环境。

    Args:
        alert_data: 告警数据，含 src_ip / dest_ip / alert_type。
        logs: 日志收集列表（会被追加）。

    Returns:
        与真实路径结构一致的决策结果（含 ``logs`` 字段）。
    """
    src_ip = alert_data.get("src_ip", "unknown")
    logs.append(_new_log("info", f"[Mock] 启动规则化决策, src_ip={src_ip}"))
    logger.info("[Mock] 启动规则化决策, src_ip=%s, alert_data=%s", src_ip, alert_data)

    messages: list = []

    # 1. 查询白名单
    messages.append({"role": "assistant", "content": f"正在查询 src_ip={src_ip} 的白名单..."})
    logs.append(_new_log("info", f"查询白名单, ip={src_ip}"))
    whitelist_hit = await check_whitelist(src_ip)
    in_whitelist = (
        whitelist_hit.get("in_whitelist")
        if isinstance(whitelist_hit, dict)
        else bool(whitelist_hit)
    )
    messages.append({"role": "tool", "content": f"check_whitelist={json.dumps(whitelist_hit, ensure_ascii=False)}"})

    # 2. 查询资产信息
    messages.append({"role": "assistant", "content": f"正在查询 src_ip={src_ip} 的资产信息..."})
    logs.append(_new_log("info", f"查询资产信息, ip={src_ip}"))
    asset_info = await get_asset_info(src_ip)
    messages.append({"role": "tool", "content": f"get_asset_info={json.dumps(asset_info, ensure_ascii=False)}"})

    # 3. 查询威胁情报
    messages.append({"role": "assistant", "content": f"正在查询 src_ip={src_ip} 的威胁情报..."})
    logs.append(_new_log("info", f"查询威胁情报, ip={src_ip}"))
    threat_intel = await get_threat_intel(src_ip)
    messages.append({"role": "tool", "content": f"get_threat_intel={json.dumps(threat_intel, ensure_ascii=False)}"})

    # 4. 查询子网信息
    messages.append({"role": "assistant", "content": f"正在查询 src_ip={src_ip} 的子网信息..."})
    logs.append(_new_log("info", f"查询子网信息, ip={src_ip}"))
    subnet_info = await check_subnet(src_ip)
    messages.append({"role": "tool", "content": f"check_subnet={json.dumps(subnet_info, ensure_ascii=False)}"})

    # 5. 基于规则生成决策
    is_malicious = bool(threat_intel.get("is_malicious"))
    is_critical = bool(asset_info.get("is_critical"))
    tags = threat_intel.get("tags", [])

    if in_whitelist:
        decision = "ignore"
        reason = f"IP {src_ip} 在白名单中，判定为可信内网，无需处置"
        duration = ""
    elif is_malicious and is_critical:
        decision = "need_human_approval"
        reason = f"IP {src_ip} 命中威胁情报（tags={tags}）且为关键资产，需人工确认后处置"
        duration = _DEFAULT_BLOCK_DURATION
    elif is_malicious:
        decision = "block_ip"
        reason = f"威胁情报标记为恶意: {tags}，建议封禁"
        duration = _DEFAULT_BLOCK_DURATION
    else:
        decision = "ignore"
        reason = f"IP {src_ip} 未命中威胁情报，判定为非恶意，无需处置"
        duration = ""

    logs.append(_new_log("info", f"决策完成: {decision}, reason={reason}"))
    action_decision = {
        "decision": decision,
        "target_ip": src_ip,
        "reason": reason,
        "duration": duration,
    }
    messages.append({"role": "assistant", "content": json.dumps(action_decision, ensure_ascii=False)})

    logger.info("[Mock] 决策完成, action_decision=%s", action_decision)
    return {**action_decision, "messages": messages, "logs": logs}




async def _run_agent_decision_via_runtime(
    *,
    db,
    agent_id: int,
    alert_data: dict,
    system_prompt: Optional[str] = None,
    override=None,
    logs: Optional[list] = None,
) -> dict:
    from app.models.agent import Agent
    from app.platform.agent_runtime import (
        OUTPUT_MODE_CHAT,
        invoke_agent,
        resolve_output_mode,
        resolve_runtime_user,
    )

    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        out_logs = list(logs or [])
        out_logs.append(_new_log("error", f"Agent not found: {agent_id}"))
        return await _mock_decision(alert_data, out_logs)

    output_mode = resolve_output_mode(agent)
    result = await invoke_agent(
        db=db,
        agent=agent,
        input=alert_data,
        user=resolve_runtime_user(db),
        channel="decision",
        output_mode=output_mode,
        override=override,
    )
    out_logs = list(logs or [])
    if output_mode == OUTPUT_MODE_CHAT:
        return {
            "response": result.response,
            "messages": result.messages,
            "logs": out_logs,
        }
    raw = dict(result.raw or {})
    raw["messages"] = result.messages
    raw["logs"] = out_logs + list(raw.get("logs") or [])
    return raw


async def run_agent_decision(
    alert_data: dict,
    enabled_tools: Optional[list[str]] = None,
    enabled_kbs: Optional[list[int]] = None,
    enabled_asset_types: Optional[list[str]] = None,
    enabled_workflows: Optional[list[int]] = None,
    agent_id: Optional[int] = None,
    model_config_id: Optional[int] = None,
    system_prompt: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    max_iterations: Optional[int] = None,
    model_name: Optional[str] = None,
) -> dict:
    """Agent 决策入口。

    按优先级确定 LLM 配置：``model_config_id`` > DB 默认 LLMConfig > 环境变量
    配置可用且指定 ``agent_id`` / ``WORKFLOW_SOC_AGENT_ID`` 时走 ``invoke_agent``；
    开发模式 ``ENABLE_DEV_CODE`` 可 Mock；否则返回 ``need_human_approval``。

    Args:
        alert_data: 告警数据。
        enabled_tools: 启用的 DB 工具名称列表（可选）。
        enabled_kbs: 启用的知识库 id 列表（可选，非空则追加知识库检索工具）。
        model_config_id: 指定 LLMConfig id（可选）。
        system_prompt: 自定义系统提示词（可选）。
        temperature: 采样温度（可选）。
        max_tokens: 最大 token 数（可选）。
        max_iterations: 最大迭代轮数（可选）。
        model_name: 显式指定模型名（可选，传入时优先于 LLMConfig.model_name）。

    Returns:
        决策结果::

            {
                "decision": "block_ip" | "ignore" | "need_human_approval",
                "target_ip": "8.8.8.8",
                "reason": "...",
                "duration": "24h",
                "messages": [{"role", "content"}, ...],
                "logs": [{"level", "message"}, ...]
            }
    """
    import warnings

    warnings.warn(
        "run_agent_decision is deprecated; use invoke_agent",
        DeprecationWarning,
        stacklevel=2,
    )
    logger.info("=" * 60)
    logger.info("收到告警决策请求, alert_data=%s", alert_data)
    logs: list[dict[str, str]] = []

    if agent_id is None:
        from app.config import settings

        fallback_agent = int(getattr(settings, "WORKFLOW_SOC_AGENT_ID", 0) or 0)
        if fallback_agent > 0:
            agent_id = fallback_agent

    if agent_id is not None:
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            override = None
            if any(
                v is not None
                for v in (system_prompt, temperature, max_tokens, max_iterations, model_config_id, model_name)
            ):
                from types import SimpleNamespace

                override = SimpleNamespace(
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    max_iterations=max_iterations,
                    model_config_id=model_config_id,
                    model_name=model_name,
                )
            return await _run_agent_decision_via_runtime(
                db=db,
                agent_id=agent_id,
                alert_data=alert_data,
                system_prompt=system_prompt,
                override=override,
                logs=logs,
            )
        finally:
            db.close()

    from app.config import settings

    if getattr(settings, "ENABLE_DEV_CODE", False):
        logs.append(_new_log("info", "未配置 Agent，开发模式 Mock 降级"))
        return await _mock_decision(alert_data, logs)

    src_ip = alert_data.get("src_ip", "unknown")
    logs.append(
        _new_log(
            "error",
            "未配置 agent_id 或 WORKFLOW_SOC_AGENT_ID",
        )
    )
    return {
        "decision": "need_human_approval",
        "target_ip": src_ip,
        "reason": "未配置 WORKFLOW_SOC_AGENT_ID 或 agent_id",
        "duration": "24h",
        "messages": [],
        "logs": logs,
    }


async def run_agent_decision_stream(
    alert_data: dict,
    enabled_tools: Optional[list[str]] = None,
    enabled_kbs: Optional[list[int]] = None,
    enabled_asset_types: Optional[list[str]] = None,
    enabled_workflows: Optional[list[int]] = None,
    agent_id: Optional[int] = None,
    model_config_id: Optional[int] = None,
    system_prompt: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    max_iterations: Optional[int] = None,
    model_name: Optional[str] = None,
    extra_llm_kwargs: Optional[dict] = None,
) -> AsyncGenerator[dict, None]:
    """流式版 Agent 决策，异步生成 SSE 事件。

    已废弃；请使用 ``invoke_agent_sse``。
    实现 token 级流式输出，让前端逐字渲染 LLM 回复。

    Yields:
        事件 dict，``type`` 为以下之一：
        - ``status``: 进度状态消息
        - ``token``: LLM 输出的 token（``content`` 字段）
        - ``tool_start`` / ``tool_end``: 工具调用开始/结束
        - ``log``: 执行日志
        - ``done``: 最终结果（``result`` 字段）
        - ``error``: 错误（``message`` 字段）
    """
    import warnings

    warnings.warn(
        "run_agent_decision_stream is deprecated; use invoke_agent_sse",
        DeprecationWarning,
        stacklevel=2,
    )
    logger.info("=" * 60)
    logger.info("收到流式告警决策请求, alert_data=%s", alert_data)

    if agent_id is None:
        from app.config import settings as _settings

        fallback_agent = int(getattr(_settings, "WORKFLOW_SOC_AGENT_ID", 0) or 0)
        if fallback_agent > 0:
            agent_id = fallback_agent

    if agent_id is not None:
        from app.database import SessionLocal
        from app.models.agent import Agent
        from app.platform.agent_runtime import invoke_agent_sse, resolve_runtime_user

        db = SessionLocal()
        try:
            agent = db.query(Agent).filter(Agent.id == agent_id).first()
            if agent is None:
                yield {"type": "error", "message": f"Agent not found: {agent_id}"}
                return
            override = None
            if any(
                v is not None
                for v in (system_prompt, temperature, max_tokens, max_iterations, model_config_id, model_name)
            ):
                from types import SimpleNamespace

                override = SimpleNamespace(
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    max_iterations=max_iterations,
                    model_config_id=model_config_id,
                    model_name=model_name,
                )
            user_input = json.dumps(alert_data, ensure_ascii=False)
            async for chunk in invoke_agent_sse(
                db=db,
                agent=agent,
                input=user_input,
                user=resolve_runtime_user(db),
                channel="decision",
                override=override,
            ):
                if not chunk.startswith("data: "):
                    continue
                try:
                    data = json.loads(chunk[6:].strip())
                except (json.JSONDecodeError, ValueError):
                    continue
                yield data
        finally:
            db.close()
        return

    from app.config import settings as _settings

    logs: list[dict[str, str]] = []
    if getattr(_settings, "ENABLE_DEV_CODE", False):
        logs.append(_new_log("info", "未配置 Agent，开发模式 Mock 降级"))
        for log in logs:
            yield {"type": "log", "log": log}
        result = await _mock_decision(alert_data, logs)
        yield {"type": "done", "result": result}
        return

    yield {
        "type": "error",
        "message": "未配置 agent_id 或 WORKFLOW_SOC_AGENT_ID，请使用 invoke_agent_sse",
    }


