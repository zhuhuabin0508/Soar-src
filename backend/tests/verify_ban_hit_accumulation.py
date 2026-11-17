# 验证大屏「封禁IP统计」命中累计口径（sqlite 内存库模拟 _sync_ban_hit_stats 逻辑）
# 场景：
#   1) 首次同步：条目入库，hit_total 从 0 开始（设备 hit_num 仅作基线，不整包计入）
#   2) 命中增长：hit_num 单调递增，差值计入累计
#   3) 解封消失：条目从设备移除后不删除、累计保留（total / total_hit 不回退）
#   4) 解封后重封：设备 hit_num 清零重计，新一轮全量计入累计
#   5) 幂等：同一批条目重复同步不产生增量
#   6) 重保区间：条目数按 effect_time，命中次数按日增量（ban_hit_daily 口径）
#   7) 日增量：首次观测的设备基线不计入，只累计平台观测到的增量
import sys
from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, Session

from app.models.ban_hit_stat import BanHitStat

Base = declarative_base()

engine = create_engine("sqlite://")
BanHitStat.__table__.create(bind=engine)  # 仅本表即可（线上由 create_all 统一注册）

FAILURES = []


def check(name, actual, expected):
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {name}: actual={actual!r} expected={expected!r}")
    if not ok:
        FAILURES.append(name)


_sync_calls = 0
daily = {}  # 与 ban_hit_daily 同口径：按自然日累计平台观测到的增量


def sync(db, items):
    """与 tickets.py::_sync_ban_hit_stats 完全一致的合并逻辑（now 每次递增以便
    校验 last_seen_at 是否被无谓更新）。"""
    if not items:
        return
    global _sync_calls
    _sync_calls += 1
    rows = {r.blist: r for r in db.query(BanHitStat).all()}
    now = datetime(2026, 11, 9, 12, 0, 0) + timedelta(seconds=_sync_calls)
    observed_delta = 0
    for it in items:
        blist = str(it.get("blist") or "").strip()
        if not blist:
            continue
        hit = int(it.get("hit_num") or 0)
        eff_raw = it.get("effectTime")
        eff = datetime.fromisoformat(str(eff_raw)) if eff_raw else None
        row = rows.get(blist)
        if row is None:
            # 首次观测只记基线，累计从 0 开始（设备 hit_num 可能含封禁前历史值）
            row = BanHitStat(blist=blist, hit_total=0, last_hit=hit,
                             effect_time=eff, first_seen_at=now, last_seen_at=now)
            db.add(row)
            rows[blist] = row
        elif hit >= row.last_hit:
            delta = hit - row.last_hit
            # 仅在命中 / 生效时间真正变化时才更新 last_seen_at（避免全表 UPDATE 写放大）
            changed = delta > 0 or (eff is not None and eff != row.effect_time)
            if delta > 0:
                row.hit_total = (row.hit_total or 0) + delta
                observed_delta += delta
            row.last_hit = hit
            if eff is not None:
                row.effect_time = eff
            if changed:
                row.last_seen_at = now
        elif eff is not None and row.effect_time is not None and eff > row.effect_time:
            # 真实重封：effectTime 前进且设备计数清零，按新一轮全量计入
            row.hit_total = (row.hit_total or 0) + hit
            observed_delta += hit
            row.last_hit = hit
            row.effect_time = eff
            row.last_seen_at = now
        # else：计数回落且 effectTime 未前进 —— 乱序快照 / 设备抖动，跳过
    if observed_delta:
        day = now.date()
        daily[day] = daily.get(day, 0) + observed_delta
    db.commit()


def stats(db, ps=None, pe=None):
    """与 ban-live 端点一致的口径：条目数按 effect_time，期间命中按日增量。"""
    total = db.query(BanHitStat).count()
    total_hit = sum(r.hit_total or 0 for r in db.query(BanHitStat).all())
    if ps and pe:
        rows = [r for r in db.query(BanHitStat).all()
                if r.effect_time is not None and ps <= r.effect_time <= pe]
        period_hit = sum(v for d, v in daily.items() if ps.date() <= d <= pe.date())
        return total, total_hit, len(rows), period_hit
    return total, total_hit, None, None


with Session(engine) as db:
    # 1) 首次同步：设备绝对值只作基线，不计入累计（含一个 12 亿级历史计数）
    sync(db, [
        {"blist": "1.1.1.1", "hit_num": "10", "effectTime": "2026-11-05 10:00:00"},
        {"blist": "2.2.2.2", "hit_num": "5", "effectTime": "2026-11-07 18:30:00"},
        {"blist": "3.3.3.3", "hit_num": "1236463492", "effectTime": "2026-11-06 08:00:00"},
        {"blist": "bad.example.com", "hit_num": "", "effectTime": None},  # 非法 hit_num / effectTime
    ])
    t, th, _, _ = stats(db)
    check("首次同步 total", t, 4)
    check("首次同步 total_hit（设备基线不计入）", th, 0)
    check("首次同步日增量（设备基线不计入）", sum(daily.values()), 0)

    # 2) 命中增长（1.1.1.1: 10→25 差 15；3.3.3.3: +8；2.2.2.2 不变）
    sync(db, [
        {"blist": "1.1.1.1", "hit_num": "25", "effectTime": "2026-11-05 10:00:00"},
        {"blist": "2.2.2.2", "hit_num": "5", "effectTime": "2026-11-07 18:30:00"},
        {"blist": "3.3.3.3", "hit_num": "1236463500", "effectTime": "2026-11-06 08:00:00"},
    ])
    _, th, _, _ = stats(db)
    check("命中增长后 total_hit", th, 23)

    # 3) 解封消失：2.2.2.2 从设备移除，仅剩 1.1.1.1（命中再涨 5）
    sync(db, [{"blist": "1.1.1.1", "hit_num": "30", "effectTime": "2026-11-05 10:00:00"}])
    t, th, _, _ = stats(db)
    check("解封后条目仍计数 total", t, 4)
    check("解封后拦截不回退 total_hit", th, 28)

    # 4) 解封后重封：2.2.2.2 重新上设备，hit_num 清零后涨到 3 → 全量计入
    sync(db, [
        {"blist": "1.1.1.1", "hit_num": "30", "effectTime": "2026-11-05 10:00:00"},
        {"blist": "2.2.2.2", "hit_num": "3", "effectTime": "2026-11-08 09:00:00"},
    ])
    t, th, _, _ = stats(db)
    check("重封后 total 不重复计数", t, 4)
    check("重封新一轮命中计入累计", th, 31)

    # 4b) 乱序旧快照（计数回落且 effectTime 未前进）：跳过，不改写累计
    sync(db, [
        {"blist": "2.2.2.2", "hit_num": "1", "effectTime": "2026-11-08 09:00:00"},
    ])
    _, th, _, _ = stats(db)
    check("乱序快照不重计 total_hit", th, 31)
    r2 = db.query(BanHitStat).filter_by(blist="2.2.2.2").one()
    check("乱序快照不下调 last_hit", r2.last_hit, 3)

    # 5) 幂等：同批重复同步
    sync(db, [
        {"blist": "1.1.1.1", "hit_num": "30", "effectTime": "2026-11-05 10:00:00"},
        {"blist": "2.2.2.2", "hit_num": "3", "effectTime": "2026-11-08 09:00:00"},
    ])
    _, th, _, _ = stats(db)
    check("重复同步幂等", th, 31)

    # 5b) 写放大回归：无变化的行不应更新 last_seen_at。1.1.1.1 最后一次变化在
    #     第 3 次同步（25→30，12:00:03），第 4/4b/5 次（30→30 无变化）不更新；
    #     2.2.2.2 重封计入发生在第 4 次同步（12:00:04），第 5 次不更新
    r1 = db.query(BanHitStat).filter_by(blist="1.1.1.1").one()
    check("无变化行不更新 last_seen_at（1.1.1.1）",
          r1.last_seen_at, datetime(2026, 11, 9, 12, 0, 3))
    check("无变化行不更新 last_seen_at（2.2.2.2）",
          r2.last_seen_at, datetime(2026, 11, 9, 12, 0, 4))

    # 6) 重保区间（2026-11-07 00:00 ~ 2026-11-09 00:00）：
    #    条目数按 effect_time：仅 2.2.2.2（重封后 effect 11-08）；
    #    命中次数按日增量：全部同步都发生在 11-09，累计 31
    ps, pe = datetime(2026, 11, 7), datetime(2026, 11, 9)
    _, _, pc, ph = stats(db, ps, pe)
    check("重保期间条目数（重封后按最近 effectTime）", pc, 1)
    check("重保期间拦截次数（按观测日增量）", ph, 31)
    check("日增量累计 = 观测增量总和", sum(daily.values()), 31)

print()
if FAILURES:
    print(f"结果: {len(FAILURES)} 项失败 -> {FAILURES}")
    sys.exit(1)
print("结果: 全部通过")
