"""LLM 实例创建与 Base URL 规范化的共享工具。

关键点：``ChatOpenAI`` / openai 客户端会自动在 ``base_url`` 后拼接
``/chat/completions``，因此传入的 ``base_url`` 不应已包含该路径，否则会产生
``/chat/completions/chat/completions`` 重复段（火山引擎等 OpenAI 兼容服务的典型 404）。

本模块提供：
- ``normalize_openai_base_url``：把任意写法的 base_url 规范化为客户端期望的形式。
- ``create_llm_from_config``：根据 LLMConfig 创建 LangChain LLM 实例。
"""
import ipaddress
import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)


def _is_ip_url(url: str) -> bool:
    """判断 URL 的 host 是否为 IP 地址（IPv4 / IPv6）。

    用于决定是否跳过代理环境变量：IP 地址直连，域名走默认行为。
    """
    if not url:
        return False
    try:
        host = urlparse(url).hostname or ""
        if not host:
            return False
        # IPv4
        try:
            ipaddress.IPv4Address(host)
            return True
        except ValueError:
            pass
        # IPv6（urlparse 会去掉方括号）
        try:
            ipaddress.IPv6Address(host)
            return True
        except ValueError:
            pass
    except Exception:
        pass
    return False


def _no_proxy_http_client(base_url: str = "", timeout: float = 60) -> httpx.Client:
    """创建 httpx 客户端，IP 地址直连、域名走默认代理。

    容器/沙箱环境常设 ``HTTP_PROXY``/``HTTPS_PROXY`` 指向本地代理，
    会导致直连 IP 地址的 LLM 请求被误路由到代理触发 DNS 解析失败
    （``[Errno -3] Temporary failure in name resolution``）。
    对 IP 地址的 base_url 设 ``trust_env=False`` 跳过代理直连；
    域名 base_url 保持默认 ``trust_env=True`` 以兼容外部 API 代理。
    """
    if _is_ip_url(base_url):
        return httpx.Client(timeout=timeout, trust_env=False)
    return httpx.Client(timeout=timeout)


def _no_proxy_async_client(base_url: str = "", timeout: float = 60) -> httpx.AsyncClient:
    """``_no_proxy_http_client`` 的 Async 版：IP 地址直连、域名走默认代理。"""
    if _is_ip_url(base_url):
        return httpx.AsyncClient(timeout=timeout, trust_env=False)
    return httpx.AsyncClient(timeout=timeout)


def clean_base_url(raw: str) -> str:
    """清理 base_url：循环去除首尾的空白、斜杠、反斜杠，直到稳定。

    处理复制粘贴引入的脏字符，例如
    ``https://api.x.com/v1/chat/completions \\``（尾部空格 + 反斜杠）
    会被清理为 ``https://api.x.com/v1/chat/completions``。

    单次 ``strip().rstrip('/\\\\')`` 无法处理 ``空格+反斜杠`` 这种交替尾部
    （rstrip 去掉反斜杠后空格仍残留，导致 endswith 判断失败、URL 被重复拼接成
    ``/chat/completions /v1/chat/completions`` 触发 404），故采用循环清理直到稳定。
    """
    if not raw:
        return ""
    cur = raw.strip()
    while True:
        prev = cur
        cur = cur.rstrip("/\\").rstrip()
        if cur == prev:
            break
    return cur


_VALID_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}


def normalize_reasoning_effort(v: str | None) -> str | None:
    """归一化推理模型思考深度参数：非法/空值归 None（None=不传，用模型默认）。

    模型配置（llm_configs）与智能体配置（agents）两侧入库/调用统一走本函数，
    保持值域口径一致，防止 API 直写脏值后配置意图静默失效。
    """
    v = (v or "").strip().lower()
    return v if v in _VALID_REASONING_EFFORTS else None


def normalize_openai_base_url(base_url: str) -> str:
    """规范化 OpenAI 兼容服务的 base_url（供 ChatOpenAI 使用）。

    ChatOpenAI 会自动追加 ``/chat/completions``，所以本函数确保返回值
    **不含** ``/chat/completions`` 后缀，并以版本号路径结尾（如 ``/v1``、``/v3``）。

    支持的输入写法：
    - 完整路径：``https://ark.cn-beijing.volces.com/api/v3/chat/completions``
      → ``https://ark.cn-beijing.volces.com/api/v3``
    - 仅版本号：``https://api.openai.com/v1`` / ``https://ark.cn-beijing.volces.com/api/v3``
      → 原样返回
    - 根域名：``https://api.deepseek.com``
      → ``https://api.deepseek.com/v1``

    Args:
        base_url: 用户配置的 base_url。

    Returns:
        规范化后的 base_url（不含 ``/chat/completions``）。
    """
    if not base_url:
        return ""
    url = base_url.strip().rstrip("/")
    if not url:
        return ""
    # 剥离已有的 /chat/completions 后缀（客户端会重新追加）
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    # 若不含版本号路径（/v1 /v2 ...），补 /v1
    if not re.search(r"/v\d+$", url):
        url += "/v1"
    return url


def create_llm_from_config(
    cfg: Any,
    temperature: float = 0.7,
    max_tokens: int = 1024,
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    seed: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
) -> tuple[Any, dict]:
    """根据 LLMConfig 创建 LangChain LLM 实例。

    Args:
        cfg: ``LLMConfig`` ORM 实例（含 provider/api_key/base_url/model_name）。
        temperature: 采样温度。
        max_tokens: 最大生成 token 数。
        top_p: 核采样概率；None 时不传，使用模型默认值（按需启用模式）。
        frequency_penalty: 频率惩罚；None 时不传。仅 OpenAI 兼容分支支持。
        presence_penalty: 存在惩罚；None 时不传。仅 OpenAI 兼容分支支持。
        seed: 随机种子；None 时不传。仅 OpenAI 兼容分支支持。
        reasoning_effort: 推理模型思考深度（minimal/low/medium/high）；None 时不传。
            经 ``model_kwargs`` 透传到请求体 ``reasoning_effort``（GLM-5.3 /
            DeepSeek-R1 / o 系列等推理模型支持）。仅 OpenAI 兼容分支支持。

    Returns:
        ``(llm, info)``，其中 info 为 ``{"provider", "model"}``。
        失败时抛出 ``ValueError``（含具体原因）。
    """
    api_key = (cfg.api_key or "").strip()
    if not api_key:
        raise ValueError("LLM API Key 为空，请先在「模型设置」中配置并设为默认")
    base_url = cfg.base_url or ""
    model_name = cfg.model_name or ""
    provider = (cfg.provider or "openai").lower()

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        kwargs: dict = {
            "model": model_name or "claude-3-5-haiku-20241022",
            "api_key": api_key,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        # ChatAnthropic 仅支持 top_p，不支持 frequency_penalty/presence_penalty/seed
        if top_p is not None:
            kwargs["top_p"] = top_p
        if frequency_penalty is not None:
            logger.warning("Anthropic 不支持 frequency_penalty，已忽略")
        if presence_penalty is not None:
            logger.warning("Anthropic 不支持 presence_penalty，已忽略")
        if seed is not None:
            logger.warning("Anthropic 不支持 seed，已忽略")
        if base_url:
            kwargs["anthropic_api_url"] = base_url
        kwargs["http_client"] = _no_proxy_http_client(base_url)
        if reasoning_effort:
            logger.warning("Anthropic 不支持 reasoning_effort，已忽略")
        llm = ChatAnthropic(**kwargs)
        logger.info("创建 LLM(anthropic): model=%s", model_name)
        return llm, {"provider": "anthropic", "model": model_name}

    from langchain_openai import ChatOpenAI

    kwargs = {
        "model": model_name or "gpt-4o-mini",
        "api_key": api_key,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    # 推理模型思考深度：经 model_kwargs 透传（LangChain 调用时随请求体下发；
    # executor 原生流式路径从 model_kwargs 读取后以顶层参数下发）
    if reasoning_effort:
        kwargs["model_kwargs"] = {"reasoning_effort": reasoning_effort}
    # OpenAI 兼容分支支持全部扩展参数
    if top_p is not None:
        kwargs["top_p"] = top_p
    if frequency_penalty is not None:
        kwargs["frequency_penalty"] = frequency_penalty
    if presence_penalty is not None:
        kwargs["presence_penalty"] = presence_penalty
    if seed is not None:
        kwargs["seed"] = seed
    if base_url:
        kwargs["base_url"] = normalize_openai_base_url(base_url)
    kwargs["http_client"] = _no_proxy_http_client(base_url)
    llm = ChatOpenAI(**kwargs)
    logger.info("创建 LLM(openai-compat): model=%s, base_url=%s", model_name, kwargs["base_url"])
    return llm, {"provider": "openai", "model": model_name}
