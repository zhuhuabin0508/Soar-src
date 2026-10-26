"""已封禁 IP 记录模型。

存储被封禁的 IP 信息，包括封禁等级、时长、过期时间、地区、违规次数等。
供 IP 风险研判智能体的 query_banned_ip 工具读取；写入方为封禁工作台与
工单流转的封禁同步（ban_sync），以及前端「已封禁 IP」页面展示。
"""
from sqlalchemy import Column, DateTime, Integer, String, Text

from app.core.timezone import beijing_now
from app.database import Base


class BannedIP(Base):
    """已封禁 IP 记录。"""

    __tablename__ = "banned_ips"

    id = Column(Integer, primary_key=True, index=True)
    ip = Column(String(45), unique=True, index=True, nullable=False)
    ban_level = Column(String(20), nullable=False, default="medium")
    ban_duration = Column(Integer, nullable=False, default=3600)
    expired_at = Column(DateTime, nullable=False)
    region = Column(String(50), default="")
    violation_count = Column(Integer, default=0)
    reason = Column(Text, default="")
    status = Column(String(20), default="active")
    # 来源标识：manual=手动添加，agent=智能体添加
    source = Column(String(20), default="agent")
    # 封禁设备信息（手动新增/CSV导入时调用设备 block_ip 动作）
    device_id = Column(Integer, nullable=True, index=True, comment="执行封禁的设备 ID")
    device_name = Column(String(255), default="", comment="冗余设备名（设备删除后仍可展示）")
    action_response = Column(Text, default="", comment="设备 block_ip 动作的原始响应（审计溯源）")
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self):
        return f"<BannedIP ip={self.ip!r} level={self.ban_level!r} status={self.status!r}>"
