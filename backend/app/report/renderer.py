"""Word 报告渲染内核：docxtpl（Jinja2 沙箱）+ 版式规整 + 产物校验。

设计约束：
- 模板只允许使用白名单过滤器，Jinja 运行在 ``SandboxedEnvironment`` 中；
- 渲染前检查必填占位符，缺失直接失败，不产出"空报告"；
- 渲染后重新打开 docx，检查残留占位符与章节/表格完整性（L3 校验）。

说明：正式运行链路的所有取值必须来自确定性采集与抽取，本模块不调用 LLM。
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime, timezone
from typing import Any

from app.report.errors import (
    TPL_RENDER,
    TPL_RESIDUE,
    VAL_REQUIRED_MISSING,
    ReportError,
)

# 渲染产物中不允许残留的模板标记
_RESIDUE_PATTERNS = ("{{", "{%", "{#")

_GB9704_BODY_FONT = "仿宋_GB2312"
_GB9704_BODY_SIZE_PT = 16
_GB9704_LINE_SPACING_PT = 28


def _dash(value: Any) -> str:
    """空值统一展示为破折号，避免报告出现 None / 空白。"""
    if value is None:
        return "—"
    if isinstance(value, str) and not value.strip():
        return "—"
    return str(value)


def _fmt_num(value: Any, decimals: int = 0, thousands: bool = True) -> str:
    """数值格式化；非数值原样返回，空值返回破折号。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if decimals <= 0:
        rendered = f"{int(round(number)):,}" if thousands else str(int(round(number)))
    else:
        rendered = f"{number:,.{decimals}f}" if thousands else f"{number:.{decimals}f}"
    return rendered


def _fmt_date(value: Any, fmt: str = "%Y-%m-%d") -> str:
    """日期格式化，支持 datetime/date、ISO 字符串与 Unix 时间戳。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return "—"
    parsed: datetime | None = None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day)
    elif isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(value, tz=timezone.utc)
    elif isinstance(value, str):
        text = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return value
    if parsed is None:
        return str(value)
    return parsed.strftime(fmt)


def _fmt_pct(value: Any, decimals: int = 1, is_ratio: bool = False) -> str:
    """百分比格式化；is_ratio=True 时 0.75 会显示为 75.0%。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if is_ratio:
        number *= 100
    return f"{number:.{decimals}f}%"


def build_jinja_env():
    """构造受限的 Jinja2 环境。

    - SandboxedEnvironment：阻止属性穿透与危险调用；
    - StrictUndefined：缺失变量立即报错，而不是渲染成空串；
    - 仅注册只读展示过滤器，不注入 globals。
    """
    from jinja2 import StrictUndefined
    from jinja2.sandbox import SandboxedEnvironment

    env = SandboxedEnvironment(
        autoescape=False,
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters.update(
        {
            "num": _fmt_num,
            "date": _fmt_date,
            "pct": _fmt_pct,
            "dash": _dash,
        }
    )
    return env


# --------------------------------------------------------------------------- #
# 版式规整
# --------------------------------------------------------------------------- #
def _set_east_asian_font(r_pr, font_name: str) -> None:
    """同时设置 ascii/hAnsi/cs/eastAsia，保证中文按目标字体渲染。"""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    r_fonts = r_pr.find(qn("w:rFonts"))
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        r_fonts.set(qn(attr), font_name)


def _apply_gb9704_style(document) -> None:
    """把模板 Normal 样式与页面边距规整为 GB/T 9704 基线。

    仅调整正文基线，模板中的标题/表格自定义样式保持不变。
    """
    from docx.enum.text import WD_LINE_SPACING
    from docx.shared import Cm, Pt

    normal = document.styles["Normal"]
    normal.font.name = _GB9704_BODY_FONT
    normal.font.size = Pt(_GB9704_BODY_SIZE_PT)
    _set_east_asian_font(normal.element.get_or_add_rPr(), _GB9704_BODY_FONT)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = Pt(_GB9704_LINE_SPACING_PT)
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY

    for section in document.sections:
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(3.7)
        section.bottom_margin = Cm(3.5)
        section.left_margin = Cm(2.8)
        section.right_margin = Cm(2.6)


def apply_style_profile(docx_bytes: bytes, profile: str) -> bytes:
    """按版式档位处理后返回新的 docx 字节。"""
    if not profile or profile == "keep":
        return docx_bytes
    if profile != "gb9704":
        raise ReportError(TPL_RENDER, f"不支持的版式档位: {profile}")

    from docx import Document

    document = Document(io.BytesIO(docx_bytes))
    _apply_gb9704_style(document)
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


# --------------------------------------------------------------------------- #
# 读取与校验
# --------------------------------------------------------------------------- #
def _iter_document_text(document):
    """遍历正文、表格（含嵌套）、页眉页脚的全部文本。"""
    from docx.oxml.ns import qn

    def paragraph_text(paragraph) -> str:
        return "".join(node.text or "" for node in paragraph._p.iter(qn("w:t")))

    for paragraph in document.paragraphs:
        yield paragraph_text(paragraph)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    yield paragraph_text(paragraph)
                for nested in cell.tables:
                    for row2 in nested.rows:
                        for cell2 in row2.cells:
                            for paragraph2 in cell2.paragraphs:
                                yield paragraph_text(paragraph2)
    for section in document.sections:
        for story in (section.header, section.footer):
            for paragraph in story.paragraphs:
                yield paragraph_text(paragraph)


def _resolve(context: dict, token: str) -> Any:
    current: Any = context
    for part in (token or "").split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _precheck_required(context: dict, manifest: dict | None) -> list[dict]:
    """L2 前置校验：必填占位符必须有值；表格必须有列定义。"""
    issues: list[dict] = []
    for item in (manifest or {}).get("placeholders", []):
        if not isinstance(item, dict) or not item.get("required"):
            continue
        token = item.get("token") or ""
        value = _resolve(context, token)
        if item.get("type") == "table":
            if not isinstance(value, list) or not value:
                issues.append(
                    {"code": VAL_REQUIRED_MISSING, "token": token, "message": "必填表格无数据"}
                )
            continue
        if value is None or (isinstance(value, str) and not value.strip()):
            issues.append(
                {"code": VAL_REQUIRED_MISSING, "token": token, "message": "必填字段无值"}
            )
    return issues


def check_rendered_docx(docx_bytes: bytes, manifest: dict | None = None) -> dict:
    """L3 校验：重新打开产物，检查残留标记、章节与表格行数。"""
    from docx import Document

    issues: list[dict] = []
    try:
        document = Document(io.BytesIO(docx_bytes))
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "issues": [{"code": TPL_RENDER, "message": f"产物无法打开: {exc}"}],
            "stats": {},
        }

    texts = list(_iter_document_text(document))
    full_text = "\n".join(texts)
    for marker in _RESIDUE_PATTERNS:
        if marker in full_text:
            issues.append(
                {
                    "code": TPL_RESIDUE,
                    "message": f"产物存在未替换的模板标记: {marker}",
                }
            )

    normalized_text = re.sub(r"\s+", "", full_text)
    for section in (manifest or {}).get("sections", []):
        if not isinstance(section, dict) or not section.get("required"):
            continue
        title = re.sub(r"\s+", "", str(section.get("title") or ""))
        if title and title not in normalized_text:
            issues.append(
                {
                    "code": "VAL_SECTION_MISSING",
                    "message": f"产物缺少必需章节: {section.get('title')}",
                }
            )

    for item in (manifest or {}).get("placeholders", []):
        if not isinstance(item, dict) or item.get("type") != "table":
            continue
        max_rows = item.get("max_rows")
        if not isinstance(max_rows, int) or max_rows <= 0:
            continue
        for location in item.get("locations", []):
            if not isinstance(location, dict) or location.get("kind") != "table_loop":
                continue
            table_index = location.get("table")
            if not isinstance(table_index, int) or table_index < 0:
                continue
            if table_index >= len(document.tables):
                issues.append(
                    {
                        "code": "VAL_TABLE_MISSING",
                        "message": f"产物缺少表格 #{table_index}（{item.get('token')}）",
                    }
                )
                continue
            rendered_rows = len(document.tables[table_index].rows)
            if rendered_rows > max_rows + 1:
                issues.append(
                    {
                        "code": "VAL_TABLE_OVERFLOW",
                        "message": (
                            f"表格 {item.get('token')} 渲染 {rendered_rows - 1} 行，"
                            f"超过上限 {max_rows}"
                        ),
                    }
                )

    stats = {
        "paragraphs": len(document.paragraphs),
        "tables": len(document.tables),
        "char_count": len(full_text),
    }
    return {"ok": not issues, "issues": issues, "stats": stats}


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def render_report(
    template_bytes: bytes,
    context: dict,
    *,
    manifest: dict | None = None,
    style_profile: str = "keep",
    strict_required: bool = True,
) -> dict:
    """渲染 Word 报告。

    Args:
        template_bytes: 模板 docx 字节。
        context: 嵌套上下文字典（``summary.total_alert`` 对应
            ``{"summary": {"total_alert": 37}}``）。
        manifest: 模板 manifest，用于必填与产物校验；建议始终传入。
        style_profile: ``keep`` 保留模板样式；``gb9704`` 套用公文版式基线。
        strict_required: 必填占位符缺失时是否直接失败。

    Returns:
        ``{"docx": bytes, "checks": {...}}``

    Raises:
        ReportError: 模板语法错误、变量缺失或产物校验未通过。
    """
    if not isinstance(context, dict):
        raise ReportError(TPL_RENDER, "渲染上下文必须是对象")
    if not template_bytes:
        raise ReportError(TPL_RENDER, "模板内容为空")

    missing = _precheck_required(context, manifest)
    if missing and strict_required:
        raise ReportError(
            VAL_REQUIRED_MISSING,
            "必填占位符缺少数据，已阻止渲染",
            {"issues": missing},
        )

    from docxtpl import DocxTemplate
    from jinja2 import TemplateSyntaxError, UndefinedError

    try:
        template = DocxTemplate(io.BytesIO(template_bytes))
        template.render(context, jinja_env=build_jinja_env())
        output = io.BytesIO()
        template.save(output)
        rendered = output.getvalue()
    except TemplateSyntaxError as exc:
        raise ReportError(
            TPL_RENDER,
            f"模板语法错误（第 {exc.lineno} 行）: {exc.message}",
        ) from exc
    except UndefinedError as exc:
        raise ReportError(TPL_RENDER, f"模板变量缺失: {exc}") from exc
    except ReportError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ReportError(TPL_RENDER, f"Word 渲染失败: {exc}") from exc

    if style_profile and style_profile != "keep":
        rendered = apply_style_profile(rendered, style_profile)

    checks = check_rendered_docx(rendered, manifest)
    if not checks["ok"]:
        # 产物已生成但校验未通过：由调用方决定标记 partial 或丢弃
        checks["warnings"] = [issue["message"] for issue in checks["issues"]]

    return {"docx": rendered, "checks": checks}
