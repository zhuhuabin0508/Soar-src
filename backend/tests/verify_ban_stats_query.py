# 验证 monitor 封禁IP统计的历史去重口径 SQL（sqlite 内存库模拟）
# 场景：1 个 IP 手动封禁 → 解封；另 1 个 IP 工单封禁生效中；1 个 IP 审批拒绝(cancelled)
# 期望：total=2（解封的仍计数、cancelled 不计）、manual=1、ticket=1
import sys
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Boolean, create_engine, func
from sqlalchemy.orm import declarative_base, Session

Base = declarative_base()


class BanRecord(Base):
    __tablename__ = "ban_records"
    id = Column(Integer, primary_key=True)
    ip = Column(String(2048), nullable=False, index=True)
    ban_source = Column(String(16), nullable=False, default="auto")
    ban_level = Column(String(20), nullable=False, default="medium")
    is_permanent = Column(Boolean, nullable=False, default=False)
    expire_time = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False, default="active", index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


engine = create_engine("sqlite://")
Base.metadata.create_all(engine)

with Session(engine) as db:
    db.add_all([
        # IP A：手动封禁后又解封（应仍计数，manual）
        BanRecord(ip="1.1.1.1", ban_source="manual", status="unbanned"),
        # IP B：工单同步封禁，生效中（ticket）
        BanRecord(ip="2.2.2.2", ban_source="ticket", status="active"),
        # IP C：审批拒绝，从未下发（cancelled，不应计数）
        BanRecord(ip="3.3.3.3", ban_source="approval", status="cancelled"),
        # IP D：自动封禁到期（应计数，归入其他来源）
        BanRecord(ip="4.4.4.4", ban_source="auto", status="expired"),
    ])
    db.commit()

    # —— 与 tickets.py 完全一致的查询 ——
    _latest_ban_sq = (
        db.query(BanRecord.ip.label("ip"), func.max(BanRecord.id).label("rid"))
        .filter(BanRecord.status != "cancelled")
        .group_by(BanRecord.ip)
        .subquery()
    )
    counts = dict(
        db.query(BanRecord.ban_source, func.count())
        .join(_latest_ban_sq, BanRecord.id == _latest_ban_sq.c.rid)
        .group_by(BanRecord.ban_source)
        .all()
    )
    ban_stats = {
        "total": sum(counts.values()),
        "manual": counts.get("manual", 0),
        "ticket": counts.get("ticket", 0),
    }
    latest_bans = (
        db.query(BanRecord)
        .join(_latest_ban_sq, BanRecord.id == _latest_ban_sq.c.rid)
        .order_by(BanRecord.id.desc())
        .limit(2000)
        .all()
    )
    rows = [(r.ip, r.ban_source, r.status) for r in latest_bans]

    print("ban_stats =", ban_stats)
    print("drill rows =", rows)

    ok = (
        ban_stats["total"] == 3
        and ban_stats["manual"] == 1
        and ban_stats["ticket"] == 1
        and len(rows) == 3
        and all(r[2] != "cancelled" for r in rows)
        and ("1.1.1.1", "manual", "unbanned") in rows
    )
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
