"""跨系统文件接收模型。

- ``FileReceiveSource``：外部来源系统（凭证、配额、白名单、格式策略）。
- ``FileReceiveObject``：内容寻址的物理对象（SHA-256 唯一，引用计数）。
- ``FileReceiveRecord``：一次文件推送的接收任务。
- ``FileReceivePart``：分片上传记录。
- ``FileReceiveEvent``：接收任务状态轨迹。
- ``FileReceiveAccessLog``：对外接口调用日志。
"""
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)

from app.core.timezone import beijing_now
from app.database import Base


class FileReceiveSource(Base):
    """外部来源系统。"""

    __tablename__ = "file_receive_sources"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_code = Column(String(64), unique=True, nullable=False, index=True)
    source_name = Column(String(128), nullable=False)
    access_key = Column(String(64), unique=True, nullable=False, index=True)
    # Fernet 密文；明文仅在创建/轮换响应中出现一次
    secret_enc = Column(String(512), nullable=False)
    secret_enc_prev = Column(String(512), nullable=True)
    secret_hint = Column(String(8), nullable=False, default="")
    secret_rotated_at = Column(DateTime, nullable=True)
    status = Column(String(16), nullable=False, default="active", index=True)
    allowed_ips = Column(JSON, nullable=False, default=list)
    allowed_exts = Column(JSON, nullable=False, default=list)
    qps = Column(Integer, nullable=False, default=20)
    burst = Column(Integer, nullable=False, default=40)
    max_concurrent_sessions = Column(Integer, nullable=False, default=8)
    max_file_size_mb = Column(Integer, nullable=False, default=200)
    session_ttl_minutes = Column(Integer, nullable=False, default=120)
    dedupe_scope = Column(String(16), nullable=False, default="content")
    scan_required = Column(Boolean, nullable=False, default=False)
    contact = Column(String(255), nullable=False, default="")
    remark = Column(String(500), nullable=False, default="")
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=beijing_now)
    updated_at = Column(DateTime, nullable=False, default=beijing_now, onupdate=beijing_now)
    last_push_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:
        return f"<FileReceiveSource id={self.id} code={self.source_code!r}>"


class FileReceiveObject(Base):
    """最终落盘的物理对象（按 SHA-256 内容寻址，可被多条记录复用）。"""

    __tablename__ = "file_receive_objects"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sha256 = Column(String(64), unique=True, nullable=False, index=True)
    file_size = Column(BigInteger, nullable=False, default=0)
    storage_path = Column(String(500), nullable=False)
    storage_backend = Column(String(16), nullable=False, default="local")
    file_ext = Column(String(16), nullable=False, default="")
    ref_count = Column(Integer, nullable=False, default=0)
    status = Column(String(16), nullable=False, default="active", index=True)
    created_at = Column(DateTime, nullable=False, default=beijing_now)
    deleted_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:
        return f"<FileReceiveObject id={self.id} sha={self.sha256[:12]!r}>"


class FileReceiveBizNoSequence(Base):
    """报告编号按日序号（RPT-YYYYMMDD-序号）。

    通过 PostgreSQL 原子 upsert 递增，保证多实例并发下不重复。
    """

    __tablename__ = "file_receive_biz_no_sequences"

    biz_date = Column(String(8), primary_key=True)
    last_seq = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return f"<FileReceiveBizNoSequence date={self.biz_date} last={self.last_seq}>"


class FileReceiveRecord(Base):
    """一次文件推送的接收任务。"""

    __tablename__ = "file_receive_records"
    __table_args__ = (
        UniqueConstraint("source_id", "request_id", name="uq_fr_source_request"),
        Index("ix_fr_records_status_time", "status", "received_at"),
        Index("ix_fr_records_source_time", "source_code", "received_at"),
        Index("ix_fr_records_biz", "biz_type", "biz_no"),
        Index("ix_fr_records_sha", "declared_sha256"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    request_id = Column(String(64), nullable=False)
    source_id = Column(Integer, ForeignKey("file_receive_sources.id"), nullable=False, index=True)
    source_code = Column(String(64), nullable=False)
    source_name = Column(String(128), nullable=False)
    upload_id = Column(String(64), unique=True, nullable=True, index=True)
    biz_type = Column(String(32), nullable=False)
    biz_no = Column(String(64), nullable=False)
    biz_fields = Column(JSON, nullable=False, default=dict)
    file_name = Column(String(255), nullable=False)
    file_ext = Column(String(16), nullable=False)
    file_size = Column(BigInteger, nullable=False)
    declared_sha256 = Column(String(64), nullable=False)
    object_id = Column(BigInteger, ForeignKey("file_receive_objects.id"), nullable=True)
    storage_path = Column(String(500), nullable=True)
    content_type = Column(String(128), nullable=False, default="")
    detected_mime = Column(String(128), nullable=False, default="")
    scan_status = Column(String(16), nullable=False, default="skipped")
    archive_check = Column(String(16), nullable=False, default="skipped")
    status = Column(String(16), nullable=False, index=True)
    chunk_size = Column(Integer, nullable=False, default=4194304)
    total_parts = Column(Integer, nullable=False, default=1)
    received_parts = Column(Integer, nullable=False, default=0)
    uploaded_bytes = Column(BigInteger, nullable=False, default=0)
    error_code = Column(String(32), nullable=True)
    error_message = Column(String(500), nullable=True)
    retryable = Column(Boolean, nullable=False, default=False)
    dedupe_of_id = Column(BigInteger, nullable=True)
    is_duplicate = Column(Boolean, nullable=False, default=False)
    request_fingerprint = Column(String(64), nullable=False)
    client_ip = Column(String(64), nullable=False, default="")
    user_agent = Column(String(255), nullable=False, default="")
    push_time = Column(DateTime, nullable=True)
    received_at = Column(DateTime, nullable=False, default=beijing_now)
    merged_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    deleted_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=beijing_now)
    updated_at = Column(DateTime, nullable=False, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return (
            f"<FileReceiveRecord id={self.id} request={self.request_id!r} "
            f"status={self.status!r}>"
        )


class FileReceivePart(Base):
    """分片上传记录。"""

    __tablename__ = "file_receive_parts"
    __table_args__ = (
        UniqueConstraint("record_id", "part_no", name="uq_fr_part"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    record_id = Column(
        BigInteger,
        ForeignKey("file_receive_records.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    part_no = Column(Integer, nullable=False)
    part_size = Column(Integer, nullable=False)
    part_sha256 = Column(String(64), nullable=False)
    storage_path = Column(String(500), nullable=False)
    created_at = Column(DateTime, nullable=False, default=beijing_now)

    def __repr__(self) -> str:
        return f"<FileReceivePart record={self.record_id} no={self.part_no}>"


class FileReceiveEvent(Base):
    """接收任务状态轨迹。"""

    __tablename__ = "file_receive_events"
    __table_args__ = (
        Index("ix_fr_events_record", "record_id", "id"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    record_id = Column(
        BigInteger,
        ForeignKey("file_receive_records.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_type = Column(String(32), nullable=False)
    status_from = Column(String(16), nullable=True)
    status_to = Column(String(16), nullable=True)
    message = Column(String(500), nullable=False, default="")
    detail = Column(JSON, nullable=True)
    actor = Column(String(64), nullable=False, default="system")
    created_at = Column(DateTime, nullable=False, default=beijing_now)

    def __repr__(self) -> str:
        return f"<FileReceiveEvent record={self.record_id} type={self.event_type!r}>"


class FileReceiveAccessLog(Base):
    """对外接口调用日志（P1 可接入中间件；当前模型先建表）。"""

    __tablename__ = "file_receive_access_logs"
    __table_args__ = (
        Index("ix_fr_access_time", "created_at"),
        Index("ix_fr_access_source", "source_code", "created_at"),
        Index("ix_fr_access_status", "status_code", "created_at"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    source_id = Column(Integer, nullable=True)
    source_code = Column(String(64), nullable=False, default="")
    method = Column(String(8), nullable=False)
    path = Column(String(255), nullable=False)
    status_code = Column(Integer, nullable=False, default=0)
    error_code = Column(String(32), nullable=True)
    request_id = Column(String(64), nullable=True)
    upload_id = Column(String(64), nullable=True)
    client_ip = Column(String(64), nullable=False, default="")
    bytes = Column(BigInteger, nullable=False, default=0)
    duration_ms = Column(Integer, nullable=False, default=0)
    user_agent = Column(String(255), nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=beijing_now)

    def __repr__(self) -> str:
        return f"<FileReceiveAccessLog {self.method} {self.path} status={self.status_code}>"
