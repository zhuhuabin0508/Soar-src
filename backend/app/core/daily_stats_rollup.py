"""日汇总滚动计算：单日落库，供大屏聚合读取。"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.dashboard_stats import extract_exec_info
from app.core.timezone import beijing_now
from app.models import Execution, ExecutionTrace, ModelCallLog
from app.models.stats_daily import (
    StatsDailyExecution,
    StatsDailyExecutionDim,
    StatsDailyModelCall,
    StatsDailyModelCallDim,
)

logger = logging.getLogger(__name__)


def _day_bounds(stat_date: date) -> tuple[datetime, datetime]:
    start = datetime.combine(stat_date, datetime.min.time())
    return start, start + timedelta(days=1)


def _upsert_execution_day(db: Session, stat_date: date, fields: dict[str, Any]) -> None:
    row = db.query(StatsDailyExecution).filter(StatsDailyExecution.stat_date == stat_date).first()
    if row is None:
        row = StatsDailyExecution(stat_date=stat_date)
        db.add(row)
    for key, val in fields.items():
        setattr(row, key, val)
    row.updated_at = beijing_now()


def _replace_execution_dims(
    db: Session,
    stat_date: date,
    dim_type: str,
    items: dict[str, tuple[int, dict | None]],
) -> None:
    db.query(StatsDailyExecutionDim).filter(
        StatsDailyExecutionDim.stat_date == stat_date,
        StatsDailyExecutionDim.dim_type == dim_type,
    ).delete(synchronize_session=False)
    for dim_key, (count, payload) in items.items():
        db.add(
            StatsDailyExecutionDim(
                stat_date=stat_date,
                dim_type=dim_type,
                dim_key=dim_key,
                count_value=count,
                payload=payload,
            )
        )


def rollup_execution_day(db: Session, stat_date: date) -> None:
    """重算单日执行汇总（仅该日 executions 行）。"""
    start, end = _day_bounds(stat_date)
    executions = (
        db.query(Execution)
        .filter(Execution.created_at >= start, Execution.created_at < end)
        .all()
    )
    exec_ids = [e.id for e in executions]
    block_traces: list[ExecutionTrace] = []
    if exec_ids:
        block_traces = (
            db.query(ExecutionTrace)
            .filter(
                ExecutionTrace.execution_id.in_(exec_ids),
                ExecutionTrace.node_type == "block_ip",
            )
            .all()
        )
    block_success_ids = {t.execution_id for t in block_traces if t.status == "success"}
    block_attempt_ids = {t.execution_id for t in block_traces}

    auto = manual = 0
    category_counter: Counter[str] = Counter()
    ip_counter: Counter[str] = Counter()
    ip_tags: dict[str, set[str]] = defaultdict(set)
    mttr_samples: list[float] = []

    for e in executions:
        info = extract_exec_info(e)
        decision = info.get("decision")
        if e.id in block_success_ids:
            auto += 1
        if decision == "need_human_approval" or e.status == "waiting_for_approval":
            manual += 1
        alert_type = info.get("alert_type")
        if alert_type:
            category_counter[str(alert_type)] += 1
        blocked_ip = info.get("blocked_ip")
        if blocked_ip:
            ip_counter[str(blocked_ip)] += 1
            for tag in info.get("tags") or []:
                ip_tags[str(blocked_ip)].add(str(tag))
        if e.id in block_success_ids and e.finished_at and e.created_at:
            delta = (e.finished_at - e.created_at).total_seconds()
            if delta >= 0:
                mttr_samples.append(delta)

    _upsert_execution_day(
        db,
        stat_date,
        {
            "total_count": len(executions),
            "auto_block_count": auto,
            "manual_approval_count": manual,
            "block_attempt_count": len(block_attempt_ids),
            "block_success_count": len(block_success_ids),
            "mttr_sum_seconds": sum(mttr_samples),
            "mttr_sample_count": len(mttr_samples),
        },
    )
    _replace_execution_dims(
        db,
        stat_date,
        "alert_type",
        {k: (v, None) for k, v in category_counter.items()},
    )
    _replace_execution_dims(
        db,
        stat_date,
        "blocked_ip",
        {ip: (cnt, {"tags": sorted(ip_tags.get(ip, []))}) for ip, cnt in ip_counter.items()},
    )
    db.commit()
    logger.info("rollup execution day %s: total=%s", stat_date, len(executions))


def _upsert_model_day(db: Session, stat_date: date, fields: dict[str, Any]) -> None:
    row = db.query(StatsDailyModelCall).filter(StatsDailyModelCall.stat_date == stat_date).first()
    if row is None:
        row = StatsDailyModelCall(stat_date=stat_date)
        db.add(row)
    for key, val in fields.items():
        setattr(row, key, val)
    row.updated_at = beijing_now()


def _replace_model_dims(db: Session, stat_date: date, dim_type: str, rows: dict[str, dict]) -> None:
    db.query(StatsDailyModelCallDim).filter(
        StatsDailyModelCallDim.stat_date == stat_date,
        StatsDailyModelCallDim.dim_type == dim_type,
    ).delete(synchronize_session=False)
    for dim_key, agg in rows.items():
        db.add(
            StatsDailyModelCallDim(
                stat_date=stat_date,
                dim_type=dim_type,
                dim_key=dim_key,
                call_count=agg.get("call_count", 0),
                success_count=agg.get("success_count", 0),
                failed_count=agg.get("failed_count", 0),
                latency_sum_ms=agg.get("latency_sum_ms", 0),
                latency_count=agg.get("latency_count", 0),
                input_tokens=agg.get("input_tokens", 0),
                output_tokens=agg.get("output_tokens", 0),
                total_tokens=agg.get("total_tokens", 0),
                payload=agg.get("payload"),
            )
        )


def rollup_model_call_day(db: Session, stat_date: date) -> None:
    start, end = _day_bounds(stat_date)
    logs = (
        db.query(ModelCallLog)
        .filter(ModelCallLog.created_at >= start, ModelCallLog.created_at < end)
        .all()
    )
    success = sum(1 for m in logs if m.status == "success")
    failed = len(logs) - success
    latencies = [m.latency_ms for m in logs if m.latency_ms is not None]
    _upsert_model_day(
        db,
        stat_date,
        {
            "total_calls": len(logs),
            "success_calls": success,
            "failed_calls": failed,
            "latency_sum_ms": sum(latencies),
            "latency_count": len(latencies),
            "input_tokens": sum(m.input_tokens or 0 for m in logs),
            "output_tokens": sum(m.output_tokens or 0 for m in logs),
            "total_tokens": sum(m.total_tokens or 0 for m in logs),
        },
    )

    def _new_agg() -> dict:
        return {
            "call_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "latency_sum_ms": 0,
            "latency_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "payload": {},
        }

    by_provider: dict[str, dict] = defaultdict(_new_agg)
    by_trigger: dict[str, dict] = defaultdict(_new_agg)
    by_model: dict[str, dict] = defaultdict(_new_agg)
    by_agent: dict[str, dict] = defaultdict(_new_agg)

    for m in logs:
        for dim_type, key, bucket in (
            ("provider", m.provider or "unknown", by_provider),
            ("trigger", m.trigger_type or "unknown", by_trigger),
            ("model_config", str(m.model_config_id or ""), by_model),
            ("agent", str(m.agent_id or ""), by_agent),
        ):
            agg = bucket[key]
            agg["call_count"] += 1
            if m.status == "success":
                agg["success_count"] += 1
            else:
                agg["failed_count"] += 1
            if m.latency_ms is not None:
                agg["latency_sum_ms"] += m.latency_ms
                agg["latency_count"] += 1
            agg["input_tokens"] += m.input_tokens or 0
            agg["output_tokens"] += m.output_tokens or 0
            agg["total_tokens"] += m.total_tokens or 0
            if dim_type == "model_config":
                agg["payload"]["model_name"] = m.model_name or agg["payload"].get("model_name", "")
                agg["payload"]["provider"] = m.provider or agg["payload"].get("provider", "")

    _replace_model_dims(db, stat_date, "provider", by_provider)
    _replace_model_dims(db, stat_date, "trigger", by_trigger)
    _replace_model_dims(db, stat_date, "model_config", by_model)
    _replace_model_dims(db, stat_date, "agent", by_agent)
    db.commit()
    logger.info("rollup model calls day %s: total=%s", stat_date, len(logs))


def rollup_recent_days(db: Session, *, days: int = 8) -> dict[str, int]:
    """滚动重算最近 N 天（含今日），覆盖迟到数据。"""
    today = date.today()
    counts = {"execution_days": 0, "model_days": 0}
    for i in range(days):
        d = today - timedelta(days=i)
        rollup_execution_day(db, d)
        counts["execution_days"] += 1
        rollup_model_call_day(db, d)
        counts["model_days"] += 1
    return counts


def rollups_cover_dates(db: Session, dates: list[date]) -> bool:
    """检查执行日汇总是否覆盖全部日期。"""
    if not dates:
        return False
    n = (
        db.query(func.count(StatsDailyExecution.stat_date))
        .filter(StatsDailyExecution.stat_date.in_(dates))
        .scalar()
    )
    return int(n or 0) >= len(dates)


def _model_rollups_cover(db: Session, dates: list[date]) -> bool:
    n = (
        db.query(func.count(StatsDailyModelCall.stat_date))
        .filter(StatsDailyModelCall.stat_date.in_(dates))
        .scalar()
    )
    return int(n or 0) >= len(dates)


def try_compute_dashboard_from_rollups(db: Session) -> dict[str, Any] | None:
    """7 天大屏：日汇总齐全时读表，否则返回 None 走全量计算。"""
    today = date.today()
    seven_days_ago = today - timedelta(days=6)
    date_list = [(seven_days_ago + timedelta(days=i)).isoformat() for i in range(7)]
    date_objs = [date.fromisoformat(d) for d in date_list]
    if not rollups_cover_dates(db, date_objs):
        return None

    rows = (
        db.query(StatsDailyExecution)
        .filter(StatsDailyExecution.stat_date.in_(date_objs))
        .all()
    )
    by_date = {r.stat_date.isoformat(): r for r in rows}
    dims = (
        db.query(StatsDailyExecutionDim)
        .filter(StatsDailyExecutionDim.stat_date.in_(date_objs))
        .all()
    )
    category_counter: Counter[str] = Counter()
    ip_counter: Counter[str] = Counter()
    ip_tags: dict[str, set[str]] = defaultdict(set)
    for dim in dims:
        if dim.dim_type == "alert_type":
            category_counter[dim.dim_key] += dim.count_value
        elif dim.dim_type == "blocked_ip":
            ip_counter[dim.dim_key] += dim.count_value
            tags = (dim.payload or {}).get("tags") or []
            ip_tags[dim.dim_key].update(tags)

    trend = []
    block_attempt = block_success = 0
    mttr_sum = mttr_n = 0
    for d in date_list:
        r = by_date.get(d)
        trend.append({
            "date": d,
            "auto_count": int(r.auto_block_count) if r else 0,
            "manual_count": int(r.manual_approval_count) if r else 0,
        })
        if r:
            block_attempt += int(r.block_attempt_count or 0)
            block_success += int(r.block_success_count or 0)
            mttr_sum += float(r.mttr_sum_seconds or 0)
            mttr_n += int(r.mttr_sample_count or 0)

    today_row = by_date.get(today.isoformat())
    today_alerts = int(today_row.total_count) if today_row else 0
    auto_block_success_rate = round(block_success / block_attempt, 4) if block_attempt else 0.0
    mttr_seconds = round(mttr_sum / mttr_n, 2) if mttr_n else 0.0

    from app.models import Execution

    pending_approvals = (
        db.query(Execution).filter(Execution.status == "waiting_for_approval").count()
    )

    alert_categories = [
        {"name": name, "value": count}
        for name, count in category_counter.most_common()
    ]
    top_malicious_ips = [
        {"ip": ip, "count": count, "tags": sorted(ip_tags.get(ip, []))}
        for ip, count in ip_counter.most_common(10)
    ]
    logger.info("大屏统计来自日汇总表")
    return {
        "kpi": {
            "today_alerts": today_alerts,
            "auto_block_success_rate": auto_block_success_rate,
            "mttr_seconds": mttr_seconds,
            "pending_approvals": pending_approvals,
        },
        "trend_7d": trend,
        "alert_categories": alert_categories,
        "top_malicious_ips": top_malicious_ips,
    }


def try_compute_ai_usage_model_rollups(db: Session, *, days: int = 7) -> dict[str, Any] | None:
    """7 天 AI 用量中的模型侧指标；智能体侧由 dashboard_stats 补齐。"""
    days = max(1, min(int(days), 90))
    today = date.today()
    n_days_ago = today - timedelta(days=days - 1)
    date_objs = [n_days_ago + timedelta(days=i) for i in range(days)]
    date_list = [d.isoformat() for d in date_objs]
    if not _model_rollups_cover(db, date_objs):
        return None

    daily_rows = (
        db.query(StatsDailyModelCall)
        .filter(StatsDailyModelCall.stat_date.in_(date_objs))
        .all()
    )
    by_day = {r.stat_date.isoformat(): r for r in daily_rows}
    total_calls = sum(int(r.total_calls or 0) for r in daily_rows)
    success_calls = sum(int(r.success_calls or 0) for r in daily_rows)
    failed_calls = sum(int(r.failed_calls or 0) for r in daily_rows)
    latency_sum = sum(int(r.latency_sum_ms or 0) for r in daily_rows)
    latency_count = sum(int(r.latency_count or 0) for r in daily_rows)
    total_tokens = sum(int(r.total_tokens or 0) for r in daily_rows)
    input_tokens = sum(int(r.input_tokens or 0) for r in daily_rows)
    output_tokens = sum(int(r.output_tokens or 0) for r in daily_rows)

    dims = (
        db.query(StatsDailyModelCallDim)
        .filter(StatsDailyModelCallDim.stat_date.in_(date_objs))
        .all()
    )
    provider_counter: Counter[str] = Counter()
    trigger_counter: Counter[str] = Counter()
    model_agg: dict[str, dict] = defaultdict(
        lambda: {
            "call_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "latency_sum_ms": 0,
            "latency_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "payload": {},
        }
    )
    agent_rollups: dict[int, dict] = defaultdict(
        lambda: {"model_call_count": 0, "total_tokens": 0}
    )

    for dim in dims:
        if dim.dim_type == "provider":
            provider_counter[dim.dim_key] += int(dim.call_count or 0)
        elif dim.dim_type == "trigger":
            trigger_counter[dim.dim_key] += int(dim.call_count or 0)
        elif dim.dim_type == "model_config":
            agg = model_agg[dim.dim_key]
            for field in (
                "call_count",
                "success_count",
                "failed_count",
                "latency_sum_ms",
                "latency_count",
                "input_tokens",
                "output_tokens",
                "total_tokens",
            ):
                agg[field] += int(getattr(dim, field) or 0)
            if dim.payload:
                agg["payload"].update(dim.payload)
        elif dim.dim_type == "agent" and dim.dim_key.isdigit():
            aid = int(dim.dim_key)
            agent_rollups[aid]["model_call_count"] += int(dim.call_count or 0)
            agent_rollups[aid]["total_tokens"] += int(dim.total_tokens or 0)

    from app.models import LLMConfig

    llm_configs = {c.id: c for c in db.query(LLMConfig).all()}
    model_usage = []
    for key, agg in model_agg.items():
        config_id = int(key) if key.isdigit() else None
        cfg = llm_configs.get(config_id) if config_id else None
        payload = agg.get("payload") or {}
        model_usage.append({
            "model_config_id": config_id,
            "config_name": cfg.name if cfg else "(已删除配置)" if config_id else "(未关联配置)",
            "model_name": payload.get("model_name") or (cfg.model_name if cfg else ""),
            "provider": payload.get("provider") or (cfg.provider if cfg else ""),
            "call_count": agg["call_count"],
            "success_count": agg["success_count"],
            "failed_count": agg["failed_count"],
            "success_rate": round(agg["success_count"] / agg["call_count"], 4) if agg["call_count"] else 0.0,
            "avg_latency_ms": round(agg["latency_sum_ms"] / agg["latency_count"]) if agg["latency_count"] else 0,
            "input_tokens": agg["input_tokens"],
            "output_tokens": agg["output_tokens"],
            "total_tokens": agg["total_tokens"],
        })
    model_usage.sort(key=lambda x: x["call_count"], reverse=True)

    model_trend = [
        {
            "date": d,
            "count": int(by_day[d].total_calls) if d in by_day else 0,
            "tokens": int(by_day[d].total_tokens) if d in by_day else 0,
        }
        for d in date_list
    ]

    return {
        "model_kpi": {
            "total_model_calls": total_calls,
            "model_success_count": success_calls,
            "model_failed_count": failed_calls,
            "model_success_rate": round(success_calls / total_calls, 4) if total_calls else 0.0,
            "avg_model_latency_ms": round(latency_sum / latency_count) if latency_count else 0,
            "total_tokens": total_tokens,
            "total_input_tokens": input_tokens,
            "total_output_tokens": output_tokens,
        },
        "model_usage": model_usage,
        "model_trend": model_trend,
        "provider_distribution": [
            {"name": n, "value": c} for n, c in provider_counter.most_common()
        ],
        "trigger_distribution": [
            {"name": n, "value": c} for n, c in trigger_counter.most_common()
        ],
        "agent_rollups": dict(agent_rollups),
    }
