"""LLM 调用失败：面向用户的提示文案 + 运维可检索的结构化日志。

运维收集（服务器上）::

    docker logs soar-backend-dev 2>&1 | grep SOAR_LLM_CALL_FAILED

带排查编号精确定位::

    docker logs soar-backend-dev 2>&1 | grep SOAR_LLM_CALL_FAILED | grep ref=<编号>

平台界面：运行监控 → 日志中心 → 模型调用（status=failed，按时间与模型名筛选）。
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from app.agent.hermes.error_classifier import (
    ErrorKind,
    ErrorClassification,
    classify_llm_error,
)

logger = logging.getLogger(__name__)

# 固定关键字，便于 docker logs | grep
SOAR_LLM_CALL_FAILED_MARKER = "SOAR_LLM_CALL_FAILED"

_USER_HINTS: dict[str, str] = {
    ErrorKind.NETWORK: (
        "与模型服务之间的连接异常（通常在几秒内失败，多数不是「模型响应过慢」）。"
        "请稍后重试；若持续出现，请检查模型 API 地址、网络与代理配置。"
    ),
    ErrorKind.RATE_LIMIT: "模型服务请求过于频繁，请稍后再试。",
    ErrorKind.OVERLOADED: "模型服务暂时繁忙，请稍后再试。",
    ErrorKind.AUTH: "模型鉴权失败，请在「模型设置」中检查 API Key 与权限。",
    ErrorKind.CONTENT_FILTER: "输入内容未通过模型安全策略，请修改提问后重试。",
    ErrorKind.CONTEXT_LENGTH: "对话上下文过长，请新建会话或缩短历史后重试。",
    ErrorKind.INVALID_REQUEST: "模型请求参数有误，请联系管理员检查模型配置。",
    ErrorKind.SERVER_ERROR: "模型服务返回服务端错误，请稍后重试或联系模型提供方。",
    ErrorKind.UNKNOWN: "模型调用失败，请稍后重试；若持续出现请联系管理员。",
}


def format_user_llm_error_message(
    exc: BaseException,
    *,
    classification: Optional[ErrorClassification] = None,
    ref: Optional[str] = None,
) -> str:
    """生成对话界面展示的 LLM 失败提示（含排查编号）。"""
    ref = ref or uuid.uuid4().hex[:8]
    if classification is None:
        classification = classify_llm_error(exc)
    hint = _USER_HINTS.get(classification.kind, _USER_HINTS[ErrorKind.UNKNOWN])
    detail = (classification.message or str(exc) or "未知错误").strip()
    if len(detail) > 120:
        detail = detail[:120] + "…"
    return (
        f"[错误] {hint}\n"
        f"技术摘要：{detail}\n"
        f"排查编号：{ref}（提供给管理员，在服务端日志中搜索关键字 {SOAR_LLM_CALL_FAILED_MARKER}）"
    )


def log_llm_call_failure(
    exc: BaseException,
    *,
    agent_id: Optional[int] = None,
    session_id: str = "",
    model_meta: Optional[dict[str, Any]] = None,
    attempts: int = 0,
    phase: str = "stream",
    classification: Optional[ErrorClassification] = None,
    ref: Optional[str] = None,
) -> str:
    """写入一条可检索的错误日志，返回排查编号 ref。"""
    ref = ref or uuid.uuid4().hex[:8]
    if classification is None:
        classification = classify_llm_error(exc)
    meta = model_meta or {}
    payload = {
        "marker": SOAR_LLM_CALL_FAILED_MARKER,
        "ref": ref,
        "phase": phase,
        "kind": classification.kind,
        "attempts": attempts,
        "agent_id": agent_id,
        "session_id": session_id,
        "model_config_id": meta.get("model_config_id"),
        "model_name": meta.get("model_name", ""),
        "provider": meta.get("provider", ""),
        "status_code": classification.status_code,
        "detail": classification.message or str(exc),
        "collect_hint": f"docker logs <backend容器名> 2>&1 | grep {SOAR_LLM_CALL_FAILED_MARKER}",
        "collect_hint_ref": f"docker logs <backend容器名> 2>&1 | grep {SOAR_LLM_CALL_FAILED_MARKER} | grep ref={ref}",
        "ui_hint": "平台：运行监控 → 日志中心 → 模型调用（status=failed）",
    }
    logger.error(
        "%s %s",
        SOAR_LLM_CALL_FAILED_MARKER,
        json.dumps(payload, ensure_ascii=False),
        exc_info=exc,
    )
    return ref


def report_llm_failure(
    exc: BaseException,
    *,
    agent_id: Optional[int] = None,
    session_id: str = "",
    model_meta: Optional[dict[str, Any]] = None,
    attempts: int = 0,
    phase: str = "stream",
) -> str:
    """记录结构化日志并返回面向用户的完整错误消息。"""
    classification = classify_llm_error(exc)
    ref = log_llm_call_failure(
        exc,
        agent_id=agent_id,
        session_id=session_id,
        model_meta=model_meta,
        attempts=attempts,
        phase=phase,
        classification=classification,
    )
    return format_user_llm_error_message(exc, classification=classification, ref=ref)