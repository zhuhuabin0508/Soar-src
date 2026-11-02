"""人工审批路由。

提供待审批执行列表查询与审批操作（通过 / 拒绝）。
审批操作通过 Redis ``lpush`` 向 ``approval:{execution_id}`` 写入信号，
唤醒正在 ``brpop`` 阻塞的 Celery 工作流任务。

工作台增强（v2）：
- ``GET /approvals/stats`` 返回统计看板数据（待处理/今日新增/已处理/平均时长）
- ``GET /approvals`` 支持查询参数 ``status`` / ``workflow_id`` / ``q`` / ``limit``
"""
import logging
from datetime import datetime, timedelta
from app.core.timezone import beijing_now, beijing_now_iso
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.redis_client import get_redis
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models import Execution, Workflow
from app.schemas.approval import ApprovalActionResponse, ApprovalItem

logger = logging.getLogger(__name__)

# P0-1：审批相关接口强制登录；权限按接口单独声明
# （列表/统计=approval:view，approve/reject=approval:approve，删除=approval:delete）
router = APIRouter(
    prefix="/approvals",
    tags=["approvals"],
    dependencies=[Depends(get_current_user)],
)


def _build_item(exec_row: Execution) -> ApprovalItem:
    """从 Execution 行构造 ApprovalItem（含完整上下文与节点元数据）。"""
    result = exec_row.result or {}
    workflow_name = ""
    if exec_row.workflow is not None:
        workflow_name = exec_row.workflow.name or ""
    return ApprovalItem(
        execution_id=exec_row.id,
        workflow_id=exec_row.workflow_id,
        workflow_name=workflow_name,
        status=exec_row.status,
        created_at=exec_row.created_at,
        alert_data=result.get("alert_data"),
        agent_messages=result.get("agent_messages"),
        agent_decision=result.get("agent_decision"),
        context=result.get("context"),
        review_meta=result.get("review_meta"),
    )


@router.get("/stats")
def approval_stats(
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("approval", "view")),
) -> dict:
    """返回工作台统计看板数据。

    指标：
    - ``pending``: 待处理工单数（status=waiting_for_approval）
    - ``today_new``: 今日新增工单数
    - ``approved``: 历史同意封禁数（result.outcome=approved 或 status=success 且有 review）
    - ``rejected``: 历史忽略数（result.outcome=rejected）
    - ``avg_handle_seconds``: 平均处理时长（秒），仅统计已结束且有 finished_at 的

    Args:
        db: 数据库会话。

    Returns:
        统计指标字典。
    """
    logger.info("查询工作台统计数据")
    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    pending = (
        db.query(func.count(Execution.id))
        .filter(Execution.status == "waiting_for_approval")
        .scalar()
        or 0
    )
    today_new = (
        db.query(func.count(Execution.id))
        .filter(Execution.status == "waiting_for_approval")
        .filter(Execution.created_at >= today_start)
        .scalar()
        or 0
    )
    # 已处理：status in (success/failed) 且 result 含 outcome 字段（标识走过审批）
    approved = (
        db.query(func.count(Execution.id))
        .filter(Execution.status.in_(["success", "failed"]))
        .filter(Execution.result["outcome"].astext == "approved")
        .scalar()
        or 0
    )
    rejected = (
        db.query(func.count(Execution.id))
        .filter(Execution.status.in_(["success", "failed"]))
        .filter(Execution.result["outcome"].astext == "rejected")
        .scalar()
        or 0
    )
    # 平均处理时长：finished_at - created_at
    avg_seconds = (
        db.query(
            func.avg(
                func.extract("epoch", Execution.finished_at - Execution.created_at)
            )
        )
        .filter(Execution.status.in_(["success", "failed"]))
        .filter(Execution.finished_at.isnot(None))
        .scalar()
    )
    avg_handle_seconds = int(avg_seconds) if avg_seconds else 0

    return {
        "pending": pending,
        "today_new": today_new,
        "approved": approved,
        "rejected": rejected,
        "avg_handle_seconds": avg_handle_seconds,
    }


@router.get("", response_model=list[ApprovalItem])
def list_approvals(
    status: Optional[str] = Query(
        None,
        description="状态筛选：waiting_for_approval / success / failed / all（默认 waiting_for_approval）",
    ),
    workflow_id: Optional[int] = Query(None, description="按工作流 ID 筛选"),
    q: Optional[str] = Query(None, description="关键词搜索（告警类型/IP/工作流名）"),
    limit: int = Query(100, ge=1, le=500, description="返回条数上限"),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("approval", "view")),
) -> list[ApprovalItem]:
    """查询审批工单列表，支持状态/工作流/关键词筛选。

    默认只返回 ``waiting_for_approval`` 待处理工单（兼容旧前端轮询）。
    传 ``status=all`` 返回所有历史工单（含已处理）。

    Args:
        status: 状态筛选；None 或 ``waiting_for_approval`` 只看待处理，
            ``all`` 看全部，``success``/``failed`` 看指定状态。
        workflow_id: 按工作流 ID 精确筛选。
        q: 关键词，匹配 alert_data / agent_decision / workflow_name 中的文本。
        limit: 返回条数上限。
        db: 数据库会话。

    Returns:
        审批工单列表。
    """
    logger.info(
        "查询审批工单: status=%s, workflow_id=%s, q=%s, limit=%s",
        status,
        workflow_id,
        q,
        limit,
    )
    query = db.query(Execution)

    # 状态筛选
    if status is None or status == "waiting_for_approval":
        query = query.filter(Execution.status == "waiting_for_approval")
    elif status == "all":
        # 全部：含待处理 + 已处理（success/failed 中带 outcome 的）
        query = query.filter(
            or_(
                Execution.status == "waiting_for_approval",
                Execution.result["outcome"].astext.isnot(None),
            )
        )
    else:
        query = query.filter(Execution.status == status)

    if workflow_id is not None:
        query = query.filter(Execution.workflow_id == workflow_id)

    executions = query.order_by(Execution.created_at.desc()).limit(limit).all()

    items = [_build_item(e) for e in executions]

    # 关键词后置过滤（在 Python 层做，因为要跨 JSON 字段匹配）
    if q:
        ql = q.lower()
        filtered = []
        for it in items:
            haystacks = [
                str(it.alert_data or ""),
                str(it.agent_decision or ""),
                it.workflow_name or "",
                str(it.review_meta or ""),
                str(it.context or ""),
            ]
            if any(ql in h.lower() for h in haystacks):
                filtered.append(it)
        items = filtered

    logger.info("审批工单查询结果: %d 条", len(items))
    return items


@router.post("/{execution_id}/approve", response_model=ApprovalActionResponse)
def approve_execution(
    execution_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("approval", "approve")),
) -> ApprovalActionResponse:
    """通过审批，向 Redis 写入 approve 信号唤醒阻塞的工作流。

    鉴权：需 ``approval:approve`` 权限（viewer 仅有 view 权限，不能审批），
    审批人身份写入 result 与审计日志，确保高敏操作可追责。

    同时在 ``Execution.result`` 中写入 ``outcome=approved`` 与 ``finished_at``，
    供工作台统计看板即时统计（不依赖 Celery 任务结束）。

    Args:
        execution_id: 待审批的执行记录 ID。
        request: 请求对象（审计用）。
        db: 数据库会话。
        current_user: 当前用户（须持 approval:approve 权限）。

    Returns:
        审批操作响应。
    """
    logger.info("通过审批: execution_id=%s, by=%s", execution_id, current_user.username)
    execution = (
        db.query(Execution).filter(Execution.id == execution_id).first()
    )
    if execution is None:
        logger.warning("审批通过失败，执行记录不存在: id=%s", execution_id)
        raise HTTPException(status_code=404, detail="Execution not found")
    if execution.status != "waiting_for_approval":
        logger.warning(
            "审批通过失败，状态非 waiting_for_approval: id=%s, status=%s",
            execution_id,
            execution.status,
        )
        raise HTTPException(
            status_code=400,
            detail=f"Execution status is {execution.status}, not waiting_for_approval",
        )

    # 先写 outcome 到 result，供 stats 即时统计；记录审批人确保可追责
    result = dict(execution.result or {})
    result["outcome"] = "approved"
    result["handled_at"] = beijing_now_iso()
    result["handled_by"] = current_user.username
    result["handled_by_id"] = current_user.id
    execution.result = result
    db.commit()

    log_audit(
        db,
        user_id=current_user.id,
        username=current_user.username,
        action="approve",
        resource_type="approval",
        resource_id=str(execution_id),
        detail="审批通过（approve）",
        ip_address=get_client_ip(request),
    )

    redis_client = get_redis()
    redis_client.lpush(f"approval:{execution_id}", "approve")
    logger.info("approve 信号已写入: approval:%s", execution_id)

    return ApprovalActionResponse(
        execution_id=execution_id,
        status="running",
        message="approved, resuming",
    )


@router.post("/{execution_id}/reject", response_model=ApprovalActionResponse)
def reject_execution(
    execution_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("approval", "approve")),
) -> ApprovalActionResponse:
    """拒绝审批，向 Redis 写入 reject 信号终止工作流。

    鉴权：需 ``approval:approve`` 权限；审批人身份写入 result 与审计日志。

    同时在 ``Execution.result`` 中写入 ``outcome=rejected`` 与 ``finished_at``，
    供工作台统计看板即时统计。

    Args:
        execution_id: 待审批的执行记录 ID。
        request: 请求对象（审计用）。
        db: 数据库会话。
        current_user: 当前用户（须持 approval:approve 权限）。

    Returns:
        审批操作响应。
    """
    logger.info("拒绝审批: execution_id=%s, by=%s", execution_id, current_user.username)
    execution = (
        db.query(Execution).filter(Execution.id == execution_id).first()
    )
    if execution is None:
        logger.warning("审批拒绝失败，执行记录不存在: id=%s", execution_id)
        raise HTTPException(status_code=404, detail="Execution not found")
    if execution.status != "waiting_for_approval":
        logger.warning(
            "审批拒绝失败，状态非 waiting_for_approval: id=%s, status=%s",
            execution_id,
            execution.status,
        )
        raise HTTPException(
            status_code=400,
            detail=f"Execution status is {execution.status}, not waiting_for_approval",
        )

    # 写 outcome 与结束时间，供 stats 即时统计；记录审批人确保可追责
    result = dict(execution.result or {})
    result["outcome"] = "rejected"
    result["handled_at"] = beijing_now_iso()
    result["handled_by"] = current_user.username
    result["handled_by_id"] = current_user.id
    execution.result = result
    execution.status = "success"
    execution.finished_at = beijing_now()
    db.commit()

    log_audit(
        db,
        user_id=current_user.id,
        username=current_user.username,
        action="reject",
        resource_type="approval",
        resource_id=str(execution_id),
        detail="审批拒绝（reject）",
        ip_address=get_client_ip(request),
    )

    redis_client = get_redis()
    redis_client.lpush(f"approval:{execution_id}", "reject")
    logger.info("reject 信号已写入: approval:%s", execution_id)

    return ApprovalActionResponse(
        execution_id=execution_id,
        status="success",
        message="rejected, ended",
    )


@router.delete("/{execution_id}", status_code=204, dependencies=[Depends(require_permission("approval", "delete"))])
def delete_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> None:
    """删除审批执行记录（需 approval:delete；用于工作台清理测试/无效数据）。"""
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if execution is None:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    snapshot = {"id": execution.id, "workflow_id": execution.workflow_id, "status": execution.status}
    db.delete(execution)
    db.commit()
    logger.info("admin=%s 删除执行记录: %s", user.username, snapshot)
