"""奇安信椒图云锁资产明细：主机上的安装包、端口、进程、数据库、Web 等模块。

数据来源：``/api/assetSrv/esZcController/zcForNGSOC`` 单主机资产详情。
- 公共字段提升为列（名称/版本/端口/路径等），模块差异字段放 ``payload``；
- ``module`` 区分模块，新增模块只需加同步配置，不必每次建表；
- ``source_id`` 由设备 + 模块 + 主机 + 条目 ID 生成，重复同步原地更新。
"""
from __future__ import annotations

import json

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 模块 → 展示名（顺序即 tab 顺序）
JIAOTU_MODULE_LABELS = {
    "install_package": "安装包",
    "port": "端口",
    "process": "进程",
    "database": "数据库",
    "web_server": "Web 服务",
    "web_frame": "Web 框架",
    "account": "系统账号",
    "network_connection": "网络连接",
    "start_service": "启动服务",
}
JIAOTU_MODULES = tuple(JIAOTU_MODULE_LABELS)

# 全量字段（导出 / 详情口径），顺序即导出列顺序
JIAOTU_ASSET_FIELDS = [
    "module",
    "os_type",
    "machine_uuid",
    "machine_name",
    "intranet_ip",
    "extranet_ip",
    "name",
    "version",
    "port",
    "protocol",
    "path",
    "publisher",
    "start_user",
    "status",
    "install_time",
]

# 列表页展示字段
JIAOTU_ASSET_LIST_FIELDS = [
    "machine_name",
    "intranet_ip",
    "os_type",
    "module_label",
    "name",
    "version",
    "port",
    "protocol",
    "path",
    "publisher",
    "start_user",
    "status",
]

JIAOTU_ASSET_FIELD_LABELS = {
    "module": "资产模块",
    "module_label": "资产模块",
    "os_type": "系统类型",
    "machine_uuid": "主机 UUID",
    "machine_name": "服务器名",
    "intranet_ip": "内网 IP",
    "extranet_ip": "出网 IP",
    "name": "名称",
    "name_norm": "名称（归一化）",
    "version": "版本",
    "version_norm": "版本（归一化）",
    "port": "端口",
    "protocol": "协议",
    "path": "路径",
    "publisher": "厂商/发布者",
    "start_user": "运行用户",
    "status": "状态",
    "install_time": "安装时间",
    "payload": "模块字段",
    # 模块差异字段（payload 展平后可直接作为列）
    "releaseNo": "发布号",
    "installTime": "安装时间",
    "packageSizeStr": "大小",
    "installPackageType": "包类型",
    "source": "来源包",
    "pid": "PID",
    "processName": "进程名",
    "startStatus": "启动状态",
    "lastLoginTime": "最后登录",
    "isAdmin": "管理员",
    "connectStatus": "连接状态",
    "dstIp": "目标 IP",
    "dstPort": "目标端口",
    "bindIp": "绑定 IP",
    "webServerType": "服务类型",
    "webFramePath": "框架路径",
}

# upsert 更新列（不含 source_id / 设备维度 / created_at）
JIAOTU_ASSET_UPDATE_COLS = [
    "module",
    "os_type",
    "machine_uuid",
    "machine_name",
    "intranet_ip",
    "extranet_ip",
    "name",
    "name_norm",
    "version",
    "version_norm",
    "port",
    "protocol",
    "path",
    "publisher",
    "start_user",
    "status",
    "install_time",
    "payload",
    "jiaotu_device_name",
    "batch_id",
    "updated_at",
]


class JiaotuAssetItem(Base):
    """椒图资产明细（一台主机上的一个安装包/端口/进程等一行）。"""

    __tablename__ = "jiaotu_asset_items"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_jiaotu_asset_items_source"),
        Index("ix_jiaotu_asset_items_device_module", "jiaotu_device_id", "module"),
        Index("ix_jiaotu_asset_items_machine", "machine_uuid"),
        Index("ix_jiaotu_asset_items_ip", "intranet_ip"),
        Index("ix_jiaotu_asset_items_port", "port"),
        Index(
            "ix_jiaotu_asset_items_name_trgm",
            "name_norm",
            postgresql_using="gin",
            postgresql_ops={"name_norm": "gin_trgm_ops"},
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    jiaotu_device_id = Column(Integer, nullable=False, default=0)
    jiaotu_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    module = Column(String(32), nullable=False, default="")
    os_type = Column(String(32), nullable=False, default="")
    machine_uuid = Column(String(64), nullable=False, default="")
    machine_name = Column(String(255), nullable=False, default="")
    intranet_ip = Column(String(255), nullable=False, default="")
    extranet_ip = Column(String(255), nullable=False, default="")

    name = Column(String(512), nullable=False, default="")
    name_norm = Column(String(512), nullable=False, default="")
    version = Column(String(255), nullable=False, default="")
    version_norm = Column(String(255), nullable=False, default="")
    port = Column(Integer, nullable=True)
    protocol = Column(String(32), nullable=False, default="")
    path = Column(String(1024), nullable=False, default="")
    publisher = Column(String(255), nullable=False, default="")
    start_user = Column(String(128), nullable=False, default="")
    status = Column(String(128), nullable=False, default="")
    install_time = Column(String(32), nullable=False, default="")

    # 模块差异字段（如 releaseNo / pid / lastLoginTime / dstIp）
    payload = Column(JSONB, nullable=False, default=dict)

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    @property
    def module_label(self) -> str:
        return JIAOTU_MODULE_LABELS.get(self.module, self.module or "")

    def __repr__(self) -> str:
        return (
            f"<JiaotuAssetItem id={self.id} {self.module}:{self.name!r} "
            f"host={self.machine_name!r}>"
        )

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "jiaotu_device_id": self.jiaotu_device_id,
            "jiaotu_device_name": self.jiaotu_device_name or "",
            "batch_id": self.batch_id,
            "module_label": self.module_label,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in JIAOTU_ASSET_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        payload = dict(self.payload or {})
        for key, val in payload.items():
            if key not in data:
                data[key] = val
        return data
