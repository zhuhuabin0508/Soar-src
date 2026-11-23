# -*- coding: utf-8 -*-
"""党政机关公文格式（GB/T 9704-2012）Word 文档生成器。

格式基线
--------
页面    A4，上 3.7cm、下 3.5cm、左 2.8cm、右 2.6cm
行距    全文固定值 28 磅（lineRule=exact）
缩进    每个段落首行缩进 2 字符（firstLineChars=200，随字号自动缩放）
主标题  二号（22pt）方正小标宋简体，居中，不缩进
一级    三号（16pt）黑体，如「一、」
二级    三号（16pt）楷体_GB2312，如「（一）」
三级    三号（16pt）仿宋_GB2312，如「1.」
四级    三号（16pt）仿宋_GB2312，如「（1）」
正文    三号（16pt）仿宋_GB2312

命令行
------
    python gongwen.py 输入.txt -o 输出.docx --title 标题
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterator, Sequence

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

from rules import (
    FONT_BODY,
    FONT_TITLE,
    FOOTER_DISTANCE_CM,
    HEADER_DISTANCE_CM,
    INDENT_CHARS,
    LEVEL_FONTS,
    LINE_SPACING_PT,
    MARGIN_BOTTOM_CM,
    MARGIN_LEFT_CM,
    MARGIN_RIGHT_CM,
    MARGIN_TOP_CM,
    PAGE_HEIGHT_CM,
    PAGE_WIDTH_CM,
    SIZE_BODY_PT,
    SIZE_TITLE_PT,
    parse_line,
)


def _iter_lines(text: str) -> Iterator[str]:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            yield stripped


# --------------------------------------------------------------------------- #
# 底层格式写入
# --------------------------------------------------------------------------- #
def _set_east_asian_fonts(rPr, cjk_font: str, latin_font: str) -> None:
    """同时写入 ascii / hAnsi / eastAsia / cs 四个字体槽位。"""
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    rFonts.set(qn("w:ascii"), latin_font)
    rFonts.set(qn("w:hAnsi"), latin_font)
    rFonts.set(qn("w:eastAsia"), cjk_font)
    rFonts.set(qn("w:cs"), latin_font)


def _apply_first_line_chars(paragraph, chars: int, font_size_pt: float) -> None:
    """首行缩进，以字符为单位（firstLineChars），保证不同字号下都是 N 个字符。"""
    pf = paragraph.paragraph_format
    pf.first_line_indent = Pt(max(chars, 0) * font_size_pt)

    # 同时写 firstLineChars：既保证按字符缩放，也用 "0" 显式覆盖 Normal 样式继承的缩进
    ind = paragraph._p.get_or_add_pPr().find(qn("w:ind"))
    ind.set(qn("w:firstLineChars"), str(int(max(chars, 0) * 100)))


# --------------------------------------------------------------------------- #
# 生成器
# --------------------------------------------------------------------------- #
class GovDocBuilder:
    """按 GB/T 9704 格式逐段构建公文。"""

    def __init__(self, latin_font: str | None = None) -> None:
        self.latin_font = latin_font
        self.doc = Document()
        self._setup_page()
        self._setup_normal_style()

    # -- 页面与默认样式 ---------------------------------------------------- #
    def _setup_page(self) -> None:
        section = self.doc.sections[0]
        section.page_width = Cm(PAGE_WIDTH_CM)
        section.page_height = Cm(PAGE_HEIGHT_CM)
        section.top_margin = Cm(MARGIN_TOP_CM)
        section.bottom_margin = Cm(MARGIN_BOTTOM_CM)
        section.left_margin = Cm(MARGIN_LEFT_CM)
        section.right_margin = Cm(MARGIN_RIGHT_CM)
        section.header_distance = Cm(HEADER_DISTANCE_CM)
        section.footer_distance = Cm(FOOTER_DISTANCE_CM)

    def _setup_normal_style(self) -> None:
        style = self.doc.styles["Normal"]
        latin_font = self.latin_font or FONT_BODY
        style.font.size = Pt(SIZE_BODY_PT)
        style.font.name = latin_font
        _set_east_asian_fonts(style.element.get_or_add_rPr(), FONT_BODY, latin_font)

        pf = style.paragraph_format
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.line_spacing = Pt(LINE_SPACING_PT)
        pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        pf.first_line_indent = Pt(INDENT_CHARS * SIZE_BODY_PT)

        ind = style.element.pPr.find(qn("w:ind"))
        ind.set(qn("w:firstLineChars"), str(INDENT_CHARS * 100))

    # -- 段落 -------------------------------------------------------------- #
    def _format(
        self,
        paragraph,
        cjk_font: str,
        size_pt: int,
        alignment,
        indent_chars: int,
    ) -> None:
        pf = paragraph.paragraph_format
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.line_spacing = Pt(LINE_SPACING_PT)
        pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        paragraph.alignment = alignment
        _apply_first_line_chars(paragraph, indent_chars, size_pt)

        latin_font = self.latin_font or cjk_font
        for run in paragraph.runs:
            run.font.size = Pt(size_pt)
            run.font.bold = False  # 黑体/小标宋本身已足够醒目，不使用加粗
            run.font.name = latin_font
            _set_east_asian_fonts(run._element.get_or_add_rPr(), cjk_font, latin_font)

    def add_title(self, text: str) -> None:
        """主标题：二号方正小标宋简体，居中，不缩进。多行标题按行拆分。"""
        for line in _iter_lines(text):
            paragraph = self.doc.add_paragraph()
            paragraph.add_run(line)
            self._format(
                paragraph, FONT_TITLE, SIZE_TITLE_PT, WD_ALIGN_PARAGRAPH.CENTER, 0
            )

    def add_heading(self, text: str, level: int) -> None:
        if level not in LEVEL_FONTS:
            raise ValueError(f"标题层级必须是 1~4，收到 {level}")
        cjk_font, size_pt = LEVEL_FONTS[level]
        paragraph = self.doc.add_paragraph()
        paragraph.add_run(text.strip())
        self._format(
            paragraph, cjk_font, size_pt, WD_ALIGN_PARAGRAPH.LEFT, INDENT_CHARS
        )

    def add_body(self, text: str) -> None:
        paragraph = self.doc.add_paragraph()
        paragraph.add_run(text.strip())
        self._format(
            paragraph, FONT_BODY, SIZE_BODY_PT, WD_ALIGN_PARAGRAPH.JUSTIFY, INDENT_CHARS
        )

    def add_auto(self, text: str) -> int:
        """自动识别层级并写入，返回实际使用的层级（-1 标题 / 0 正文 / 1~4）。"""
        level, content = parse_line(text)
        if not content:
            return level
        if level < 0:
            self.add_title(content)
        elif level == 0:
            self.add_body(content)
        else:
            self.add_heading(content, level)
        return level

    # -- 输出 -------------------------------------------------------------- #
    def save(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self.doc.save(str(target))
        return target


def _non_empty_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def _skip_duplicated_title(lines: Sequence[str], title: str | None) -> list[str]:
    """已显式传入主标题时，跳过源文本开头与之重复的标题行。"""
    prepared = [line for line in lines if line.strip()]
    if not title or not prepared:
        return prepared
    first = prepared[0].strip().lstrip("#").strip()
    if first == title.strip():
        return prepared[1:]
    return prepared


def build_document(
    content_lines: Sequence[str],
    output: str | Path,
    title: str | None = None,
    latin_font: str | None = None,
) -> Path:
    """按行生成公文：先写标题，再逐行自动识别层级。"""
    builder = GovDocBuilder(latin_font=latin_font)
    if title:
        builder.add_title(title)
    for line in _skip_duplicated_title(content_lines, title):
        builder.add_auto(line)
    return builder.save(output)


# --------------------------------------------------------------------------- #
# 命令行
# --------------------------------------------------------------------------- #
def _read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"无法识别文件编码：{path}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="按党政机关公文格式（GB/T 9704-2012）生成 Word 文档"
    )
    parser.add_argument("input", help="源文本文件（UTF-8 / GBK），一行一段")
    parser.add_argument("-o", "--output", help="输出 .docx 路径")
    parser.add_argument("--title", help="主标题；未指定时取文本首行的一个 # 标题")
    parser.add_argument(
        "--latin-font",
        default=None,
        help="西文与数字字体，默认与中文正文字体一致",
    )
    args = parser.parse_args(argv)

    source = Path(args.input)
    if not source.is_file():
        raise SystemExit(f"文件不存在：{source}")

    output = Path(args.output) if args.output else source.with_name(
        f"{source.stem}_公文.docx"
    )

    builder = GovDocBuilder(latin_font=args.latin_font)
    if args.title:
        builder.add_title(args.title)

    for line in _skip_duplicated_title(_non_empty_lines(_read_text(source)), args.title):
        builder.add_auto(line)

    target = builder.save(output)
    print(f"已生成：{target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
