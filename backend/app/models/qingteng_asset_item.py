"""青藤资产明细：主机上的账号、用户组、Web 应用、Web 站点等模块。

与组件表（``qingteng_components``）分开：
- 组件表只放 CVE 匹配需要的软件/包/数据库类数据，保证 name/version 口径干净；
- 本表用 ``module`` 区分模块，公共字段提升为列，模块差异字段放 ``payload``，
  新增模块只需加同步配置，不必每次建表。

本期模块（P2）：account / accountgroup / webapp / website。
"""
from __future__ import annotations

import json

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 模块 → 展示名（顺序即 tab 顺序）
ASSET_MODULE_LABELS = {
    "account": "系统账号",
    "accountgroup": "用户组",
    "webapp": "Web 应用",
    "website": "Web 站点",
}
ASSET_MODULES = tuple(ASSET_MODULE_LABELS)

# 全量字段（导出 / 详情口径）
QINGTENG_ASSET_FIELDS = [
    "module",
    "os_type",
    "agent_id",
    "hostname",
    "display_ip",
    "internal_ip",
    "external_ip",
    "biz_group",
    "name",
    "version",
    "port",
    "path",
    "status",
]

# 列表页展示字段
QINGTENG_ASSET_LIST_FIELDS = [
    "hostname",
    "display_ip",
    "os_type",
    "module_label",
    "name",
    "version",
    "port",
    "path",
    "status",
    "biz_group",
]

QINGTENG_ASSET_FIELD_LABELS = {
    "module": "资产模块",
    "module_label": "资产模块",
    "os_type": "系统类型",
    "agent_id": "Agent ID",
    "hostname": "主机名",
    "display_ip": "展示 IP",
    "internal_ip": "内部 IP",
    "external_ip": "外部 IP",
    "biz_group": "业务组",
    "name": "名称",
    "name_norm": "名称（归一化）",
    "version": "版本",
    "version_norm": "版本（归一化）",
    "port": "端口",
    "path": "路径",
    "status": "状态",
    "payload": "模块字段",
    # 模块差异字段（payload 展平后可直接作为列）
    "uid": "UID",
    "gid": "GID",
    "lastLoginTime": "最后登录",
    "serverName": "服务名",
    "domainName": "域名",
    "rootPath": "根路径",
    "proto": "协议",
    "type": "类型",
}

# upsert 更新列（不含 source_id / 设备维度 / created_at）
QINGTENG_ASSET_UPDATE_COLS = [
    "module",
    "os_type",
    "agent_id",
    "hostname",
    "display_ip",
    "internal_ip",
    "external_ip",
    "biz_group",
    "name",
    "name_norm",
    "version",
    "version_norm",
    "port",
    "path",
    "status",
    "payload",
    "qingteng_device_name",
    "batch_id",
    "updated_at",
]


class QingtengAssetItem(Base):
    """青藤资产明细（一台主机上的一个账号/进程/站点等一行）。"""

    __tablename__ = "qingteng_asset_items"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_qingteng_asset_items_source"),
        Index("ix_qingteng_asset_items_device_module", "qingteng_device_id", "module"),
        Index("ix_qingteng_asset_items_agent", "agent_id"),
        Index("ix_qingteng_asset_items_ip", "display_ip"),
        Index("ix_qingteng_asset_items_port", "port"),
        Index(
            "ix_qingteng_asset_items_name_trgm",
            "name_norm",
            postgresql_using="gin",
            postgresql_ops={"name_norm": "gin_trgm_ops"},
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    qingteng_device_id = Column(Integer, nullable=False, default=0)
    qingteng_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    module = Column(String(32), nullable=False, default="")
    os_type = Column(String(16), nullable=False, default="")
    agent_id = Column(String(64), nullable=False, default="")
    hostname = Column(String(255), nullable=False, default="")
    display_ip = Column(String(255), nullable=False, default="")
    internal_ip = Column(String(255), nullable=False, default="")
    external_ip = Column(String(255), nullable=False, default="")
    biz_group = Column(String(255), nullable=False, default="")

    name = Column(String(512), nullable=False, default="")
    name_norm = Column(String(512), nullable=False, default="")
    version = Column(String(255), nullable=False, default="")
    version_norm = Column(String(255), nullable=False, default="")
    port = Column(Integer, nullable=True)
    path = Column(String(1024), nullable=False, default="")
    status = Column(String(128), nullable=False, default="")

    # 模块差异字段（如 uid/gid、proto、bindIp、serverName、rootPath）
    payload = Column(JSONB, nullable=False, default=dict)

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    @property
    def module_label(self) -> str:
        return ASSET_MODULE_LABELS.get(self.module, self.module or "")

    def __repr__(self) -> str:
        return f"<QingtengAssetItem id={self.id} {self.module}:{self.name!r} host={self.hostname!r}>"

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "qingteng_device_id": self.qingteng_device_id,
            "qingteng_device_name": self.qingteng_device_name or "",
            "batch_id": self.batch_id,
            "module_label": self.module_label,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in QINGTENG_ASSET_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        payload = dict(self.payload or {})
        for key, val in payload.items():
            if key not in data:
                data[key] = val
        return data
