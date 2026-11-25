"""青藤组件资产：按青藤平台（设备管理 auth_type=qingteng）同步组件清单。

本期覆盖 CVE 匹配所需的五类组件：
- pkg：安装包（Linux rpm/dpkg、Windows 软件）
- app：软件应用
- dbinfo：数据库
- jar_pkg：Jar 包（仅 Linux）
- webframe：Web 应用框架

设计要点：
- 每条组件保留主机快照（agent_id / IP / 主机名 / 业务组），列表与导出无需 join；
- ``source_id`` 由设备 + 来源 + 主机 + 组件身份生成，组件升级原地更新；
- 与 ``qingteng_hosts`` 仅按 ``(qingteng_device_id, agent_id)`` 逻辑关联，不建外键；
- 未知字段落 ``extra``，青藤升级不丢字段。
"""
from __future__ import annotations

import json

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 组件来源类型与展示名（顺序即同步顺序）
COMPONENT_SOURCE_LABELS = {
    "pkg": "安装包",
    "app": "软件应用",
    "dbinfo": "数据库",
    "jar_pkg": "Jar 包",
    "webframe": "Web 框架",
}
COMPONENT_SOURCES = tuple(COMPONENT_SOURCE_LABELS)

# 全量字段（导出 / 详情口径），顺序即导出列顺序
QINGTENG_COMPONENT_FIELDS = [
    "source_type",
    "os_type",
    "agent_id",
    "hostname",
    "display_ip",
    "internal_ip",
    "external_ip",
    "biz_group",
    "name",
    "version",
    "component_type",
    "path",
    "port",
    "publisher",
    "uname",
    "install_time",
    "remark",
]

# 列表页展示字段（子集，顺序即列顺序）
QINGTENG_COMPONENT_LIST_FIELDS = [
    "hostname",
    "display_ip",
    "os_type",
    "source_type_label",
    "name",
    "version",
    "component_type",
    "path",
    "biz_group",
]

QINGTENG_COMPONENT_FIELD_LABELS = {
    "source_type": "组件来源",
    "source_type_label": "组件来源",
    "os_type": "系统类型",
    "agent_id": "Agent ID",
    "hostname": "主机名",
    "display_ip": "展示 IP",
    "internal_ip": "内部 IP",
    "external_ip": "外部 IP",
    "biz_group": "业务组",
    "name": "组件名",
    "name_norm": "组件名（归一化）",
    "version": "版本",
    "version_norm": "版本（归一化）",
    "component_type": "组件类型",
    "path": "安装路径",
    "port": "端口",
    "publisher": "发布者",
    "uname": "运行用户",
    "install_time": "安装时间",
    "remark": "备注",
}

# upsert 时需要更新的列（不含 source_id / 设备维度 / created_at）
QINGTENG_COMPONENT_UPDATE_COLS = [
    *QINGTENG_COMPONENT_FIELDS,
    "name_norm",
    "version_norm",
    "qingteng_device_name",
    "extra",
    "batch_id",
    "updated_at",
]


class QingtengComponentAsset(Base):
    """青藤组件资产（一台主机上的一个组件一行）。"""

    __tablename__ = "qingteng_components"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_qingteng_components_source"),
        Index("ix_qingteng_components_device_source", "qingteng_device_id", "source_type"),
        Index("ix_qingteng_components_agent", "agent_id"),
        Index("ix_qingteng_components_ip", "display_ip"),
        Index(
            "ix_qingteng_components_name_trgm",
            "name_norm",
            postgresql_using="gin",
            postgresql_ops={"name_norm": "gin_trgm_ops"},
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    # 来源青藤设备（devices.id）：多青藤平台的数据都在这一张表。
    # 设备维度查询走 (qingteng_device_id, source_type) 复合索引，无需单列索引。
    qingteng_device_id = Column(Integer, nullable=False, default=0)
    qingteng_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    # 来源与主机快照
    source_type = Column(String(16), nullable=False, default="")
    os_type = Column(String(16), nullable=False, default="")
    agent_id = Column(String(64), nullable=False, default="")
    hostname = Column(String(255), nullable=False, default="")
    display_ip = Column(String(255), nullable=False, default="")
    internal_ip = Column(String(255), nullable=False, default="")
    external_ip = Column(String(255), nullable=False, default="")
    biz_group = Column(String(255), nullable=False, default="")
    remark = Column(Text, nullable=False, default="")

    # 组件信息
    name = Column(String(512), nullable=False, default="")
    name_norm = Column(String(512), nullable=False, default="")
    version = Column(String(255), nullable=False, default="")
    version_norm = Column(String(255), nullable=False, default="")
    component_type = Column(String(64), nullable=False, default="")
    path = Column(String(1024), nullable=False, default="")
    port = Column(Integer, nullable=True)
    publisher = Column(String(255), nullable=False, default="")
    uname = Column(String(128), nullable=False, default="")
    install_time = Column(String(32), nullable=False, default="")

    # API 未知字段兜底
    extra = Column(JSONB, nullable=False, default=dict)

    # 内容指纹：增量同步时用于跳过未变化行
    row_hash = Column(String(40), nullable=False, default="")

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    @property
    def source_type_label(self) -> str:
        return COMPONENT_SOURCE_LABELS.get(self.source_type, self.source_type or "")

    def __repr__(self) -> str:
        return f"<QingtengComponentAsset id={self.id} {self.source_type}:{self.name!r} host={self.hostname!r}>"

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "qingteng_device_id": self.qingteng_device_id,
            "qingteng_device_name": self.qingteng_device_name or "",
            "batch_id": self.batch_id,
            "source_type_label": self.source_type_label,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in QINGTENG_COMPONENT_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        extra = dict(self.extra or {})
        for key, val in extra.items():
            if key not in data:
                data[key] = val
        return data
