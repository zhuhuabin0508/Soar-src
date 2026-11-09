"""安博通全局白名单本地同步表。

安博通阻断器「全局白名单（GlobalWhitelist）」的本地只读副本：后台线程每 5 秒
从设备全量拉取并原子替换本表，供工作台白名单管理页展示，以及手动封禁时的
白名单匹配（匹配只读内存索引，不访问设备，响应稳定在毫秒级）。

设备始终是唯一权威数据源；平台侧手动增删经设备接口成功后立即回读同步。
"""
from sqlalchemy import BigInteger, Column, DateTime, Integer, String

from app.core.timezone import beijing_now
from app.database import Base


class AnbotongWhitelist(Base):
    """安博通全局白名单条目（设备侧字段的本地快照）。"""

    __tablename__ = "anbotong_whitelist"

    id = Column(Integer, primary_key=True, index=True)
    wlist = Column(
        String(253), unique=True, index=True, nullable=False,
        comment="白名单主机（规范化的 IPv4/IPv6/小写域名）",
    )
    age = Column(Integer, nullable=True, comment="生命周期（秒），-1 表示永久")
    enable = Column(Integer, nullable=True, comment="1 启用 / 0 停用")
    reason = Column(String(255), default="", comment="添加方式/原因")
    effect_time = Column(String(32), default="", comment="设备侧生效时间")
    policy_group_name = Column(String(127), default="", comment="所属策略组")
    left_time = Column(BigInteger, nullable=True, comment="设备侧剩余时间（只读）")
    state = Column(Integer, nullable=True, comment="设备侧是否生效（只读）")
    hit_num = Column(BigInteger, nullable=True, comment="命中次数（只读）")
    node_id = Column(String(64), default="", comment="节点标识（只读）")
    synced_at = Column(
        DateTime, default=beijing_now, index=True, comment="最近一次同步时间",
    )
