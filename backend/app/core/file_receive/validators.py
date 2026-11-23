"""文件接收字段校验与文件内容巡检。"""
import hashlib
import json
import math
import re
import unicodedata
import zipfile
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath

from app.config import settings
from app.core.file_receive.constants import (
    BIZ_TYPES,
    DEFAULT_ALLOWED_EXTS,
    DEFAULT_MIME_BY_EXT,
    EXECUTABLE_MAGICS,
    FORBIDDEN_EXTS,
    MIME_BY_EXT,
)
from app.core.file_receive.errors import FileReceiveError
from app.core.timezone import BEIJING_TZ, beijing_now

MAX_BODY_BYTES = 32 * 1024
MAX_BIZ_FIELDS_BYTES = 16 * 1024
MAX_BIZ_FIELDS_KEYS = 50

FILENAME_RE = re.compile(r"^[^/\\\x00-\x1f]+$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$")
BIZ_NO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#-]{0,63}$")
BIZ_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

# 外部系统只需提供来源、文件名、内容类型；其余字段全部由服务端生成
REQUIRED_FIELDS = ("source_system", "file_name", "content_type")

WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _err(code: str, status: int, message: str, *, details=None, retryable=False):
    raise FileReceiveError(
        code, status, message, details=details, retryable=retryable
    )


def _require_str(payload: dict, field: str, min_len: int, max_len: int) -> str:
    value = payload.get(field)
    if value is None or (isinstance(value, str) and not value.strip()):
        _err("FR-VAL-001", 400, f"缺少必填字段: {field}", details=[{"field": field, "reason": "field required"}])
    if not isinstance(value, str):
        _err("FR-VAL-002", 400, f"字段类型错误: {field} 应为字符串", details=[{"field": field, "reason": "expect string"}])
    value = value.strip()
    if not (min_len <= len(value) <= max_len):
        _err(
            "FR-VAL-002", 400,
            f"字段长度非法: {field} 应在 {min_len}-{max_len} 之间",
            details=[{"field": field, "reason": f"length {min_len}-{max_len}"}],
        )
    return value


def normalize_filename(raw: str) -> str:
    """规范化并校验原始文件名。"""
    name = unicodedata.normalize("NFC", raw or "").strip()
    if not name:
        _err("FR-VAL-005", 400, "文件名不能为空")
    if len(name) > 255:
        _err("FR-VAL-005", 400, "文件名长度不能超过 255 个字符")
    if not FILENAME_RE.match(name):
        _err("FR-VAL-005", 400, "文件名包含非法字符（路径分隔符或控制字符）")
    if ".." in name:
        _err("FR-VAL-005", 400, "文件名不允许包含 '..'")
    if name.endswith(".") or name.endswith(" "):
        _err("FR-VAL-005", 400, "文件名不能以点或空格结尾")
    base = name.rsplit(".", 1)[0].strip().upper()
    if base in WINDOWS_RESERVED:
        _err("FR-VAL-005", 400, f"文件名使用了系统保留名: {base}")
    return name


def _validate_biz_fields(value) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        _err("FR-VAL-006", 400, "biz_fields 必须是对象", details=[{"field": "biz_fields", "reason": "expect object"}])
    if len(value) > MAX_BIZ_FIELDS_KEYS:
        _err("FR-VAL-006", 400, f"biz_fields 最多 {MAX_BIZ_FIELDS_KEYS} 个键")
    for key, item in value.items():
        if not isinstance(key, str) or not BIZ_KEY_RE.match(key):
            _err("FR-VAL-006", 400, f"biz_fields 键名非法: {key}", details=[{"field": f"biz_fields.{key}", "reason": "invalid key"}])
        if isinstance(item, (dict, list)) and not isinstance(item, list):
            _err("FR-VAL-006", 400, f"biz_fields.{key} 不允许嵌套对象")
        if isinstance(item, list):
            if len(item) > 50:
                _err("FR-VAL-006", 400, f"biz_fields.{key} 数组最多 50 项")
            for sub in item:
                if isinstance(sub, (dict, list)) or not isinstance(sub, (str, int, float, bool)):
                    _err("FR-VAL-006", 400, f"biz_fields.{key} 数组仅允许标量")
                if isinstance(sub, str) and len(sub) > 2000:
                    _err("FR-VAL-006", 400, f"biz_fields.{key} 字符串过长")
        elif isinstance(item, str):
            if len(item) > 2000:
                _err("FR-VAL-006", 400, f"biz_fields.{key} 字符串过长（最多 2000 字符）")
        elif item is not None and not isinstance(item, (int, float, bool)):
            _err("FR-VAL-006", 400, f"biz_fields.{key} 类型不支持")
    try:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        _err("FR-VAL-006", 400, "biz_fields 无法序列化")
    if len(raw.encode("utf-8")) > MAX_BIZ_FIELDS_BYTES:
        _err("FR-VAL-006", 400, "biz_fields 序列化后不能超过 16 KiB")
    return value


def _parse_push_time(value) -> datetime:
    if not isinstance(value, str) or not value.strip():
        _err("FR-VAL-001", 400, "缺少必填字段: push_time")
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        _err("FR-VAL-002", 400, "push_time 必须是 RFC3339 时间", details=[{"field": "push_time", "reason": "invalid datetime"}])
    if dt.tzinfo is not None:
        dt = dt.astimezone(BEIJING_TZ).replace(tzinfo=None)
    if dt > beijing_now() + timedelta(minutes=5):
        _err("FR-VAL-007", 400, "push_time 不能晚于服务端时间 5 分钟以上")
    return dt


def _validate_content_type(value, ext: str) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > 128:
        _err("FR-VAL-002", 400, "content_type 非法")
    content_type = value.strip().lower()
    if not content_type:
        _err("FR-VAL-001", 400, "缺少必填字段: content_type")
    expected = MIME_BY_EXT.get(ext)
    if expected and content_type not in expected:
        _err(
            "FR-TYPE-004", 415,
            f"content_type 与文件扩展名不匹配: {content_type}",
            details=[{"field": "content_type", "reason": f"expect one of {sorted(expected)}"}],
        )
    return content_type


def build_fingerprint(source_code: str, data: dict) -> str:
    """计算幂等指纹（不含 push_time）。"""
    canonical = {
        "source_code": source_code,
        "biz_type": data.get("biz_type") or "",
        "biz_no": data.get("biz_no") or "",
        "file_name": data.get("file_name") or "",
        "file_size": int(data.get("file_size") or 0),
        "file_sha256": (data.get("file_sha256") or "").lower(),
        "content_type": data.get("content_type") or "",
        "biz_fields": data.get("biz_fields") or {},
    }
    raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def validate_create_payload(payload: dict, source) -> dict:
    """校验创建接收任务的业务字段，返回规范化结果。"""
    if not isinstance(payload, dict):
        _err("FR-VAL-002", 400, "请求体必须是 JSON 对象")

    missing = [name for name in REQUIRED_FIELDS if payload.get(name) in (None, "")]
    if missing:
        _err(
            "FR-VAL-001", 400,
            f"缺少必填字段: {', '.join(missing)}",
            details=[{"field": name, "reason": "field required"} for name in missing],
        )

    source_system = _require_str(payload, "source_system", 2, 64)
    if source_system != source.source_code:
        _err(
            "FR-VAL-003", 400,
            f"source_system 与凭证不一致（凭证来源: {source.source_code}）",
            details=[{"field": "source_system", "reason": "must equal credential source_code"}],
        )

    # 业务类型固定为报告；业务编号由服务端生成。客户端传入的值会被忽略。
    biz_type = "report"
    biz_no = None

    file_name = normalize_filename(_require_str(payload, "file_name", 1, 255))
    if "." not in file_name:
        _err("FR-TYPE-001", 415, "文件名缺少扩展名", details=[{"field": "file_name", "reason": "extension required"}])
    ext = file_name.rsplit(".", 1)[-1].lower()
    if ext in FORBIDDEN_EXTS:
        _err("FR-TYPE-003", 415, f"禁止上传可执行或高风险文件类型: .{ext}")
    allowed = {str(e).lower().lstrip(".") for e in (source.allowed_exts or DEFAULT_ALLOWED_EXTS)}
    allowed -= FORBIDDEN_EXTS
    if ext not in allowed:
        _err(
            "FR-TYPE-001", 415,
            f"文件扩展名不在白名单: .{ext}",
            details=[{"field": "file_name", "reason": f"allowed: {sorted(allowed)}"}],
        )

    # 大小/哈希/推送时间/业务扩展字段均由服务端生成或统计
    file_size = 0
    file_sha256 = ""

    # content_type 是必填字段（已在 REQUIRED_FIELDS 中校验非空）
    content_type = _validate_content_type(payload.get("content_type"), ext)
    biz_fields: dict = {}
    push_time = beijing_now()

    chunk_size = max(1, int(settings.FILE_RECEIVE_CHUNK_SIZE_MB)) * 1024 * 1024
    total_parts = max(1, math.ceil(file_size / chunk_size)) if file_size else 0
    if total_parts > int(settings.FILE_RECEIVE_MAX_PARTS):
        _err(
            "FR-VAL-002", 400,
            f"分片数量超过上限（{settings.FILE_RECEIVE_MAX_PARTS}）",
            details=[{"field": "file_size", "reason": "too many parts"}],
        )

    normalized = {
        "source_system": source_system,
        "biz_type": biz_type,
        "biz_no": biz_no,
        "biz_fields": biz_fields,
        "file_name": file_name,
        "file_ext": ext,
        "file_size": file_size,
        "file_sha256": file_sha256,
        "content_type": content_type,
        "push_time": push_time,
        "chunk_size": chunk_size,
        "total_parts": total_parts,
    }
    # 指纹在 service 中待 biz_no 确定（可能由系统生成）后统一计算
    return normalized


# ============ 文件内容巡检 ============

def _inspect_zip(path: Path) -> None:
    """ZIP/OOXML 安全巡检：条目数、解压总量、压缩比、危险路径。"""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            if len(infos) > 1000:
                _err("FR-ARCH-001", 422, "压缩包条目数超过 1000，疑似压缩炸弹")
            total_uncompressed = sum(i.file_size for i in infos)
            total_compressed = max(1, sum(i.compress_size for i in infos))
            if total_uncompressed > 2 * 1024 * 1024 * 1024:
                _err("FR-ARCH-001", 422, "压缩包解压后超过 2 GiB，疑似压缩炸弹")
            if total_uncompressed / total_compressed > 100:
                _err("FR-ARCH-001", 422, "压缩比超过 100:1，疑似压缩炸弹")
            for info in infos:
                name = info.filename or ""
                if name.startswith("/") or "\\" in name:
                    _err("FR-ARCH-001", 422, "压缩包包含非法绝对路径或反斜杠路径")
                if ".." in PurePosixPath(name).parts:
                    _err("FR-ARCH-001", 422, "压缩包包含路径穿越条目")
                mode = (info.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    _err("FR-ARCH-001", 422, "压缩包包含符号链接条目")
    except FileReceiveError:
        raise
    except (zipfile.BadZipFile, OSError) as exc:
        raise FileReceiveError("FR-TYPE-002", 415, f"ZIP/OOXML 文件损坏或格式不符: {exc}") from exc


def _decode_text_sample(head: bytes) -> None:
    if b"\x00" in head[:4096]:
        _err("FR-TYPE-002", 415, "文本文件包含 NUL 字节，疑似二进制文件")
    sample = head[:8192]
    for cut in range(0, 4):
        try:
            sample[: len(sample) - cut].decode("utf-8")
            return
        except UnicodeDecodeError:
            continue
    _err("FR-TYPE-002", 415, "文本文件不是合法 UTF-8 编码")


def inspect_file(path: Path, ext: str) -> tuple[str, str]:
    """校验文件魔数/结构，返回 (detected_mime, archive_check)。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192)
    except OSError as exc:
        raise FileReceiveError("FR-FILE-002", 500, f"读取文件失败: {exc}", retryable=True) from exc
    if not head:
        raise FileReceiveError("FR-FILE-001", 422, "文件内容为空")

    for magic in EXECUTABLE_MAGICS:
        if head.startswith(magic):
            _err("FR-TYPE-003", 415, "检出可执行文件特征，已拒绝")

    mime = DEFAULT_MIME_BY_EXT.get(ext, "application/octet-stream")
    archive_check = "not_applicable"

    if ext == "pdf":
        if not head.startswith(b"%PDF-"):
            _err("FR-TYPE-002", 415, "PDF 文件魔数不匹配")
    elif ext in ("doc", "xls", "ppt"):
        if not head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
            _err("FR-TYPE-002", 415, f".{ext} 文件不是合法的 OLE2 文档")
    elif ext in ("docx", "xlsx", "pptx"):
        if not head.startswith(b"PK\x03\x04"):
            _err("FR-TYPE-002", 415, f".{ext} 文件不是合法的 OOXML（ZIP）文档")
        try:
            with zipfile.ZipFile(path) as zf:
                if "[Content_Types].xml" not in zf.namelist():
                    _err("FR-TYPE-002", 415, f".{ext} 文件缺少 OOXML 结构")
        except zipfile.BadZipFile as exc:
            raise FileReceiveError("FR-TYPE-002", 415, f".{ext} 文件损坏") from exc
        _inspect_zip(path)
        archive_check = "passed"
    elif ext == "zip":
        if not head.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            _err("FR-TYPE-002", 415, "ZIP 文件魔数不匹配")
        _inspect_zip(path)
        archive_check = "passed"
    elif ext == "rar":
        if not head.startswith((b"Rar!\x1a\x07\x00", b"Rar!\x1a\x07\x01\x00")):
            _err("FR-TYPE-002", 415, "RAR 文件魔数不匹配")
        archive_check = "skipped"
    elif ext == "7z":
        if not head.startswith(b"7z\xbc\xaf\x27\x1c"):
            _err("FR-TYPE-002", 415, "7Z 文件魔数不匹配")
        archive_check = "skipped"
    elif ext in ("txt", "csv", "md", "json", "xml"):
        _decode_text_sample(head)
    return mime, archive_check
