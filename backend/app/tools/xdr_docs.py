"""XDR 接口文档检索与读取（宿主模块）。

为 ``search_xdr_api_docs`` / ``query_xdr_api_doc`` 两个沙箱工具提供实现：
- ``search_xdr_docs(keyword, domain, limit)``：按业务域检索接口文档，返回候选列表与摘要；
- ``read_xdr_doc(path)``：读取指定接口文档 / 规范文档全文（带路径安全校验与长度限额）。

文档来源：openapi-requirement-analyzer Skill 的 references/ 目录，
同步至 ``app/data/xdr_skill_reference/``（92 份接口文档 + 7 份规范文档）。

安全规则：
- 拒绝 ``..``、绝对路径、反斜杠、非 ``.md`` 文件；
- 读取上限 80000 字符，超限截断并标记 ``truncated``；
- 永不抛出异常，统一返回结构化 dict。
"""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

# 文档内容缓存：绝对路径 -> (mtime_ns, size, text)，避免每次检索/读取全量读盘
_DOC_CACHE: dict[str, tuple[int, int, str]] = {}
_DOC_CACHE_LOCK = threading.Lock()

# 业务域目录（api-docs/ 下的子目录）
_VALID_DOMAINS = ("alerts", "incidents", "assets", "vulnerabilities", "risks", "logs")

# 读取上限（字符）；接口文档最大单文件约 40KB，留出余量
_MAX_DOC_CHARS = 80000

# 摘要截取长度
_SNIPPET_CHARS = 300


def _docs_root() -> Path:
    return Path(settings.XDR_DOCS_DIR)


def _safe_resolve(path: str) -> Path | None:
    """路径安全解析：仅允许 docs 目录内的 .md 文件，返回绝对 Path 或 None。"""
    cleaned = str(path or "").strip().replace("\\", "/")
    if not cleaned or not cleaned.endswith(".md"):
        return None
    if cleaned.startswith(("/", ".")) or ".." in cleaned.split("/"):
        return None
    root = _docs_root().resolve()
    target = (root / cleaned).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    if not target.is_file():
        return None
    return target


def _read_cached(target: Path) -> str | None:
    """读取文档文本（按 mtime + size 缓存），读取失败返回 None。"""
    try:
        stat = target.stat()
    except OSError:
        return None
    key = str(target)
    mtime_ns, size = stat.st_mtime_ns, stat.st_size
    with _DOC_CACHE_LOCK:
        cached = _DOC_CACHE.get(key)
        if cached is not None and cached[0] == mtime_ns and cached[1] == size:
            return cached[2]
    try:
        text = target.read_text(encoding="utf-8")
    except Exception:
        return None
    with _DOC_CACHE_LOCK:
        if len(_DOC_CACHE) > 256:  # 防御：正常约 100 份文档
            _DOC_CACHE.clear()
        _DOC_CACHE[key] = (mtime_ns, size, text)
    return text


def _first_heading(text: str) -> str:
    """提取首个一级/二级标题作为文档标题。"""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return ""


def search_xdr_docs(
    keyword: str,
    domain: str | None = None,
    limit: int = 5,
) -> dict:
    """检索 XDR 接口文档。

    匹配规则：文件名命中 > 一级标题命中 > 正文命中次数；
    摘要截取首个命中点前后约 300 字。

    Args:
        keyword: 业务关键词、接口名或字段名，如"告警 列表 分页"。
        domain: 业务域目录（alerts/incidents/assets/vulnerabilities/risks/logs），None 为全部。
        limit: 返回条数（1-10）。

    Returns:
        ``{"ok": True, "total_candidates", "results": [{path, title, score, snippet}]}``
    """
    words = [w for w in re.split(r"[\s,，、;；]+", str(keyword or "").strip()) if w]
    if not words:
        return {"ok": False, "error": "keyword 不能为空", "error_type": "PARAM_ERROR"}

    try:
        limit = max(1, min(int(limit or 5), 10))
    except (TypeError, ValueError):
        limit = 5
    dom = str(domain or "").strip().strip("/") if domain and str(domain).strip() else None
    if dom and dom not in _VALID_DOMAIN_DIRS and dom != "all":
        return {
            "ok": False,
            "error": f"domain 必须是 {'/'.join(_VALID_DOMAIN_DIRS)} 或 all",
            "error_type": "PARAM_ERROR",
        }

    root = _docs_root()
    if not root.is_dir():
        return {
            "ok": False,
            "error": "接口文档目录未部署（app/data/xdr_skill_reference/）",
            "error_type": "CONFIG_MISSING",
            "hint": "请联系平台管理员同步 XDR 接口文档",
        }

    # 候选范围：api-docs/<domain>/ 或全部（含根下规范文档）
    if dom and dom != "all":
        scan_dirs = [root / "api-docs" / dom]
    else:
        scan_dirs = [root / "api-docs", root]

    candidates: list[dict] = []
    for scan_dir in scan_dirs:
        if not scan_dir.is_dir():
            continue
        for md in scan_dir.rglob("*.md"):
            rel = md.relative_to(root).as_posix()
            # 扫根目录时跳过 api-docs（已单独扫描）
            if scan_dir == root and rel.startswith("api-docs/"):
                continue
            text = _read_cached(md)
            if text is None:
                continue
            rel_lower = rel.lower()
            title = _first_heading(text)

            score = 0
            first_hit_pos = -1
            for w in words:
                w_lower = w.lower()
                # 文件名命中（权重 60）
                if w_lower in rel_lower:
                    score += 60
                # 标题命中（权重 40）
                if w_lower in title.lower():
                    score += 40
                # 正文命中（每次 5，记录首个命中位置）
                positions = [m.start() for m in re.finditer(re.escape(w_lower), text.lower())]
                score += len(positions) * 5
                if positions and (first_hit_pos < 0 or positions[0] < first_hit_pos):
                    first_hit_pos = positions[0]

            if score <= 0:
                continue

            if first_hit_pos >= 0:
                start = max(0, first_hit_pos - 80)
                snippet = re.sub(r"\s+", " ", text[start:start + _SNIPPET_CHARS]).strip()
            else:
                snippet = re.sub(r"\s+", " ", text[:_SNIPPET_CHARS]).strip()

            candidates.append({
                "path": rel,
                "title": title,
                "score": score,
                "snippet": snippet,
            })

    # 去重（scan root 与 api-docs 可能重复）并排序
    seen: set[str] = set()
    unique: list[dict] = []
    for c in sorted(candidates, key=lambda x: -x["score"]):
        if c["path"] in seen:
            continue
        seen.add(c["path"])
        unique.append(c)

    return {
        "ok": True,
        "total_candidates": len(unique),
        "results": unique[:limit],
        "hint": "用 query_xdr_api_doc(path) 读取命中文档全文；规范文档见根目录 *.md",
    }


# 兼容命名（供沙箱注入使用简短名）
_VALID_DOMAIN_DIRS = _VALID_DOMAINS


def read_xdr_doc(path: str) -> dict:
    """读取接口文档 / 规范文档全文。

    Args:
        path: 相对路径，如 ``api-docs/alerts/alert-list.md``、``scheme-template.md``。

    Returns:
        ``{"ok": True, "path", "content", "truncated"}``；非法路径返回 ``error_type=PARAM_ERROR``。
    """
    target = _safe_resolve(path)
    if target is None:
        # 区分：文件不存在 vs 路径非法（仅含 .md、无 ".."、非绝对路径时才可能是文件缺失）
        cleaned = str(path or "").strip().replace("\\", "/")
        looks_valid = (
            cleaned.endswith(".md")
            and ".." not in cleaned.split("/")
            and not cleaned.startswith("/")
        )
        if looks_valid:
            return {
                "ok": False,
                "error": f"文档不存在: {cleaned}",
                "error_type": "NOT_FOUND",
                "hint": "请先用 search_xdr_api_docs 检索正确路径",
            }
        return {
            "ok": False,
            "error": f"非法路径: {cleaned[:80]}",
            "error_type": "PARAM_ERROR",
            "hint": "仅允许 docs 目录内的 .md 相对路径，禁止 .. 与绝对路径",
        }

    text = _read_cached(target)
    if text is None:
        return {"ok": False, "error": "读取失败: 文件不可读", "error_type": "UPSTREAM_ERROR"}

    truncated = len(text) > _MAX_DOC_CHARS
    rel = target.relative_to(_docs_root().resolve()).as_posix()
    return {
        "ok": True,
        "path": rel,
        "content": text[:_MAX_DOC_CHARS],
        "truncated": truncated,
        "hint": "内容已截断，请用关键词定位所需段落" if truncated else "",
    }
