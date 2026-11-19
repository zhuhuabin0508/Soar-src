"""政务云爬取资产：四类资源各一张表，Excel 列 + 业务列。

未知 Excel 列写入 extra_excel，避免爬虫增列后丢字段。
"""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.govcloud_schema import RESOURCE_EXCEL_FIELDS, excel_attr
from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base


class GovCloudImportBatch(Base):
    """一次导入批次（对应一份爬取 Excel 的「原始数据」）。"""

    __tablename__ = "govcloud_import_batches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    resource_type = Column(String(64), nullable=False, index=True)
    filename = Column(String(300), nullable=False, default="")
    file_size = Column(Integer, nullable=False, default=0)
    excel_rows = Column(Integer, nullable=False, default=0)
    unique_source_ids = Column(Integer, nullable=False, default=0)
    inserted = Column(Integer, nullable=False, default=0)
    updated = Column(Integer, nullable=False, default=0)
    deleted = Column(Integer, nullable=False, default=0)
    skipped = Column(Integer, nullable=False, default=0)
    live_count = Column(Integer, nullable=False, default=0)
    consistent = Column(Integer, nullable=False, default=0)
    duration_ms = Column(Integer, nullable=False, default=0)
    import_mode = Column(String(16), nullable=False, default="full")
    # 异步同步进度：历史批次视为已完成（success/100）
    status = Column(String(16), nullable=False, default="success")
    phase = Column(String(32), nullable=False, default="")
    percent = Column(Integer, nullable=False, default=100)
    stats = Column(JSONB, nullable=False, default=dict)
    note = Column(Text, default="")
    created_by = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "resource_type": self.resource_type,
            "filename": self.filename,
            "file_size": self.file_size,
            "excel_rows": self.excel_rows,
            "unique_source_ids": self.unique_source_ids,
            "inserted": self.inserted,
            "updated": self.updated,
            "deleted": self.deleted,
            "skipped": self.skipped,
            "live_count": self.live_count,
            "consistent": bool(self.consistent),
            "duration_ms": self.duration_ms,
            "import_mode": self.import_mode or "full",
            "status": self.status or "success",
            "phase": self.phase or "",
            "percent": int(self.percent if self.percent is not None else 100),
            "stats": self.stats or {},
            "note": self.note or "",
            "created_by": self.created_by,
            "created_at": to_beijing_iso(self.created_at),
        }


def _to_dict(self) -> dict:
    data = {
        "id": self.id,
        "source_id": self.source_id,
        "batch_id": self.batch_id,
        "created_at": to_beijing_iso(self.created_at),
        "updated_at": to_beijing_iso(self.updated_at),
    }
    for field in self.excel_fields:
        attr = excel_attr(field)
        data[field] = getattr(self, attr, "") or ""
    extra = dict(self.extra_excel or {})
    for key, val in extra.items():
        if key not in data:
            data[key] = val
    return data


def _build_resource_model(class_name: str, table_name: str, resource_type: str):
    fields = RESOURCE_EXCEL_FIELDS[resource_type]
    attrs = {
        "__tablename__": table_name,
        "__table_args__": (UniqueConstraint("source_id", name=f"uq_{table_name}_source"),),
        "id": Column(Integer, primary_key=True, autoincrement=True),
        "source_id": Column(String(128), nullable=False),
        "batch_id": Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True),
        "extra_excel": Column(JSONB, nullable=False, default=dict),
        "created_at": Column(DateTime, default=beijing_now),
        "updated_at": Column(DateTime, default=beijing_now, onupdate=beijing_now),
        "resource_type": resource_type,
        "excel_fields": fields,
        "to_dict": _to_dict,
    }
    for field in fields:
        attr = excel_attr(field)
        # Excel 表头 _id 落库为 cmdb_id，避免 upsert excluded 访问失败
        col_name = "cmdb_id" if field == "_id" else field
        attrs[attr] = Column(col_name, Text, nullable=False, default="")
    return type(class_name, (Base,), attrs)


GovCloudCloudHost = _build_resource_model("GovCloudCloudHost", "govcloud_cloud_hosts", "cloud_host")
GovCloudBareMetal = _build_resource_model("GovCloudBareMetal", "govcloud_bare_metals", "bare_metal")
GovCloudNetwork = _build_resource_model("GovCloudNetwork", "govcloud_networks", "e_government_network")
GovCloudElasticIP = _build_resource_model("GovCloudElasticIP", "govcloud_elastic_ips", "elastic_ip")

RESOURCE_MODELS = {
    "cloud_host": GovCloudCloudHost,
    "bare_metal": GovCloudBareMetal,
    "e_government_network": GovCloudNetwork,
    "elastic_ip": GovCloudElasticIP,
}
