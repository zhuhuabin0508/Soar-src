# -*- coding: utf-8 -*-
"""工单研判智能体调用封装（线程内同步调用 Hermes）。

范式与 ``app/workflow/agent_client.py`` 一致：LinkageSessionLocal 会话、
失败重试（无退避，3s SLA 约束）、AgentInvocationLog 审计。
channel="ticket_analyst" 已加入 agent_runtime 的联动通道集合。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from app.core.ticket_analyst.prompt import OUTPUT_CONTRACT

logger = logging.getLogger(__name__)

# 1 次调用 + 2 次重试（无退避：工单研判延迟目标 3 秒内）
MAX_ATTEMPTS = 3
NODE_KEY = "ticket_analyst"


def build_analysis_input(ctx: dict, evidence: list[dict]) -> dict:
    """组装 LLM 输入：维度上下文 + 规则证据 + 输出契约提醒。"""
    return {
        "ip": ctx.get("ip"),
        "ticket_title": ctx.get("title") or "",
        "roles": ctx.get("roles") or [],
        "context": {
            "blacklist": ctx.get("blacklist"),
            "whitelist": ctx.get("whitelist"),
            "ip_library": ctx.get("ip_library"),
            "asset": ctx.get("asset"),
            "threat": ctx.get("threat"),
            "ti_360": ctx.get("ti_360"),
        },
        "evidence": evidence,
        "output_format": OUTPUT_CONTRACT,
    }


async def _invoke_ticket_analyst(
    ip: str,
    analysis_input: dict,
    *,
    ticket_id: Optional[int],
) -> dict:
    from app.database import LinkageSessionLocal, close_db_session
    from app.platform.agent_runtime import (
        OUTPUT_MODE_TICKET_ANALYST,
        invoke_agent,
        resolve_runtime_user,
    )
    from app.core.ticket_analyst.ensure import resolve_ticket_analyst_agent

    db = LinkageSessionLocal()
    try:
        user = resolve_runtime_user(db)
        agent = resolve_ticket_analyst_agent(db, create=False)
        if agent is None:
            from app.workflow.agent_client import AgentCallError

            raise AgentCallError("未找到工单安全分析研判智能体（名称与 TICKET_ANALYST_AGENT_ID 均未命中）")
        # ORM 对象按既有范式脱会话后传入 executor（联动通道内部自行开会话）
    finally:
        close_db_session(db)

    db = LinkageSessionLocal()
    try:
        result = await invoke_agent(
            db=db,
            agent=agent,
            input=analysis_input,
            user=user,
            channel=NODE_KEY,
            output_mode=OUTPUT_MODE_TICKET_ANALYST,
            session_id=f"ticket-{ticket_id or 0}-{ip}",
        )
    finally:
        close_db_session(db)

    if result.decision is None:
        from app.workflow.agent_client import AgentCallError

        raise AgentCallError("invoke_agent 未返回 ticket_analyst 决策")
    return result.decision


def analyze_ticket_ip(
    ctx: dict,
    evidence: list[dict],
    *,
    ticket_id: Optional[int] = None,
) -> dict:
    """对单个 IP 执行 LLM 研判，返回严格 3 字段 dict（risk_level/action/reasons）。

    线程内同步执行（``asyncio.run``）：供 ``ThreadPoolExecutor`` 并发调用，
    调用期间不持有任何调用方 Session（内部使用联动会话工厂）。

    Raises:
        app.workflow.agent_client.AgentCallError: 重试耗尽仍失败。
    """
    from app.workflow.agent_client import AgentCallError, _write_invocation_log

    ip = str(ctx.get("ip") or "")
    analysis_input = build_analysis_input(ctx, evidence)
    request_body = {"ip": ip, "ticket_id": ticket_id, "input": analysis_input}
    last_error = ""
    response_body: Optional[dict] = None
    status = "fail"
    started = time.perf_counter()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response_body = asyncio.run(
                _invoke_ticket_analyst(ip, analysis_input, ticket_id=ticket_id)
            )
            status = "success"
            last_error = ""
            break
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)[:500]
            logger.warning(
                "工单研判失败(第 %d/%d 次) ip=%s: %s",
                attempt, MAX_ATTEMPTS, ip, last_error,
            )

    duration_ms = int((time.perf_counter() - started) * 1000)
    _write_invocation_log(
        instance_id=ticket_id,
        node_key=NODE_KEY,
        request_body=request_body,
        response_body=response_body,
        model_name="hermes",
        input_tokens=None,
        output_tokens=None,
        duration_ms=duration_ms,
        status=status,
        error_msg=last_error or None,
    )

    if status != "success":
        raise AgentCallError(f"工单智能体研判失败（已重试 {MAX_ATTEMPTS} 次）: {last_error}")
    return response_body
