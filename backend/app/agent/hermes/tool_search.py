"""渐进式工具披露（tool search）—— 移植自 Hermes ``tools/tool_search.py``。

当 Agent 启用工具数较多时，把非核心工具（DB code/http、OpenAPI 动态工具、
工作流包装工具）从模型可见的 tools 数组中替换为三个桥接工具：
``tool_search`` / ``tool_describe`` / ``tool_call``，按需检索与调用。

核心设计约束（与 Hermes 一致）：

* **核心工具永不延迟**：``builtin`` / ``kb`` / ``delegate`` / ``memory`` /
  ``persisted`` 来源的工具，以及技能触发/列表工具和 ``clarify`` 工具，永远
  全量加载，不进入延迟目录。SOAR 的封堵/查询/澄清工具一旦延迟会严重影响响应。
* **阈值门控每次装配都跑**：当延迟工具预估 token 不足上下文窗口的
  ``threshold_pct``（默认 10%）时，tool_search 退化为 no-op，原样返回。
  避免小工具集也付出桥接开销。
* **目录无状态**：每次装配都从当前 tool_defs 重建目录，不跨 turn 缓存。
  这是 OpenClaw cron 回归的教训：session-keyed 目录与实时注册表漂移会导致
  工具静默丢失。
* **桥接工具走同一执行管线**：``tool_call`` 解析出底层工具后，由
  ``tool_engine._execute_one`` 递归执行，guardrail / middleware /
  verification / threat_scanner / budget 全部照常触发。
* **展示层解包**：``resolve_underlying_call`` 供执行器把 ``tool_call``
  还原为底层工具名+参数，SSE 与执行日志展示底层工具而非桥接。

Soar 适配点（与 Hermes 的差异）：

1. **分词器**：Hermes 用 ``[A-Za-z0-9]+`` 纯英文分词；SOAR 是中文安全平台，
   工具描述多为中文（如"查询威胁情报""封禁IP"），改用 **jieba 中文分词 +
   字母数字 token + CJK 双字二元组** 的混合分词（与项目知识库检索一致），
   保证中文工具描述的召回率。
2. **工具分类**：Hermes 按 registry toolset 前缀（``mcp-``）分类；Soar 按
   ``ToolEntry.source`` 字段分类（``db_code``/``db_http``/``openapi_dynamic``/
   ``workflow`` 可延迟，``builtin``/``kb``/``delegate`` 等为核心）。
3. **桥接工具描述**：中英双语，适配 SOAR 中文 LLM 场景。
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

__all__ = [
    "TOOL_SEARCH_NAME",
    "TOOL_DESCRIBE_NAME",
    "TOOL_CALL_NAME",
    "BRIDGE_TOOL_NAMES",
    "ToolSearchConfig",
    "CatalogEntry",
    "AssemblyResult",
    "SOAR_CORE_TOOL_SOURCES",
    "SOAR_DEFERRABLE_TOOL_SOURCES",
    "default_tool_search_config",
    "is_deferrable_by_source",
    "classify_tools",
    "estimate_tokens_from_schemas",
    "should_activate",
    "build_catalog",
    "search_catalog",
    "search_catalog_hybrid",
    "bridge_tool_schemas",
    "assemble_tool_defs",
    "is_bridge_tool",
    "dispatch_tool_search",
    "dispatch_tool_search_async",
    "dispatch_tool_describe",
    "resolve_underlying_call",
]


# ============================================================================
# 桥接工具名（保留名，不允许用户工具占用）
# ============================================================================

TOOL_SEARCH_NAME = "tool_search"
TOOL_DESCRIBE_NAME = "tool_describe"
TOOL_CALL_NAME = "tool_call"

BRIDGE_TOOL_NAMES = frozenset({TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME})

# 无 tokenizer 时估算 token 的经验值：约 4 字符/token（中英混合略低估，更安全）
CHARS_PER_TOKEN = 4.0


# ============================================================================
# 配置
# ============================================================================


@dataclass(frozen=True)
class ToolSearchConfig:
    """单次装配的 tool-search 配置（已校验）。

    Attributes:
        enabled: ``"auto"`` | ``"on"`` | ``"off"``
        threshold_pct: 0..100，仅 ``auto`` 模式使用
        search_default_limit: ``tool_search`` 默认返回数
        max_search_limit: ``tool_search`` 最大返回数
    """

    enabled: str
    threshold_pct: float
    search_default_limit: int
    max_search_limit: int

    @classmethod
    def from_raw(cls, raw: Any) -> "ToolSearchConfig":
        """从原始配置（bool / dict / None）构建，校验并钳制每个数值字段。

        未知值回退到安全默认，不抛异常——用户配置笔误不应 break agent。
        """
        default = cls(enabled="auto", threshold_pct=10.0,
                      search_default_limit=5, max_search_limit=20)
        if raw is True:
            return default
        if raw is False:
            return cls(enabled="off", threshold_pct=10.0,
                       search_default_limit=5, max_search_limit=20)
        if not isinstance(raw, dict):
            return default

        enabled_raw = str(raw.get("enabled", "auto")).strip().lower()
        if enabled_raw in ("true", "1", "yes"):
            enabled = "on"
        elif enabled_raw in ("false", "0", "no"):
            enabled = "off"
        elif enabled_raw in ("auto", "on", "off"):
            enabled = enabled_raw
        else:
            enabled = "auto"

        threshold_pct = max(0.0, min(100.0, _safe_float(raw.get("threshold_pct"), 10.0)))
        max_search_limit = max(1, min(50, _safe_int(raw.get("max_search_limit"), 20)))
        search_default_limit = max(1, min(max_search_limit,
                                          _safe_int(raw.get("search_default_limit"), 5)))
        return cls(enabled=enabled, threshold_pct=threshold_pct,
                   search_default_limit=search_default_limit,
                   max_search_limit=max_search_limit)


def default_tool_search_config() -> ToolSearchConfig:
    """默认配置（auto 模式，10% 阈值）。"""
    return ToolSearchConfig.from_raw(None)


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _safe_float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


# ============================================================================
# 工具分类（按 ToolEntry.source）
# ============================================================================

# 核心工具来源：永不延迟。这些工具数量少、调用频繁、SOAR 响应关键路径。
SOAR_CORE_TOOL_SOURCES = frozenset({
    "builtin",        # block_ip / get_threat_intel / check_whitelist 等内置安全工具
    "kb",             # search_knowledge_base / query_kb_file 知识库检索
    "delegate",       # delegate_task 子代理委派
    "memory",         # memory_search / memory_write 记忆工具
    "persisted",      # query_persisted_result 持久化结果查询
    "asset",          # search_assets 资产检索（核心检索能力，永不延迟）
})

# 可延迟工具来源：数量可能很多（用户在 DB 配置大量 code/http 工具、导入 OpenAPI、
# 配置多个工作流包装工具），适合按需检索。
SOAR_DEFERRABLE_TOOL_SOURCES = frozenset({
    "db_code",            # DB code 工具
    "db_http",            # DB http 工具
    "openapi_dynamic",    # 本次会话动态注册的 OpenAPI 工具
    "workflow",           # 工作流包装工具（trigger_workflow_skill 之外）
})

# 桥接工具自身永远不延迟（它们就是替代品）
# 技能触发/列表工具（skill_engine 注入）也不延迟——它们是入口工具

# 显式核心工具名（与 source 无关，名字命中即核心）
_EXPLICIT_CORE_NAMES = frozenset({
    "clarify",              # 澄清问答工具，SOAR 关键交互入口
    "trigger_workflow_skill",  # 技能触发
    "list_workflow_skills",    # 技能列表
})

# 研判/封禁链路核心工具：即使 source=db_code 也永不延迟
_JUDGMENT_CORE_TOOL_NAMES = frozenset({
    "search_assets",
    "search_discovered_assets",
    "get_asset_info",
    "get_threat_intel",
    "check_whitelist",
    "check_subnet",
    "query_banned_ip",
    "calculate_ban_duration",
    "block_ip_on_firewall",
})


def is_deferrable_by_source(name: str, source: Optional[str]) -> bool:
    """按 Soar 的 source 分类判断工具是否可延迟。

    Args:
        name: 工具名
        source: ``ToolEntry.source``（如 ``"db_code"`` / ``"builtin"``）

    Returns:
        True 表示可延迟（进入目录，按需检索）
    """
    if not name or name in BRIDGE_TOOL_NAMES:
        return False
    if name in _EXPLICIT_CORE_NAMES or name in _JUDGMENT_CORE_TOOL_NAMES:
        return False
    if source is None:
        # 未知 source：保守视为核心（不延迟），避免误延迟关键工具
        return False
    if source in SOAR_CORE_TOOL_SOURCES:
        return False
    if source in SOAR_DEFERRABLE_TOOL_SOURCES:
        return True
    # 未知 source：保守不延迟
    return False


def classify_tools(
    tool_defs: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """把 tool-defs 列表拆为 (visible, deferrable)。

    Args:
        tool_defs: OpenAI 格式 ``[{"type":"function","function":{...}}]``
        source_map: 工具名 → source 的映射（由 tool_engine 从 registry 构建）。
            缺失时把所有非显式核心工具视为不可延迟（保守）。

    Returns:
        (visible, deferrable)：visible 必须留在模型可见数组；deferrable 进入目录。
    """
    visible: List[Dict[str, Any]] = []
    deferrable: List[Dict[str, Any]] = []
    sm = source_map or {}
    for td in tool_defs:
        fn = td.get("function") or {}
        name = fn.get("name", "")
        if name in BRIDGE_TOOL_NAMES:
            # 已存在的桥接工具跳过（防重复装配）
            continue
        if is_deferrable_by_source(name, sm.get(name)):
            deferrable.append(td)
        else:
            visible.append(td)
    return visible, deferrable


# ============================================================================
# Token 估算 + 阈值门控
# ============================================================================


def estimate_tokens_from_schemas(tool_defs: Iterable[Dict[str, Any]]) -> int:
    """用 chars/4 规则估算 tool-defs 的 token 成本。

    便宜且跨 provider 稳定。不需要精确——它只门控 activate/skip 决策。
    典型 200K 上下文 + 10% 阈值意味着决策在 ~20K token schema 处翻转，
    数量级精度足够。
    """
    total_chars = 0
    for td in tool_defs:
        try:
            total_chars += len(json.dumps(td, ensure_ascii=False, separators=(",", ":")))
        except (TypeError, ValueError):
            total_chars += len(str(td))
    return int(math.ceil(total_chars / CHARS_PER_TOKEN))


def should_activate(
    config: ToolSearchConfig,
    deferrable_tokens: int,
    context_length: Optional[int],
) -> bool:
    """决定本次装配是否激活 tool search。

    - ``"off"`` → 永不激活
    - ``"on"`` → 有至少 1 个可延迟工具就激活
    - ``"auto"`` → 可延迟 schema token >= 上下文窗口的 threshold_pct%
    """
    if config.enabled == "off":
        return False
    if deferrable_tokens <= 0:
        return False
    if config.enabled == "on":
        return True
    # auto
    if not context_length or context_length <= 0:
        # 未知上下文大小：回退到固定 20K token 门槛（Anthropic/OpenAI 测得的质量悬崖）
        return deferrable_tokens >= 20_000
    threshold_tokens = int(context_length * (config.threshold_pct / 100.0))
    return deferrable_tokens >= threshold_tokens


# ============================================================================
# 目录 + BM25 检索（jieba 中文分词 + CJK 双字二元组）
# ============================================================================


@dataclass
class CatalogEntry:
    """一个可延迟工具的目录条目。"""

    name: str
    description: str
    schema: Dict[str, Any]  # 完整 {"type":"function","function":{...}}
    source: str  # ToolEntry.source
    # 预分词结果（供 BM25 打分）
    _tokens: List[str] = field(default_factory=list)


# 字母数字 token（含下划线，匹配 block_ip 这类标识符）
_ALPHA_NUM_RE = re.compile(r"[A-Za-z0-9_]+")
# CJK 字符（中日韩统一表意文字 + 扩展 A）
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")


def _is_cjk_char(ch: str) -> bool:
    """判断单个字符是否 CJK。"""
    return bool(_CJK_RE.match(ch))


def _tokenize(text: str) -> List[str]:
    """混合分词：jieba 中文分词 + 字母数字 token + CJK 双字二元组。

    项目记忆约束：中文检索必须用 jieba + BM25，character bigram 作为 fallback。
    混合策略保证：
    - 英文/代码标识符（``block_ip``）→ 整体保留为 token
    - 中文短语（"查询威胁情报"）→ jieba 切分为词（"查询"/"威胁"/"情报"）
    - 未登录中文词 → CJK 双字二元组兜底（"威胁情报"→"威胁"/"胁情"/"情报"）

    所有 token 小写化。
    """
    if not text:
        return []
    tokens: List[str] = []

    # 1. 提取字母数字 token（含下划线）—— 英文/代码标识符整体保留
    for m in _ALPHA_NUM_RE.findall(text):
        tokens.append(m.lower())
        # 把 snake_case 拆词也加入（block_ip → block / ip），提升子词召回
        parts = m.lower().replace("_", " ").split()
        tokens.extend(p for p in parts if p and p != m.lower())

    # 2. jieba 中文分词
    try:
        import jieba
        # jieba.cut 返回生成器；精确模式
        cjk_tokens = [w for w in jieba.cut(text, cut_all=False) if w.strip()]
    except Exception:  # noqa: BLE001
        cjk_tokens = []

    # 3. CJK 双字二元组兜底（覆盖未登录词）
    bigrams: List[str] = []
    prev_cjk = ""
    for ch in text:
        if _is_cjk_char(ch):
            if prev_cjk:
                bigrams.append(prev_cjk + ch)
            prev_cjk = ch
        else:
            prev_cjk = ""
    # 单字 CJK 也加入（保证单字查询能命中）
    cjk_chars = [ch for ch in text if _is_cjk_char(ch)]

    # 合并：字母数字 + jieba 词 + CJK 双字 + CJK 单字，全部小写，去重保序
    all_tokens = tokens + [w.lower() for w in cjk_tokens] + bigrams + cjk_chars
    seen: set[str] = set()
    result: List[str] = []
    for t in all_tokens:
        if t and t not in seen:
            seen.add(t)
            result.append(t)
    return result


def _entry_search_text(td: Dict[str, Any]) -> str:
    """构建工具的检索文本 blob。

    包含：工具名（下划线/点/连字符拆为词）、描述、顶层参数名。
    不索引 schema body——索引它们只增噪声不提召回。
    """
    fn = td.get("function") or {}
    name = fn.get("name", "")
    desc = fn.get("description", "") or ""
    params = ((fn.get("parameters") or {}).get("properties") or {})
    param_names = " ".join(params.keys())
    # 把 snake_case / dotted / hyphenated 名字拆为词，供 BM25 子词匹配
    name_words = name.replace("_", " ").replace(".", " ").replace("-", " ").replace(":", " ")
    return f"{name_words} {name} {desc} {param_names}"


def build_catalog(
    tool_defs: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
) -> List[CatalogEntry]:
    """从 tool-defs 列表构建延迟工具目录。

    Args:
        tool_defs: 可延迟子集（classify_tools 第二个返回值）
        source_map: 工具名 → source 映射
    """
    sm = source_map or {}
    catalog: List[CatalogEntry] = []
    for td in tool_defs:
        fn = td.get("function") or {}
        name = fn.get("name", "")
        if not name:
            continue
        desc = fn.get("description", "") or ""
        entry = CatalogEntry(
            name=name,
            description=desc,
            schema=td,
            source=sm.get(name, "other"),
            _tokens=_tokenize(_entry_search_text(td)),
        )
        catalog.append(entry)
    return catalog


# 进程级缓存：延迟工具目录（含预分词 token）。
# key = 可延迟 tool_defs + source 的 JSON 指纹，value = 目录列表。
# build_catalog 的 jieba 分词 + CJK 双字二元组是 CPU 开销，而同一批工具在
# 一次对话里可能被 tool_search 反复检索；缓存后只在工具集合变化时重建。
# 加容量上限：不同工具集合数量有限，但长期运行 + 频繁增删工具时仍应防无界增长。
_catalog_cache: Dict[str, List[CatalogEntry]] = {}
_CATALOG_CACHE_MAX = 128


def _catalog_fingerprint(
    deferrable: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
) -> str:
    """计算可延迟工具目录的指纹（含 source，避免 source 变化复用旧目录）。"""
    sm = source_map or {}
    sources = [
        (
            (td.get("function") or {}).get("name", ""),
            sm.get((td.get("function") or {}).get("name", ""), "other"),
        )
        for td in deferrable
    ]
    return json.dumps({"defs": deferrable, "sources": sources},
                      sort_keys=True, ensure_ascii=False)


def _get_or_build_catalog(
    deferrable: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
) -> List[CatalogEntry]:
    """返回延迟工具目录，按指纹做进程级缓存。

    分离出来是为了让 ``dispatch_tool_search`` 每次检索都不必重建目录、
    重复 jieba 分词。
    """
    fingerprint = _catalog_fingerprint(deferrable, source_map)
    cached = _catalog_cache.get(fingerprint)
    if cached is not None:
        return cached
    catalog = build_catalog(deferrable, source_map=source_map)
    # 超过上限时按插入顺序淘汰最旧条目（dict 保持插入顺序）
    if len(_catalog_cache) >= _CATALOG_CACHE_MAX:
        _catalog_cache.pop(next(iter(_catalog_cache)), None)
    _catalog_cache[fingerprint] = catalog
    return catalog


def _bm25_score(
    query_tokens: List[str],
    doc_tokens: List[str],
    avg_dl: float,
    doc_freq: Dict[str, int],
    n_docs: int,
    k1: float = 1.5,
    b: float = 0.75,
) -> float:
    """标准 BM25 打分（单 query vs 单 doc）。

    内联小实现，避免引入依赖。目录规模 N（工具数）通常 < 500，性能足够。
    """
    if not doc_tokens:
        return 0.0
    score = 0.0
    dl = len(doc_tokens)
    doc_tf: Dict[str, int] = {}
    for t in doc_tokens:
        doc_tf[t] = doc_tf.get(t, 0) + 1
    for q in query_tokens:
        df = doc_freq.get(q, 0)
        if df == 0:
            continue
        idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
        tf = doc_tf.get(q, 0)
        if tf == 0:
            continue
        norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / max(avg_dl, 1.0)))
        score += idf * norm
    return score


def _bm25_score_all(
    catalog: List[CatalogEntry],
    query: str,
) -> List[Tuple[float, CatalogEntry]]:
    """对所有目录条目做 BM25 打分，返回按分数降序的 ``(score, entry)`` 列表。

    当 BM25 无 >0 命中时，回退到工具名子串匹配（给 0.1 分）。这保证查询
    ``"github"`` 对一个全是 ``github_*`` 工具的目录仍返回结果——BM25 在
    query 与所有 doc 共享单一 token（零 IDF）时表现差。
    """
    if not catalog:
        return []
    query_tokens = _tokenize(query)
    if not query_tokens:
        return []

    doc_lengths = [len(e._tokens) for e in catalog]
    avg_dl = sum(doc_lengths) / max(len(doc_lengths), 1)
    doc_freq: Dict[str, int] = {}
    for e in catalog:
        seen = set(e._tokens)
        for t in seen:
            doc_freq[t] = doc_freq.get(t, 0) + 1
    n_docs = len(catalog)

    scored: List[Tuple[float, CatalogEntry]] = []
    for entry in catalog:
        s = _bm25_score(query_tokens, entry._tokens, avg_dl, doc_freq, n_docs)
        scored.append((s, entry))

    if not any(s > 0 for s, _ in scored):
        # 子串回退（工具名小写包含查询）
        ql = query.lower()
        scored = [(0.1 if ql in e.name.lower() else 0.0, e) for e in catalog]

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


def search_catalog(
    catalog: List[CatalogEntry],
    query: str,
    limit: int = 5,
) -> List[CatalogEntry]:
    """BM25 检索目录，返回 top-``limit`` 条目。"""
    if not catalog or limit <= 0:
        return []
    scored = _bm25_score_all(catalog, query)
    return [e for _, e in scored[:limit]]


# ============================================================================
# 向量语义召回（BM25 + embedding 混合）
# ============================================================================
# 工具描述多为中文自由文本，纯 BM25 对「换个说法」的同义查询召回不足。用
# embedding 计算 query 与工具描述向量的余弦相似度，与 BM25 分数线性加权融合，
# 提升语义匹配命中率。embedding 不可用/失败时自动回退纯 BM25，链路始终可用。
#
# 文档向量进程级缓存：同一批延迟工具在一段对话内反复被 tool_search 检索，
# 避免重复调用 embedding API（embed_texts 内部也有按文本的缓存，但这里避免
# 重复的 dict 重建与函数开销）。

# 融合权重：BM25 占 alpha、语义相似度占 1-alpha。0.5 让关键词与语义各占一半。
_HYBRID_ALPHA = 0.5

# fingerprint → {工具名: 描述向量}
_doc_vec_cache: Dict[str, Dict[str, list]] = {}
_DOC_VEC_CACHE_MAX = 128


def _default_embedding_config_id(db) -> Optional[int]:
    """取 model_type=embedding 的 LLMConfig.id，找不到返回 None（回退默认配置）。"""
    try:
        from app.models.llm_config import LLMConfig

        cfg = db.query(LLMConfig).filter(LLMConfig.model_type == "embedding").first()
        return cfg.id if cfg is not None else None
    except Exception:  # noqa: BLE001
        return None


async def _embed_catalog_docs(
    catalog: List[CatalogEntry],
    db,
    embedding_config_id: Optional[int],
) -> Optional[Dict[str, list]]:
    """为目录条目描述批量生成向量（进程级缓存），失败返回 None。"""
    from app.core.embedding import embed_texts

    texts = [(e.description or e.name) for e in catalog]
    fp = json.dumps(texts, ensure_ascii=False)
    cached = _doc_vec_cache.get(fp)
    if cached is not None:
        return cached

    vecs = await embed_texts(texts, "", db=db, embedding_config_id=embedding_config_id)
    if not vecs:
        return None
    result = {e.name: vecs[i] for i, e in enumerate(catalog) if i < len(vecs)}
    # 超过上限时按插入顺序淘汰最旧条目（dict 保持插入顺序）
    if len(_doc_vec_cache) >= _DOC_VEC_CACHE_MAX:
        _doc_vec_cache.pop(next(iter(_doc_vec_cache)), None)
    _doc_vec_cache[fp] = result
    return result


async def search_catalog_hybrid(
    catalog: List[CatalogEntry],
    query: str,
    limit: int = 5,
    *,
    db=None,
    embedding_config_id: Optional[int] = None,
) -> List[CatalogEntry]:
    """BM25 + 向量语义混合检索，返回 top-``limit`` 条目。

    embedding 不可用（无配置 / 网络失败 / 模型不支持）时自动退化为纯 BM25，
    与 ``search_catalog`` 结果一致。融合前对 BM25 分数做 min-max 归一化，
    语义相似度用余弦（文本 embedding 通常非负，这里 clamp 到 [0,1]）。
    """
    if not catalog or limit <= 0:
        return []
    bm25 = _bm25_score_all(catalog, query)
    if not bm25:
        return []

    # 尝试向量语义召回（失败则纯 BM25）
    vec_scores: Dict[str, float] = {}
    if db is not None:
        try:
            from app.core.embedding import cosine_similarity, embed_texts

            qvecs = await embed_texts([query], "", db=db, embedding_config_id=embedding_config_id)
            doc_vecs = await _embed_catalog_docs(catalog, db, embedding_config_id)
            if qvecs and doc_vecs:
                qv = qvecs[0]
                for e in catalog:
                    dv = doc_vecs.get(e.name)
                    if dv:
                        # clamp 到 [0,1]，避免负相似度拉低排序
                        vec_scores[e.name] = max(0.0, cosine_similarity(qv, dv))
        except Exception:  # noqa: BLE001
            vec_scores = {}

    # 融合：min-max 归一化 BM25 后与语义相似度加权
    bm25_by_name = {e.name: s for s, e in bm25}
    bm25_scores = [s for s, _ in bm25]
    mn, mx = min(bm25_scores), max(bm25_scores)
    rng = (mx - mn) or 1.0

    fused: List[Tuple[float, CatalogEntry]] = []
    for entry in catalog:
        bm25_norm = (bm25_by_name.get(entry.name, 0.0) - mn) / rng
        sem = vec_scores.get(entry.name, 0.0)
        final = _HYBRID_ALPHA * bm25_norm + (1 - _HYBRID_ALPHA) * sem
        fused.append((final, entry))

    fused.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in fused[:limit]]


# ============================================================================
# 桥接工具 schema
# ============================================================================


def bridge_tool_schemas(deferred_count: int) -> List[Dict[str, Any]]:
    """构建注入到模型可见数组的桥接工具 schema。

    schema 刻意简短——每多一个字节都是用户每 turn 要付的代价。描述精确
    说明模型应遵循的调用序列。
    """
    desc_search = (
        f"搜索 {deferred_count} 个按需加载的额外工具。"
        f"返回最多 ``limit`` 个匹配（含名称与描述）。"
        f"随后用 ``{TOOL_DESCRIBE_NAME}`` 加载工具的完整参数 schema，"
        f"再用 ``{TOOL_CALL_NAME}`` 调用。"
        f"已在本系统提示词顶部列出的工具可直接调用，无需搜索。"
        f"\nSearch {deferred_count} on-demand tools. Returns up to ``limit`` matches. "
        f"Follow with ``{TOOL_DESCRIBE_NAME}`` then ``{TOOL_CALL_NAME}``."
    )
    desc_describe = (
        f"加载 ``{TOOL_SEARCH_NAME}`` 返回的某个工具的完整 JSON schema。"
        f"若工具参数未知，调用 ``{TOOL_CALL_NAME}`` 前必须先调用本工具。"
        f"\nLoad full JSON schema for a tool returned by ``{TOOL_SEARCH_NAME}``."
    )
    desc_call = (
        "按名称调用一个延迟工具，参数形状与工具 schema 一致"
        f"（见 ``{TOOL_DESCRIBE_NAME}``）。"
        "策略、守卫、审批、验证等管线与直接列出的工具完全一致。"
        f"\nInvoke a deferred tool by name. Policy/guardrail/approval hooks fire identically."
    )

    return [
        {
            "type": "function",
            "function": {
                "name": TOOL_SEARCH_NAME,
                "description": desc_search,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "描述所需能力的关键词（如 '查询威胁情报' / 'create github issue'）。",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "最大返回数，默认 5。",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": TOOL_DESCRIBE_NAME,
                "description": desc_describe,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "工具名（tool_search 返回的精确名称）。",
                        },
                    },
                    "required": ["name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": TOOL_CALL_NAME,
                "description": desc_call,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "要调用的工具名。",
                        },
                        "arguments": {
                            "type": "object",
                            "description": "工具参数，与工具 schema 一致。",
                        },
                    },
                    "required": ["name", "arguments"],
                },
            },
        },
    ]


# ============================================================================
# 装配入口
# ============================================================================


@dataclass
class AssemblyResult:
    """一次装配的结果（供测试与可观测性）。"""

    tool_defs: List[Dict[str, Any]]  # 模型实际可见的 tool-defs
    activated: bool
    deferred_count: int = 0
    deferred_tokens: int = 0
    threshold_tokens: int = 0
    visible_count: int = 0


def assemble_tool_defs(
    tool_defs: List[Dict[str, Any]],
    *,
    source_map: Optional[Dict[str, str]] = None,
    context_length: Optional[int] = None,
    config: Optional[ToolSearchConfig] = None,
) -> AssemblyResult:
    """返回模型实际应看到的 tool-defs 列表。

    未激活（off / 无可延迟工具 / 低于阈值）时为透传。激活时，可延迟工具从
    visible 列表剥离，替换为三个桥接工具。核心工具无论配置如何都不延迟。

    幂等：输入已含桥接工具时为 no-op（它们被分类为非核心/非延迟，但名字保留，
    会从 deferrable 集合过滤掉）。
    """
    if config is None:
        config = default_tool_search_config()

    # 防御：剥离可能已存在的桥接工具（防重复装配）
    incoming = [td for td in tool_defs
                if (td.get("function") or {}).get("name") not in BRIDGE_TOOL_NAMES]

    visible, deferrable = classify_tools(incoming, source_map=source_map)
    if not deferrable:
        return AssemblyResult(tool_defs=incoming, activated=False,
                              visible_count=len(visible))

    deferrable_tokens = estimate_tokens_from_schemas(deferrable)
    if not should_activate(config, deferrable_tokens, context_length):
        threshold_tokens = int((context_length or 0) * (config.threshold_pct / 100.0))
        return AssemblyResult(
            tool_defs=incoming,
            activated=False,
            deferred_count=len(deferrable),
            deferred_tokens=deferrable_tokens,
            threshold_tokens=threshold_tokens,
            visible_count=len(visible),
        )

    bridge = bridge_tool_schemas(len(deferrable))
    result = visible + bridge
    threshold_tokens = int((context_length or 0) * (config.threshold_pct / 100.0))

    logger.info(
        "tool_search 激活: 保留核心工具 %d 个, 延迟 %d 个 (~%d token, 阈值 ~%d token)",
        len(visible), len(deferrable), deferrable_tokens, threshold_tokens,
    )

    return AssemblyResult(
        tool_defs=result,
        activated=True,
        deferred_count=len(deferrable),
        deferred_tokens=deferrable_tokens,
        threshold_tokens=threshold_tokens,
        visible_count=len(visible),
    )


# ============================================================================
# 桥接工具分发
# ============================================================================


def is_bridge_tool(name: str) -> bool:
    """判断是否为桥接工具名。"""
    return name in BRIDGE_TOOL_NAMES


def _format_search_hit(entry: CatalogEntry) -> Dict[str, Any]:
    """格式化单条搜索结果（限制描述长度防 MCP server 噪音）。"""
    return {
        "name": entry.name,
        "source": entry.source,
        "description": (entry.description or "")[:400],
    }


def _resolve_search_limit(args: Dict[str, Any], config: ToolSearchConfig) -> int:
    """解析 tool_search 的 limit 参数（钳制到 [1, max_search_limit]）。"""
    raw_limit = args.get("limit")
    if raw_limit is None:
        return config.search_default_limit
    return max(1, min(config.max_search_limit,
                      _safe_int(raw_limit, config.search_default_limit)))


def _search_result_json(query: str, catalog: List[CatalogEntry], hits: List[CatalogEntry]) -> str:
    """把检索结果打包成 JSON 字符串（dispatch 两个版本共用）。"""
    return json.dumps({
        "query": query,
        "total_available": len(catalog),
        "matches": [_format_search_hit(h) for h in hits],
    }, ensure_ascii=False)


def dispatch_tool_search(
    args: Dict[str, Any],
    *,
    full_tool_defs: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
    config: Optional[ToolSearchConfig] = None,
) -> str:
    """执行 ``tool_search`` 桥接工具（纯 BM25），返回 JSON 字符串。

    Args:
        args: LLM 传入的参数（``query`` / ``limit``）
        full_tool_defs: **完整的** tool-defs（含核心+可延迟），用于重建目录。
            注意：每次都从完整列表重建（无状态），而非从已装配的 visible 列表。
        source_map: 工具名 → source
        config: tool-search 配置
    """
    if config is None:
        config = default_tool_search_config()
    query = str(args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "query is required"}, ensure_ascii=False)
    limit = _resolve_search_limit(args, config)

    _, deferrable = classify_tools(full_tool_defs, source_map=source_map)
    catalog = _get_or_build_catalog(deferrable, source_map=source_map)
    hits = search_catalog(catalog, query, limit=limit)
    return _search_result_json(query, catalog, hits)


async def dispatch_tool_search_async(
    args: Dict[str, Any],
    *,
    full_tool_defs: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
    config: Optional[ToolSearchConfig] = None,
    db=None,
) -> str:
    """执行 ``tool_search`` 桥接工具（BM25 + 向量语义混合），返回 JSON 字符串。

    与 ``dispatch_tool_search`` 唯一的区别：优先用混合检索（提升中文语义召回），
    embedding 不可用时自动退化为纯 BM25。需要 db 会话用于取 embedding 配置与
    调用向量化 API。
    """
    if config is None:
        config = default_tool_search_config()
    query = str(args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "query is required"}, ensure_ascii=False)
    limit = _resolve_search_limit(args, config)

    _, deferrable = classify_tools(full_tool_defs, source_map=source_map)
    catalog = _get_or_build_catalog(deferrable, source_map=source_map)
    embedding_config_id = _default_embedding_config_id(db) if db is not None else None
    hits = await search_catalog_hybrid(
        catalog, query, limit=limit,
        db=db, embedding_config_id=embedding_config_id,
    )
    return _search_result_json(query, catalog, hits)


def dispatch_tool_describe(
    args: Dict[str, Any],
    *,
    full_tool_defs: List[Dict[str, Any]],
    source_map: Optional[Dict[str, str]] = None,
) -> str:
    """执行 ``tool_describe`` 桥接工具，返回 JSON 字符串。"""
    name = str(args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "name is required"}, ensure_ascii=False)

    sm = source_map or {}
    if not is_deferrable_by_source(name, sm.get(name)):
        return json.dumps({
            "error": (
                f"'{name}' 不是可延迟工具。若它已在工具列表中，请直接调用；"
                f"否则请用 tool_search 核对拼写。"
            ),
        }, ensure_ascii=False)

    _, deferrable = classify_tools(full_tool_defs, source_map=source_map)
    for td in deferrable:
        fn = td.get("function") or {}
        if fn.get("name") == name:
            return json.dumps({
                "name": name,
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {}),
            }, ensure_ascii=False)
    return json.dumps({
        "error": f"'{name}' 当前不可用。请重新运行 tool_search 刷新。",
    }, ensure_ascii=False)


def resolve_underlying_call(
    args: Dict[str, Any],
    *,
    source_map: Optional[Dict[str, str]] = None,
) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """解析 ``tool_call`` 桥接调用为 (底层工具名, 参数, 错误信息)。

    供：
    - ``tool_engine._execute_one`` 把桥接调用还原为底层工具后走完整执行管线
    - SSE / 执行日志展示底层工具名（而非桥接）
    - 执行记录持久化

    解析失败返回 ``(None, {}, error_message)``。
    """
    name = str(args.get("name") or "").strip()
    if not name:
        return None, {}, "tool_call 需要 'name' 参数"
    if name in BRIDGE_TOOL_NAMES:
        return None, {}, f"tool_call 不能调用 '{name}'（它本身是桥接工具）"

    raw_args = args.get("arguments")
    if raw_args is None:
        raw_args = {}
    if isinstance(raw_args, str):
        try:
            raw_args = json.loads(raw_args)
        except json.JSONDecodeError as e:
            return None, {}, f"tool_call 'arguments' 不是合法 JSON: {e}"
    if not isinstance(raw_args, dict):
        return None, {}, "tool_call 'arguments' 必须是对象"

    sm = source_map or {}
    if not is_deferrable_by_source(name, sm.get(name)):
        return None, {}, (
            f"'{name}' 不是可延迟工具。若它已在模型可见工具列表中，"
            f"请直接调用而非通过 tool_call。"
        )
    return name, raw_args, None
