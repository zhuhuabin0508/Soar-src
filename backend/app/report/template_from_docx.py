"""从现有 docx 报告生成模板：结构探测 → AI 计划 → 原位套用占位符。

平台流程（报告中心「模板库 → 从现有报告生成」）：

1. :func:`inspect_docx` 提取正文段落、页眉页脚与表格的可定位结构；
2. LLM 只输出 JSON 计划（替换位置 + 表格行循环），由 :func:`sanitize_plan` 严格校验；
3. :func:`apply_plan` 在原文档上写入 ``{{ token }}`` / ``{%tr for %}``，保留原有版式；
4. 生成的 docx 交给报告中心既有的 manifest 解析、草稿确认与发布流程。

AI 不参与正式报告填数，生成结果始终是草稿，必须人工确认后发布。
"""
from __future__ import annotations

import copy
import io
import json
import re
from typing import Any

from app.report.errors import AI_BAD_OUTPUT, TPL_PARSE, ReportError
from app.report.spec import is_valid_token, normalize_token

_COLUMN_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_REPLACEMENT_KINDS = {"paragraph", "header", "footer", "table_cell"}
_TRUNCATED_MARK = "…(已截断)"

# 结构快照上限：控制提示词体积，超出部分标记 truncated
_MAX_PARAGRAPHS = 150
_MAX_PARAGRAPH_CHARS = 500
_MAX_TABLES = 12
_MAX_TABLE_ROWS = 30
_MAX_CELL_CHARS = 120
_MAX_WARNINGS = 50


# --------------------------------------------------------------------------- #
# 文档结构快照
# --------------------------------------------------------------------------- #
def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + _TRUNCATED_MARK


def _cell_text(cell) -> str:
    return " ".join(" ".join(p.text.split()) for p in cell.paragraphs).strip()


def inspect_docx(docx_bytes: bytes) -> dict:
    """提取 docx 的可定位结构，供 LLM 识别动态数据。

    位置口径与 manifest 解析一致：正文段落、表格使用 python-docx 的 index，
    页眉/页脚额外带 section index。
    """
    try:
        from docx import Document

        document = Document(io.BytesIO(docx_bytes))
    except Exception as exc:  # noqa: BLE001
        raise ReportError(TPL_PARSE, f"Word 报告解析失败: {exc}") from exc

    truncated = False
    paragraphs: list[dict] = []
    for index, paragraph in enumerate(document.paragraphs):
        text = (paragraph.text or "").strip()
        if not text:
            continue
        if len(paragraphs) >= _MAX_PARAGRAPHS:
            truncated = True
            continue
        entry = {"index": index, "text": _truncate(text, _MAX_PARAGRAPH_CHARS)}
        style = (paragraph.style.name if paragraph.style is not None else "") or ""
        if style:
            entry["style"] = style
        paragraphs.append(entry)

    tables: list[dict] = []
    for table_index, table in enumerate(document.tables):
        if len(tables) >= _MAX_TABLES:
            truncated = True
            break
        rows = [
            [_truncate(_cell_text(cell), _MAX_CELL_CHARS) for cell in row.cells]
            for row in table.rows
        ]
        entry = {
            "index": table_index,
            "row_count": len(rows),
            "rows": rows[:_MAX_TABLE_ROWS],
        }
        if len(rows) > _MAX_TABLE_ROWS:
            entry["truncated"] = True
            truncated = True
        tables.append(entry)

    headers: list[dict] = []
    footers: list[dict] = []
    for section_index, section in enumerate(document.sections):
        for target, story in (
            (headers, section.header),
            (footers, section.footer),
        ):
            story_paragraphs = list(story.paragraphs)
            items: list[dict] = []
            for index, paragraph in enumerate(story_paragraphs):
                text = (paragraph.text or "").strip()
                if text:
                    items.append(
                        {"index": index, "text": _truncate(text, _MAX_PARAGRAPH_CHARS)}
                    )
            target.append(
                {
                    "section": section_index,
                    "paragraph_count": len(story_paragraphs),
                    "paragraphs": items,
                }
            )

    return {
        "paragraph_count": len(document.paragraphs),
        "table_count": len(document.tables),
        "section_count": len(document.sections),
        "paragraphs": paragraphs,
        "tables": tables,
        "headers": headers,
        "footers": footers,
        "truncated": truncated,
    }


# --------------------------------------------------------------------------- #
# AI 计划
# --------------------------------------------------------------------------- #
_PLAN_PROMPT = """你是安全运营报告模板工程师。下面是一份**已有 Word 报告**的结构快照，\
按 python-docx 的位置索引描述正文段落、页眉页脚与表格。请找出其中每次运行都会变化的\
动态数据（统计数值、日期、周期、比例、资产名、列表项等），输出把它改造成模板的\
**JSON 计划**。固定文案、章节标题、固定表头必须原样保留，不要改写或删减。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{{
  "replacements": [
    {{"kind": "paragraph", "index": 12, "find": "37", "token": "summary.total_alert",
      "occurrence": 1}}
  ],
  "tables": [
    {{"index": 0, "header_row": 0, "data_row": 1, "remove_rows": [2, 3],
      "loop_token": "table.vuln",
      "columns": [{{"label": "资产", "key": "asset"}}, {{"label": "等级", "key": "level"}}]}}
  ],
  "warnings": ["无法确定的内容"]
}}

规则：
1. replacements.kind 只能是 paragraph / header / footer / table_cell。
2. paragraph / header / footer 用 index 定位；header / footer 还需给 section；\
table_cell 用 table / row / col 定位。
3. find 必须是该位置原文中**逐字连续出现**的文字，只截取动态值本身（数字、日期、名称等），\
不要包含整句；同一段落内相同文字出现多次时，分别用 occurrence 1、2、3 指向对应出现，\
同一 find 与 occurrence 只能对应一个 token。
4. token 全小写，格式「域.指标」，至少两段，仅含字母、数字、下划线，例如 \
summary.total_alert、vuln.high_count、period.start_date；同一指标多处出现必须复用同一个 token。
5. 不要替换章节标题、固定说明文字和表头；除占位符外不得增删或改写内容。
6. 表格：header_row 为表头行，data_row 为任意一条示例数据行，remove_rows 列出其余\
示例数据行（保留合计、备注等固定行）；columns 的 label 必须与表头文字完全一致，\
key 为小写蛇形英文列名。
7. 结构快照可能被截断（truncated 为 true），只能引用快照中实际出现的位置。
8. 无法确定是否动态的内容不要替换，写入 warnings（最多 20 条）。
9. 至少输出一个 replacement 或一个 table；只输出 JSON 对象。

用户补充要求：{hint}

报告结构快照：
{structure}
"""


def _plan_error(message: str, **extra: Any) -> None:
    raise ReportError(AI_BAD_OUTPUT, f"无法套用 AI 计划：{message}", extra or None)


def _int_field(value: Any, label: str, default: int | None = None) -> int:
    if value is None:
        if default is not None:
            return default
        raise ReportError(AI_BAD_OUTPUT, f"AI 计划缺少 {label}")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ReportError(AI_BAD_OUTPUT, f"AI 计划中的 {label} 必须是整数") from exc


def _entry_text(structure: dict, entry: dict) -> str:
    """返回替换位置的可检索文本，用于重复原文自动分配 occurrence。"""
    kind = entry.get("kind")
    if kind == "table_cell":
        tables = structure.get("tables") or []
        table_index = entry.get("table")
        if not isinstance(table_index, int) or not (0 <= table_index < len(tables)):
            return ""
        rows = tables[table_index].get("rows") or []
        row_index = entry.get("row")
        if not isinstance(row_index, int) or not (0 <= row_index < len(rows)):
            return ""
        row = rows[row_index]
        col_index = entry.get("col")
        if not isinstance(col_index, int) or not (0 <= col_index < len(row)):
            return ""
        return row[col_index]

    stories = structure.get(
        "headers" if kind == "header" else "footers" if kind == "footer" else ""
    )
    if stories:
        story = next(
            (
                candidate
                for candidate in stories
                if candidate.get("section") == entry.get("section")
            ),
            None,
        )
        if story is None:
            return ""
        paragraphs = story.get("paragraphs") or []
    else:
        paragraphs = structure.get("paragraphs") or []
    paragraph = next(
        (
            candidate
            for candidate in paragraphs
            if candidate.get("index") == entry.get("index")
        ),
        None,
    )
    return (paragraph or {}).get("text") or ""


def _sanitize_replacements(
    raw: Any, structure: dict, warnings: list[str]
) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ReportError(AI_BAD_OUTPUT, "AI 计划中的 replacements 必须是数组")

    paragraph_count = int(structure.get("paragraph_count") or 0)
    section_count = int(structure.get("section_count") or 0)
    tables = structure.get("tables") or []
    stories = {"header": structure.get("headers") or [], "footer": structure.get("footers") or []}

    result: list[dict] = []
    seen: dict[tuple, str] = {}
    usage: dict[tuple, set[int]] = {}
    for position, item in enumerate(raw):
        if not isinstance(item, dict):
            warnings.append(f"忽略第 {position + 1} 个非法替换项")
            continue

        kind = str(item.get("kind") or "paragraph").strip().lower()
        if kind not in _REPLACEMENT_KINDS:
            raise ReportError(
                AI_BAD_OUTPUT,
                f"不支持的替换位置类型: {kind}（可选 paragraph/header/footer/table_cell）",
            )
        token = normalize_token(item.get("token"))
        if not is_valid_token(token):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"占位符命名不规范（应形如 summary.total_alert）: {item.get('token') or '(空)'}",
            )
        find = str(item.get("find") or "")
        occurrence = _int_field(item.get("occurrence"), "occurrence", default=1)
        if occurrence < 1:
            raise ReportError(AI_BAD_OUTPUT, "occurrence 必须从 1 开始")

        entry: dict[str, Any] = {
            "kind": kind,
            "token": token,
            "find": find,
            "occurrence": occurrence,
        }
        if kind == "table_cell":
            table_index = _int_field(item.get("table"), "table")
            row_index = _int_field(item.get("row"), "row")
            col_index = _int_field(item.get("col"), "col")
            if not (0 <= table_index < len(tables)):
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 index 越界: {table_index}（结构快照共 {len(tables)} 个表格）",
                )
            table = tables[table_index]
            row_count = int(table.get("row_count") or 0)
            if not (0 <= row_index < row_count):
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{table_index} 行 index 越界: {row_index}（共 {row_count} 行）",
                )
            rows = table.get("rows") or []
            if row_index >= len(rows):
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{table_index} 行 {row_index} 超出结构快照范围（结构已截断）",
                )
            if not (0 <= col_index < len(rows[row_index])):
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{table_index} 行 {row_index} 列 index 越界: {col_index}",
                )
            cell_text = rows[row_index][col_index]
            if find and find not in cell_text:
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{table_index} 行 {row_index} 列 {col_index} 未找到文本 {find!r}",
                    {"cell_text": cell_text},
                )
            entry.update({"table": table_index, "row": row_index, "col": col_index})
        else:
            index = _int_field(item.get("index"), "index")
            if kind in stories:
                section = _int_field(item.get("section"), "section", default=0)
                if not (0 <= section < section_count):
                    raise ReportError(AI_BAD_OUTPUT, f"section 越界: {section}")
                story = next(
                    (
                        candidate
                        for candidate in stories[kind]
                        if candidate.get("section") == section
                    ),
                    None,
                )
                if story is None or not (
                    0 <= index < int(story.get("paragraph_count") or 0)
                ):
                    raise ReportError(
                        AI_BAD_OUTPUT,
                        f"{'页眉' if kind == 'header' else '页脚'}段落 index 越界: {index}",
                    )
                entry["section"] = section
            elif not (0 <= index < paragraph_count):
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"正文段落 index 越界: {index}（共 {paragraph_count} 段）",
                )
            entry["index"] = index
            if not find.strip():
                raise ReportError(AI_BAD_OUTPUT, "非表格单元格的替换必须提供 find 原文")

        base_key = (
            kind,
            entry.get("section"),
            entry.get("index"),
            entry.get("table"),
            entry.get("row"),
            entry.get("col"),
            find,
        )
        key = (*base_key, occurrence)
        if key in seen:
            # 模型对同一段重复原文常给出相同 occurrence：能定位到后续出现时自动顺延，
            # 否则保留首个 token 并告警，避免整个生成流程被一个计划瑕疵阻断。
            used = usage.setdefault(base_key, {occurrence})
            text = _entry_text(structure, entry)
            total = text.count(find) if find and text else 0
            next_occurrence = next(
                (
                    candidate
                    for candidate in range(occurrence + 1, total + 1)
                    if candidate not in used
                ),
                None,
            )
            if next_occurrence is not None:
                warnings.append(
                    f"同一位置重复规划原文 {find!r}，已自动分配到第 "
                    f"{next_occurrence} 次出现（{token}）"
                )
                entry["occurrence"] = next_occurrence
                seen[(*base_key, next_occurrence)] = token
                used.add(next_occurrence)
                result.append(entry)
            else:
                warnings.append(
                    f"同一位置出现多个占位符，已保留 {seen[key]}，忽略 {token}"
                )
            continue
        seen[key] = token
        usage.setdefault(base_key, set()).add(occurrence)
        result.append(entry)
    return result


def _column_pairs(raw: Any) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    if isinstance(raw, dict):
        pairs = [(str(label), str(key)) for label, key in raw.items()]
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                pairs.append(
                    (str(item.get("label") or ""), str(item.get("key") or ""))
                )
    return pairs


def _sanitize_tables(raw: Any, structure: dict, warnings: list[str]) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ReportError(AI_BAD_OUTPUT, "AI 计划中的 tables 必须是数组")

    tables = structure.get("tables") or []
    result: list[dict] = []
    loop_tokens: set[str] = set()
    for position, item in enumerate(raw):
        if not isinstance(item, dict):
            warnings.append(f"忽略第 {position + 1} 个非法表格项")
            continue

        index = _int_field(item.get("index"), "tables.index")
        if not (0 <= index < len(tables)):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"表格 index 越界: {index}（结构快照共 {len(tables)} 个表格）",
            )
        table = tables[index]
        rows = table.get("rows") or []
        row_count = int(table.get("row_count") or len(rows))
        header_row = _int_field(item.get("header_row"), "header_row", default=0)
        data_row = _int_field(item.get("data_row"), "data_row")
        if not (0 <= header_row < len(rows)):
            raise ReportError(AI_BAD_OUTPUT, f"表格 #{index} header_row 越界: {header_row}")
        if not (0 <= data_row < row_count):
            raise ReportError(AI_BAD_OUTPUT, f"表格 #{index} data_row 越界: {data_row}")
        if data_row >= len(rows):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"表格 #{index} data_row {data_row} 超出结构快照范围（结构已截断）",
            )
        if data_row == header_row:
            raise ReportError(AI_BAD_OUTPUT, "data_row 不能等于 header_row")

        loop_token = normalize_token(
            item.get("loop_token") or item.get("token")
        )
        if not is_valid_token(loop_token):
            raise ReportError(
                AI_BAD_OUTPUT,
                f"表格循环 token 不规范（应形如 table.vuln）: {loop_token or '(空)'}",
            )
        if loop_token in loop_tokens:
            raise ReportError(AI_BAD_OUTPUT, f"表格循环 token 重复: {loop_token}")
        loop_tokens.add(loop_token)

        raw_remove = item.get("remove_rows") or []
        if not isinstance(raw_remove, list):
            raise ReportError(AI_BAD_OUTPUT, "remove_rows 必须是数组")
        remove_rows = sorted(
            {_int_field(value, "remove_rows") for value in raw_remove}
        )
        for row_index in remove_rows:
            if row_index in {header_row, data_row}:
                raise ReportError(
                    AI_BAD_OUTPUT, "remove_rows 不能包含 header_row 或 data_row"
                )
            if not (0 <= row_index < row_count):
                raise ReportError(
                    AI_BAD_OUTPUT, f"表格 #{index} remove_rows 越界: {row_index}"
                )

        pairs = _column_pairs(item.get("columns") or item.get("column_map"))
        if not pairs:
            raise ReportError(AI_BAD_OUTPUT, f"表格 #{index} 缺少列映射 columns")
        header_cells = rows[header_row]
        columns: list[dict] = []
        used_keys: set[str] = set()
        used_cols: set[int] = set()
        for label, key in pairs:
            key = key.strip()
            if not _COLUMN_KEY_RE.match(key):
                raise ReportError(
                    AI_BAD_OUTPUT, f"表格列 key 必须是小写蛇形命名: {key!r}"
                )
            if key in used_keys:
                raise ReportError(AI_BAD_OUTPUT, f"表格 #{index} 列 key 重复: {key}")
            normalized_label = " ".join(label.split())
            matches = [
                col
                for col, header in enumerate(header_cells)
                if " ".join(header.split()) == normalized_label
            ]
            if not matches:
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{index} 未找到表头 {label!r}",
                    {"headers": header_cells},
                )
            if matches[0] in used_cols:
                raise ReportError(
                    AI_BAD_OUTPUT,
                    f"表格 #{index} 多个列映射到同一表头: {label!r}",
                )
            used_keys.add(key)
            used_cols.add(matches[0])
            columns.append({"label": normalized_label, "key": key})

        remaining = [
            row_index
            for row_index in range(data_row + 1, row_count)
            if row_index not in remove_rows
        ]
        if remaining:
            warnings.append(
                f"表格 #{index} 样例行之后仍有 {len(remaining)} 行未移除，渲染时会保留为固定行"
            )

        result.append(
            {
                "index": index,
                "header_row": header_row,
                "data_row": data_row,
                "remove_rows": remove_rows,
                "loop_token": loop_token,
                "columns": columns,
            }
        )
    return result


def sanitize_plan(raw: Any, structure: dict) -> dict:
    """校验并规整 AI 输出的计划；任何不合法项直接拒绝，避免生成坏模板。"""
    if not isinstance(raw, dict):
        raise ReportError(AI_BAD_OUTPUT, "AI 输出必须是 JSON 对象")

    warnings: list[str] = []
    raw_warnings = raw.get("warnings")
    if isinstance(raw_warnings, list):
        warnings.extend(
            str(item).strip() for item in raw_warnings if str(item).strip()
        )

    replacements = _sanitize_replacements(raw.get("replacements"), structure, warnings)
    tables = _sanitize_tables(raw.get("tables"), structure, warnings)
    if not replacements and not tables:
        raise ReportError(AI_BAD_OUTPUT, "AI 未识别到任何可替换的动态数据")

    scalar_tokens = {item["token"] for item in replacements}
    loop_tokens = {item["loop_token"] for item in tables}
    overlap = scalar_tokens & loop_tokens
    if overlap:
        raise ReportError(
            AI_BAD_OUTPUT, f"标量占位符与表格循环 token 冲突: {sorted(overlap)}"
        )

    tokens = sorted(scalar_tokens | loop_tokens)
    for token in tokens:
        parts = token.split(".")
        for depth in range(1, len(parts)):
            prefix = ".".join(parts[:depth])
            if prefix in tokens:
                raise ReportError(
                    AI_BAD_OUTPUT, f"占位符前缀冲突: {prefix} 与 {token}"
                )

    return {
        "replacements": replacements,
        "tables": tables,
        "warnings": warnings[:_MAX_WARNINGS],
        "stats": {
            "replacements": len(replacements),
            "tables": len(tables),
            "tokens": len(tokens),
        },
    }


async def generate_plan(llm, structure: dict, *, hint: str = "") -> dict:
    """调用 LLM 生成占位符计划并校验。"""
    from app.report import ai as ai_module

    prompt = _PLAN_PROMPT.format(
        hint=(hint or "").strip() or "无",
        structure=json.dumps(structure, ensure_ascii=False, indent=1),
    )
    raw = await ai_module._chat_json(llm, prompt)
    return sanitize_plan(raw, structure)


def plan_tokens(plan: dict) -> list[str]:
    """计划中声明的全部 token（用于生成后与 manifest 对照）。"""
    tokens = {
        normalize_token(item.get("token"))
        for item in plan.get("replacements") or []
        if isinstance(item, dict)
    }
    tokens |= {
        normalize_token(item.get("loop_token"))
        for item in plan.get("tables") or []
        if isinstance(item, dict)
    }
    return sorted(token for token in tokens if token)


# --------------------------------------------------------------------------- #
# 原位套用计划
# --------------------------------------------------------------------------- #
def _set_cell_text(cell, text: str) -> None:
    """保留首个 run 的格式写入文本，清空其余段落。"""
    paragraphs = list(cell.paragraphs)
    if not paragraphs:
        cell.text = text
        return
    first = paragraphs[0]
    runs = list(first.runs)
    if runs:
        runs[0].text = text
        for run in runs[1:]:
            run.text = ""
    else:
        first.add_run(text)
    for paragraph in paragraphs[1:]:
        element = paragraph._element
        parent = element.getparent()
        if parent is not None:
            parent.remove(element)


def _replace_in_paragraph(
    paragraph, find: str, replacement: str, occurrence: int = 1
) -> bool:
    """跨 run 精确替换，保留首个命中 run 的格式。"""
    runs = list(paragraph.runs)
    full_text = "".join(run.text for run in runs)
    position = 0
    start = -1
    for _ in range(max(occurrence, 1)):
        start = full_text.find(find, position)
        if start < 0:
            return False
        position = start + len(find)
    end = start + len(find)

    offset = 0
    replaced = False
    for run in runs:
        run_start = offset
        run_end = offset + len(run.text)
        offset = run_end
        if run_end <= start or run_start >= end:
            continue
        local_start = max(start - run_start, 0)
        local_end = min(end - run_start, len(run.text))
        if not replaced:
            run.text = run.text[:local_start] + replacement + run.text[local_end:]
            replaced = True
        else:
            run.text = run.text[:local_start] + run.text[local_end:]
    return replaced


def _apply_replacement(document, item: dict) -> None:
    token = normalize_token(item.get("token"))
    if not is_valid_token(token):
        _plan_error(f"token 命名不规范: {token!r}")
    kind = item.get("kind") or "paragraph"
    occurrence = int(item.get("occurrence") or 1)
    find = str(item.get("find") or "")
    replacement = "{{ " + token + " }}"

    if kind == "table_cell":
        table_index = int(item.get("table", -1))
        row_index = int(item.get("row", -1))
        col_index = int(item.get("col", -1))
        if not (0 <= table_index < len(document.tables)):
            _plan_error(f"表格 index 越界: {table_index}")
        table = document.tables[table_index]
        if not (0 <= row_index < len(table.rows)):
            _plan_error(f"表格 #{table_index} 行 index 越界: {row_index}")
        row = table.rows[row_index]
        if not (0 <= col_index < len(row.cells)):
            _plan_error(f"表格 #{table_index} 行 #{row_index} 列 index 越界: {col_index}")
        cell = row.cells[col_index]
        if not find:
            _set_cell_text(cell, replacement)
            return
        for paragraph in cell.paragraphs:
            if _replace_in_paragraph(paragraph, find, replacement, occurrence):
                return
        _plan_error(
            f"表格 #{table_index} 行 #{row_index} 列 #{col_index} 未找到文本 {find!r}",
            cell_text="\n".join(p.text for p in cell.paragraphs),
        )

    if kind in {"header", "footer"}:
        section_index = int(item.get("section", 0))
        if not (0 <= section_index < len(document.sections)):
            _plan_error(f"section 越界: {section_index}")
        section = document.sections[section_index]
        story = section.header if kind == "header" else section.footer
        paragraphs = list(story.paragraphs)
        label = "页眉" if kind == "header" else "页脚"
    else:
        paragraphs = list(document.paragraphs)
        label = "正文"
    index = int(item.get("index", -1))
    if not (0 <= index < len(paragraphs)):
        _plan_error(f"{label}段落 index 越界: {index}")
    paragraph = paragraphs[index]
    if not _replace_in_paragraph(paragraph, find, replacement, occurrence):
        _plan_error(
            f"{label}段落 #{index} 未找到文本 {find!r}",
            paragraph=paragraph.text,
        )


def _apply_table_loop(document, spec: dict) -> None:
    token = normalize_token(spec.get("loop_token"))
    if not is_valid_token(token):
        _plan_error(f"表格循环 token 命名不规范: {token!r}")
    table_index = int(spec.get("index", -1))
    if not (0 <= table_index < len(document.tables)):
        _plan_error(f"表格 index 越界: {table_index}")
    table = document.tables[table_index]

    header_row = int(spec.get("header_row", 0))
    data_row = int(spec.get("data_row", -1))
    if not (0 <= header_row < len(table.rows)):
        _plan_error(f"表格 #{table_index} header_row 越界: {header_row}")
    if not (0 <= data_row < len(table.rows)):
        _plan_error(f"表格 #{table_index} data_row 越界: {data_row}")
    if data_row == header_row:
        _plan_error(f"表格 #{table_index} 的 data_row 不能等于 header_row")

    columns = spec.get("columns") or []
    if not isinstance(columns, list) or not columns:
        _plan_error(f"表格 #{table_index} 未配置 columns")
    headers = [_cell_text(cell) for cell in table.rows[header_row].cells]
    mapping: dict[int, str] = {}
    for column in columns:
        label = " ".join(str(column.get("label") or "").split())
        key = str(column.get("key") or "").strip()
        if not _COLUMN_KEY_RE.match(key):
            _plan_error(f"表格列 key 必须是小写蛇形命名: {key!r}")
        matches = [
            index
            for index, header in enumerate(headers)
            if " ".join(header.split()) == label
        ]
        if not matches:
            _plan_error(
                f"表格 #{table_index} 未找到表头 {label!r}",
                headers=headers,
            )
        mapping[matches[0]] = key
    if len(set(mapping.values())) != len(mapping):
        _plan_error(f"表格 #{table_index} 的 columns 存在重复 key")

    remove_rows = sorted(
        {int(item) for item in spec.get("remove_rows") or []}, reverse=True
    )
    for row_index in remove_rows:
        if row_index in {header_row, data_row}:
            _plan_error(f"remove_rows 不能包含 header_row/data_row: {row_index}")
        if not (0 <= row_index < len(table.rows)):
            _plan_error(f"表格 #{table_index} remove_rows 越界: {row_index}")
        table._tbl.remove(table.rows[row_index]._tr)
    data_row -= sum(1 for row_index in remove_rows if row_index < data_row)

    data = table.rows[data_row]
    for cell in data.cells:
        _set_cell_text(cell, "")
    for col_index, key in mapping.items():
        _set_cell_text(data.cells[col_index], "{{ r." + key + " }}")

    start_tr = copy.deepcopy(data._tr)
    data._tr.addprevious(start_tr)
    end_tr = copy.deepcopy(data._tr)
    data._tr.addnext(end_tr)

    start_row = table.rows[data_row]
    end_row = table.rows[data_row + 2]
    for cell in start_row.cells:
        _set_cell_text(cell, "")
    for cell in end_row.cells:
        _set_cell_text(cell, "")
    _set_cell_text(start_row.cells[0], "{%tr for r in " + token + " %}")
    _set_cell_text(end_row.cells[0], "{%tr endfor %}")


def _replacement_order(item: dict) -> tuple:
    """同一位置先替换靠后的 occurrence，避免前一次替换改变后续出现的位置。

    例如段落中有两个 "12"，先写 occurrence=2 再写 occurrence=1，
    否则第一次替换后第二个 "12" 会变成第 1 次出现，导致计划错位。
    """
    return (
        str(item.get("kind") or "paragraph"),
        int(item.get("section") or 0),
        int(item.get("index", -1)),
        int(item.get("table", -1)),
        int(item.get("row", -1)),
        int(item.get("col", -1)),
        -len(str(item.get("find") or "")),
        -int(item.get("occurrence") or 1),
    )


def apply_plan(docx_bytes: bytes, plan: dict) -> bytes:
    """按计划在原文档上写入占位符，返回新的 docx 字节。"""
    try:
        from docx import Document

        document = Document(io.BytesIO(docx_bytes))
    except Exception as exc:  # noqa: BLE001
        raise ReportError(TPL_PARSE, f"Word 报告解析失败: {exc}") from exc

    replacements = plan.get("replacements") or []
    for item in replacements:
        if not isinstance(item, dict):
            _plan_error("replacements 数组元素必须是对象")
    for item in sorted(replacements, key=_replacement_order):
        _apply_replacement(document, item)
    for item in plan.get("tables") or []:
        if not isinstance(item, dict):
            _plan_error("tables 数组元素必须是对象")
        _apply_table_loop(document, item)

    output = io.BytesIO()
    document.save(output)
    return output.getvalue()
