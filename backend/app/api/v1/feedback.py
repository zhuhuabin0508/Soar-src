"""系统 BUG 与优化建议反馈 API。

提供反馈全生命周期接口：
- 用户：提交反馈（含 BUG 必填项校验）、上传/下载附件、我的反馈、详情、编辑、重新打开；
- 管理员：反馈列表（多维筛选）、回复（可同步改状态/指派）、状态流转、批量操作。

安全设计：
- 所有文本字段入库前经 ``sanitize_text`` 做 XSS 过滤（转义 HTML 特殊字符 + 去控制字符）；
- 附件扩展名白名单 + 10MB 大小限制，杜绝可执行文件上传；
- 附件下载做路径穿越校验；
- 提交频率限制：每用户 1 小时内最多 10 次（内存实现，超限返回 429）。
"""
import json
import logging
import os
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.permissions import DEFAULT_ROLES, has_permission, migrate_permissions
from app.core.sanitizer import sanitize_text
from app.database import get_db
from app.dependencies import get_current_user, is_admin, require_permission
from app.models.feedback import Feedback, FeedbackHistory
from app.models.role import Role
from app.models.notification import Notification
from app.models.user import User
from app.schemas.feedback import (
    BUG_REQUIRED_FIELDS,
    AssigneeUpdate,
    BatchAction,
    FeedbackCreate,
    FeedbackUpdate,
    ReplyCreate,
    StatusUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/feedbacks",
    tags=["feedbacks"],
    dependencies=[Depends(get_current_user)],
)

# ============ 常量 ============

# 反馈类型中文名（用于通知文案）
TYPE_LABELS = {"bug": "BUG", "suggestion": "优化建议", "other": "其他反馈"}

# 状态中文名（用于通知文案）
STATUS_LABELS = {
    "pending": "待处理",
    "processing": "处理中",
    "replied": "已回复",
    "resolved": "已解决",
    "closed": "已关闭",
}

# 合法状态流转表（closed 仅能通过 reopen 专用接口重新打开）
VALID_TRANSITIONS = {
    "pending": {"processing", "replied", "closed"},
    "processing": {"replied", "resolved", "closed"},
    "replied": {"resolved", "closed", "processing"},
    "resolved": {"closed"},
    "closed": set(),
}

# 可编辑状态（已完结的反馈不允许提交人再编辑）
EDITABLE_STATUSES = {"pending", "processing", "replied"}

# 附件扩展名白名单（拒绝 exe/dll/sh/bat/py 等一切可执行文件）
ALLOWED_ATTACHMENT_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp", "bmp",
    "pdf", "txt", "log", "md", "csv", "zip",
}
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024  # 10MB

# 提交频率限制：每用户 1 小时内最多 10 次
RATE_LIMIT_WINDOW = 3600  # 秒
RATE_LIMIT_MAX = 10
_rate_lock = threading.Lock()
_rate_buckets: dict[int, list[float]] = defaultdict(list)

# 附件保存目录：backend/uploads/feedback/{feedback_id}/
# __file__ = backend/app/api/v1/feedback.py，上溯 4 级到 backend/
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
    "feedback",
)


# ============ 辅助函数 ============

def _check_rate_limit(user_id: int) -> None:
    """提交频率限制：滑动窗口内超过上限抛 429。"""
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets[user_id]
        # 清理窗口外的时间戳
        _rate_buckets[user_id] = [ts for ts in bucket if now - ts < RATE_LIMIT_WINDOW]
        if len(_rate_buckets[user_id]) >= RATE_LIMIT_MAX:
            raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")
        _rate_buckets[user_id].append(now)


def _parse_attachments(raw: Optional[str]) -> list[dict]:
    """解析 attachments JSON 数组字符串，容错返回列表（None/损坏 → []）。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (TypeError, ValueError):
        return []


def _get_feedback_or_404(db: Session, feedback_id: int) -> Feedback:
    """按 ID 查反馈，不存在抛 404。"""
    feedback = db.query(Feedback).filter(Feedback.id == feedback_id).first()
    if feedback is None:
        raise HTTPException(status_code=404, detail="反馈不存在")
    return feedback


def _cascade_delete_feedback(db: Session, feedback: Feedback) -> None:
    """级联删除单条反馈：附件文件 / 关联通知 / 历史记录 / 反馈本身。

    不 commit，由调用方决定事务边界（单删/批删共用）。
    附件文件删除失败仅记日志，不阻断主流程。
    """
    feedback_id = feedback.id
    # 1) 删除附件文件（容错：目录不存在或文件丢失不报错）
    attachments = _parse_attachments(feedback.attachments)
    fb_upload_dir = os.path.join(UPLOAD_DIR, str(feedback_id))
    if os.path.isdir(fb_upload_dir):
        for a in attachments:
            filename = os.path.basename(a.get("path", ""))
            if not filename:
                continue
            fp = os.path.join(fb_upload_dir, filename)
            try:
                if os.path.isfile(fp) and os.path.abspath(fp).startswith(
                    os.path.abspath(fb_upload_dir) + os.sep
                ):
                    os.remove(fp)
            except OSError as exc:
                logger.warning("删除附件文件失败: %s (%s)", fp, exc)
        # 尝试清理空目录
        try:
            if not os.listdir(fb_upload_dir):
                os.rmdir(fb_upload_dir)
        except OSError:
            pass

    # 2) 删除关联通知（related_type=feedback + related_id=feedback_id）
    db.query(Notification).filter(
        Notification.related_type == "feedback",
        Notification.related_id == feedback_id,
    ).delete(synchronize_session=False)

    # 3) 删除历史记录
    db.query(FeedbackHistory).filter(
        FeedbackHistory.feedback_id == feedback_id
    ).delete(synchronize_session=False)

    # 4) 删除反馈本身
    db.delete(feedback)


def _is_feedback_admin(user: User, db: Session) -> bool:
    """是否具备反馈管理权限：admin 角色，或角色矩阵含 feedback:view。"""
    if is_admin(user, db):
        return True
    if user.role_id:
        role = db.query(Role).filter(Role.id == user.role_id).first()
        if role and has_permission(migrate_permissions(role.permissions), "feedback", "view"):
            return True
    for default in DEFAULT_ROLES:
        if default["name"] == user.role and has_permission(default["permissions"], "feedback", "view"):
            return True
    return False


def _require_admin(user: User, db: Session) -> None:
    """管理接口权限校验：admin 角色或拥有 feedback:view 权限的角色通过，否则 403。

    支持角色管理权限矩阵（Role.permissions）配置「反馈管理」权限。
    """
    if not _is_feedback_admin(user, db):
        raise HTTPException(status_code=403, detail="权限不足，需要反馈管理权限")


def _can_view_feedback(user: User, feedback: Feedback, db: Session) -> bool:
    """提交人本人，或具备反馈管理权限，可查看详情/附件。"""
    return feedback.user_id == user.id or _is_feedback_admin(user, db)


def _notify(db: Session, user_id: int, title: str, content: str, related_id: int) -> None:
    """通知指定用户反馈相关事件（如回复、状态变更）。"""
    db.add(Notification(
        user_id=user_id,
        type="feedback",
        title=title,
        content=content,
        related_type="feedback",
        related_id=related_id,
        created_by="system",
    ))


def _notify_all_admins(db: Session, title: str, content: str, related_id: int) -> int:
    """通知目标用户反馈相关事件。

    优先走通知规则路由（dispatch_notification），无匹配规则时回退通知所有 admin。
    返回通知条数。
    """
    from app.core.notification_dispatch import dispatch_notification
    try:
        created = dispatch_notification(
            db,
            event_type="feedback",
            title=title,
            content=content,
            related_type="feedback",
            related_id=related_id,
            created_by="system",
        )
        return len(created)
    except Exception:
        # 兜底：规则派发失败时直接通知所有 admin，避免丢通知
        admins = db.query(User).filter(
            User.role == "admin",
            User.is_active.is_(True),
        ).all()
        for admin in admins:
            db.add(Notification(
                user_id=admin.id,
                type="feedback",
                title=title,
                content=content,
                related_type="feedback",
                related_id=related_id,
                created_by="system",
            ))
        return len(admins)


# 可视为「处理动作」的历史：用于补全未写入的处理人
_HANDLE_HISTORY_ACTIONS = {"reply", "status_change", "assign", "batch"}


def _display_name(user: User | None) -> str | None:
    """展示名：优先 display_name，否则用户名。"""
    if user is None:
        return None
    name = (user.display_name or "").strip()
    return name or user.username


def _assign_history_content(operator: User, target: User | None) -> str:
    """分配历史文案：谁把处理人分给谁，或谁改成未分配。"""
    op = _display_name(operator) or operator.username
    if target is None:
        return f"{op} 将处理人改为未分配"
    who = _display_name(target) or target.username
    return f"{op} 将处理人分配给 {who}"


def _infer_handler_id(histories: list[FeedbackHistory]) -> int | None:
    """从处理历史倒序推断实际处理人（仅补从未显式指派过的旧单）。"""
    if any(h.action == "assign" for h in histories):
        return None
    for h in reversed(histories):
        if h.action in {"reply", "status_change", "batch"} and h.operator_id:
            return h.operator_id
    return None


def _backfill_assignees(db: Session, feedbacks: list[Feedback]) -> None:
    """列表批量补全未写入的处理人（跳过已显式指派/取消的单据）。"""
    missing = [f for f in feedbacks if not f.assignee_id]
    if not missing:
        return
    ids = [f.id for f in missing]
    rows = (
        db.query(FeedbackHistory)
        .filter(
            FeedbackHistory.feedback_id.in_(ids),
            FeedbackHistory.action.in_(_HANDLE_HISTORY_ACTIONS),
        )
        .order_by(FeedbackHistory.created_at.asc(), FeedbackHistory.id.asc())
        .all()
    )
    grouped: dict[int, list[FeedbackHistory]] = defaultdict(list)
    for h in rows:
        grouped[h.feedback_id].append(h)
    changed = False
    by_id = {f.id: f for f in missing}
    for fid, f in by_id.items():
        inferred = _infer_handler_id(grouped.get(fid, []))
        if inferred:
            f.assignee_id = inferred
            changed = True
    if changed:
        db.commit()


def _feedback_detail(db: Session, feedback: Feedback, *, backfill: bool = True) -> dict:
    """构造反馈详情：全字段 + 操作历史（含操作人用户名）+ 提交人/处理人用户名。"""
    data = feedback.to_dict()
    data["attachments"] = _parse_attachments(feedback.attachments)

    # 批量取相关用户（提交人 / 处理人 / 历史操作人）
    user_ids = {feedback.user_id}
    if feedback.assignee_id:
        user_ids.add(feedback.assignee_id)
    histories = (
        db.query(FeedbackHistory)
        .filter(FeedbackHistory.feedback_id == feedback.id)
        .order_by(FeedbackHistory.created_at.asc(), FeedbackHistory.id.asc())
        .all()
    )
    user_ids.update(h.operator_id for h in histories if h.operator_id)

    # 仅补从未显式指派过的旧单；有过指派/取消记录的不再回填，避免「未分配」被改成当前登录人
    if backfill and not feedback.assignee_id:
        inferred = _infer_handler_id(histories)
        if inferred:
            feedback.assignee_id = inferred
            db.add(feedback)
            db.commit()
            db.refresh(feedback)
            user_ids.add(inferred)

    users = {
        u.id: u
        for u in db.query(User).filter(User.id.in_(user_ids)).all()
    }

    submitter = users.get(feedback.user_id)
    data["user_username"] = submitter.username if submitter else None
    data["user_display_name"] = submitter.display_name if submitter else None
    data["user_name"] = _display_name(submitter) or data["user_username"]
    assignee = users.get(feedback.assignee_id) if feedback.assignee_id else None
    data["assignee_id"] = feedback.assignee_id
    data["assignee_username"] = assignee.username if assignee else None
    data["assignee_name"] = _display_name(assignee)

    data["histories"] = [
        {
            **h.to_dict(),
            "operator_username": users[h.operator_id].username if h.operator_id in users else None,
            "operator_name": _display_name(users.get(h.operator_id)) if h.operator_id in users else None,
        }
        for h in histories
    ]
    return data


def _valid_transition(from_status: str, to_status: str) -> bool:
    """校验状态流转是否合法（相同状态视为无变化，跳过）。"""
    if from_status == to_status:
        return True
    return to_status in VALID_TRANSITIONS.get(from_status, set())


def _check_bug_required(body: FeedbackCreate) -> None:
    """type=bug 时复现步骤/期望结果/实际结果三项必填（业务校验返回 400）。"""
    if body.type != "bug":
        return
    missing = [
        BUG_REQUIRED_FIELDS[field]
        for field in BUG_REQUIRED_FIELDS
        if not getattr(body, field, None) or not str(getattr(body, field)).strip()
    ]
    if missing:
        raise HTTPException(status_code=400, detail=f"BUG 类反馈必须填写: {'、'.join(missing)}")


# ============ 1. 提交反馈 ============

@router.post("", status_code=201)
def create_feedback(
    body: FeedbackCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """提交系统 BUG / 优化建议。

    - 所有文本字段经 XSS 过滤后入库；
    - type=bug 时复现步骤/期望结果/实际结果必填（缺失返回 400）；
    - 每用户 1 小时内最多提交 10 次，超限返回 429；
    - 创建后通知所有管理员。
    """
    # 业务校验在前：校验失败的请求不占用频率额度
    _check_bug_required(body)
    _check_rate_limit(current_user.id)

    feedback = Feedback(
        user_id=current_user.id,
        type=body.type,
        title=sanitize_text(body.title.strip()),
        module=sanitize_text(body.module.strip()) if body.module else None,
        priority=body.priority,
        description=sanitize_text(body.description.strip()),
        reproduce_steps=sanitize_text(body.reproduce_steps.strip()) if body.reproduce_steps else None,
        expected_result=sanitize_text(body.expected_result.strip()) if body.expected_result else None,
        actual_result=sanitize_text(body.actual_result.strip()) if body.actual_result else None,
        contact=sanitize_text(body.contact.strip()) if body.contact else None,
        allow_visit=body.allow_visit,
        page_title=sanitize_text(body.page_title.strip()) if body.page_title else None,
        page_url=sanitize_text(body.page_url.strip()) if body.page_url else None,
        status="pending",
    )
    db.add(feedback)
    db.flush()  # 先拿到自增 ID，供历史与通知引用

    # 写创建历史
    db.add(FeedbackHistory(
        feedback_id=feedback.id,
        action="created",
        to_status="pending",
        content=f"提交了{TYPE_LABELS.get(feedback.type, feedback.type)}反馈",
        operator_id=current_user.id,
    ))

    # 通知所有管理员
    type_label = TYPE_LABELS.get(feedback.type, feedback.type)
    notified = _notify_all_admins(
        db,
        title=f"收到新反馈：{feedback.title[:50]}",
        content=f"{current_user.username} 提交了{type_label}「{feedback.title}」",
        related_id=feedback.id,
    )
    db.commit()
    db.refresh(feedback)
    logger.info(
        "反馈已创建: id=%s, user=%s, type=%s, 已通知 %d 名管理员",
        feedback.id, current_user.username, feedback.type, notified,
    )
    return _feedback_detail(db, feedback)


# ============ 4. 我的反馈（须在 /{feedback_id} 之前注册） ============

@router.get("/mine")
def list_my_feedbacks(
    type: Optional[str] = Query(None, description="反馈类型筛选：bug/suggestion/other"),
    status: Optional[str] = Query(None, description="状态筛选：pending/processing/replied/resolved/closed"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """当前用户提交的反馈列表（含历史数量与最新回复摘要），按创建时间倒序。"""
    query = db.query(Feedback).filter(Feedback.user_id == current_user.id)
    if type:
        query = query.filter(Feedback.type == type)
    if status:
        query = query.filter(Feedback.status == status)

    total = query.count()
    feedbacks = (
        query.order_by(Feedback.created_at.desc(), Feedback.id.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )

    # 批量统计历史数量与最新回复摘要
    ids = [f.id for f in feedbacks]
    history_map: dict[int, list[FeedbackHistory]] = defaultdict(list)
    if ids:
        rows = (
            db.query(FeedbackHistory)
            .filter(FeedbackHistory.feedback_id.in_(ids))
            .order_by(FeedbackHistory.created_at.asc(), FeedbackHistory.id.asc())
            .all()
        )
        for row in rows:
            history_map[row.feedback_id].append(row)

    items = []
    for feedback in feedbacks:
        item = feedback.to_dict()
        item["attachments"] = _parse_attachments(feedback.attachments)
        histories = history_map.get(feedback.id, [])
        item["history_count"] = len(histories)
        latest_reply = next(
            (h.content for h in reversed(histories) if h.action == "reply" and h.content), None
        )
        item["latest_reply"] = latest_reply[:100] if latest_reply else None
        items.append(item)

    return {"items": items, "total": total, "page": page, "size": size}


# ============ 10. 管理员反馈列表 ============

@router.get("", dependencies=[Depends(require_permission("feedback", "view"))])
def list_feedbacks(
    type: Optional[str] = Query(None, description="反馈类型筛选"),
    status: Optional[str] = Query(None, description="状态筛选"),
    priority: Optional[str] = Query(None, description="优先级筛选"),
    module: Optional[str] = Query(None, description="模块模糊筛选"),
    user_id: Optional[int] = Query(None, description="提交人 user_id 筛选"),
    submitter: Optional[str] = Query(None, description="提交人用户名模糊筛选"),
    start_time: Optional[str] = Query(None, description="创建时间起（ISO 格式）"),
    end_time: Optional[str] = Query(None, description="创建时间止（ISO 格式）"),
    keyword: Optional[str] = Query(None, description="标题关键词模糊筛选"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """管理员反馈列表（多维筛选 + 分页，按创建时间倒序）。"""
    _require_admin(current_user, db)

    query = db.query(Feedback)
    if type:
        query = query.filter(Feedback.type == type)
    if status:
        query = query.filter(Feedback.status == status)
    if priority:
        query = query.filter(Feedback.priority == priority)
    if module:
        query = query.filter(Feedback.module.ilike(f"%{module}%"))
    if user_id:
        query = query.filter(Feedback.user_id == user_id)
    if submitter:
        # 提交人用户名模糊筛选：先查用户 ID 集合再过滤
        matched_ids = [
            u.id
            for u in db.query(User).filter(User.username.ilike(f"%{submitter}%")).all()
        ]
        if not matched_ids:
            return {"items": [], "total": 0, "page": page, "size": size}
        query = query.filter(Feedback.user_id.in_(matched_ids))
    if keyword:
        query = query.filter(Feedback.title.ilike(f"%{keyword}%"))
    for raw, op in ((start_time, ">="), (end_time, "<=")):
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"时间格式非法: {raw}，应为 ISO 格式（如 2026-08-17T00:00:00）")
        query = query.filter(
            Feedback.created_at >= dt if op == ">=" else Feedback.created_at <= dt
        )

    total = query.count()
    feedbacks = (
        query.order_by(Feedback.created_at.desc(), Feedback.id.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    _backfill_assignees(db, feedbacks)

    user_ids = {f.user_id for f in feedbacks}
    user_ids.update(f.assignee_id for f in feedbacks if f.assignee_id)
    users: dict[int, User] = {}
    if user_ids:
        users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}

    items = []
    for feedback in feedbacks:
        item = feedback.to_dict()
        item["attachments"] = _parse_attachments(feedback.attachments)
        submitter = users.get(feedback.user_id)
        item["user_username"] = submitter.username if submitter else None
        item["user_name"] = _display_name(submitter) or item["user_username"]
        assignee = users.get(feedback.assignee_id) if feedback.assignee_id else None
        item["assignee_id"] = feedback.assignee_id
        item["assignee_name"] = _display_name(assignee)
        items.append(item)

    return {"items": items, "total": total, "page": page, "size": size}


# ============ 4.5 反馈统计（admin；须在 /{feedback_id} 之前注册，避免被路径参数拦截） ============

@router.get("/stats", dependencies=[Depends(require_permission("feedback", "view"))])
def feedback_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """反馈统计概览（admin only）：总数 / 状态分布 / 类型分布 / 优先级分布 / 今日新增 / 本周新增 / 待处理数。

    用于反馈管理页顶部紧凑统计卡片与迷你图表。
    """
    _require_admin(current_user, db)

    total = db.query(func.count(Feedback.id)).scalar() or 0

    # 状态分布
    status_rows = (
        db.query(Feedback.status, func.count(Feedback.id))
        .group_by(Feedback.status)
        .all()
    )
    by_status = {row[0]: row[1] for row in status_rows}

    # 类型分布
    type_rows = (
        db.query(Feedback.type, func.count(Feedback.id))
        .group_by(Feedback.type)
        .all()
    )
    by_type = {row[0]: row[1] for row in type_rows}

    # 优先级分布
    priority_rows = (
        db.query(Feedback.priority, func.count(Feedback.id))
        .group_by(Feedback.priority)
        .all()
    )
    by_priority = {row[0]: row[1] for row in priority_rows}

    # 模块 Top 5（module 为空的归到「未分类」）
    module_rows = (
        db.query(
            func.coalesce(Feedback.module, "未分类").label("m"),
            func.count(Feedback.id),
        )
        .group_by("m")
        .order_by(func.count(Feedback.id).desc())
        .limit(5)
        .all()
    )
    by_module = [{"name": row[0], "count": row[1]} for row in module_rows]

    # 今日新增 / 本周新增
    now = datetime.utcnow()
    today_start = datetime(now.year, now.month, now.day)
    week_start = today_start - timedelta(days=today_start.weekday())
    today_count = (
        db.query(func.count(Feedback.id))
        .filter(Feedback.created_at >= today_start)
        .scalar() or 0
    )
    week_count = (
        db.query(func.count(Feedback.id))
        .filter(Feedback.created_at >= week_start)
        .scalar() or 0
    )

    # 待处理 = pending + processing
    pending_count = (by_status.get("pending", 0) + by_status.get("processing", 0))

    return {
        "total": total,
        "by_status": by_status,
        "by_type": by_type,
        "by_priority": by_priority,
        "by_module": by_module,
        "today": today_count,
        "this_week": week_count,
        "pending_count": pending_count,
    }


@router.get("/assignees", dependencies=[Depends(require_permission("feedback", "view"))])
def list_feedback_assignees(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """可供指派的处理人列表（启用中的账号）。须在 /{feedback_id} 之前注册。"""
    _require_admin(current_user, db)
    rows = (
        db.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.id.asc())
        .all()
    )
    return {
        "items": [
            {
                "id": u.id,
                "username": u.username,
                "display_name": _display_name(u) or u.username,
            }
            for u in rows
        ]
    }


# ============ 5. 反馈详情 ============

@router.get("/{feedback_id}")
def get_feedback(
    feedback_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """反馈详情：全字段 + 操作历史 + 提交人/处理人信息（提交人或具备反馈管理权限可见）。"""
    feedback = _get_feedback_or_404(db, feedback_id)
    # 非提交人且无管理权限时返回 404，避免泄露「该 id 是否存在」
    if not _can_view_feedback(current_user, feedback, db):
        raise HTTPException(status_code=404, detail="反馈不存在")
    return _feedback_detail(db, feedback)


# ============ 6. 编辑反馈 ============

@router.put("/{feedback_id}")
def update_feedback(
    feedback_id: int,
    body: FeedbackUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """编辑反馈（仅提交人，pending/processing/replied 状态可编辑）。"""
    feedback = _get_feedback_or_404(db, feedback_id)
    if feedback.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="仅提交人可编辑该反馈")
    if feedback.status not in EDITABLE_STATUSES:
        raise HTTPException(status_code=400, detail="该反馈已完结，不可编辑")

    updates = body.model_dump(exclude_unset=True)
    # 文本字段清洗后更新
    for field in ("title", "module", "description", "reproduce_steps",
                  "expected_result", "actual_result", "contact"):
        if field in updates and updates[field] is not None:
            updates[field] = sanitize_text(str(updates[field]).strip())

    # 合并后校验：type=bug 时复现步骤三项必须齐全
    merged_type = updates.get("type", feedback.type) or feedback.type
    if merged_type == "bug":
        merged = {
            "reproduce_steps": updates.get("reproduce_steps", feedback.reproduce_steps),
            "expected_result": updates.get("expected_result", feedback.expected_result),
            "actual_result": updates.get("actual_result", feedback.actual_result),
        }
        missing = [BUG_REQUIRED_FIELDS[k] for k, v in merged.items() if not (v and str(v).strip())]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"BUG 类反馈必须填写: {'、'.join(missing)}",
            )

    if updates:
        for field, value in updates.items():
            setattr(feedback, field, value)
        db.add(FeedbackHistory(
            feedback_id=feedback.id,
            action="edit",
            content="提交人修改了反馈内容",
            operator_id=current_user.id,
        ))
        db.commit()
        db.refresh(feedback)
        logger.info("反馈已编辑: id=%s, fields=%s", feedback_id, list(updates))
    return _feedback_detail(db, feedback)


# ============ 7. 管理员回复 ============

@router.post("/{feedback_id}/replies", dependencies=[Depends(require_permission("feedback", "edit"))])
def reply_feedback(
    feedback_id: int,
    body: ReplyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """管理员回复反馈（可同步更新状态与指派处理人），并通知提交人。"""
    _require_admin(current_user, db)
    feedback = _get_feedback_or_404(db, feedback_id)

    content = sanitize_text(body.content.strip())
    db.add(FeedbackHistory(
        feedback_id=feedback.id,
        action="reply",
        content=content,
        to_status=body.new_status,
        operator_id=current_user.id,
    ))

    # 同步状态变更（校验合法流转）
    if body.new_status and body.new_status != feedback.status:
        if not _valid_transition(feedback.status, body.new_status):
            raise HTTPException(
                status_code=400,
                detail=f"非法的状态流转: {STATUS_LABELS.get(feedback.status, feedback.status)} → "
                       f"{STATUS_LABELS.get(body.new_status, body.new_status)}",
            )
        db.add(FeedbackHistory(
            feedback_id=feedback.id,
            action="status_change",
            from_status=feedback.status,
            to_status=body.new_status,
            operator_id=current_user.id,
        ))
        feedback.status = body.new_status

    # 明确指派，或尚未指派时记为当前处理人
    if body.assignee_id and body.assignee_id != feedback.assignee_id:
        target = db.query(User).filter(User.id == body.assignee_id, User.is_active.is_(True)).first()
        if not target:
            raise HTTPException(status_code=400, detail="处理人不存在或已禁用")
        db.add(FeedbackHistory(
            feedback_id=feedback.id,
            action="assign",
            content=_assign_history_content(current_user, target),
            operator_id=current_user.id,
        ))
        feedback.assignee_id = body.assignee_id
    # 回复/改状态不自动认领处理人，避免覆盖「未分配」

    # 通知提交人
    _notify(
        db,
        user_id=feedback.user_id,
        title="您的反馈有新回复",
        content=content[:100],
        related_id=feedback.id,
    )
    db.commit()
    db.refresh(feedback)
    logger.info("反馈已回复: id=%s, operator=%s, new_status=%s", feedback_id, current_user.username, body.new_status)
    return _feedback_detail(db, feedback)


# ============ 8. 管理员改状态 ============

@router.put("/{feedback_id}/status", dependencies=[Depends(require_permission("feedback", "edit"))])
def update_feedback_status(
    feedback_id: int,
    body: StatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """管理员更新反馈状态（校验合法流转），并通知提交人。"""
    _require_admin(current_user, db)
    feedback = _get_feedback_or_404(db, feedback_id)

    if not _valid_transition(feedback.status, body.status):
        raise HTTPException(
            status_code=400,
            detail=f"非法的状态流转: {STATUS_LABELS.get(feedback.status, feedback.status)} → "
                   f"{STATUS_LABELS.get(body.status, body.status)}",
        )
    if body.status == feedback.status:
        return _feedback_detail(db, feedback)

    from_status = feedback.status
    feedback.status = body.status
    db.add(FeedbackHistory(
        feedback_id=feedback.id,
        action="status_change",
        from_status=from_status,
        to_status=body.status,
        operator_id=current_user.id,
    ))
    _notify(
        db,
        user_id=feedback.user_id,
        title="您的反馈状态已更新",
        content=f"您的反馈「{feedback.title}」状态由 "
                f"{STATUS_LABELS.get(from_status, from_status)} 变更为 {STATUS_LABELS.get(body.status, body.status)}",
        related_id=feedback.id,
    )
    db.commit()
    db.refresh(feedback)
    logger.info("反馈状态已更新: id=%s, %s → %s, operator=%s",
                feedback_id, from_status, body.status, current_user.username)
    return _feedback_detail(db, feedback)


@router.put("/{feedback_id}/assignee", dependencies=[Depends(require_permission("feedback", "edit"))])
def assign_feedback(
    feedback_id: int,
    body: AssigneeUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """超级管理员主动指派或取消处理人。"""
    if not is_admin(current_user, db):
        raise HTTPException(status_code=403, detail="仅超级管理员可分配处理人")
    feedback = _get_feedback_or_404(db, feedback_id)

    target = None
    if body.assignee_id is not None:
        target = db.query(User).filter(User.id == body.assignee_id, User.is_active.is_(True)).first()
        if not target:
            raise HTTPException(status_code=400, detail="处理人不存在或已禁用")

    new_id = target.id if target else None
    if new_id == feedback.assignee_id:
        return _feedback_detail(db, feedback, backfill=False)

    feedback.assignee_id = new_id
    db.add(FeedbackHistory(
        feedback_id=feedback.id,
        action="assign",
        content=_assign_history_content(current_user, target),
        operator_id=current_user.id,
    ))
    if target and target.id != current_user.id:
        _notify(
            db,
            user_id=target.id,
            title="您被指派处理一条反馈",
            content=f"反馈「{feedback.title}」已指派给您",
            related_id=feedback.id,
        )
    db.commit()
    db.refresh(feedback)
    logger.info("反馈已指派: id=%s, assignee=%s, operator=%s", feedback_id, new_id, current_user.username)
    return _feedback_detail(db, feedback, backfill=False)


# ============ 9. 重新打开 ============

@router.post("/{feedback_id}/reopen")
def reopen_feedback(
    feedback_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """重新打开已完结反馈（提交人或 admin，仅 closed/resolved 可 reopen）。

    状态改回 pending，并通知所有管理员。
    """
    feedback = _get_feedback_or_404(db, feedback_id)
    if not _can_view_feedback(current_user, feedback, db):
        raise HTTPException(status_code=403, detail="仅提交人或管理员可重新打开该反馈")
    if feedback.status not in ("closed", "resolved"):
        raise HTTPException(status_code=400, detail="仅已关闭或已解决的反馈可以重新打开")

    from_status = feedback.status
    feedback.status = "pending"
    db.add(FeedbackHistory(
        feedback_id=feedback.id,
        action="reopen",
        from_status=from_status,
        to_status="pending",
        content="反馈被重新打开",
        operator_id=current_user.id,
    ))
    _notify_all_admins(
        db,
        title="反馈已重新打开",
        content=f"反馈「{feedback.title}」由 {current_user.username} 重新打开，请跟进处理",
        related_id=feedback.id,
    )
    db.commit()
    db.refresh(feedback)
    logger.info("反馈已重新打开: id=%s, operator=%s, %s → pending",
                feedback_id, current_user.username, from_status)
    return _feedback_detail(db, feedback)


# ============ 2. 上传附件 ============

@router.post("/{feedback_id}/attachments", status_code=201)
async def upload_attachment(
    feedback_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """为反馈上传附件（仅提交人或 admin）。

    - 扩展名白名单：png/jpg/jpeg/gif/webp/bmp/pdf/txt/log/md/csv/zip；
    - 单文件不超过 10MB；
    - 保存到 ``backend/uploads/feedback/{feedback_id}/``，文件名用 uuid 防冲突。
    """
    feedback = _get_feedback_or_404(db, feedback_id)
    if not _can_view_feedback(current_user, feedback, db):
        raise HTTPException(status_code=403, detail="仅提交人或管理员可上传附件")

    original_name = file.filename or "untitled"
    ext = os.path.splitext(original_name)[1].lower().lstrip(".")
    if ext not in ALLOWED_ATTACHMENT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的文件类型")

    file_bytes = await file.read()
    if len(file_bytes) > MAX_ATTACHMENT_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过限制（最大 10MB）")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="文件内容为空")

    # 保存到 uploads/feedback/{feedback_id}/，文件名用 uuid + 原扩展名
    save_dir = os.path.join(UPLOAD_DIR, str(feedback_id))
    os.makedirs(save_dir, exist_ok=True)
    saved_filename = f"{uuid.uuid4().hex}.{ext}" if ext else uuid.uuid4().hex
    saved_path = os.path.join(save_dir, saved_filename)
    with open(saved_path, "wb") as f:
        f.write(file_bytes)
    logger.info("反馈附件已保存: feedback_id=%s, file=%s, size=%d bytes",
                feedback_id, saved_filename, len(file_bytes))

    # 追加附件清单（JSON 数组字符串）
    attachments = _parse_attachments(feedback.attachments)
    attachments.append({
        "name": sanitize_text(original_name),
        "path": f"feedback/{feedback_id}/{saved_filename}",
        "size": len(file_bytes),
    })
    feedback.attachments = json.dumps(attachments, ensure_ascii=False)
    db.commit()

    return {
        "name": sanitize_text(original_name),
        "size": len(file_bytes),
        "url": f"/api/v1/feedbacks/{feedback_id}/attachments/{saved_filename}",
    }


# ============ 3. 下载/预览附件 ============
# 独立 router：不走主 router 的登录依赖，支持 ?token= query 参数认证
# （<img> / <a> 标签无法携带 Authorization 头，缩略图/下载需要 query token）


def _query_token_auth(request: Request, db: Session = Depends(get_db)) -> User:
    """附件访问专用鉴权：优先 query token，其次标准 Authorization 头。"""
    token = request.query_params.get("token")
    if token:
        return get_current_user(authorization=f"Bearer {token}", db=db)
    return get_current_user(authorization=request.headers.get("authorization"), db=db)


download_router = APIRouter(prefix="/feedbacks", tags=["feedbacks"])


@download_router.get("/{feedback_id}/attachments/{filename}")
def download_attachment(
    feedback_id: int,
    filename: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(_query_token_auth),
) -> FileResponse:
    """下载/预览反馈附件（提交人或 admin，做路径穿越校验）。

    支持 ``?token=<jwt>`` 认证，供前端 <img> 缩略图直接加载。
    """
    feedback = _get_feedback_or_404(db, feedback_id)
    if not _can_view_feedback(current_user, feedback, db):
        raise HTTPException(status_code=403, detail="仅提交人或管理员可下载附件")

    # 路径穿越校验：文件名不允许包含路径分隔符与上溯符
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="非法的文件名")

    file_path = os.path.abspath(os.path.join(UPLOAD_DIR, str(feedback_id), filename))
    if not file_path.startswith(os.path.abspath(UPLOAD_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="非法的文件名")
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="附件不存在")

    # 图片类型内联显示（供 <img> 缩略图 / lightbox 直接加载），非图片保持下载
    ext = os.path.splitext(filename)[1].lower()
    image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
    if ext in image_exts:
        return FileResponse(file_path, filename=filename, content_disposition_type="inline")
    return FileResponse(file_path, filename=filename)


# ============ 11. 批量操作 ============

@router.post("/batch", dependencies=[Depends(require_permission("feedback", "edit"))])
def batch_action(
    body: BatchAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """批量操作反馈（admin only）：
    - close=批量关闭 / processed=批量标记处理中（每条写 batch 历史 + 通知提交人）
    - delete=硬删除（级联清理附件/历史/通知，删除即静默，不发通知）
    """
    _require_admin(current_user, db)

    feedbacks = db.query(Feedback).filter(Feedback.id.in_(body.ids)).all()

    # 批量硬删除：级联清理，单次事务提交
    if body.action == "delete":
        for fb in feedbacks:
            _cascade_delete_feedback(db, fb)
        db.commit()
        logger.warning(
            "反馈批量删除: ids=%s, deleted=%d, operator=%s",
            body.ids, len(feedbacks), current_user.username,
        )
        return {"updated": len(feedbacks)}

    # 状态变更分支：close / processed
    target_status = "closed" if body.action == "close" else "processing"

    for feedback in feedbacks:
        if feedback.status == target_status:
            continue
        from_status = feedback.status
        feedback.status = target_status
        db.add(FeedbackHistory(
            feedback_id=feedback.id,
            action="batch",
            from_status=from_status,
            to_status=target_status,
            content=f"批量{'关闭' if body.action == 'close' else '标记处理中'}",
            operator_id=current_user.id,
        ))
        # 每条反馈通知提交人一次
        _notify(
            db,
            user_id=feedback.user_id,
            title="您的反馈状态已更新",
            content=f"您的反馈「{feedback.title}」被批量标记为 {STATUS_LABELS.get(target_status, target_status)}",
            related_id=feedback.id,
        )

    db.commit()
    updated = len(feedbacks)
    logger.info("反馈批量操作完成: action=%s, ids=%s, updated=%d, operator=%s",
                body.ids, body.ids, updated, current_user.username)
    return {"updated": updated}


# ============ 12. 删除反馈（admin only，硬删除） ============

@router.delete(
    "/{feedback_id}",
    status_code=204,
    dependencies=[Depends(require_permission("feedback", "delete"))],
)
def delete_feedback(
    feedback_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除反馈（admin only）：级联清理附件文件、历史、关联通知。

    硬删除，操作不可恢复。删除附件文件失败不阻断主流程，仅记录日志。
    """
    _require_admin(current_user, db)
    feedback = _get_feedback_or_404(db, feedback_id)
    _cascade_delete_feedback(db, feedback)
    db.commit()
    logger.warning(
        "反馈已删除: id=%s, title=%s, operator=%s",
        feedback_id, feedback.title, current_user.username,
    )
    return None
