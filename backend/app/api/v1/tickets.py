"""工单实例 API。

核心能力：
- 工单发起：校验发起人属于流程的发起分组，字段按首节点定义校验，发起即对流程模板做快照
- 工单列表：待我处理（当前节点分组=我的分组）/ 我发起 / 我处理过 / 全部，多维筛选分页，
  附 SLA 剩余倒计时（超时红色高亮）与催办权限标记
- 工单详情：完整节点处理时间线（上游节点字段对处理人只读展示）
- 工单流转：当前节点分组内任一成员提交即代表全组（先到先得），字段按当前节点定义校验，
  流向必须在路由白名单内，未显式选择时按条件路由自动建议
- 工单取消：仅发起人或 admin
- 催办：发起人/抄送人/admin 对处理中工单一键催办（30 分钟限频），通知当前节点分组
- 转办/改派：当前节点处理人转给其他分组（接管当前节点）或指定人（认领锁定）
- 认领：组内成员先到先得认领，认领后仅认领人/admin 可提交
- 内部评论：时间线评论（区别于处置意见），通知发起人与处理组成员
- 相似工单推荐：发起时按首节点 源/目的 IP 匹配同流程历史工单（处置中/已完成）
  （源+目的均相同 > 仅源相同 > 仅目的相同，均不同不返回）
- 工单导出：按当前筛选条件导出 CSV（UTF-8 BOM）
- 附件：通用上传 + query token 下载（截图等 file 类型字段）

权限：``ticket:view`` 可查看，``ticket:edit`` 可发起/流转，取消=发起人或 admin。
所有动作写审计日志，流转成功后通知下一分组。
"""
import csv
import ipaddress
import io
import logging
import os
import re
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.core.ticket_enrichment import build_ticket_enrichment, start_agent_analysis_bg
from app.core.ticket_sla import evaluate_ticket_sla, get_sla_config
from app.core.ticket_flow import (
    collect_ref_options,
    get_node,
    get_node_pending_groups,
    get_start_node,
    is_end_node,
    parse_duration,
    strip_hidden_field_values,
    suggest_route,
    validate_field_values,
)
from datetime import timedelta

from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import get_current_user, is_admin, require_permission
from app.models.banned_ip import BannedIP
from app.models.notification import Notification
from app.models.ticket import (
    Ticket, TicketCc, TicketFlow, TicketGroup, TicketGroupMember, TicketNodeRecord,
)
from app.models.user import User
from app.models.workflow_ban import BanRecord
from app.schemas.ticket import (
    TicketAdvance, TicketCancel, TicketCcAdd, TicketComment, TicketCreate,
    TicketRollback, TicketSimilar, TicketTransfer,
)
from app.workflow.audit import write_audit

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/tickets",
    tags=["tickets"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("ticket", "view")),
    ],
)

# ============ 常量与辅助 ============

# 状态中文
STATUS_LABELS = {"processing": "进行中", "completed": "已完成", "cancelled": "已取消"}
PRIORITY_LABELS = {"low": "低", "medium": "中", "high": "高", "critical": "紧急"}

# 附件：扩展名白名单（与反馈附件一致，拒绝一切可执行文件）；元组保序用于报错提示
ALLOWED_ATTACHMENT_EXTENSIONS = (
    "png", "jpg", "jpeg", "gif", "webp", "bmp",
    "pdf", "txt", "log", "md", "csv", "zip",
)
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024  # 10MB
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
    "tickets",
    "pending",
)

# 仅去除控制字符（不做 HTML 转义：React 文本渲染自动转义，URL 字段不能被转义）
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean_value(v):
    if isinstance(v, str):
        return _CONTROL_CHARS.sub("", v)
    return v


def _clean_field_values(values: dict) -> dict:
    return {k: _clean_value(v) for k, v in (values or {}).items()}


def _my_group_ids(db: Session, user_id: int) -> list[int]:
    """当前用户所属的工单分组 ID 列表。"""
    return [
        gid for (gid,) in db.query(TicketGroupMember.group_id)
        .filter(TicketGroupMember.user_id == user_id)
        .all()
    ]


def _csv_group_ids(ticket: Ticket) -> set[int]:
    """工单当前待处理分组集合：优先 current_group_ids CSV，回退 current_group_id（旧数据）。"""
    raw = getattr(ticket, "current_group_ids", None)
    if raw:
        return {int(x) for x in str(raw).split(",") if x.strip().isdigit()}
    return {ticket.current_group_id} if ticket.current_group_id else set()


def _set_current_groups(ticket: Ticket, node: dict | None) -> None:
    """到达节点时重置待处理分组（并行会签=全部会签组；普通节点=单分组）。

    current_group_id 始终指向首个待处理分组（兼容展示/转办/旧数据筛选）。
    """
    groups = get_node_pending_groups(node) if node else []
    ticket.current_group_ids = ("," + ",".join(str(g) for g in groups) + ",") if groups else None
    ticket.current_group_id = groups[0] if groups else None


def _get_ticket_or_404(db: Session, ticket_id: int, *, for_update: bool = False) -> Ticket:
    """取工单；``for_update=True`` 时行级加锁（SELECT ... FOR UPDATE）。

    会签/认领/转办/催办等"读-改-写"并发敏感路径必须加锁，防止并发下重复会签、
    认领互相覆盖（SQLite 无 FOR UPDATE，方言自动忽略，由库级锁兜底）。
    """
    query = db.query(Ticket).filter(Ticket.id == ticket_id)
    if for_update:
        query = query.with_for_update()
    ticket = query.first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="工单不存在")
    return ticket


def _group_name_map(db: Session, group_ids: set[int]) -> dict[int, str]:
    """批量取分组名。"""
    ids = [g for g in group_ids if g]
    if not ids:
        return {}
    rows = db.query(TicketGroup.id, TicketGroup.name).filter(TicketGroup.id.in_(ids)).all()
    return {gid: name for gid, name in rows}


def _gen_ticket_no(db: Session) -> str:
    """生成工单编号：TK-YYYYMMDD-XXXX（当日序号，4 位补零）。"""
    today = beijing_now().strftime("%Y%m%d")
    prefix = f"TK-{today}-"
    count = (
        db.query(func.count(Ticket.id))
        .filter(Ticket.ticket_no.like(prefix + "%"))
        .scalar()
        or 0
    )
    return f"{prefix}{count + 1:04d}"


def _resolve_route(
    routes: list,
    field_values: dict,
    explicit_route: str | None,
    node_label: str,
) -> str:
    """解析流转去向：显式选择 → 校验白名单；未选择 → 条件建议/默认路由。"""
    whitelist = {r.get("to") for r in routes or [] if isinstance(r, dict) and r.get("to")}
    if not whitelist:
        raise HTTPException(status_code=400, detail=f"节点「{node_label}」未配置流转路由")
    if explicit_route:
        if explicit_route not in whitelist:
            raise HTTPException(
                status_code=400,
                detail=f"流转去向 {explicit_route} 不在节点「{node_label}」的路由白名单内",
            )
        return explicit_route
    suggested, default = suggest_route(routes, field_values)
    target = suggested or default
    if not target:
        raise HTTPException(status_code=400, detail=f"节点「{node_label}」无可用流转路由")
    return target


def _notify_next_group(db: Session, ticket: Ticket, node_name: str, group_ids: list[int] | int | None) -> None:
    """流转成功后精确通知下一处理分组成员（并行会签=全部待签分组）。

    直接投递给分组成员（不走通知规则路由），避免未配置规则时回退全员广播、
    把节点待处理提醒发给无关人员（如其他分组的成员）。
    """
    if isinstance(group_ids, int):
        group_ids = [group_ids]
    ids = [g for g in (group_ids or []) if g]
    if not ids:
        return
    sign_note = "，各组均需会签处理" if len(ids) > 1 else "（组内任一成员提交即代表全组）"
    for gid in ids:
        group = db.query(TicketGroup).filter(TicketGroup.id == gid).first()
        group_label = group.name if group else f"分组{gid}"
        user_ids = sorted({
            uid for (uid,) in db.query(TicketGroupMember.user_id)
            .filter(TicketGroupMember.group_id == gid)
            .all()
            if uid
        })
        if not user_ids:
            logger.warning("流转通知无收件人（分组无成员）: ticket=%s group=%s", ticket.id, gid)
            continue
        _notify_user_ids(
            db, ticket, user_ids,
            title=f"工单待处理：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已流转至节点「{node_name}」，"
                f"请【{group_label}】跟进处理{sign_note}"
            ),
        )


def _notify_sign_progress(
    db: Session, ticket: Ticket, node: dict, remaining_ids: list[int], done: int, total: int
) -> None:
    """会签中间进度通知：提醒尚未会签的分组跟进。"""
    if not remaining_ids:
        return
    node_label = node.get("name") or node.get("key")
    for gid in remaining_ids:
        group = db.query(TicketGroup).filter(TicketGroup.id == gid).first()
        group_label = group.name if group else f"分组{gid}"
        user_ids = sorted({
            uid for (uid,) in db.query(TicketGroupMember.user_id)
            .filter(TicketGroupMember.group_id == gid)
            .all()
            if uid
        })
        if not user_ids:
            continue
        _notify_user_ids(
            db, ticket, user_ids,
            title=f"工单会签进行中：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」在节点「{node_label}」会签进行中"
                f"（已完成 {done}/{total} 组），请【{group_label}】尽快会签"
            ),
        )


# ============ SLA 展示与共享筛选 ============

# 催办限频：30 分钟内同一工单仅可催办一次
URGE_INTERVAL_MINUTES = 30


def _fmt_duration(minutes: float) -> str:
    """分钟数 → 中文时长（X天X小时 / X小时X分 / X分钟）。"""
    m = int(abs(minutes))
    days, rem = divmod(m, 1440)
    hours, mins = divmod(rem, 60)
    if days:
        return f"{days}天{hours}小时" if hours else f"{days}天"
    if hours:
        return f"{hours}小时{mins}分" if mins else f"{hours}小时"
    return f"{mins}分钟"


def _sla_remaining(ticket: Ticket, records: list, now, config: dict) -> tuple[float | None, bool, bool]:
    """处理中工单的 SLA 倒计时：未响应看响应目标，已响应看解决目标。

    返回 (剩余分钟, 是否超时, 是否有目标)；剩余为负即超时。
    """
    target = config.get(ticket.priority) or {}
    resp_target = target.get("response")
    res_target = target.get("resolve")
    if not resp_target and not res_target:
        return None, False, False
    creates = [r for r in records if r.action == "create"]
    has_submit = any(r.action == "submit" for r in records)
    started = (creates[0].created_at if creates and creates[0].created_at else None) or ticket.created_at
    if not has_submit and resp_target and started:
        remaining = resp_target - (now - started).total_seconds() / 60
    elif res_target and ticket.created_at:
        remaining = res_target - (now - ticket.created_at).total_seconds() / 60
    else:
        return None, False, True
    return remaining, remaining < 0, True


def _apply_ticket_filters(
    db: Session,
    current_user: User,
    view: str,
    status: str | None,
    flow_id: int | None,
    priority: str | None,
    archived: str,
    q: str | None,
):
    """列表/导出共用的筛选逻辑：视图 + 归档 + 状态/流程/优先级/关键词。"""
    query = db.query(Ticket)

    if view == "my_pending":
        my_groups = _my_group_ids(db, current_user.id)
        if not my_groups:
            return None
        # 并行会签：工单可同时待多个分组处理（current_group_ids CSV），
        # 任一命中即出现在"待我处理"；旧数据（CSV 为空）回退 current_group_id
        group_cond = or_(
            Ticket.current_group_id.in_(my_groups),
            *[
                Ticket.current_group_ids.like(f"%,{g},%")
                for g in my_groups
            ],
        )
        query = query.filter(
            Ticket.status == "processing",
            group_cond,
        )
    elif view == "created":
        query = query.filter(Ticket.created_by_id == current_user.id)
    elif view == "handled":
        handled_ids = (
            db.query(TicketNodeRecord.ticket_id)
            .filter(TicketNodeRecord.handler_id == current_user.id)
            .distinct()
            .subquery()
        )
        query = query.filter(Ticket.id.in_(handled_ids))
    elif view == "cc":
        # 抄送我的：直接抄送本人 + 抄送我所在分组（组内成员均可见）
        my_groups = _my_group_ids(db, current_user.id)
        cc_cond = (
            (TicketCc.target_type == "user") & (TicketCc.target_id == current_user.id)
        ) | (
            (TicketCc.target_type == "group") & TicketCc.target_id.in_(my_groups or [-1])
        )
        cc_ids = (
            db.query(TicketCc.ticket_id).filter(cc_cond).distinct().subquery()
        )
        query = query.filter(Ticket.id.in_(cc_ids))

    # 归档过滤（应用于所有视图）
    if archived == "only":
        query = query.filter(Ticket.archived.is_(True))
    elif archived != "include":
        query = query.filter(Ticket.archived.is_(False))

    if status:
        query = query.filter(Ticket.status == status)
    if flow_id:
        query = query.filter(Ticket.flow_id == flow_id)
    if priority:
        query = query.filter(Ticket.priority == priority)
    if q:
        kw = f"%{q.strip()}%"
        query = query.filter(or_(Ticket.ticket_no.like(kw), Ticket.title.like(kw)))
    return query


def _group_member_ids(db: Session, group_id: int | None) -> list[int]:
    """分组成员用户 ID 列表（去重、去空）。"""
    if not group_id:
        return []
    return sorted({
        uid for (uid,) in db.query(TicketGroupMember.user_id)
        .filter(TicketGroupMember.group_id == group_id)
        .all()
        if uid
    })


def _cc_ticket_ids_for_user(db: Session, user: User, ticket_ids: list[int]) -> set[int]:
    """用户在指定工单集合中被抄送的工单 ID（直接抄送本人 + 抄送所在分组）。"""
    if not ticket_ids:
        return set()
    my_groups = _my_group_ids(db, user.id)
    cc_cond = (
        (TicketCc.target_type == "user") & (TicketCc.target_id == user.id)
    ) | (
        (TicketCc.target_type == "group") & TicketCc.target_id.in_(my_groups or [-1])
    )
    return {
        tid for (tid,) in db.query(TicketCc.ticket_id)
        .filter(cc_cond, TicketCc.ticket_id.in_(ticket_ids)).distinct().all()
    }


# ============ 抄送（CC）辅助 ============

def _normalize_cc_targets(raw) -> list[dict]:
    """清洗抄送对象列表：仅保留合法元素 [{type: user|group, id, name}]。"""
    out = []
    seen = set()
    for t in raw or []:
        if not isinstance(t, dict) or t.get("type") not in ("user", "group"):
            continue
        tid = t.get("id")
        if isinstance(tid, bool) or not isinstance(tid, int):
            continue
        key = (t["type"], tid)
        if key in seen:
            continue
        seen.add(key)
        out.append({"type": t["type"], "id": tid, "name": str(t.get("name") or "").strip()})
    return out


def _fill_cc_names(db: Session, targets: list[dict]) -> list[dict]:
    """补全/校验抄送对象名称与存在性：user 须为启用账号，group 须为启用分组。"""
    user_ids = [t["id"] for t in targets if t["type"] == "user"]
    group_ids = [t["id"] for t in targets if t["type"] == "group"]
    users = {
        uid: (name or f"用户{uid}")
        for uid, name in db.query(User.id, User.display_name)
        .filter(User.id.in_(user_ids), User.is_active.is_(True)).all()
    } if user_ids else {}
    groups = {
        gid: name
        for gid, name in db.query(TicketGroup.id, TicketGroup.name)
        .filter(TicketGroup.id.in_(group_ids), TicketGroup.enabled.is_(True)).all()
    } if group_ids else {}
    out = []
    for t in targets:
        if t["type"] == "user" and t["id"] in users:
            out.append({**t, "name": t["name"] or users[t["id"]]})
        elif t["type"] == "group" and t["id"] in groups:
            out.append({**t, "name": t["name"] or groups[t["id"]]})
    return out


def _cc_rows(db: Session, ticket_id: int) -> list[TicketCc]:
    """取工单的全部抄送行（按加入顺序）。"""
    return (
        db.query(TicketCc)
        .filter(TicketCc.ticket_id == ticket_id)
        .order_by(TicketCc.id.asc())
        .all()
    )


def _resolve_cc_user_ids(db: Session, rows: list[TicketCc], exclude_id: int | None = None) -> list[int]:
    """把抄送行展开为实际用户 ID 集合：user 直取，group 展开组内启用成员。"""
    ids: set[int] = set()
    group_ids = []
    for r in rows:
        if r.target_type == "user":
            ids.add(r.target_id)
        else:
            group_ids.append(r.target_id)
    if group_ids:
        for (uid,) in (
            db.query(TicketGroupMember.user_id)
            .join(User, User.id == TicketGroupMember.user_id)
            .filter(TicketGroupMember.group_id.in_(group_ids), User.is_active.is_(True))
            .all()
        ):
            ids.add(uid)
    # 仅保留真实存在的启用账号（组直存、防脏数据）
    if ids:
        ids = {
            uid for (uid,) in db.query(User.id)
            .filter(User.id.in_(ids), User.is_active.is_(True)).all()
        }
    if exclude_id:
        ids.discard(exclude_id)
    return sorted(ids)


def _notify_user_ids(db: Session, ticket: Ticket, user_ids: list[int], title: str, content: str) -> None:
    """精确投递通知给指定用户（不走通知规则路由，抄送场景必须送达本人）。"""
    for uid in user_ids:
        db.add(Notification(
            user_id=uid,
            type="ticket",
            title=title,
            content=content,
            related_type="ticket",
            related_id=ticket.id,
            created_by="system",
        ))


def _notify_cc_added(db: Session, ticket: Ticket, rows: list[TicketCc], operator: User, *, finished: bool = False) -> None:
    """抄送通知：发起/被加入抄送时通知（发起直通完结时合并为完结通知）。"""
    if not rows:
        return
    user_ids = _resolve_cc_user_ids(db, rows, exclude_id=operator.id)
    if not user_ids:
        return
    if finished:
        _notify_user_ids(
            db, ticket, user_ids,
            title=f"工单已完成：{ticket.ticket_no}",
            content=f"您被抄送的工单「{ticket.title}」已完成，请知悉结果（发起人：{ticket.created_by_name}）",
        )
    else:
        _notify_user_ids(
            db, ticket, user_ids,
            title=f"工单抄送：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已抄送给您（发起人：{ticket.created_by_name}，"
                f"当前节点：{ticket.current_node_name or ticket.current_node_key or '已完结'}），请知悉"
            ),
        )


def _notify_cc_finished(db: Session, ticket: Ticket, result_label: str, reason: str | None = None) -> None:
    """完结通知：工单完成/取消时把最终结果通知全部抄送人。"""
    rows = _cc_rows(db, ticket.id)
    if not rows:
        return
    user_ids = _resolve_cc_user_ids(db, rows)
    if not user_ids:
        return
    content = f"您被抄送的工单「{ticket.title}」已{result_label}，请知悉结果"
    if reason:
        content += f"（原因：{reason}）"
    _notify_user_ids(
        db, ticket, user_ids,
        title=f"工单已{result_label}：{ticket.ticket_no}",
        content=content,
    )


def _ticket_list_item(ticket: Ticket, group_names: dict[int, str]) -> dict:
    data = ticket.to_dict()
    # 列表剔除自动研判大 JSON（详情接口返回，保持列表响应轻量）
    data.pop("enrichment_data", None)
    data["status_label"] = STATUS_LABELS.get(ticket.status, ticket.status)
    data["priority_label"] = PRIORITY_LABELS.get(ticket.priority, ticket.priority)
    # 并行会签：展示全部待处理分组（多组标注会签）；普通节点回退单分组名
    pending = sorted(_csv_group_ids(ticket))
    data["current_group_ids"] = pending
    names = [group_names.get(g) for g in pending if group_names.get(g)]
    if len(pending) > 1:
        data["current_group_name"] = "、".join(names) + "（会签）" if names else None
    else:
        data["current_group_name"] = group_names.get(ticket.current_group_id) if ticket.current_group_id else None
    return data


def _ticket_detail(db: Session, ticket: Ticket, current_user: User) -> dict:
    """工单详情：快照 + 节点时间线 + 当前用户操作权限。"""
    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    records = (
        db.query(TicketNodeRecord)
        .filter(TicketNodeRecord.ticket_id == ticket.id)
        .order_by(TicketNodeRecord.id.asc())
        .all()
    )
    # 分组名映射（快照节点 + 当前节点涉及分组，含并行会签 sign_groups）
    group_ids: set[int] = set()
    for n in snapshot.get("nodes") or []:
        if isinstance(n, dict):
            if n.get("group_id"):
                group_ids.add(int(n["group_id"]))
            for sg in n.get("sign_groups") or []:
                if isinstance(sg, int) and not isinstance(sg, bool):
                    group_ids.add(sg)
    pending_groups = _csv_group_ids(ticket)
    group_ids |= pending_groups
    if ticket.current_group_id:
        group_ids.add(ticket.current_group_id)
    group_names = _group_name_map(db, group_ids)

    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    my_groups = set(_my_group_ids(db, current_user.id))
    admin = is_admin(current_user, db)

    # 基础处理权：处理中 + admin / 当前节点任一待处理分组成员（并行会签）/ 认领人
    # （认领人含被改派到个人的用户——其可能不属于节点分组，若不放开该工单将无人能继续流转）
    base_can_handle = (
        ticket.status == "processing"
        and bool(current_node)
        and (admin or bool(pending_groups & my_groups) or ticket.claimed_by_id == current_user.id)
    )
    # 认领锁定：被认领后仅认领人（或 admin）可继续处理
    claim_locked_by_other = (
        ticket.claimed_by_id is not None
        and ticket.claimed_by_id != current_user.id
        and not admin
    )
    can_handle = bool(base_can_handle and not claim_locked_by_other)
    # 催办权限：发起人 / 抄送人 / admin（处理中）
    cc_user_ids = set(_resolve_cc_user_ids(db, _cc_rows(db, ticket.id)))
    can_urge = bool(
        ticket.status == "processing"
        and (admin or ticket.created_by_id == current_user.id or current_user.id in cc_user_ids)
    )
    # 评论权限：发起人 / 当前节点处理人 / 抄送人 / admin（不限工单状态，与评论端点一致）
    is_handler_any = bool(current_node and (pending_groups & my_groups))
    can_comment = bool(
        admin or ticket.created_by_id == current_user.id
        or is_handler_any or current_user.id in cc_user_ids
    )
    # 认领人姓名（锁定展示）
    claimed_by = (
        db.query(User).filter(User.id == ticket.claimed_by_id).first()
        if ticket.claimed_by_id else None
    )

    # 并行会签进度（当前节点为会签节点时返回，前端展示已签/待签分组）
    sign_progress = None
    if current_node and current_node.get("type") == "parallel":
        all_ids = [g for g in get_node_pending_groups(current_node)]
        pending_set = set(pending_groups)
        sign_progress = {
            "policy": current_node.get("finish_policy") or "all",
            "signed": [
                {"id": g, "name": group_names.get(g, f"分组{g}")}
                for g in all_ids if g not in pending_set
            ],
            "pending": [
                {"id": g, "name": group_names.get(g, f"分组{g}")}
                for g in all_ids if g in pending_set
            ],
        }

    data = _ticket_list_item(ticket, group_names)
    data.update({
        "flow_snapshot": snapshot,
        "records": [r.to_dict() for r in records],
        # 自动研判结果随详情返回（列表已剔除）：资产匹配 + 威胁情报
        "enrichment_data": ticket.enrichment_data,
        "group_names": {str(k): v for k, v in group_names.items()},
        "current_node": current_node,
        "can_handle": can_handle,
        # 认领：未锁定且具备基础处理权时可认领（先到先得；并行会签节点不支持认领）
        "can_claim": bool(
            base_can_handle and ticket.claimed_by_id is None
            and (current_node or {}).get("type") != "parallel"
        ),
        "claimed_by_name": (claimed_by.display_name or claimed_by.username) if claimed_by else None,
        "can_urge": can_urge,
        "can_comment": can_comment,
        "can_cancel": (
            ticket.status == "processing"
            and (admin or ticket.created_by_id == current_user.id)
        ),
        # 并行会签进度（非会签节点为 null）
        "sign_progress": sign_progress,
        # 抄送：列表 + 管理权限（发起人 / 当前处理人 / admin；仅进行中可增减）
        "cc_targets": [r.to_dict() for r in _cc_rows(db, ticket.id)],
        "can_manage_cc": (
            ticket.status == "processing"
            and (admin or ticket.created_by_id == current_user.id or can_handle)
        ),
    })
    return data


# ============ 发起可用流程 ============

@router.get("/flows/options")
def flow_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """发起工单可选的流程模板列表（已发布且启用），含首节点表单定义与发起权限标记。"""
    flows = (
        db.query(TicketFlow)
        .filter(TicketFlow.enabled.is_(True), TicketFlow.is_draft.is_(False))
        .order_by(TicketFlow.id.desc())
        .all()
    )
    my_groups = set(_my_group_ids(db, current_user.id))
    admin = is_admin(current_user, db)
    items = []
    for f in flows:
        nodes = f.nodes if isinstance(f.nodes, dict) else {}
        start_groups = set(nodes.get("start_groups") or [])
        start_node = get_start_node(nodes)
        if not start_node:
            continue
        items.append({
            "id": f.id,
            "name": f.name,
            "description": f.description,
            "version": f.version,
            "node_count": len(nodes.get("nodes") or []),
            "start_groups": sorted(start_groups),
            "cc_targets": _normalize_cc_targets(nodes.get("cc_targets")),
            "first_node": {
                "key": start_node.get("key"),
                "name": start_node.get("name"),
                "fields": start_node.get("fields") or [],
                "routes": start_node.get("routes") or [],
            },
            "can_initiate": admin or bool(start_groups & my_groups),
        })
    return {"items": items}


@router.get("/cc-options")
def ticket_cc_options(
    db: Session = Depends(get_db),
) -> dict:
    """抄送候选数据源：启用用户 + 启用工单分组（精简字段，ticket:view 即可调用）。

    发起/追加抄送弹窗的人员与分组选项来自本接口，避免依赖 user:view
    / ticket_config:view 导致普通工单用户「权限不足」无法选择抄送对象。
    """
    users = (
        db.query(User.id, User.display_name, User.username, User.is_active)
        .order_by(User.id.asc())
        .all()
    )
    groups = db.query(TicketGroup).order_by(TicketGroup.id.asc()).all()
    return {
        "users": [
            {
                "id": u.id,
                "display_name": u.display_name,
                "username": u.username,
                "is_active": bool(u.is_active),
            }
            for u in users
        ],
        "groups": [
            {"id": g.id, "name": g.name, "enabled": bool(g.enabled)}
            for g in groups
        ],
    }


# ============ 发起 ============

@router.post("", status_code=201)
def create_ticket(
    body: TicketCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """发起工单。

    - 仅流程模板「可发起分组」成员（或 admin）可发起
    - field_values 按首节点字段定义校验（必填/类型/枚举，拒绝未定义字段）
    - 发起时对流程模板做快照，后续模板修改不影响本工单
    - 关联告警（一键发起）写入 related_alert_id / related_alert_uuid
    """
    flow = db.query(TicketFlow).filter(TicketFlow.id == body.flow_id).first()
    if flow is None:
        raise HTTPException(status_code=404, detail="流程模板不存在")
    if not flow.enabled or flow.is_draft:
        raise HTTPException(status_code=400, detail="流程模板未发布或已停用，不能发起工单")

    nodes_json = flow.nodes if isinstance(flow.nodes, dict) else {}
    start_node = get_start_node(nodes_json)
    if not start_node:
        raise HTTPException(status_code=400, detail="流程模板缺少处理节点")

    # 发起权限：admin 或属于发起分组
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    start_groups = set(nodes_json.get("start_groups") or [])
    if not admin and not (start_groups & my_groups):
        raise HTTPException(status_code=403, detail="您不属于该流程的可发起分组")

    # 字段校验（先剔除未命中匹配规则的扩展字段值，再校验必填/类型/枚举；
    # 引用联动字段选项 = 本工单已提交值 + 本次提交值）
    values = strip_hidden_field_values(
        start_node.get("fields") or [], _clean_field_values(body.field_values)
    )
    ref_opts = collect_ref_options(nodes_json, [{"field_values": values}])
    errors = validate_field_values(start_node.get("fields") or [], values, ref_options=ref_opts)
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))

    # 路由解析
    start_label = start_node.get("name") or start_node.get("key")
    route_to = _resolve_route(start_node.get("routes") or [], values, body.route_to, start_label)
    target = get_node(nodes_json, route_to)
    if target is None:
        raise HTTPException(status_code=400, detail=f"流转目标节点 {route_to} 不存在")

    # 快照
    snapshot = {
        "flow_id": flow.id,
        "flow_name": flow.name,
        "version": flow.version,
        "start_groups": list(start_groups),
        "nodes": nodes_json.get("nodes") or [],
    }

    end = is_end_node(target)
    # 自动研判：对 src_ip/dst_ip 做资产匹配 + 威胁情报查询 + 智能体研判
    #（按字段开关，失败不阻塞发起）
    try:
        enrichment = build_ticket_enrichment(
            db, start_node.get("fields") or [], values, title=body.title
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单自动研判失败（忽略，不阻塞发起）: %s", exc)
        enrichment = None
    ticket = Ticket(
        ticket_no=_gen_ticket_no(db),
        title=sanitize_text(body.title).strip(),
        flow_id=flow.id,
        flow_name=flow.name,
        flow_snapshot=snapshot,
        status="completed" if end else "processing",
        current_node_key=route_to,
        current_node_name=target.get("name") or route_to,
        created_by_id=current_user.id,
        created_by_name=current_user.display_name or current_user.username,
        priority=body.priority,
        related_alert_id=body.related_alert_id,
        related_alert_uuid=body.related_alert_uuid,
        closed_at=beijing_now() if end else None,
        # 节点停留计时起点（超时提醒按 arrived_at 计算停留时长）
        arrived_at=None if end else beijing_now(),
        # 发起时自动研判结果（资产匹配 + 威胁情报），随工单流转只读展示
        enrichment_data=enrichment,
    )
    # 到达目标节点：初始化待处理分组（并行会签=全部会签组）
    if not end:
        _set_current_groups(ticket, target)
    db.add(ticket)
    db.flush()
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=start_node.get("key") or "",
        node_name=start_node.get("name") or "",
        group_id=start_node.get("group_id"),
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="create",
        field_values=values,
        route_to=route_to,
        comment=sanitize_text(body.comment) if body.comment else None,
    ))
    # 抄送：模板固定抄送（发起时快照）+ 请求手动追加，去重后落库
    tpl_cc = _fill_cc_names(db, _normalize_cc_targets(nodes_json.get("cc_targets")))
    manual_cc = _fill_cc_names(db, _normalize_cc_targets(
        [t.model_dump() for t in body.cc_targets]
    ))
    seen_keys = set()
    cc_rows_added = []
    operator_name = current_user.display_name or current_user.username
    for t in tpl_cc + manual_cc:
        key = (t["type"], t["id"])
        if key in seen_keys:
            continue
        seen_keys.add(key)
        row = TicketCc(
            ticket_id=ticket.id,
            target_type=t["type"],
            target_id=t["id"],
            target_name=t["name"],
            source="manual" if t in manual_cc and t not in tpl_cc else "template",
            created_by_id=current_user.id,
            created_by_name=operator_name,
        )
        db.add(row)
        cc_rows_added.append(row)
    db.flush()
    # 抄送通知：发起即完结（直通 end）时直接发完结通知；否则发抄送知会
    _notify_cc_added(db, ticket, cc_rows_added, current_user, finished=end)
    if not end:
        _notify_next_group(db, ticket, target.get("name") or route_to, sorted(_csv_group_ids(ticket)))
    db.commit()
    db.refresh(ticket)
    # 智能体研判后台异步执行（LLM 耗时较长，不阻塞发起；完成后回写 enrichment_data）
    if isinstance(enrichment, dict):
        pending = [
            (s.get("role"), s.get("label"), s.get("ip"))
            for s in enrichment.get("sources") or []
            if isinstance(s.get("agent"), dict) and s["agent"].get("pending")
        ]
        if pending:
            start_agent_analysis_bg(ticket.id, pending, body.title)
    write_audit(
        db, action="ticket_create", resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no, "flow": flow.name,
            "route_to": route_to, "related_alert_id": body.related_alert_id,
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("发起工单: id=%s no=%s flow=%s, operator=%s",
                ticket.id, ticket.ticket_no, flow.name, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 列表 ============

@router.get("")
def list_tickets(
    view: str = Query(default="my_pending", pattern="^(my_pending|created|handled|cc|all)$"),
    status: str | None = Query(default=None, pattern="^(processing|completed|cancelled)$"),
    flow_id: int | None = Query(default=None),
    priority: str | None = Query(default=None, pattern="^(low|medium|high|critical)$"),
    archived: str = Query(default="exclude", pattern="^(exclude|only|include)$"),
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """工单列表：待我处理 / 我发起 / 我处理过 / 全部 + 状态/流程/优先级/关键词筛选。

    ``archived``：exclude=不含归档（默认）/ only=仅归档 / include=全部。
    每项附 ``sla_text``/``sla_overdue``（处理中工单的 SLA 倒计时，超时标记）
    与 ``can_urge``（发起人/抄送人/admin 可催办）。
    """
    query = _apply_ticket_filters(db, current_user, view, status, flow_id, priority, archived, q)
    if query is None:  # my_pending 且不在任何分组
        return {"items": [], "total": 0, "page": page, "size": size, "pages": 0}

    query = query.order_by(Ticket.id.desc())
    total = query.count()
    tickets = query.offset((page - 1) * size).limit(size).all()
    # 分组名映射：含并行会签 CSV 内的全部待处理分组
    list_group_ids: set[int] = {t.current_group_id for t in tickets if t.current_group_id}
    for t in tickets:
        list_group_ids |= _csv_group_ids(t)
    group_names = _group_name_map(db, list_group_ids)

    # SLA 倒计时：批量取本页工单的节点记录（create/submit 时间）
    now = beijing_now()
    sla_config = get_sla_config(db)
    page_ids = [t.id for t in tickets]
    rec_map: dict[int, list] = {}
    if page_ids:
        for r in (
            db.query(TicketNodeRecord)
            .filter(TicketNodeRecord.ticket_id.in_(page_ids))
            .order_by(TicketNodeRecord.id.asc())
            .all()
        ):
            rec_map.setdefault(r.ticket_id, []).append(r)
    # 催办权限：admin / 发起人直判，其余查本页抄送关系（一次查询）
    admin = is_admin(current_user, db)
    cc_ids = set() if admin else _cc_ticket_ids_for_user(db, current_user, page_ids)

    items = []
    for t in tickets:
        item = _ticket_list_item(t, group_names)
        if t.status == "processing":
            remaining, overdue, has_target = _sla_remaining(t, rec_map.get(t.id, []), now, sla_config)
            if remaining is not None:
                item["sla_text"] = ("超时 " if overdue else "剩余 ") + _fmt_duration(remaining)
                item["sla_overdue"] = overdue
            elif has_target:
                item["sla_text"] = None
                item["sla_overdue"] = False
        item["can_urge"] = bool(
            t.status == "processing"
            and (admin or t.created_by_id == current_user.id or t.id in cc_ids)
        )
        items.append(item)
    return {
        "items": items,
        "total": total,
        "page": page,
        "size": size,
        "pages": (total + size - 1) // size if total > 0 else 0,
    }


# ============ 监控大屏聚合 ============

@router.get("/monitor")
def ticket_monitor_stats(
    flow_id: int | None = Query(default=None, description="指定流程模板 ID；缺省时自动选取进行中工单最多的流程"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_monitor", "view")),
):
    """工单监控大屏聚合数据（KPI / 趋势 / 分布 / 来源平台统计 / SLA / 流转节点 / 最新工单）。

    数据均来自真实工单（排除归档），按大屏七个分区一次返回，前端 60s 轮询。
    需要独立权限 ticket_monitor:view（叠加 router 级 ticket:view）。
    处置状态流转：``flow_id`` 可指定展示的流程模板；节点序列始终读取模板**当前定义**，
    修改并重新发布模板后大屏在下次轮询自动更新。响应附 ``flows``（可选流程列表）与
    ``flow``（当前生效流程及是否自动选取）。
    注意：本路由必须注册在 ``GET /{ticket_id}`` 之前，避免 "monitor" 被路径参数吞掉。
    """
    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    tickets = [t for t in db.query(Ticket).all() if not t.archived]
    records = (
        db.query(TicketNodeRecord)
        .order_by(TicketNodeRecord.ticket_id, TicketNodeRecord.created_at)
        .all()
    )
    by_ticket: dict[int, list] = {}
    first_record: dict[int, TicketNodeRecord] = {}
    for r in records:
        by_ticket.setdefault(r.ticket_id, []).append(r)
        if r.action == "create" and r.ticket_id not in first_record:
            first_record[r.ticket_id] = r

    processing = [t for t in tickets if t.status == "processing"]
    completed = [t for t in tickets if t.status == "completed"]
    cancelled = [t for t in tickets if t.status == "cancelled"]
    finished = [t for t in tickets if t.closed_at is not None]

    # —— SLA 目标口径评估（按优先级目标：响应=发起→首次提交，解决=创建→关闭）——
    sla_config = get_sla_config(db)
    sla_eval: dict[int, dict] = {
        t.id: evaluate_ticket_sla(t, by_ticket.get(t.id, []), now, sla_config)
        for t in tickets
    }

    # —— KPI：今日活跃（处理中）= 今日有提交流转且仍在进行中 ——
    today_submit_ids = {
        r.ticket_id
        for r in records
        if r.action == "submit" and r.created_at and r.created_at >= today_start
    }
    active_now = [t for t in processing if t.id in today_submit_ids]
    timeout_warn = [t for t in processing if sla_eval[t.id]["timeout"]]
    kpi = {
        "total": len(tickets),
        "today_new": sum(1 for t in tickets if t.created_at and t.created_at >= today_start),
        "today_closed": sum(1 for t in finished if t.closed_at >= today_start),
        "pending": len(processing),
        "processing_active": len(active_now),
        "completed": len(completed),
        "cancelled": len(cancelled),
        "timeout_warning": len(timeout_warn),
    }

    # —— 趋势：24h 按小时 / 7 天、30 天按天（新增 vs 关闭）——
    def _trend_by_hour(n_hours: int) -> list[dict]:
        cur = now.replace(minute=0, second=0, microsecond=0)
        starts = [cur - timedelta(hours=i) for i in range(n_hours - 1, -1, -1)]
        return [
            {
                "label": s.strftime("%H:%M"),
                "new": sum(1 for t in tickets if t.created_at and s <= t.created_at < s + timedelta(hours=1)),
                "closed": sum(1 for t in finished if s <= t.closed_at < s + timedelta(hours=1)),
            }
            for s in starts
        ]

    def _trend_by_day(n_days: int) -> list[dict]:
        starts = [today_start - timedelta(days=i) for i in range(n_days - 1, -1, -1)]
        return [
            {
                "label": s.strftime("%m-%d"),
                "new": sum(1 for t in tickets if t.created_at and s <= t.created_at < s + timedelta(days=1)),
                "closed": sum(1 for t in finished if s <= t.closed_at < s + timedelta(days=1)),
            }
            for s in starts
        ]

    trend = {"hours24": _trend_by_hour(24), "days7": _trend_by_day(7), "days30": _trend_by_day(30)}

    # —— 分布：优先级 / 来源平台 / 事件类型 + 严重度×状态堆叠 ——
    def _count_by(items, key_fn):
        m: dict = {}
        for it in items:
            k = key_fn(it)
            if k:
                m[k] = m.get(k, 0) + 1
        return [{"name": k, "value": v} for k, v in sorted(m.items(), key=lambda x: -x[1])]

    def _field_of(t, key):
        rec = first_record.get(t.id)
        return (rec.field_values or {}).get(key) if rec else None

    priority_dist = _count_by(tickets, lambda t: t.priority)
    type_dist = _count_by(tickets, lambda t: _field_of(t, "alert_type"))

    # —— 来源平台统计：工单总量 / 今日新增 / 待处理 / 处理中(今日活跃) / 已解决（口径与顶部 KPI 一致）——
    platform_rows: dict[str, dict] = {}
    for t in tickets:
        platform = _field_of(t, "alert_platform")
        if not platform:
            continue
        row = platform_rows.setdefault(platform, {
            "name": platform,
            "total": 0,
            "today_new": 0,
            "pending": 0,
            "processing_active": 0,
            "completed": 0,
        })
        row["total"] += 1
        if t.created_at and t.created_at >= today_start:
            row["today_new"] += 1
        if t.status == "processing":
            row["pending"] += 1
            if t.id in today_submit_ids:
                row["processing_active"] += 1
        elif t.status == "completed":
            row["completed"] += 1
    platform_stats = sorted(platform_rows.values(), key=lambda r: -r["total"])
    severity_status = []
    for p in ("critical", "high", "medium", "low"):
        row = {"name": PRIORITY_LABELS.get(p, p), "processing": 0, "completed": 0, "cancelled": 0}
        for t in tickets:
            if t.priority == p:
                row[t.status] = row.get(t.status, 0) + 1
        severity_status.append(row)

    # —— SLA：按优先级目标统计（平均响应/解决 + 达标率/超时率 + 细分计数 + 目标值） ——
    in_scope = [t for t in tickets if sla_eval[t.id]["has_target"]]
    resp_minutes = [sla_eval[t.id]["response_minutes"] for t in in_scope if sla_eval[t.id]["response_minutes"] is not None]
    resolve_minutes = [sla_eval[t.id]["resolve_minutes"] for t in in_scope if sla_eval[t.id]["resolve_minutes"] is not None]
    sla_timeout = [t for t in in_scope if sla_eval[t.id]["timeout"]]

    def _avg(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    completed_in_scope = [t for t in in_scope if t.status == "completed"]
    on_time = [t for t in completed_in_scope if not sla_eval[t.id]["timeout"]]
    sla = {
        "avg_response_minutes": _avg(resp_minutes),
        "avg_resolve_minutes": _avg(resolve_minutes),
        # 超时率 = SLA 超时工单 / 纳入目标统计的工单
        "timeout_rate": round(len(sla_timeout) / len(in_scope) * 100, 1) if in_scope else 0,
        # 达标率 = 已完结工单中未超目标的占比
        "on_time_rate": round(len(on_time) / len(completed_in_scope) * 100, 1) if completed_in_scope else None,
        "responded_count": len(resp_minutes),
        "resolved_count": len(resolve_minutes),
        "timeout_count": len(sla_timeout),
        "response_overdue_count": sum(1 for t in in_scope if sla_eval[t.id]["response_breach"]),
        "resolve_overdue_count": sum(1 for t in in_scope if sla_eval[t.id]["resolve_breach"]),
        "in_scope_count": len(in_scope),
        "targets": sla_config,
    }

    # 分组名映射（用于流转节点显示处理分组）
    group_map = {g.id: g.name for g in db.query(TicketGroup).all()}

    # —— 处置状态流转：可指定流程（?flow_id=）或自动选取（进行中工单最多 / 最新）——
    # 节点序列始终读取流程模板当前定义（而非工单发起时的旧快照），模板修改重新发布后自动生效
    flow_count: dict[int, int] = {}
    for t in processing:
        flow_count[t.flow_id] = flow_count.get(t.flow_id, 0) + 1
    all_flows = db.query(TicketFlow).order_by(TicketFlow.id).all()
    flow_by_id = {f.id: f for f in all_flows}
    auto_flow_id = (
        max(flow_count, key=flow_count.get)
        if flow_count
        else (all_flows[-1].id if all_flows else None)
    )
    # 指定的流程不存在（如已删除）时回退自动选取
    selected_flow_id = flow_id if flow_id in flow_by_id else auto_flow_id
    selected_flow = flow_by_id.get(selected_flow_id)
    node_counts: dict[str, int] = {}
    for t in processing:
        if t.flow_id == selected_flow_id and t.current_node_key:
            node_counts[t.current_node_key] = node_counts.get(t.current_node_key, 0) + 1
    flow_nodes: list[dict] = []
    if selected_flow:
        for n in (selected_flow.nodes or {}).get("nodes", []):
            if n.get("type") == "end":
                continue
            flow_nodes.append({
                "key": n.get("key"),
                "name": n.get("name"),
                "group": group_map.get(n.get("group_id"), ""),
                "current": node_counts.get(n.get("key"), 0),
            })
    # 已完结计数限定所选流程，避免多流程混算
    flow_finished = sum(1 for t in finished if t.flow_id == selected_flow_id) if selected_flow_id else 0
    flow_nodes.append({
        "key": "_finished",
        "name": "已完结",
        "group": "",
        "current": flow_finished,
    })

    # —— 最新工单（中央实时列表 + 底部跑马灯）——
    latest = []
    for t in sorted(tickets, key=lambda x: x.created_at or now, reverse=True)[:20]:
        latest.append({
            "id": t.id,
            "ticket_no": t.ticket_no,
            "title": t.title,
            "priority": t.priority,
            "priority_label": PRIORITY_LABELS.get(t.priority, t.priority),
            "status": t.status,
            "status_label": STATUS_LABELS.get(t.status, t.status),
            "current_node_name": t.current_node_name or t.current_node_key,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "timeout": sla_eval[t.id]["timeout"],
            "remind_count": t.remind_count or 0,
        })

    return {
        "kpi": kpi,
        "trend": trend,
        "dist": {"priority": priority_dist, "type": type_dist},
        # 来源平台统计表：各平台 工单总量 / 今日新增 / 待处理 / 处理中(今日活跃) / 已解决
        "platform_stats": platform_stats,
        "severity_status": severity_status,
        "sla": sla,
        # 大屏流程切换器数据：全部流程模板（含草稿/停用标记）
        "flows": [
            {
                "id": f.id,
                "name": f.name,
                "is_draft": f.is_draft,
                "enabled": f.enabled,
                "version": f.version,
            }
            for f in all_flows
        ],
        # 当前生效流程（前端据此同步切换器显示；auto=是否自动选取）
        "flow": {
            "id": selected_flow_id,
            "name": selected_flow.name if selected_flow else "",
            "auto": selected_flow_id == auto_flow_id,
        },
        "flow_nodes": flow_nodes,
        "latest": latest,
        "generated_at": now.isoformat(),
    }


# ============ CSV 导出（须注册在 GET /{ticket_id} 之前，避免 "export" 被路径参数吞掉） ============

# 导出上限：防御性兜底，避免极端存量下响应过大
EXPORT_MAX_ROWS = 10000


def _snapshot_field_labels(snapshot: dict) -> dict[str, str]:
    """快照全部节点字段（含匹配规则扩展字段）key → label 映射。"""
    m: dict[str, str] = {}
    for n in snapshot.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        for f in n.get("fields") or []:
            if isinstance(f, dict) and f.get("key"):
                m[f["key"]] = f.get("label") or f["key"]
                for r in f.get("rules") or []:
                    for rf in (r.get("fields") or []):
                        if isinstance(rf, dict) and rf.get("key"):
                            m[rf["key"]] = rf.get("label") or rf["key"]
    return m


def _csv_cell_value(v) -> str:
    """字段值 → CSV 单元格文本（布尔转是/否，其余字符串化）。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "是" if v else "否"
    return str(v)


# CSV 公式注入：以 = + - @（及制表符/回车）开头的单元格在 Excel/WPS 打开时会被当公式执行
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_formula_safe(v) -> str:
    """整格文本防公式注入：危险前缀前置单引号（仅对独占单元格的文本使用，
    拼接在「【节点】label：」前缀后的字段值不会被 Excel 解释为公式，保持原样）。"""
    s = _csv_cell_value(v)
    return ("'" + s) if s[:1] in _CSV_FORMULA_PREFIXES else s


@router.get("/export")
def export_tickets(
    view: str = Query(default="all", pattern="^(my_pending|created|handled|cc|all)$"),
    status: str | None = Query(default=None, pattern="^(processing|completed|cancelled)$"),
    flow_id: int | None = Query(default=None),
    priority: str | None = Query(default=None, pattern="^(low|medium|high|critical)$"),
    archived: str = Query(default="exclude", pattern="^(exclude|only|include)$"),
    q: str | None = Query(default=None, max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """按当前筛选条件导出工单 CSV（UTF-8 BOM，Excel 可直接打开）。

    列：工单号/标题/流程/状态/优先级/发起人/当前节点/当前处理分组/发起时间/完结时间/
    处理时长分钟/SLA状态/表单字段内容（按节点·字段 label 汇总）/处置意见汇总。
    """
    query = _apply_ticket_filters(db, current_user, view, status, flow_id, priority, archived, q)
    # 筛选结果为 None（view=my_pending 且用户不属于任何分组）时导出空表，
    # 严禁回退为全量导出（越权泄露全部工单）
    tickets = (
        query.order_by(Ticket.id.desc()).limit(EXPORT_MAX_ROWS).all()
        if query is not None
        else []
    )

    now = beijing_now()
    sla_config = get_sla_config(db)
    group_names = _group_name_map(db, {t.current_group_id for t in tickets if t.current_group_id})
    # 批量取节点记录（字段值/处置意见/SLA 倒计时）
    rec_map: dict[int, list] = {}
    if tickets:
        for r in (
            db.query(TicketNodeRecord)
            .filter(TicketNodeRecord.ticket_id.in_([t.id for t in tickets]))
            .order_by(TicketNodeRecord.id.asc())
            .all()
        ):
            rec_map.setdefault(r.ticket_id, []).append(r)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "工单号", "标题", "流程模板", "状态", "优先级", "发起人", "当前节点", "当前处理分组",
        "发起时间", "完结时间", "处理时长(分钟)", "SLA状态", "表单字段内容", "处置意见汇总",
    ])
    for t in tickets:
        records = rec_map.get(t.id, [])
        # 处理时长：完结=创建→关闭；进行中=创建→现在
        duration = ""
        if t.created_at:
            end_at = t.closed_at or now
            duration = str(int((end_at - t.created_at).total_seconds() // 60))
        # SLA 状态：进行中显示倒计时，完结显示实际是否超时
        sla_text = ""
        if t.status == "processing":
            remaining, overdue, _ = _sla_remaining(t, records, now, sla_config)
            if remaining is not None:
                sla_text = ("超时 " if overdue else "剩余 ") + _fmt_duration(remaining)
        else:
            sla_text = "超时" if evaluate_ticket_sla(t, records, now, sla_config)["timeout"] else "达标"
        # 表单字段内容：按节点汇总 "【节点】label：value"
        label_map = _snapshot_field_labels(t.flow_snapshot if isinstance(t.flow_snapshot, dict) else {})
        fields_parts = []
        comment_parts = []
        for r in records:
            if r.action in ("create", "submit") and r.field_values:
                seg = "；".join(
                    f"{label_map.get(k, k)}：{_csv_cell_value(v)}"
                    for k, v in r.field_values.items()
                )
                fields_parts.append(f"【{r.node_name or r.node_key}】{seg}")
            if r.action == "submit" and r.comment:
                comment_parts.append(f"【{r.node_name or r.node_key}·{r.handler_name}】{r.comment}")
        writer.writerow([
            t.ticket_no,
            _csv_formula_safe(t.title),
            _csv_formula_safe(t.flow_name),
            STATUS_LABELS.get(t.status, t.status),
            PRIORITY_LABELS.get(t.priority, t.priority),
            _csv_formula_safe(t.created_by_name),
            _csv_formula_safe(t.current_node_name) if t.status == "processing" else "",
            _csv_formula_safe(group_names.get(t.current_group_id, "")) if t.status == "processing" else "",
            t.created_at.strftime("%Y-%m-%d %H:%M:%S") if t.created_at else "",
            t.closed_at.strftime("%Y-%m-%d %H:%M:%S") if t.closed_at else "",
            duration,
            sla_text,
            " ".join(fields_parts),
            " ".join(comment_parts),
        ])

    filename = f"工单导出_{now.strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


# ============ 相似工单推荐（发起时按首节点 源/目的 IP 匹配） ============

def _ip_field_role(field: dict) -> str:
    """IP 字段角色：src=源 / dst=目的 / other=其它。

    与发起时自动研判（ticket_enrichment）同口径：字段 key 或 alert_field_mapping
    为 src_ip / dst_ip 优先；兜底按显示名判断（含「目的/目标」→ 目的，含「源」→ 源）。
    """
    key = str(field.get("key") or "")
    mapping = str(field.get("alert_field_mapping") or "")
    if key == "src_ip" or mapping == "src_ip":
        return "src"
    if key == "dst_ip" or mapping == "dst_ip":
        return "dst"
    label = str(field.get("label") or "")
    if "目的" in label or "目标" in label:
        return "dst"
    if "源" in label:
        return "src"
    return "other"


def _first_ip(value) -> str | None:
    """字段值 → 首个有效 IP（支持逗号/分号分隔多值；无效返回 None）。

    与自动研判的 IP 提取口径一致：多值取首个有效地址参与比对。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    for part in s.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ipaddress.ip_address(part)
            return part
        except ValueError:
            continue
    return None


@router.post("/similar")
def similar_tickets(
    body: TicketSimilar,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """相似工单推荐：按首节点 源/目的 IP 匹配同流程历史工单（发起时右侧滑出展示）。

    候选为同流程「处置中 + 已完成」的未归档工单（已取消不参与）。
    匹配优先级（IP 地址类型字段参与，取首个有效 IP 比对）：
    1. 源 IP + 目的 IP 均相同 → 相似度最高（match_level=3）；
    2. 仅源 IP 相同 → 次之（match_level=2）；
    3. 仅目的 IP 相同 → 再次（match_level=1，其余 ip 字段命中同此级）；
    4. 源与目的均不相同 → 不返回（不展示相似工单）。

    源/目的角色识别见 ``_ip_field_role``（key / alert_field_mapping 为
    src_ip / dst_ip 优先，兜底显示名）。返回 {items: [...]}，每条含工单
    信息（编号/标题/状态/优先级/发起人/发起与完结时间）、命中等级
    （match_level / match_label）、命中 IP 明细（matched）与处置意见摘要
    （summary，200 字截断，仅完结工单有）。
    """
    flow = db.query(TicketFlow).filter(TicketFlow.id == body.flow_id).first()
    if flow is None:
        raise HTTPException(status_code=404, detail="流程模板不存在")
    nodes_json = flow.nodes if isinstance(flow.nodes, dict) else {}
    start_node = get_start_node(nodes_json)
    if not start_node:
        return {"items": []}

    # 首节点 ip 字段 → (role, key, label, 当前已填的有效 IP)；未填有效 IP 不参与匹配
    values = body.field_values or {}
    probes: list[tuple[str, str, str, str]] = []
    for f in start_node.get("fields") or []:
        if not isinstance(f, dict) or f.get("type") != "ip" or not f.get("key"):
            continue
        ip = _first_ip(values.get(f["key"]))
        if not ip:
            continue
        probes.append((
            _ip_field_role(f),
            str(f["key"]),
            str(f.get("label") or f["key"]),
            ip,
        ))
    if not probes:
        return {"items": []}

    # 候选：同流程「处置中 + 已完成」且未归档的历史工单（已取消不参与）；
    # 最近活跃倒序取 1000 条，保证源+目的均相同的工单尽量不被挤出候选集
    candidates = (
        db.query(
            Ticket.id, Ticket.ticket_no, Ticket.title, Ticket.priority,
            Ticket.status, Ticket.created_by_name, Ticket.created_at,
            Ticket.closed_at, Ticket.updated_at,
        )
        .filter(
            Ticket.flow_id == flow.id,
            Ticket.status.in_(["processing", "completed"]),
            Ticket.archived.is_(False),
        )
        .order_by(Ticket.updated_at.desc())
        .limit(1000)
        .all()
    )
    create_values: dict[int, dict] = {}
    if candidates:
        for r in (
            db.query(TicketNodeRecord)
            .filter(
                TicketNodeRecord.ticket_id.in_([t.id for t in candidates]),
                TicketNodeRecord.action == "create",
            )
            .order_by(TicketNodeRecord.id.asc())
            .all()
        ):
            create_values.setdefault(r.ticket_id, r.field_values or {})

    # 评分：源命中 +2、目的命中 +1（其余 ip 字段命中 +1）；
    # 等级 3=源+目的 / 2=仅源 / 1=仅目的或其它，均未命中则排除
    now = beijing_now()
    scored: list[tuple[int, str, float, object, list[dict]]] = []
    for t in candidates:
        fv = create_values.get(t.id) or {}
        src_hit = dst_hit = other_hit = False
        matched: list[dict] = []
        for role, key, label, ip in probes:
            hip = _first_ip(fv.get(key))
            if hip is not None and hip == ip:
                matched.append({"label": label, "value": ip})
                if role == "src":
                    src_hit = True
                elif role == "dst":
                    dst_hit = True
                else:
                    other_hit = True
        if src_hit and dst_hit:
            level, level_label = 3, "源+目的IP均相同"
        elif src_hit:
            level, level_label = 2, "源IP相同"
        elif dst_hit:
            level, level_label = 1, "目的IP相同"
        elif other_hit:
            level, level_label = 1, "IP相同"
        else:
            continue
        closed_ts = (t.closed_at or t.updated_at or t.created_at or now).timestamp()
        scored.append((level, level_label, closed_ts, t, matched))
    scored.sort(key=lambda x: (-x[0], -x[2]))

    # 处置意见摘要：最后一条带 comment 的 submit 记录
    top = scored[:5]
    summaries: dict[int, str] = {}
    if top:
        for r in (
            db.query(TicketNodeRecord)
            .filter(TicketNodeRecord.ticket_id.in_([x[3].id for x in top]), TicketNodeRecord.action == "submit")
            .order_by(TicketNodeRecord.id.asc())
            .all()
        ):
            if r.comment:
                summaries[r.ticket_id] = r.comment
    items = []
    for level, level_label, _, t, matched in top:
        items.append({
            "id": t.id,
            "ticket_no": t.ticket_no,
            "title": t.title,
            "priority": t.priority,
            "status": t.status,
            "created_by_name": t.created_by_name,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "closed_at": t.closed_at.isoformat() if t.closed_at else None,
            "match_level": level,
            "match_label": level_label,
            "matched": matched,
            "summary": (summaries.get(t.id) or "").strip()[:200],
        })
    return {"items": items}


# ============ 封禁状态查询 ============

# 封禁来源/等级中文（与工作台展示一致）
_BAN_SOURCE_LABELS = {
    "auto": "自动封禁", "approval": "审批封禁", "manual": "手动封禁",
    "chat": "聊天封禁", "ticket": "工单同步",
}
_BAN_LEVEL_LABELS = {"low": "低", "medium": "中", "high": "高", "serious": "严重", "critical": "严重"}


@router.get("/ban-status")
def get_ban_status(
    ips: str = Query(..., description="逗号分隔的 IP 列表，最多 20 个"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """批量查询 IP 是否处于封禁期间（安全上下文封禁查询）。

    同时检查工作台封禁记录（ban_records，含工单同步）与旧版已封禁列表
    （banned_ips），返回每个 IP 的全部生效中封禁详情；未封禁则 banned=false。
    """
    ip_list = list(dict.fromkeys(x.strip() for x in ips.split(",") if x.strip()))
    if not ip_list:
        raise HTTPException(status_code=400, detail="请提供至少一个 IP 地址")
    if len(ip_list) > 20:
        raise HTTPException(status_code=400, detail="单次最多查询 20 个 IP")
    now = beijing_now()
    result: dict[str, dict] = {ip: {"banned": False, "items": []} for ip in ip_list}

    # 工作台封禁记录（永久封禁 expire_time 为空，视为生效中）
    for r in (
        db.query(BanRecord)
        .filter(BanRecord.ip.in_(ip_list), BanRecord.status == "active")
        .all()
    ):
        if not r.is_permanent and (r.expire_time is None or r.expire_time <= now):
            continue
        result[r.ip]["banned"] = True
        result[r.ip]["items"].append({
            "source": r.ban_source,
            "source_label": _BAN_SOURCE_LABELS.get(r.ban_source or "", r.ban_source or "未知"),
            "ban_level": r.ban_level,
            "ban_level_label": _BAN_LEVEL_LABELS.get(r.ban_level or "", r.ban_level or "-"),
            "started_at": r.created_at.isoformat() if r.created_at else None,
            "expire_time": r.expire_time.isoformat() if r.expire_time else None,
            "is_permanent": bool(r.is_permanent),
            "remaining_ms": int((r.expire_time - now).total_seconds() * 1000)
            if (r.expire_time and not r.is_permanent) else None,
            "reason": r.reason or "",
            "ban_device": r.ban_device,
            "ticket_id": r.ticket_id,
            "ticket_no": r.ticket_no,
        })

    # 旧版 banned_ips（补充历史手动/智能体封禁，防遗漏）
    for b in (
        db.query(BannedIP)
        .filter(BannedIP.ip.in_(ip_list), BannedIP.status == "active")
        .all()
    ):
        if b.expired_at and b.expired_at <= now:
            continue
        result[b.ip]["banned"] = True
        result[b.ip]["items"].append({
            "source": b.source,
            "source_label": "手动封禁" if b.source == "manual" else "旧版封禁记录",
            "ban_level": b.ban_level,
            "ban_level_label": _BAN_LEVEL_LABELS.get(b.ban_level or "", b.ban_level or "-"),
            "started_at": b.created_at.isoformat() if b.created_at else None,
            "expire_time": b.expired_at.isoformat() if b.expired_at else None,
            "is_permanent": False,
            "remaining_ms": int((b.expired_at - now).total_seconds() * 1000) if b.expired_at else None,
            "reason": b.reason or "",
            "ban_device": b.device_name or None,
            "ticket_id": None,
            "ticket_no": None,
        })
    return result


# ============ 详情 ============

@router.get("/{ticket_id}")
def get_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """工单详情：处理时间线 + 当前节点操作表单 + 权限上下文。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    return _ticket_detail(db, ticket, current_user)


# ============ 封禁同步 ============

def _sync_ban_from_ticket(db: Session, ticket: Ticket, node: dict, values: dict, user: User) -> None:
    """封禁同步动作：节点配置 ban_sync 且开关字段命中时写入工作台已封禁 IP 列表。

    - 仅写 BanRecord（ban_source=ticket 工单同步），不同步 legacy banned_ips
    - 按 (ticket_id, ticket_node) 去重，回退后重新提交不会重复产生封禁记录
    - 时长字段用 parse_duration 解析（"永久" 或 "30天"/"12小时"/"45分钟"）
    """
    cfg = node.get("ban_sync") if isinstance(node, dict) else None
    if not isinstance(cfg, dict) or not cfg:
        return
    sv = values.get(cfg.get("switch_field"))
    if isinstance(sv, bool):
        sv = "是" if sv else "否"
    if str(sv if sv is not None else "") != str(cfg.get("switch_value") or "是"):
        return
    raw_ip = values.get(cfg.get("ip_field"))
    # 非字符串值（如多值控件传入的列表）先归一化，防止 str() 后写入脏数据
    if isinstance(raw_ip, (list, tuple)):
        raw_ip = next((x for x in raw_ip if str(x or "").strip()), None)
    ip = str(raw_ip or "").strip()
    duration_raw = values.get(cfg.get("duration_field"))
    device = str(values.get(cfg.get("device_field")) or "").strip() if cfg.get("device_field") else ""
    if not ip or duration_raw in (None, ""):
        logger.warning("封禁同步跳过（IP/时长未填）: ticket=%s node=%s", ticket.ticket_no, node.get("key"))
        return
    permanent, seconds = parse_duration(duration_raw)
    if not permanent and seconds < 0:
        logger.warning("封禁同步跳过（时长格式非法: %r）: ticket=%s", duration_raw, ticket.ticket_no)
        return
    dup = (
        db.query(BanRecord)
        .filter(BanRecord.ticket_id == ticket.id, BanRecord.ticket_node == str(node.get("key") or ""))
        .first()
    )
    if dup is not None:
        return
    now = beijing_now()
    record = BanRecord(
        ip=ip,
        ban_level="medium",
        ban_duration=0 if permanent else seconds,
        is_permanent=permanent,
        expire_time=None if permanent else now + timedelta(seconds=seconds),
        reason=f"工单同步：{ticket.title}",
        ban_source="ticket",
        status="active",
        ticket_id=ticket.id,
        ticket_no=ticket.ticket_no,
        ticket_node=str(node.get("key") or ""),
        ban_device=device or None,
    )
    db.add(record)
    logger.info(
        "封禁同步: ticket=%s ip=%s permanent=%s duration=%ss device=%s, operator=%s",
        ticket.ticket_no, ip, permanent, 0 if permanent else seconds, device or "-", user.username,
    )


# ============ 流转 ============

@router.post("/{ticket_id}/advance")
def advance_ticket(
    ticket_id: int,
    body: TicketAdvance,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """流转工单：当前节点分组内任一成员提交即代表全组（先到先得）。

    - field_values 按当前节点字段定义校验
    - route_to 必须在当前节点路由白名单内；未提供时按条件路由自动建议
    - 并行会签节点：按 finish_policy 等待全部会签分组提交后才流转
      （all=全部完成 / any=任一即过）；中间会签提交不改变停留节点
    - 流向结束节点时工单完成
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能再流转")

    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    if not current_node:
        raise HTTPException(status_code=400, detail="当前节点定义缺失（快照损坏）")

    # 处理权限：admin / 属于当前节点任一待处理分组（并行会签）/ 认领人
    # （认领人含被改派到个人的用户，其可能不属于节点分组）
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    pending = _csv_group_ids(ticket)
    if not admin and ticket.claimed_by_id != current_user.id and not (pending & my_groups):
        raise HTTPException(
            status_code=403,
            detail="您不属于当前节点的待处理分组（或所在分组已完成会签）",
        )
    # 认领锁定：被认领后仅认领人（或 admin）可提交
    if ticket.claimed_by_id and ticket.claimed_by_id != current_user.id and not admin:
        raise HTTPException(status_code=403, detail="工单已被其他成员认领，仅认领人或管理员可提交")

    # 字段校验（先剔除未命中匹配规则的扩展字段值，再校验必填/类型/枚举；
    # 引用联动字段选项 = 本工单已提交记录值 + 本次提交值）
    values = strip_hidden_field_values(
        current_node.get("fields") or [], _clean_field_values(body.field_values)
    )
    submitted = (
        db.query(TicketNodeRecord)
        .filter(TicketNodeRecord.ticket_id == ticket.id)
        .order_by(TicketNodeRecord.id.asc())
        .all()
    )
    ref_opts = collect_ref_options(snapshot, [*submitted, {"field_values": values}])
    errors = validate_field_values(current_node.get("fields") or [], values, ref_options=ref_opts)
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))

    # —— 并行会签：未到完成条件时留在本节点，仅记录本分组会签 ——
    if current_node.get("type") == "parallel":
        # admin 提交固定视为一次签掉全部待签分组（卡签兜底语义保持一致，
        # 避免同是 admin 却因是否属待签分组而出现两种签法）
        newly_signed = set(pending) if admin else (pending & my_groups)
        remaining = pending - newly_signed
        policy = current_node.get("finish_policy") or "all"
        if remaining and policy != "any":
            total = len(get_node_pending_groups(current_node))
            done = total - len(remaining)
            db.add(TicketNodeRecord(
                ticket_id=ticket.id,
                node_key=current_node.get("key") or "",
                node_name=current_node.get("name") or "",
                group_id=min(newly_signed) if newly_signed else None,
                handler_id=current_user.id,
                handler_name=current_user.display_name or current_user.username,
                action="submit",
                field_values=values,
                route_to=None,  # 会签中间提交：不流转，等待其余分组
                comment=sanitize_text(body.comment) if body.comment else None,
            ))
            # 待处理分组去掉已签分组（current_group_id 指向下一个待签分组）
            ticket.current_group_ids = "," + ",".join(str(g) for g in sorted(remaining)) + ","
            ticket.current_group_id = min(remaining)
            _notify_sign_progress(db, ticket, current_node, sorted(remaining), done, total)
            db.commit()
            db.refresh(ticket)
            write_audit(
                db, action="ticket_advance", resource_type="ticket", resource_id=ticket.id,
                detail={"ticket_no": ticket.ticket_no, "node": current_node.get("key"),
                        "sign_off": sorted(newly_signed), "remaining": sorted(remaining)},
                operator=current_user.username, user_id=current_user.id,
            )
            logger.info("工单会签: id=%s no=%s node=%s %d/%d, operator=%s",
                        ticket.id, ticket.ticket_no, current_node.get("key"), done, total,
                        current_user.username)
            return _ticket_detail(db, ticket, current_user)

    # 路由解析（普通流转 / 会签完成后的最终流转，以最终提交人字段与去向为准）
    node_label = current_node.get("name") or current_node.get("key")
    route_to = _resolve_route(current_node.get("routes") or [], values, body.route_to, node_label)
    target = get_node(snapshot, route_to)
    if target is None:
        raise HTTPException(status_code=400, detail=f"流转目标节点 {route_to} 不存在")

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=current_node.get("key") or "",
        node_name=current_node.get("name") or "",
        group_id=current_node.get("group_id") if current_node.get("type") != "parallel" else (min(pending & my_groups) if (pending & my_groups) else None),
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="submit",
        field_values=values,
        route_to=route_to,
        comment=sanitize_text(body.comment) if body.comment else None,
    ))

    # 封禁同步动作：节点配置了 ban_sync 且命中开关条件时，写入工作台已封禁 IP 列表
    # （附加动作在独立 SAVEPOINT 中执行：任何失败——含提交阶段的约束错误如 IP 超长——
    #   仅回滚封禁记录自身，不阻塞工单流转主流程）
    try:
        with db.begin_nested():
            _sync_ban_from_ticket(db, ticket, current_node, values, current_user)
    except Exception:  # noqa: BLE001
        logger.exception("封禁同步失败（不阻塞工单流转）: ticket=%s", ticket.ticket_no)

    end = is_end_node(target)
    ticket.current_node_key = route_to
    ticket.current_node_name = target.get("name") or route_to
    # 节点停留计时重置：进入新节点重新计时，超时提醒进度清零；认领锁定随节点流转释放
    _set_current_groups(ticket, None if end else target)
    ticket.arrived_at = None if end else beijing_now()
    ticket.first_reminded_at = None
    ticket.last_reminded_at = None
    ticket.remind_count = 0
    ticket.claimed_by_id = None
    if end:
        ticket.status = "completed"
        ticket.closed_at = beijing_now()
        # 完结通知：把最终结果通知全部抄送人
        _notify_cc_finished(db, ticket, "完成")
    else:
        _notify_next_group(db, ticket, target.get("name") or route_to, sorted(_csv_group_ids(ticket)))
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_advance", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "from": current_node.get("key"), "to": route_to,
                "status": ticket.status},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单流转: id=%s no=%s %s → %s, operator=%s",
                ticket.id, ticket.ticket_no, current_node.get("key"), route_to, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 回退 ============

@router.post("/{ticket_id}/rollback")
def rollback_ticket(
    ticket_id: int,
    body: TicketRollback,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """回退工单：当前节点退回上一处理节点，必须填写回退原因。

    - 权限与流转一致：admin 或当前节点处理分组成员（先到先得）
    - 上一节点 = 最近一次把工单送入当前节点的记录（submit/create）的来源节点；
      当前节点即首处理节点时无可回退上家，返回 400
    - 回退后工单停留到上一节点重新处理，停留计时重置、超时提醒进度清零
    - 回退写入时间线（action=rollback）并精确通知上一节点分组成员（含回退原因）
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能再回退")

    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    if not current_node:
        raise HTTPException(status_code=400, detail="当前节点定义缺失（快照损坏）")

    # 处理权限：admin / 待处理分组成员 / 认领人（与流转一致）
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    pending = _csv_group_ids(ticket)
    if not admin and ticket.claimed_by_id != current_user.id and not (pending & my_groups):
        raise HTTPException(status_code=403, detail="您不属于当前节点的待处理分组，不能回退")
    # 认领锁定：被认领后仅认领人（或 admin）可回退
    if ticket.claimed_by_id and ticket.claimed_by_id != current_user.id and not admin:
        raise HTTPException(status_code=403, detail="工单已被其他成员认领，仅认领人或管理员可回退")

    # 回退原因必填（schema 已校验 min_length，此处防御性兜底）
    reason = sanitize_text(body.comment).strip()
    if not reason:
        raise HTTPException(status_code=400, detail="回退原因不能为空")

    # 回退目标：白名单模式（rollback_to）→ 仅允许退回白名单内节点；
    # 缺省 → 上一处理节点（最近一条把工单送入当前节点的 submit/create 来源）
    whitelist = current_node.get("rollback_to")
    if isinstance(whitelist, list):
        if not whitelist:
            raise HTTPException(status_code=400, detail="当前节点已配置禁止回退")
        if body.target:
            if body.target not in whitelist:
                raise HTTPException(
                    status_code=400,
                    detail=f"回退目标 {body.target} 不在当前节点的回退白名单内",
                )
            target_key = body.target
        elif len(whitelist) == 1:
            target_key = whitelist[0]
        else:
            raise HTTPException(
                status_code=400,
                detail="当前节点配置了多个可回退目标，请指定回退目标节点",
            )
        target = get_node(snapshot, target_key)
        if target is None or is_end_node(target):
            raise HTTPException(status_code=400, detail="回退目标节点定义缺失或不合法")
    else:
        # 找上一节点：最近一条把工单送入当前节点的记录（submit 流转 / create 发起）
        prev = (
            db.query(TicketNodeRecord)
            .filter(
                TicketNodeRecord.ticket_id == ticket.id,
                TicketNodeRecord.route_to == ticket.current_node_key,
                TicketNodeRecord.action.in_(("create", "submit")),
            )
            .order_by(TicketNodeRecord.id.desc())
            .first()
        )
        if not prev or not prev.node_key or prev.node_key == ticket.current_node_key:
            raise HTTPException(status_code=400, detail="当前节点为首节点，无上一步可回退")
        if body.target and body.target != prev.node_key:
            raise HTTPException(status_code=400, detail="当前节点仅支持退回上一步处理节点")
        target = get_node(snapshot, prev.node_key)
        if target is None or is_end_node(target):
            raise HTTPException(status_code=400, detail="上一节点定义缺失或不合法，不能回退")

    # 时间线记录：node=当前节点，route_to=回退目标，comment=回退原因
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=current_node.get("key") or "",
        node_name=current_node.get("name") or "",
        group_id=current_node.get("group_id") if current_node.get("type") != "parallel" else (min(pending & my_groups) if (pending & my_groups) else None),
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="rollback",
        field_values={},
        route_to=target.get("key"),
        comment=reason,
    ))

    # 工单停留回目标节点：计时重置、提醒进度清零、认领锁定释放；
    # 并行会签目标节点重新初始化全部会签分组（会签进度重置）
    ticket.current_node_key = target.get("key")
    ticket.current_node_name = target.get("name") or target.get("key")
    _set_current_groups(ticket, target)
    ticket.arrived_at = beijing_now()
    ticket.first_reminded_at = None
    ticket.last_reminded_at = None
    ticket.remind_count = 0
    ticket.claimed_by_id = None

    # 通知目标节点待处理分组成员：工单被退回，需重新处理（含回退原因）
    for gid in sorted(_csv_group_ids(ticket)):
        group = db.query(TicketGroup).filter(TicketGroup.id == gid).first()
        group_label = group.name if group else f"分组{gid}"
        user_ids = sorted({
            uid for (uid,) in db.query(TicketGroupMember.user_id)
            .filter(TicketGroupMember.group_id == gid)
            .all()
            if uid
        })
        if not user_ids:
            logger.warning("回退通知无收件人（分组无成员）: ticket=%s group=%s", ticket.id, gid)
            continue
        _notify_user_ids(
            db, ticket, user_ids,
            title=f"工单退回：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已由「{current_node.get('name') or '当前节点'}」"
                f"退回至「{target.get('name') or target.get('key')}」，"
                f"回退原因：{reason}。请【{group_label}】重新跟进处理"
            ),
        )

    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_rollback", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "from": current_node.get("key"),
                "to": target.get("key"), "reason": reason},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单回退: id=%s no=%s %s → %s, operator=%s, reason=%s",
                ticket.id, ticket.ticket_no, current_node.get("key"),
                target.get("key"), current_user.username, reason)
    return _ticket_detail(db, ticket, current_user)


# ============ 取消 ============

@router.post("/{ticket_id}/cancel")
def cancel_ticket(
    ticket_id: int,
    body: TicketCancel,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """取消工单：仅发起人或 admin，需填写取消原因。"""
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    admin = is_admin(current_user, db)
    if not admin and ticket.created_by_id != current_user.id:
        raise HTTPException(status_code=403, detail="仅发起人或管理员可取消工单")
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能取消")

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id,
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="cancel",
        field_values={},
        comment=sanitize_text(body.comment) if body.comment else None,
    ))
    ticket.status = "cancelled"
    ticket.closed_at = beijing_now()
    # 完结通知：把取消结果通知全部抄送人
    _notify_cc_finished(db, ticket, "取消", reason=body.comment)
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_cancel", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "reason": body.comment},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("取消工单: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 催办（发起人/抄送人/admin，处理中工单，30 分钟限频） ============

@router.post("/{ticket_id}/urge")
def urge_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """催办工单：发起人/抄送人/admin 一键催办处理中工单，通知当前节点分组成员。

    - 30 分钟内同一工单仅可催办一次（按最近一条催办时间线记录计算）
    - 写入时间线（action=urge）与审计，不改变工单状态
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，无需催办")

    admin = is_admin(current_user, db)
    cc_user_ids = set(_resolve_cc_user_ids(db, _cc_rows(db, ticket.id)))
    if not admin and ticket.created_by_id != current_user.id and current_user.id not in cc_user_ids:
        raise HTTPException(status_code=403, detail="仅发起人、抄送人或管理员可催办")

    now = beijing_now()
    last = (
        db.query(TicketNodeRecord)
        .filter(TicketNodeRecord.ticket_id == ticket.id, TicketNodeRecord.action == "urge")
        .order_by(TicketNodeRecord.id.desc())
        .first()
    )
    if last and last.created_at and (now - last.created_at).total_seconds() < URGE_INTERVAL_MINUTES * 60:
        waited = int((now - last.created_at).total_seconds() // 60)
        raise HTTPException(
            status_code=429,
            detail=f"催办太频繁，请 {max(URGE_INTERVAL_MINUTES - waited, 1)} 分钟后再试（30 分钟内仅可催办一次）",
        )

    operator_name = current_user.display_name or current_user.username
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id,
        handler_id=current_user.id,
        handler_name=operator_name,
        action="urge",
        field_values={},
    ))
    # 通知当前节点全部待处理分组成员（并行会签=全部待签分组；催办人自身不重复通知）
    member_ids = sorted({
        uid for gid in _csv_group_ids(ticket)
        for uid in _group_member_ids(db, gid)
        if uid != current_user.id
    })
    if member_ids:
        _notify_user_ids(
            db, ticket, member_ids,
            title=f"工单催办提醒：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已被 {operator_name} 催办，"
                f"请尽快处理（当前节点：{ticket.current_node_name or '--'}）"
            ),
        )
    else:
        logger.warning("催办通知无收件人（分组无成员）: ticket=%s groups=%s",
                       ticket.id, sorted(_csv_group_ids(ticket)))
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_urge", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "node": ticket.current_node_key},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单催办: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 转办/改派（当前节点处理人 → 其他分组或指定人） ============

@router.post("/{ticket_id}/transfer")
def transfer_ticket(
    ticket_id: int,
    body: TicketTransfer,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """转办/改派：当前节点处理人（或 admin）把工单转给其他分组或指定人处理。

    - ``group_id``：目标分组接管当前节点处理（停留计时重置、提醒进度清零、认领释放）
    - ``user_id``：指定人个人接管（认领锁定语义：仅其与 admin 可继续提交）
    - 转办原因必填，写入时间线（action=transfer）+ 审计 + 通知目标
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能转办")
    if body.group_id is None and body.user_id is None:
        raise HTTPException(status_code=400, detail="请选择转办目标（分组或人员）")
    if body.group_id is not None and body.user_id is not None:
        raise HTTPException(status_code=400, detail="转办目标只能选择分组或人员其中之一")

    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    if not current_node:
        raise HTTPException(status_code=400, detail="当前节点定义缺失（快照损坏）")

    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    pending = _csv_group_ids(ticket)
    if not admin and ticket.claimed_by_id != current_user.id and not (pending & my_groups):
        raise HTTPException(status_code=403, detail="您不属于当前节点的待处理分组，不能转办")
    if ticket.claimed_by_id and ticket.claimed_by_id != current_user.id and not admin:
        raise HTTPException(status_code=403, detail="工单已被其他成员认领，仅认领人或管理员可转办")
    # 并行会签节点：多分组同时处理，转办会破坏会签语义（卡签可由 admin 提交兜底）
    if current_node.get("type") == "parallel":
        raise HTTPException(status_code=400, detail="并行会签节点不支持转办，请等待会签完成")

    reason = sanitize_text(body.reason).strip()
    if not reason:
        raise HTTPException(status_code=400, detail="转办原因不能为空")
    operator_name = current_user.display_name or current_user.username

    if body.group_id is not None:
        group = db.query(TicketGroup).filter(TicketGroup.id == body.group_id).first()
        if group is None or not group.enabled:
            raise HTTPException(status_code=404, detail="目标分组不存在或已停用")
        if group.id in pending:
            raise HTTPException(status_code=400, detail=f"工单当前已由「{group.name}」处理，无需转办")
        target_label = f"分组「{group.name}」"
    else:
        user = db.query(User).filter(User.id == body.user_id).first()
        if user is None or not user.is_active:
            raise HTTPException(status_code=404, detail="目标人员不存在或已停用")
        if user.id == current_user.id:
            raise HTTPException(status_code=400, detail="不能转办给自己（如需锁定处理请使用认领）")
        target_label = f"人员「{user.display_name or user.username}」"

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=current_node.get("key") or "",
        node_name=current_node.get("name") or "",
        group_id=ticket.current_group_id,
        handler_id=current_user.id,
        handler_name=operator_name,
        action="transfer",
        field_values={},
        comment=f"转办至{target_label}。原因：{reason}",
    ))

    if body.group_id is not None:
        # 分组接管：停留计时重置、提醒进度清零、认领释放（待处理分组整体替换）
        ticket.current_group_id = group.id
        ticket.current_group_ids = f",{group.id},"
        ticket.claimed_by_id = None
        ticket.arrived_at = beijing_now()
        ticket.first_reminded_at = None
        ticket.last_reminded_at = None
        ticket.remind_count = 0
        member_ids = [uid for uid in _group_member_ids(db, group.id) if uid != current_user.id]
        if member_ids:
            _notify_user_ids(
                db, ticket, member_ids,
                title=f"工单转办：{ticket.ticket_no}",
                content=(
                    f"工单「{ticket.title}」已转办至您所在分组「{group.name}」"
                    f"（操作人：{operator_name}），转办原因：{reason}，请跟进处理"
                ),
            )
        else:
            logger.warning("转办通知无收件人（分组无成员）: ticket=%s group=%s", ticket.id, group.id)
    else:
        # 指定人接管：认领锁定语义
        ticket.claimed_by_id = user.id
        _notify_user_ids(
            db, ticket, [user.id],
            title=f"工单改派：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已改派给您个人处理（操作人：{operator_name}），"
                f"原因：{reason}，请尽快跟进"
            ),
        )

    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_transfer", resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no, "to_group_id": body.group_id,
            "to_user_id": body.user_id, "reason": reason,
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单转办: id=%s no=%s to=%s, operator=%s",
                ticket.id, ticket.ticket_no, target_label, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 认领（组内先到先得，认领后锁定） ============

@router.post("/{ticket_id}/claim")
def claim_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """认领工单：当前节点分组成员先到先得认领，认领后其他成员不可再提交（锁定）。

    - 认领后仅认领人（或 admin）可流转/回退/转办；流转、回退、转办到分组时自动释放
    - 写入时间线（action=claim）+ 审计；通知组内其他成员已被认领
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能认领")

    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    if not current_node:
        raise HTTPException(status_code=400, detail="当前节点定义缺失（快照损坏）")

    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    pending = _csv_group_ids(ticket)
    if not admin and not (pending & my_groups):
        raise HTTPException(status_code=403, detail="您不属于当前节点的待处理分组，不能认领")
    # 并行会签节点：多分组同时处理，单人认领会锁定其他分组，不支持认领
    if current_node.get("type") == "parallel":
        raise HTTPException(status_code=400, detail="并行会签节点不支持认领（多分组同时处理）")
    if ticket.claimed_by_id:
        if ticket.claimed_by_id == current_user.id:
            raise HTTPException(status_code=400, detail="您已认领该工单，无需重复认领")
        raise HTTPException(status_code=400, detail="该工单已被其他成员认领")

    operator_name = current_user.display_name or current_user.username
    ticket.claimed_by_id = current_user.id
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=current_node.get("key") or "",
        node_name=current_node.get("name") or "",
        group_id=current_node.get("group_id"),
        handler_id=current_user.id,
        handler_name=operator_name,
        action="claim",
        field_values={},
    ))
    # 通知当前全部待处理分组的其他成员：工单已被认领，避免重复处理
    # （用待处理分组全集而非节点配置分组——转办后节点配置分组已非实际处理方）
    member_ids = sorted({
        uid for gid in _csv_group_ids(ticket)
        for uid in _group_member_ids(db, gid)
        if uid != current_user.id
    })
    if member_ids:
        _notify_user_ids(
            db, ticket, member_ids,
            title=f"工单已被认领：{ticket.ticket_no}",
            content=(
                f"工单「{ticket.title}」已由 {operator_name} 认领处理"
                f"（节点：{ticket.current_node_name or '--'}），请勿重复处理"
            ),
        )
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_claim", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "node": ticket.current_node_key},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单认领: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 内部评论（时间线，区别于处置意见） ============

@router.post("/{ticket_id}/comments")
def add_ticket_comment(
    ticket_id: int,
    body: TicketComment,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """添加内部评论：写入处理时间线（action=comment），不改变工单状态与流转。

    权限：发起人 / 当前节点处理分组成员 / 抄送人 / admin。
    通知发起人与当前节点分组成员（评论人除外）。
    """
    ticket = _get_ticket_or_404(db, ticket_id)

    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    cc_user_ids = set(_resolve_cc_user_ids(db, _cc_rows(db, ticket.id)))
    # 处理人判定与详情 can_comment 同口径：按当前待处理分组（含会签/转办后变化），而非节点配置分组
    is_handler = bool(current_node and (_csv_group_ids(ticket) & my_groups))
    if not (admin or ticket.created_by_id == current_user.id or is_handler or current_user.id in cc_user_ids):
        raise HTTPException(status_code=403, detail="仅发起人、处理人、抄送人或管理员可评论")

    content = sanitize_text(body.content).strip()
    if not content:
        raise HTTPException(status_code=400, detail="评论内容不能为空")
    operator_name = current_user.display_name or current_user.username
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id if ticket.status == "processing" else None,
        handler_id=current_user.id,
        handler_name=operator_name,
        action="comment",
        field_values={},
        comment=content,
    ))
    # 通知：发起人 + 当前节点全部待处理分组成员（处理中，含会签/转办后变化），排除评论人
    notify_ids: set[int] = set()
    if ticket.status == "processing":
        notify_ids.update(
            uid for gid in _csv_group_ids(ticket) for uid in _group_member_ids(db, gid)
        )
    if ticket.created_by_id:
        notify_ids.add(ticket.created_by_id)
    notify_ids.discard(current_user.id)
    if notify_ids:
        _notify_user_ids(
            db, ticket, sorted(notify_ids),
            title=f"工单新评论：{ticket.ticket_no}",
            content=f"{operator_name} 在工单「{ticket.title}」中评论：{content[:120]}",
        )
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_comment", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "length": len(content)},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单评论: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 抄送（进行中工单：发起人/当前处理人/admin 可增减） ============

def _require_cc_manage_permission(db: Session, ticket: Ticket, current_user: User) -> None:
    """校验抄送管理权限：admin / 发起人 / 当前节点处理分组成员（仅进行中工单）。"""
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能再变更抄送")
    admin = is_admin(current_user, db)
    if admin or ticket.created_by_id == current_user.id:
        return
    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    my_groups = set(_my_group_ids(db, current_user.id))
    if current_node and current_node.get("group_id") in my_groups:
        return
    raise HTTPException(status_code=403, detail="仅发起人、当前处理人或管理员可变更抄送")


@router.post("/{ticket_id}/cc")
def add_ticket_cc(
    ticket_id: int,
    body: TicketCcAdd,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """追加抄送对象（人员或分组），被加入者立即收到抄送通知。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    _require_cc_manage_permission(db, ticket, current_user)

    targets = _fill_cc_names(db, _normalize_cc_targets([t.model_dump() for t in body.targets]))
    if not targets:
        raise HTTPException(status_code=400, detail="请选择有效的抄送对象（人员或分组）")

    # 去重：已存在的抄送对象跳过
    existing = {(r.target_type, r.target_id) for r in _cc_rows(db, ticket.id)}
    operator_name = current_user.display_name or current_user.username
    added = []
    for t in targets:
        if (t["type"], t["id"]) in existing:
            continue
        existing.add((t["type"], t["id"]))
        row = TicketCc(
            ticket_id=ticket.id,
            target_type=t["type"],
            target_id=t["id"],
            target_name=t["name"],
            source="manual",
            created_by_id=current_user.id,
            created_by_name=operator_name,
        )
        db.add(row)
        added.append(row)
    if not added:
        raise HTTPException(status_code=400, detail="所选对象已在抄送列表中")
    db.flush()
    _notify_cc_added(db, ticket, added, current_user)
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_cc_add", resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no,
            "targets": [f"{'分组' if r.target_type == 'group' else '用户'}:{r.target_name}" for r in added],
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单追加抄送: id=%s no=%s targets=%d, operator=%s",
                ticket.id, ticket.ticket_no, len(added), current_user.username)
    return _ticket_detail(db, ticket, current_user)


@router.delete("/{ticket_id}/cc/{cc_id}")
def remove_ticket_cc(
    ticket_id: int,
    cc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """移除抄送对象（仅限手动追加项；模板固定抄送由模板强制指定，不可移除）。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    _require_cc_manage_permission(db, ticket, current_user)

    row = db.query(TicketCc).filter(
        TicketCc.id == cc_id, TicketCc.ticket_id == ticket.id
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="抄送记录不存在")
    if row.source == "template":
        raise HTTPException(status_code=400, detail="模板固定抄送不可移除（由流程模板强制指定，仅可移除手动追加的抄送）")
    label = f"{'分组' if row.target_type == 'group' else '用户'}:{row.target_name}"
    db.delete(row)
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_cc_remove", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "target": label},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单移除抄送: id=%s no=%s target=%s, operator=%s",
                ticket.id, ticket.ticket_no, label, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 归档（软删除，仅完结工单） ============

@router.post("/{ticket_id}/archive")
def archive_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "delete")),
) -> dict:
    """归档工单（软删除）：仅已完成/已取消的工单可归档，归档后从默认列表隐藏。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    if ticket.status not in ("completed", "cancelled"):
        raise HTTPException(status_code=400, detail="仅已完结（已完成/已取消）的工单可归档")
    if ticket.archived:
        raise HTTPException(status_code=400, detail="工单已处于归档状态")
    ticket.archived = True
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_archive", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "status": ticket.status},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("归档工单: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


@router.post("/{ticket_id}/unarchive")
def unarchive_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "delete")),
) -> dict:
    """取消归档：恢复工单在默认列表中的展示。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    if not ticket.archived:
        raise HTTPException(status_code=400, detail="工单未处于归档状态")
    ticket.archived = False
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_unarchive", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "status": ticket.status},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("取消归档工单: id=%s no=%s, operator=%s", ticket.id, ticket.ticket_no, current_user.username)
    return _ticket_detail(db, ticket, current_user)


@router.delete("/{ticket_id}")
def delete_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "delete")),
) -> dict:
    """删除工单记录（物理删除）：同时删除节点处理记录与抄送行，不可恢复。

    仅授予 ticket:delete 的角色（如 admin）可见入口；归档为软删除，
    本接口为彻底清理入口。
    """
    ticket = _get_ticket_or_404(db, ticket_id)
    ticket_no = ticket.ticket_no
    ticket_title = ticket.title
    db.query(TicketCc).filter(TicketCc.ticket_id == ticket_id).delete(synchronize_session=False)
    db.query(TicketNodeRecord).filter(TicketNodeRecord.ticket_id == ticket_id).delete(synchronize_session=False)
    db.delete(ticket)
    db.commit()
    write_audit(
        db, action="ticket_delete", resource_type="ticket", resource_id=ticket_id,
        detail={"ticket_no": ticket_no, "title": ticket_title, "status": ticket.status},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("删除工单: id=%s no=%s, operator=%s", ticket_id, ticket_no, current_user.username)
    return {"deleted": ticket_id, "ticket_no": ticket_no}


# ============ 附件（上传走主 router，下载走 query token router） ============

@router.post("/attachments")
async def upload_attachment(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """上传工单附件（file 类型字段引用其 URL；发起/流转前上传，暂存 pending 目录）。

    - 扩展名白名单：png/jpg/jpeg/gif/webp/bmp/pdf/txt/log/md/csv/zip
    - 单文件不超过 10MB
    """
    original_name = file.filename or "untitled"
    ext = os.path.splitext(original_name)[1].lower().lstrip(".")
    if ext not in ALLOWED_ATTACHMENT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的文件类型，仅支持：" + "、".join(ALLOWED_ATTACHMENT_EXTENSIONS))
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(file_bytes) > MAX_ATTACHMENT_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过限制（最大 10MB）")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    saved_filename = f"{uuid.uuid4().hex}.{ext}" if ext else uuid.uuid4().hex
    with open(os.path.join(UPLOAD_DIR, saved_filename), "wb") as f:
        f.write(file_bytes)
    write_audit(
        db, action="ticket_attachment_upload", resource_type="ticket_attachment",
        resource_id=saved_filename, detail={"name": original_name, "size": len(file_bytes)},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单附件上传: file=%s size=%d, operator=%s",
                saved_filename, len(file_bytes), current_user.username)
    return {
        "name": sanitize_text(original_name),
        "size": len(file_bytes),
        "url": f"/api/v1/tickets/attachments/{saved_filename}",
    }


def _query_token_auth(request: Request, db: Session = Depends(get_db)) -> User:
    """附件访问专用鉴权：优先 query token，其次标准 Authorization 头。"""
    token = request.query_params.get("token")
    if token:
        return get_current_user(authorization=f"Bearer {token}", db=db)
    return get_current_user(authorization=request.headers.get("authorization"), db=db)


download_router = APIRouter(prefix="/tickets", tags=["tickets"])


@download_router.get("/attachments/{filename}")
def download_attachment(
    filename: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(_query_token_auth),
) -> FileResponse:
    """下载/预览工单附件（图片内联显示，做路径穿越校验）。

    支持 ``?token=<jwt>`` 认证，供前端 <img> 直接加载。
    """
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="非法的文件名")
    file_path = os.path.abspath(os.path.join(UPLOAD_DIR, filename))
    if not file_path.startswith(os.path.abspath(UPLOAD_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="非法的文件名")
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="附件不存在")

    ext = os.path.splitext(filename)[1].lower()
    image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
    if ext in image_exts:
        return FileResponse(file_path, filename=filename, content_disposition_type="inline")
    return FileResponse(file_path, filename=filename)
