"""IP 风险研判智能体调用封装。

契约：生产经 ``invoke_agent(output_mode=ban_risk_analyze)``；
dev/staging 未配置 ``BAN_ANALYST_AGENT_ID`` 时可回退 HTTP mock。
"""
import asyncio
import json
import logging
import os
import time
from typing import Any, Optional

import requests

from app.config import settings
from app.database import LinkageSessionLocal, close_db_session, linkage_db
from app.models.workflow_ban import AgentInvocationLog

logger = logging.getLogger(__name__)

AGENT_BASE_URL = os.environ.get("BAN_AGENT_BASE_URL", "http://127.0.0.1:8000/api/v1/internal")
AGENT_TIMEOUT_SECONDS = 60
AGENT_MAX_ATTEMPTS = 3

REQUIRED_FIELDS = ("is_banned", "risk_level", "action", "need_confirm", "ban_plan", "monitoring_advice", "reasons")

_OUTPUT_CONTRACT = (
    "输出要求：最终回答必须只包含一个 JSON 对象，不要任何解释文字或 markdown 代码块标记，"
    '字段：is_banned(bool)、risk_level(str)、action(str)、need_confirm(bool)、'
    "ban_plan(object)、monitoring_advice(str)、reasons(str数组)。"
    "数据要求：reasons 等字段必须引用本次工具调用实际返回的数据"
    "（威胁标签、置信度、恶意软件等以威胁情报工具返回值为准），"
    "严禁照搬系统提示词示例中的数值。"
)


class AgentCallError(Exception):
    """智能体调用失败（网络/超时/HTTP 错误/JSON 结构不完整）。"""


def _write_invocation_log(
    *,
    instance_id: Optional[int],
    node_key: str,
    request_body: dict,
    response_body: Optional[dict],
    model_name: str,
    input_tokens: Optional[int],
    output_tokens: Optional[int],
    duration_ms: int,
    status: str,
    error_msg: Optional[str],
) -> None:
    try:
        with linkage_db() as db:
            db.add(AgentInvocationLog(
                workflow_instance_id=instance_id,
                node_key=node_key,
                request_body=json.dumps(request_body, ensure_ascii=False),
                response_body=json.dumps(response_body, ensure_ascii=False) if response_body is not None else None,
                model_name=model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                duration_ms=duration_ms,
                status=status,
                error_msg=error_msg,
            ))
    except Exception:  # noqa: BLE001
        logger.exception("智能体调用日志写入失败（不影响流程）")


async def _invoke_ban_risk_analyze(
    ip: str,
    alert_context: dict[str, Any],
    *,
    agent_id: int,
    instance_id: Optional[int],
    node_key: str,
) -> dict[str, Any]:
    from app.models.agent import Agent
    from app.platform.agent_runtime import (
        OUTPUT_MODE_BAN_RISK_ANALYZE,
        invoke_agent,
        resolve_runtime_user,
    )

    db = LinkageSessionLocal()
    try:
        user = resolve_runtime_user(db)
        agent = db.query(Agent).filter(Agent.id == int(agent_id)).first()
        if agent is None:
            raise AgentCallError(f"智能体不存在: agent_id={agent_id}")
    finally:
        close_db_session(db)

    db = LinkageSessionLocal()
    try:
        result = await invoke_agent(
            db=db,
            agent=agent,
            input={"ip": ip, "alert_context": alert_context, "output_format": _OUTPUT_CONTRACT},
            user=user,
            channel="ban_workflow",
            output_mode=OUTPUT_MODE_BAN_RISK_ANALYZE,
            session_id=f"ban-{instance_id or 0}-{node_key}",
        )
    finally:
        close_db_session(db)

    if result.decision is None:
        raise AgentCallError("invoke_agent 未返回 ban_risk_analyze 决策")
    return result.decision


async def _analyze_ip_risk_via_runtime(
    ip: str,
    alert_context: dict[str, Any],
    *,
    agent_id: int,
    instance_id: Optional[int],
    node_key: str,
) -> dict[str, Any]:
    request_body = {"ip": ip, "alert_context": alert_context}
    last_error = ""
    response_body: Optional[dict] = None
    status = "fail"
    started = time.perf_counter()

    for attempt in range(1, AGENT_MAX_ATTEMPTS + 1):
        try:
            response_body = await _invoke_ban_risk_analyze(
                ip, alert_context,
                agent_id=agent_id,
                instance_id=instance_id,
                node_key=node_key,
            )
            status = "success"
            last_error = ""
            break
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)[:500]
            logger.warning(
                "Hermes 研判失败(第 %d/%d 次) ip=%s: %s",
                attempt, AGENT_MAX_ATTEMPTS, ip, last_error,
            )
            if attempt < AGENT_MAX_ATTEMPTS:
                await asyncio.sleep(min(2 ** attempt, 5))

    duration_ms = int((time.perf_counter() - started) * 1000)
    _write_invocation_log(
        instance_id=instance_id,
        node_key=node_key,
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
        raise AgentCallError(f"智能体研判失败（已重试 {AGENT_MAX_ATTEMPTS} 次）: {last_error}")
    return response_body


def _analyze_ip_risk_via_http(
    ip: str,
    alert_context: dict[str, Any],
    *,
    instance_id: Optional[int],
    node_key: str,
) -> dict[str, Any]:
    request_body = {"ip": ip, "alert_context": alert_context}
    last_error = ""
    response_body: Optional[dict] = None
    model_name = ""
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    status = "fail"

    started = time.perf_counter()
    for attempt in range(1, AGENT_MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(
                f"{AGENT_BASE_URL}/agent/ip-risk-analyze",
                json=request_body,
                timeout=AGENT_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            body = resp.json()
            missing = [f for f in REQUIRED_FIELDS if f not in body]
            if missing:
                raise AgentCallError(f"响应缺少必填字段: {', '.join(missing)}")
            response_body = body
            meta = body.get("_meta") or {}
            model_name = str(meta.get("model") or "")
            input_tokens = meta.get("input_tokens")
            output_tokens = meta.get("output_tokens")
            status = "success"
            last_error = ""
            break
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)[:500]
            logger.warning(
                "智能体研判失败(第 %d/%d 次) ip=%s: %s",
                attempt, AGENT_MAX_ATTEMPTS, ip, last_error,
            )
            if attempt < AGENT_MAX_ATTEMPTS:
                time.sleep(min(2 ** attempt, 5))

    duration_ms = int((time.perf_counter() - started) * 1000)
    _write_invocation_log(
        instance_id=instance_id,
        node_key=node_key,
        request_body=request_body,
        response_body=response_body,
        model_name=model_name,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        duration_ms=duration_ms,
        status=status,
        error_msg=last_error or None,
    )

    if status != "success":
        raise AgentCallError(f"智能体研判失败（已重试 {AGENT_MAX_ATTEMPTS} 次）: {last_error}")
    return response_body


def analyze_ip_risk(
    ip: str,
    alert_context: dict[str, Any],
    *,
    instance_id: Optional[int] = None,
    node_key: str = "agent_analyze",
    agent_id: Optional[int] = None,
    db=None,  # noqa: ARG001 — 兼容旧签名，忽略
) -> dict[str, Any]:
    """调用 IP 风险研判智能体（ban_risk_analyze）。

    长耗时推理期间不占用调用方 Session；日志与配置加载使用联动池短会话。
    """
    aid = agent_id if agent_id and agent_id > 0 else int(getattr(settings, "BAN_ANALYST_AGENT_ID", 0) or 0)
    if aid > 0:
        return asyncio.run(
            _analyze_ip_risk_via_runtime(
                ip, alert_context,
                agent_id=aid,
                instance_id=instance_id,
                node_key=node_key,
            )
        )
    if not getattr(settings, "ENABLE_DEV_CODE", False):
        raise AgentCallError(
            "BAN_ANALYST_AGENT_ID 未配置，生产环境禁止 HTTP mock 研判"
        )
    return _analyze_ip_risk_via_http(
        ip, alert_context,
        instance_id=instance_id,
        node_key=node_key,
    )
