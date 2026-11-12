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
import json
import logging
import os
import re
import threading
import time
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.core.audit import get_client_ip
from app.core.ticket_enrichment import (
    build_ticket_enrichment,
    decorate_asset_source_labels,
    requery_ticket_enrichment,
    start_agent_analysis_bg,
    start_enrichment_bg,
)
from app.core.ticket_pause import (
    REQUIRED_DETAIL_KEYS,
    PauseError,
    can_pause_ticket,
    can_resume_ticket,
    create_pause,
    force_resume_for_cancel,
    get_active_pause,
    get_pause_config,
    is_ticket_handler,
    pause_type_label,
    resume_pause,
    save_pause_config,
)
from app.core.ticket_sla import evaluate_ticket_sla, get_sla_config, paused_minutes_between
from app.core.ticket_device_action import (
    annotate_device_form,
    build_device_action_form,
    build_field_context,
    parse_params_schema,
    plan_device_runs,
    prepare_device_params,
)
from app.core.ticket_device_run import (
    apply_run_to_node_record,
    create_runs_for_plans,
    enqueue_run,
    mark_enqueue_failed,
)
from app.core.ticket_flow import (
    collect_ref_options,
    eval_when,
    get_node,
    get_node_pending_groups,
    get_start_node,
    is_end_node,
    parse_duration,
    strip_hidden_field_values,
    suggest_route,
    validate_field_values,
)
from datetime import datetime, timedelta

from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import (
    get_current_user, has_permission_for_user, is_admin, require_permission,
)
from app.devices.action_executor import execute_device_action
from app.models.ban_hit_stat import BanHitStat
from app.models.device import Device, DeviceAction
from app.models.notification import Notification
from app.models.ticket import (
    Ticket, TicketCc, TicketDeviceRun, TicketFlow, TicketGroup, TicketGroupMember,
    TicketNodeRecord, TicketPause,
)
from app.models.user import User
from app.models.workflow_ban import BanRecord
from app.schemas.ticket import (
    TicketAdvance, TicketBatchPause, TicketBatchResume, TicketCancel,
    TicketCcAdd, TicketComment, TicketCreate, TicketDeviceActionExecute,
    TicketEnrichmentRequery, TicketPauseConfigUpdate, TicketPauseCreate,
    TicketResume, TicketRollback, TicketSimilar, TicketTransfer,
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

def _ticket_device_action_form(db, node, records) -> dict:
    """工单详情的设备动作表单（含参数配置展示方式）。

    ``default_template`` 原样下发，前端用历史记录 + 当前表单实时解析预览；
    不在服务端把模板结果写进 ``default``，避免处理人改其他参数时被冻结的旧值覆盖。
    reason 参数未配置时由 build_device_action_form 内置 隐藏 + 工单同步：{ticket_no}。
    """
    return annotate_device_form(build_device_action_form(db, node), records)

# 状态中文
STATUS_LABELS = {"processing": "进行中", "paused": "已暂停", "completed": "已完成", "cancelled": "已取消"}
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
    """生成工单编号：TK-YYYYMMDD-XXXX（当日序号，4 位补零）。

    取当日已用最大序号 + 1（而非当日数量 + 1）：工单可被物理删除产生断号，
    按数量计数会追上已存在编号，触发 ticket_no 唯一约束冲突导致发起 500；
    按最大序号续号可容忍任意断号。
    """
    today = beijing_now().strftime("%Y%m%d")
    prefix = f"TK-{today}-"
    max_no = (
        db.query(func.max(Ticket.ticket_no))
        .filter(Ticket.ticket_no.like(prefix + "%"))
        .scalar()
    )
    seq = int(max_no[len(prefix):]) + 1 if max_no else 1
    return f"{prefix}{seq:04d}"


# 并发取号保护：多人同时发起时 max+1 可能读到相同值撞号，冲突回滚重取的次数上限
TICKET_NO_MAX_ATTEMPTS = 5


def _is_ticket_no_conflict(exc: IntegrityError) -> bool:
    """判断 IntegrityError 是否为 ticket_no 唯一约束冲突（并发取号撞号）。

    psycopg2：diag.constraint_name 精确给出约束名；
    SQLite（单测）：报错文本形如 "UNIQUE constraint failed: tickets.ticket_no"。
    其余唯一约束冲突不应误判（重试无意义，须原样抛出）。
    """
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    constraint = getattr(diag, "constraint_name", None)
    if constraint:
        return constraint == "ix_tickets_ticket_no"
    text = str(exc)
    return "ix_tickets_ticket_no" in text or "UNIQUE constraint failed: tickets.ticket_no" in text


def _resolve_route(
    routes: list,
    field_values: dict,
    explicit_route: str | None,
    node_label: str,
) -> str:
    """解析流转去向：条件路由命中时强制走条件去向；未命中走显式选择/默认路由。

    - 字段值命中路由条件（如「是否需要处置=是」）→ 流转去向锁定为该条件路由，
      显式改选不一致时拒绝（保证确定性流转，前端同步锁定不可改选）
    - 未命中条件 → 显式选择（校验白名单）；未选择则走默认路由
    """
    whitelist = {r.get("to") for r in routes or [] if isinstance(r, dict) and r.get("to")}
    if not whitelist:
        raise HTTPException(status_code=400, detail=f"节点「{node_label}」未配置流转路由")
    suggested, default = suggest_route(routes, field_values)
    if suggested:
        if explicit_route and explicit_route != suggested:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"节点「{node_label}」按填写内容命中流转条件，必须流转至「{suggested}」，"
                    f"不支持手动改选「{explicit_route}」"
                ),
            )
        return suggested
    if explicit_route:
        if explicit_route not in whitelist:
            raise HTTPException(
                status_code=400,
                detail=f"流转去向 {explicit_route} 不在节点「{node_label}」的路由白名单内",
            )
        return explicit_route
    target = default
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
        elapsed = (now - started).total_seconds() / 60
        elapsed -= paused_minutes_between(records, started, now)
        remaining = resp_target - elapsed
    elif res_target and ticket.created_at:
        elapsed = (now - ticket.created_at).total_seconds() / 60
        elapsed -= paused_minutes_between(records, ticket.created_at, now)
        remaining = res_target - elapsed
    else:
        return None, False, True
    return remaining, remaining < 0, True


def _ticket_overdue(t: Ticket, records: list, now, config: dict) -> bool:
    """工单「当前超时」判定（大屏超时预警与工单中心列表/超时筛选统一口径）。

    - 未提交过节点：响应目标到期即超时；
    - 已提交过节点：只看解决目标（响应曾经超标属历史事实，不计入当前预警）；
    - 暂停工单以暂停时刻冻结评估；已完成/已取消不参与当前预警。
    """
    if t.status not in ("processing", "paused"):
        return False
    sla_now = (t.paused_at or now) if t.status == "paused" else now
    _, overdue, _ = _sla_remaining(t, records, sla_now, config)
    return overdue


def _sla_overdue_conditions(db: Session, config: dict, now) -> list:
    """SLA 已超时的 SQL 过滤条件（处理中/暂停中且响应或解决目标已到期）。

    与 ``_sla_remaining`` 判定保持一致：
    - 尚未提交过节点（无 submit 记录）：按响应目标（create 时间 + response）判定；
    - 已提交过节点：按解决目标（ticket.created_at + resolve）判定；
    - 暂停中：以 ``paused_at`` 作为评估时点（SLA 冻结）。
    """
    started = func.coalesce(
        db.query(func.min(TicketNodeRecord.created_at))
        .filter(
            TicketNodeRecord.ticket_id == Ticket.id,
            TicketNodeRecord.action == "create",
        )
        .correlate(Ticket)
        .scalar_subquery(),
        Ticket.created_at,
    )
    has_submit = (
        db.query(TicketNodeRecord.id)
        .filter(
            TicketNodeRecord.ticket_id == Ticket.id,
            TicketNodeRecord.action == "submit",
        )
        .correlate(Ticket)
        .exists()
    )
    eval_now = func.coalesce(Ticket.paused_at, now)
    # 扣除已完成暂停时长：暂停期间不计入 SLA 耗时
    pause_interval = func.make_interval(
        0, 0, 0, 0, 0, func.coalesce(Ticket.pause_total_minutes, 0)
    )
    priority_conds = []
    for pr, target in (config or {}).items():
        resp_target = (target or {}).get("response")
        res_target = (target or {}).get("resolve")
        pr_conds = []
        if resp_target:
            pr_conds.append(and_(
                ~has_submit,
                started + timedelta(minutes=resp_target) + pause_interval < eval_now,
            ))
        if res_target:
            resolve_cond = (
                Ticket.created_at + timedelta(minutes=res_target) + pause_interval < eval_now
            )
            # 有响应目标时，解决时限仅在已响应后生效；无响应目标时与列表口径一致
            if resp_target:
                resolve_cond = and_(has_submit, resolve_cond)
            pr_conds.append(resolve_cond)
        if pr_conds:
            priority_conds.append(and_(Ticket.priority == pr, or_(*pr_conds)))
    if not priority_conds:
        return [Ticket.id.is_(None)]
    return [
        # 未被处理：仍在处理中或已暂停；已完成/已取消不计入超时
        Ticket.status.in_(("processing", "paused")),
        or_(*priority_conds),
    ]


def _apply_ticket_filters(
    db: Session,
    current_user: User,
    view: str,
    status: str | None,
    flow_id: int | None,
    priority: str | None,
    archived: str,
    q: str | None,
    timeout_only: bool = False,
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
            # 暂停工单仍属于当前处理组的"待我处理"，展示为已暂停
            Ticket.status.in_(("processing", "paused")),
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
    if timeout_only:
        # 已超时：SLA 目标已到期且工单仍未被处理（处理中/暂停中）
        query = query.filter(*_sla_overdue_conditions(db, get_sla_config(db), beijing_now()))
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


def _reject_if_paused(ticket: Ticket, action_label: str) -> None:
    """暂停中的工单禁止流转类操作，需先恢复。"""
    if ticket.status == "paused":
        raise HTTPException(
            status_code=409,
            detail=f"工单已暂停，请先恢复后再{action_label}",
        )


def _pause_error(exc: PauseError) -> HTTPException:
    """暂停领域异常 → HTTP 响应（错误码写入日志，便于前端提示定位）。"""
    logger.warning("工单暂停操作被拒绝: code=%s status=%s message=%s",
                   exc.code, exc.status_code, exc.message)
    return HTTPException(status_code=exc.status_code, detail=exc.message)


def _pause_notify_ids(db: Session, ticket: Ticket, exclude_id: int | None = None) -> list[int]:
    """暂停/恢复通知对象：发起人 + 抄送人 + 当前待处理分组成员 + 认领人。"""
    ids: set[int] = set()
    if ticket.created_by_id:
        ids.add(ticket.created_by_id)
    ids.update(_resolve_cc_user_ids(db, _cc_rows(db, ticket.id)))
    for gid in _csv_group_ids(ticket):
        ids.update(_group_member_ids(db, gid))
    if ticket.claimed_by_id:
        ids.add(ticket.claimed_by_id)
    if exclude_id:
        ids.discard(exclude_id)
    return sorted(uid for uid in ids if uid)


def _notify_pause_created(
    db: Session, ticket: Ticket, pause: TicketPause, operator_name: str,
) -> None:
    """暂停成功通知：发起人 + 抄送人 + 当前分组成员 + 认领人。"""
    label = pause_type_label(get_pause_config(db), pause.pause_type)
    recipients = _pause_notify_ids(db, ticket, exclude_id=pause.paused_by_id)
    if not recipients:
        return
    expire_text = pause.expire_at.strftime("%Y-%m-%d %H:%M") if pause.expire_at else "--"
    visibility = (pause.policy_snapshot or {}).get("reason_visibility", "participants")
    reason_text = "（原因内部可见）" if visibility == "internal" else pause.reason
    _notify_user_ids(
        db, ticket, recipients,
        title=f"工单已暂停：{ticket.ticket_no}",
        content=(
            f"工单「{ticket.title}」已由 {operator_name} 暂停（{label}），"
            f"原因：{reason_text}；到期时间：{expire_text}。"
            f"暂停期间不可流转，请联系暂停人或管理员恢复。"
        ),
    )


def _notify_ticket_resumed(
    db: Session, ticket: Ticket, pause: TicketPause, operator_name: str,
) -> None:
    """恢复通知：发起人 + 抄送人 + 当前分组成员 + 认领人。"""
    recipients = _pause_notify_ids(db, ticket, exclude_id=pause.resumed_by_id)
    if not recipients:
        return
    _notify_user_ids(
        db, ticket, recipients,
        title=f"工单已恢复：{ticket.ticket_no}",
        content=(
            f"工单「{ticket.title}」已由 {operator_name} 恢复，"
            f"暂停时长 {pause.duration_minutes or 0} 分钟，"
            f"当前节点：{ticket.current_node_name or '--'}，请继续处理。"
        ),
    )


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


def _rollback_restore_values(current_node: dict | None, records: list) -> dict | None:
    """回退回显：当前节点由「回退」重新到达时，返回该节点上次提交的字段值。

    - 最后一次决定当前节点归属的记录（create/submit/rollback 且 route_to=当前节点）
      必须是 rollback，才认定为回退回显场景；正常流转/首次进入不干预（返回 None）
    - 取值来源：该节点最近一次 create/submit 记录的 field_values
    - 仅保留当前节点字段定义内的 key（含匹配规则扩展字段），避免回带无关字段
    """
    if not current_node:
        return None
    node_key = str(current_node.get("key") or "")
    if not node_key:
        return None
    arrival = next(
        (
            r for r in reversed(records)
            if getattr(r, "action", None) in ("create", "submit", "rollback")
            and getattr(r, "route_to", None) == node_key
        ),
        None,
    )
    if arrival is None or getattr(arrival, "action", None) != "rollback":
        return None
    prev = next(
        (
            r for r in reversed(records)
            if getattr(r, "id", 0) < getattr(arrival, "id", 0)
            and getattr(r, "node_key", None) == node_key
            and getattr(r, "action", None) in ("create", "submit")
        ),
        None,
    )
    values = getattr(prev, "field_values", None) if prev is not None else None
    if not isinstance(values, dict) or not values:
        return None
    allowed: set[str] = set()
    for field in current_node.get("fields") or []:
        if not isinstance(field, dict) or not field.get("key"):
            continue
        allowed.add(str(field["key"]))
        for rule in field.get("rules") or []:
            for rf in (rule or {}).get("fields") or []:
                if isinstance(rf, dict) and rf.get("key"):
                    allowed.add(str(rf["key"]))
    return {k: v for k, v in values.items() if k in allowed}


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
    # 设备动作执行权限（独立授权）：详情/只看不受影响，
    # 提交流转触发设备、失败重试、封禁撤销均需 ticket:execute
    can_execute_device = has_permission_for_user(db, current_user, "ticket", "execute")
    # 排队/执行中的设备任务数：前端据此轮询刷新时间线状态
    pending_device_runs = int(
        db.query(func.count(TicketDeviceRun.id))
        .filter(
            TicketDeviceRun.ticket_id == ticket.id,
            TicketDeviceRun.status.in_(["queued", "running"]),
        )
        .scalar() or 0
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

    # 暂停：活动记录 + 历史 + 当前用户可发起的分类 + 操作权限
    pause_config = get_pause_config(db)
    active_pause = get_active_pause(db, ticket) if ticket.status == "paused" else None
    pause_history = (
        db.query(TicketPause)
        .filter(TicketPause.ticket_id == ticket.id)
        .order_by(TicketPause.id.desc())
        .limit(20)
        .all()
    )
    allowed_pause_types: list[dict] = []
    if ticket.status == "processing" and pause_config.get("enabled", True):
        for code, item in (pause_config.get("types") or {}).items():
            if not isinstance(item, dict) or not item.get("enabled", True):
                continue
            if can_pause_ticket(
                ticket, current_user.id, my_groups,
                is_admin_user=admin, pause_type=code, config=pause_config,
            ):
                allowed_pause_types.append({
                    "code": code,
                    "label": item.get("label") or code,
                    "max_minutes": item.get("max_minutes"),
                    "require_expected_resume": bool(item.get("require_expected_resume")),
                    "required_detail_keys": list(REQUIRED_DETAIL_KEYS.get(code, ())),
                })
    can_resume = bool(
        active_pause
        and can_resume_ticket(
            ticket, active_pause, current_user.id, my_groups,
            is_admin_user=admin,
        )
    )
    # 暂停原因可见性：reason_visibility=internal 时仅处理人与管理员可见原文，
    # 发起人/抄送人仅看到"已暂停（原因内部可见）"
    viewer_is_handler = is_ticket_handler(ticket, current_user.id, my_groups)

    def _pause_payload(p: TicketPause) -> dict:
        payload = p.to_dict()
        visibility = (p.policy_snapshot or {}).get("reason_visibility", "participants")
        if visibility == "internal" and not (admin or viewer_is_handler):
            payload["reason"] = "已暂停（原因内部可见）"
            payload["detail"] = {}
        return payload

    def _record_payload(r: TicketNodeRecord) -> dict:
        """时间线记录：内部可见的暂停原因对发起人/抄送人脱敏。"""
        item = r.to_dict()
        if r.action == "pause":
            values = dict(item.get("field_values") or {})
            visibility = values.get("reason_visibility")
            if visibility is None:
                matched = next(
                    (p for p in pause_history if p.pause_type == values.get("pause_type")),
                    None,
                )
                visibility = (
                    (matched.policy_snapshot or {}).get("reason_visibility", "participants")
                    if matched else "participants"
                )
            if visibility == "internal" and not (admin or viewer_is_handler):
                values.pop("reason", None)
                values.pop("necessity", None)
                values["reason"] = "已暂停（原因内部可见）"
                item["field_values"] = values
                item["comment"] = None
        return item

    data = _ticket_list_item(ticket, group_names)
    data.update({
        "flow_snapshot": snapshot,
        "records": [_record_payload(r) for r in records],
        # 自动研判结果随详情返回（列表已剔除）：资产匹配 + 威胁情报
        # 资产匹配各来源补详细来源标签（资产发现-裸金属资产 /
        # 资产清单-A会保持在线系统清单），存量工单按当前模板名推导
        "enrichment_data": decorate_asset_source_labels(db, ticket.enrichment_data),
        "group_names": {str(k): v for k, v in group_names.items()},
        "current_node": current_node,
        # 回退回显：当前节点由回退重新到达时，返回该节点上次提交的字段值（正常流转为 None）
        "restore_values": _rollback_restore_values(current_node, records),
        "can_handle": can_handle,
        # 认领：未锁定且具备基础处理权时可认领（先到先得；并行会签节点不支持认领）
        "can_claim": bool(
            base_can_handle and ticket.claimed_by_id is None
            and (current_node or {}).get("type") != "parallel"
        ),
        "claimed_by_name": (claimed_by.display_name or claimed_by.username) if claimed_by else None,
        "can_urge": can_urge,
        "can_comment": can_comment,
        # 设备动作执行权限（下车/重试/撤销）：独立权限 ticket:execute
        "can_execute_device": bool(can_execute_device),
        # 排队/执行中的设备任务数（>0 时前端轮询刷新时间线）
        "pending_device_runs": pending_device_runs,
        "can_cancel": (
            ticket.status in ("processing", "paused")
            and (admin or ticket.created_by_id == current_user.id)
        ),
        # —— 暂停（临时挂起）——
        "pause": _pause_payload(active_pause) if active_pause else None,
        "pause_label": pause_type_label(pause_config, ticket.pause_type),
        "pause_history": [_pause_payload(p) for p in pause_history],
        "pause_types": allowed_pause_types,
        "pause_reason_visibility": (
            (pause_config.get("types") or {}).get(ticket.pause_type or "", {}).get("reason_visibility")
            if ticket.pause_type else None
        ),
        "can_pause": bool(ticket.status == "processing" and allowed_pause_types),
        "can_resume": can_resume,
        "can_force_resume": bool(admin and active_pause),
        # 并行会签进度（非会签节点为 null）
        "sign_progress": sign_progress,
        # 设备动作表单：default_template 原样下发，前端按 display 渲染并用历史 + 当前表单实时预览；
        # reason 未配置时内置 隐藏 + 工单同步：{ticket_no}
        "device_action_form": _ticket_device_action_form(db, current_node, records),
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
    # 自动研判：对 src_ip/dst_ip 全部有效 IP 做资产匹配 + 威胁情报 + 智能体
    # 研判（按字段开关，失败不阻塞发起）；IP 数 > 同步阈值时返回 pending
    # 占位（bg_plan 非空），工单落库后由后台线程补全
    enrichment = None
    enrich_bg_plan = None
    enrich_agent_ips: list[str] = []
    try:
        enrichment, enrich_bg_plan, enrich_agent_ips = build_ticket_enrichment(
            db, start_node.get("fields") or [], values, title=body.title
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单自动研判失败（忽略，不阻塞发起）: %s", exc)
        enrichment, enrich_bg_plan, enrich_agent_ips = None, None, []
    # 并发取号保护：max+1 非原子操作，多人同时发起可能读到相同最大序号而撞号；
    # 撞号时整体回滚（此前仅只读查询，无副作用）重新取号，最多重试 5 次
    ticket: Ticket | None = None
    for attempt in range(1, TICKET_NO_MAX_ATTEMPTS + 1):
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
        try:
            db.flush()
            break
        except IntegrityError as exc:
            db.rollback()
            if not _is_ticket_no_conflict(exc):
                raise
            if attempt >= TICKET_NO_MAX_ATTEMPTS:
                logger.error(
                    "工单号取号连续 %s 次冲突，放弃: flow=%s operator=%s",
                    TICKET_NO_MAX_ATTEMPTS, flow.id, current_user.username,
                )
                raise HTTPException(
                    status_code=503, detail="工单号生成冲突，请稍后重试"
                ) from exc
            logger.warning(
                "工单号取号冲突，回滚重取(%s/%s): flow=%s operator=%s",
                attempt, TICKET_NO_MAX_ATTEMPTS, flow.id, current_user.username,
            )
    assert ticket is not None  # 循环至少执行一次
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
    # 自动研判后台异步执行（不阻塞发起，完成后回写 enrichment_data）：
    # - IP 数超同步阈值：enrichment 后台线程先补全资产/情报（bg_plan 内
    #   含 agent 标记，worker 完成后同线程链式执行智能体研判，避免双线
    #   程并发回写相互覆盖）；
    # - 同步路径：仅智能体研判（LLM 耗时）转后台线程。
    if enrich_bg_plan is not None:
        start_enrichment_bg(ticket.id, enrich_bg_plan, body.title)
    elif enrich_agent_ips:
        start_agent_analysis_bg(ticket.id, enrich_agent_ips, body.title)
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
    status: str | None = Query(default=None, pattern="^(processing|paused|completed|cancelled)$"),
    flow_id: int | None = Query(default=None),
    priority: str | None = Query(default=None, pattern="^(low|medium|high|critical)$"),
    archived: str = Query(default="exclude", pattern="^(exclude|only|include)$"),
    q: str | None = Query(default=None, max_length=100),
    timeout_only: bool = Query(default=False),
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
    query = _apply_ticket_filters(
        db, current_user, view, status, flow_id, priority, archived, q,
        timeout_only=timeout_only,
    )
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
    # 暂停权限：策略配置与本页活动暂停记录各取一次，逐单按角色判定
    pause_config = get_pause_config(db)
    my_groups = set(_my_group_ids(db, current_user.id))
    enabled_pause_types = [
        code for code, item in (pause_config.get("types") or {}).items()
        if isinstance(item, dict) and item.get("enabled", True)
    ]
    active_pause_ids = [t.active_pause_id for t in tickets if t.active_pause_id]
    active_pauses = {
        p.id: p
        for p in db.query(TicketPause).filter(TicketPause.id.in_(active_pause_ids)).all()
    } if active_pause_ids else {}

    items = []
    for t in tickets:
        item = _ticket_list_item(t, group_names)
        if t.status in ("processing", "paused"):
            # 暂停中 SLA 冻结：以暂停时间作为"当前时间"计算剩余
            sla_now = (t.paused_at or now) if t.status == "paused" else now
            remaining, overdue, has_target = _sla_remaining(t, rec_map.get(t.id, []), sla_now, sla_config)
            if remaining is not None:
                item["sla_text"] = ("超时 " if overdue else "剩余 ") + _fmt_duration(remaining)
                item["sla_overdue"] = overdue
            elif has_target:
                item["sla_text"] = None
                item["sla_overdue"] = False
            item["sla_frozen"] = t.status == "paused"
        item["can_urge"] = bool(
            t.status == "processing"
            and (admin or t.created_by_id == current_user.id or t.id in cc_ids)
        )
        # 暂停/恢复入口权限（列表行快捷操作）
        item["can_pause"] = bool(
            t.status == "processing"
            and pause_config.get("enabled", True)
            and any(
                can_pause_ticket(
                    t, current_user.id, my_groups,
                    is_admin_user=admin, pause_type=code, config=pause_config,
                )
                for code in enabled_pause_types
            )
        )
        active_pause = active_pauses.get(t.active_pause_id) if t.active_pause_id else None
        item["can_resume"] = bool(
            t.status == "paused"
            and active_pause
            and can_resume_ticket(
                t, active_pause, current_user.id, my_groups, is_admin_user=admin,
            )
        )
        item["pause_label"] = (
            pause_type_label(pause_config, t.pause_type) if t.status == "paused" else None
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

def _monitor_light(db: Session, now, today_start) -> dict:
    """轻量模式聚合（大屏高频轮询）：KPI + 最新工单，不做全量 SLA/趋势/下钻。

    KPI 全部走 SQL 聚合（只 count，不加载整表）；SLA 仅对「处理中」工单与
    最新 20 件工单做评估，并只加载这些工单的流转记录，避免大屏轮询把
    全量工单与全部流转记录反复载入内存。
    """
    active_filter = or_(Ticket.archived.is_(False), Ticket.archived.is_(None))
    base = db.query(Ticket).filter(active_filter)
    # 统计口径：暂停工单仍属于「处理中」（SLA 计时冻结但不脱离待办）
    active_statuses = ("processing", "paused")

    kpi = {
        "total": base.count(),
        "today_new": base.filter(Ticket.created_at >= today_start).count(),
        "today_closed": base.filter(
            Ticket.closed_at.isnot(None), Ticket.closed_at >= today_start,
        ).count(),
        "pending": base.filter(Ticket.status.in_(active_statuses)).count(),
        "processing_active": (
            db.query(Ticket.id)
            .join(TicketNodeRecord, TicketNodeRecord.ticket_id == Ticket.id)
            .filter(
                active_filter,
                Ticket.status.in_(active_statuses),
                TicketNodeRecord.action == "submit",
                TicketNodeRecord.created_at >= today_start,
            )
            .distinct()
            .count()
        ),
        "completed": base.filter(Ticket.status == "completed").count(),
        "cancelled": base.filter(Ticket.status == "cancelled").count(),
        "timeout_warning": 0,  # 下方按处理中工单 SLA 评估后回填
    }

    processing = base.filter(Ticket.status.in_(active_statuses)).all()
    latest_tickets = base.order_by(Ticket.created_at.desc()).limit(20).all()
    eval_tickets: dict[int, Ticket] = {t.id: t for t in processing}
    eval_tickets.update({t.id: t for t in latest_tickets})
    by_ticket: dict[int, list] = {}
    if eval_tickets:
        records = (
            db.query(TicketNodeRecord)
            .filter(TicketNodeRecord.ticket_id.in_(list(eval_tickets)))
            .order_by(TicketNodeRecord.ticket_id, TicketNodeRecord.created_at)
            .all()
        )
        for r in records:
            by_ticket.setdefault(r.ticket_id, []).append(r)
    sla_config = get_sla_config(db)
    # 超时预警口径：与工单中心「超时」筛选一致（暂停工单按暂停时刻冻结评估）
    kpi["timeout_warning"] = sum(
        1 for t in processing if _ticket_overdue(t, by_ticket.get(t.id, []), now, sla_config)
    )

    latest = []
    for t in latest_tickets:
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
            "timeout": _ticket_overdue(t, by_ticket.get(t.id, []), now, sla_config),
            "remind_count": t.remind_count or 0,
        })

    return {
        "light": True,
        "generated_at": now.isoformat(),
        "kpi": kpi,
        "latest": latest,
    }


# ============ 封禁IP统计（大屏「封禁IP统计」卡）：安博通黑名单历史累计 + 重保区间 ============
# 与 /monitor 聚合接口解耦：每次全量拉取安博通黑名单后增量合并进 ban_hit_stats
# 命中累计表（历史累计口径，解封/到期不回退），大屏卡片独立轮询本组接口，
# 避免设备调用频率绑死在工单聚合刷新周期上。

# 全量黑名单翻页上限（单页 LIST_PAGE_SIZE=1000，20 页 = 2 万条，超出以 truncated 标记）
_BLACKLIST_FETCH_MAX_PAGES = 20
# 全量拉取结果缓存 TTL（秒）：万级条目分页拉取一轮可达分钟级，短 TTL 会让
# 高频轮询退化为连续全量拉取打爆设备；60s 让轮询绝大多数命中缓存
_BLACKLIST_CACHE_TTL_SECONDS = 60.0
_blacklist_cache: dict = {"at": 0.0, "items": [], "truncated": False}
_blacklist_cache_lock = threading.Lock()
# 全量拉取 single-flight 锁：并发请求（两卡 + 轮询叠加）共用一次进行中的拉取，
# 后到者在锁上等待并直接复用其结果，避免多个分钟级翻页请求同时压到设备
_blacklist_fetch_lock = threading.Lock()
# 命中累计表同步锁：并发请求同时触发全量拉取时串行化合并，避免增量重复累计
_ban_hit_sync_lock = threading.Lock()


def _parse_effect_time(value) -> datetime | None:
    """解析设备黑名单条目的 effectTime（条目产生/生效时间，北京时间）。

    设备返回形如 ``2026-11-05 10:00:00`` / ``2026-11-05T10:00:00``（可能带秒级以下
    精度或时区偏移）；解析失败返回 None（该条目不参与重保区间统计）。
    """
    if value in (None, ""):
        return None
    s = str(value).strip()
    if not s:
        return None
    dt: datetime | None = None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s.replace("T", " ")[:19])
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
                try:
                    dt = datetime.strptime(s[:19], fmt)
                    break
                except ValueError:
                    continue
    if dt is None:
        return None
    # 设备与平台同时区：带时区偏移时按北京时间剥离 tzinfo，统一为 naive 比较
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


def _parse_hit_num(value) -> int:
    """解析设备黑名单条目的 hit_num（命中/拦截次数，设备返回字符串或整数）。

    缺失 / 非法 / 负值按 0 计（不影响其他条目统计）。
    """
    if value is None or value == "":
        return 0
    try:
        return max(0, int(str(value).strip()))
    except (TypeError, ValueError):
        return 0


def _sync_ban_hit_stats(db: Session, items: list[dict]) -> None:
    """将本次拉取的设备黑名单条目并入命中累计表（ban_hit_stats，历史累计口径）。

    - 新条目：hit_total = last_hit = 当前 hit_num；
    - 已有条目：设备侧 hit_num 单调递增，取差值计入累计；
    - 「解封后重新封禁」的全额重计必须同时满足两个条件：设备计数回落
      （hit < last_hit）**且 effectTime 前进**（重封会刷新生效时间）。只看计数
      回落会把乱序快照误判为重封——并发全量拉取时代旧快照后到，一轮误重计
      就把全表当前计数整轮再加一遍（实测 2 小时膨胀 72 倍）；此时跳过本条
      不改写（不下调 last_hit，避免下一轮再全量重计一次）；
    - 条目从设备消失（解封/到期）不删除记录：累计值保留，统计只增不减。

    同一批条目重复同步幂等（last_hit 已更新为当前值，差值为 0）。
    """
    if not items:
        return
    rows = {r.blist: r for r in db.query(BanHitStat).all()}
    now = beijing_now()
    for it in items:
        blist = str(it.get("blist") or "").strip()
        if not blist:
            continue
        hit = _parse_hit_num(it.get("hit_num"))
        eff = _parse_effect_time(it.get("effectTime"))
        row = rows.get(blist)
        if row is None:
            row = BanHitStat(blist=blist, hit_total=hit, last_hit=hit,
                             effect_time=eff, first_seen_at=now, last_seen_at=now)
            db.add(row)
            rows[blist] = row  # 同批同 blist 去重
        elif hit >= row.last_hit:
            # 正常增量：设备计数不低于上次记录，差值计入累计
            delta = hit - row.last_hit
            # 仅在命中 / 生效时间真正变化时才更新 last_seen_at：
            # 无条件赋新时间戳会把全表行标记 dirty，每次同步产生全表 UPDATE
            changed = delta > 0 or (eff is not None and eff != row.effect_time)
            if delta > 0:
                row.hit_total = (row.hit_total or 0) + delta
            row.last_hit = hit
            if eff is not None:
                row.effect_time = eff
            if changed:
                row.last_seen_at = now
        elif eff is not None and row.effect_time is not None and eff > row.effect_time:
            # 真实重封：effectTime 前进且设备计数清零，按新一轮全量计入
            row.hit_total = (row.hit_total or 0) + hit
            row.last_hit = hit
            row.effect_time = eff
            row.last_seen_at = now
        # else：计数回落但 effectTime 未前进 —— 乱序快照 / 设备抖动，
        # 跳过本条（不改写 last_hit / hit_total）。
        # 已知限制（有意保守）：若历史行 effect_time 为 NULL 或设备重封后
        # 不返回 effectTime，真实重封无法识别，将跳过并少计该条增量，
        # 直到设备计数重新超过 last_hit 才恢复正常——宁少计勿误多计。
    db.commit()


def _fetch_full_blacklist(db: Session) -> tuple[list[dict], str | None, bool]:
    """翻页拉取安博通阻断器黑名单全量条目（带 TTL 缓存 + single-flight 合并）。

    每次真实拉取成功后同步命中累计表（历史累计口径数据源，见 _sync_ban_hit_stats）；
    缓存命中时不重复同步。Returns: (items, error, truncated)：error 非 None 时
    items 为空；truncated=True 表示超出翻页上限，仅统计到前
    ``_BLACKLIST_FETCH_MAX_PAGES`` 页。

    万级条目分页拉取一轮可达分钟级：并发请求（封禁IP统计卡 / 重保拦截趋势卡
    及其轮询叠加）在 single-flight 锁上排队，共用首个请求的拉取结果——等锁
    期间若缓存已新鲜则直接返回缓存；首请求失败时后到者依次重试拉取。
    """
    now_ts = time.monotonic()
    with _blacklist_cache_lock:
        if _blacklist_cache["items"] and now_ts - _blacklist_cache["at"] < _BLACKLIST_CACHE_TTL_SECONDS:
            return _blacklist_cache["items"], None, _blacklist_cache["truncated"]

    with _blacklist_fetch_lock:
        # 等锁期间前一个请求可能已完成拉取并刷新缓存：double-check 后直接复用
        now_ts = time.monotonic()
        with _blacklist_cache_lock:
            if _blacklist_cache["items"] and now_ts - _blacklist_cache["at"] < _BLACKLIST_CACHE_TTL_SECONDS:
                return _blacklist_cache["items"], None, _blacklist_cache["truncated"]

        from app.devices.anbotong import LIST_PAGE_SIZE, list_blacklist_on_anbotong

        items: list[dict] = []
        truncated = False
        page = 1
        while page <= _BLACKLIST_FETCH_MAX_PAGES:
            res = list_blacklist_on_anbotong(db, page=page, count=LIST_PAGE_SIZE, source="monitor")
            if not res.get("success"):
                # 首页失败：整体失败；翻页中途失败：保留已拉到的部分（数据可能不全但可展示）
                if page == 1:
                    return [], res.get("error") or "安博通黑名单接口调用失败", False
                logger.warning("黑名单全量拉取在第 %d 页中断: %s", page, res.get("error"))
                break
            items.extend(res.get("items") or [])
            if not res.get("page_full"):
                break
            page += 1
        else:
            truncated = True
            logger.warning("黑名单条目超过 %d 页上限，统计可能不全", _BLACKLIST_FETCH_MAX_PAGES)

        # 并入命中累计表（串行化：并发双拉取时第二次同步幂等，不重复累计增量）。
        # 同步失败（如历史遗留的列溢出）不阻断大屏请求：回滚后按表内既有累计值
        # 返回统计，仅记录告警等待下次拉取重试同步
        with _ban_hit_sync_lock:
            try:
                _sync_ban_hit_stats(db, items)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.warning("黑名单命中累计表同步失败（本次按旧累计值返回）: %s", exc)

        with _blacklist_cache_lock:
            _blacklist_cache.update(at=now_ts, items=items, truncated=truncated)
        return items, None, truncated


@router.get("/monitor/ban-live")
def ticket_monitor_ban_live(
    period_start: datetime | None = Query(default=None, description="重保时间范围起点（ISO 格式，如 2026-11-01T00:00:00）"),
    period_end: datetime | None = Query(default=None, description="重保时间范围终点（ISO 格式，如 2026-11-07T23:59:59）"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_monitor", "view")),
):
    """封禁IP统计（大屏「封禁IP统计」卡专用，独立于 /monitor 聚合接口轮询）。

    历史累计口径（数据源 ban_hit_stats 命中累计表，每次全量拉取设备黑名单后
    增量合并，见 ``_sync_ban_hit_stats``）：条目解封/到期从设备消失后计数保留，
    只增不减；解封后重新封禁按新一轮命中继续累计。

    - ``total``：累计封禁条目（去重 blist）总数（含已解封/到期）；
    - ``total_hit_count``：全量条目的拦截（命中）次数累计总和；
    - ``period_count``：重保时间范围内「产生」的封禁条目数（按条目最近一次
      effectTime 落在 ``[period_start, period_end]` 统计）；起止均未传时为
      null（前端提示未配置）；
    - ``period_hit_count``：重保时间范围内产生条目的拦截（命中）次数总和；
      未配置范围时为 null。

    设备接口异常时返回 ``ok=false`` + ``error``（HTTP 仍为 200），前端据此降级：
    保留最近一次成功快照并给出错误提示，而非空白。全量拉取结果后端缓存 10 秒，
    卡片高频轮询不会逐次打到设备。
    """
    if (period_start is None) != (period_end is None):
        raise HTTPException(status_code=400, detail="重保时间范围需同时提供起止时间")
    ps = period_start.replace(tzinfo=None) if period_start and period_start.tzinfo else period_start
    pe = period_end.replace(tzinfo=None) if period_end and period_end.tzinfo else period_end
    if ps and pe and pe < ps:
        raise HTTPException(status_code=400, detail="重保时间范围终点不能早于起点")

    def _payload(ok, total, period_count, total_hit=None, period_hit=None, error=None, truncated=False) -> dict:
        return {
            "ok": ok,
            "error": error,
            "total": total,
            "total_hit_count": total_hit,
            "period_count": period_count,
            "period_hit_count": period_hit,
            "period_start": ps.isoformat() if ps else None,
            "period_end": pe.isoformat() if pe else None,
            "truncated": truncated,
            "fetched_at": beijing_now().isoformat(),
        }

    # 全量拉取（内部已同步命中累计表；缓存命中时直接用表内累计值）
    _, err, truncated = _fetch_full_blacklist(db)
    if err:
        logger.warning("大屏封禁IP统计失败: %s", err)
        return _payload(False, None, None, error=err)
    # 历史累计口径：从命中累计表聚合（解封/到期条目仍计数，只增不减）
    total = db.query(func.count(BanHitStat.id)).scalar() or 0
    total_hit_count = db.query(func.coalesce(func.sum(BanHitStat.hit_total), 0)).scalar() or 0
    period_count = None
    period_hit_count = None
    if ps and pe:
        period_q = db.query(BanHitStat).filter(
            BanHitStat.effect_time.isnot(None),
            BanHitStat.effect_time >= ps,
            BanHitStat.effect_time <= pe,
        )
        period_count = period_q.count()
        period_hit_count = (
            period_q.with_entities(func.coalesce(func.sum(BanHitStat.hit_total), 0)).scalar() or 0
        )
    return _payload(True, total, period_count, total_hit=total_hit_count,
                    period_hit=period_hit_count, truncated=truncated)


# 重保期间每日拦截趋势最大天数（避免误配超长范围时返回上千日桶；超出时仅保留最近 N 天）
_INTERCEPT_TREND_MAX_DAYS = 366


@router.get("/monitor/ban-intercept-trend")
def ticket_monitor_ban_intercept_trend(
    period_start: datetime | None = Query(default=None, description="重保时间范围起点（ISO 格式）"),
    period_end: datetime | None = Query(default=None, description="重保时间范围终点（ISO 格式）"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_monitor", "view")),
):
    """重保期间每日拦截次数趋势（大屏右上「重保拦截趋势」卡专用）。

    按日分桶统计重保时间范围内「产生」的黑名单条目命中（拦截）次数（历史累计
    口径，数据源 ban_hit_stats 命中累计表）：某日拦截次数 = 最近一次 effectTime
    落在该日的条目累计命中（hit_total）之和，同时返回该日新增条目数 ban_count
    （辅助口径）。逐日求和与 ``/monitor/ban-live`` 的 ``period_hit_count``
    完全一致（同一条目集合同一口径），两卡数字可互相核对。

    - 起止必须同时提供且起点不晚于终点（否则 HTTP 400）；
    - 范围终点晚于当前时间时截断到今天（未来天数无数据不返回）；
    - 范围跨度超过 366 天时仅返回最近 366 天（window_truncated=true）。

    设备接口异常时返回 200 + ok=false + error（前端降级保留最近快照）；
    全量拉取结果与 ban-live 共享 10 秒缓存，两卡轮询不会重复打设备。
    """
    if period_start is None or period_end is None:
        raise HTTPException(status_code=400, detail="重保时间范围需同时提供起止时间")
    ps = period_start.replace(tzinfo=None) if period_start.tzinfo else period_start
    pe = period_end.replace(tzinfo=None) if period_end.tzinfo else period_end
    if pe < ps:
        raise HTTPException(status_code=400, detail="重保时间范围终点不能早于起点")

    def _payload(ok: bool, days=None, error=None, window_truncated=False) -> dict:
        return {
            "ok": ok,
            "error": error,
            "days": days or [],
            "window_truncated": window_truncated,
            "period_start": ps.isoformat(),
            "period_end": pe.isoformat(),
            "fetched_at": beijing_now().isoformat(),
        }

    # 全量拉取（内部已同步命中累计表）+ 从累计表按日分桶（历史累计口径）
    _, err, _ = _fetch_full_blacklist(db)
    if err:
        logger.warning("大屏重保拦截趋势获取黑名单失败: %s", err)
        return _payload(False, error=err)

    # 日桶序列：从起点当日到 min(终点, 今天)；跨度超上限时仅保留最近 N 天
    first_day = ps.replace(hour=0, minute=0, second=0, microsecond=0)
    last_day = min(pe, beijing_now()).replace(hour=0, minute=0, second=0, microsecond=0)
    total_days = (last_day - first_day).days + 1
    window_truncated = total_days > _INTERCEPT_TREND_MAX_DAYS
    if window_truncated:
        first_day = last_day - timedelta(days=_INTERCEPT_TREND_MAX_DAYS - 1)
        total_days = _INTERCEPT_TREND_MAX_DAYS

    counts = [0] * total_days
    bans = [0] * total_days
    for eff, hit_total in (
        db.query(BanHitStat.effect_time, BanHitStat.hit_total)
        .filter(BanHitStat.effect_time.isnot(None))
        .all()
    ):
        idx = (eff.replace(hour=0, minute=0, second=0, microsecond=0) - first_day).days
        if 0 <= idx < total_days:
            counts[idx] += hit_total or 0
            bans[idx] += 1
    days = []
    for i in range(total_days):
        d = first_day + timedelta(days=i)
        days.append({"date": d.date().isoformat(), "count": counts[i], "ban_count": bans[i]})
    return _payload(True, days=days, window_truncated=window_truncated)


@router.get("/monitor")
def ticket_monitor_stats(
    flow_id: int | None = Query(default=None, description="指定流程模板 ID；缺省时自动选取进行中工单最多的流程"),
    light: bool = Query(default=False, description="轻量模式：仅返回 kpi + latest（供大屏高频轮询）"),
    include_drill: bool = Query(default=True, description="是否下发下钻工单集（大屏按需拉取时可关闭以减小响应体）"),
    drill_limit: int = Query(default=2000, ge=100, le=2000, description="下钻工单集条数上限（最新在前）"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_monitor", "view")),
):
    """工单监控大屏聚合数据（KPI / 趋势 / 分布 / 团队排名 / 来源平台 / 封禁IP / 流转节点 / 最新工单）。

    数据均来自真实工单（排除归档），按大屏七个分区一次返回；大屏按「轻量 → 全景」分层轮询：
    ``light=1`` 只算 KPI + 最新工单（高频），全景（趋势/分布/团队/平台/封禁/流转/下钻集）低频刷新。
    ``include_drill=0`` 不下发下钻工单集（默认轮询用），大屏打开下钻弹窗时再按需请求。
    需要独立权限 ticket_monitor:view（叠加 router 级 ticket:view）。
    提交团队排名 ``team_stats``：按各流程模板首节点「提交团队」字段聚合（按 label 定位，
    跨模板字段 key 兼容），全流程口径，降序 ``[{name, value}]``。
    下钻工单集 ``tickets``：大屏各分区点击弹窗逐级下钻的数据源，字段口径与各分区统计
    严格一致（team/platform/alert_type/active_today/timeout 等）；极端存量下仅返回最近
    2000 件并以 ``tickets_truncated`` 标记。
    下钻封禁记录集 ``ban_records``：大屏「封禁IP统计」卡点击弹窗的数据源（历史累计
    去重口径：一个 IP 一行 = 该 IP 最新一条记录 + ``ban_count`` 历史封禁次数，
    含已解封/已到期）；同样仅在 ``include_drill=1`` 时下发，极端存量下仅返回
    最近 2000 个 IP 并以 ``ban_records_truncated`` 标记。
    处置状态流转：``flow_id`` 可指定展示的流程模板；节点序列始终读取模板**当前定义**，
    修改并重新发布模板后大屏在下次轮询自动更新。响应附 ``flows``（可选流程列表）与
    ``flow``（当前生效流程及是否自动选取）。末位「已完结」节点的件数为全流程已解决
    （``completed``）工单数，不随 ``flow_id`` 变化（与 KPI「已解决」口径一致）。
    注意：本路由必须注册在 ``GET /{ticket_id}`` 之前，避免 "monitor" 被路径参数吞掉。
    """
    # 轻量模式响应小，正常返回 dict；全景走预渲染 JSON 缓存直接回发（跳过
    # jsonable_encoder 对约 2MB 大响应的逐次编码）
    if light:
        return ticket_monitor_payload(db, light=True)
    return Response(
        content=ticket_monitor_payload_json(
            db, flow_id=flow_id, include_drill=include_drill, drill_limit=drill_limit
        ),
        media_type="application/json",
    )


# —— 大屏全景聚合 TTL 缓存 + single-flight（与 _blacklist_* 同款模式）——
# 全景聚合每次全量加载工单/流转记录并逐单 SLA 评估，CPU 密集且持有 GIL；大屏
# 多端（内部路由 + 开放 API）高频轮询叠加时单进程即被打满，拖慢全站数据加载。
# 相同参数（flow_id / include_drill / drill_limit）的并发请求共用首个请求的重算
# 结果，TTL 内直接命中缓存；light 模式本身走 SQL 聚合开销小，不缓存。
# TTL 取 15s 对齐大屏默认刷新间隔；缓存同时保存预渲染 JSON（全景响应约 2MB，
# jsonable_encoder 逐次编码约 0.2s，直接回放缓存字符串近乎零开销）。
_MONITOR_PAYLOAD_CACHE_TTL_SECONDS = 15.0
_monitor_payload_cache: dict[tuple, dict] = {}
_monitor_payload_cache_lock = threading.Lock()
_monitor_payload_fetch_lock = threading.Lock()


def ticket_monitor_payload(
    db: Session,
    flow_id: int | None = None,
    light: bool = False,
    include_drill: bool = True,
    drill_limit: int = 2000,
) -> dict:
    """工单监控大屏聚合数据核心（内部路由 ``GET /tickets/monitor`` 与开放 API 资源共用）。

    响应结构：KPI / 趋势 / 分布 / 团队排名 / 来源平台 / 封禁IP / 流转节点 /
    最新工单 / 下钻集，与 ``GET /tickets/monitor`` 完全一致。
    全景结果按 (flow_id, include_drill, drill_limit) 缓存 15 秒，并发请求
    single-flight 合并重算；light 模式直接走 SQL 聚合，不经过缓存。
    """
    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # 轻量模式：只算高频区（SQL 聚合 KPI + 最新工单），不加载全量工单/流转记录
    if light:
        return _monitor_light(db, now, today_start)

    cache_key = (flow_id, bool(include_drill), int(drill_limit))
    now_ts = time.monotonic()
    with _monitor_payload_cache_lock:
        hit = _monitor_payload_cache.get(cache_key)
        if hit and now_ts - hit["at"] < _MONITOR_PAYLOAD_CACHE_TTL_SECONDS:
            return hit["payload"]

    with _monitor_payload_fetch_lock:
        # 等锁期间同参请求可能已完成重算并刷新缓存：double-check 后直接复用
        now_ts = time.monotonic()
        with _monitor_payload_cache_lock:
            hit = _monitor_payload_cache.get(cache_key)
            if hit and now_ts - hit["at"] < _MONITOR_PAYLOAD_CACHE_TTL_SECONDS:
                return hit["payload"]

        payload = _ticket_monitor_payload_full(db, flow_id, include_drill, drill_limit)
        # single-flight 内完成渲染，等锁的请求直接回放预渲染 JSON
        rendered = json.dumps(payload, ensure_ascii=False)
        with _monitor_payload_cache_lock:
            # 顺带清理长期无人访问的过期项，防止 flow_id/drill_limit 参数组合膨胀
            for k in [
                k for k, v in _monitor_payload_cache.items()
                if now_ts - v["at"] >= _MONITOR_PAYLOAD_CACHE_TTL_SECONDS * 6
            ]:
                _monitor_payload_cache.pop(k, None)
            _monitor_payload_cache[cache_key] = {"at": now_ts, "payload": payload, "json": rendered}
        return payload


def ticket_monitor_payload_json(
    db: Session,
    flow_id: int | None = None,
    include_drill: bool = True,
    drill_limit: int = 2000,
) -> str:
    """大屏全景聚合的预渲染 JSON（与 ``ticket_monitor_payload`` 同一份缓存）。

    大响应（约 2MB）逐次走 jsonable_encoder 编码开销显著；本函数返回缓存中的
    预渲染字符串供路由直接以 ``Response`` 回发，跳过逐次编码。缓存未命中时
    触发重算并渲染（渲染已在 single-flight 内完成，此处必有结果）。
    """
    cache_key = (flow_id, bool(include_drill), int(drill_limit))
    with _monitor_payload_cache_lock:
        hit = _monitor_payload_cache.get(cache_key)
        if hit and time.monotonic() - hit["at"] < _MONITOR_PAYLOAD_CACHE_TTL_SECONDS:
            return hit["json"]
    payload = ticket_monitor_payload(db, flow_id=flow_id, include_drill=include_drill, drill_limit=drill_limit)
    with _monitor_payload_cache_lock:
        hit = _monitor_payload_cache.get(cache_key) or {}
        if "json" not in hit:
            hit["json"] = json.dumps(payload, ensure_ascii=False)
        return hit["json"]


def _ticket_monitor_payload_full(
    db: Session,
    flow_id: int | None,
    include_drill: bool,
    drill_limit: int,
) -> dict:
    """大屏全景聚合重算（无缓存）：全量加载 + 应用侧统计，仅由缓存层 single-flight 调用。"""
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

    # 统计口径：暂停工单仍属于「处理中」，SLA 计时冻结但不脱离待办
    processing = [t for t in tickets if t.status in ("processing", "paused")]
    completed = [t for t in tickets if t.status == "completed"]
    cancelled = [t for t in tickets if t.status == "cancelled"]
    finished = [t for t in tickets if t.closed_at is not None]

    # —— SLA 目标口径评估（按优先级目标：响应=发起→首次提交，解决=创建→关闭）——
    sla_config = get_sla_config(db)
    # 暂停中 SLA 冻结：以暂停时刻作为评估基准
    sla_eval: dict[int, dict] = {
        t.id: evaluate_ticket_sla(
            t, by_ticket.get(t.id, []),
            (t.paused_at or now) if t.status == "paused" else now,
            sla_config,
        )
        for t in tickets
    }

    # —— KPI：今日活跃（处理中）= 今日有提交流转且仍在进行中 ——
    today_submit_ids = {
        r.ticket_id
        for r in records
        if r.action == "submit" and r.created_at and r.created_at >= today_start
    }
    active_now = [t for t in processing if t.id in today_submit_ids]
    # 超时预警口径：与工单中心「超时」筛选一致（暂停工单按暂停时刻冻结评估）
    timeout_warn = [
        t for t in processing
        if _ticket_overdue(t, by_ticket.get(t.id, []), now, sla_config)
    ]
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
            "timeout": _ticket_overdue(t, by_ticket.get(t.id, []), now, sla_config),
            "remind_count": t.remind_count or 0,
        })

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

    # —— 首节点语义字段定位（按 label 匹配，跨模板 key 兼容）——
    # 不同模板同一语义字段的 key 可能不同（告警名称 alert_type/alert_name、提交团队 f10），
    # 按 label 在模板首节点定义中定位字段 key；旧工单发起时的模板若无该字段则取不到值（口径自然正确）。
    # all_flows 在此提前查询，下方流转统计段复用，避免重复查库。
    all_flows = db.query(TicketFlow).order_by(TicketFlow.id).all()
    flow_by_id = {f.id: f for f in all_flows}

    def _start_field_key(flow, labels=(), key_aliases=()):
        node = get_start_node(flow.nodes or {}) if flow else None
        for fld in (node or {}).get("fields") or []:
            if isinstance(fld, dict) and fld.get("key") and (
                str(fld.get("label") or "") in labels or fld["key"] in key_aliases
            ):
                return fld["key"]
        return None

    # 语义名 → 各流程首节点字段 key（提交团队 / 告警平台 / 告警名称 / 源 IP）
    flow_start_keys: dict[int, dict] = {
        f.id: {
            "team": _start_field_key(f, labels=("提交团队",)),
            "platform": _start_field_key(f, labels=("告警平台", "来源平台"), key_aliases=("alert_platform",)),
            "alert_type": _start_field_key(
                f, labels=("告警名称", "告警类型", "事件类型"), key_aliases=("alert_type", "alert_name")
            ),
            "src_ip": _start_field_key(
                f, labels=("源IP地址", "源 IP 地址", "主机IP地址"), key_aliases=("src_ip", "host_ip")
            ),
        }
        for f in all_flows
    }

    def _start_value(t, name):
        """读工单发起（create）记录的首节点字段值；语义字段 key 按流程模板 label 定位。"""
        rec = first_record.get(t.id)
        if not rec:
            return None
        key = flow_start_keys.get(t.flow_id, {}).get(name)
        return (rec.field_values or {}).get(key) if key else None

    priority_dist = _count_by(tickets, lambda t: t.priority)
    type_dist = _count_by(tickets, lambda t: _start_value(t, "alert_type"))

    # —— 来源平台统计：工单总量 / 今日新增 / 待处理 / 处理中(今日活跃) / 已解决 / 已取消（口径与顶部 KPI 一致）——
    platform_rows: dict[str, dict] = {}
    for t in tickets:
        platform = _start_value(t, "platform")
        if not platform:
            continue
        row = platform_rows.setdefault(platform, {
            "name": platform,
            "total": 0,
            "today_new": 0,
            "pending": 0,
            "processing_active": 0,
            "completed": 0,
            "cancelled": 0,
        })
        row["total"] += 1
        if t.created_at and t.created_at >= today_start:
            row["today_new"] += 1
        if t.status in ("processing", "paused"):
            row["pending"] += 1
            if t.id in today_submit_ids:
                row["processing_active"] += 1
        elif t.status == "completed":
            row["completed"] += 1
        elif t.status == "cancelled":
            row["cancelled"] += 1
    platform_stats = sorted(platform_rows.values(), key=lambda r: -r["total"])
    # —— 提交团队排名（大屏团队排名条）：按各流程首节点「提交团队」字段聚合，全流程口径 ——
    team_stats = _count_by(tickets, lambda t: _start_value(t, "team"))
    severity_status = []
    for p in ("critical", "high", "medium", "low"):
        row = {"name": PRIORITY_LABELS.get(p, p), "processing": 0, "completed": 0, "cancelled": 0}
        for t in tickets:
            if t.priority == p:
                # 暂停计入处理中（与 KPI 待处理口径一致）
                key = "processing" if t.status == "paused" else t.status
                row[key] = row.get(key, 0) + 1
        severity_status.append(row)

    # —— 封禁 IP 统计（大屏右栏「封禁IP统计」卡）：历史累计口径，按去重 IP 统计 ——
    # 一个 IP 只算一次（多次封禁 / 解封 / 到期不重复计数，只增不减）；已解封、已到期
    # 的记录仍计数。cancelled（审批拒绝 / 流程取消，从未真正下发设备）的记录不参与。
    # 来源归类取该 IP 最新一条记录的 ban_source，保证 手动 + 工单同步 + 其他 = 总数
    # （构成环各分量不重叠，与下钻列表「一个 IP 一行」严格同口径）。
    _latest_ban_sq = (
        db.query(BanRecord.ip.label("ip"), func.max(BanRecord.id).label("rid"))
        .filter(BanRecord.status != "cancelled")
        .group_by(BanRecord.ip)
        .subquery()
    )
    _ban_source_counts: dict[str, int] = dict(
        db.query(BanRecord.ban_source, func.count())
        .join(_latest_ban_sq, BanRecord.id == _latest_ban_sq.c.rid)
        .group_by(BanRecord.ban_source)
        .all()
    )
    ban_stats = {
        "total": sum(_ban_source_counts.values()),
        "manual": _ban_source_counts.get("manual", 0),
        "ticket": _ban_source_counts.get("ticket", 0),
    }

    # 分组名映射（用于流转节点显示处理分组）
    group_map = {g.id: g.name for g in db.query(TicketGroup).all()}

    # —— 处置状态流转：可指定流程（?flow_id=）或自动选取（进行中工单最多 / 最新）——
    # 节点序列始终读取流程模板当前定义（而非工单发起时的旧快照），模板修改重新发布后自动生效
    # （all_flows / flow_by_id 已在首节点字段定位段查询，此处复用）
    flow_count: dict[int, int] = {}
    for t in processing:
        flow_count[t.flow_id] = flow_count.get(t.flow_id, 0) + 1
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
    # 已完结计数 = 全流程已解决（completed）工单数，不随所选流程变化（与 KPI「已解决」口径一致）
    flow_finished = len(completed)
    flow_nodes.append({
        "key": "_finished",
        "name": "已完结",
        "group": "",
        "current": flow_finished,
    })

    # —— 处置状态流转泳道：所有已启用流程模板各一条泳道（大屏多泳道展示，无需切换）——
    # 每条泳道节点序列读取流程模板当前定义（与单流程 flow_nodes 同口径），进行中工单按
    # (flow_id, node_key) 统计停留。所有泳道最终汇聚到统一的「已完结」终态节点（前端
    # 泳道区右侧共享节点卡，全部流程共用的最终状态）：数值直接复用 KPI「已解决」总数
    # （len(completed)，与单流程 flow_nodes 的 _finished 同源），不按流程单独统计；
    # 已取消工单不属于处置流转路径，不在流转图中展示（KPI / 等级分布等模块不受影响）。
    # 边界兜底：停用 / 草稿 / 已删除流程名下的进行中存量工单归入末位「其他流程」合成泳道；
    # 模板改版后 current_node_key 不在当前节点定义中的进行中工单归入「其他位置」合成节点卡。
    # 泳道按进行中工单数降序，「其他流程」恒排末位；节点 key 跨流程可能重名，泳道内天然隔离。
    _flow_key_counts: dict[tuple[int, str], int] = {}
    for t in processing:
        if t.current_node_key:
            k = (t.flow_id, t.current_node_key)
            _flow_key_counts[k] = _flow_key_counts.get(k, 0) + 1
    flow_lanes: list[dict] = []
    for f in all_flows:
        if f.is_draft or not f.enabled:
            continue
        lane_nodes = [
            {
                "key": n.get("key"),
                "name": n.get("name"),
                "group": group_map.get(n.get("group_id"), ""),
                "current": _flow_key_counts.get((f.id, n.get("key")), 0),
            }
            for n in (f.nodes or {}).get("nodes", [])
            if n.get("type") != "end"
        ]
        # 「其他位置」兜底：本流程进行中数 - 各节点停留数之和 = 停留节点不在当前模板
        # 定义中的工单数（模板重发布后节点 key 变更 / current_node_key 为空），保证
        # Σ节点卡停留数 = 本泳道进行中数，泳道内部自洽
        lane_processing = flow_count.get(f.id, 0)
        unmatched = lane_processing - sum(n["current"] for n in lane_nodes)
        if unmatched > 0:
            lane_nodes.append({
                "key": "_other",
                "name": "其他位置",
                "group": "",
                "current": unmatched,
            })
        flow_lanes.append({
            "flow_id": f.id,
            "flow_name": f.name,
            "processing_count": lane_processing,
            "nodes": lane_nodes,
        })
    flow_lanes.sort(key=lambda x: -x["processing_count"])
    # 「其他流程」合成泳道：启用流程集合之外（停用 / 草稿 / 已删除模板）名下的存量
    # 进行中工单承接。无节点链（模板定义不可用），exclude_flow_ids 供前端下钻过滤
    # （弹窗匹配 flow_id 不在启用流程集合中的工单，与泳道计数严格同口径）。
    _active_flow_ids = {f.id for f in all_flows if not f.is_draft and f.enabled}
    other_processing = sum(c for fid, c in flow_count.items() if fid not in _active_flow_ids)
    if other_processing:
        flow_lanes.append({
            "flow_id": None,
            "flow_name": "其他流程",
            "synthetic": True,
            "processing_count": other_processing,
            "nodes": [],
            "exclude_flow_ids": sorted(_active_flow_ids),
        })

    # —— 下钻工单集（大屏各分区弹窗逐级下钻的数据源）——
    # 字段口径与各分区统计严格一致：team/platform/alert_type 与团队排名、来源平台、
    # 类型分布同源（首节点语义字段）；active_today 与 KPI「处理中」卡「今日活跃」小字一致；
    # timeout 与 SLA 超时预警一致；nodeKey 与流转节点停留一致（前端按 flow_id + current_node_key
    # 过滤）；status=completed 与流转图「已完结」计数一致（全流程已解决口径）。
    # 上限保护：极端存量下仅返回最近创建的工单。
    # include_drill=False 时不构造下钻集（大屏常规轮询用，打开弹窗时再按需请求）。
    drill_source = sorted(tickets, key=lambda x: x.created_at or now, reverse=True)
    drill_total = len(drill_source)
    drill_truncated = drill_total > drill_limit
    drill_tickets = []
    if include_drill:
        for t in drill_source[:drill_limit]:
            ev = sla_eval[t.id]
            drill_tickets.append({
                "id": t.id,
                "ticket_no": t.ticket_no,
                "title": t.title,
                "flow_id": t.flow_id,
                "priority": t.priority,
                "priority_label": PRIORITY_LABELS.get(t.priority, t.priority),
                "status": t.status,
                "status_label": STATUS_LABELS.get(t.status, t.status),
                "team": _start_value(t, "team"),
                "platform": _start_value(t, "platform"),
                "alert_type": _start_value(t, "alert_type"),
                "src_ip": _start_value(t, "src_ip"),
                "current_node_key": t.current_node_key,
                "current_node_name": t.current_node_name,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "closed_at": t.closed_at.isoformat() if t.closed_at else None,
                # 统计分组：暂停工单归属「处理中」，供大屏下钻筛选与 KPI 同口径
                "status_group": "processing" if t.status in ("processing", "paused") else t.status,
                # SLA 超时预警（口径与工单中心超时筛选一致；暂停工单冻结评估）
                "timeout": _ticket_overdue(t, by_ticket.get(t.id, []), now, sla_config),
                # 今日活跃（进行中且今日有提交流转），与 KPI processing_active 口径一致
                "active_today": t.status in ("processing", "paused") and t.id in today_submit_ids,
                "response_minutes": ev["response_minutes"],
                "resolve_minutes": ev["resolve_minutes"],
            })

    # —— 下钻封禁记录集（大屏「封禁IP统计」卡点击弹窗数据源）——
    # 与 ban_stats 同口径（历史累计去重 IP）：一个 IP 一行，取该 IP 最新一条记录
    # （含已解封 / 已到期，状态见 status 字段），附 ban_count = 该 IP 历史封禁次数；
    # 仅 include_drill=True 时构造（与下钻工单集同策略，常规轮询不下发）；最新在前，
    # 极端存量下仅返回最近 drill_limit 个 IP 并以 ban_records_truncated 标记。
    # 工单同步来源附 ticket_id/ticket_no，供前端弹窗内继续下钻来源工单详情。
    ban_records: list[dict] = []
    ban_records_truncated = False
    if include_drill:
        latest_bans = (
            db.query(BanRecord)
            .join(_latest_ban_sq, BanRecord.id == _latest_ban_sq.c.rid)
            .order_by(BanRecord.id.desc())
            .limit(drill_limit)
            .all()
        )
        ban_records_truncated = ban_stats["total"] > drill_limit
        # 本批 IP 的历史封禁次数（仅聚合本次下发的 IP，避免全量扫描）
        ban_ip_counts: dict[str, int] = (
            dict(
                db.query(BanRecord.ip, func.count())
                .filter(
                    BanRecord.status != "cancelled",
                    BanRecord.ip.in_([r.ip for r in latest_bans]),
                )
                .group_by(BanRecord.ip)
                .all()
            )
            if latest_bans
            else {}
        )
        for r in latest_bans:
            ban_records.append({
                "id": r.id,
                "ip": r.ip,
                "ban_source": r.ban_source or "auto",
                "ban_level": r.ban_level,
                "is_permanent": r.is_permanent,
                "ban_duration": r.ban_duration,
                "expire_time": r.expire_time.isoformat() if r.expire_time else None,
                # 最新一条记录状态（active=生效中 / unbanned=已解封 / expired=已到期…）
                "status": r.status,
                # 该 IP 历史封禁次数（含已解封 / 到期，去重统计的辅助信息）
                "ban_count": ban_ip_counts.get(r.ip, 1),
                # 工单同步来源信息（ban_source=ticket 时有值）
                "ticket_id": r.ticket_id,
                "ticket_no": r.ticket_no,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            })

    return {
        "generated_at": now.isoformat(),
        "light": False,
        "kpi": kpi,
        "latest": latest,
        "trend": trend,
        "dist": {"priority": priority_dist, "type": type_dist},
        # 来源平台统计表：各平台 工单总量 / 今日新增 / 待处理 / 处理中(今日活跃) / 已解决 / 已取消
        "platform_stats": platform_stats,
        # 提交团队排名：各流程首节点「提交团队」字段聚合（降序 [{name, value}]）
        "team_stats": team_stats,
        # 下钻工单集：各分区点击弹窗逐级下钻的数据源（最新在前；
        # tickets_truncated=True 时仅含最近 drill_limit 件，前端弹窗内提示）
        "tickets": drill_tickets,
        "tickets_truncated": drill_truncated,
        "tickets_total": drill_total,
        # 下钻封禁记录集：封禁IP统计卡弹窗数据源（一个 IP 一行；
        # ban_records_truncated=True 时仅最近 drill_limit 个 IP）
        "ban_records": ban_records,
        "ban_records_truncated": ban_records_truncated,
        "severity_status": severity_status,
        # 封禁 IP 统计：历史累计去重 IP 数（total/manual=手动封禁/ticket=工单同步封禁，
        # 解封 / 到期不减少；来源按各 IP 最新记录归类，分量之和 = total）
        "ban_stats": ban_stats,
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
        # 处置状态流转泳道（大屏多泳道展示）：全部已启用流程按进行中工单数降序 + 末位
        # 「其他流程」合成泳道兜底（停用/草稿/已删除模板的存量进行中工单，仅有存量时存在）。
        # [{flow_id, flow_name, synthetic?, processing_count, exclude_flow_ids?,
        #   nodes: [{key, name, group, current}]}]
        # 所有泳道最终汇聚到统一「已完结」终态节点（数值复用 KPI「已解决」总数，
        # 前端从 kpi.completed 直读），不在此字段下发；已取消不在流转图展示。
        "flow_lanes": flow_lanes,
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
    status: str | None = Query(default=None, pattern="^(processing|paused|completed|cancelled)$"),
    flow_id: int | None = Query(default=None),
    priority: str | None = Query(default=None, pattern="^(low|medium|high|critical)$"),
    archived: str = Query(default="exclude", pattern="^(exclude|only|include)$"),
    q: str | None = Query(default=None, max_length=100),
    timeout_only: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """按当前筛选条件导出工单 CSV（UTF-8 BOM，Excel 可直接打开）。

    列：工单号/标题/流程/状态/优先级/发起人/当前节点/当前处理分组/发起时间/完结时间/
    处理时长分钟/SLA状态/表单字段内容（按节点·字段 label 汇总）/处置意见汇总。
    """
    query = _apply_ticket_filters(
        db, current_user, view, status, flow_id, priority, archived, q,
        timeout_only=timeout_only,
    )
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
        # 处理时长：完结=创建→关闭；进行中=创建→现在；暂停中冻结且扣除已暂停时长
        duration = ""
        if t.created_at:
            end_at = t.paused_at if t.status == "paused" else (t.closed_at or now)
            minutes = int((end_at - t.created_at).total_seconds() // 60) - int(t.pause_total_minutes or 0)
            duration = str(max(0, minutes))
        # SLA 状态：暂停中冻结，进行中显示倒计时，完结显示实际是否超时
        sla_text = ""
        if t.status in ("processing", "paused"):
            sla_now = (t.paused_at or now) if t.status == "paused" else now
            remaining, overdue, has_target = _sla_remaining(t, records, sla_now, sla_config)
            if remaining is not None:
                sla_text = ("超时 " if overdue else "剩余 ") + _fmt_duration(remaining)
                if t.status == "paused":
                    sla_text = "暂停中（冻结）· " + sla_text
            elif t.status == "paused" and has_target:
                sla_text = "暂停中（冻结）"
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
            (_csv_formula_safe(t.current_node_name) + ("（已暂停）" if t.status == "paused" else ""))
            if t.status in ("processing", "paused") else "",
            _csv_formula_safe(group_names.get(t.current_group_id, ""))
            if t.status in ("processing", "paused") else "",
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
    """字段值 → 首个有效 IP（支持多值 / CIDR / 范围 / 通配；无效返回 None）。

    与自动研判的 IP 提取口径一致：多值取首个有效片段，CIDR/范围/通配取
    区间起始地址参与比对（IPv4 与 IPv6 均支持）。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    from app.core.ip_validation import parse_ip_token, split_ip_expression

    for part in split_ip_expression(s):
        try:
            iv = parse_ip_token(part)
        except ValueError:
            continue
        cls = ipaddress.IPv6Address if iv.version == 6 else ipaddress.IPv4Address
        return str(cls(iv.start))
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


@router.get("/ban-status")
def get_ban_status(
    ips: str = Query(..., description="逗号分隔的 IP 列表，最多 20 个"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """批量查询 IP 封禁状态：改为通过安博通阻断器「查询指定黑名单」动作实时查询。

    - 设备/动作不可用时返回 device=None + device_error（HTTP 200），前端展示引导信息；
    - 每个 IP 返回 {banned, entry(设备返回的全部字段), raw(原始响应), error}；
    - 并发查询（每 IP 一次设备调用，超时收敛，避免页面久等）。
    """
    from concurrent.futures import ThreadPoolExecutor

    from app.devices.anbotong import (
        QUERY_TIMEOUT_CAP_SECONDS, find_anbotong_action, query_blacklist_entry,
    )

    ip_list = list(dict.fromkeys(x.strip() for x in ips.split(",") if x.strip()))
    if not ip_list:
        raise HTTPException(status_code=400, detail="请提供至少一个 IP 地址")
    if len(ip_list) > 20:
        raise HTTPException(status_code=400, detail="单次最多查询 20 个 IP")

    device, action, dev_err = find_anbotong_action(db, "query")
    if dev_err:
        # 设备未接入/动作未配置：不抛 5xx，带说明返回，前端可给出配置引导
        logger.warning("工单封禁查询不可用: %s", dev_err)
        return {
            "device": None,
            "device_error": dev_err,
            "results": {ip: {"banned": False, "entry": None, "raw": None, "error": dev_err}
                        for ip in ip_list},
        }

    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(ip_list), 8)) as pool:
        futures = {
            ip: pool.submit(query_blacklist_entry, device, action, ip, timeout=timeout)
            for ip in ip_list
        }
        for ip, fut in futures.items():
            r = fut.result()
            results[ip] = {
                "banned": bool(r.get("found")),
                "entry": r.get("entry"),
                "raw": r.get("response_body"),
                "error": r.get("error"),
                "note": r.get("note"),
            }
    return {
        "device": {"id": device.id, "name": device.name},
        "device_error": None,
        "results": results,
    }


# ============ 暂停策略配置 ============
# 注意：必须定义在 /{ticket_id} 之前，避免 "pause-config" 被当作工单 ID 解析

@router.get("/pause-options")
def get_ticket_pause_options(
    db: Session = Depends(get_db),
) -> dict:
    """暂停类型选项（启用中的分类）：批量暂停弹窗等无工单上下文场景使用。"""
    config = get_pause_config(db)
    items = [
        {
            "code": code,
            "label": item.get("label") or code,
            "max_minutes": item.get("max_minutes"),
            "require_expected_resume": bool(item.get("require_expected_resume")),
            "required_detail_keys": list(REQUIRED_DETAIL_KEYS.get(code, ())),
            "allow_batch": bool(item.get("allow_batch", True)),
        }
        for code, item in (config.get("types") or {}).items()
        if isinstance(item, dict) and item.get("enabled", True)
    ]
    return {"enabled": bool(config.get("enabled", True)), "items": items}


@router.get("/pause-config")
def get_ticket_pause_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "view")),
) -> dict:
    """读取暂停策略（未配置时返回内置默认值）。"""
    return get_pause_config(db)


@router.put("/pause-config")
def update_ticket_pause_config(
    body: TicketPauseConfigUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket_config", "edit")),
) -> dict:
    """保存暂停策略：分类时效、提醒阈值、到期处置与兜底分组。"""
    try:
        config = save_pause_config(db, body.model_dump())
    except PauseError as exc:
        db.rollback()
        raise _pause_error(exc) from exc
    write_audit(
        db, action="ticket_pause_config_update", resource_type="ticket_config",
        resource_id=0,
        detail={
            "enabled": config.get("enabled"),
            "max_pause_minutes": config.get("max_pause_minutes"),
            "types": {
                code: {"enabled": item.get("enabled"), "max_minutes": item.get("max_minutes")}
                for code, item in (config.get("types") or {}).items()
            },
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("更新工单暂停策略: operator=%s", current_user.username)
    return config


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

    旧版封禁同步（ban_sync 字段映射）的执行兼容：配置入口已从流程编辑器下线，
    仅存量已发布模板未经重存前仍按此逻辑同步；新能力由设备动作的工作台同步覆盖。
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
    # 封禁目标硬拦截：单 IP / CIDR / 范围 / 域名 / 多值（与人工封禁同一套规则）
    from app.core.ip_validation import IPValidationError, validate_ban_entry

    try:
        ip = validate_ban_entry(ip, "封禁目标")
    except IPValidationError as exc:
        logger.warning(
            "封禁同步跳过（封禁目标非法: %s）: ticket=%s node=%s",
            exc, ticket.ticket_no, node.get("key"),
        )
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
        reason=f"工单同步：{ticket.ticket_no}",
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


def _submit_node_record(
    ticket: Ticket,
    current_node: dict,
    current_user: User,
    pending: set,
    my_groups: set,
    *,
    values: dict,
    route_to: str | None,
    comment: str | None,
) -> TicketNodeRecord:
    """构造提交流转的节点记录（不含设备结果，device_result 由调用方按需回填）。

    并行会签节点取本分组 ID（无待签分组时为空）；普通节点取节点配置分组。
    advance_ticket 的「绑定/未绑定设备动作」两个分支共用，避免记录结构漂移。
    """
    group_id = (
        current_node.get("group_id")
        if current_node.get("type") != "parallel"
        else (min(pending & my_groups) if (pending & my_groups) else None)
    )
    return TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=current_node.get("key") or "",
        node_name=current_node.get("name") or "",
        group_id=group_id,
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="submit",
        field_values=values,
        device_result=None,
        route_to=route_to,
        comment=comment,
    )


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
    - 命中设备动作：参数定稿后落库排队，由 Celery Worker 异步下发；
      触发需独立权限 ``ticket:execute``，失败可在时间线重试，封禁成功可撤销
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    _reject_if_paused(ticket, "流转")
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

    device_result = None
    queued_runs: list[TicketDeviceRun] = []
    # 判断字段命中优先级：本次提交的表单值（本节点字段联动）> 历史记录（存量模板引用前面节点）
    device_form = annotate_device_form(
        build_device_action_form(db, current_node), submitted, current_values=values,
    )
    items = device_form.get("items") or [] if device_form.get("bound") else []
    if not items:
        if body.run_device_action or body.device_params or body.device_runs:
            raise HTTPException(status_code=400, detail="当前节点未绑定设备动作")
        db.add(_submit_node_record(
            ticket, current_node, current_user, pending, my_groups,
            values=values, route_to=route_to,
            comment=sanitize_text(body.comment) if body.comment else None,
        ))
    else:
        choices = {}
        for choice in body.device_runs or []:
            if choice.index in choices:
                raise HTTPException(status_code=400, detail="重复提交了设备动作参数")
            matched = next((it for it in items if it.get("index") == choice.index), None)
            if matched is None or choice.action_id != matched.get("action_id"):
                raise HTTPException(status_code=400, detail="设备动作与当前节点配置不一致")
            choices[choice.index] = choice
        # 先对本次要执行的动作全部定稿并校验参数；任一失败直接返回全部错误，
        # 不做任何设备排队/下发（下发后需通过撤销补偿回退）。
        skipped_results = {}
        run_items = []
        runs = {}
        for item in items:
            label = f"{item.get('device_name') or '设备'} / {item.get('action_name') or '动作'}"
            choice = choices.get(item.get("index"))
            if not item.get("execute"):
                if choice and (choice.params or choice.overridden_params):
                    raise HTTPException(status_code=400, detail=f"判断组未建议执行「{label}」，不能提交设备参数")
                skipped_results[item.get("index")] = {
                    "skipped": True,
                    "by": "judge",
                    "judge_actual": item.get("judge_actual") or "",
                    "device_name": item.get("device_name") or "",
                    "action_name": item.get("action_name") or "",
                    "action_id": item.get("action_id"),
                }
                continue
            if choice is None:
                raise HTTPException(status_code=400, detail=f"判断组已建议执行「{label}」，请填写参数")
            run_items.append(item)
            runs[item.get("index")] = {
                "params": dict(choice.params or {}),
                "overridden_params": list(choice.overridden_params or []),
            }
        exec_ctx = {
            "ticket_no": ticket.ticket_no,
            "ticket_title": ticket.title or "",
            "creator": getattr(ticket, "created_by_name", "") or "",
            "node": (current_node or {}).get("name") or "",
            "field_values": build_field_context(submitted, values),
        }
        plans, errors = plan_device_runs(db, run_items, runs, exec_ctx)
        if errors:
            raise HTTPException(status_code=422, detail="；".join(errors))
        # 独立设备执行权限：仅命中建议执行的设备动作才校验，未触发时仍需正常流转
        if plans and not has_permission_for_user(db, current_user, "ticket", "execute"):
            raise HTTPException(
                status_code=403,
                detail="您没有设备动作执行权限（ticket:execute），无法下发设备",
            )

        # 排队态结果先写入时间线（前端展示 排队中），Worker 完成后回写成功/失败
        queued_items = {}
        for plan in plans:
            device, action = plan["device"], plan["action"]
            queued_items[int(plan.get("index"))] = {
                "index": plan.get("index"),
                "skipped": False,
                "run_id": None,
                "device_id": device.id,
                "device_name": device.name or "",
                "action_id": action.id,
                "action_name": action.name or "",
                "action_type": action.action_type or "",
                "params": plan.get("params") or {},
                "status": "queued",
                "success": None,
                "attempts": 0,
                "status_code": None,
                "error": None,
                "finished_at": None,
            }
        results = [
            queued_items.get(item.get("index")) or skipped_results[item.get("index")]
            for item in items
        ]
        node_record = _submit_node_record(
            ticket, current_node, current_user, pending, my_groups,
            values=values, route_to=route_to,
            comment=sanitize_text(body.comment) if body.comment else None,
        )
        db.add(node_record)
        db.flush()
        if plans:
            # 动作槽位唯一约束 + 幂等键：重复提交不会重复下发设备
            queued_runs = create_runs_for_plans(
                db, ticket, node_record, plans, results,
                created_by_id=current_user.id,
                created_by_name=current_user.display_name or current_user.username,
            )
            device_result = node_record.device_result
        else:
            device_result = results[0] if len(results) == 1 else {"items": results}
            node_record.device_result = device_result

    # 旧版封禁同步（ban_sync 字段映射，仅记录不调用设备）：配置入口已从流程编辑器下线，
    # 此处保留执行以兼容存量已发布模板，存量工单/台账行为不变
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
    # 工单先落库，再把设备动作投递给 Celery Worker：
    # - 异步执行，失败不阻塞工单流转，时间线可重试
    # - 排队失败标记 failed，前端可在流转历史中重新排队
    for run in queued_runs:
        queued_ok = enqueue_run(run.id)
        if not queued_ok:
            mark_enqueue_failed(run.id, "任务排队失败，请在流转历史中重试")
        write_audit(
            db,
            action="ticket_device_run_queued" if queued_ok else "ticket_device_run_queue_failed",
            resource_type="ticket", resource_id=ticket.id,
            detail={
                "ticket_no": ticket.ticket_no, "run_id": run.id, "node": run.node_key,
                "device": run.device_name, "action": run.action_name, "params": run.params,
            },
            operator=current_user.username, user_id=current_user.id,
            result="success" if queued_ok else "failed",
        )
    write_audit(
        db, action="ticket_advance", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "from": current_node.get("key"), "to": route_to,
                "status": ticket.status},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("工单流转: id=%s no=%s %s → %s, operator=%s",
                ticket.id, ticket.ticket_no, current_node.get("key"), route_to, current_user.username)
    return _ticket_detail(db, ticket, current_user)


# ============ 节点设备动作（如安博通阻断器封禁/解封） ============

@router.post("/{ticket_id}/device-actions/execute")
def execute_ticket_device_action(
    ticket_id: int,
    body: TicketDeviceActionExecute,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "execute")),
) -> dict:
    """执行当前节点配置的设备动作（如安博通阻断器的封禁/解封/查询）。

    - 权限与流转一致：admin / 当前节点待处理分组成员 / 认领人
    - 仅进行中工单、且动作配置在当前停留节点上时可执行
    - 触发条件按提交的表单值快照服务端复检（与前端展示面板同口径），
      未命中时拒绝执行，防止绕过前端直调设备
    - 实际调用走统一执行引擎 execute_device_action（写 DeviceCallLog，source=ticket），
      结果写入工单时间线（action=device_action）留痕，可在流转历史中查看
    - 查询类动作（GET）设备返回 404 归一为业务结果（success=true + note 说明
      未查询到目标），与封禁状态查询的 404=未封禁语义一致，不误报"执行失败"
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    _reject_if_paused(ticket, "执行设备动作")
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail="工单已完结，不能再执行设备动作")

    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    if not current_node:
        raise HTTPException(status_code=400, detail="当前节点定义缺失（快照损坏）")

    # 处理权限：admin / 属于当前节点任一待处理分组 / 认领人（与 advance 同口径）
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    pending = _csv_group_ids(ticket)
    if not admin and ticket.claimed_by_id != current_user.id and not (pending & my_groups):
        raise HTTPException(status_code=403, detail="您不属于当前节点的待处理分组，无法执行设备动作")
    if ticket.claimed_by_id and ticket.claimed_by_id != current_user.id and not admin:
        raise HTTPException(status_code=403, detail="工单已被其他成员认领，仅认领人或管理员可执行设备动作")

    # 定位节点上的动作配置（按配置项 id，非设备动作表 ID）
    cfg = None
    for da in current_node.get("device_actions") or []:
        if isinstance(da, dict) and str(da.get("id") or "") == str(body.action_id):
            cfg = da
            break
    if cfg is None:
        raise HTTPException(status_code=404, detail="当前节点不存在该设备动作配置")

    # 带判断字段的动作只在提交流转里执行，旧接口不再接受
    if str(cfg.get("judge_field") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="该设备动作由判断字段触发，请在工单提交流转时执行",
        )

    # 触发条件服务端复检：未命中说明面板本不该出现（或表单值已变化），拒绝执行
    values = _clean_field_values(body.field_values)
    if not eval_when(cfg.get("when"), values):
        raise HTTPException(status_code=400, detail="当前表单值未命中该设备动作的触发条件")

    # 按配置指向定位设备与动作（执行按 ID 定位，冗余名称仅用于展示）
    device = db.query(Device).filter(Device.id == cfg.get("device_id")).first()
    if device is None or not device.enabled:
        raise HTTPException(status_code=400, detail=f"设备「{cfg.get('device_name') or cfg.get('device_id')}」不存在或已停用")
    action = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.id == cfg.get("action_id"),
            DeviceAction.device_id == device.id,
            DeviceAction.enabled.is_(True),
        )
        .first()
    )
    if action is None:
        raise HTTPException(
            status_code=400,
            detail=f"设备「{device.name}」上的动作「{cfg.get('action_name') or cfg.get('action_id')}」不存在或已停用",
        )

    # 参数统一走 prepare_device_params：默认值补齐、类型/选项/IP/时长校验后再调用设备
    params, errors = prepare_device_params(parse_params_schema(action), body.params or {})
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))
    result = execute_device_action(
        device,
        action,
        params,
        db=db,
        source="ticket",
        user_id=current_user.id,
        source_ip=get_client_ip(request) if request else None,
    )
    success = bool(result.get("success"))
    note = ""
    if not success and result.get("status_code") == 404 and (action.http_method or "").upper() == "GET":
        # 查询类动作（GET）404 = 查无数据（如「查询指定黑名单」该 IP 未封禁）：
        # 归一为业务结果而非执行失败，与工单封禁状态查询 404 语义保持一致
        success = True
        note = "设备返回 404：未查询到目标（如该 IP 未封禁）"
    # 时间线留痕：动作执行卡片（设备/动作/参数/结果摘要），不产生流转副作用
    summary = json.dumps({
        "device": device.name,
        "action": action.name,
        "params": params,
        "success": success,
        "status_code": result.get("status_code"),
        "error": result.get("error") if not success else None,
        "note": note or None,
    }, ensure_ascii=False)
    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=str(current_node.get("key") or ""),
        node_name=str(current_node.get("name") or current_node.get("key") or ""),
        group_id=None,
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="device_action",
        field_values={},
        route_to=None,
        comment=summary,
    ))
    db.commit()
    write_audit(
        db, action="ticket_device_action", resource_type="ticket", resource_id=ticket.id,
        detail={"ticket_no": ticket.ticket_no, "node": current_node.get("key"),
                "device": device.name, "action": action.name, "success": success},
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info(
        "工单设备动作执行: ticket=%s node=%s device=%s action=%s success=%s, operator=%s",
        ticket.ticket_no, current_node.get("key"), device.name, action.name, success, current_user.username,
    )
    return {
        "success": success,
        "status_code": result.get("status_code"),
        "response_body": result.get("response_body"),
        "error": result.get("error") if not success else None,
        "note": note or None,
        "latency_ms": result.get("latency_ms"),
    }


# ============ 设备动作执行记录：失败重试 / 封禁撤销 ============

def _get_device_run_or_404(db: Session, ticket_id: int, run_id: int, *, for_update: bool = False) -> TicketDeviceRun:
    query = db.query(TicketDeviceRun).filter(
        TicketDeviceRun.id == run_id,
        TicketDeviceRun.ticket_id == ticket_id,
    )
    if for_update:
        query = query.with_for_update()
    run = query.first()
    if run is None:
        raise HTTPException(status_code=404, detail="设备执行记录不存在")
    return run


@router.post("/{ticket_id}/device-runs/{run_id}/retry")
def retry_ticket_device_run(
    ticket_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "execute")),
) -> dict:
    """重试失败的设备动作：复用同一执行记录，不重复生成动作槽位。"""
    ticket = _get_ticket_or_404(db, ticket_id)
    _reject_if_paused(ticket, "重试设备动作")
    run = _get_device_run_or_404(db, ticket_id, run_id, for_update=True)
    if run.status != "failed":
        raise HTTPException(status_code=400, detail="仅失败的设备动作可以重试")
    run.status = "queued"
    run.error = None
    run.finished_at = None
    run.updated_at = beijing_now()
    apply_run_to_node_record(db, run)
    db.commit()

    queued_ok = enqueue_run(run.id)
    if not queued_ok:
        mark_enqueue_failed(run.id, "任务排队失败，请稍后重试")
    write_audit(
        db,
        action="ticket_device_run_retry" if queued_ok else "ticket_device_run_retry_failed",
        resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no, "run_id": run.id, "node": run.node_key,
            "device": run.device_name, "action": run.action_name, "attempts": run.attempts,
        },
        operator=current_user.username, user_id=current_user.id,
        result="success" if queued_ok else "failed",
    )
    if not queued_ok:
        raise HTTPException(status_code=503, detail="任务排队失败，请稍后重试")
    return _ticket_detail(db, ticket, current_user)


@router.post("/{ticket_id}/device-runs/{run_id}/compensate")
def compensate_ticket_device_run(
    ticket_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "execute")),
) -> dict:
    """撤销已成功的封禁动作：自动匹配同设备的解封动作并异步下发。

    - 仅 ``block_ip`` 且执行成功的记录可撤销；已撤销/撤销中返回冲突
    - 解封参数从原封禁参数映射（``ip`` → ``blist``），再按解封动作 schema 校验
    - 撤销动作写独立时间线记录（action=device_action），原记录标记为 compensated
    """
    ticket = _get_ticket_or_404(db, ticket_id)
    _reject_if_paused(ticket, "撤销设备动作")
    run = _get_device_run_or_404(db, ticket_id, run_id, for_update=True)
    if run.kind != "execute" or run.status != "success":
        raise HTTPException(status_code=400, detail="仅执行成功的设备动作可以撤销")
    if (run.action_type or "") != "block_ip":
        raise HTTPException(status_code=400, detail="仅封禁类动作支持自动撤销（解封）")
    prior = (
        db.query(TicketDeviceRun)
        .filter(TicketDeviceRun.compensation_of_run_id == run.id)
        .order_by(TicketDeviceRun.id.desc())
        .first()
    )
    if prior is not None:
        if prior.status in ("queued", "running", "success"):
            raise HTTPException(status_code=409, detail="该封禁动作已发起撤销或已撤销")
        if prior.status == "failed":
            # 上次撤销失败：复用同一撤销记录重新排队（避免重复动作槽位/幂等键冲突）
            prior.status = "queued"
            prior.error = None
            prior.finished_at = None
            prior.updated_at = beijing_now()
            apply_run_to_node_record(db, prior)
            db.commit()
            queued_ok = enqueue_run(prior.id)
            if not queued_ok:
                mark_enqueue_failed(prior.id, "任务排队失败，请稍后重试")
            write_audit(
                db,
                action="ticket_device_run_compensate_retry" if queued_ok else "ticket_device_run_compensate_failed",
                resource_type="ticket", resource_id=ticket.id,
                detail={
                    "ticket_no": ticket.ticket_no, "run_id": run.id, "compensation_run_id": prior.id,
                    "node": run.node_key, "device": prior.device_name, "action": prior.action_name,
                    "attempts": prior.attempts,
                },
                operator=current_user.username, user_id=current_user.id,
                result="success" if queued_ok else "failed",
            )
            if not queued_ok:
                raise HTTPException(status_code=503, detail="撤销任务排队失败，请稍后重试")
            return _ticket_detail(db, ticket, current_user)

    device = db.query(Device).filter(Device.id == run.device_id).first()
    if device is None or not device.enabled:
        raise HTTPException(status_code=400, detail="原封禁设备不存在或已停用，无法自动撤销")
    unblock = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.device_id == device.id,
            DeviceAction.action_type == "unblock_ip",
            DeviceAction.enabled.is_(True),
        )
        .order_by(DeviceAction.id.asc())
        .first()
    )
    if unblock is None:
        raise HTTPException(status_code=400, detail="该设备未配置启用的解封动作（unblock_ip），请手动处理")

    # 参数映射：同名字段直接沿用；封禁 ip → 解封 blist（安博通解封以路径参数 blist 指定对象）
    schema = parse_params_schema(unblock)
    orig_params = dict(run.params or {})
    names = {str(p.get("name")) for p in schema}
    mapped = {}
    for name in names:
        if name == "blist":
            mapped[name] = orig_params.get("blist") or orig_params.get("ip") or ""
        elif name in orig_params:
            mapped[name] = orig_params.get(name)
    if "reason" in names and not mapped.get("reason"):
        mapped["reason"] = f"工单撤销：{ticket.ticket_no}"
    if "blist" in names and not str(mapped.get("blist") or "").strip():
        raise HTTPException(status_code=422, detail="原封禁记录未保存封禁对象，无法自动撤销")
    params, errors = prepare_device_params(schema, mapped)
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))

    summary = json.dumps({
        "kind": "compensate",
        "device": device.name,
        "action": unblock.name,
        "params": params,
        "compensation_of_run_id": run.id,
    }, ensure_ascii=False)
    record = TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=run.node_key,
        node_name=run.node_name,
        group_id=None,
        handler_id=current_user.id,
        handler_name=current_user.display_name or current_user.username,
        action="device_action",
        field_values={},
        device_result=None,
        route_to=None,
        comment=summary,
    )
    db.add(record)
    db.flush()
    comp = TicketDeviceRun(
        ticket_id=ticket.id,
        node_record_id=record.id,
        node_key=run.node_key,
        node_name=run.node_name,
        action_index=0,
        kind="compensate",
        device_id=device.id,
        action_id=unblock.id,
        device_name=device.name or "",
        action_name=unblock.name or "",
        action_type=unblock.action_type or "",
        params=params,
        status="queued",
        attempts=0,
        idempotency_key=f"{ticket.id}:{run.id}:compensate",
        compensation_of_run_id=run.id,
        created_by_id=current_user.id,
        created_by_name=current_user.display_name or current_user.username,
        updated_at=beijing_now(),
    )
    db.add(comp)
    db.flush()
    record.device_result = {"items": [{
        "index": 0,
        "skipped": False,
        "kind": "compensate",
        "run_id": comp.id,
        "device_id": device.id,
        "device_name": device.name or "",
        "action_id": unblock.id,
        "action_name": unblock.name or "",
        "action_type": unblock.action_type or "",
        "params": params,
        "status": "queued",
        "success": None,
        "attempts": 0,
        "status_code": None,
        "error": None,
        "finished_at": None,
        "compensation_of_run_id": run.id,
    }]}
    db.commit()

    queued_ok = enqueue_run(comp.id)
    if not queued_ok:
        mark_enqueue_failed(comp.id, "任务排队失败，请稍后重试")
    write_audit(
        db,
        action="ticket_device_run_compensate" if queued_ok else "ticket_device_run_compensate_failed",
        resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no, "run_id": run.id, "compensation_run_id": comp.id,
            "node": run.node_key, "device": device.name, "action": unblock.name, "params": params,
        },
        operator=current_user.username, user_id=current_user.id,
        result="success" if queued_ok else "failed",
    )
    if not queued_ok:
        raise HTTPException(status_code=503, detail="撤销任务排队失败，请稍后重试")
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
    _reject_if_paused(ticket, "回退")
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
    if ticket.status == "paused":
        # 暂停中取消：先补记强制恢复，保证状态链完整（允许发起人/管理员）
        try:
            force_resume_for_cancel(
                db, ticket,
                user_id=current_user.id,
                user_name=current_user.display_name or current_user.username,
            )
        except PauseError as exc:
            db.rollback()
            raise _pause_error(exc) from exc
    elif ticket.status != "processing":
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
    _reject_if_paused(ticket, "催办")
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
    _reject_if_paused(ticket, "转办")
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
    _reject_if_paused(ticket, "认领")
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


# ============ 批量暂停 / 恢复 ============
# 注意：必须定义在 /{ticket_id}/pause 之前，避免 "batch" 被当作工单 ID 解析

def _batch_error_result(exc: Exception, ticket_id: int) -> dict:
    """批量操作单项失败归类：状态冲突/越权记为 skipped，其余为 failed。"""
    if isinstance(exc, PauseError):
        if exc.code in ("TICKET_PAUSED", "TICKET_NOT_PAUSED", "PAUSE_FORBIDDEN"):
            return {"ticket_id": ticket_id, "result": "skipped", "reason": exc.code, "message": exc.message}
        return {"ticket_id": ticket_id, "result": "failed", "reason": exc.code, "message": exc.message}
    if isinstance(exc, HTTPException):
        return {"ticket_id": ticket_id, "result": "failed", "reason": "HTTP_ERROR", "message": str(exc.detail)}
    return {"ticket_id": ticket_id, "result": "failed", "reason": "INTERNAL_ERROR", "message": "处理失败"}


def _batch_notify_operator(db: Session, operator_id: int, title: str, content: str) -> None:
    from app.models.notification import Notification

    db.add(Notification(
        user_id=operator_id,
        type="system_alert",
        title=title,
        content=content,
        related_type=None,
        related_id=None,
        created_by="system",
    ))


@router.post("/batch/pause")
def batch_pause_tickets(
    body: TicketBatchPause,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "pause")),
) -> dict:
    """批量暂停：逐单校验、逐单事务、部分成功，单批上限取策略 max_batch_size。"""
    config = get_pause_config(db)
    max_batch = int(config.get("max_batch_size") or 200)
    type_item = (config.get("types") or {}).get(body.pause_type) or {}
    if not isinstance(type_item, dict) or not type_item.get("enabled", True):
        raise HTTPException(status_code=400, detail="该暂停类型未启用")
    if type_item.get("allow_batch") is False:
        raise HTTPException(status_code=400, detail="该暂停类型不支持批量操作")
    ticket_ids = list(dict.fromkeys(body.ticket_ids))
    if len(ticket_ids) > max_batch:
        raise HTTPException(status_code=400, detail=f"单批最多 {max_batch} 条，请分批操作")

    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    operator_name = current_user.display_name or current_user.username
    batch_id = f"bp-{beijing_now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"
    results: list[dict] = []
    success = skipped = failed = 0

    for tid in ticket_ids:
        try:
            ticket = _get_ticket_or_404(db, tid, for_update=True)
            pause, created = create_pause(
                db, ticket,
                user_id=current_user.id,
                user_name=operator_name,
                my_group_ids=my_groups,
                is_admin_user=admin,
                pause_type=body.pause_type,
                reason=body.reason,
                expected_resume_at=body.expected_resume_at,
                detail=body.detail,
                necessity=body.necessity,
                batch_id=batch_id,
            )
            if not created:
                db.rollback()
                skipped += 1
                results.append({
                    "ticket_id": tid, "result": "skipped",
                    "reason": "already_paused", "message": "工单已处于暂停状态",
                })
                continue
            _notify_pause_created(db, ticket, pause, operator_name)
            db.commit()
            success += 1
            results.append({
                "ticket_id": tid, "ticket_no": ticket.ticket_no,
                "result": "success", "pause_id": pause.id,
            })
        except PauseError as exc:
            db.rollback()
            item = _batch_error_result(exc, tid)
            results.append(item)
            skipped += 1 if item["result"] == "skipped" else 0
            failed += 1 if item["result"] == "failed" else 0
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            results.append(_batch_error_result(exc, tid))
            failed += 1
            logger.exception("批量暂停失败: batch=%s ticket=%s", batch_id, tid)

    _batch_notify_operator(
        db, current_user.id,
        title="批量暂停完成",
        content=f"批次 {batch_id}：成功 {success} / 跳过 {skipped} / 失败 {failed}，共 {len(ticket_ids)} 条。",
    )
    db.commit()
    write_audit(
        db, action="ticket_batch_pause", resource_type="ticket", resource_id=0,
        detail={
            "batch_id": batch_id,
            "pause_type": body.pause_type,
            "total": len(ticket_ids),
            "success": success,
            "skipped": skipped,
            "failed": failed,
            "results": results,
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("批量暂停完成: batch=%s success=%s skipped=%s failed=%s",
                batch_id, success, skipped, failed)
    return {
        "batch_id": batch_id, "total": len(ticket_ids),
        "success": success, "skipped": skipped, "failed": failed,
        "results": results,
    }


@router.post("/batch/resume")
def batch_resume_tickets(
    body: TicketBatchResume,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "pause")),
) -> dict:
    """批量恢复：逐单校验、逐单事务、部分成功；force 仅管理员可用于全部工单。"""
    config = get_pause_config(db)
    max_batch = int(config.get("max_batch_size") or 200)
    ticket_ids = list(dict.fromkeys(body.ticket_ids))
    if len(ticket_ids) > max_batch:
        raise HTTPException(status_code=400, detail=f"单批最多 {max_batch} 条，请分批操作")
    if body.force and not is_admin(current_user, db):
        raise HTTPException(status_code=403, detail="仅管理员可批量强制恢复")

    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    operator_name = current_user.display_name or current_user.username
    batch_id = f"br-{beijing_now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"
    results: list[dict] = []
    success = skipped = failed = 0

    for tid in ticket_ids:
        try:
            ticket = _get_ticket_or_404(db, tid, for_update=True)
            pause = resume_pause(
                db, ticket,
                user_id=current_user.id,
                user_name=operator_name,
                my_group_ids=my_groups,
                is_admin_user=admin,
                comment=body.comment,
                force=body.force,
            )
            _notify_ticket_resumed(db, ticket, pause, operator_name)
            db.commit()
            success += 1
            results.append({
                "ticket_id": tid, "ticket_no": ticket.ticket_no,
                "result": "success", "pause_id": pause.id,
                "duration_minutes": pause.duration_minutes,
            })
        except PauseError as exc:
            db.rollback()
            item = _batch_error_result(exc, tid)
            results.append(item)
            skipped += 1 if item["result"] == "skipped" else 0
            failed += 1 if item["result"] == "failed" else 0
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            results.append(_batch_error_result(exc, tid))
            failed += 1
            logger.exception("批量恢复失败: batch=%s ticket=%s", batch_id, tid)

    _batch_notify_operator(
        db, current_user.id,
        title="批量恢复完成",
        content=f"批次 {batch_id}：成功 {success} / 跳过 {skipped} / 失败 {failed}，共 {len(ticket_ids)} 条。",
    )
    db.commit()
    write_audit(
        db, action="ticket_batch_resume", resource_type="ticket", resource_id=0,
        detail={
            "batch_id": batch_id,
            "total": len(ticket_ids),
            "success": success,
            "skipped": skipped,
            "failed": failed,
            "force": body.force,
            "results": results,
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("批量恢复完成: batch=%s success=%s skipped=%s failed=%s",
                batch_id, success, skipped, failed)
    return {
        "batch_id": batch_id, "total": len(ticket_ids),
        "success": success, "skipped": skipped, "failed": failed,
        "results": results,
    }


# ============ 暂停 / 恢复（临时挂起） ============

@router.post("/{ticket_id}/pause")
def pause_ticket(
    ticket_id: int,
    body: TicketPauseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "pause")),
) -> dict:
    """暂停工单（临时挂起）。

    - 仅进行中工单可暂停；重复暂停幂等返回现有暂停记录
    - 分类决定必填信息、最长时效与到期处置策略（见 app.core.ticket_pause）
    - 暂停期间 SLA 与节点停留计时冻结，禁止流转/回退/转办/认领/设备动作
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    operator_name = current_user.display_name or current_user.username

    try:
        pause, created = create_pause(
            db, ticket,
            user_id=current_user.id,
            user_name=operator_name,
            my_group_ids=my_groups,
            is_admin_user=admin,
            pause_type=body.pause_type,
            reason=body.reason,
            expected_resume_at=body.expected_resume_at,
            detail=body.detail,
            necessity=body.necessity,
        )
    except PauseError as exc:
        db.rollback()
        raise _pause_error(exc) from exc

    if created:
        _notify_pause_created(db, ticket, pause, operator_name)
        db.commit()
        db.refresh(ticket)
        write_audit(
            db, action="ticket_pause", resource_type="ticket", resource_id=ticket.id,
            detail={
                "ticket_no": ticket.ticket_no,
                "pause_type": pause.pause_type,
                "pause_id": pause.id,
                "reason": pause.reason,
                "expire_at": pause.expire_at.isoformat() if pause.expire_at else None,
            },
            operator=current_user.username, user_id=current_user.id,
        )
        logger.info("暂停工单: id=%s no=%s type=%s operator=%s",
                    ticket.id, ticket.ticket_no, pause.pause_type, current_user.username)
    else:
        db.commit()
        db.refresh(ticket)

    return _ticket_detail(db, ticket, current_user)


@router.post("/{ticket_id}/resume")
def resume_ticket(
    ticket_id: int,
    body: TicketResume,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "pause")),
) -> dict:
    """恢复暂停：回到暂停前的节点原地继续。

    - 权限：管理员 / 暂停发起人 / 发起人（本人发起或用户反馈类）/ 当前处理人
    - ``force=true`` 仅管理员可用，忽略发起人限制
    - 恢复后节点停留计时顺延暂停时长，SLA 按扣除暂停时长重新计算
    """
    ticket = _get_ticket_or_404(db, ticket_id, for_update=True)
    admin = is_admin(current_user, db)
    my_groups = set(_my_group_ids(db, current_user.id))
    operator_name = current_user.display_name or current_user.username

    try:
        pause = resume_pause(
            db, ticket,
            user_id=current_user.id,
            user_name=operator_name,
            my_group_ids=my_groups,
            is_admin_user=admin,
            comment=body.comment,
            force=body.force,
        )
    except PauseError as exc:
        db.rollback()
        raise _pause_error(exc) from exc

    _notify_ticket_resumed(db, ticket, pause, operator_name)
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_resume", resource_type="ticket", resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no,
            "pause_id": pause.id,
            "pause_type": pause.pause_type,
            "duration_minutes": pause.duration_minutes,
            "resume_mode": pause.resume_mode,
            "conflict": pause.conflict_flag,
        },
        operator=current_user.username, user_id=current_user.id,
    )
    logger.info("恢复工单: id=%s no=%s duration=%s mode=%s operator=%s",
                ticket.id, ticket.ticket_no, pause.duration_minutes,
                pause.resume_mode, current_user.username)
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
        group_id=ticket.current_group_id if ticket.status in ("processing", "paused") else None,
        handler_id=current_user.id,
        handler_name=operator_name,
        action="comment",
        field_values={},
        comment=content,
    ))
    # 通知：发起人 + 当前节点全部待处理分组成员（处理中，含会签/转办后变化），排除评论人
    notify_ids: set[int] = set()
    if ticket.status in ("processing", "paused"):
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

def _require_ticket_participant(
    db: Session, ticket: Ticket, current_user: User, action: str
) -> None:
    """校验工单参与人权限：admin / 发起人 / 当前节点处理分组成员（仅进行中工单）。

    action 参与错误文案（如「变更抄送」「重新研判安全上下文」）。
    """
    if ticket.status != "processing":
        raise HTTPException(status_code=400, detail=f"工单已完结，不能再{action}")
    admin = is_admin(current_user, db)
    if admin or ticket.created_by_id == current_user.id:
        return
    snapshot = ticket.flow_snapshot if isinstance(ticket.flow_snapshot, dict) else {}
    current_node = get_node(snapshot, ticket.current_node_key) if ticket.current_node_key else None
    my_groups = set(_my_group_ids(db, current_user.id))
    if current_node and current_node.get("group_id") in my_groups:
        return
    raise HTTPException(status_code=403, detail=f"仅发起人、当前处理人或管理员可{action}")


def _require_cc_manage_permission(db: Session, ticket: Ticket, current_user: User) -> None:
    """校验抄送管理权限：admin / 发起人 / 当前节点处理分组成员（仅进行中工单）。"""
    _require_ticket_participant(db, ticket, current_user, "变更抄送")


# ============ 重新研判安全上下文（多 IP requery） ============

@router.post("/{ticket_id}/enrichment/requery")
def requery_ticket_enrichment_api(
    ticket_id: int,
    body: TicketEnrichmentRequery,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ticket", "edit")),
) -> dict:
    """重新研判安全上下文指定 IP：重跑资产匹配 + 威胁情报并升级为完整档。

    - 参与人权限（发起人/当前节点处理人/admin，仅进行中工单）；
    - 选中 IP ≤20 同步返回更新后的工单详情；>20 打 requery_pending
      标记转后台线程补全（返回 pending=true，前端轮询工单详情）；
    - 写审计 ticket_enrichment_requery。
    """
    ticket = _get_ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, ticket, current_user, "重新研判安全上下文")
    try:
        result = requery_ticket_enrichment(db, ticket, body.ips)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(ticket)
    write_audit(
        db, action="ticket_enrichment_requery", resource_type="ticket",
        resource_id=ticket.id,
        detail={
            "ticket_no": ticket.ticket_no,
            "ips_count": len(body.ips),
            "ips_preview": body.ips[:20],
            "updated": result.get("updated", 0),
            "unknown": result.get("unknown", []),
            "pending": result.get("pending", False),
        },
        operator=current_user.username, user_id=current_user.id,
    )
    return {"ok": True, **result, "ticket": _ticket_detail(db, ticket, current_user)}


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
    db.query(TicketPause).filter(TicketPause.ticket_id == ticket_id).delete(synchronize_session=False)
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
