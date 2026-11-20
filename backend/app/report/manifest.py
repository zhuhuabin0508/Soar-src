"""Word 模板解析：从 docx 中提取占位符、表格循环与章节结构。

约定（写入模板的占位符语法）：
- 标量：``{{ summary.total_alert }}``
- 表格循环（docxtpl 原生语法）::

      | 资产 | 等级 |
      | {%tr for r in table.vuln %} | |
      | {{ r.asset }} | {{ r.level }} |
      | {%tr endfor %} | |

  ``{%tr for ... %}`` 与 ``{%tr endfor %}`` 所在行渲染时会被移除，
  循环体内的 ``{{ r.列名 }}`` 会被登记为该表格占位符的列。

解析结果写入 ``report_template_versions.manifest_json``，是映射配置的唯一契约。
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

from app.report.errors import (
    TPL_PARSE,
    TPL_UPLOAD_INVALID,
    ReportError,
)
from app.report.spec import (
    FORMAT_VERSION,
    infer_placeholder_type,
    normalize_token,
    slugify_token,
)

TOKEN_TEXT_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")
LOOP_FOR_RE = re.compile(r"\{%\s*tr\s+for\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_][\w.]*)\s*%\}")
LOOP_END_RE = re.compile(r"\{%\s*tr\s+endfor\s*%\}")
SECTION_RE = re.compile(r"^(?:[一二三四五六七八九十百]+、|第[一二三四五六七八九十\d]+[章节部分])")

MAX_DOCX_BYTES = 50 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200


def _paragraph_text(paragraph) -> str:
    """读取段落全部文本（含内容控件内的 w:t，避免漏掉 sdt 占位符）。"""
    from docx.oxml.ns import qn

    return "".join(node.text or "" for node in paragraph._p.iter(qn("w:t")))


def _row_text(row) -> str:
    return "\n".join(
        _paragraph_text(paragraph)
        for cell in row.cells
        for paragraph in cell.paragraphs
    )


def _dedupe_locations(locations: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result: list[dict] = []
    for location in locations:
        key = json.dumps(location, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.add(key)
            result.append(location)
    return result


def _add_placeholder(
    placeholders: dict[str, dict],
    token: str,
    *,
    location: dict,
    ptype: str | None = None,
    label: str | None = None,
    columns: list[dict] | None = None,
    required: bool = True,
) -> None:
    """登记占位符；同一 token 多次出现时合并位置。"""
    token = normalize_token(token)
    if not token:
        return
    existing = placeholders.get(token)
    if existing is not None:
        existing["locations"] = _dedupe_locations(existing["locations"] + [location])
        # 已有表格定义时不被后续标量出现覆盖
        if existing.get("type") == "table":
            return
        if ptype == "table":
            existing["type"] = "table"
            existing["columns"] = columns or []
        return
    placeholders[token] = {
        "id": slugify_token(token),
        "token": token,
        "label": label or token,
        "type": ptype or infer_placeholder_type(token),
        "required": required,
        "locations": [location],
    }
    if ptype == "table":
        placeholders[token]["columns"] = columns or []
        placeholders[token]["max_rows"] = 200


def _extract_table(
    table,
    table_index: int,
    placeholders: dict[str, dict],
    warnings: list[str],
) -> None:
    rows = list(table.rows)
    if not rows:
        return
    row_texts = [_row_text(row) for row in rows]

    loop_start = None
    loop_match = None
    for index, text in enumerate(row_texts):
        match = LOOP_FOR_RE.search(text)
        if match:
            loop_start = index
            loop_match = match
            break

    if loop_start is None:
        # 无循环：表格单元格内的 token 按标量占位符处理
        for r_index, row in enumerate(rows):
            for c_index, cell in enumerate(row.cells):
                text = "\n".join(_paragraph_text(p) for p in cell.paragraphs)
                for token in TOKEN_TEXT_RE.findall(text):
                    _add_placeholder(
                        placeholders,
                        token,
                        location={
                            "kind": "table_cell",
                            "table": table_index,
                            "row": r_index,
                            "col": c_index,
                        },
                    )
        return

    assert loop_match is not None
    alias = loop_match.group(1)
    token = normalize_token(loop_match.group(2))
    if not token:
        warnings.append(f"表格 #{table_index} 的循环语句缺少数据变量名")
        return

    loop_end = None
    for index in range(loop_start + 1, len(row_texts)):
        if LOOP_END_RE.search(row_texts[index]):
            loop_end = index
            break
    if loop_end is None:
        warnings.append(
            f"表格 #{table_index} 的循环 {token} 缺少 {{%tr endfor%}}，已按表格末尾处理"
        )
        loop_end = len(row_texts)

    column_keys: list[str] = []
    for index in range(loop_start + 1, loop_end):
        for column in re.findall(
            rf"\{{\{{\s*{re.escape(alias)}\.([A-Za-z_]\w*)\s*\}}\}}",
            row_texts[index],
        ):
            if column not in column_keys:
                column_keys.append(column)

    # 表头：循环起始行的上一行；无则用循环首行本身
    header_labels: list[str] = []
    header_index = loop_start - 1
    if header_index >= 0:
        header_labels = [
            _paragraph_text(p).strip()
            for cell in rows[header_index].cells
            for p in cell.paragraphs
        ]
        header_labels = [label for label in header_labels if label]

    columns = []
    for position, key in enumerate(column_keys):
        label = (
            header_labels[position]
            if position < len(header_labels)
            else key
        )
        columns.append({"key": key, "label": label, "type": infer_placeholder_type(key)})

    if not columns:
        warnings.append(
            f"表格 #{table_index} 的循环 {token} 未发现 {alias}.列名 形式的列占位符"
        )

    _add_placeholder(
        placeholders,
        token,
        location={
            "kind": "table_loop",
            "table": table_index,
            "start_row": loop_start,
            "end_row": loop_end,
        },
        ptype="table",
        label=token,
        columns=columns,
        required=True,
    )

    # 循环区域之外的表格 token 仍按标量处理
    for r_index, row in enumerate(rows):
        if loop_start <= r_index <= loop_end:
            continue
        for c_index, cell in enumerate(row.cells):
            text = "\n".join(_paragraph_text(p) for p in cell.paragraphs)
            for other in TOKEN_TEXT_RE.findall(text):
                _add_placeholder(
                    placeholders,
                    other,
                    location={
                        "kind": "table_cell",
                        "table": table_index,
                        "row": r_index,
                        "col": c_index,
                    },
                )


def _parse_story(paragraphs, placeholders: dict[str, dict], location_kind: str) -> None:
    """解析页眉/页脚等 story 中的占位符。"""
    for index, paragraph in enumerate(paragraphs):
        for token in TOKEN_TEXT_RE.findall(_paragraph_text(paragraph)):
            _add_placeholder(
                placeholders,
                token,
                location={"kind": location_kind, "index": index},
            )


def extract_manifest(docx_bytes: bytes) -> dict:
    """解析 docx，返回 manifest（章节、占位符、告警）。

    Raises:
        ReportError: 文件不是合法 docx 或无法打开。
    """
    try:
        from docx import Document

        document = Document(io.BytesIO(docx_bytes))
    except Exception as exc:  # noqa: BLE001
        raise ReportError(TPL_PARSE, f"Word 模板解析失败: {exc}") from exc

    placeholders: dict[str, dict] = {}
    warnings: list[str] = []
    sections: list[dict] = []

    # 正文段落：标题识别 + 标量占位符
    body_paragraphs = list(document.paragraphs)
    for index, paragraph in enumerate(body_paragraphs):
        text = _paragraph_text(paragraph).strip()
        if not text:
            continue
        style_name = (paragraph.style.name if paragraph.style is not None else "") or ""
        is_heading = style_name.lower().startswith(("heading", "标题")) or bool(
            SECTION_RE.match(text)
        )
        if is_heading and len(text) <= 120:
            sections.append(
                {
                    "id": f"s{len(sections) + 1}",
                    "title": text,
                    "required": True,
                }
            )
        for token in TOKEN_TEXT_RE.findall(text):
            _add_placeholder(
                placeholders,
                token,
                location={"kind": "paragraph", "index": index},
            )

    # 表格：循环区域与普通单元格
    for table_index, table in enumerate(document.tables):
        try:
            _extract_table(table, table_index, placeholders, warnings)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"表格 #{table_index} 解析失败: {exc}")

    # 页眉/页脚
    for section in document.sections:
        for story_name, story in (
            ("header", section.header),
            ("footer", section.footer),
        ):
            try:
                _parse_story(story.paragraphs, placeholders, story_name)
                for table in story.tables:
                    _extract_table(table, -1, placeholders, warnings)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"{story_name} 解析失败: {exc}")

    # 表格占位符补齐 columns 类型推断
    for item in placeholders.values():
        if item.get("type") == "table":
            for column in item.get("columns", []):
                column.setdefault("type", infer_placeholder_type(column.get("key", "")))

    return {
        "format_version": FORMAT_VERSION,
        "sections": sections,
        "placeholders": list(placeholders.values()),
        "warnings": warnings,
        "stats": {
            "paragraphs": len(body_paragraphs),
            "tables": len(document.tables),
            "placeholder_count": len(placeholders),
        },
    }


def diff_manifests(old: dict | None, new: dict | None) -> dict:
    """对比两份 manifest，输出占位符与章节级差异（供版本升级与迁移向导）。"""
    old = old or {}
    new = new or {}
    old_map = {
        normalize_token(item.get("token")): item
        for item in old.get("placeholders", [])
        if isinstance(item, dict)
    }
    new_map = {
        normalize_token(item.get("token")): item
        for item in new.get("placeholders", [])
        if isinstance(item, dict)
    }

    added = sorted(set(new_map) - set(old_map))
    removed = sorted(set(old_map) - set(new_map))
    changed: list[dict] = []
    for token in sorted(set(old_map) & set(new_map)):
        before, after = old_map[token], new_map[token]
        fields: list[str] = []
        if before.get("type") != after.get("type"):
            fields.append("type")
        if bool(before.get("required")) != bool(after.get("required")):
            fields.append("required")
        if before.get("label") != after.get("label"):
            fields.append("label")
        old_columns = [c.get("key") for c in before.get("columns", []) if isinstance(c, dict)]
        new_columns = [c.get("key") for c in after.get("columns", []) if isinstance(c, dict)]
        if old_columns != new_columns:
            fields.append("columns")
        if fields:
            changed.append({"token": token, "fields": fields})

    old_sections = [str(s.get("title") or "") for s in old.get("sections", []) if isinstance(s, dict)]
    new_sections = [str(s.get("title") or "") for s in new.get("sections", []) if isinstance(s, dict)]

    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "sections": {
            "added": [title for title in new_sections if title not in old_sections],
            "removed": [title for title in old_sections if title not in new_sections],
        },
        "breaking": bool(removed or changed),
    }


def validate_docx_upload(filename: str, content: bytes) -> dict:
    """校验上传的 Word 模板，返回文件基本信息。

    拒绝：非 .docx、超大文件、宏文档、zip 路径穿越、异常压缩比、外部模板引用。
    """
    name = (filename or "").strip()
    lower = name.lower()
    if not lower.endswith(".docx"):
        raise ReportError(
            TPL_UPLOAD_INVALID,
            "仅支持 .docx 格式；.doc / .docm 请先另存为 .docx",
        )
    if not content:
        raise ReportError(TPL_UPLOAD_INVALID, "文件内容为空")
    if len(content) > MAX_DOCX_BYTES:
        raise ReportError(
            TPL_UPLOAD_INVALID,
            f"文件超过大小上限 {MAX_DOCX_BYTES // (1024 * 1024)}MB",
        )

    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ReportError(TPL_UPLOAD_INVALID, "文件不是合法的 docx（zip 结构损坏）") from exc

    with archive:
        names = archive.namelist()
        for entry in names:
            normalized = entry.replace("\\", "/")
            if normalized.startswith("/") or ".." in normalized.split("/"):
                raise ReportError(TPL_UPLOAD_INVALID, f"docx 内含非法路径: {entry}")
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise ReportError(TPL_UPLOAD_INVALID, "docx 结构不完整（缺少 document.xml）")
        if "word/vbaProject.bin" in names:
            raise ReportError(TPL_UPLOAD_INVALID, "不支持含宏的 Word 文档")

        uncompressed = sum(info.file_size for info in archive.infolist())
        if uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise ReportError(TPL_UPLOAD_INVALID, "docx 解压后体积过大")
        if content and uncompressed / max(len(content), 1) > MAX_COMPRESSION_RATIO:
            raise ReportError(TPL_UPLOAD_INVALID, "docx 压缩比异常，疑似 zip bomb")

        # 外部模板引用可能造成渲染时远程加载，直接拒绝
        rels_name = "word/_rels/document.xml.rels"
        if rels_name in names:
            rels = archive.read(rels_name).decode("utf-8", errors="ignore")
            if "attachedTemplate" in rels and "External" in rels:
                raise ReportError(
                    TPL_UPLOAD_INVALID,
                    "docx 引用了外部模板（attachedTemplate），请移除后重新上传",
                )

    return {
        "filename": name,
        "size": len(content),
        "uncompressed_size": uncompressed,
        "entry_count": len(names),
    }
