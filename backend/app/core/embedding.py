"""Embedding 向量生成客户端（OpenAI 兼容）。

复用默认 LLMConfig 的 base_url 与 api_key 调用 ``/embeddings`` 接口生成向量。
- 从 base_url 推导 embeddings 端点：剥离 ``/chat/completions`` 后追加 ``/embeddings``。
- 模型名取知识库的 ``embedding_model``。
- 任何失败（无配置 / 模型名无效 / 网络错误）均返回 ``None``，调用方回退到纯关键词检索，
  保证检索链路始终可用。
- 支持多模态 embedding 模型（如 doubao-embedding-vision-251215），自动检测并切换到
  ``/embeddings/multimodal`` 端点（逐条调用，因多模态 API 不支持批量）。

向量存储为 JSON 浮点数组（无 pgvector），余弦相似度在 ``kb_retriever`` 中用 numpy 计算。
"""
import logging
from typing import Any

import httpx

from app.core.llm_helper import _no_proxy_async_client, clean_base_url

logger = logging.getLogger(__name__)

# 简单内存缓存：避免对相同短文本重复调用
_EMBED_CACHE: dict[str, list[float]] = {}
_EMBED_CACHE_MAX = 2000

# 多模态 embedding 检测缓存：config_id → True 表示该配置使用多模态 API
# 避免每次调用都先试 /embeddings 再回退到 /embeddings/multimodal
_MULTIMODAL_CACHE: set[int] = set()


def _resolve_embeddings_url(base_url: str) -> str:
    """从 LLM base_url 推导 embeddings 端点。

    https://ark.cn-beijing.volces.com/api/v3/chat/completions
      → https://ark.cn-beijing.volces.com/api/v3/embeddings
    https://api.openai.com/v1 → https://api.openai.com/v1/embeddings
    """
    if not base_url:
        return ""
    url = clean_base_url(base_url)
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    elif url.endswith("/embeddings/multimodal"):
        url = url[: -len("/multimodal")]
    elif url.endswith("/embeddings"):
        pass  # 已含 /embeddings
    else:
        url += "/embeddings"
    return url


def _resolve_multimodal_url(base_url: str) -> str:
    """从 LLM base_url 推导多模态 embeddings 端点。"""
    regular = _resolve_embeddings_url(base_url)
    if regular.endswith("/embeddings"):
        return regular + "/multimodal"
    return regular + "/multimodal"


def _get_default_llm_config(db):
    """取默认 LLMConfig（优先 is_default，否则第一条）。"""
    from app.models.llm_config import LLMConfig

    cfg = db.query(LLMConfig).filter(LLMConfig.is_default.is_(True)).first()
    if cfg is None:
        cfg = db.query(LLMConfig).first()
    return cfg


def _get_embedding_llm_config(db, embedding_config_id=None):
    """取向量化的 LLMConfig。

    优先用知识库指定的 ``embedding_config_id``（model_type=embedding 的配置），
    这样向量化的 base_url/api_key/model_name 与对话模型可分别配置（如对话用
    Anthropic、向量化用火山引擎 Doubao）。为空时回退到默认 LLMConfig。
    """
    from app.models.llm_config import LLMConfig

    if embedding_config_id:
        cfg = db.query(LLMConfig).filter(LLMConfig.id == embedding_config_id).first()
        if cfg is not None:
            return cfg
    return _get_default_llm_config(db)


async def _call_multimodal_embedding(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    model: str,
    text: str,
) -> list[float] | None:
    """调用多模态 embedding API（单条文本）。

    多模态 API（``/embeddings/multimodal``）不支持批量输入，需逐条调用。
    输入格式为 ``[{"type": "text", "text": ...}]``，
    响应格式为 ``{"data": {"embedding": [...]}}``（非数组）。
    """
    payload = {
        "model": model,
        "input": [{"type": "text", "text": text}],
        "encoding_format": "float",
    }
    resp = await client.post(url, headers=headers, json=payload)
    resp.raise_for_status()
    data = resp.json().get("data", {})
    # 多模态响应：{"data": {"embedding": [...]}}
    if isinstance(data, dict):
        return data.get("embedding")
    elif isinstance(data, list) and data:
        return data[0].get("embedding")
    return None


async def embed_texts(
    texts: list[str], embedding_model: str, db=None, embedding_config_id=None
) -> list[list[float]] | None:
    """批量生成向量。

    Args:
        texts: 待向量化的文本列表。
        embedding_model: 模型名（知识库配置的 embedding_model，作为兜底）。
        db: 数据库会话，用于取 LLMConfig 的 base_url/api_key。
        embedding_config_id: 知识库关联的 embedding 类型 LLMConfig.id。
            优先用此配置的 base_url/api_key/model_name 做向量化。

    Returns:
        与 texts 等长的向量列表；失败返回 ``None``。
    """
    if not texts:
        return []
    if db is None:
        return None

    cfg = _get_embedding_llm_config(db, embedding_config_id)
    if cfg is None or not (cfg.api_key or "").strip():
        logger.warning("未配置 LLM，向量检索不可用，回退关键词检索")
        return None

    api_key = (cfg.api_key or "").strip()
    url = _resolve_embeddings_url(cfg.base_url or "")
    # 优先用关联配置的 model_name（真实模型名，如 doubao-embedding-text-240715），
    # 否则回退到知识库 embedding_model 字段
    model = (cfg.model_name or "").strip() or embedding_model or "text-embedding-ada-002"

    # 分离缓存命中与未命中
    results: list[list[float] | None] = [None] * len(texts)
    miss_idx: list[int] = []
    miss_texts: list[str] = []
    for i, t in enumerate(texts):
        cached = _EMBED_CACHE.get(t)
        if cached is not None:
            results[i] = cached
        else:
            miss_idx.append(i)
            miss_texts.append(t)

    if miss_texts:
        config_id = getattr(cfg, "id", 0) or 0
        use_multimodal = config_id in _MULTIMODAL_CACHE
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        multimodal_url = _resolve_multimodal_url(cfg.base_url or "")

        try:
            # IP 型 base_url 直连（与 llm_helper 约定一致），域名走默认代理
            async with _no_proxy_async_client(cfg.base_url or "", 30) as client:
                if use_multimodal:
                    # 已知多模态模型：直接逐条调用 /embeddings/multimodal
                    for j, text in enumerate(miss_texts):
                        vec = await _call_multimodal_embedding(
                            client, multimodal_url, headers, model, text
                        )
                        if vec and len(vec) > 0:
                            results[miss_idx[j]] = vec
                            if len(_EMBED_CACHE) < _EMBED_CACHE_MAX:
                                _EMBED_CACHE[miss_texts[j]] = vec
                else:
                    # 先尝试常规 /embeddings（批量）
                    resp = await client.post(
                        url,
                        headers=headers,
                        json={"model": model, "input": miss_texts},
                    )
                    if resp.status_code == 400 and "does not support this api" in resp.text:
                        # 多模态模型不支持常规端点 → 逐条调用 /embeddings/multimodal
                        logger.info("检测到多模态 embedding 模型，切换到 /embeddings/multimodal")
                        _MULTIMODAL_CACHE.add(config_id)
                        for j, text in enumerate(miss_texts):
                            vec = await _call_multimodal_embedding(
                                client, multimodal_url, headers, model, text
                            )
                            if vec and len(vec) > 0:
                                results[miss_idx[j]] = vec
                                if len(_EMBED_CACHE) < _EMBED_CACHE_MAX:
                                    _EMBED_CACHE[miss_texts[j]] = vec
                    else:
                        resp.raise_for_status()
                        data = resp.json()
                        # 按 index 对齐
                        items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
                        if len(items) != len(miss_texts):
                            logger.warning(
                                "向量返回数量不匹配: 期望 %d, 实际 %d",
                                len(miss_texts), len(items),
                            )
                            return None
                        for j, item in enumerate(items):
                            vec = item.get("embedding")
                            if vec and len(vec) > 0:
                                results[miss_idx[j]] = vec
                                if len(_EMBED_CACHE) < _EMBED_CACHE_MAX:
                                    _EMBED_CACHE[miss_texts[j]] = vec
        except Exception as exc:  # noqa: BLE001
            logger.warning("向量生成失败（回退关键词检索）: model=%s, err=%s", model, exc)
            return None

    # 任一缺失即视为失败
    if any(r is None for r in results):
        return None
    return results


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """计算两个向量的余弦相似度。"""
    try:
        import numpy as np

        va, vb = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
        na, nb = float(np.linalg.norm(va)), float(np.linalg.norm(vb))
        if na == 0 or nb == 0:
            return 0.0
        return float(np.dot(va, vb) / (na * nb))
    except Exception:  # noqa: BLE001
        return 0.0
