"""青藤主机资产：按青藤平台（设备管理 auth_type=qingteng）拉取主机清单。

- 每台青藤平台对应资产发现左侧「青藤主机资产发现」下的一张数据表卡片；
- source_id = "{device_id}:{agentId}"，跨多台青藤平台唯一；
- API 未来新增的未知字段落入 extra，青藤升级后不丢字段。

字段口径：GET /external/api/assets/host/{linux|win} 返回 rows（见
scripts/qingteng_api_manual.txt「主机信息查询结果」），linux/win 同构。
"""
from __future__ import annotations

import json

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# Agent 状态：0-在线 1-离线 2-停用
AGENT_STATUS_LABELS = {0: "在线", 1: "离线", 2: "停用"}

# 拉取的操作系统口径（青藤接口按 OS 分开查询）
OS_TYPES = ("linux", "win")

# 全量字段（导出 / 详情口径），顺序即导出列顺序
QINGTENG_HOST_FIELDS = [
    "agent_id",
    "hostname",
    "os_type",
    "display_ip",
    "connection_ip",
    "external_ip",
    "internal_ip",
    "proxy_ip",
    "platform",
    "kernel_version",
    "agent_status_label",
    "agent_version",
    "last_online_time",
    "offline_days",
    "biz_group",
    "host_tag_list",
    "charge_name",
    "host_location",
    "remark",
    "cpu_core",
    "cpu_brand",
    "memory_size",
    "memory_usage",
    "disk_size",
    "disk_usage",
    "disk_count",
    "manufacturer",
    "product_name",
    "serial_number",
    "network_cards",
]

# 列表页展示字段（子集，顺序即列顺序）
QINGTENG_LIST_FIELDS = [
    "hostname",
    "display_ip",
    "os_type",
    "platform",
    "agent_status_label",
    "biz_group",
    "cpu_core",
    "memory_size",
    "disk_size",
    "serial_number",
    "last_online_time",
]

QINGTENG_FIELD_LABELS = {
    "agent_id": "Agent ID",
    "hostname": "主机名",
    "os_type": "系统类型",
    "display_ip": "展示 IP",
    "connection_ip": "连接 IP",
    "external_ip": "外部 IP",
    "internal_ip": "内部 IP",
    "proxy_ip": "代理 IP",
    "platform": "操作系统",
    "kernel_version": "内核版本",
    "agent_status_label": "Agent 状态",
    "agent_version": "Agent 版本",
    "last_online_time": "最后在线时间",
    "offline_days": "离线天数",
    "biz_group": "业务组",
    "host_tag_list": "主机标签",
    "charge_name": "负责人",
    "host_location": "主机位置",
    "remark": "备注",
    "cpu_core": "CPU 核数",
    "cpu_brand": "CPU 型号",
    "memory_size": "内存(MB)",
    "memory_usage": "内存使用率",
    "disk_size": "磁盘(MB)",
    "disk_usage": "磁盘使用率",
    "disk_count": "磁盘数",
    "manufacturer": "厂商",
    "product_name": "产品型号",
    "serial_number": "序列号",
    "network_cards": "网卡",
}

# upsert 时需要更新的列（不含 source_id / 设备维度 / created_at）
QINGTENG_UPDATE_COLS = [
    *QINGTENG_HOST_FIELDS,
    "agent_status",
    "online_status",
    "biz_group_id",
    "qingteng_device_name",
    "extra",
    "batch_id",
    "updated_at",
]


class QingtengHostAsset(Base):
    """青藤主机资产（一台主机一行，来源平台用 qingteng_device_id 区分）。"""

    __tablename__ = "qingteng_hosts"
    __table_args__ = (UniqueConstraint("source_id", name="uq_qingteng_hosts_source"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    # 来源青藤设备（devices.id）：多青藤平台的数据都在这一张表
    qingteng_device_id = Column(Integer, nullable=False, default=0, index=True)
    qingteng_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    # 主机识别
    agent_id = Column(String(64), nullable=False, default="")
    hostname = Column(String(255), nullable=False, default="")
    os_type = Column(String(16), nullable=False, default="")
    display_ip = Column(String(255), nullable=False, default="")
    connection_ip = Column(String(255), nullable=False, default="")
    external_ip = Column(String(255), nullable=False, default="")
    internal_ip = Column(String(255), nullable=False, default="")
    proxy_ip = Column(String(255), nullable=False, default="")

    # 系统与 Agent 状态
    platform = Column(Text, nullable=False, default="")
    kernel_version = Column(Text, nullable=False, default="")
    agent_status = Column(Integer, nullable=True)
    agent_status_label = Column(String(16), nullable=False, default="")
    online_status = Column(Integer, nullable=True)
    last_online_time = Column(String(32), nullable=False, default="")
    offline_days = Column(Integer, nullable=True)
    agent_version = Column(String(255), nullable=False, default="")

    # 业务归属
    biz_group_id = Column(Integer, nullable=True)
    biz_group = Column(String(255), nullable=False, default="")
    host_tag_list = Column(JSONB, nullable=False, default=list)
    remark = Column(Text, nullable=False, default="")
    charge_name = Column(String(128), nullable=False, default="")
    host_location = Column(String(128), nullable=False, default="")

    # 硬件
    cpu_core = Column(Integer, nullable=True)
    cpu_brand = Column(Text, nullable=False, default="")
    memory_size = Column(Integer, nullable=True)
    memory_usage = Column(Integer, nullable=True)
    disk_size = Column(Integer, nullable=True)
    disk_usage = Column(Integer, nullable=True)
    disk_count = Column(Integer, nullable=True)
    manufacturer = Column(String(255), nullable=False, default="")
    product_name = Column(String(255), nullable=False, default="")
    serial_number = Column(String(255), nullable=False, default="")
    network_cards = Column(JSONB, nullable=False, default=list)

    # API 未知字段兜底（青藤升级新增字段不丢）
    extra = Column(JSONB, nullable=False, default=dict)

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self):
        return f"<QingtengHostAsset id={self.id} host={self.hostname!r} device={self.qingteng_device_id}>"

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "source_id": self.source_id,
            "qingteng_device_id": self.qingteng_device_id,
            "qingteng_device_name": self.qingteng_device_name or "",
            "batch_id": self.batch_id,
            "created_at": to_beijing_iso(self.created_at),
            "updated_at": to_beijing_iso(self.updated_at),
        }
        for attr in QINGTENG_HOST_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            data[attr] = "" if val is None else val
        extra = dict(self.extra or {})
        for key, val in extra.items():
            if key not in data:
                data[key] = val
        return data
