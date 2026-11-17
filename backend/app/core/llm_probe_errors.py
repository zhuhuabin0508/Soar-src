"""LLM 探测 / 模型测试失败：分类、人类可读说明与 API 结构化字段。"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from app.agent.hermes.error_classifier import ErrorKind, classify_llm_error

logger = logging.getLogger(__name__)

SOAR_LLM_PROBE_FAILED_MARKER = "SOAR_LLM_PROBE_FAILED"

_ERROR_KIND_LABELS: dict[str, str] = {
    ErrorKind.NETWORK: "网络连接异常",
    ErrorKind.RATE_LIMIT: "请求限流",
    ErrorKind.OVERLOADED: "服务繁忙",
    ErrorKind.AUTH: "鉴权失败",
    ErrorKind.CONTENT_FILTER: "内容安全策略",
    ErrorKind.CONTEXT_LENGTH: "上下文超长",
    ErrorKind.INVALID_REQUEST: "请求参数无效",
    ErrorKind.SERVER_ERROR: "上游服务端错误",
    ErrorKind.UNKNOWN: "未知错误",
}

_ERROR_HINTS: dict[str, list[str]] = {
    ErrorKind.NETWORK: [
        "确认 Base URL 可从运行后端的机器访问（容器内 curl 网关地址）",
        "检查服务器 HTTP_PROXY/HTTPS_PROXY 是否误代理了模型地址",
        "若失败耗时在数秒内且提示 Connection error，多为链路瞬断而非模型推理慢",
        "智能体对话与测试已共用流式栈；测试失败时对话通常也会失败",
    ],
    ErrorKind.RATE_LIMIT: [
        "降低并发或稍后重试",
        "在模型供应商控制台查看 QPS/配额",
    ],
    ErrorKind.AUTH: [
        "检查 API Key 是否过期、是否有该模型的调用权限",
        "OpenAI 兼容网关需确认 Authorization 头格式为 Bearer",
    ],
    ErrorKind.INVALID_REQUEST: [
        "核对模型名 model_name 是否与网关一致",
        "检查 Base URL 是否多/少 /v1 或 /chat/completions 段",
        "推理模型需确认是否支持 stream + reasoning_effort",
    ],
    ErrorKind.SERVER_ERROR: [
        "稍后重试；若持续失败联系模型提供方或网关运维",
    ],
    ErrorKind.UNKNOWN: [
        "查看下方技术详情；服务端日志可搜索 SOAR_LLM_PROBE_FAILED",
    ],
}


def enrich_probe_error(
    exc_or_msg: BaseException | str,
    *,
    cfg: Any,
    latency_ms: Optional[int] = None,
    transport: str = "",
    status_code: Optional[int] = None,
) -> dict[str, Any]:
    """将原始异常/文案转为前端与运维可用的结构化错误。"""
    if isinstance(exc_or_msg, BaseException):
        status_code = status_code or (
            getattr(exc_or_msg, "status_code", None)
            or getattr(exc_or_msg, "code", None)
            or getattr(getattr(exc_or_msg, "response", None), "status_code", None)
        )
        classification = classify_llm_error(exc_or_msg, status_code=status_code)
        raw_detail = classification.message or str(exc_or_msg)
        exc = exc_or_msg
    else:
        classification = classify_llm_error(Exception(exc_or_msg))
        raw_detail = str(exc_or_msg)
        exc = Exception(exc_or_msg)

    ref = uuid.uuid4().hex[:8]
    kind = classification.kind
    label = _ERROR_KIND_LABELS.get(kind, _ERROR_KIND_LABELS[ErrorKind.UNKNOWN])
    hints = list(_ERROR_HINTS.get(kind, _ERROR_HINTS[ErrorKind.UNKNOWN]))
    if latency_ms is not None and latency_ms < 15000 and kind == ErrorKind.NETWORK:
        hints.insert(0, f"本次失败耗时约 {latency_ms}ms，多见于连不上/被重置，而非响应超时。")

    base_url = (getattr(cfg, "base_url", None) or "").strip()
    display_error = (
        f"[{label}] {raw_detail}\n"
        f"排查编号：{ref}（日志关键字 {SOAR_LLM_PROBE_FAILED_MARKER}）"
    )

    return {
        "error": display_error,
        "error_kind": kind,
        "error_label": label,
        "error_detail": raw_detail[:500],
        "error_hint": hints[0] if hints else "",
        "error_checklist": hints,
        "probe_ref": ref,
        "status_code": status_code,
        "latency_ms": latency_ms,
        "probe_transport": transport,
        "config_snapshot": {
            "config_id": getattr(cfg, "id", None),
            "name": getattr(cfg, "name", ""),
            "provider": getattr(cfg, "provider", ""),
            "model_name": getattr(cfg, "model_name", ""),
            "model_type": getattr(cfg, "model_type", "chat"),
            "base_url": base_url[:200] if base_url else "",
            "timeout_sec": getattr(cfg, "timeout", None),
        },
        "_exc": exc,
        "_classification": classification,
    }


def log_probe_failure(enriched: dict[str, Any], *, trigger: str = "manual_test") -> None:
    """写入可 grep 的结构化探测失败日志。"""
    payload = {
        "marker": SOAR_LLM_PROBE_FAILED_MARKER,
        "ref": enriched.get("probe_ref"),
        "trigger": trigger,
        "kind": enriched.get("error_kind"),
        "latency_ms": enriched.get("latency_ms"),
        "transport": enriched.get("probe_transport"),
        "status_code": enriched.get("status_code"),
        "detail": enriched.get("error_detail"),
        "config": enriched.get("config_snapshot"),
        "collect_hint": f"docker logs <backend> 2>&1 | grep {SOAR_LLM_PROBE_FAILED_MARKER}",
    }
    exc = enriched.get("_exc")
    logger.error(
        "%s %s",
        SOAR_LLM_PROBE_FAILED_MARKER,
        json.dumps(payload, ensure_ascii=False),
        exc_info=exc if isinstance(exc, BaseException) else None,
    )