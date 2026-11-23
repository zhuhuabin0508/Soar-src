"""文件接收存储层：分片流式落盘、合并、对象落盘与磁盘检查。

存储布局（相对 ``FILE_RECEIVE_ROOT``）：
- ``tmp/{record_id}/{part_no}.part`` 分片
- ``staging/{record_id}/merged.tmp`` 合并临时文件
- ``objects/{yyyy}/{mm}/{sha[:2]}/{sha}.{ext}`` 最终对象
"""
import hashlib
import logging
import os
import shutil
import uuid
from pathlib import Path

from fastapi import Request

from app.config import settings
from app.core.file_receive.errors import FileReceiveError
from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# file_receive/storage.py -> file_receive(0), core(1), app(2), backend(3)
_BACKEND_DIR = Path(__file__).resolve().parents[3]


def storage_root() -> Path:
    """存储根目录；相对路径按 backend 目录解析。"""
    p = Path(settings.FILE_RECEIVE_ROOT)
    if not p.is_absolute():
        p = _BACKEND_DIR / p
    return p


def ensure_dirs() -> None:
    root = storage_root()
    for sub in ("tmp", "staging", "objects", "quarantine", "trash"):
        (root / sub).mkdir(parents=True, exist_ok=True)


def _safe_abs(rel_path: str) -> Path:
    """把相对路径解析为绝对路径，阻止路径穿越。"""
    root = storage_root().resolve()
    target = (root / rel_path).resolve()
    if target != root and root not in target.parents:
        raise FileReceiveError("FR-INTERNAL-001", 500, "存储路径非法")
    return target


def fsync_dir(path: Path) -> None:
    """对目录 fsync，保证 rename 后目录项持久化（失败仅告警）。"""
    try:
        fd = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as exc:  # noqa: BLE001
        logger.debug("目录 fsync 失败（忽略）: %s (%s)", path, exc)


def part_dir(record_id: int) -> Path:
    return _safe_abs(f"tmp/{record_id}")


def part_path(record_id: int, part_no: int) -> Path:
    return part_dir(record_id) / f"{part_no:05d}.part"


def staging_path(record_id: int) -> Path:
    return _safe_abs(f"staging/{record_id}/merged.tmp")


def object_rel_path(sha256: str, ext: str) -> str:
    now = beijing_now()
    suffix = f".{ext}" if ext else ""
    return f"objects/{now.year:04d}/{now.month:02d}/{sha256[:2]}/{sha256}{suffix}"


def abs_from_rel(rel_path: str) -> Path:
    return _safe_abs(rel_path)


async def save_part_stream(
    request: Request,
    record_id: int,
    part_no: int,
    max_bytes: int,
) -> tuple[str, int, Path]:
    """把请求体流式写入分片临时文件，返回 (sha256, size, tmp_path)。

    不把请求体整体读入内存；超过 ``max_bytes`` 立即拒绝并删除临时文件。
    """
    # 每次上传使用独立临时文件，避免同一分片并发重传互相覆盖
    tmp = part_dir(record_id) / f"{part_no:05d}.{uuid.uuid4().hex}.tmp"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    total = 0
    try:
        with open(tmp, "wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    raise FileReceiveError(
                        "FR-PART-003", 400, f"分片大小超过限制（{max_bytes} 字节）"
                    )
                hasher.update(chunk)
                fh.write(chunk)
            fh.flush()
            os.fsync(fh.fileno())
    except FileReceiveError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return hasher.hexdigest(), total, tmp


def promote_part(tmp_path: Path, record_id: int, part_no: int) -> str:
    """把校验通过的分片临时文件原子改名为正式分片，返回相对路径。"""
    target = part_path(record_id, part_no)
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp_path, target)
    fsync_dir(target.parent)
    return f"tmp/{record_id}/{part_no:05d}.part"


def merge_parts(record_id: int, parts) -> tuple[str, Path]:
    """按分片编号顺序流式合并，返回 (全文件 SHA-256, 合并临时文件路径)。"""
    staging = staging_path(record_id)
    staging.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    try:
        with open(staging, "wb") as out:
            for part in sorted(parts, key=lambda p: p.part_no):
                src_path = abs_from_rel(part.storage_path)
                with open(src_path, "rb") as src:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        hasher.update(chunk)
            out.flush()
            os.fsync(out.fileno())
    except Exception:
        staging.unlink(missing_ok=True)
        raise
    return hasher.hexdigest(), staging


def store_object(tmp_path: Path, sha256: str, ext: str) -> tuple[str, bool]:
    """把合并文件落到内容寻址对象路径。

    Returns:
        ``(relative_path, is_new)``；同 SHA 对象已存在时删除临时文件并返回 False。
    """
    rel = object_rel_path(sha256, ext)
    target = abs_from_rel(rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        tmp_path.unlink(missing_ok=True)
        return rel, False
    os.replace(tmp_path, target)
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    fsync_dir(target.parent)
    return rel, True


def remove_record_temp(record_id: int) -> None:
    """删除某接收任务的分片与合并临时目录。"""
    for path in (part_dir(record_id), staging_path(record_id).parent):
        try:
            shutil.rmtree(path, ignore_errors=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("清理文件接收临时目录失败: %s (%s)", path, exc)


def remove_empty_part_dir(record_id: int) -> None:
    """成功合并后删除分片文件目录（数据库分片记录保留用于详情展示）。"""
    shutil.rmtree(part_dir(record_id), ignore_errors=True)


def disk_usage_pct() -> float:
    """存储根目录所在分区使用率（0-100）。"""
    ensure_dirs()
    usage = shutil.disk_usage(storage_root())
    if usage.total <= 0:
        return 0.0
    return usage.used / usage.total * 100


def check_disk_capacity(declared_size: int) -> None:
    """接入前磁盘水位与剩余空间检查。"""
    ensure_dirs()
    usage = shutil.disk_usage(storage_root())
    pct = usage.used / usage.total * 100 if usage.total else 0.0
    if pct >= settings.FILE_RECEIVE_DISK_REJECT_PCT:
        raise FileReceiveError(
            "FR-BUSY-003",
            503,
            "存储空间水位过高，暂停接收新文件",
            retryable=True,
            retry_after=60,
        )
    # 合并阶段会短暂占用约 2 倍单文件空间，并预留 64MB 余量
    required = int(declared_size * 2 + 64 * 1024 * 1024)
    if usage.free < required:
        raise FileReceiveError(
            "FR-STORAGE-001",
            507,
            "存储空间不足，请联系平台管理员扩容",
            retryable=True,
            retry_after=60,
        )
    if pct >= settings.FILE_RECEIVE_DISK_WARN_PCT:
        logger.warning("文件接收存储水位偏高: %.1f%%", pct)
