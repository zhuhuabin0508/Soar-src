"""安博通黑名单条目命中累计模型（工单监控大屏「封禁IP统计」历史累计口径）。"""
from sqlalchemy import Column, DateTime, Integer, String

from app.core.timezone import beijing_now
from app.database import Base


class BanHitStat(Base):
    """黑名单条目命中（拦截）累计：按 blist 去重，一个条目一行。

    大屏封禁统计每次刷新时以设备侧实时黑名单合并增量：hit_num 单调递增取
    差值累计；解封后重新封禁（设备计数清零重计）按新一轮全量计入；条目从
    设备消失（解封/到期）不删除本表记录，保证「封禁数量 / 拦截次数」只增不减。
    """

    __tablename__ = "ban_hit_stats"

    id = Column(Integer, primary_key=True, index=True)
    # 黑名单条目（IP / 域名，与设备 blist 字段同口径）
    blist = Column(String(253), nullable=False, unique=True, index=True)
    # 累计命中（拦截）次数：历轮设备 hit_num 之和，只增不减
    hit_total = Column(Integer, nullable=False, default=0)
    # 最近一次设备侧 hit_num（下次同步据此计算增量）
    last_hit = Column(Integer, nullable=False, default=0)
    # 最近一次生效时间（重保区间与拦截趋势按日落桶依据）
    effect_time = Column(DateTime, nullable=True, index=True)
    first_seen_at = Column(DateTime, nullable=False, default=beijing_now)
    last_seen_at = Column(DateTime, nullable=False, default=beijing_now)

    def __repr__(self) -> str:
        return f"<BanHitStat {self.blist!r} hit_total={self.hit_total!r}>"
