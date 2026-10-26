"""临时脚本：提取青藤万相API手册 docx 全文（段落+表格）到文本文件。

用法: python extract_docx.py [源.docx] [输出.txt]
两个路径参数均可省略，缺省用项目内默认值。
"""
import os
import sys
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn

SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\trae project\soar-src\青藤万相 v3.4.1.66 外部API手册.docx"
DST = sys.argv[2] if len(sys.argv) > 2 else r"D:\trae project\soar-src\scripts\qingteng_api_manual.txt"


def iter_block_items(parent):
    """按文档顺序生成段落与表格。"""
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def main():
    if not os.path.exists(SRC):
        sys.exit(f"源文件不存在: {SRC}\n用法: python extract_docx.py [源.docx] [输出.txt]")
    doc = Document(SRC)
    lines = []
    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            style = block.style.name if block.style else ""
            if text:
                if style.startswith("Heading"):
                    level = "".join(ch for ch in style if ch.isdigit()) or "0"
                    lines.append(f"\n{'#' * int(level)} {text}")
                else:
                    lines.append(text)
        else:  # Table
            lines.append("[TABLE]")
            for row in block.rows:
                cells = []
                for cell in row.cells:
                    cell_text = " ".join(
                        p.text.strip() for p in cell.paragraphs if p.text.strip()
                    )
                    cells.append(cell_text.replace("\n", " "))
                lines.append(" | ".join(cells))
            lines.append("[/TABLE]")
    content = "\n".join(lines)
    with open(DST, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"total lines: {len(lines)}")
    print(f"total chars: {len(content)}")


if __name__ == "__main__":
    main()
