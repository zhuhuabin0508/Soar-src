"""奇安信天擎终端资产：按天擎 ODP 接口同步终端基础信息、在线状态与版本。

数据来源：天擎 ODP GraphQL 接口 ``free_clients``（按分组递归拉取）。
每台天擎平台对应资产发现左侧「天擎终端资产发现」下的一张数据表卡片：
- ``source_id`` = ``{device_id}:{client_id}``，多台天擎平台唯一；
- 仅保留首期需要的终端基础信息、在线状态与版本，硬件/资产登记后续扩展；
- ODP 未来新增字段落入 ``extra``，天擎升级不丢字段。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base

# 操作系统枚举（ODP meta.tos.os）
TIANQING_OS_LABELS = {
    0: "未知",
    1: "Windows",
    2: "Linux",
    3: "macOS",
    4: "Android",
    5: "iOS",
    6: "HarmonyOS",
}

# 系统架构枚举（ODP meta.tos.arch）
TIANQING_ARCH_LABELS = {
    0: "未知",
    1: "x86",
    2: "x64",
    3: "ARM",
    4: "AArch64",
    5: "MIPS",
    6: "MIPS64",
}

# 全量字段（导出 / 详情口径），顺序即导出列顺序
TIANQING_ENDPOINT_FIELDS = [
    "client_id",
    "computer_name",
    "ip",
    "report_ip",
    "mac",
    "os_type",
    "os_name",
    "os_version",
    "kernel_version",
    "arch",
    "client_type",
    "group_name",
    "group_path",
    "online_status",
    "last_online_time",
    "activation",
    "login_account",
    "domain",
    "computer_working_group",
    "system_language",
    "main_program_version",
    "virus_version",
]

# 列表页展示字段（子集，顺序即列顺序）
TIANQING_LIST_FIELDS = [
    "computer_name",
    "ip",
    "report_ip",
    "mac",
    "os_type",
    "os_name",
    "os_version",
    "arch",
    "client_type",
    "group_name",
    "online_status",
    "last_online_time",
    "login_account",
    "main_program_version",
    "virus_version",
]

TIANQING_FIELD_LABELS = {
    "client_id": "终端 ID",
    "computer_name": "计算机名",
    "ip": "通信 IP",
    "report_ip": "上报 IP",
    "mac": "MAC 地址",
    "os_type": "操作系统类型",
    "os_name": "操作系统",
    "os_version": "系统版本",
    "kernel_version": "内核版本",
    "arch": "系统架构",
    "client_type": "终端类型",
    "group_name": "终端分组",
    "group_path": "分组路径",
    "online_status": "在线状态",
    "last_online_time": "最后在线时间",
    "activation": "激活状态",
    "login_account": "登录账号",
    "domain": "登录域",
    "computer_working_group": "工作组",
    "system_language": "系统语言",
    "main_program_version": "主程序版本",
    "virus_version": "病毒库版本",
    "tianqing_device_name": "天擎平台",
}

# upsert 时需要更新的列（不含 source_id / 设备维度 / created_at）
TIANQING_UPDATE_COLS = [
    *TIANQING_ENDPOINT_FIELDS,
    "tianqing_device_name",
    "extra",
    "batch_id",
    "updated_at",
]


class TianqingEndpointAsset(Base):
    """天擎终端资产（一台终端一行，来源平台用 tianqing_device_id 区分）。"""

    __tablename__ = "tianqing_endpoints"
    __table_args__ = (
        UniqueConstraint("source_id", name="uq_tianqing_endpoints_source"),
        Index("ix_tianqing_endpoints_device", "tianqing_device_id"),
        Index("ix_tianqing_endpoints_ip", "ip"),
        Index("ix_tianqing_endpoints_name", "computer_name"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(String(160), nullable=False)
    # 来源天擎设备（devices.id）：多台天擎平台的数据都在这一张表
    tianqing_device_id = Column(Integer, nullable=False, default=0)
    tianqing_device_name = Column(String(255), nullable=False, default="")
    batch_id = Column(Integer, ForeignKey("govcloud_import_batches.id"), nullable=True, index=True)

    client_id = Column(String(128), nullable=False, default="", index=True)
    computer_name = Column(String(255), nullable=False, default="")
    ip = Column(String(64), nullable=False, default="")
    report_ip = Column(String(64), nullable=False, default="")
    mac = Column(String(64), nullable=False, default="")

    os_type = Column(String(32), nullable=False, default="")
    os_name = Column(Text, nullable=False, default="")
    os_version = Column(String(255), nullable=False, default="")
    kernel_version = Column(Text, nullable=False, default="")
    arch = Column(String(32), nullable=False, default="")
    client_type = Column(String(64), nullable=False, default="")

    group_name = Column(String(255), nullable=False, default="")
    group_path = Column(String(1024), nullable=False, default="")

    online_status = Column(Boolean, nullable=True)
    last_online_time = Column(String(32), nullable=False, default="")
    activation = Column(Boolean, nullable=True)
    login_account = Column(String(128), nullable=False, default="")
    domain = Column(String(128), nullable=False, default="")
    computer_working_group = Column(String(128), nullable=False, default="")
    system_language = Column(String(32), nullable=False, default="")

    main_program_version = Column(String(64), nullable=False, default="")
    virus_version = Column(String(64), nullable=False, default="")

    # ODP 未知字段兜底（天擎升级新增字段不丢）
    extra = Column(JSONB, nullable=False, default=dict)

    # 内容指纹：增量同步时用于跳过未变化行
    row_hash = Column(String(40), nullable=False, default="")

    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return (
            f"<TianqingEndpointAsset id={self.id} host={self.computer_name!r} "
            f"device={self.tianqing_device_id}>"
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
        for attr in TIANQING_ENDPOINT_FIELDS:
            val = getattr(self, attr, None)
            if isinstance(val, (dict, list)):
                val = str(val)
            data[attr] = "" if val is None else val
        # 布尔字段转中文展示，便于列表/详情/导出直接阅读
        if self.online_status is not None:
            data["online_status"] = "在线" if self.online_status else "离线"
        if self.activation is not None:
            data["activation"] = "已激活" if self.activation else "未激活"
        extra = dict(self.extra or {})
        for key, val in extra.items():
            if key not in data:
                data[key] = val
        return data
