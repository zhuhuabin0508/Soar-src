"""奇安信天擎终端软件资产：按天擎 ODP 接口逐终端同步已安装软件清单。

数据来源：天擎 ODP GraphQL 接口 ``softid_clientid``（按终端 client_id 查询）。
每条软件保留终端快照（client_id / 计算机名 / IP / 系统类型 / 分组），
列表、导出与 CVE 版本匹配无需再 join 终端表：
- ``source_id`` = ``{设备ID}:{client_id}:{软件身份摘要}``，软件升级原地更新；
- ``soft_id`` 为天擎软件库 ID，可用于后续 CVE 关联；
- ODP 未知字段落 ``extra``，天擎升级不丢字段。
"""
from __future__ import annotations

import json

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 全量字段（导出 / 详情口径），顺序即导出列顺序
TIANQING_SOFTWARE_FIELDS = [
    "client_id",
    "computer_name",
    "ip",
    "os_type",
    "group_name",
    "soft_name",
    "version",
    "soft_id",
    "corp",
    "install_source",
    "install_time",
    "license",
    "newest_ver",
    "size",
    "is_update",
]

# 列表页展示字段（子集，顺序即列顺序）
TIANQING_SOFTWARE_LIST_FIELDS = [
    "computer_name",
    "ip",
    "os_type",
    "soft_name",
    "version",
    "corp",
    "install_source",
    "install_time",
    "newest_ver",
    "group_name",
]

TIANQING_SOFTWARE_FIELD_LABELS = {
    "client_id": "终端 ID",
    "computer_name": "计算机名",
    "ip": "IP 地址",
    "os_type": "系统类型",
    "group_name": "终端分组",
    "soft_name": "软件名",
    "name_norm": "软件名（归一化）",
    "version": "版本",
    "version_norm": "版本（归一化）",
    "soft_id": "软件 ID",
    "corp": "厂商",
    "install_source": "安装来源",
    "install_time": "安装时间",
    "license": "授权",
    "newest_ver": "最新版本",
    "size": "大小",
    "is_update": "可升级",
    "tianqing_device_name": "天擎平台",
}

# upsert 时需要更新的列（不含 source_id / 设备维度 / created_at）
TIANQING_SOFTWARE_UPDATE_COLS = [
    *TIANQING_SOFTWARE_FIELDS,
    "name_norm",
    "version_norm",
    "tianqing_device_name",
    "extra",
    "batch_id",
    "updated_at",
]


class TianqingSoftwareAsset(Base):
    """天擎终端软件资产（一台终端上的一个软件一行）。"""

    __tablename__ = "tianqing_software"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_tianqing_software_source"),
        Index("ix_tianqing_software_device_client", "tianqing_device_id", "client_id"),
        Index(
            "ix_tianqing_software_name_trgm",
            "name_norm",
            postgresql_using="gin",
            postgresql_ops={"name_norm": "gin_trgm_ops"},
        ),
        Index("ix_tianqing_software_soft_id", "soft_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    # 来源天擎设备（devices.id）：多台天擎平台的数据都在这一张表
    tianqing_device_id = Column(Integer, nullable=False, default=0)
    tianqing_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    # 终端快照
    client_id = Column(String(128), nullable=False, default="")
    computer_name = Column(String(255), nullable=False, default="")
    ip = Column(String(64), nullable=False, default="")
    os_type = Column(String(32), nullable=False, default="")
    group_name = Column(String(255), nullable=False, default="")

    # 软件信息
    soft_name = Column(String(512), nullable=False, default="")
    name_norm = Column(String(512), nullable=False, default="")
    version = Column(String(255), nullable=False, default="")
    version_norm = Column(String(255), nullable=False, default="")
    soft_id = Column(String(64), nullable=False, default="")
    corp = Column(String(255), nullable=False, default="")
    install_source = Column(String(128), nullable=False, default="")
    install_time = Column(String(32), nullable=False, default="")
    license = Column(String(64), nullable=False, default="")
    newest_ver = Column(String(255), nullable=False, default="")
    size = Column(String(32), nullable=False, default="")
    is_update = Column(Boolean, nullable=True)

    # ODP 未知字段兜底
    extra = Column(JSONB, nullable=False, default=dict)

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return (
            f"<TianqingSoftwareAsset id={self.id} {self.soft_name!r} "
            f"host={self.computer_name!r} device={self.tianqing_device_id}>"
        )

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "tianqing_device_id": self.tianqing_device_id,
            "tianqing_device_name": self.tianqing_device_name or "",
            "batch_id": self.batch_id,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in TIANQING_SOFTWARE_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        extra = dict(self.extra or {})
        for key, val in extra.items():
            if key not in data:
                data[key] = val
        # 布尔字段转中文展示，便于列表直接阅读
        if self.is_update is not None:
            data["is_update"] = "可升级" if self.is_update else "已最新"
        return data
