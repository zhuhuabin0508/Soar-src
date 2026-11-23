# -*- coding: utf-8 -*-
"""党政机关公文格式（GB/T 9704-2012）Word 版式。

供 ``generate_document`` 内置工具在 ``options={"style": "gb9704"}`` 时调用：

- 页面 A4，上 3.7cm / 下 3.5cm / 左 2.8cm / 右 2.6cm
- 全文固定行距 28 磅，每个段落首行缩进 2 字符
- 主标题 二号(22pt) 方正小标宋简体，居中
- 一级 三号 黑体；二级 三号 楷体_GB2312；三级/四级 三号 仿宋_GB2312
- 正文 三号 仿宋_GB2312，两端对齐

正文一行一段，不按 Markdown 合并段落：公文里「1.xxx」是三级标题编号，
若交给 Markdown 列表解析会变成「1. xxx」，编号与文字之间被插入空格。
"""

from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------- #
# 版式基线
# --------------------------------------------------------------------------- #
LINE_SPACING_PT = 28
INDENT_CHARS = 2

FONT_TITLE = "方正小标宋简体"
FONT_LEVEL_1 = "黑体"
FONT_LEVEL_2 = "楷体_GB2312"
FONT_BODY = "仿宋_GB2312"
FONT_CODE = "Courier New"

SIZE_TITLE_PT = 22
SIZE_LEVEL_PT = 16
SIZE_BODY_PT = 16
SIZE_TABLE_PT = 16
SIZE_CODE_PT = 10.5

PAGE_WIDTH_CM = 21.0
PAGE_HEIGHT_CM = 29.7
MARGIN_TOP_CM = 3.7
MARGIN_BOTTOM_CM = 3.5
MARGIN_LEFT_CM = 2.8
MARGIN_RIGHT_CM = 2.6

LEVEL_FONTS = {
    1: (FONT_LEVEL_1, SIZE_LEVEL_PT),
    2: (FONT_LEVEL_2, SIZE_LEVEL_PT),
    3: (FONT_BODY, SIZE_LEVEL_PT),
    4: (FONT_BODY, SIZE_LEVEL_PT),
}

_NUM = "一二三四五六七八九十百千零〇两"
_RE_LEVEL_1 = re.compile(rf"^[{_NUM}]+、")
_RE_LEVEL_2 = re.compile(rf"^[（(][{_NUM}]+[）)]")
_RE_LEVEL_4 = re.compile(r"^[（(]\d{1,2}[）)]")
_RE_LEVEL_3 = re.compile(r"^\d{1,2}[.．](?!\d)")
_RE_HEADING = re.compile(r"^(#{1,4})\s+(.+)$")
_RE_TABLE_SEP = re.compile(r"^\s*\|[\s:\-|]+\|?\s*$")

# 括号编号优先，避免「（一）」被判成一级、「（1）」被判成三级
_LEVEL_PATTERNS = (
    (2, _RE_LEVEL_2),
    (4, _RE_LEVEL_4),
    (3, _RE_LEVEL_3),
    (1, _RE_LEVEL_1),
)


def detect_level(text: str) -> int:
    """按行首编号识别公文层级：1~4 为标题层级，0 为正文。"""
    line = (text or "").strip()
    for level, pattern in _LEVEL_PATTERNS:
        if pattern.match(line):
            return level
    return 0


def _split_blocks(content: str) -> list[dict[str, Any]]:
    """逐行切分内容：每行一段，另识别 Markdown 标题与表格。"""
    lines = (content or "").splitlines()
    blocks: list[dict[str, Any]] = []
    i, total = 0, len(lines)
    while i < total:
        stripped = lines[i].strip()
        # 围栏代码块：保留原始缩进与空行，避免被当作正文段落拆散
        if stripped.startswith("```"):
            i += 1
            code_lines: list[str] = []
            while i < total and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i].rstrip())
                i += 1
            if i < total:
                i += 1
            while code_lines and not code_lines[0].strip():
                code_lines.pop(0)
            while code_lines and not code_lines[-1].strip():
                code_lines.pop()
            if code_lines:
                blocks.append({"kind": "code", "lines": code_lines})
            continue
        if not stripped:
            i += 1
            continue
        if stripped.startswith("|") and i + 1 < total and _RE_TABLE_SEP.match(lines[i + 1]):
            rows: list[list[str]] = []
            while i < total and lines[i].strip().startswith("|"):
                inner = lines[i].strip().strip("|")
                if not _RE_TABLE_SEP.match(f"|{inner}|"):
                    rows.append([cell.strip() for cell in inner.split("|")])
                i += 1
            if rows:
                blocks.append({"kind": "table", "rows": rows})
            continue
        match = _RE_HEADING.match(stripped)
        if match:
            blocks.append(
                {
                    "kind": "heading",
                    "level": len(match.group(1)),
                    "text": match.group(2).strip(),
                }
            )
        else:
            blocks.append({"kind": "paragraph", "text": stripped})
        i += 1
    return blocks


# --------------------------------------------------------------------------- #
# OOXML 细节
# --------------------------------------------------------------------------- #
def _set_fonts(rPr, cjk_font: str) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs"):
        rFonts.set(qn(attr), cjk_font)
    rFonts.set(qn("w:eastAsia"), cjk_font)


def _apply_line_spacing(paragraph) -> None:
    from docx.enum.text import WD_LINE_SPACING
    from docx.shared import Pt

    pf = paragraph.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.line_spacing = Pt(LINE_SPACING_PT)
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY


def _apply_indent(paragraph, chars: int, size_pt: float) -> None:
    from docx.oxml.ns import qn
    from docx.shared import Pt

    paragraph.paragraph_format.first_line_indent = Pt(max(chars, 0) * size_pt)
    ind = paragraph._p.get_or_add_pPr().find(qn("w:ind"))
    # 以字符为单位缩进，字号变化时仍是 N 个字符；标题显式写 0 覆盖样式继承
    ind.set(qn("w:firstLineChars"), str(int(max(chars, 0) * 100)))


def _apply_style_indent(style, chars: int, size_pt: float) -> None:
    """样式级首行缩进：未被显式设置缩进的段落也保持 2 字符缩进。"""
    from docx.oxml.ns import qn
    from docx.shared import Pt

    style.paragraph_format.first_line_indent = Pt(chars * size_pt)
    ind = style.element.get_or_add_pPr().find(qn("w:ind"))
    ind.set(qn("w:firstLineChars"), str(chars * 100))


def _style_run(run, cjk_font: str, size_pt: float) -> None:
    from docx.shared import Pt

    run.font.size = Pt(size_pt)
    run.font.bold = False
    run.font.name = cjk_font
    _set_fonts(run._element.get_or_add_rPr(), cjk_font)


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #
def _setup_document():
    from docx import Document
    from docx.shared import Cm, Pt

    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(PAGE_WIDTH_CM)
    section.page_height = Cm(PAGE_HEIGHT_CM)
    section.top_margin = Cm(MARGIN_TOP_CM)
    section.bottom_margin = Cm(MARGIN_BOTTOM_CM)
    section.left_margin = Cm(MARGIN_LEFT_CM)
    section.right_margin = Cm(MARGIN_RIGHT_CM)

    normal = doc.styles["Normal"]
    normal.font.name = FONT_BODY
    normal.font.size = Pt(SIZE_BODY_PT)
    _set_fonts(normal.element.get_or_add_rPr(), FONT_BODY)
    _apply_line_spacing(normal)
    _apply_style_indent(normal, INDENT_CHARS, SIZE_BODY_PT)
    return doc


def _add_paragraph(doc, text: str, font: str, size_pt: float, alignment, indent: int):
    paragraph = doc.add_paragraph()
    paragraph.alignment = alignment
    _apply_line_spacing(paragraph)
    _apply_indent(paragraph, indent, size_pt)
    _style_run(paragraph.add_run(text), font, size_pt)
    return paragraph


def _add_code_block(doc, lines: list[str]) -> None:
    """代码块：等宽字体、单倍行距、无首行缩进，保留原始缩进与换行。"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.text import WD_LINE_SPACING
    from docx.shared import Pt

    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf = paragraph.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.line_spacing = 1.0
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    _apply_indent(paragraph, 0, SIZE_CODE_PT)
    run = paragraph.add_run()
    _style_run(run, FONT_CODE, SIZE_CODE_PT)
    for index, line in enumerate(lines):
        if index:
            run.add_break()
        run.add_text(line)


def _add_table(doc, rows: list[list[str]]) -> None:
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    if not rows:
        return
    width = max(len(row) for row in rows)
    table = doc.add_table(rows=len(rows), cols=width)
    table.style = "Table Grid"
    for r, row in enumerate(rows):
        for c in range(width):
            paragraph = table.cell(r, c).paragraphs[0]
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            pf = paragraph.paragraph_format
            pf.space_before = Pt(0)
            pf.space_after = Pt(0)
            pf.line_spacing = 1.0
            # 表格单元格不缩进：同时清零 firstLine 与 firstLineChars，覆盖样式继承的 2 字符缩进
            _apply_indent(paragraph, 0, SIZE_TABLE_PT)
            _style_run(
                paragraph.add_run(row[c] if c < len(row) else ""), FONT_BODY, SIZE_TABLE_PT
            )


def build_gb9704_document(content: str, options: dict | None = None):
    """把公文正文渲染成符合 GB/T 9704 的 Document 对象。

    options:
        title: 主标题（公文必备，不传则不写标题行）
    """
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    opts = options or {}
    doc = _setup_document()

    title = str(opts.get("title") or "").strip()
    for line in title.splitlines():
        if line.strip():
            _add_paragraph(
                doc, line.strip(), FONT_TITLE, SIZE_TITLE_PT, WD_ALIGN_PARAGRAPH.CENTER, 0
            )

    for block in _split_blocks(content):
        if block["kind"] == "table":
            _add_table(doc, block["rows"])
            continue
        if block["kind"] == "code":
            _add_code_block(doc, block["lines"])
            continue
        text = block["text"]
        # 文本自带国标编号时以编号为准，否则用 Markdown 标题级别
        level = detect_level(text) or (block["level"] if block["kind"] == "heading" else 0)
        if level:
            font, size_pt = LEVEL_FONTS[level]
            _add_paragraph(
                doc, text, font, size_pt, WD_ALIGN_PARAGRAPH.LEFT, INDENT_CHARS
            )
        else:
            _add_paragraph(
                doc,
                text,
                FONT_BODY,
                SIZE_BODY_PT,
                WD_ALIGN_PARAGRAPH.JUSTIFY,
                INDENT_CHARS,
            )
    return doc
