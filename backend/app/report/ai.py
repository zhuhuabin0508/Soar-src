"""AI 辅助：模板草稿生成与映射建议。

AI 只产出**结构化 JSON 规格**，由后端校验并用 python-docx 生成可渲染的 docx：

- 模板生成：规格 → docx（含 ``{{token}}`` 与 ``{%tr for %}`` 表格循环）→ manifest 解析校验；
- 映射建议：manifest + 数据源样例 → 绑定建议（token/path/columns），人工确认后才写入配置。

AI 永远不直接参与正式报告的填数；生成结果必须走草稿 → 发布流程。
"""
from __future__ import annotations

import io
import json
import logging
import re
from typing import Any

from app.report.errors import AI_BAD_OUTPUT, AI_FAILED, AI_NOT_CONFIGURED, ReportError
from app.report.spec import (
    COLUMN_TYPES,
    TRANSFORM_OPS,
    is_valid_token,
    normalize_token,
)

logger = logging.getLogger(__name__)

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_COLUMN_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_SAMPLE_LIMIT = 4000


# --------------------------------------------------------------------------- #
# LLM 解析与 JSON 容错
# --------------------------------------------------------------------------- #
def resolve_default_llm(
    db, *, temperature: float = 0.3, max_tokens: int = 3000
) -> tuple[Any, dict]:
    """加载默认 LLM 配置并创建实例。

    优先级：``is_default`` → 第一个配置。未配置 Key 时抛 ``AI_NOT_CONFIGURED``。

    Returns:
        ``(llm, {"provider", "model"})``。
    """
    from app.core.llm_helper import create_llm_from_config
    from app.models.llm_config import LLMConfig

    cfg = db.query(LLMConfig).filter(LLMConfig.is_default.is_(True)).first()
    if cfg is None:
        cfg = db.query(LLMConfig).first()
    if cfg is None or not (cfg.api_key or cfg.base_url):
        raise ReportError(
            AI_NOT_CONFIGURED,
            "未配置 AI 模型，请先在「模型设置」中配置并设为默认",
        )
    try:
        llm, info = create_llm_from_config(
            cfg, temperature=temperature, max_tokens=max_tokens
        )
    except ValueError as exc:
        raise ReportError(AI_NOT_CONFIGURED, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("创建 LLM 实例失败: %s", exc)
        raise ReportError(AI_FAILED, f"创建 AI 模型实例失败: {exc}") from exc
    return llm, info or {}


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def extract_json(text: str) -> Any:
    """从模型输出中提取 JSON：兼容代码块包裹与前后解释文字。"""
    if not text:
        return None
    cleaned = _strip_code_fence(str(text))
    try:
        return json.loads(cleaned)
    except ValueError:
        pass
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(cleaned[start : end + 1])
        except ValueError:
            return None
    return None


async def _chat_json(llm, prompt: str) -> Any:
    """调用 LLM 并解析 JSON；异常统一转成带错误码的 ReportError。"""
    from langchain_core.messages import HumanMessage

    try:
        response = await llm.ainvoke([HumanMessage(content=prompt)])
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI 调用失败: %s", exc)
        raise ReportError(AI_FAILED, f"AI 调用失败: {exc}") from exc

    content = getattr(response, "content", response)
    if isinstance(content, list):
        content = "".join(
            str(part.get("text", "")) if isinstance(part, dict) else str(part)
            for part in content
        )
    data = extract_json(str(content))
    if data is None:
        raise ReportError(
            AI_BAD_OUTPUT,
            "AI 输出不是合法 JSON",
            {"preview": str(content)[:500]},
        )
    return data


# --------------------------------------------------------------------------- #
# 模板生成
# --------------------------------------------------------------------------- #
_TEMPLATE_PROMPT = """你是资深安全运营报告模板设计专家。请根据报告需求输出**一个 JSON 对象**，\
不要输出 markdown 代码块，不要任何解释。

JSON 结构：
{{
  "title": "报告标题",
  "sections": [
    {{
      "heading": "一、概述",
      "paragraphs": ["本周期共发现告警 {{{{ summary.total_alert }}}} 起，高危 {{{{ summary.high_alert }}}} 起。"],
      "table": {{
        "token": "table.vuln",
        "columns": [{{"key": "asset", "label": "资产", "type": "text"}}]
      }}
    }}
  ]
}}

硬性规则：
1. 段落中的填充位必须写成 {{{{ 域.指标 }}}}（双大括号，token 全小写、至少两段、用点分隔）；
2. 表格 token 形如 table.xxx；列 key 为单段小写标识符，label 为中文表头；
3. 所有指标都必须用占位符表示，禁止写死具体数值、日期、设备名；
4. 每章只允许 paragraphs 与 table 两种内容；禁止 Jinja 控制语句；
5. 章节标题用「一、二、三、」编号；最多 {max_sections} 个章节，每章 1~4 段；
6. 直接输出 JSON 对象本身。

报告需求：
{description}
"""


def _validate_paragraph_tokens(text: str, section_index: int, tokens: set[str]) -> None:
    for match in _PLACEHOLDER_RE.finditer(text):
        token = normalize_token(match.group(1))
        if not is_valid_token(token):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"占位符命名不合法: {match.group(0)}",
                {"section": section_index + 1, "token": match.group(1)},
            )
        tokens.add(token)


def _sanitize_table(
    table: dict,
    section_index: int,
    tokens: set[str],
    table_tokens: set[str],
) -> dict:
    token = normalize_token(table.get("token"))
    if not is_valid_token(token):
        raise ReportError(
            AI_BAD_OUTPUT,
            f"表格 token 不合法: {table.get('token') or '(空)'}",
            {"section": section_index + 1},
        )
    if token in table_tokens:
        raise ReportError(AI_BAD_OUTPUT, f"表格 token 重复: {token}")
    table_tokens.add(token)
    tokens.add(token)

    columns: list[dict] = []
    seen: set[str] = set()
    for column in table.get("columns") or []:
        if not isinstance(column, dict):
            continue
        key = str(column.get("key") or "").strip()
        if not _COLUMN_KEY_RE.match(key):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"表格 {token} 的列 key 不合法: {key or '(空)'}",
                {"section": section_index + 1},
            )
        if key in seen:
            raise ReportError(AI_BAD_OUTPUT, f"表格 {token} 的列 key 重复: {key}")
        seen.add(key)
        ctype = str(column.get("type") or "text").strip().lower()
        if ctype not in COLUMN_TYPES:
            ctype = "text"
        columns.append(
            {
                "key": key,
                "label": str(column.get("label") or key).strip() or key,
                "type": ctype,
            }
        )
    if not columns:
        raise ReportError(AI_BAD_OUTPUT, f"表格 {token} 缺少列定义")
    return {"token": token, "columns": columns}


def sanitize_template_spec(
    raw: Any, *, description: str = "", title: str = ""
) -> dict:
    """校验并规整模型输出的模板结构；不合法时抛 ``AI_BAD_OUTPUT``。"""
    if not isinstance(raw, dict):
        raise ReportError(AI_BAD_OUTPUT, "AI 输出必须是 JSON 对象")
    raw_sections = raw.get("sections")
    if not isinstance(raw_sections, list) or not raw_sections:
        raise ReportError(AI_BAD_OUTPUT, "AI 输出缺少 sections")

    tokens: set[str] = set()
    table_tokens: set[str] = set()
    sections: list[dict] = []
    for index, section in enumerate(raw_sections):
        if not isinstance(section, dict):
            continue
        heading = str(section.get("heading") or "").strip()
        paragraphs: list[str] = []
        for paragraph in section.get("paragraphs") or []:
            if not isinstance(paragraph, str):
                continue
            text = paragraph.strip()
            if not text:
                continue
            if "{%" in text:
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"第 {index + 1} 个章节包含非法的模板控制语句",
                    {"section": index + 1, "paragraph": text[:200]},
                )
            _validate_paragraph_tokens(text, index, tokens)
            paragraphs.append(text)

        table = section.get("table")
        sanitized_table = (
            _sanitize_table(table, index, tokens, table_tokens)
            if isinstance(table, dict)
            else None
        )
        if not heading and not paragraphs and sanitized_table is None:
            continue
        sections.append(
            {
                "heading": heading or f"第 {len(sections) + 1} 部分",
                "paragraphs": paragraphs,
                "table": sanitized_table,
            }
        )

    if not sections:
        raise ReportError(AI_BAD_OUTPUT, "AI 输出未包含有效章节")
    if not tokens:
        raise ReportError(AI_BAD_OUTPUT, "AI 输出未包含任何占位符")

    return {
        "title": str(raw.get("title") or title or "").strip() or "报告",
        "sections": sections,
        "source_description": description,
    }


def build_docx_from_spec(spec: dict) -> bytes:
    """把结构化规格渲染为 docx；表格使用 docxtpl 行循环语法。"""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Pt

    document = Document()
    normal = document.styles["Normal"]
    normal.font.name = "宋体"
    normal.font.size = Pt(11)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "宋体")

    heading = document.add_heading(spec.get("title") or "报告", level=0)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for section in spec.get("sections") or []:
        document.add_heading(section.get("heading") or "", level=1)
        for text in section.get("paragraphs") or []:
            paragraph = document.add_paragraph(text)
            paragraph.paragraph_format.first_line_indent = Pt(22)
        table = section.get("table")
        if isinstance(table, dict) and table.get("columns"):
            _add_table(document, table)

    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def _add_table(document, table: dict) -> None:
    columns = table["columns"]
    token = table["token"]

    grid = document.add_table(rows=4, cols=len(columns))
    grid.style = "Table Grid"
    for index, column in enumerate(columns):
        cell = grid.cell(0, index)
        cell.text = column["label"]
        for paragraph in cell.paragraphs:
            for run in paragraph.runs:
                run.bold = True

    grid.cell(1, 0).text = "{%tr for r in " + token + " %}"
    for index, column in enumerate(columns):
        grid.cell(2, index).text = "{{ r." + column["key"] + " }}"
    grid.cell(3, 0).text = "{%tr endfor %}"


async def generate_template_spec(
    llm, description: str, *, title: str = "", max_sections: int = 8
) -> dict:
    """调用 LLM 生成模板规格并校验。"""
    if not (description or "").strip():
        raise ReportError(AI_BAD_OUTPUT, "请提供报告需求描述")
    prompt = _TEMPLATE_PROMPT.format(
        max_sections=max_sections, description=description.strip()
    )
    raw = await _chat_json(llm, prompt)
    return sanitize_template_spec(raw, description=description, title=title)


# --------------------------------------------------------------------------- #
# 映射建议
# --------------------------------------------------------------------------- #
def _truncate_sample(data: Any) -> str:
    try:
        text = json.dumps(data, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        text = str(data)
    if len(text) > _SAMPLE_LIMIT:
        return text[:_SAMPLE_LIMIT] + "...(已截断)"
    return text


_MAPPING_PROMPT = """你是数据映射专家。下面是 Word 模板的占位符清单，以及各数据源的响应样例\
（JSON 片段，可能被截断）。请为每个占位符给出取值建议，输出**一个 JSON 对象**，不要解释。

输出结构：
{{
  "bindings": [
    {{"token": "summary.total_alert", "source_key": "xdr", "path": "$.data.total",
      "transforms": [{{"op": "to_int"}}], "reason": "取自告警总数"}},
    {{"token": "table.vuln", "source_key": "xdr", "path": "$.data.list",
      "columns": {{"asset": {{"path": "asset"}}, "level": {{"path": "level"}}}}, "reason": "漏洞列表"}}
  ],
  "warnings": ["无法匹配的说明"]
}}

规则：
1. 只能使用清单中出现的 token 与 source_key；
2. path 使用 JSONPath，必须以 $ 开头；表格 path 必须指向数组；
3. 标量不要给 columns；表格必须给 columns，key 必须来自该表格的列定义；
4. transforms 只能使用白名单算子：{ops}；
5. 无法确定的占位符不要编造，写入 warnings；
6. 只输出 JSON 对象。

占位符清单：
{placeholders}

数据源样例：
{sources}
"""


def _sanitize_transforms(raw: Any, token: str, warnings: list[str]) -> list[dict]:
    if not isinstance(raw, list):
        return []
    operations: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("op") or "").strip()
        if name not in TRANSFORM_OPS:
            warnings.append(f"{token} 的转换算子不受支持: {name or '(空)'}")
            continue
        operation = {"op": name}
        for key, value in item.items():
            if key != "op":
                operation[key] = value
        operations.append(operation)
    return operations


def _sanitize_columns(
    raw: Any, placeholder: dict, token: str, warnings: list[str]
) -> dict:
    expected = {
        column.get("key")
        for column in placeholder.get("columns") or []
        if isinstance(column, dict)
    }
    if not isinstance(raw, dict):
        return {}
    columns: dict[str, dict] = {}
    for key, column in raw.items():
        if key not in expected:
            warnings.append(f"{token} 的列 {key} 不在模板中，已忽略")
            continue
        if not isinstance(column, dict):
            continue
        path = str(column.get("path") or "").strip()
        if not path:
            warnings.append(f"{token}.{key} 缺少 path，已忽略")
            continue
        columns[key] = {
            "path": path,
            "transforms": _sanitize_transforms(
                column.get("transforms"), f"{token}.{key}", warnings
            ),
        }
    return columns


def sanitize_mapping_suggestions(
    raw: Any, manifest: dict, source_keys: set[str]
) -> dict:
    """过滤模型建议：token / source_key / path / 列映射必须合法。"""
    if not isinstance(raw, dict):
        raise ReportError(AI_BAD_OUTPUT, "AI 输出必须是 JSON 对象")
    bindings = raw.get("bindings")
    if not isinstance(bindings, list):
        raise ReportError(AI_BAD_OUTPUT, "AI 输出缺少 bindings")

    placeholder_by_token = {
        normalize_token(item.get("token")): item
        for item in manifest.get("placeholders", [])
        if isinstance(item, dict) and item.get("token")
    }
    warnings: list[str] = []
    suggestions: list[dict] = []
    seen: set[str] = set()

    for item in bindings:
        if not isinstance(item, dict):
            continue
        token = normalize_token(item.get("token"))
        placeholder = placeholder_by_token.get(token)
        if placeholder is None:
            warnings.append(f"忽略未知占位符: {item.get('token') or '(空)'}")
            continue
        if token in seen:
            warnings.append(f"忽略重复建议: {token}")
            continue
        source_key = str(item.get("source_key") or "").strip()
        if source_key not in source_keys:
            warnings.append(f"{token} 的数据源不存在: {source_key or '(空)'}")
            continue
        path = str(item.get("path") or "").strip()
        if not path.startswith("$"):
            warnings.append(f"{token} 的 path 不合法: {path or '(空)'}")
            continue

        suggestion = {
            "placeholder_id": placeholder.get("id"),
            "token": token,
            "type": placeholder.get("type") or "text",
            "source_key": source_key,
            "path": path,
            "transforms": _sanitize_transforms(item.get("transforms"), token, warnings),
            "on_missing": "degrade_mark",
            "reason": str(item.get("reason") or "").strip(),
        }
        if placeholder.get("type") == "table":
            columns = _sanitize_columns(item.get("columns"), placeholder, token, warnings)
            if not columns:
                warnings.append(f"{token} 缺少有效列映射，已忽略")
                continue
            suggestion["columns"] = columns
            suggestion.pop("transforms", None)
        seen.add(token)
        suggestions.append(suggestion)

    ai_warnings = raw.get("warnings")
    if isinstance(ai_warnings, list):
        warnings.extend(str(item) for item in ai_warnings if str(item).strip())

    uncovered = [token for token in placeholder_by_token if token not in seen]
    return {
        "suggestions": suggestions,
        "warnings": warnings[:50],
        "stats": {
            "total": len(placeholder_by_token),
            "covered": len(suggestions),
            "uncovered": uncovered[:30],
        },
    }


async def suggest_mappings(
    llm, manifest: dict, sources: list[dict], *, model: str = ""
) -> dict:
    """调用 LLM 生成映射建议并过滤非法项。

    Args:
        sources: ``[{"source_key", "source_type", "sample"}]``。
    """
    payload = [
        {
            "source_key": source.get("source_key"),
            "source_type": source.get("source_type") or "",
            "sample_json": _truncate_sample(source.get("sample")),
        }
        for source in sources
    ]
    placeholders = [
        {
            "token": item.get("token"),
            "label": item.get("label") or item.get("token"),
            "type": item.get("type") or "text",
            "columns": [
                {"key": column.get("key"), "label": column.get("label") or column.get("key")}
                for column in item.get("columns") or []
                if isinstance(column, dict)
            ],
        }
        for item in manifest.get("placeholders", [])
        if isinstance(item, dict)
    ]
    prompt = _MAPPING_PROMPT.format(
        ops=", ".join(sorted(TRANSFORM_OPS)),
        placeholders=json.dumps(placeholders, ensure_ascii=False, indent=2),
        sources=json.dumps(payload, ensure_ascii=False, indent=2),
    )
    raw = await _chat_json(llm, prompt)
    result = sanitize_mapping_suggestions(
        raw, manifest, {str(source.get("source_key")) for source in sources}
    )
    result["model"] = model
    return result
