"""解析入库监控 API。

- ``GET /monitor/overview``：概览卡片（今日接收/成功/失败/部分/成功率/平均耗时，含昨日对比与近24小时迷你趋势）。
- ``GET /monitor/strategy-stats``：策略维度统计表（含"无匹配策略"汇总行）。
- ``GET /monitor/trend``：入库量 / 成功率趋势（24小时 / 7天，可按策略筛选）。
- ``GET /monitor/risk-distribution``：今日风险等级分布（环形图数据）。
- ``GET /monitor/top-threats``：今日告警类型 TOP10（threat_class+threat_type 聚合）。
- ``GET /monitor/logs``：服务日志（内存环形缓冲，支持 after_id 增量拉取）。
- ``GET /monitor/health``：服务健康（解析服务/数据库连接/积压）。
- ``POST /monitor/errors/{id}/retry`` / ``POST /monitor/errors/retry-batch`` / ``DELETE /monitor/errors/{id}``：错误队列重试与删除。
"""
import json
import logging
import threading
from collections import deque
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, text as sa_text
from sqlalchemy.orm import Session

from app.api.v1.ingest import ParseEngine, SQLAlchemySink, get_strategy_loader
from app.core.timezone import BEIJING_TZ, beijing_now
from app.database import engine as db_engine, get_db
from app.dependencies import require_permission
from app.models.alert_event import AlertEvent
from app.models.ingestion_metric import IngestionMetric
from app.models.parse_error import ParseErrorQueue
from app.models.parse_strategy import ParseStrategy

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monitor", tags=["monitor"])

# 服务启动时间（健康卡片展示）
_STARTED_AT = beijing_now()


# ======================================================================
# 服务日志：内存环形缓冲（进程级，重启清空）
# ======================================================================
class _RingBufferHandler(logging.Handler):
    """把进程内全部日志记录收进定长环形缓冲，供 /monitor/logs 查询。"""

    def __init__(self, capacity: int = 2000) -> None:
        super().__init__(level=logging.INFO)
        self._buf: deque[dict] = deque(maxlen=capacity)
        self._seq = 0
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = record.getMessage() if hasattr(record, "msg") else "<unreadable>"
        with self._lock:
            self._seq += 1
            self._buf.append({
                "id": self._seq,
                "ts": datetime.fromtimestamp(record.created, tz=BEIJING_TZ)
                .strftime("%Y-%m-%d %H:%M:%S"),
                "level": record.levelname,
                "module": record.name,
                "message": msg,
            })

    def snapshot(self, *, level: str = "", keyword: str = "", after_id: int = 0, limit: int = 200) -> list[dict]:
        with self._lock:
            items = list(self._buf)
        out = []
        for it in items:
            if it["id"] <= after_id:
                continue
            if level and it["level"] != level:
                continue
            if keyword and keyword.lower() not in (
                it["message"].lower() + it["module"].lower()
            ):
                continue
            out.append(it)
        return out[-limit:]


_log_handler: Optional[_RingBufferHandler] = None


def _get_log_handler() -> _RingBufferHandler:
    """惰性挂载环形缓冲到根日志器（幂等）。"""
    global _log_handler
    if _log_handler is None:
        handler = _RingBufferHandler()
        logging.getLogger().addHandler(handler)
        # uvicorn access 日志也纳入（默认不向 root 传播的场合强制挂上）
        logging.getLogger("uvicorn.access").addHandler(handler)
        _log_handler = handler
    return _log_handler


# 模块加载即挂载：捕获启动以来的服务日志（而非首次查询之后）
_get_log_handler()


# ======================================================================
# 聚合辅助
# ======================================================================
def _hour_range(hours: int) -> list[str]:
    """最近 N 个整点小时标签（含当前小时），升序。"""
    now = beijing_now().replace(minute=0, second=0, microsecond=0)
    return [(now - timedelta(hours=i)).strftime("%Y-%m-%dT%H") for i in range(hours - 1, -1, -1)]


def _day_range(days: int) -> list[str]:
    """最近 N 天日期标签（含今天），升序。"""
    now = beijing_now()
    return [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days - 1, -1, -1)]


def _sum_metrics(rows: list[IngestionMetric]) -> dict[str, int]:
    """把指标行累加为汇总 dict。"""
    agg = {"total": 0, "success": 0, "partial": 0, "fail": 0, "parse_ms": 0}
    for m in rows:
        agg["total"] += m.total_count or 0
        agg["success"] += m.success_count or 0
        agg["partial"] += m.partial_count or 0
        agg["fail"] += m.fail_count or 0
        agg["parse_ms"] += m.total_parse_ms or 0
    return agg


def _metrics_in_range(db: Session, hour_prefixes: list[str], strategy_id: Optional[int] = None) -> list[IngestionMetric]:
    """查询 stat_hour 前缀命中任一标签的指标行。"""
    query = db.query(IngestionMetric).filter(
        func.substr(IngestionMetric.stat_hour, 1, 13).in_(hour_prefixes)
    )
    if strategy_id is not None:
        query = query.filter(IngestionMetric.strategy_id == strategy_id)
    return query.all()


def _no_match_count_today(db: Session) -> int:
    """今日无匹配策略告警数（错误队列 no_strategy_matched）。"""
    today_start = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.query(func.count(ParseErrorQueue.id)).filter(
        ParseErrorQueue.error_type == "no_strategy_matched",
        ParseErrorQueue.created_at >= today_start,
    ).scalar() or 0


# ======================================================================
# 概览卡片
# ======================================================================
def compute_monitor_overview(db: Session) -> dict:
    """6 张概览卡片数据（供 API 与 Redis 快照刷新共用）。"""
    today_hours = _hour_range(24)
    yesterday_hours = _hour_range(48)[:24]

    today = _sum_metrics(_metrics_in_range(db, today_hours))
    yesterday = _sum_metrics(_metrics_in_range(db, yesterday_hours))

    hour_rows = _metrics_in_range(db, today_hours)
    by_hour: dict[str, int] = {}
    for m in hour_rows:
        key = (m.stat_hour or "")[:13]
        by_hour[key] = by_hour.get(key, 0) + (m.total_count or 0)
    trend = [{"hour": h, "total": by_hour.get(h, 0)} for h in today_hours]

    def rate(agg: dict) -> Optional[float]:
        if not agg["total"]:
            return None
        return round((agg["success"] + agg["partial"]) * 100.0 / agg["total"], 1)

    def avg_ms(agg: dict) -> Optional[int]:
        if not agg["total"]:
            return None
        return round(agg["parse_ms"] / agg["total"])

    return {
        "today": {
            "total": today["total"],
            "success": today["success"],
            "fail": today["fail"],
            "partial": today["partial"],
            "success_rate": rate(today),
            "avg_parse_ms": avg_ms(today),
        },
        "yesterday": {
            "total": yesterday["total"],
            "success": yesterday["success"],
            "fail": yesterday["fail"],
            "partial": yesterday["partial"],
            "success_rate": rate(yesterday),
            "avg_parse_ms": avg_ms(yesterday),
        },
        "trend_24h": trend,
        "no_match_today": _no_match_count_today(db),
    }


@router.get("/overview", dependencies=[Depends(require_permission("monitor", "view"))])
def monitor_overview(db: Session = Depends(get_db)) -> dict:
    """6 张概览卡片：今日接收/成功/失败/部分/成功率/平均耗时 + 昨日对比 + 近24小时趋势。"""
    from app.core.dashboard_cache import CacheKeys, resolve_cached_payload

    return resolve_cached_payload(
        CacheKeys.MONITOR_OVERVIEW,
        db,
        compute_monitor_overview,
    )


# ======================================================================
# 策略维度统计
# ======================================================================
@router.get("/strategy-stats", dependencies=[Depends(require_permission("monitor", "view"))])
def strategy_stats(db: Session = Depends(get_db)) -> dict:
    """每行一个策略的今日统计；末尾附"无匹配策略"汇总行。"""
    today_hours = _hour_range(24)
    rows = _metrics_in_range(db, today_hours)

    by_strategy: dict[int, dict] = {}
    for m in rows:
        if m.strategy_id is None:
            continue
        agg = by_strategy.setdefault(m.strategy_id, {"total": 0, "success": 0, "partial": 0, "fail": 0, "parse_ms": 0})
        agg["total"] += m.total_count or 0
        agg["success"] += m.success_count or 0
        agg["partial"] += m.partial_count or 0
        agg["fail"] += m.fail_count or 0
        agg["parse_ms"] += m.total_parse_ms or 0

    strategies = db.query(ParseStrategy).order_by(ParseStrategy.id).all()
    strategy_meta = {s.id: s for s in strategies}

    items = []
    for sid in sorted(set(list(by_strategy.keys()) + list(strategy_meta.keys()))):
        agg = by_strategy.get(sid, {"total": 0, "success": 0, "partial": 0, "fail": 0, "parse_ms": 0})
        s = strategy_meta.get(sid)
        items.append({
            "strategy_id": sid,
            "strategy_name": s.strategy_name if s else f"策略 #{sid}",
            "device_type": s.device_type if s else "",
            "enabled": bool(s and s.status == "enabled"),
            "today_total": agg["total"],
            "success": agg["success"],
            "partial": agg["partial"],
            "fail": agg["fail"],
            "success_rate": round((agg["success"] + agg["partial"]) * 100.0 / agg["total"], 1) if agg["total"] else None,
            "avg_parse_ms": round(agg["parse_ms"] / agg["total"]) if agg["total"] else None,
            "no_match": None,  # 无匹配不归属具体策略
        })

    no_match = _no_match_count_today(db)
    items.append({
        "strategy_id": None,
        "strategy_name": "无匹配策略",
        "device_type": "",
        "enabled": None,
        "today_total": no_match,
        "success": 0,
        "partial": 0,
        "fail": no_match,
        "success_rate": None,
        "avg_parse_ms": None,
        "no_match": no_match,
    })
    return {"items": items}


# ======================================================================
# 趋势 / 分布
# ======================================================================
@router.get("/trend", dependencies=[Depends(require_permission("monitor", "view"))])
def monitor_trend(
    window: str = Query("24h", description="24h / 7d"),
    strategy_id: int = Query(0, description="按策略筛选，0 表示全部"),
    db: Session = Depends(get_db),
) -> dict:
    """入库量趋势（成功/部分/失败逐桶计数）与成功率数据源。"""
    if window == "7d":
        labels = _day_range(7)
    else:
        labels = _hour_range(24)

    prefix_len = 13 if window != "7d" else 10
    query = db.query(IngestionMetric)
    if strategy_id:
        query = query.filter(IngestionMetric.strategy_id == strategy_id)
    rows = query.all()

    buckets: dict[str, dict] = {label: {"success": 0, "partial": 0, "fail": 0} for label in labels}
    for m in rows:
        key = (m.stat_hour or "")[:prefix_len]
        if key in buckets:
            buckets[key]["success"] += m.success_count or 0
            buckets[key]["partial"] += m.partial_count or 0
            buckets[key]["fail"] += m.fail_count or 0

    series = []
    for label in labels:
        b = buckets[label]
        total = b["success"] + b["partial"] + b["fail"]
        series.append({
            "label": label,
            "success": b["success"],
            "partial": b["partial"],
            "fail": b["fail"],
            "total": total,
            "success_rate": round((b["success"] + b["partial"]) * 100.0 / total, 1) if total else None,
        })
    return {"window": window, "series": series}


@router.get("/risk-distribution", dependencies=[Depends(require_permission("monitor", "view"))])
def risk_distribution(db: Session = Depends(get_db)) -> dict:
    """今日风险等级分布（环形图）。"""
    today_start = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = (
        db.query(AlertEvent.risk_level, AlertEvent.risk_level_name, func.count(AlertEvent.id))
        .filter(AlertEvent.occur_timestamp >= today_start)
        .group_by(AlertEvent.risk_level, AlertEvent.risk_level_name)
        .all()
    )
    items = [
        {"risk_level": r[0], "name": r[1] or "未知", "count": r[2]}
        for r in sorted(rows, key=lambda x: (x[0] if x[0] is not None and x[0] >= 0 else 99))
    ]
    return {"items": items}


@router.get("/top-threats", dependencies=[Depends(require_permission("monitor", "view"))])
def top_threats(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
) -> dict:
    """今日告警类型 TOP N（threat_class + threat_type 聚合，横向条形图）。"""
    today_start = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = (
        db.query(
            AlertEvent.threat_class,
            AlertEvent.threat_type,
            func.count(AlertEvent.id),
        )
        .filter(AlertEvent.occur_timestamp >= today_start)
        .group_by(AlertEvent.threat_class, AlertEvent.threat_type)
        .order_by(func.count(AlertEvent.id).desc())
        .limit(limit)
        .all()
    )
    items = [
        {
            "name": f"{r[0] or '未分类'} / {r[1] or '未分类'}",
            "threat_class": r[0] or "",
            "threat_type": r[1] or "",
            "count": r[2],
        }
        for r in rows
    ]
    return {"items": items}


# ======================================================================
# 服务日志
# ======================================================================
@router.get("/logs", dependencies=[Depends(require_permission("monitor", "view"))])
def monitor_logs(
    level: str = Query("", description="级别过滤：ERROR/WARNING/INFO/DEBUG"),
    keyword: str = Query("", description="内容关键词"),
    after_id: int = Query(0, ge=0, description="增量拉取：只返回 id 大于该值的日志"),
    limit: int = Query(200, ge=1, le=1000),
) -> dict:
    """服务日志：内存环形缓冲，支持 5 秒增量拉取。"""
    handler = _get_log_handler()
    items = handler.snapshot(level=level.upper(), keyword=keyword.strip(), after_id=after_id, limit=limit)
    return {"items": items, "latest_id": items[-1]["id"] if items else after_id}


# ======================================================================
# 服务健康
# ======================================================================
@router.get("/health", dependencies=[Depends(require_permission("monitor", "view"))])
def monitor_health(db: Session = Depends(get_db)) -> dict:
    """服务健康：解析服务状态 / 数据库连接与连接数 / 待处理积压。"""
    db_ok = True
    db_error = ""
    connections = 0
    try:
        with db_engine.connect() as conn:
            connections = conn.execute(
                sa_text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()")
            ).scalar() or 0
    except Exception as exc:  # noqa: BLE001
        db_ok = False
        db_error = str(exc)[:200]

    backlog = db.query(func.count(ParseErrorQueue.id)).filter(
        ParseErrorQueue.status == "pending"
    ).scalar() or 0

    return {
        "service": {
            "status": "running",
            "started_at": _STARTED_AT,
            "uptime_seconds": int((beijing_now() - _STARTED_AT).total_seconds()),
        },
        "database": {
            "status": "connected" if db_ok else "error",
            "connections": connections,
            "error": db_error,
        },
        "backlog": backlog,
    }


# ======================================================================
# 错误队列：重试 / 批量重试 / 删除
# ======================================================================
class RetryBatchBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, description="待重试的错误记录 ID 列表")


# 错误类型 → 中文标签
ERROR_TYPE_LABELS = {
    "json_parse_failed": "JSON解析失败",
    "no_strategy_matched": "无匹配策略",
    "field_validation_failed": "字段校验失败",
    "db_write_failed": "数据库写入失败",
    "unknown_log_type": "未知日志类型",
}


@router.get("/errors", dependencies=[Depends(require_permission("monitor", "view"))])
def list_monitor_errors(
    error_type: str = Query("", description="错误类型过滤"),
    keyword: str = Query("", description="失败原因/uuid 关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """监控页错误队列列表（含原始数据摘要与策略名）。"""
    query = db.query(ParseErrorQueue)
    if error_type:
        query = query.filter(ParseErrorQueue.error_type == error_type)
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            or_(ParseErrorQueue.error_msg.ilike(like), ParseErrorQueue.uuid.ilike(like))
        )
    total = query.count()
    rows = (
        query.order_by(ParseErrorQueue.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    strategy_names = {
        s.id: s.strategy_name
        for s in db.query(ParseStrategy.id, ParseStrategy.strategy_name).all()
    }
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "uuid": r.uuid,
                "strategy_id": r.strategy_id,
                "strategy_name": strategy_names.get(r.strategy_id) if r.strategy_id else None,
                "error_type": r.error_type,
                "error_type_label": ERROR_TYPE_LABELS.get(r.error_type, r.error_type),
                "error_msg": r.error_msg,
                "retry_count": r.retry_count,
                "status": r.status,
                "created_at": r.created_at,
                "raw_summary": (r.raw_data or "")[:120],
            }
            for r in rows
        ],
    }


@router.get("/errors/{error_id}/raw", dependencies=[Depends(require_permission("monitor", "view"))])
def get_error_raw(error_id: int, db: Session = Depends(get_db)) -> dict:
    """错误记录原始数据全文（查看 JSON 弹窗用）。"""
    err = db.query(ParseErrorQueue).filter(ParseErrorQueue.id == error_id).first()
    if err is None:
        raise HTTPException(status_code=404, detail="错误记录不存在")
    return {"id": err.id, "uuid": err.uuid, "raw_data": err.raw_data, "error_msg": err.error_msg}


class _RetrySink(SQLAlchemySink):
    """重试专用 sink：失败时不再写入错误队列（避免重试产生重复记录）。"""

    def save_error(self, raw_data: str, error_type: str, error_msg: str,
                   uuid: Optional[str] = None, strategy_id: Optional[int] = None) -> None:
        """重试失败由 _retry_one 更新原记录，跳过写入。"""
        return None


def _retry_one(db: Session, err: ParseErrorQueue) -> dict:
    """单条重试：走引擎重跑；成功后移出队列。超 3 次转人工。"""
    err.retry_count = (err.retry_count or 0) + 1
    try:
        raw = json.loads(err.raw_data)
    except (ValueError, TypeError):
        raw = err.raw_data

    loader = get_strategy_loader()
    if not loader.strategies:
        loader.refresh()
    engine = ParseEngine(loader=loader, sink=_RetrySink(db))
    stats = engine.process([raw])

    item = stats["results"][0] if stats.get("results") else {}
    outcome = item.get("status") or "fail"
    inserted_or_dup = outcome in ("success", "partial") or stats.get("duplicates", 0) > 0
    if inserted_or_dup:
        # 成功（或 uuid 重复幂等跳过）→ 移出队列
        db.delete(err)
        db.commit()
        return {"id": err.id, "ok": True, "status": outcome, "removed": True}

    # 仍失败：保留队列；超过 3 次标记需人工处理
    if err.retry_count >= 3:
        err.status = "manual"
    err.error_msg = str(item.get("error_msg") or err.error_msg)[:2000]
    db.commit()
    return {
        "id": err.id, "ok": False, "status": outcome, "removed": False,
        "retry_count": err.retry_count, "need_manual": err.status == "manual",
        "error": item.get("error_msg") or "",
    }


@router.post("/errors/{error_id}/retry", dependencies=[Depends(require_permission("monitor", "edit"))])
def retry_error(error_id: int, db: Session = Depends(get_db)) -> dict:
    """重新解析单条错误记录（走引擎重跑，不写新代码路径）。"""
    err = db.query(ParseErrorQueue).filter(ParseErrorQueue.id == error_id).first()
    if err is None:
        raise HTTPException(status_code=404, detail="错误记录不存在")
    return _retry_one(db, err)


@router.post("/errors/retry-batch", dependencies=[Depends(require_permission("monitor", "edit"))])
def retry_errors_batch(body: RetryBatchBody, db: Session = Depends(get_db)) -> dict:
    """批量重试。"""
    results = []
    for eid in body.ids[:100]:
        err = db.query(ParseErrorQueue).filter(ParseErrorQueue.id == eid).first()
        if err is None:
            continue
        results.append(_retry_one(db, err))
    ok_count = sum(1 for r in results if r.get("ok"))
    return {"total": len(results), "ok": ok_count, "fail": len(results) - ok_count, "results": results}


@router.delete("/errors/{error_id}", status_code=204, dependencies=[Depends(require_permission("monitor", "edit"))])
def delete_error(error_id: int, db: Session = Depends(get_db)) -> None:
    """删除错误队列记录。"""
    err = db.query(ParseErrorQueue).filter(ParseErrorQueue.id == error_id).first()
    if err is None:
        raise HTTPException(status_code=404, detail="错误记录不存在")
    db.delete(err)
    db.commit()
