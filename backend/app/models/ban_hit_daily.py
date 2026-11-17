"""安博通黑名单每日命中增量（大屏重保期间 / 拦截趋势的真实日口径）。"""
from sqlalchemy import BigInteger, Column, Date, DateTime, Integer

from app.core.timezone import beijing_now
from app.database import Base


class BanHitDaily(Base):
    """按自然日累计平台实际观测到的命中增量（每次同步的差值之和）。

    只记录平台观测到的增量，不回填历史：某日无记录视为 0。与 BanHitStat
    的终身累计不同，本表不受「首次观测带入设备历史计数」「重封后终身计数
    归属最近一次 effectTime」影响，用于重保期间与每日趋势。
    """

    __tablename__ = "ban_hit_daily"

    id = Column(Integer, primary_key=True, index=True)
    # 统计日（北京时间自然日）
    stat_date = Column(Date, nullable=False, unique=True, index=True)
    # 当日观测到的命中增量
    hit_delta = Column(BigInteger, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return f"<BanHitDaily {self.stat_date!r} hit_delta={self.hit_delta!r}>"
