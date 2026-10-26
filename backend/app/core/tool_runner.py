"""工具执行器：编译并运行用户编辑的 Python 工具代码。

安全说明（P0-3 升级）：
本平台为用户自有的内部 SOAR 平台，工具代码由平台管理员/授权用户编写。
但在多用户/角色场景下，仍需防止恶意或误操作的工具代码执行系统命令、
读取敏感文件、发起网络连接。因此引入两层沙箱防护：

1. **AST 静态审查**（``app.core.tool_sandbox.validate_tool_code``）：
   在 ``exec`` 前对源码做 AST 解析，禁止导入 os/subprocess/socket 等高危模块，
   禁止访问双下划线属性（防 ``__class__.__mro__`` 逃逸）。
2. **builtins 白名单**（``app.core.tool_sandbox.build_safe_builtins``）：
   将 exec 命名空间的 ``__builtins__`` 替换为白名单字典，
   运行时无法访问 ``__import__`` / ``open`` / ``eval`` 等。

工具代码约定：必须定义 ``async def run(**kwargs)``，返回任意可 JSON 序列化的结果。
可用注入模块：asyncio / json / datetime / timedelta / re / ipaddress / httpx（仅 HTTP 客户端，无文件系统访问）。
文档读取：openpyxl / docx / pypdf + ``read_uploaded_file(file_name)`` 辅助函数
（按文件名读取已上传的 xlsx/docx/pdf/csv/txt 文件，内部查 DB 定位文件，工具代码无需关心路径）。
"""
import asyncio
import ipaddress
import json
import logging
import os
import re
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from app.core.tool_sandbox import (
    CodeValidationError,
    build_safe_builtins,
    validate_tool_code,
)

logger = logging.getLogger(__name__)

# 日志回调类型：(level: str, message: str) -> None；与 tool_http_runner.LogHandler 一致
LogHandler = Callable[[str, str], None]

# 保留字段名：run_tool 注入 log_handler 给 HTTP 工具时使用的 kwarg 名。
# 以下划线开头，避免与用户参数命名冲突；_http_run 会将其弹出后再调用 run_http_tool。
_LOG_HANDLER_KWARG = "_soar_log_handler"

# 进程级缓存：工具名 -> (run 函数, code 摘要)
# 当 code 变化时重新编译，避免重复 exec 开销。
_tool_cache: dict[str, tuple[Callable, str]] = {}


def _query_agent_file(db, safe_name: str, agent_id: int | None = None):
    """按名称（兼容 original_name / stored_name）+ 可选智能体归属查询 AgentFile。

    ``agent_id`` 为 None 时不限定（全局查询，兼容无智能体上下文的调用方）；
    需要"仅公共文件"请用 :func:`_query_agent_file_public`。
    """
    from app.models.agent_file import AgentFile

    q = db.query(AgentFile)
    if agent_id is not None:
        q = q.filter(AgentFile.agent_id == agent_id)
    rec = q.filter(AgentFile.original_name == safe_name).first()
    if rec is None:
        q2 = db.query(AgentFile)
        if agent_id is not None:
            q2 = q2.filter(AgentFile.agent_id == agent_id)
        rec = q2.filter(AgentFile.stored_name == safe_name).first()
    return rec


def _query_agent_file_public(db, safe_name: str):
    """仅查询公共文件（``agent_id`` 为空，含历史文件），兼容 original_name / stored_name。"""
    from app.models.agent_file import AgentFile

    q = db.query(AgentFile).filter(AgentFile.agent_id.is_(None))
    rec = q.filter(AgentFile.original_name == safe_name).first()
    if rec is None:
        rec = q.filter(AgentFile.stored_name == safe_name).first()
    return rec


def read_uploaded_file(file_name: str, agent_id: int | None = None) -> dict:
    """读取已上传的智能体文件内容（供工具代码调用）。

    本函数注入到沙箱命名空间，工具代码可直接调用 ``read_uploaded_file("报表.xlsx")``。
    内部通过 DB 查询 AgentFile 定位文件，按扩展名自动解析：
    - xlsx/xls：openpyxl 读取所有 sheet，返回 ``{sheet_name: [[row], ...]}``
    - docx：python-docx 读取段落，返回 ``{"text": "...", "paragraphs": [...]}``
    - pdf：pypdf 读取所有页，返回 ``{"pages": ["page1_text", ...], "text": "..."}``
    - csv/txt/md/json：直接读文本

    Args:
        file_name: 文件名（用户上传时的原始名，与 AgentFile.original_name 匹配）。
        agent_id: 归属智能体 id（由沙箱注入）。先查本智能体文件，
            查不到回退公共文件（agent_id 为空，含历史文件）。

    Returns:
        ``{"file_name": ..., "file_type": ..., "content": ...}`` 或 ``{"error": "..."}``
    """
    if not file_name or not isinstance(file_name, str):
        return {"error": "请提供文件名（file_name 参数）"}

    # 安全：仅取文件名部分，防止路径遍历
    safe_name = os.path.basename(file_name.strip())

    # 延迟导入，避免循环依赖
    from app.database import SessionLocal
    from app.models.agent_file import AgentFile

    db = SessionLocal()
    try:
        # 先精确匹配 original_name，再尝试 stored_name
        record = _query_agent_file(db, safe_name, agent_id=agent_id)
        if record is None and agent_id is not None:
            # 回退公共文件（agent_id 为空）
            record = _query_agent_file_public(db, safe_name)
        if record is None:
            q = db.query(AgentFile)
            if agent_id is not None:
                from sqlalchemy import or_

                q = q.filter(or_(AgentFile.agent_id == agent_id, AgentFile.agent_id.is_(None)))
            available = [r.original_name for r in q.all()]
            return {
                "error": f"文件不存在: {safe_name}",
                "available_files": available,
            }

        file_path = record.file_path
        if not os.path.exists(file_path):
            return {"error": f"文件在磁盘上不存在: {safe_name}"}

        ext = record.file_type.lower()
        try:
            if ext in ("xlsx", "xls"):
                # 真 OLE2 老式 .xls 用 xlrd 读取（openpyxl 无法解析）；其余用 openpyxl
                with open(file_path, "rb") as _fh:
                    _head = _fh.read(8)
                if detect_real_format(_head) == "ole2":
                    sheets = _xls_rows_via_xlrd(file_path)
                    return {
                        "file_name": record.original_name,
                        "file_type": ext,
                        "sheets": sheets,
                        "content": json.dumps(sheets, ensure_ascii=False),
                    }
                import io

                import openpyxl
                with open(file_path, "rb") as _fh:
                    _payload = _fh.read()
                # 必须用 BytesIO 加载：openpyxl 对部分「.xls 后缀 + OOXML 内容」的文件
                # 按路径加载时 _validate_archive 会误报 "old .xls file format"
                # （InvalidFileException）；字节流加载可正常解析。
                # 不用 read_only 模式：该模式对该类文件会流式解析异常（只读出首行首列）。
                wb = openpyxl.load_workbook(io.BytesIO(_payload), data_only=True)
                sheets = {}
                for ws in wb.sheetnames:
                    sheet = wb[ws]
                    rows = []
                    for row in sheet.iter_rows(values_only=True):
                        rows.append([str(c) if c is not None else "" for c in row])
                    sheets[ws] = rows
                wb.close()
                return {
                    "file_name": record.original_name,
                    "file_type": ext,
                    "sheets": sheets,
                    "content": json.dumps(sheets, ensure_ascii=False),
                }

            elif ext == "docx":
                import docx
                doc = docx.Document(file_path)
                paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
                full_text = "\n".join(paragraphs)
                return {
                    "file_name": record.original_name,
                    "file_type": ext,
                    "paragraphs": paragraphs,
                    "content": full_text,
                }

            elif ext == "pdf":
                from pypdf import PdfReader
                reader = PdfReader(file_path)
                pages = []
                for page in reader.pages:
                    text = page.extract_text() or ""
                    pages.append(text.strip())
                full_text = "\n\n".join(pages)
                return {
                    "file_name": record.original_name,
                    "file_type": ext,
                    "pages": pages,
                    "page_count": len(pages),
                    "content": full_text,
                }

            else:
                # csv / txt / md / json：直接读文本
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
                return {
                    "file_name": record.original_name,
                    "file_type": ext,
                    "content": text,
                }

        except Exception as exc:  # noqa: BLE001
            logger.exception("读取文件失败: %s, error=%s", safe_name, exc)
            return {"error": f"读取文件失败: {exc}"}
    finally:
        db.close()


# ==== 供 expand_risk_detail / compare_risk_exports 工具使用的安全 Excel 文件助手 ====
# 沙箱禁止工具代码直接 open()/import，故在此（可信模块上下文）封装路径式读写并注入到
# 工具命名空间调用，保证工具只能访问上传文件库中的文件，不能触碰任意磁盘路径。

def _agent_upload_dir() -> str:
    """上传文件保存目录：backend/uploads/agent_files/（与 api/v1/agent_files.py 一致）

    注意：本文件位于 backend/app/core/ 下，上溯 3 级即到 backend/（/app）。
    上溯 4 级会到文件系统根目录（/），导致写入错误目录。
    """
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "uploads",
        "agent_files",
    )


# 弱密码风险清单技能的标准 22 列白名单（expand_risk_detail 未传模板时的默认输出列）。
# 与技能文档「导出字段白名单」一致；传入模板文件时以模板表头为准（覆盖此默认值）。
DEFAULT_RISK_COLUMNS: list[str] = [
    "业务组名", "IP", "内网IP", "外网IP", "主机名",
    "弱密码应用(仅linux)", "弱密码类型", "用户名", "密码", "账号状态",
    "应用版本号(仅linux)", "应用路径(仅linux)", "ssh账号登录方式(仅linux,ssh)",
    "密码状态(仅linux,ssh)", "第一次发现该弱密码的时间(仅linux)",
    "绑定ip(仅linux)", "绑定端口(仅linux)", "进程id(仅linux)",
    "是否root权限运行", "是否对外访问", "shell登录性",
    "mysql帐号允许访问的主机(仅linux mysql)",
]


def _resolve_agent_file(file_name: str, agent_id: int | None = None):
    """按文件名定位上传文件库中的记录（兼容 original_name / stored_name）。

    归属隔离：先查 ``agent_id`` 对应的本智能体文件，查不到回退公共文件
    （``agent_id`` 为空，含历史文件）。

    Args:
        file_name: 文件名。
        agent_id: 归属智能体 id（沙箱注入）；None 时不限定（全局/公共）。

    Returns:
        返回 ``AgentFile`` ORM 记录；未找到或文件在磁盘上不存在时返回 None。
    """
    if not file_name or not isinstance(file_name, str):
        return None
    safe = os.path.basename(file_name.strip())
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        rec = _query_agent_file(db, safe, agent_id=agent_id)
        if rec is None and agent_id is not None:
            rec = _query_agent_file_public(db, safe)
        if rec is None:
            return None
        if not os.path.exists(rec.file_path):
            return None
        return rec
    finally:
        db.close()


def detect_real_format(head8: bytes) -> str:
    """按文件头 8 字节判断真实格式（不依赖扩展名）。

    Returns:
        ``"ole2"``（D0 CF 11 E0，真老式二进制 .xls/.doc）、
        ``"ooxml"``（PK zip，OOXML xlsx）、``"unknown"``。
    """
    if head8[:4] == b"\xd0\xcf\x11\xe0":
        return "ole2"
    if head8[:2] == b"PK":
        return "ooxml"
    return "unknown"


def _xls_rows_via_xlrd(path: str) -> dict:
    """用 xlrd 读取真 OLE2 老式 .xls，返回 {sheet_name: [[str,...],...]}。

    xlrd 2.x 仅支持旧版 .xls（OLE2），不支持 xlsx。单元格统一转为字符串：
    日期格式化为 ``YYYY-MM-DD``（带时分秒时 ``YYYY-MM-DD HH:MM:SS``）、
    布尔转为 "true"/"false"、空值为 ""。
    """
    import xlrd

    book = xlrd.open_workbook(path, formatting_info=False)
    sheets: dict = {}
    for sh in book.sheets():
        rows = []
        for r in range(sh.nrows):
            row = []
            for c in range(sh.ncols):
                cell = sh.cell(r, c)
                v = cell.value
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        dt = xlrd.xldate.xldate_as_datetime(v, book.datemode)
                        v = (
                            dt.strftime("%Y-%m-%d %H:%M:%S")
                            if (dt.hour or dt.minute or dt.second)
                            else dt.strftime("%Y-%m-%d")
                        )
                    except Exception:  # noqa: BLE001
                        v = str(v)
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    v = "true" if v else "false"
                elif v is None:
                    v = ""
                row.append(str(v))
            rows.append(row)
        sheets[sh.name or "Sheet"] = rows
    return sheets


def _xls_to_workbook(path: str):
    """把真 OLE2 老式 .xls 读取为 openpyxl Workbook（仅数据，无样式）。

    load_excel_workbook 统一返回 openpyxl 工作簿，供 expand_risk_detail /
    compare_risk_exports 等工具用 openpyxl API 处理，故 OLE2 也转成 openpyxl。
    """
    import openpyxl

    sheets = _xls_rows_via_xlrd(path)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name[:31] or "Sheet")
        for row in rows:
            ws.append(row)
    return wb


def load_excel_workbook(file_name: str, agent_id: int | None = None) -> dict:
    """按上传文件名读取 Excel 工作簿（从字节流加载），返回工作簿对象 + AgentFile 记录。

    格式识别：读文件头 8 字节判断真实格式——
    - OLE2 旧版二进制（真老式 .xls）：用 xlrd 读取并转为 openpyxl 工作簿（数据）。
    - OOXML（即使扩展名伪装为 .xls）：按 zip 字节流用 openpyxl 加载。

    错误处理（需写入工具配置描述）：
    - 非 OOXML/OLE2（文件头无法识别）→ “无法识别的文件格式，请确认文件为 Excel”
    - 上传文件库中不存在 → “上传文件库中不存在文件: <name>”
    - Python 环境缺少 xlrd/openpyxl → 部署错误，提示管理员安装
    """
    rec = _resolve_agent_file(file_name, agent_id=agent_id)
    if rec is None:
        return {"error": f"上传文件库中不存在文件: {file_name}"}
    try:
        with open(rec.file_path, "rb") as f:
            head = f.read(8)
        fmt = detect_real_format(head)
        if fmt == "ole2":
            # 真 OLE2 老式 .xls：xlrd 读取 → openpyxl 工作簿（数据，无样式）
            wb = _xls_to_workbook(rec.file_path)
            return {"ok": True, "wb": wb, "node": rec, "file_path": rec.file_path, "format": "ole2"}
        if fmt != "ooxml":
            return {
                "error": "无法识别的文件格式（非 OOXML/OLE2），请确认文件为 Excel",
                "file": rec.original_name,
            }
        import io

        import openpyxl  # noqa: F401

        with open(rec.file_path, "rb") as f:
            payload = f.read()
        wb = openpyxl.load_workbook(io.BytesIO(payload), data_only=True)
        return {"ok": True, "wb": wb, "node": rec, "file_path": rec.file_path}
    except ImportError:
        return {"error": "Python 环境缺少 openpyxl，请联系管理员安装 openpyxl"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("加载 Excel 失败: %s", rec.original_name)
        return {"error": f"读取 Excel 失败: {exc}"}


def find_col(header: list, name: str, fuzzy: bool = False) -> int:
    """按表头名称定位列，返回列索引；找不到返回 -1。

    Args:
        header: 表头行（字符串列表，可能含 None）。
        name: 目标列名。
        fuzzy: True 时在精确匹配失败后做包含匹配（用于「绑定端口(仅linux)」
            容忍「绑定端口」等变体列名）。

    Returns:
        列索引（0 起），找不到返回 -1。
    """
    if not header:
        return -1
    norm = [str(h).strip() if h is not None else "" for h in header]
    for i, h in enumerate(norm):
        if h == name:
            return i
    if fuzzy:
        for i, h in enumerate(norm):
            if h and name in h:
                return i
    return -1


def save_workbook_as_agent_file(
    wb, suggested_name: str, agent_id: int | None = None, user_id: int | None = None
) -> dict:
    """把 openpyxl 工作簿保存到上传文件库并注册为 AgentFile，返回文件元数据。

    Args:
        wb: 已填充数据与样式的 openpyxl Workbook 对象。
        suggested_name: 建议的文件名；若与库中已有文件重名会追加序号避免覆盖。
        agent_id: 归属智能体 id（沙箱注入，current_agent_id）。
        user_id: 归属上传用户 id（沙箱注入，current_user_id）。
    """
    import uuid

    from app.database import SessionLocal
    from app.models.agent_file import AgentFile

    upload_dir = _agent_upload_dir()
    os.makedirs(upload_dir, exist_ok=True)
    base, ext = os.path.splitext((suggested_name or "export.xlsx").strip())
    if ext.lower() != ".xlsx":
        ext = ".xlsx"
    original = base + ext
    stored = f"{uuid.uuid4().hex}.xlsx"
    abs_path = os.path.join(upload_dir, stored)
    wb.save(abs_path)
    db = SessionLocal()
    try:
        rec = AgentFile(
            original_name=original,
            stored_name=stored,
            file_path=abs_path,
            file_type="xlsx",
            file_size=os.path.getsize(abs_path),
            agent_id=agent_id,
            created_by=user_id,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return {
            "ok": True,
            "file_name": rec.original_name,
            "stored_name": rec.stored_name,
            "file_path": rec.file_path,
            "file_size": rec.file_size,
        }
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("保存 Excel 到上传文件库失败: %s", original)
        return {"error": f"保存 Excel 失败: {exc}"}
    finally:
        db.close()


def save_json_as_agent_file(
    data: dict, suggested_name: str, agent_id: int | None = None, user_id: int | None = None
) -> dict:
    """把 JSON 字典保存到上传文件库并注册为 AgentFile，返回文件元数据。

    供 expand_risk_detail 的 save_template 参数使用：把模板的输出列定义
    持久化为 JSON 文件，供 compare 工具按名定位时校验参考。
    """
    import json as _json
    import uuid

    from app.database import SessionLocal
    from app.models.agent_file import AgentFile

    upload_dir = _agent_upload_dir()
    os.makedirs(upload_dir, exist_ok=True)
    base, ext = os.path.splitext((suggested_name or "export.json").strip())
    if ext.lower() != ".json":
        ext = ".json"
    original = base + ext
    stored = f"{uuid.uuid4().hex}.json"
    abs_path = os.path.join(upload_dir, stored)
    with open(abs_path, "w", encoding="utf-8") as f:
        _json.dump(data, f, ensure_ascii=False, indent=2)
    db = SessionLocal()
    try:
        rec = AgentFile(
            original_name=original,
            stored_name=stored,
            file_path=abs_path,
            file_type="json",
            file_size=os.path.getsize(abs_path),
            agent_id=agent_id,
            created_by=user_id,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return {
            "ok": True,
            "file_name": rec.original_name,
            "stored_name": rec.stored_name,
            "file_path": rec.file_path,
            "file_size": rec.file_size,
        }
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("保存 JSON 到上传文件库失败: %s", original)
        return {"error": f"保存 JSON 失败: {exc}"}
    finally:
        db.close()


# 智能体记忆存储路径（JSON 文件，持久化在 uploads 卷中）
_AGENT_MEMORY_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads", "agent_memory",
)
_AGENT_MEMORY_FILE = os.path.join(_AGENT_MEMORY_DIR, "memory.json")


def _load_memory_store() -> dict:
    """加载记忆 JSON 文件，返回 dict。文件不存在时返回空 dict。"""
    if not os.path.exists(_AGENT_MEMORY_FILE):
        return {}
    try:
        with open(_AGENT_MEMORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_memory_store(store: dict) -> None:
    """将记忆 dict 写入 JSON 文件。"""
    os.makedirs(_AGENT_MEMORY_DIR, exist_ok=True)
    with open(_AGENT_MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def save_agent_memory(key: str, value: str) -> dict:
    """保存一条键值对到智能体长期记忆（供工具代码调用）。

    存储在 ``uploads/agent_memory/memory.json`` 中，跨工具调用持久化。
    """
    if not key or not isinstance(key, str):
        return {"error": "请提供 key 参数"}
    store = _load_memory_store()
    store[key] = value
    try:
        _save_memory_store(store)
        return {"ok": True, "key": key, "saved": True, "total_keys": len(store)}
    except OSError as exc:
        logger.exception("保存记忆失败: key=%s, error=%s", key, exc)
        return {"error": f"保存记忆失败: {exc}"}


def recall_agent_memory(key: str = "") -> dict:
    """从智能体长期记忆检索数据（供工具代码调用）。

    - 传入 key：返回对应的值
    - 不传 key：返回所有已保存的记忆键列表
    """
    store = _load_memory_store()
    if not key:
        return {"keys": list(store.keys()), "total": len(store)}
    if key in store:
        return {"key": key, "value": store[key]}
    return {"key": key, "value": None, "error": f"未找到记忆: {key}", "available_keys": list(store.keys())}


def load_tool_function(tool, enabled_kbs=None, agent_id=None, user_id=None) -> Callable:
    """加载工具的 ``run`` 异步函数。

    按 ``tool.tool_type`` 分发：
    - ``code``：编译用户 Python 代码（沙箱审查），缓存以 code 摘要为键。
    - ``http``：构造一个调用 ``run_http_tool`` 的协程函数，缓存以 http_config 摘要为键。

    若该工具已缓存且配置未变化，则直接复用缓存。

    Args:
        tool: ``Tool`` ORM 实例，需含 ``name``、``tool_type``，
            ``code`` 工具还需 ``code``，``http`` 工具还需 ``http_config``。

    Returns:
        可 await 的 ``run`` 函数对象。

    Raises:
        ValueError: 代码为空 / AST 审查失败 / 未定义 ``run`` 函数。
    """
    name = getattr(tool, "name", "unknown")
    tool_type = (getattr(tool, "tool_type", "code") or "code").lower()
    code = getattr(tool, "code", "") or ""
    http_config = getattr(tool, "http_config", None) or {}

    # 缓存摘要：code 工具用 code，http 工具用 http_config + parameters_schema 序列化
    # 注意：必须把 parameters_schema 纳入摘要，否则仅更新 schema（如把参数 location 改为
    # path）而 http_config 未变时，会复用旧闭包中绑定的旧 schema，导致路径参数不生效。
    if tool_type == "http":
        schema_for_cache = getattr(tool, "parameters_schema", None) or []
        cache_summary = "http:" + json.dumps(
            {"http_config": http_config, "parameters_schema": schema_for_cache},
            sort_keys=True,
            ensure_ascii=False,
        )
    else:
        # code 工具的缓存键需纳入 enabled_kbs + agent_id + user_id：同一工具在不同
        # 智能体/用户下注入的命名空间闭包捕获值不同（enabled_kbs / current_agent_id /
        # current_user_id 不同），若只用 code 作键会复用旧缓存，导致查到错误作用域。
        cache_summary = (
            code + "||enabled_kbs=" + ",".join(str(k) for k in (enabled_kbs or []))
            + "||agent_id=" + str(agent_id or "")
            + "||user_id=" + str(user_id or "")
        )

    cached = _tool_cache.get(name)
    if cached is not None and cached[1] == cache_summary:
        logger.debug("复用工具缓存: %s", name)
        return cached[0]

    # ===== HTTP 工具：构造 run 协程 =====
    if tool_type == "http":
        from app.core.tool_http_runner import run_http_tool

        # 用闭包绑定 http_config / schema，避免延迟捕获问题
        cfg_snapshot = json.loads(json.dumps(http_config))  # 深拷贝
        schema_snapshot = list(getattr(tool, "parameters_schema", None) or [])

        async def _http_run(**kwargs):
            # 弹出内部保留的 log_handler kwarg（run_tool 为 HTTP 工具注入），
            # 不传递给 run_http_tool 的 parameters，避免污染参数分发。
            lh = kwargs.pop(_LOG_HANDLER_KWARG, None)
            return await run_http_tool(cfg_snapshot, kwargs, schema_snapshot, log_handler=lh)

        _tool_cache[name] = (_http_run, cache_summary)
        logger.info("HTTP 工具已加载并缓存: %s, url=%s", name, cfg_snapshot.get("url"))
        return _http_run

    # ===== Code 工具：编译 Python 代码（沙箱审查） =====
    if not code.strip():
        raise ValueError(f"工具 {name} 代码为空")

    # P0-3：AST 静态审查，拦截危险 import 与双下划线访问
    try:
        validate_tool_code(code)
    except CodeValidationError as exc:
        logger.warning("工具 %s 代码安全审查失败: %s", name, exc)
        raise ValueError(f"工具 {name} 代码安全审查失败: {exc}") from exc

    # 独立命名空间，注入常用模块供用户代码使用
    # 注意：__builtins__ 替换为白名单，阻断 __import__/open/eval 等运行时访问
    namespace: dict[str, Any] = {
        "__name__": f"tool_{name}",
        "__builtins__": build_safe_builtins(),
        "asyncio": asyncio,
        "json": json,
        "datetime": datetime,
        "timedelta": timedelta,
        "re": re,
        "ipaddress": ipaddress,
    }
    # httpx 按需注入（允许工具发起 HTTP 请求，但禁止文件系统/进程操作）
    try:
        import httpx  # noqa: F401

        namespace["httpx"] = httpx
    except ImportError:  # pragma: no cover
        logger.debug("httpx 未安装，工具命名空间不注入 httpx")

    # 文档读取能力注入：read_uploaded_file 辅助函数 + 文档解析库
    # read_uploaded_file 内部查 DB 定位文件并解析（xlsx/docx/pdf/csv/txt），
    # 工具代码无需关心文件路径，直接调用 read_uploaded_file("报表.xlsx") 即可。
    namespace["save_agent_memory"] = save_agent_memory
    namespace["recall_agent_memory"] = recall_agent_memory
    # 安全 Excel 文件助手：供 expand_risk_detail / compare_risk_exports 工具调用
    # （按上传文件名读取 xlsx / 把生成的 xlsx 写回上传文件库并注册 AgentFile）
    # 通过 partial 注入 agent_id/user_id 作用域：文件读取限定本智能体（+公共回退），
    # 生成文件记录归属智能体与对话用户，实现双层隔离。
    try:
        from functools import partial as _partial

        namespace["read_uploaded_file"] = _partial(read_uploaded_file, agent_id=agent_id)
        namespace["load_excel_workbook"] = _partial(load_excel_workbook, agent_id=agent_id)
        namespace["save_workbook_as_agent_file"] = _partial(
            save_workbook_as_agent_file, agent_id=agent_id, user_id=user_id
        )
        namespace["save_json_as_agent_file"] = _partial(
            save_json_as_agent_file, agent_id=agent_id, user_id=user_id
        )
    except Exception:  # pragma: no cover
        logger.debug("文件助手作用域注入失败，回退直接注入")
        namespace["read_uploaded_file"] = read_uploaded_file
        namespace["load_excel_workbook"] = load_excel_workbook
        namespace["save_workbook_as_agent_file"] = save_workbook_as_agent_file
        namespace["save_json_as_agent_file"] = save_json_as_agent_file
    # 模板驱动改造新增：按表头名称定位列（含模糊匹配）+ JSON 写回上传库（save_template）
    namespace["find_col"] = find_col
    # expand_risk_detail 未传模板时的标准 22 列白名单（与技能文档一致）
    namespace["DEFAULT_RISK_COLUMNS"] = DEFAULT_RISK_COLUMNS

    # 安全上下文工具注入：沙箱禁止 __import__，工具代码无法用 import 语句
    # 导入 app.tools.context_tools / app.devices.firewall。此处将函数直接注入
    # 命名空间，工具代码可直接调用 get_asset_info(ip) 等，无需 import。
    try:
        from app.tools.context_tools import (
            check_subnet,
            check_whitelist,
            get_asset_info,
            get_threat_intel,
        )
        namespace["get_asset_info"] = get_asset_info
        namespace["get_threat_intel"] = get_threat_intel
        namespace["check_whitelist"] = check_whitelist
        namespace["check_subnet"] = check_subnet
    except ImportError:  # pragma: no cover
        logger.debug("context_tools 未安装，工具命名空间不注入安全上下文函数")
    # 渗透测试安全工具集（nmap/nuclei/hydra 等）已整体退役，沙箱命名空间不再注入
    # app.tools.security_tools 函数；底层封装模块保留，供未来按需重新封装为工具。
    try:
        from app.devices.firewall import block_ip_on_firewall
        namespace["block_ip_on_firewall"] = block_ip_on_firewall
    except ImportError:  # pragma: no cover
        logger.debug("firewall 模块未安装，工具命名空间不注入 block_ip_on_firewall")
    # 设备动作执行注入：execute_device_action_by_id 按动作 ID 调用设备 API
    # （智能体 execute_device_action 工具使用）。通过 partial 绑定 agent_id/user_id
    # 审计作用域（DeviceCallLog source='agent'），工具代码无需显式传递。
    try:
        from functools import partial as _partial

        from app.devices.action_executor import execute_device_action_by_id

        namespace["execute_device_action_by_id"] = _partial(
            execute_device_action_by_id, agent_id=agent_id, user_id=user_id
        )
    except ImportError:  # pragma: no cover
        logger.debug("action_executor 未安装，工具命名空间不注入 execute_device_action_by_id")
    try:
        import openpyxl  # noqa: F401
        namespace["openpyxl"] = openpyxl
    except ImportError:  # pragma: no cover
        logger.debug("openpyxl 未安装，工具命名空间不注入 openpyxl")
    try:
        import docx  # noqa: F401
        namespace["docx"] = docx
    except ImportError:  # pragma: no cover
        logger.debug("python-docx 未安装，工具命名空间不注入 docx")
    try:
        from pypdf import PdfReader  # noqa: F401
        namespace["PdfReader"] = PdfReader
    except ImportError:  # pragma: no cover
        logger.debug("pypdf 未安装，工具命名空间不注入 pypdf")

    # 知识库检索能力注入：允许工具代码查询「当前智能体勾选的知识库」。
    # - search_kb(kb_id, query, top_k=5)：分段级混合检索，返回命中片段列表。
    # - enabled_kbs：当前智能体勾选的知识库 ID 列表（由 tool_engine 传入）。
    # 工具代码可直接遍历 enabled_kbs 调用 search_kb，无需 import（沙箱禁止 import）。
    # 典型场景：get_asset_info 查询勾选知识库中的 IP 资产归属。
    try:
        from app.core.kb_retriever import search_kb

        namespace["search_kb"] = search_kb
    except ImportError:  # pragma: no cover
        logger.debug("kb_retriever 未安装，工具命名空间不注入 search_kb")
    namespace["enabled_kbs"] = list(enabled_kbs or [])
    namespace["enabled_asset_types"] = []
    try:
        from app.agent.decision import execute_search_assets

        namespace["run_search_assets"] = execute_search_assets
    except ImportError:  # pragma: no cover
        logger.debug("decision 未安装，工具命名空间不注入 run_search_assets")
    try:
        from app.agent.discovery_search import execute_search_discovered_assets

        namespace["run_search_discovered_assets"] = execute_search_discovered_assets
    except ImportError:  # pragma: no cover
        logger.debug("discovery_search 未安装，工具命名空间不注入 run_search_discovered_assets")

    # 数据库访问注入：允许工具查询已封禁 IP 表（query_banned_ip 等只读场景）
    # 注意：智能体只做研判与建议，不提供任何写入封禁记录的能力（record_ban 已禁用，
    # record_chat_ban 注入已移除），封禁一律由人工在工作台/工单流转中执行。
    # 同时注入 KnowledgeBase / KnowledgeSegment，供 get_asset_info 查询知识库名称和精确 IP 匹配
    # 注入 Asset 供资产管理智能体的 query_asset / add_asset / update_asset 等工具读写资产表
    # 注入 Device / DeviceAction 供 query_device_actions 等设备对接工具查询设备与动作清单
    try:
        from app.database import SessionLocal
        from app.models.banned_ip import BannedIP
        from app.models.workflow_ban import BanRecord
        from app.models.knowledge_base import KnowledgeBase, KnowledgeSegment
        from app.models.asset import Asset
        from app.models.device import Device, DeviceAction
        from app.core.timezone import beijing_now
        namespace["SessionLocal"] = SessionLocal
        namespace["BannedIP"] = BannedIP
        namespace["BanRecord"] = BanRecord
        namespace["KnowledgeBase"] = KnowledgeBase
        namespace["KnowledgeSegment"] = KnowledgeSegment
        namespace["Asset"] = Asset
        namespace["Device"] = Device
        namespace["DeviceAction"] = DeviceAction
    except ImportError:  # pragma: no cover
        logger.debug("数据库模块未安装，工具命名空间不注入 SessionLocal/BannedIP/BanRecord/KnowledgeBase/Asset")
    # 当前智能体 ID：供资产工具按 agent_id 作用域过滤（agent_id+identifier 去重）
    namespace["current_agent_id"] = agent_id
    # 当前对话用户 ID：供工具生成文件归属 created_by（双层隔离）
    namespace["current_user_id"] = user_id

    try:
        exec(compile(code, f"<tool:{name}>", "exec"), namespace)  # noqa: S102
    except Exception as exc:
        logger.exception("工具 %s 代码编译失败: %s", name, exc)
        raise ValueError(f"工具 {name} 代码编译失败: {exc}") from exc

    run_fn = namespace.get("run")
    if run_fn is None or not callable(run_fn):
        raise ValueError(f"工具 {name} 未定义 run 函数")

    _tool_cache[name] = (run_fn, cache_summary)
    logger.info("工具已加载并缓存（沙箱审查通过）: %s", name)
    return run_fn


async def run_tool(
    tool, parameters: dict, log_handler: LogHandler | None = None
) -> dict:
    """执行工具的 ``run(**parameters)`` 并返回结果。

    捕获执行异常，失败时返回 ``{"error": str(exc)}`` 而非抛出，
    便于工作流节点与 API 测试接口统一处理。

    Args:
        tool: ``Tool`` ORM 实例。
        parameters: 调用参数字典。
        log_handler: 可选日志回调 ``(level, message)``。仅对 HTTP 工具生效：
            通过保留 kwarg ``_soar_log_handler`` 注入到 ``_http_run``，再透传给
            ``run_http_tool``，用于在工具测试时回传「实际请求 URL / 参数分发 /
            响应状态」等执行链路日志。code 工具不接收此回调。

    Returns:
        ``{"result": <run 返回值>}`` 成功，或 ``{"error": "..."}`` 失败。
    """
    name = getattr(tool, "name", "unknown")
    tool_type = (getattr(tool, "tool_type", "code") or "code").lower()
    params = dict(parameters or {})
    # 仅 HTTP 工具注入 log_handler；code 工具的 run() 不识别该 kwarg。
    if log_handler is not None and tool_type == "http":
        params[_LOG_HANDLER_KWARG] = log_handler
    logger.info("执行工具: name=%s, params=%s", name, parameters)
    try:
        run_fn = load_tool_function(tool)
        result = await run_fn(**params)
        logger.info("工具执行成功: name=%s, result=%s", name, result)
        return {"result": result}
    except Exception as exc:  # noqa: BLE001
        logger.exception("工具执行异常: name=%s, error=%s", name, exc)
        if log_handler is not None:
            try:
                log_handler("error", f"工具执行异常: {exc}")
            except Exception:  # noqa: BLE001
                pass
        return {"error": str(exc)}


def clear_tool_cache(name: Optional[str] = None) -> None:
    """清除工具缓存（更新/删除工具时调用）。"""
    if name is None:
        _tool_cache.clear()
        logger.info("已清除全部工具缓存")
    elif name in _tool_cache:
        del _tool_cache[name]
        logger.info("已清除工具缓存: %s", name)
