"""Workflow 版本管理路由：创建快照、列表、详情、回滚。

所有路由通过 router 级 ``dependencies=[Depends(get_current_user)]`` 强制 JWT 登录，
并通过 ``require_permission("workflow_list", ...)`` 做权限矩阵校验。
"""
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import check_resource_ownership, get_current_user, require_any_permission
from app.models import Workflow
from app.models.user import User
from app.models.workflow_version import WorkflowVersion
from app.schemas.workflow_version import (
    RollbackResponse,
    WorkflowVersionCreate,
    WorkflowVersionOut,
)

logger = logging.getLogger(__name__)

# router 级鉴权：所有版本管理接口强制登录
router = APIRouter(
    prefix="/workflows/{workflow_id}/versions",
    tags=["workflow-versions"],
    dependencies=[Depends(get_current_user)],
)

# 版本写/读允许「列表」或「编排」对应权限（与 workflows.py 口径一致）
_WF_EDIT = require_any_permission(("workflow_list", "edit"), ("workflow_editor", "edit"))
_WF_VIEW = require_any_permission(("workflow_list", "view"), ("workflow_editor", "view"))


def _build_snapshot(workflow: Workflow) -> dict[str, Any]:
    """从工作流当前状态构建快照。"""
    return {
        "name": workflow.name,
        "graph_config": workflow.graph_config,
        "enabled": workflow.enabled,
    }


def _snapshot_to_workflow_dict(snapshot: dict[str, Any]) -> dict[str, Any]:
    """将快照转换为可序列化的工作流字典（用于响应）。"""
    return {
        "name": snapshot.get("name"),
        "graph_config": snapshot.get("graph_config"),
        "enabled": snapshot.get("enabled"),
    }


def _get_workflow_or_404(db: Session, workflow_id: int) -> Workflow:
    """根据 id 查询工作流，不存在则抛 404。"""
    workflow = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if workflow is None:
        logger.warning("Workflow not found: id=%s", workflow_id)
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


def _get_version_or_404(
    db: Session, workflow_id: int, version_id: int
) -> WorkflowVersion:
    """根据 workflow_id 与 version_id 查询版本，不存在则抛 404。"""
    version = (
        db.query(WorkflowVersion)
        .filter(
            WorkflowVersion.id == version_id,
            WorkflowVersion.workflow_id == workflow_id,
        )
        .first()
    )
    if version is None:
        logger.warning(
            "WorkflowVersion not found: workflow_id=%s, version_id=%s",
            workflow_id,
            version_id,
        )
        raise HTTPException(status_code=404, detail="Workflow version not found")
    return version


@router.post("", response_model=WorkflowVersionOut, status_code=201)
def create_workflow_version(
    workflow_id: int,
    body: WorkflowVersionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(_WF_EDIT),
) -> WorkflowVersion:
    """为工作流创建一个版本快照。

    自动计算下一个 ``version_number``（当前最大 +1，初始为 1），
    snapshot 包含当前 ``{name, graph_config, enabled}``。
    """
    logger.info(
        "Creating workflow version: workflow_id=%s, by=%s",
        workflow_id,
        current_user.username,
    )
    workflow = _get_workflow_or_404(db, workflow_id)
    # 资源级 owner 校验：仅 admin/owner/被授权用户可创建版本快照
    check_resource_ownership(current_user, db, "workflow", workflow_id, workflow)

    # 计算下一个版本号
    latest = (
        db.query(WorkflowVersion)
        .filter(WorkflowVersion.workflow_id == workflow_id)
        .order_by(desc(WorkflowVersion.version_number))
        .first()
    )
    next_version_number = (latest.version_number + 1) if latest else 1

    version = WorkflowVersion(
        workflow_id=workflow_id,
        version_number=next_version_number,
        snapshot=_build_snapshot(workflow),
        change_note=body.change_note,
        created_by=current_user.username,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    logger.info(
        "Workflow version created: workflow_id=%s, version_number=%s",
        workflow_id,
        version.version_number,
    )
    return version


@router.get("", response_model=list[WorkflowVersionOut])
def list_workflow_versions(
    workflow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_WF_VIEW),
) -> list[WorkflowVersion]:
    """列出指定工作流的所有版本（按 version_number 降序）。

    资源级 owner 校验：仅 admin/owner/被授权用户可查看版本列表。
    """
    logger.info("Listing workflow versions: workflow_id=%s", workflow_id)
    workflow = _get_workflow_or_404(db, workflow_id)
    check_resource_ownership(current_user, db, "workflow", workflow_id, workflow)
    versions = (
        db.query(WorkflowVersion)
        .filter(WorkflowVersion.workflow_id == workflow_id)
        .order_by(desc(WorkflowVersion.version_number))
        .all()
    )
    logger.info(
        "Found %d versions for workflow_id=%s", len(versions), workflow_id
    )
    return versions


@router.get("/{version_id}", response_model=WorkflowVersionOut)
def get_workflow_version(
    workflow_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_WF_VIEW),
) -> WorkflowVersion:
    """获取指定版本详情。

    资源级 owner 校验：仅 admin/owner/被授权用户可查看版本详情。
    """
    logger.info(
        "Fetching workflow version: workflow_id=%s, version_id=%s",
        workflow_id,
        version_id,
    )
    workflow = _get_workflow_or_404(db, workflow_id)
    check_resource_ownership(current_user, db, "workflow", workflow_id, workflow)
    return _get_version_or_404(db, workflow_id, version_id)


@router.post("/{version_id}/rollback", response_model=RollbackResponse)
def rollback_workflow_version(
    workflow_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(_WF_EDIT),
) -> RollbackResponse:
    """回滚到指定版本。

    用版本 ``snapshot`` 覆盖当前 workflow 的 ``name / graph_config / enabled``，
    随后自动创建一个新版本快照（``change_note`` 标记回滚来源）。
    """
    logger.info(
        "Rolling back workflow: workflow_id=%s, version_id=%s, by=%s",
        workflow_id,
        version_id,
        current_user.username,
    )
    workflow = _get_workflow_or_404(db, workflow_id)
    # 资源级 owner 校验：仅 admin/owner/被授权用户可回滚版本
    check_resource_ownership(current_user, db, "workflow", workflow_id, workflow)
    version = _get_version_or_404(db, workflow_id, version_id)

    snapshot = version.snapshot or {}
    # 用 snapshot 覆盖当前工作流字段
    workflow.name = snapshot.get("name")
    workflow.graph_config = snapshot.get("graph_config")
    workflow.enabled = snapshot.get("enabled")
    db.flush()

    # 计算回滚后的新版本号
    latest = (
        db.query(WorkflowVersion)
        .filter(WorkflowVersion.workflow_id == workflow_id)
        .order_by(desc(WorkflowVersion.version_number))
        .first()
    )
    next_version_number = (latest.version_number + 1) if latest else 1

    new_version = WorkflowVersion(
        workflow_id=workflow_id,
        version_number=next_version_number,
        snapshot=_build_snapshot(workflow),
        change_note=f"回滚到版本 {version.version_number}",
        created_by=current_user.username,
    )
    db.add(new_version)
    db.commit()
    db.refresh(new_version)

    logger.info(
        "Rollback completed: workflow_id=%s, new_version_number=%s",
        workflow_id,
        new_version.version_number,
    )
    return RollbackResponse(
        workflow=_snapshot_to_workflow_dict(new_version.snapshot),
        version_number=new_version.version_number,
        message=f"已回滚到版本 {version.version_number}，并生成新版本 {new_version.version_number}",
    )
