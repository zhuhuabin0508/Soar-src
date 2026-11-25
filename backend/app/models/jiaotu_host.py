"""奇安信椒图云锁主机资产：按云锁 API 同步服务器基础信息与硬件概况。

数据来源：云锁接口 ``/api/assetSrv/zcMachineController/listMachineBaseInfos``
（分页）与 ``/api/assetSrv/esZcController/zcForNGSOC``（单主机硬件）。

- ``source_id`` = ``{设备ID}:{machine_uuid}``，多台椒图平台唯一；
- 硬件字段（CPU/内存/厂商/序列号）来自单机资产详情，失败时保留空值；
- ODP/云锁未知字段落 ``extra``，接口升级不丢字段。
"""
from __future__ import annotations

import json

from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 操作系统枚举（云锁 osType）
JIAOTU_OS_LABELS = {0: "Windows", 1: "Linux"}

# 版本类型枚举（云锁 advVersion）
JIAOTU_ADV_LABELS = {0: "基础版", 1: "增强版"}

# 全量字段（导出 / 详情口径），顺序即导出列顺序
JIAOTU_HOST_FIELDS = [
    "machine_uuid",
    "machine_name",
    "intranet_ip",
    "extranet_ip",
    "mac",
    "os_type",
    "os_name",
    "online_status",
    "if_delete",
    "agent_version",
    "adv_version",
    "manufacturer",
    "serial",
    "cpu",
    "memory_size",
]

# 列表页展示字段（子集，顺序即列顺序）
JIAOTU_HOST_LIST_FIELDS = [
    "machine_name",
    "intranet_ip",
    "extranet_ip",
    "os_type",
    "os_name",
    "online_status",
    "agent_version",
    "adv_version",
    "mac",
    "cpu",
    "memory_size",
]

JIAOTU_HOST_FIELD_LABELS = {
    "machine_uuid": "主机 UUID",
    "machine_name": "服务器名",
    "intranet_ip": "内网 IP",
    "extranet_ip": "出网 IP",
    "mac": "MAC 地址",
    "os_type": "系统类型",
    "os_name": "操作系统",
    "online_status": "在线状态",
    "agent_version": "Agent 版本",
    "adv_version": "版本类型",
    "manufacturer": "厂商",
    "serial": "序列号",
    "cpu": "CPU",
    "memory_size": "内存(字节)",
    "if_delete": "卸载状态",
    "jiaotu_device_name": "椒图平台",
}

# upsert 时需要更新的列（不含 source_id / 设备维度 / created_at）
JIAOTU_HOST_UPDATE_COLS = [
    *JIAOTU_HOST_FIELDS,
    "if_delete",
    "jiaotu_device_name",
    "extra",
    "batch_id",
    "updated_at",
]


class JiaotuHostAsset(Base):
    """椒图云锁主机资产（一台服务器一行）。"""

    __tablename__ = "jiaotu_hosts"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_jiaotu_hosts_source"),
        Index("ix_jiaotu_hosts_device", "jiaotu_device_id"),
        Index("ix_jiaotu_hosts_ip", "intranet_ip"),
        Index("ix_jiaotu_hosts_name", "machine_name"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    # 来源椒图设备（devices.id）：多台椒图平台的数据都在这一张表
    jiaotu_device_id = Column(Integer, nullable=False, default=0)
    jiaotu_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    machine_uuid = Column(String(64), nullable=False, default="", index=True)
    machine_name = Column(String(255), nullable=False, default="")
    intranet_ip = Column(String(255), nullable=False, default="")
    extranet_ip = Column(String(255), nullable=False, default="")
    mac = Column(String(64), nullable=False, default="")

    os_type = Column(String(32), nullable=False, default="")
    os_name = Column(Text, nullable=False, default="")
    online_status = Column(Boolean, nullable=True)
    agent_version = Column(String(64), nullable=False, default="")
    adv_version = Column(String(32), nullable=False, default="")
    if_delete = Column(Boolean, nullable=True)

    manufacturer = Column(String(255), nullable=False, default="")
    serial = Column(String(255), nullable=False, default="")
    cpu = Column(String(255), nullable=False, default="")
    memory_size = Column(BigInteger, nullable=True)

    # 云锁未知字段兜底
    extra = Column(JSONB, nullable=False, default=dict)

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return (
            f"<JiaotuHostAsset id={self.id} host={self.machine_name!r} "
            f"device={self.jiaotu_device_id}>"
        )

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "jiaotu_device_id": self.jiaotu_device_id,
            "jiaotu_device_name": self.jiaotu_device_name or "",
            "batch_id": self.batch_id,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in JIAOTU_HOST_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        # 布尔字段转中文展示，便于列表直接阅读
        if self.online_status is not None:
            data["online_status"] = "在线" if self.online_status else "离线"
        if self.if_delete is not None:
            data["if_delete"] = "已卸载" if self.if_delete else "未卸载"
        extra = dict(self.extra or {})
        for key, val in extra.items():
            if key not in data:
                data[key] = val
        return data
