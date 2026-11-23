# -*- coding: utf-8 -*-
"""党政机关公文格式基线参数与层级识别规则（纯标准库，无第三方依赖）。

生成器 gongwen.py 与校验器 validate.py 共用本模块，保证「生成」与「校验」
使用同一套阈值，任何参数调整只需改这里。
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------- #
# 版式参数（GB/T 9704-2012）
# --------------------------------------------------------------------------- #
LINE_SPACING_PT = 28          # 全文固定行距 28 磅
INDENT_CHARS = 2              # 首行缩进 2 字符

FONT_TITLE = "方正小标宋简体"
FONT_LEVEL_1 = "黑体"
FONT_LEVEL_2 = "楷体_GB2312"
FONT_BODY = "仿宋_GB2312"

SIZE_TITLE_PT = 22            # 二号
SIZE_LEVEL_PT = 16            # 三号
SIZE_BODY_PT = 16             # 三号

PAGE_WIDTH_CM = 21.0
PAGE_HEIGHT_CM = 29.7
MARGIN_TOP_CM = 3.7
MARGIN_BOTTOM_CM = 3.5
MARGIN_LEFT_CM = 2.8
MARGIN_RIGHT_CM = 2.6
HEADER_DISTANCE_CM = 1.5
FOOTER_DISTANCE_CM = 1.75

# 层级 -> (中文字体, 字号磅值)
LEVEL_FONTS = {
    1: (FONT_LEVEL_1, SIZE_LEVEL_PT),
    2: (FONT_LEVEL_2, SIZE_LEVEL_PT),
    3: (FONT_BODY, SIZE_LEVEL_PT),
    4: (FONT_BODY, SIZE_LEVEL_PT),
}

# --------------------------------------------------------------------------- #
# 层级识别
# --------------------------------------------------------------------------- #
_NUM = "一二三四五六七八九十百千零〇两"
RE_LEVEL_1 = re.compile(rf"^[{_NUM}]+、")
RE_LEVEL_2 = re.compile(rf"^[（(][{_NUM}]+[）)]")
RE_LEVEL_4 = re.compile(r"^[（(]\d{1,2}[）)]")
RE_LEVEL_3 = re.compile(r"^\d{1,2}[.．](?!\d)")
RE_MARKDOWN = re.compile(r"^(#{1,5})\s+(.+)$")

# 识别顺序：带括号的层级优先，避免「（一）」被当成一级、「（1）」被当成三级
_ORDERED_PATTERNS = (
    (2, RE_LEVEL_2),
    (4, RE_LEVEL_4),
    (3, RE_LEVEL_3),
    (1, RE_LEVEL_1),
)


def parse_line(text: str) -> tuple[int, str]:
    """识别单行层级。

    返回 (level, content)：
      -1 = 主标题（仅 Markdown 一个 # 前缀时）
       0 = 正文
       1~4 = 对应层级标题
    """
    line = text.strip()
    if not line:
        return 0, ""

    md = RE_MARKDOWN.match(line)
    if md:
        level = -1 if len(md.group(1)) == 1 else len(md.group(1)) - 1
        return level, md.group(2).strip()

    for level, pattern in _ORDERED_PATTERNS:
        if pattern.match(line):
            return level, line
    return 0, line


def expected_style(level: int) -> tuple[str, int]:
    """层级 -> (中文字体, 字号磅值)。主标题为 -1。"""
    if level < 0:
        return FONT_TITLE, SIZE_TITLE_PT
    if level == 0:
        return FONT_BODY, SIZE_BODY_PT
    return LEVEL_FONTS[level]
