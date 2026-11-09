"""执行记录查询路由。

提供执行列表（分页）与执行详情（含节点轨迹）查询，
以及监测统计 API（成功率 / 平均耗时 / 节点瓶颈 / 错误趋势）。
"""
import logging
from datetime import datetime, timedelta
from app.core.timezone import beijing_now, beijing_now_iso
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models import Execution, ExecutionLog, ExecutionTrace
from app.schemas.execution import ExecutionOut
from app.schemas.execution_trace import ExecutionTraceOut

logger = logging.getLogger(__name__)

# 路由级基线：强制登录；查询接口均为只读，按接口单独声明 execution:view
router = APIRouter(
    prefix="/executions",
    tags=["executions"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=list[ExecutionOut])
def list_executions(
    limit: int = Query(50, ge=1, le=500, description="每页数量"),
    offset: int = Query(0, ge=0, description="偏移量"),
    workflow_id: Optional[int] = Query(None, description="按工作流 ID 过滤"),
    status: Optional[str] = Query(None, description="按状态过滤(success/failed/running)"),
    trigger_type: Optional[str] = Query(None, description="按触发类型过滤(asset_scan/agent_test/webhook/test_run/manual)"),
    agent_id: Optional[int] = Query(None, description="按智能体 ID 过滤"),
    since: Optional[str] = Query(None, description="按创建时间过滤，ISO 日期字符串（如 2026-08-01 或 2026-08-01T00:00:00）"),
    until: Optional[str] = Query(None, description="按创建时间上限过滤，ISO 日期字符串"),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("execution", "view")),
) -> list[Execution]:
    """查询执行记录列表（分页，支持按工作流/状态/触发类型/智能体/时间范围过滤）。

    Args:
        limit: 每页数量，默认 50，范围 1-500。
        offset: 偏移量，默认 0。
        workflow_id: 可选，按工作流 ID 过滤。
        status: 可选，按执行状态过滤。
        trigger_type: 可选，按触发类型过滤（如 asset_scan 用于资产扫描进度查询）。
        agent_id: 可选，按智能体 ID 过滤。
        since: 可选，ISO 日期字符串，仅返回创建时间 >= since 的记录。
        until: 可选，ISO 日期字符串，仅返回创建时间 < until 的记录。
        db: 数据库会话。

    Returns:
        执行记录列表，按创建时间倒序。
    """
    logger.info("查询执行列表: limit=%s, offset=%s, workflow_id=%s, status=%s, trigger_type=%s, agent_id=%s, since=%s, until=%s",
                limit, offset, workflow_id, status, trigger_type, agent_id, since, until)
    q = db.query(Execution)
    if workflow_id is not None:
        q = q.filter(Execution.workflow_id == workflow_id)
    if status:
        q = q.filter(Execution.status == status)
    if trigger_type:
        q = q.filter(Execution.trigger_type == trigger_type)
    if agent_id is not None:
        q = q.filter(Execution.agent_id == agent_id)
    if since:
        try:
            since_dt = datetime.fromisoformat(since)
            q = q.filter(Execution.created_at >= since_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid 'since' date format. Use ISO format (e.g. 2026-08-01)")
    if until:
        try:
            until_dt = datetime.fromisoformat(until)
            q = q.filter(Execution.created_at < until_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid 'until' date format. Use ISO format (e.g. 2026-08-01)")
    executions = (
        q.order_by(Execution.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    logger.info("查询到 %d 条执行记录", len(executions))
    return executions


@router.get("/{execution_id}")
def get_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("execution", "view")),
) -> dict[str, Any]:
    """查询单个执行详情，含节点轨迹列表。

    Args:
        execution_id: 执行记录 ID。
        db: 数据库会话。

    Returns:
        ``{"execution": ExecutionOut, "traces": [ExecutionTraceOut, ...]}``。
    """
    logger.info("查询执行详情: id=%s", execution_id)
    execution = (
        db.query(Execution).filter(Execution.id == execution_id).first()
    )
    if execution is None:
        logger.warning("执行记录不存在: id=%s", execution_id)
        raise HTTPException(status_code=404, detail="Execution not found")

    traces = (
        db.query(ExecutionTrace)
        .filter(ExecutionTrace.execution_id == execution_id)
        .order_by(ExecutionTrace.started_at.asc())
        .all()
    )
    logs = (
        db.query(ExecutionLog)
        .filter(ExecutionLog.execution_id == execution_id)
        .order_by(ExecutionLog.timestamp.asc())
        .all()
    )
    logger.info(
        "执行详情: id=%s, traces=%d, logs=%d", execution_id, len(traces), len(logs)
    )

    execution_out = ExecutionOut.model_validate(execution)
    traces_out = [ExecutionTraceOut.model_validate(t) for t in traces]
    logs_out = [
        {
            "node_id": log.node_id,
            "level": log.level,
            "message": log.message,
            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
        }
        for log in logs
    ]
    return {"execution": execution_out, "traces": traces_out, "logs": logs_out}


@router.get("/stats/overview")
def get_stats_overview(
    days: int = Query(7, ge=1, le=90, description="统计最近 N 天的数据"),
    workflow_id: Optional[int] = Query(None, description="按工作流 ID 过滤；不传则统计全部"),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("execution", "view")),
) -> dict[str, Any]:
    """监测统计概览：成功率 / 平均耗时 / 按天趋势 / 触发类型分布 / 节点瓶颈。

    支持按 ``workflow_id`` 过滤（只统计指定工作流的执行），便于在执行监测看板
    上聚焦单个工作流的运行情况。不传 ``workflow_id`` 时统计全部执行（含智能体测试）。

    Args:
        days: 统计最近 N 天的数据，默认 7 天，范围 1-90。
        workflow_id: 可选，按工作流 ID 过滤。
        db: 数据库会话。

    Returns:
        ``{total, success, failed, success_rate, avg_duration_seconds,
           by_day: [{date, total, success, failed}],
           by_trigger: {webhook: N, test_run: M},
           node_bottleneck: [{node_type, avg_duration_seconds, count, failed_count}]}``
    """
    from app.core.dashboard_cache import CacheKeys, resolve_cached_payload
    from app.core.dashboard_stats import compute_executions_overview

    if workflow_id is not None:
        return compute_executions_overview(db, days=days, workflow_id=workflow_id)

    return resolve_cached_payload(
        CacheKeys.executions_overview(days),
        db,
        lambda session: compute_executions_overview(session, days=days),
        allow_live_cold_start=(days == 7),
    )
