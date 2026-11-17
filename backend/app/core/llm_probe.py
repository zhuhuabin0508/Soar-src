"""与智能体对话（Hermes executor）对齐的 LLM 连通性探测。

对话侧对 OpenAI 兼容模型优先走 ``ChatOpenAI.async_client.create(stream=True)``；
本模块复用同一栈（``create_llm_from_config`` + 流式消费），避免「手动测试走 httpx 非流式、
对话走 LangChain 流式」导致测试通过但对话失败。

Embedding 模型仍走专用 ``/embeddings`` 探测（见 ``probe_embedding_llm``）。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

from app.core.llm_helper import (
    _no_proxy_http_client,
    clean_base_url,
    create_llm_from_config,
    normalize_reasoning_effort,
)
from app.core.llm_probe_errors import enrich_probe_error, log_probe_failure

logger = logging.getLogger(__name__)

DEFAULT_PROBE_PROMPT = "回复OK两个字"


@dataclass
class LlmProbeResult:
    """探测结果。"""

    success: bool
    content: str = ""
    reasoning: str = ""
    latency_ms: Optional[int] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error: str = ""
    transport: str = ""  # openai_raw_stream | langchain_astream
    error_kind: str = ""
    error_label: str = ""
    error_detail: str = ""
    error_hint: str = ""
    error_checklist: Optional[list[str]] = None
    probe_ref: str = ""
    status_code: Optional[int] = None

    @property
    def display_text(self) -> str:
        """供界面展示的摘要（推理模型可能仅有思维链）。"""
        if self.content:
            return self.content
        if self.reasoning:
            return f"（模型仅返回思维链，共 {len(self.reasoning)} 字）"
        return ""

    def to_api_error(self, cfg: Any) -> dict:
        """失败时返回给 API 的结构化字段（不含内部 _exc）。"""
        if self.probe_ref:
            return {
                "error": self.error,
                "error_kind": self.error_kind,
                "error_label": self.error_label,
                "error_detail": self.error_detail,
                "error_hint": self.error_hint,
                "error_checklist": self.error_checklist or [],
                "probe_ref": self.probe_ref,
                "status_code": self.status_code,
                "latency_ms": self.latency_ms,
                "probe_transport": self.transport,
            }
        enriched = enrich_probe_error(
            self.error_detail or self.error,
            cfg=cfg,
            latency_ms=self.latency_ms,
            transport=self.transport,
        )
        log_probe_failure(enriched, trigger="manual_test")
        out = {k: v for k, v in enriched.items() if not str(k).startswith("_")}
        out.pop("config_snapshot", None)
        return out


def _fail_probe(
    exc_or_msg: BaseException | str,
    *,
    cfg: Any,
    latency_ms: Optional[int],
    transport: str = "",
) -> LlmProbeResult:
    enriched = enrich_probe_error(
        exc_or_msg, cfg=cfg, latency_ms=latency_ms, transport=transport
    )
    log_probe_failure(enriched, trigger="probe")
    return LlmProbeResult(
        success=False,
        error=enriched["error"],
        error_kind=enriched["error_kind"],
        error_label=enriched["error_label"],
        error_detail=enriched["error_detail"],
        error_hint=enriched["error_hint"],
        error_checklist=enriched["error_checklist"],
        probe_ref=enriched["probe_ref"],
        status_code=enriched.get("status_code"),
        latency_ms=latency_ms,
        transport=transport,
    )


def _http_timeout_sec(cfg: Any) -> float:
    t = getattr(cfg, "timeout", None)
    if t is not None and int(t) > 0:
        return float(int(t))
    return 60.0


def _llm_params_from_config(cfg: Any, *, max_tokens_override: Optional[int] = None) -> dict:
    temperature = cfg.temperature if cfg.temperature is not None else 0.7
    max_tokens = max_tokens_override
    if max_tokens is None:
        max_tokens = cfg.max_tokens if cfg.max_tokens is not None else 1024
    return {
        "temperature": float(temperature),
        "max_tokens": int(max_tokens),
        "top_p": cfg.top_p,
        "reasoning_effort": normalize_reasoning_effort(getattr(cfg, "reasoning_effort", None)),
    }


async def probe_chat_llm_like_agent(
    cfg: Any,
    *,
    prompt: str = DEFAULT_PROBE_PROMPT,
    max_tokens_override: Optional[int] = None,
) -> LlmProbeResult:
    """异步探测：调用栈与 Hermes 对话流式路径一致。"""
    t0 = time.monotonic()
    try:
        params = _llm_params_from_config(cfg, max_tokens_override=max_tokens_override)
        llm, info = create_llm_from_config(
            cfg,
            temperature=params["temperature"],
            max_tokens=params["max_tokens"],
            top_p=params["top_p"],
            reasoning_effort=params["reasoning_effort"],
        )

        raw_async_client = getattr(llm, "async_client", None)
        if info.get("provider") != "anthropic" and raw_async_client is not None and hasattr(
            raw_async_client, "create"
        ):
            try:
                result = await _probe_openai_raw_stream(llm, prompt, params)
                result.latency_ms = int((time.monotonic() - t0) * 1000)
                return result
            except Exception as exc:  # noqa: BLE001
                return _fail_probe(
                    exc, cfg=cfg, latency_ms=int((time.monotonic() - t0) * 1000),
                    transport="openai_raw_stream",
                )

        try:
            result = await _probe_langchain_astream(llm, prompt)
            result.latency_ms = int((time.monotonic() - t0) * 1000)
            return result
        except Exception as exc:  # noqa: BLE001
            return _fail_probe(
                exc, cfg=cfg, latency_ms=int((time.monotonic() - t0) * 1000),
                transport="langchain_astream",
            )
    except Exception as exc:  # noqa: BLE001
        return _fail_probe(
            exc,
            cfg=cfg,
            latency_ms=int((time.monotonic() - t0) * 1000),
        )


async def _probe_openai_raw_stream(llm: Any, prompt: str, params: dict) -> LlmProbeResult:
    """OpenAI 兼容：原生 async ``create(stream=True)``（同 executor._call_llm_stream）。"""
    client = llm.async_client
    api_kwargs: dict = {
        "model": llm.model_name,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if llm.temperature is not None:
        api_kwargs["temperature"] = llm.temperature
    if params.get("max_tokens") is not None:
        api_kwargs["max_tokens"] = params["max_tokens"]
    effort = (getattr(llm, "model_kwargs", None) or {}).get("reasoning_effort")
    if effort:
        api_kwargs["reasoning_effort"] = effort

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None

    stream = await client.create(**api_kwargs)
    async for chunk in stream:
        chunk_usage = getattr(chunk, "usage", None)
        if chunk_usage:
            input_tokens = getattr(chunk_usage, "prompt_tokens", None) or input_tokens
            output_tokens = getattr(chunk_usage, "completion_tokens", None) or output_tokens
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        reasoning = (
            getattr(delta, "reasoning_content", None)
            or getattr(delta, "reasoning", None)
            or ""
        )
        if reasoning:
            reasoning_parts.append(reasoning)
        token = delta.content or ""
        if token:
            content_parts.append(token)

    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    if not content and not reasoning:
        raise ValueError(
            "流式响应已建立但未返回 content/reasoning（可能模型名错误或网关空流）"
        )
    return LlmProbeResult(
        success=True,
        content=content,
        reasoning=reasoning,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        transport="openai_raw_stream",
    )


async def _probe_langchain_astream(llm: Any, prompt: str) -> LlmProbeResult:
    """Anthropic 或无法使用原生 async client 时的回退（同 executor LangChain 分支）。"""
    from langchain_core.messages import HumanMessage

    content_parts: list[str] = []
    async for chunk in llm.astream([HumanMessage(content=prompt)]):
        token = getattr(chunk, "content", "") or ""
        if token:
            content_parts.append(token)

    content = "".join(content_parts)
    if not content:
        raise ValueError("LangChain 流式响应未返回正文")
    return LlmProbeResult(
        success=True,
        content=content,
        transport="langchain_astream",
    )


def probe_chat_llm_like_agent_sync(
    cfg: Any,
    *,
    prompt: str = DEFAULT_PROBE_PROMPT,
    max_tokens_override: Optional[int] = None,
) -> LlmProbeResult:
    """同步包装（FastAPI 路由 / 健康检查线程调用）。"""
    return asyncio.run(
        probe_chat_llm_like_agent(
            cfg, prompt=prompt, max_tokens_override=max_tokens_override
        )
    )


def probe_embedding_llm(cfg: Any, *, input_text: str = "连通性测试") -> LlmProbeResult:
    """Embedding 模型：走 /embeddings（对话不使用此路径）。"""
    provider = (cfg.provider or "openai").lower()
    api_key = (cfg.api_key or "").strip()
    if not api_key:
        return _fail_probe("API Key 为空", cfg=cfg, latency_ms=None, transport="embeddings_http")

    base = clean_base_url(cfg.base_url or "https://api.openai.com/v1")
    if base.endswith("/embeddings/multimodal"):
        regular_url = base[: -len("/multimodal")]
    elif base.endswith("/embeddings"):
        regular_url = base
    elif re.search(r"/v\d+$", base):
        regular_url = f"{base}/embeddings"
    else:
        regular_url = f"{base}/v1/embeddings"
    multimodal_url = regular_url + "/multimodal"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    model_name = cfg.model_name or "text-embedding-ada-002"
    timeout = _http_timeout_sec(cfg)
    t0 = time.monotonic()
    try:
        with _no_proxy_http_client(cfg.base_url or "", timeout=timeout) as client:
            payload = {"model": model_name, "input": [input_text]}
            r = client.post(regular_url, json=payload, headers=headers)
            if r.status_code == 400 and "does not support this api" in r.text:
                mm_payload = {
                    "model": model_name,
                    "input": [{"type": "text", "text": input_text}],
                    "encoding_format": "float",
                }
                r = client.post(multimodal_url, json=mm_payload, headers=headers)
        latency_ms = int((time.monotonic() - t0) * 1000)
        if r.status_code != 200:
            return _fail_probe(
                f"HTTP {r.status_code}: {r.text[:400]}",
                cfg=cfg,
                latency_ms=latency_ms,
                transport="embeddings_http",
            )
        return LlmProbeResult(success=True, latency_ms=latency_ms, transport="embeddings_http")
    except Exception as exc:  # noqa: BLE001
        return _fail_probe(
            exc,
            cfg=cfg,
            latency_ms=int((time.monotonic() - t0) * 1000),
            transport="embeddings_http",
        )