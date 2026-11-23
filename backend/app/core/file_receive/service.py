"""文件接收领域服务：创建、分片、完成、重试、查询与序列化。"""
import logging
import uuid
from datetime import timedelta

from sqlalchemy import func, or_
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.core.file_receive import limiter, storage, validators
from app.core.file_receive.constants import ACTIVE_STATUSES, STATUS_LABELS
from app.core.file_receive.errors import FileReceiveError
from app.core.timezone import beijing_now, to_beijing_iso
from app.models.file_receive import (
    FileReceiveBizNoSequence,
    FileReceiveEvent,
    FileReceiveObject,
    FileReceivePart,
    FileReceiveRecord,
    FileReceiveSource,
)

logger = logging.getLogger(__name__)


def _upload_id() -> str:
    return "up_" + uuid.uuid4().hex


def _next_biz_no(db: Session) -> str:
    """生成 RPT-YYYYMMDD-序号（按日原子递增，多实例安全）。"""
    date_str = beijing_now().strftime("%Y%m%d")
    dialect = db.get_bind().dialect.name if db.get_bind() is not None else ""
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = (
            pg_insert(FileReceiveBizNoSequence)
            .values(biz_date=date_str, last_seq=1)
            .on_conflict_do_update(
                index_elements=["biz_date"],
                set_={
                    "last_seq": FileReceiveBizNoSequence.last_seq + 1,
                    "updated_at": beijing_now(),
                },
            )
            .returning(FileReceiveBizNoSequence.last_seq)
        )
        seq = int(db.execute(stmt).scalar_one())
    else:
        row = (
            db.query(FileReceiveBizNoSequence)
            .filter(FileReceiveBizNoSequence.biz_date == date_str)
            .with_for_update()
            .first()
        )
        if row is None:
            row = FileReceiveBizNoSequence(biz_date=date_str, last_seq=1)
            db.add(row)
            db.flush()
        else:
            row.last_seq = int(row.last_seq or 0) + 1
        seq = int(row.last_seq)
    return f"RPT-{date_str}-{seq:04d}"


def _fingerprint(source: FileReceiveSource, normalized: dict, biz_no: str) -> str:
    return validators.build_fingerprint(
        source.source_code, {**normalized, "biz_no": biz_no}
    )


def _add_event(
    db: Session,
    record: FileReceiveRecord,
    event_type: str,
    status_from: str | None,
    status_to: str | None,
    message: str,
    *,
    actor: str = "system",
    detail: dict | None = None,
) -> None:
    db.add(
        FileReceiveEvent(
            record_id=record.id,
            event_type=event_type,
            status_from=status_from,
            status_to=status_to,
            message=(message or "")[:500],
            detail=detail,
            actor=actor,
        )
    )


def _parts(db: Session, record_id: int) -> list[FileReceivePart]:
    return (
        db.query(FileReceivePart)
        .filter(FileReceivePart.record_id == record_id)
        .order_by(FileReceivePart.part_no.asc())
        .all()
    )


def _missing_parts(record: FileReceiveRecord, parts: list[FileReceivePart]) -> list[int]:
    have = {p.part_no for p in parts}
    return [n for n in range(1, int(record.total_parts or 0) + 1) if n not in have]


def _get_record(db: Session, source_id: int, upload_id: str) -> FileReceiveRecord:
    record = (
        db.query(FileReceiveRecord)
        .filter(
            FileReceiveRecord.source_id == source_id,
            FileReceiveRecord.upload_id == upload_id,
            FileReceiveRecord.deleted_at.is_(None),
        )
        .first()
    )
    if record is None:
        raise FileReceiveError("FR-NOTFOUND-001", 404, "接收任务不存在")
    return record


def _get_record_by_request(db: Session, source_id: int, request_id: str) -> FileReceiveRecord:
    record = (
        db.query(FileReceiveRecord)
        .filter(
            FileReceiveRecord.source_id == source_id,
            FileReceiveRecord.request_id == request_id,
            FileReceiveRecord.deleted_at.is_(None),
        )
        .first()
    )
    if record is None:
        raise FileReceiveError("FR-NOTFOUND-001", 404, "接收任务不存在")
    return record


def record_open_state(db: Session, record: FileReceiveRecord, *, idempotent: bool = False) -> dict:
    """对外返回任务状态（创建/查询/完成共用）。"""
    parts = _parts(db, record.id) if record.status in ACTIVE_STATUSES else []
    data = {
        "receipt_id": record.id,
        "request_id": record.request_id,
        "upload_id": record.upload_id,
        "status": record.status,
        "status_label": STATUS_LABELS.get(record.status, record.status),
        "biz_type": record.biz_type,
        "biz_no": record.biz_no,
        "file_name": record.file_name,
        "file_ext": record.file_ext,
        "file_size": record.file_size,
        "file_sha256": record.declared_sha256,
        "idempotent": idempotent,
    }
    if record.status in ACTIVE_STATUSES:
        total_parts = int(record.total_parts or 0)
        data.update({
            "chunk_size": record.chunk_size,
            # 大小未声明时 total_parts 为 null，客户端上传到 EOF 后直接 complete
            "total_parts": total_parts or None,
            "upload_mode": "fixed" if int(record.file_size or 0) > 0 else "open",
            "uploaded_parts": [
                {
                    "part_no": p.part_no,
                    "part_size": p.part_size,
                    "part_sha256": p.part_sha256,
                }
                for p in parts
            ],
            "missing_parts": _missing_parts(record, parts) if total_parts else [],
            "expires_at": to_beijing_iso(record.expires_at),
        })
        return data
    if record.status in ("MERGING", "VERIFYING"):
        data.update({"next_poll_after_ms": 1000})
        return data
    data.update({
        "storage_path": record.storage_path,
        "is_duplicate": record.is_duplicate,
        "merged_at": to_beijing_iso(record.merged_at),
        "completed_at": to_beijing_iso(record.completed_at),
        "error_code": record.error_code,
        "error_message": record.error_message,
        "retryable": record.retryable,
    })
    return data


def create_receipt(
    db: Session,
    source: FileReceiveSource,
    payload: dict,
    *,
    client_ip: str = "",
    user_agent: str = "",
) -> dict:
    """创建接收任务；request_id、业务编号等全部由服务端生成。"""
    normalized = validators.validate_create_payload(payload, source)

    limiter.check_session_limit(db, source)
    # 大小未知时按来源上限预留空间，避免开放分片模式绕过磁盘水位
    check_size = min(
        int(source.max_file_size_mb or settings.FILE_RECEIVE_MAX_FILE_MB),
        int(settings.FILE_RECEIVE_MAX_FILE_MB),
    ) * 1024 * 1024
    storage.check_disk_capacity(check_size)

    request_id = "req_" + uuid.uuid4().hex
    biz_no = _next_biz_no(db)
    normalized["request_id"] = request_id
    normalized["biz_no"] = biz_no
    fingerprint = _fingerprint(source, normalized, biz_no)

    now = beijing_now()
    ttl = max(30, min(1440, int(source.session_ttl_minutes or settings.FILE_RECEIVE_SESSION_TTL_MINUTES)))
    record = FileReceiveRecord(
        request_id=request_id,
        source_id=source.id,
        source_code=source.source_code,
        source_name=source.source_name,
        upload_id=_upload_id(),
        biz_type=normalized["biz_type"],
        biz_no=biz_no,
        biz_fields=normalized["biz_fields"],
        file_name=normalized["file_name"],
        file_ext=normalized["file_ext"],
        file_size=normalized["file_size"],
        declared_sha256=normalized["file_sha256"],
        content_type=normalized["content_type"],
        status="INIT",
        chunk_size=normalized["chunk_size"],
        total_parts=normalized["total_parts"],
        received_parts=0,
        uploaded_bytes=0,
        request_fingerprint=fingerprint,
        client_ip=(client_ip or "")[:64],
        user_agent=(user_agent or "")[:255],
        push_time=normalized["push_time"],
        received_at=now,
        expires_at=now + timedelta(minutes=ttl),
        created_at=now,
        updated_at=now,
    )
    db.add(record)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise FileReceiveError(
            "FR-INTERNAL-001", 500, "创建接收任务失败，请重试", retryable=True
        )

    db.query(FileReceiveSource).filter(FileReceiveSource.id == source.id).update(
        {"last_push_at": now}, synchronize_session=False
    )
    db.add(
        FileReceiveEvent(
            record_id=record.id,
            event_type="CREATED",
            status_from=None,
            status_to="INIT",
            message="接收任务已创建",
            actor="system",
            detail={"request_id": request_id},
        )
    )
    db.commit()
    db.refresh(record)
    return record_open_state(db, record)


async def save_part(
    db: Session,
    source: FileReceiveSource,
    upload_id: str,
    part_no: int,
    request,
) -> dict:
    """流式接收一个分片（幂等）。"""
    record = _get_record(db, source.id, upload_id)
    request.state.fr_request_id = record.request_id
    if record.status not in ACTIVE_STATUSES:
        raise FileReceiveError("FR-STATE-002", 409, f"当前状态 {record.status} 不允许上传分片")
    if record.expires_at and record.expires_at <= beijing_now():
        record.status = "EXPIRED"
        record.completed_at = beijing_now()
        record.error_code = "FR-STATE-001"
        record.error_message = "上传会话已过期"
        _add_event(db, record, "EXPIRED", "UPLOADING", "EXPIRED", "上传会话已过期")
        db.commit()
        raise FileReceiveError("FR-STATE-001", 409, "上传会话已过期，请使用新的 request_id 重新创建")

    fixed_total = int(record.total_parts or 0)
    max_parts = fixed_total or int(settings.FILE_RECEIVE_MAX_PARTS)
    if part_no < 1 or part_no > max_parts:
        raise FileReceiveError("FR-PART-001", 400, f"分片编号越界（1-{max_parts}）")

    raw_length = (request.headers.get("content-length") or "").strip()
    if not raw_length:
        raise FileReceiveError("FR-PART-005", 411, "分片请求缺少 Content-Length")
    try:
        content_length = int(raw_length)
    except ValueError:
        raise FileReceiveError("FR-PART-005", 411, "Content-Length 非法")

    if int(record.file_size or 0) > 0:
        # 固定分片模式：每片大小精确匹配
        expected_size = min(
            int(record.chunk_size),
            int(record.file_size) - (part_no - 1) * int(record.chunk_size),
        )
        if content_length != expected_size:
            raise FileReceiveError(
                "FR-PART-003", 400,
                f"分片大小与协议不符（期望 {expected_size}，实际 {content_length}）",
                details=[{"field": "Content-Length", "reason": f"expect {expected_size}"}],
            )
    else:
        # 开放分片模式：大小未知，每片 1..chunk_size，最后一片可小于 chunk_size
        if content_length <= 0 or content_length > int(record.chunk_size):
            raise FileReceiveError(
                "FR-PART-003", 400,
                f"分片大小必须在 1-{record.chunk_size} 字节之间",
                details=[{"field": "Content-Length", "reason": f"1-{record.chunk_size}"}],
            )
        expected_size = content_length

    declared_part_sha = (request.headers.get("x-content-sha256") or "").strip().lower()
    if len(declared_part_sha) != 64:
        raise FileReceiveError("FR-SIGN-001", 401, "缺少或非法 X-Content-SHA256")

    existing = (
        db.query(FileReceivePart)
        .filter(FileReceivePart.record_id == record.id, FileReceivePart.part_no == part_no)
        .first()
    )
    max_mb = min(
        int(source.max_file_size_mb or settings.FILE_RECEIVE_MAX_FILE_MB),
        int(settings.FILE_RECEIVE_MAX_FILE_MB),
    )
    max_bytes = max_mb * 1024 * 1024
    uploaded_total = int(
        db.query(func.coalesce(func.sum(FileReceivePart.part_size), 0))
        .filter(FileReceivePart.record_id == record.id)
        .scalar()
        or 0
    )
    if existing is not None:
        # 重传同一分片时先扣除旧片，避免误判超限
        uploaded_total -= int(existing.part_size or 0)
    if uploaded_total + content_length > max_bytes:
        raise FileReceiveError(
            "FR-SIZE-001", 413,
            f"文件大小超过限制（最大 {max_mb} MiB）",
            details=[{"field": "Content-Length", "reason": f"total>{max_bytes}"}],
        )

    with limiter.upload_slot(record.id):
        actual_sha, actual_size, tmp_path = await storage.save_part_stream(
            request, record.id, part_no, expected_size
        )
    if actual_size != expected_size:
        tmp_path.unlink(missing_ok=True)
        raise FileReceiveError(
            "FR-PART-003", 400,
            f"分片实际大小与 Content-Length 不符（{actual_size} != {expected_size}）",
        )
    if actual_sha != declared_part_sha:
        tmp_path.unlink(missing_ok=True)
        raise FileReceiveError("FR-FILE-001", 400, "分片 SHA-256 与水印不一致")

    # 并发保护：分片写盘期间 complete 可能已抢占 MERGING，此时拒绝再入库
    db.refresh(record)
    if record.status not in ACTIVE_STATUSES:
        tmp_path.unlink(missing_ok=True)
        raise FileReceiveError("FR-STATE-002", 409, f"当前状态 {record.status} 不允许上传分片")

    # 写盘期间可能有并发请求写入同一分片，入库前重新确认
    existing = (
        db.query(FileReceivePart)
        .filter(FileReceivePart.record_id == record.id, FileReceivePart.part_no == part_no)
        .first()
    )
    if existing is not None:
        tmp_path.unlink(missing_ok=True)
        if existing.part_sha256 != actual_sha:
            raise FileReceiveError("FR-PART-002", 409, "同一分片编号已存在且内容不同")
        progress = _progress(db, record)
        return {
            "upload_id": record.upload_id,
            "part_no": part_no,
            "part_size": existing.part_size,
            "received_parts": progress["received_parts"],
            "total_parts": record.total_parts,
            "uploaded_bytes": progress["uploaded_bytes"],
            "progress": progress["progress"],
            "idempotent": True,
        }

    rel_path = storage.promote_part(tmp_path, record.id, part_no)
    db.add(
        FileReceivePart(
            record_id=record.id,
            part_no=part_no,
            part_size=actual_size,
            part_sha256=actual_sha,
            storage_path=rel_path,
        )
    )
    old_status = record.status
    if record.status == "INIT":
        record.status = "UPLOADING"
    record.updated_at = beijing_now()
    try:
        db.flush()
        progress = _progress(db, record)
        record.received_parts = progress["received_parts"]
        record.uploaded_bytes = progress["uploaded_bytes"]
        if old_status == "INIT":
            _add_event(
                db, record, "PART_UPLOADED", "INIT", "UPLOADING",
                f"首个分片上传成功（分片 {part_no}）",
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        "upload_id": record.upload_id,
        "part_no": part_no,
        "part_size": actual_size,
        "received_parts": record.received_parts,
        "total_parts": record.total_parts,
        "uploaded_bytes": record.uploaded_bytes,
        "progress": round(record.received_parts / max(1, record.total_parts), 4),
    }


def _progress(db: Session, record: FileReceiveRecord) -> dict:
    count, total = (
        db.query(
            func.count(FileReceivePart.id),
            func.coalesce(func.sum(FileReceivePart.part_size), 0),
        )
        .filter(FileReceivePart.record_id == record.id)
        .one()
    )
    count = int(count or 0)
    total_parts = int(record.total_parts or 0)
    return {
        "received_parts": count,
        "uploaded_bytes": int(total or 0),
        "progress": round(count / total_parts, 4) if total_parts else 0,
    }


def complete_receipt(
    db: Session,
    source: FileReceiveSource,
    upload_id: str,
    payload: dict,
) -> tuple[dict, int]:
    """完成上传：校验分片、流式合并、内容巡检、对象去重与落盘。"""
    record = _get_record(db, source.id, upload_id)
    record_id = record.id
    if record.status == "SUCCESS":
        return record_open_state(db, record, idempotent=True), 200
    if record.status in ("MERGING", "VERIFYING"):
        return record_open_state(db, record, idempotent=True), 202
    if record.status in ("EXPIRED", "CANCELED"):
        raise FileReceiveError("FR-STATE-001", 409, f"当前状态 {record.status} 不允许完成")
    if record.status == "FAILED" and not record.retryable:
        raise FileReceiveError(
            "FR-STATE-002",
            409,
            f"任务已失败且不可重试: {record.error_message or record.error_code}",
        )

    declared_sha = record.declared_sha256 or ""
    payload_size = None
    if payload.get("file_size") not in (None, ""):
        try:
            payload_size = int(payload["file_size"])
        except (TypeError, ValueError):
            raise FileReceiveError("FR-VAL-002", 400, "file_size 必须是整数")
    if payload.get("file_sha256") not in (None, ""):
        complete_sha = str(payload["file_sha256"]).strip().lower()
        if not validators.SHA256_RE.match(complete_sha):
            raise FileReceiveError("FR-VAL-002", 400, "file_sha256 必须是 64 位十六进制")
        if declared_sha and complete_sha != declared_sha:
            raise FileReceiveError("FR-FILE-001", 422, "complete 声明的 SHA-256 与创建任务不一致")
        declared_sha = complete_sha

    parts = _parts(db, record_id)
    if not parts:
        raise FileReceiveError("FR-PART-004", 409, "尚未上传任何分片", retryable=True)
    if len(parts) > int(settings.FILE_RECEIVE_MAX_PARTS):
        raise FileReceiveError("FR-PART-001", 400, "分片数量超过上限")

    part_nos = [int(p.part_no) for p in parts]
    if part_nos != list(range(1, len(parts) + 1)):
        have = set(part_nos)
        missing = [n for n in range(1, max(part_nos) + 1) if n not in have]
        raise FileReceiveError(
            "FR-PART-004", 409,
            f"分片不连续，缺少编号: {missing}",
            retryable=True,
            details=[{"field": "missing_parts", "reason": missing}],
        )

    fixed_missing = _missing_parts(record, parts)
    if fixed_missing:
        raise FileReceiveError(
            "FR-PART-004", 409,
            f"仍有 {len(fixed_missing)} 个分片未上传",
            retryable=True,
            details=[{"field": "missing_parts", "reason": fixed_missing}],
        )

    total_size = sum(int(p.part_size) for p in parts)
    max_mb = min(
        int(source.max_file_size_mb or settings.FILE_RECEIVE_MAX_FILE_MB),
        int(settings.FILE_RECEIVE_MAX_FILE_MB),
    )
    max_bytes = max_mb * 1024 * 1024
    if total_size <= 0 or total_size > max_bytes:
        raise FileReceiveError(
            "FR-SIZE-001", 413,
            f"文件大小超过限制（最大 {max_mb} MiB）",
        )
    if int(record.file_size or 0) > 0 and total_size != int(record.file_size):
        raise FileReceiveError(
            "FR-SIZE-002", 400,
            f"分片总大小与声明大小不一致（{total_size} != {record.file_size}）",
        )
    if payload_size is not None and payload_size != total_size:
        raise FileReceiveError(
            "FR-SIZE-002", 400,
            f"complete 声明大小与分片总大小不一致（{payload_size} != {total_size}）",
        )

    with limiter.merge_slot(record_id):
        updated = (
            db.query(FileReceiveRecord)
            .filter(
                FileReceiveRecord.id == record_id,
                FileReceiveRecord.status.in_(("UPLOADING", "FAILED")),
                or_(
                    FileReceiveRecord.status == "UPLOADING",
                    FileReceiveRecord.retryable.is_(True),
                ),
            )
            .update(
                {"status": "MERGING", "updated_at": beijing_now()},
                synchronize_session=False,
            )
        )
        db.commit()
        if not updated:
            current = db.query(FileReceiveRecord).filter(FileReceiveRecord.id == record_id).first()
            if current is None:
                raise FileReceiveError("FR-NOTFOUND-001", 404, "接收任务不存在")
            if current.status in ("MERGING", "VERIFYING"):
                return record_open_state(db, current, idempotent=True), 202
            if current.status == "SUCCESS":
                return record_open_state(db, current, idempotent=True), 200
            raise FileReceiveError("FR-STATE-002", 409, f"当前状态 {current.status} 不允许完成")

        record = db.query(FileReceiveRecord).filter(FileReceiveRecord.id == record_id).first()
        _add_event(db, record, "MERGING", "UPLOADING", "MERGING", "开始合并分片")
        try:
            db.commit()
        except Exception:
            db.rollback()

        try:
            actual_sha, staging = storage.merge_parts(record_id, parts)
            if declared_sha and actual_sha != declared_sha:
                staging.unlink(missing_ok=True)
                _fail_record(
                    db, record_id, "FR-FILE-001", "整文件 SHA-256 与声明不一致",
                    retryable=False,
                )
                raise FileReceiveError("FR-FILE-001", 422, "整文件 SHA-256 与声明不一致")

            detected_mime, archive_check = validators.inspect_file(staging, record.file_ext)
            rel_path, _is_new_file = storage.store_object(
                staging, actual_sha, record.file_ext
            )

            obj = db.query(FileReceiveObject).filter(FileReceiveObject.sha256 == actual_sha).first()
            if obj is None:
                from sqlalchemy.dialects.postgresql import insert as pg_insert

                stmt = (
                    pg_insert(FileReceiveObject)
                    .values(
                        sha256=actual_sha,
                        file_size=total_size,
                        storage_path=rel_path,
                        storage_backend="local",
                        file_ext=record.file_ext,
                        ref_count=0,
                        status="active",
                    )
                    .on_conflict_do_nothing(index_elements=["sha256"])
                )
                db.execute(stmt)
                obj = db.query(FileReceiveObject).filter(FileReceiveObject.sha256 == actual_sha).first()
            if obj is None:
                raise FileReceiveError("FR-FILE-002", 500, "对象入库失败", retryable=True)
            if obj.status != "active":
                raise FileReceiveError("FR-FILE-002", 500, "对象已隔离，无法引用", retryable=False)

            db.execute(
                sa_update(FileReceiveObject)
                .where(FileReceiveObject.id == obj.id)
                .values(ref_count=FileReceiveObject.ref_count + 1)
            )
            db.expire(obj, ["ref_count"])

            is_duplicate = False
            dedupe_of_id = None
            if (source.dedupe_scope or "content") == "content":
                prior = (
                    db.query(FileReceiveRecord)
                    .filter(
                        FileReceiveRecord.source_code == record.source_code,
                        FileReceiveRecord.biz_type == record.biz_type,
                        FileReceiveRecord.biz_no == record.biz_no,
                        FileReceiveRecord.declared_sha256 == actual_sha,
                        FileReceiveRecord.status == "SUCCESS",
                        FileReceiveRecord.id != record.id,
                        FileReceiveRecord.deleted_at.is_(None),
                    )
                    .order_by(FileReceiveRecord.id.asc())
                    .first()
                )
                if prior is not None:
                    is_duplicate = True
                    dedupe_of_id = prior.id

            now = beijing_now()
            record.object_id = obj.id
            record.storage_path = rel_path or obj.storage_path
            record.detected_mime = detected_mime
            record.archive_check = archive_check
            record.scan_status = "skipped"
            record.is_duplicate = is_duplicate
            record.dedupe_of_id = dedupe_of_id
            record.status = "SUCCESS"
            record.retryable = False
            record.error_code = None
            record.error_message = None
            record.merged_at = now
            record.completed_at = now
            # 未声明大小/哈希时，以服务端实际合并结果回填
            record.file_size = total_size
            record.total_parts = len(parts)
            record.declared_sha256 = actual_sha
            record.received_parts = len(parts)
            record.uploaded_bytes = total_size
            record.updated_at = now
            _add_event(db, record, "MERGED", "MERGING", "SUCCESS", "合并完成，完整性校验通过")
            if is_duplicate:
                _add_event(
                    db, record, "DEDUPED", "SUCCESS", "SUCCESS",
                    f"内容与接收记录 {dedupe_of_id} 重复，复用物理对象",
                )
            db.commit()
            db.refresh(record)
            # 成功后删除分片文件，数据库分片记录保留用于详情展示
            storage.remove_empty_part_dir(record_id)
            return record_open_state(db, record, idempotent=False), 200
        except FileReceiveError as exc:
            db.rollback()
            _fail_record(
                db, record_id, exc.code, exc.message,
                retryable=exc.retryable,
            )
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("文件接收合并失败: record=%s", record_id)
            db.rollback()
            _fail_record(db, record_id, "FR-FILE-002", f"合并失败: {exc}", retryable=True)
            raise FileReceiveError("FR-FILE-002", 500, "合并或落盘失败，请稍后重试", retryable=True)


def _fail_record(db: Session, record_id: int, code: str, message: str, *, retryable: bool) -> None:
    record = db.query(FileReceiveRecord).filter(FileReceiveRecord.id == record_id).first()
    if record is None:
        return
    if record.status == "FAILED":
        return
    now = beijing_now()
    record.status = "FAILED"
    record.error_code = code
    record.error_message = (message or "")[:500]
    record.retryable = retryable
    record.completed_at = now
    record.updated_at = now
    _add_event(db, record, "FAILED", "MERGING", "FAILED", message)
    try:
        db.commit()
    except Exception:
        db.rollback()


def retry_receipt(db: Session, source: FileReceiveSource, upload_id: str) -> tuple[dict, int]:
    record = _get_record(db, source.id, upload_id)
    if record.status != "FAILED" or not record.retryable:
        raise FileReceiveError("FR-STATE-002", 409, "仅可重试的失败任务支持重试")
    parts = _parts(db, record.id)
    missing = _missing_parts(record, parts)
    if missing:
        raise FileReceiveError(
            "FR-PART-004", 409, "分片不完整，无法重试",
            retryable=True,
            details=[{"field": "missing_parts", "reason": missing}],
        )
    # 开放模式成功前 file_size 为 0、哈希为空，不能作为显式声明传给 complete
    retry_payload: dict = {}
    if int(record.file_size or 0) > 0:
        retry_payload["file_size"] = int(record.file_size)
    if record.declared_sha256:
        retry_payload["file_sha256"] = record.declared_sha256

    record.status = "UPLOADING"
    record.error_code = None
    record.error_message = None
    record.retryable = False
    record.updated_at = beijing_now()
    _add_event(db, record, "RETRIED", "FAILED", "UPLOADING", "人工/外部触发重试")
    db.commit()
    return complete_receipt(db, source, upload_id, retry_payload)


def abort_receipt(db: Session, source: FileReceiveSource, upload_id: str) -> tuple[dict, int]:
    record = _get_record(db, source.id, upload_id)
    if record.status in ACTIVE_STATUSES:
        record.status = "CANCELED"
        record.completed_at = beijing_now()
        record.updated_at = beijing_now()
        _add_event(db, record, "CANCELED", "UPLOADING", "CANCELED", "外部系统取消上传")
        db.commit()
        storage.remove_record_temp(record.id)
        return record_open_state(db, record), 200
    if record.status == "CANCELED":
        return record_open_state(db, record, idempotent=True), 200
    raise FileReceiveError("FR-STATE-002", 409, f"当前状态 {record.status} 不允许取消")


def get_session(db: Session, source: FileReceiveSource, upload_id: str) -> dict:
    record = _get_record(db, source.id, upload_id)
    return record_open_state(db, record)


def get_by_request(db: Session, source: FileReceiveSource, request_id: str) -> dict:
    record = _get_record_by_request(db, source.id, request_id)
    return record_open_state(db, record, idempotent=True)


def recover_stuck_merging(db: Session) -> int:
    """把长时间停留在 MERGING 的任务恢复为可重试失败（进程崩溃兜底）。"""
    cutoff = beijing_now() - timedelta(minutes=30)
    records = (
        db.query(FileReceiveRecord)
        .filter(
            FileReceiveRecord.status == "MERGING",
            FileReceiveRecord.updated_at < cutoff,
        )
        .all()
    )
    for record in records:
        record.status = "FAILED"
        record.error_code = "FR-INTERNAL-001"
        record.error_message = "合并任务超时，已自动标记失败，可重试"
        record.retryable = True
        record.completed_at = beijing_now()
        record.updated_at = beijing_now()
        _add_event(db, record, "FAILED", "MERGING", "FAILED", "合并任务超时")
    if records:
        db.commit()
    return len(records)


# ============ 管理端序列化 ============

def record_summary(record: FileReceiveRecord) -> dict:
    return {
        "id": record.id,
        "request_id": record.request_id,
        "source_code": record.source_code,
        "source_name": record.source_name,
        "biz_type": record.biz_type,
        "biz_no": record.biz_no,
        "biz_fields": record.biz_fields or {},
        "file_name": record.file_name,
        "file_ext": record.file_ext,
        "file_size": record.file_size,
        "file_sha256": record.declared_sha256,
        "upload_id": record.upload_id,
        "content_type": record.content_type,
        "chunk_size": record.chunk_size,
        "push_time": to_beijing_iso(record.push_time),
        "status": record.status,
        "status_label": STATUS_LABELS.get(record.status, record.status),
        "storage_path": record.storage_path,
        "received_at": to_beijing_iso(record.received_at),
        "completed_at": to_beijing_iso(record.completed_at),
        "received_parts": record.received_parts,
        "total_parts": record.total_parts,
        "is_duplicate": record.is_duplicate,
        "dedupe_of_id": record.dedupe_of_id,
        "error_code": record.error_code,
        "error_message": record.error_message,
        "retryable": record.retryable,
    }


def record_detail(db: Session, record: FileReceiveRecord) -> dict:
    parts = _parts(db, record.id)
    events = (
        db.query(FileReceiveEvent)
        .filter(FileReceiveEvent.record_id == record.id)
        .order_by(FileReceiveEvent.id.asc())
        .all()
    )
    obj = (
        db.query(FileReceiveObject).filter(FileReceiveObject.id == record.object_id).first()
        if record.object_id
        else None
    )
    summary = record_summary(record)
    summary.update({
        "client_ip": record.client_ip,
        "user_agent": record.user_agent,
        "push_time": to_beijing_iso(record.push_time),
        "expires_at": to_beijing_iso(record.expires_at),
        "created_at": to_beijing_iso(record.created_at),
        "updated_at": to_beijing_iso(record.updated_at),
        "merged_at": to_beijing_iso(record.merged_at),
    })
    return {
        "record": summary,
        "file": {
            "file_name": record.file_name,
            "file_ext": record.file_ext,
            "file_size": record.file_size,
            "file_sha256": record.declared_sha256,
            "content_type": record.content_type,
            "detected_mime": record.detected_mime,
            "scan_status": record.scan_status,
            "archive_check": record.archive_check,
            "storage_path": record.storage_path,
            "storage_backend": obj.storage_backend if obj else "local",
        },
        "parts": {
            "total": record.total_parts,
            "received": len(parts),
            "uploaded_bytes": sum(int(p.part_size) for p in parts),
            "items": [
                {
                    "part_no": p.part_no,
                    "part_size": p.part_size,
                    "part_sha256": p.part_sha256,
                    "created_at": to_beijing_iso(p.created_at),
                }
                for p in parts
            ],
        },
        "events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "status_from": e.status_from,
                "status_to": e.status_to,
                "message": e.message,
                "actor": e.actor,
                "created_at": to_beijing_iso(e.created_at),
            }
            for e in events
        ],
    }
