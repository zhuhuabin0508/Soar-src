"""工单流程模板管理 API。

- 流程模板：节点/字段/路由全部内嵌 ``nodes`` JSON，支持草稿与发布
- 发布校验：至少 1 个处理节点 / 节点 key 唯一 / 路由指向存在 / 字段 key 唯一且类型合法 /
  分组存在且启用 / 发起分组已配置
- 内容更新后自动回到草稿态，需重新发布才能被发起工单引用
- 进行中工单使用发起时的快照，不受模板修改影响

权限：``ticket_config:view`` 可查看，``ticket_config:edit`` 可增删改/发布。
"""
import copy
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.core.ticket_flow import validate_flow_structure
from app.core.timezone import to_beijing_iso
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.ticket import Ticket, TicketFlow, TicketFlowVersion, TicketGroup
from app.models.user import User
from app.schemas.ticket import FlowCreate, FlowUpdate
from app.workflow.audit import write_audit

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/ticket-config/flows",
    tags=["ticket-config"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("ticket_config", "view")),
    ],
)


# ============ 辅助 ============

def _get_flow_or_404(db: Session, flow_id: int) -> TicketFlow:
    flow = db.query(TicketFlow).filter(TicketFlow.id == flow_id).first()
    if flow is None:
        raise HTTPException(status_code=404, detail="流程模板不存在")
    return flow


def _group_ok_factory(db: Session):
    """分组存在性校验回调（存在且启用）。"""
    cache: dict[int, bool] = {}

    def _ok(gid: int) -> bool:
        gid = int(gid)
        if gid not in cache:
            g = db.query(TicketGroup).filter(TicketGroup.id == gid).first()
            cache[gid] = bool(g and g.enabled)
        return cache[gid]

    return _ok


def _flow_payload(flow: TicketFlow, ticket_count: int | None = None) -> dict:
    data = flow.to_dict()
    data["node_count"] = len(flow.nodes.get("nodes") or []) if isinstance(flow.nodes, dict) else 0
    if ticket_count is not None:
        data["ticket_count"] = ticket_count
    return data


def _version_payload(v: TicketFlowVersion, with_nodes: bool = False) -> dict:
    """版本存档序列化：列表只给摘要（nodes 体积大），详情按需带全量。"""
    data = {
        "id": v.id,
        "version": v.version,
        "name": v.name,
        "description": v.description,
        "node_count": len((v.nodes or {}).get("nodes") or []) if isinstance(v.nodes, dict) else 0,
        "published_by": v.published_by,
        "published_at": to_beijing_iso(v.published_at),
    }
    if with_nodes:
        data["nodes"] = v.nodes
    return data


# ============ 接口 ============

@router.get("")
def list_flows(db: Session = Depends(get_db)) -> dict:
    """流程模板列表（含工单引用数）。"""
    flows = db.query(TicketFlow).order_by(TicketFlow.id.desc()).all()
    counts: dict[int, int] = {}
    if flows:
        rows = (
            db.query(Ticket.flow_id, func.count(Ticket.id))
            .filter(Ticket.flow_id.in_([f.id for f in flows]))
            .group_by(Ticket.flow_id)
            .all()
        )
        counts = {fid: c for fid, c in rows}
    return {"items": [_flow_payload(f, counts.get(f.id, 0)) for f in flows]}


@router.get("/{flow_id}")
def get_flow(flow_id: int, db: Session = Depends(get_db)) -> dict:
    """流程模板详情。"""
    flow = _get_flow_or_404(db, flow_id)
    return _flow_payload(flow)


@router.post("", status_code=201)
def create_flow(
    body: FlowCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """创建流程模板：默认草稿态，发布前不校验结构（保存即草稿）。"""
    name = sanitize_text(body.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="模板名称不能为空")
    flow = TicketFlow(
        name=name,
        description=sanitize_text(body.description) if body.description else None,
        nodes=body.nodes or {},
        is_draft=True,
        created_by=current_user.username,
    )
    db.add(flow)
    db.commit()
    db.refresh(flow)
    write_audit(
        db, action="ticket_flow_create", resource_type="ticket_flow", resource_id=flow.id,
        detail={"name": flow.name},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("创建工单流程模板: id=%s name=%s, operator=%s", flow.id, flow.name, current_user.username)
    return _flow_payload(flow)


@router.put("/{flow_id}")
def update_flow(
    flow_id: int,
    body: FlowUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """更新流程模板：内容（名称/描述/nodes）变更后自动回到草稿态，需重新发布。

    仅切换 enabled 不影响草稿状态。
    """
    flow = _get_flow_or_404(db, flow_id)
    content_changed = False
    if body.name is not None:
        name = sanitize_text(body.name).strip()
        if not name:
            raise HTTPException(status_code=400, detail="模板名称不能为空")
        if name != flow.name:
            content_changed = True
            flow.name = name
    if body.description is not None:
        desc = sanitize_text(body.description) or None
        if desc != flow.description:
            content_changed = True
            flow.description = desc
    if body.nodes is not None:
        if not isinstance(body.nodes, dict):
            raise HTTPException(status_code=400, detail="nodes 必须为 JSON 对象")
        if body.nodes != flow.nodes:
            content_changed = True
            flow.nodes = body.nodes
    if body.enabled is not None:
        flow.enabled = body.enabled
    if content_changed:
        flow.is_draft = True
    db.commit()
    db.refresh(flow)
    write_audit(
        db, action="ticket_flow_update", resource_type="ticket_flow", resource_id=flow.id,
        detail={"name": flow.name, "content_changed": content_changed, "is_draft": flow.is_draft},
        operator=current_user.username, user_id=current_user.id,
    )
    return _flow_payload(flow)


@router.post("/{flow_id}/publish")
def publish_flow(
    flow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """发布流程模板：结构校验通过后置为已发布（is_draft=False，version+1）。

    发布成功同时写入版本存档（ticket_flow_versions），供版本历史查看与回滚。
    """
    flow = _get_flow_or_404(db, flow_id)
    errors = validate_flow_structure(flow.nodes, group_ok=_group_ok_factory(db))
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))

    flow.is_draft = False
    flow.enabled = True
    flow.version = (flow.version or 0) + 1
    # 深拷贝快照：JSON 列不追踪原位修改，直接赋引用会在后续编辑时污染存档
    db.add(TicketFlowVersion(
        flow_id=flow.id,
        version=flow.version,
        name=flow.name,
        description=flow.description,
        nodes=copy.deepcopy(flow.nodes),
        published_by=current_user.username,
    ))
    db.commit()
    db.refresh(flow)
    write_audit(
        db, action="ticket_flow_publish", resource_type="ticket_flow", resource_id=flow.id,
        detail={"name": flow.name, "version": flow.version},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("发布工单流程模板: id=%s name=%s v%s, operator=%s",
                flow.id, flow.name, flow.version, current_user.username)
    return _flow_payload(flow)


# ============ 版本管理 ============

@router.get("/{flow_id}/versions")
def list_flow_versions(flow_id: int, db: Session = Depends(get_db)) -> dict:
    """版本存档列表（摘要，不含 nodes 主体），按版本号倒序。"""
    _get_flow_or_404(db, flow_id)
    rows = (
        db.query(TicketFlowVersion)
        .filter(TicketFlowVersion.flow_id == flow_id)
        .order_by(TicketFlowVersion.version.desc())
        .all()
    )
    return {"items": [_version_payload(v) for v in rows]}


@router.get("/{flow_id}/versions/{version}")
def get_flow_version(flow_id: int, version: int, db: Session = Depends(get_db)) -> dict:
    """版本存档详情（含完整 nodes，供前端 diff）。"""
    _get_flow_or_404(db, flow_id)
    snap = (
        db.query(TicketFlowVersion)
        .filter(TicketFlowVersion.flow_id == flow_id, TicketFlowVersion.version == version)
        .first()
    )
    if snap is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    return _version_payload(snap, with_nodes=True)


@router.post("/{flow_id}/versions/{version}/rollback")
def rollback_flow_version(
    flow_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """回滚到指定发布版本：存档内容覆盖当前模板（名称/描述/nodes）。

    回滚后回到草稿态，检查确认后需重新发布才生效；进行中工单不受影响。
    """
    flow = _get_flow_or_404(db, flow_id)
    snap = (
        db.query(TicketFlowVersion)
        .filter(TicketFlowVersion.flow_id == flow_id, TicketFlowVersion.version == version)
        .first()
    )
    if snap is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    if snap.nodes == flow.nodes and snap.name == flow.name and snap.description == flow.description:
        raise HTTPException(status_code=400, detail="当前内容与该版本一致，无需回滚")

    flow.name = snap.name
    flow.description = snap.description
    flow.nodes = copy.deepcopy(snap.nodes)  # 拷贝隔离，避免后续编辑反向污染存档
    flow.is_draft = True
    db.commit()
    db.refresh(flow)
    write_audit(
        db, action="ticket_flow_rollback", resource_type="ticket_flow", resource_id=flow.id,
        detail={"name": flow.name, "rollback_to_version": version},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("回滚工单流程模板: id=%s 回滚到 v%s, operator=%s",
                flow_id, version, current_user.username)
    return _flow_payload(flow)


@router.delete("/{flow_id}")
def delete_flow(
    flow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """删除流程模板：已被工单引用（含历史）时禁止删除。"""
    flow = _get_flow_or_404(db, flow_id)
    count = db.query(func.count(Ticket.id)).filter(Ticket.flow_id == flow_id).scalar()
    if count:
        raise HTTPException(status_code=400, detail=f"该模板已被 {count} 条工单引用，禁止删除")
    # 版本存档随模板一并清理（无工单引用才可删，存档无独立保留价值）
    db.query(TicketFlowVersion).filter(TicketFlowVersion.flow_id == flow_id).delete()
    db.delete(flow)
    db.commit()
    write_audit(
        db, action="ticket_flow_delete", resource_type="ticket_flow", resource_id=flow_id,
        detail={"name": flow.name},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("删除工单流程模板: id=%s name=%s, operator=%s", flow_id, flow.name, current_user.username)
    return {"deleted": flow_id}
