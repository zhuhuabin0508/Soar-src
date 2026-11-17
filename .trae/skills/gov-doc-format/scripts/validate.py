# -*- coding: utf-8 -*-
"""公文格式校验器（纯标准库，无需 python-docx）。

.docx 本质是 ZIP + OOXML，本脚本直接读取 word/document.xml 与
word/styles.xml，逐段核对页面尺寸、页边距、行距、首行缩进、字体、
字号、对齐与加粗是否与 GB/T 9704 基线一致。

用法:
    python validate.py 文件.docx
退出码 0 表示全部符合，1 表示存在偏差。
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from rules import (
    FONT_BODY,
    INDENT_CHARS,
    LINE_SPACING_PT,
    MARGIN_BOTTOM_CM,
    MARGIN_LEFT_CM,
    MARGIN_RIGHT_CM,
    MARGIN_TOP_CM,
    PAGE_HEIGHT_CM,
    PAGE_WIDTH_CM,
    SIZE_BODY_PT,
    expected_style,
    parse_line,
)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
TWIPS_PER_CM = 1440 / 2.54
TOLERANCE_TWIPS = 10

LEVEL_NAMES = {-1: "主标题", 0: "正文", 1: "一级", 2: "二级", 3: "三级", 4: "四级"}


def _tag(name: str) -> str:
    return f"{{{W}}}{name}"


def _attr(element, name: str) -> str | None:
    if element is None:
        return None
    return element.get(_tag(name))


def _cm_to_twips(value_cm: float) -> int:
    return round(value_cm * TWIPS_PER_CM)


def _text_of(paragraph) -> str:
    return "".join(node.text or "" for node in paragraph.iter(_tag("t")))


def _has_text(run) -> bool:
    return any((node.text or "").strip() for node in run.iter(_tag("t")))


def _paragraph_props(paragraph):
    return paragraph.find(_tag("pPr"))


def _check_page(body, problems: list[str]) -> None:
    sections = body.findall(_tag("sectPr"))
    if not sections:
        problems.append("找不到页面设置（w:sectPr）")
        return
    section = sections[-1]

    size = section.find(_tag("pgSz"))
    width = int(_attr(size, "w") or 0)
    height = int(_attr(size, "h") or 0)
    if abs(width - _cm_to_twips(PAGE_WIDTH_CM)) > TOLERANCE_TWIPS or abs(
        height - _cm_to_twips(PAGE_HEIGHT_CM)
    ) > TOLERANCE_TWIPS:
        problems.append(
            f"页面尺寸为 {width / TWIPS_PER_CM:.2f}×{height / TWIPS_PER_CM:.2f} cm，"
            f"应为 {PAGE_WIDTH_CM:.2f}×{PAGE_HEIGHT_CM:.2f} cm"
        )

    margin = section.find(_tag("pgMar"))
    expected = {
        "top": MARGIN_TOP_CM,
        "bottom": MARGIN_BOTTOM_CM,
        "left": MARGIN_LEFT_CM,
        "right": MARGIN_RIGHT_CM,
    }
    for side, value_cm in expected.items():
        actual = int(_attr(margin, side) or 0)
        if abs(actual - _cm_to_twips(value_cm)) > TOLERANCE_TWIPS:
            problems.append(
                f"页边距 {side} 为 {actual / TWIPS_PER_CM:.2f} cm，应为 {value_cm:.2f} cm"
            )


def _check_normal_style(styles_root, problems: list[str]) -> None:
    if styles_root is None:
        problems.append("缺少 word/styles.xml，无法核对默认样式")
        return

    normal = None
    for style in styles_root.findall(_tag("style")):
        if style.get(_tag("styleId")) == "Normal":
            normal = style
            break
    if normal is None:
        problems.append("默认样式 Normal 不存在")
        return

    rPr = normal.find(_tag("rPr"))
    fonts = rPr.find(_tag("rFonts")) if rPr is not None else None
    if _attr(fonts, "eastAsia") != FONT_BODY:
        problems.append(f"默认样式中文字体为 {_attr(fonts, 'eastAsia')}，应为 {FONT_BODY}")
    size = rPr.find(_tag("sz")) if rPr is not None else None
    if _attr(size, "val") != str(SIZE_BODY_PT * 2):
        problems.append(
            f"默认样式字号为 {_attr(size, 'val')}（半磅），应为 {SIZE_BODY_PT * 2}"
        )

    pPr = normal.find(_tag("pPr"))
    spacing = pPr.find(_tag("spacing")) if pPr is not None else None
    if _attr(spacing, "line") != str(int(LINE_SPACING_PT * 20)) or _attr(
        spacing, "lineRule"
    ) != "exact":
        problems.append(
            f"默认样式行距为 {_attr(spacing, 'line')}/{_attr(spacing, 'lineRule')}，"
            f"应为 {int(LINE_SPACING_PT * 20)}/exact"
        )
    ind = pPr.find(_tag("ind")) if pPr is not None else None
    if _attr(ind, "firstLineChars") != str(INDENT_CHARS * 100):
        problems.append(
            f"默认样式首行缩进为 {_attr(ind, 'firstLineChars')}（1/100 字符），"
            f"应为 {INDENT_CHARS * 100}"
        )


def _check_paragraph(
    index: int,
    paragraph,
    problems: list[str],
    latin_font: str | None = None,
    is_first: bool = False,
) -> int:
    """校验单个段落，返回识别出的层级。"""
    text = _text_of(paragraph).strip()
    level, _ = parse_line(text)

    # 公文首段即主标题；首段若是编号标题，说明文件缺少主标题
    if is_first:
        if level > 0:
            problems.append(f"第1段「{text[:18]}」是编号标题，文档缺少主标题")
        elif level == 0:
            level = -1

    font, size_pt = expected_style(level)
    expected_latin = latin_font or font
    pPr = _paragraph_props(paragraph)
    label = f"第{index}段「{text[:18]}」"

    # 行距：固定值 28 磅
    spacing = pPr.find(_tag("spacing")) if pPr is not None else None
    if _attr(spacing, "line") != str(int(LINE_SPACING_PT * 20)) or _attr(
        spacing, "lineRule"
    ) != "exact":
        problems.append(
            f"{label} 行距为 {_attr(spacing, 'line')}/{_attr(spacing, 'lineRule')}，"
            f"应为 {int(LINE_SPACING_PT * 20)}/exact"
        )

    # 首行缩进：标题 0，其余 2 字符
    ind = pPr.find(_tag("ind")) if pPr is not None else None
    expected_chars = 0 if level < 0 else INDENT_CHARS * 100
    if _attr(ind, "firstLineChars") != str(expected_chars):
        problems.append(
            f"{label} 首行缩进为 {_attr(ind, 'firstLineChars')}（1/100 字符），"
            f"应为 {expected_chars}"
        )
    expected_twips = 0 if level < 0 else int(INDENT_CHARS * size_pt * 20)
    if _attr(ind, "firstLine") != str(expected_twips):
        problems.append(
            f"{label} 首行缩进绝对值为 {_attr(ind, 'firstLine')} 缇，应为 {expected_twips}"
        )

    # 对齐：标题居中，正文两端对齐，标题行左对齐
    alignment = _attr(pPr.find(_tag("jc")) if pPr is not None else None, "val")
    if level < 0:
        if alignment != "center":
            problems.append(f"{label} 对齐方式为 {alignment}，应为 center")
    elif level == 0:
        if alignment != "both":
            problems.append(f"{label} 对齐方式为 {alignment}，应为 both")
    elif alignment not in (None, "left", "start"):
        problems.append(f"{label} 对齐方式为 {alignment}，应为 left")

    # 字体、字号、加粗
    for run in paragraph.iter(_tag("r")):
        if not _has_text(run):
            continue
        rPr = run.find(_tag("rPr"))
        fonts = rPr.find(_tag("rFonts")) if rPr is not None else None
        east_asian = _attr(fonts, "eastAsia")
        if east_asian != font:
            problems.append(f"{label} 中文字体为 {east_asian}，应为 {font}")
        if _attr(fonts, "ascii") != expected_latin:
            problems.append(
                f"{label} 西文字体为 {_attr(fonts, 'ascii')}，应为 {expected_latin}"
            )
        size = rPr.find(_tag("sz")) if rPr is not None else None
        if _attr(size, "val") != str(size_pt * 2):
            problems.append(
                f"{label} 字号为 {_attr(size, 'val')}（半磅），应为 {size_pt * 2}"
            )
        bold = rPr.find(_tag("b")) if rPr is not None else None
        if bold is not None and _attr(bold, "val") not in ("0", "false"):
            problems.append(f"{label} 被加粗，公文标题与正文均不应加粗")
    return level


def validate(path: Path, latin_font: str | None = None) -> tuple[list[str], dict[int, int]]:
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        try:
            styles = ET.fromstring(archive.read("word/styles.xml"))
        except KeyError:
            styles = None

    problems: list[str] = []
    body = document.find(_tag("body"))
    if body is None:
        return ["document.xml 缺少 w:body"], {}

    _check_page(body, problems)
    _check_normal_style(styles, problems)

    counts: dict[int, int] = {}
    index = 0
    for paragraph in body.iter(_tag("p")):
        if not _text_of(paragraph).strip():
            continue
        index += 1
        level = _check_paragraph(
            index, paragraph, problems, latin_font=latin_font, is_first=index == 1
        )
        counts[level] = counts.get(level, 0) + 1

    if index == 0:
        problems.append("文档没有正文段落")
    return problems, counts


def _summary(counts: dict[int, int]) -> str:
    parts = [f"{LEVEL_NAMES[key]}{counts[key]}" for key in sorted(counts)]
    total = sum(counts.values())
    return f"{total} 个段落（" + " / ".join(parts) + "）"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 .docx 是否符合党政机关公文格式")
    parser.add_argument("input", help="待校验的 .docx 文件")
    parser.add_argument(
        "--latin-font",
        default=None,
        help="生成时指定的西文字体；未指定则要求与所在段落的中文字体一致",
    )
    args = parser.parse_args(argv)

    target = Path(args.input)
    if not target.is_file():
        raise SystemExit(f"文件不存在：{target}")
    if target.suffix.lower() != ".docx":
        raise SystemExit("仅支持 .docx 文件")

    problems, counts = validate(target, latin_font=args.latin_font)
    print(f"公文格式校验：{target}")
    if not problems:
        print("  [通过] 页面、页边距、默认样式")
        print(f"  [通过] {_summary(counts)}")
        print("  结果：全部符合 GB/T 9704 格式基线")
        return 0

    print(f"  [失败] {len(problems)} 处偏差：")
    for problem in problems[:30]:
        print(f"    - {problem}")
    if len(problems) > 30:
        print(f"    …… 另有 {len(problems) - 30} 处")
    print(f"  [统计] {_summary(counts)}")
    print("  结果：不符合，请修正后重新校验")
    return 1


if __name__ == "__main__":
    sys.exit(main())
