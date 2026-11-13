"""材料管理 API。

按目录类别（树形，最多 10 级）归类管理交付文件，支持上传 / 下载 / 批量下载 / 更新元数据 / 删除。

安全设计：
- 文件扩展名白名单（办公文档 + 压缩包 + 文本），拒绝一切可执行文件；
- 单文件大小限制 200MB；
- 落盘使用 uuid 文件名 + 扩展名，杜绝路径穿越；
- 下载时以原始文件名返回（Content-Disposition UTF-8 编码）；
- 批量下载打包为 zip，文件名冲突自动追加序号；
- 权限：view 可查看/下载，edit 可上传/编辑，delete 可删除。
"""
import hashlib
import io
import logging
import os
import uuid
import zipfile
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.core.timezone import to_beijing_iso
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.deliverable import Deliverable, ServiceCategory
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/deliverables", tags=["deliverables"])

# ============ 常量 ============

# 附件扩展名白名单：办公文档 / 压缩包 / 文本
ALLOWED_EXTENSIONS = {
    "xlsx", "xls", "doc", "docx", "ppt", "pptx", "pdf",
    "zip", "rar", "7z",
    "txt", "csv", "md",
}
MAX_FILE_SIZE = 200 * 1024 * 1024  # 200MB
# 批量下载最大文件数（防止一次性打包过多导致内存溢出）
BATCH_DOWNLOAD_MAX = 50
# 批量移动最大条目数（材料 / 目录各自独立计数，避免与下载上限耦合）
BATCH_MOVE_MAX = 50


# 文件保存目录：backend/uploads/deliverables/
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
    "deliverables",
)
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ============ 辅助函数 ============

def _get_category_or_404(db: Session, category_id: int) -> ServiceCategory:
    """按 ID 查目录类别，不存在抛 404。"""
    category = db.query(ServiceCategory).filter(ServiceCategory.id == category_id).first()
    if category is None:
        raise HTTPException(status_code=404, detail="目录类别不存在")
    return category


def _get_deliverable_or_404(db: Session, deliverable_id: int) -> Deliverable:
    """按 ID 查材料，不存在抛 404。"""
    deliverable = db.query(Deliverable).filter(Deliverable.id == deliverable_id).first()
    if deliverable is None:
        raise HTTPException(status_code=404, detail="材料不存在")
    return deliverable


def _stored_path(stored_name: str) -> str:
    """落盘文件绝对路径；校验文件名不含路径分隔符，防路径穿越。"""
    if not stored_name or "/" in stored_name or "\\" in stored_name or ".." in stored_name:
        raise HTTPException(status_code=400, detail="非法文件名")
    return os.path.join(UPLOAD_DIR, stored_name)


def _find_duplicate(
    db: Session, category_id: int, content: bytes, content_hash: str
) -> Deliverable | None:
    """同目录下按文件内容判重，命中返回已有材料记录。

    口径：仅同一目录内、文件内容完全相同（SHA-256）才算重复；
    同名的不同内容（新版本）不算重复。存量记录可能没有 content_hash，
    此时只对同大小候选比对磁盘内容，并无论是否命中都回填哈希，
    避免后续每次上传重复读取同一批老文件。
    """
    hit = (
        db.query(Deliverable)
        .filter(
            Deliverable.category_id == category_id,
            Deliverable.content_hash == content_hash,
        )
        .order_by(Deliverable.id.asc())
        .first()
    )
    if hit is not None:
        return hit

    candidates = (
        db.query(Deliverable)
        .filter(
            Deliverable.category_id == category_id,
            Deliverable.content_hash.is_(None),
            Deliverable.file_size == len(content),
        )
        .order_by(Deliverable.id.asc())
        .all()
    )
    found: Deliverable | None = None
    compared = False
    for cand in candidates:
        try:
            hasher = hashlib.sha256()
            with open(_stored_path(cand.stored_name), "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    hasher.update(chunk)
        except (OSError, HTTPException) as exc:
            logger.warning("判重时读取存量文件失败: %s (%s)", cand.stored_name, exc)
            continue
        digest = hasher.hexdigest()
        # 回填哈希：未命中的候选也写回，保证每个存量文件最多被读一次
        cand.content_hash = digest
        compared = True
        if digest == content_hash and found is None:
            found = cand
    if compared:
        # 只 flush 不 commit：由调用方决定事务边界，避免请求中途提前提交
        db.flush()
    return found


def _validate_upload(file: UploadFile) -> str:
    """校验上传文件扩展名白名单，返回小写扩展名；不合法抛 400。"""
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if not ext or ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型（.{'/'.join(sorted(ALLOWED_EXTENSIONS))}）",
        )
    return ext


def _user_map(db: Session, user_ids: list[int]) -> dict[int, str]:
    """批量查用户名映射 {user_id: username}。"""
    if not user_ids:
        return {}
    rows = db.query(User.id, User.username).filter(User.id.in_(user_ids)).all()
    return {row[0]: row[1] for row in rows}


def _collect_descendant_ids(db: Session, category_id: int) -> list[int]:
    """递归收集某类别下所有后代类别 ID（不含自身）。

    采用逐层查询（层级最多 10，单层条目有限），避免递归 CTE 在老版 PG 上不可用。
    """
    result: list[int] = []
    frontier = [category_id]
    for _ in range(ServiceCategory.MAX_LEVEL):
        if not frontier:
            break
        rows = (
            db.query(ServiceCategory.id)
            .filter(ServiceCategory.parent_id.in_(frontier))
            .all()
        )
        next_ids = [r[0] for r in rows]
        result.extend(next_ids)
        frontier = next_ids
    return result


def _is_descendant(db: Session, category_id: int, candidate_parent_id: int) -> bool:
    """判断 candidate_parent_id 是否是 category_id 的后代（用于防止移动成自己的子孙）。"""
    return candidate_parent_id in _collect_descendant_ids(db, category_id)


def _subtree_height(db: Session, category_id: int) -> int:
    """返回以该目录为根的子树的层数（仅自身算 1）。

    用于移动前预判：把整棵子树挂到更深处后，最深层是否会超过 MAX_LEVEL。
    逐层查询（层级最多 10），与 _collect_descendant_ids 同思路。
    """
    height = 1
    frontier = [category_id]
    for _ in range(ServiceCategory.MAX_LEVEL):
        if not frontier:
            break
        rows = (
            db.query(ServiceCategory.id)
            .filter(ServiceCategory.parent_id.in_(frontier))
            .all()
        )
        next_ids = [r[0] for r in rows]
        if not next_ids:
            break
        height += 1
        frontier = next_ids
    return height


def _refresh_descendant_levels(db: Session, category: ServiceCategory) -> int:
    """移动目录后，递归修正其所有后代的 level，使其始终等于 parent.level + 1。

    只改 level（树的父子关系由 parent_id 决定，本身已经跟着走），
    返回被修正的目录数。逐层下推，避免递归 CTE。
    """
    fixed = 0
    frontier = [(category.id, category.level or 1)]
    for _ in range(ServiceCategory.MAX_LEVEL):
        if not frontier:
            break
        next_frontier: list[tuple[int, int]] = []
        for parent_id, parent_level in frontier:
            children = (
                db.query(ServiceCategory)
                .filter(ServiceCategory.parent_id == parent_id)
                .all()
            )
            for child in children:
                child.level = parent_level + 1
                fixed += 1
                next_frontier.append((child.id, child.level))
        frontier = next_frontier
    return fixed


def _parse_relative_dir(relative_path: str, filename: str) -> list[str]:
    """从相对路径解析目录段（不含文件名），用于按原文件夹结构迁入。

    接受 ``季度报告/实施方案/方案.docx`` 或 ``季度报告/实施方案``。
    拒绝 ``.`` / ``..`` / 空段，防止路径穿越。
    """
    raw = (relative_path or "").replace("\\", "/").strip()
    if not raw:
        return []
    parts = [p.strip() for p in raw.split("/") if p.strip()]
    cleaned: list[str] = []
    for part in parts:
        if part in {".", ".."} or "/" in part or "\\" in part:
            raise HTTPException(status_code=400, detail="相对路径非法")
        if len(part) > 100:
            raise HTTPException(status_code=400, detail=f"目录名不能超过 100 字：{part}")
        cleaned.append(part)
    if not cleaned:
        return []
    last = cleaned[-1]
    base = os.path.basename(filename or "")
    last_ext = last.rsplit(".", 1)[-1].lower() if "." in last else ""
    if last == base or last_ext in ALLOWED_EXTENSIONS:
        cleaned = cleaned[:-1]
    return cleaned


def _ensure_category_path(
    db: Session,
    root: ServiceCategory,
    segments: list[str],
    user: User,
) -> ServiceCategory:
    """从 root 起按目录段逐级查找或创建子目录（同级同名复用），返回叶子目录。"""
    current = root
    for name in segments:
        name = sanitize_text(name).strip()
        if not name:
            raise HTTPException(status_code=400, detail="目录名不能为空")
        next_level = (current.level or 1) + 1
        if next_level > ServiceCategory.MAX_LEVEL:
            raise HTTPException(
                status_code=400,
                detail=f"目录层级不能超过 {ServiceCategory.MAX_LEVEL} 级，请缩短文件夹深度",
            )
        child = (
            db.query(ServiceCategory)
            .filter(
                ServiceCategory.parent_id == current.id,
                ServiceCategory.name == name,
            )
            .first()
        )
        if child is None:
            max_order = (
                db.query(func.max(ServiceCategory.sort_order))
                .filter(ServiceCategory.parent_id == current.id)
                .scalar()
                or 0
            )
            child = ServiceCategory(
                name=name,
                description=None,
                parent_id=current.id,
                level=next_level,
                sort_order=max_order + 1,
                created_by=user.id,
            )
            db.add(child)
            db.flush()
        current = child
    return current


# ============ 1. 目录类别 ============

@router.get("/categories")
def list_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """服务类别列表（按 sort_order / id 排序），扁平结构带 parent_id/level，
    前端据此构建树形目录。每个类别附带递归文件总数（含所有后代）与直接子类别数。"""
    categories = (
        db.query(ServiceCategory)
        .order_by(ServiceCategory.sort_order.asc(), ServiceCategory.id.asc())
        .all()
    )
    # 各目录直接材料数
    count_rows = (
        db.query(Deliverable.category_id, func.count(Deliverable.id))
        .group_by(Deliverable.category_id)
        .all()
    )
    direct_counts = {row[0]: row[1] for row in count_rows}
    # 子类别计数
    child_rows = (
        db.query(ServiceCategory.parent_id, func.count(ServiceCategory.id))
        .filter(ServiceCategory.parent_id.isnot(None))
        .group_by(ServiceCategory.parent_id)
        .all()
    )
    child_counts = {row[0]: row[1] for row in child_rows}

    # 构建递归材料总数：每个目录 = 自身直接数 + 所有后代直接数之和
    # 先建 parent_id → [child_ids] 映射
    children_map: dict[int | None, list[int]] = {}
    for c in categories:
        children_map.setdefault(c.parent_id, []).append(c.id)

    def _recursive_count(cat_id: int) -> int:
        """递归汇总某目录及其所有后代的材料数。"""
        total = direct_counts.get(cat_id, 0)
        for child_id in children_map.get(cat_id, []):
            total += _recursive_count(child_id)
        return total

    users = _user_map(db, [c.created_by for c in categories])
    # 全局材料总数（直接查 Deliverable 表，避免递归累加重复计算）
    total_deliverables = db.query(func.count(Deliverable.id)).scalar() or 0
    return {
        "items": [
            {
                **c.to_dict(
                    deliverable_count=_recursive_count(c.id),
                    descendant_count=child_counts.get(c.id, 0),
                ),
                "creator_name": users.get(c.created_by, ""),
            }
            for c in categories
        ],
        "total_deliverables": total_deliverables,
    }


@router.get("/stats")
def deliverable_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """材料管理大屏统计：总类别 / 总文件 / 各类别文件数 / 扩展名分布 / 趋势 / 最近上传。"""
    from datetime import datetime, timedelta

    total_categories = db.query(func.count(ServiceCategory.id)).scalar() or 0
    total_files = db.query(func.count(Deliverable.id)).scalar() or 0
    total_size = db.query(func.coalesce(func.sum(Deliverable.file_size), 0)).scalar() or 0

    now = datetime.utcnow()

    # 今日 / 昨日新增（环比）
    today_start = datetime(now.year, now.month, now.day)
    yesterday_start = today_start - timedelta(days=1)
    today_count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.created_at >= today_start)
        .scalar() or 0
    )
    yesterday_count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.created_at >= yesterday_start, Deliverable.created_at < today_start)
        .scalar() or 0
    )
    # 上周总数（周环比）
    week_ago = today_start - timedelta(days=7)
    this_week_count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.created_at >= week_ago)
        .scalar() or 0
    )
    last_week_start = today_start - timedelta(days=14)
    last_week_count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.created_at >= last_week_start, Deliverable.created_at < week_ago)
        .scalar() or 0
    )

    # 活跃目录数（有至少 1 个文件的目录）
    active_dirs = (
        db.query(func.count(func.distinct(Deliverable.category_id)))
        .scalar() or 0
    )

    # 各类别文件数 Top
    cat_rows = (
        db.query(
            ServiceCategory.id,
            ServiceCategory.name,
            func.count(Deliverable.id),
            func.coalesce(func.sum(Deliverable.file_size), 0),
        )
        .outerjoin(Deliverable, Deliverable.category_id == ServiceCategory.id)
        .group_by(ServiceCategory.id, ServiceCategory.name)
        .order_by(func.count(Deliverable.id).desc())
        .limit(8)
        .all()
    )
    by_category = [
        {"id": r[0], "name": r[1], "count": r[2], "size": int(r[3])}
        for r in cat_rows
    ]

    # ============ 各层级目录文件数排行（一/二/三级，递归含子目录）============
    # 复用 list_categories 中递归汇总逻辑：每个目录的文件数 = 自身直接数 + 所有后代直接数之和
    all_cats_level = (
        db.query(ServiceCategory)
        .order_by(ServiceCategory.sort_order.asc(), ServiceCategory.id.asc())
        .all()
    )
    direct_count_map = {
        r[0]: r[1]
        for r in db.query(Deliverable.category_id, func.count(Deliverable.id))
        .group_by(Deliverable.category_id)
        .all()
    }
    level_children_map: dict[int | None, list[int]] = {}
    for c in all_cats_level:
        level_children_map.setdefault(c.parent_id, []).append(c.id)
    # 父级名称映射，便于拼接路径前缀（如 父级 / 子级）
    parent_name_map = {c.id: c.name for c in all_cats_level}

    def _level_recursive_count(cat_id: int) -> int:
        total = direct_count_map.get(cat_id, 0)
        for child_id in level_children_map.get(cat_id, []):
            total += _level_recursive_count(child_id)
        return total

    def _build_path(cat) -> str:
        """拼接从根到当前目录的名称路径，便于区分同名目录。"""
        parts = [cat.name]
        pid = cat.parent_id
        safety = 0
        while pid and safety < ServiceCategory.MAX_LEVEL:
            parent_name = parent_name_map.get(pid)
            if not parent_name:
                break
            parts.append(parent_name)
            # 继续向上
            parent_cat = next((c for c in all_cats_level if c.id == pid), None)
            if not parent_cat:
                break
            pid = parent_cat.parent_id
            safety += 1
        return " / ".join(reversed(parts))

    by_level: dict[int, list[dict]] = {1: [], 2: [], 3: []}
    for c in all_cats_level:
        lvl = c.level or 1
        if lvl not in (1, 2, 3):
            continue
        by_level[lvl].append({
            "id": c.id,
            "name": c.name,
            "path": _build_path(c),
            "count": _level_recursive_count(c.id),
        })
    # 各层级按文件数倒序，取 Top 8
    by_level_1 = sorted(by_level[1], key=lambda x: x["count"], reverse=True)[:8]
    by_level_2 = sorted(by_level[2], key=lambda x: x["count"], reverse=True)[:8]
    by_level_3 = sorted(by_level[3], key=lambda x: x["count"], reverse=True)[:8]

    # 按月统计（近 12 个月）
    by_month = []
    for i in range(11, -1, -1):
        m = now - timedelta(days=i * 30)
        month_start = datetime(m.year, m.month, 1)
        if m.month == 12:
            month_end = datetime(m.year + 1, 1, 1)
        else:
            month_end = datetime(m.year, m.month + 1, 1)
        cnt = (
            db.query(func.count(Deliverable.id))
            .filter(Deliverable.created_at >= month_start, Deliverable.created_at < month_end)
            .scalar() or 0
        )
        by_month.append({"month": f"{m.year}-{m.month:02d}", "count": cnt})

    # 扩展名分布（带大小详情）
    ext_rows = (
        db.query(
            Deliverable.file_ext,
            func.count(Deliverable.id),
            func.coalesce(func.sum(Deliverable.file_size), 0),
        )
        .group_by(Deliverable.file_ext)
        .order_by(func.count(Deliverable.id).desc())
        .all()
    )
    by_ext = [
        {
            "ext": r[0],
            "count": r[1],
            "total_size": int(r[2]),
            "avg_size": int(r[2] / r[1]) if r[1] > 0 else 0,
        }
        for r in ext_rows
    ]

    # 近 7 日趋势（文件数 + 总大小）
    recent_week: list[dict] = []
    for i in range(6, -1, -1):
        d = now - timedelta(days=i)
        day_start = datetime(d.year, d.month, d.day)
        day_end = day_start + timedelta(days=1)
        row = (
            db.query(
                func.count(Deliverable.id),
                func.coalesce(func.sum(Deliverable.file_size), 0),
            )
            .filter(Deliverable.created_at >= day_start, Deliverable.created_at < day_end)
            .first()
        )
        recent_week.append({
            "date": f"{d.month:02d}-{d.day:02d}",
            "count": row[0] or 0,
            "size": int(row[1] or 0),
        })

    # 近 30 日趋势（精简版）
    trend_30d: list[dict] = []
    for i in range(29, -1, -1):
        d = now - timedelta(days=i)
        day_start = datetime(d.year, d.month, d.day)
        day_end = day_start + timedelta(days=1)
        cnt = (
            db.query(func.count(Deliverable.id))
            .filter(Deliverable.created_at >= day_start, Deliverable.created_at < day_end)
            .scalar() or 0
        )
        trend_30d.append({"date": f"{d.month:02d}-{d.day:02d}", "count": cnt})

    # 本年度月度趋势
    year_start = datetime(now.year, 1, 1)
    trend_year: list[dict] = []
    for m in range(1, 13):
        ms = datetime(now.year, m, 1)
        me = datetime(now.year, m + 1, 1) if m < 12 else datetime(now.year + 1, 1, 1)
        if ms > now:
            break
        cnt = (
            db.query(func.count(Deliverable.id))
            .filter(Deliverable.created_at >= ms, Deliverable.created_at < me)
            .scalar() or 0
        )
        trend_year.append({"month": f"{m}月", "count": cnt})

    # Top 5 上传人
    user_rows = (
        db.query(
            Deliverable.created_by,
            func.count(Deliverable.id),
            func.coalesce(func.sum(Deliverable.file_size), 0),
        )
        .group_by(Deliverable.created_by)
        .order_by(func.count(Deliverable.id).desc())
        .limit(5)
        .all()
    )
    user_ids = [r[0] for r in user_rows]
    user_map = _user_map(db, user_ids)
    by_user = [
        {
            "user_id": r[0],
            "username": user_map.get(r[0], "未知"),
            "count": r[1],
            "total_size": int(r[2]),
        }
        for r in user_rows
    ]

    # 最近 8 个上传
    recent_rows = (
        db.query(Deliverable, ServiceCategory.name)
        .join(ServiceCategory, ServiceCategory.id == Deliverable.category_id)
        .order_by(Deliverable.created_at.desc())
        .limit(8)
        .all()
    )
    recent_users = _user_map(db, [r[0].created_by for r in recent_rows])
    recent = [
        {
            **r[0].to_dict(creator_name=recent_users.get(r[0].created_by, "")),
            "category_name": r[1],
        }
        for r in recent_rows
    ]

    return {
        "total_categories": total_categories,
        "total_files": total_files,
        "total_size": int(total_size),
        "today_count": today_count,
        "yesterday_count": yesterday_count,
        "this_week_count": this_week_count,
        "last_week_count": last_week_count,
        "active_dirs": active_dirs,
        "by_category": by_category,
        "by_level_1": by_level_1,
        "by_level_2": by_level_2,
        "by_level_3": by_level_3,
        "by_month": by_month,
        "by_ext": by_ext,
        "by_user": by_user,
        "recent_week": recent_week,
        "trend_30d": trend_30d,
        "trend_year": trend_year,
        "recent_uploads": recent,
    }


@router.post("/categories", status_code=201)
def create_category(
    name: str = Form(...),
    description: str = Form(""),
    parent_id: int = Form(0),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """创建目录类别（同级名称唯一，支持最多 10 级子目录）。

    - ``parent_id`` 为 0 或缺省 → 创建根类别（level=1）。
    - 否则创建为 parent 的子类别，level = parent.level + 1，不得超过 10。
    """
    name = sanitize_text(name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="类别名称不能为空")
    if len(name) > 100:
        raise HTTPException(status_code=400, detail="类别名称不能超过 100 字")

    parent: ServiceCategory | None = None
    level = 1
    if parent_id:
        parent = _get_category_or_404(db, parent_id)
        level = (parent.level or 1) + 1
        if level > ServiceCategory.MAX_LEVEL:
            raise HTTPException(
                status_code=400,
                detail=f"目录层级不能超过 {ServiceCategory.MAX_LEVEL} 级",
            )

    # 同级（同一 parent_id 下）名称唯一
    dup_q = db.query(ServiceCategory).filter(ServiceCategory.name == name)
    if parent is None:
        dup_q = dup_q.filter(ServiceCategory.parent_id.is_(None))
    else:
        dup_q = dup_q.filter(ServiceCategory.parent_id == parent_id)
    if dup_q.first():
        raise HTTPException(status_code=400, detail=f"同级下名称「{name}」已存在")

    # 同级排序：取该层最大 sort_order + 1
    sibling_q = db.query(func.max(ServiceCategory.sort_order))
    if parent is None:
        sibling_q = sibling_q.filter(ServiceCategory.parent_id.is_(None))
    else:
        sibling_q = sibling_q.filter(ServiceCategory.parent_id == parent_id)
    max_order = sibling_q.scalar() or 0

    category = ServiceCategory(
        name=name,
        description=sanitize_text(description)[:500] if description else None,
        parent_id=parent.id if parent else None,
        level=level,
        sort_order=max_order + 1,
        created_by=current_user.id,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    return {
        **category.to_dict(deliverable_count=0, descendant_count=0),
        "creator_name": current_user.username,
    }


@router.put("/categories/{category_id}")
def update_category(
    category_id: int,
    name: str = Form(...),
    description: str = Form(""),
    parent_id: str = Form(""),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """更新目录类别名称 / 描述 / 所属父级。

    - ``parent_id`` 为空字符串表示不修改父级；为 "0" 表示移到根级；
      为正整数表示移到对应父级下。
    - 移动时校验：不能把自己作为自己的后代；层级不得超过 10；同级名称唯一。
    """
    category = _get_category_or_404(db, category_id)
    name = sanitize_text(name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="类别名称不能为空")
    if len(name) > 100:
        raise HTTPException(status_code=400, detail="类别名称不能超过 100 字")

    move_requested = parent_id != ""
    new_parent_id: int | None = None
    new_level = category.level or 1
    if move_requested:
        try:
            pid_val = int(parent_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="父级类别参数非法")
        if pid_val == 0:
            new_parent_id = None
            new_level = 1
        else:
            if pid_val == category_id:
                raise HTTPException(status_code=400, detail="不能把自己设为父级")
            new_parent = _get_category_or_404(db, pid_val)
            # 防止移动到自己的后代下（形成环）
            if _is_descendant(db, category_id, pid_val):
                raise HTTPException(status_code=400, detail="不能移动到自己的子目录下")
            new_parent_id = new_parent.id
            new_level = (new_parent.level or 1) + 1
            if new_level > ServiceCategory.MAX_LEVEL:
                raise HTTPException(
                    status_code=400,
                    detail=f"目录层级不能超过 {ServiceCategory.MAX_LEVEL} 级",
                )
        # 整棵子树一起移动：预判最深层是否越界（否则子目录会被挤到第 11 层）
        sub_depth = _subtree_height(db, category_id) - 1
        if new_level + sub_depth > ServiceCategory.MAX_LEVEL:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"该目录下还有 {sub_depth} 层子目录，移动后最深层级将达到 "
                    f"L{new_level + sub_depth}，超过上限 {ServiceCategory.MAX_LEVEL}，"
                    f"请选择更浅的父级"
                ),
            )
        # 同级名称唯一（排除自身）
        dup_q = db.query(ServiceCategory).filter(
            ServiceCategory.name == name,
            ServiceCategory.id != category_id,
        )
        if new_parent_id is None:
            dup_q = dup_q.filter(ServiceCategory.parent_id.is_(None))
        else:
            dup_q = dup_q.filter(ServiceCategory.parent_id == new_parent_id)
        if dup_q.first():
            raise HTTPException(status_code=400, detail=f"同级下名称「{name}」已存在")
        category.parent_id = new_parent_id
        category.level = new_level
        # 子目录跟着走：递归修正后代 level，保证与 parent.level + 1 一致
        _refresh_descendant_levels(db, category)
    else:
        # 仅改名：在原同级下检查重名
        dup_q = db.query(ServiceCategory).filter(
            ServiceCategory.name == name,
            ServiceCategory.id != category_id,
        )
        if category.parent_id is None:
            dup_q = dup_q.filter(ServiceCategory.parent_id.is_(None))
        else:
            dup_q = dup_q.filter(ServiceCategory.parent_id == category.parent_id)
        if dup_q.first():
            raise HTTPException(status_code=400, detail=f"同级下名称「{name}」已存在")

    category.name = name
    category.description = sanitize_text(description)[:500] if description else None
    db.commit()
    return category.to_dict()


@router.post("/categories/batch-move")
def batch_move_categories(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """批量移动目录到目标父级（整棵子树跟着走，目录内文件不动）。

    - 请求体 ``{"ids": [1, 2], "target_parent_id": 10}``；``target_parent_id=0`` 表示移到根级。
    - 逐项校验（自身 / 成环 / 越界 / 同级重名），非法项计入 ``skipped`` 并附原因，
      不影响其余目录；全部处理完统一提交。
    - 目录内的文件无需任何改动（文件按 category_id 挂载，天然跟随）。
    - 移动后递归修正整棵子树的 level。
    """
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    raw_target = payload.get("target_parent_id") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="请选择要移动的目录")
    if len(raw_ids) > BATCH_MOVE_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"批量移动最多 {BATCH_MOVE_MAX} 个目录，请减少选择数量",
        )
    try:
        target_parent_id = int(raw_target)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="目标目录参数非法")

    target: ServiceCategory | None = None
    if target_parent_id:
        target = _get_category_or_404(db, target_parent_id)
    new_level = (target.level or 1) + 1 if target else 1

    # 去重 + 转整
    ids: list[int] = []
    seen: set[int] = set()
    for x in raw_ids:
        try:
            iid = int(x)
        except (TypeError, ValueError):
            continue
        if iid in seen:
            continue
        seen.add(iid)
        ids.append(iid)

    # 全部 id 都非法（如 ["abc"]）时直接返回，避免 in_([]) 退化 SQL
    if not ids:
        return {"moved": 0, "moved_ids": [], "skipped": []}

    moved: list[int] = []
    skipped: list[dict] = []
    for cid in ids:
        cat = db.query(ServiceCategory).filter(ServiceCategory.id == cid).first()
        if cat is None:
            skipped.append({"id": cid, "name": "", "reason": "目录不存在"})
            continue
        if target is not None and target.id == cat.id:
            skipped.append({"id": cid, "name": cat.name, "reason": "目标就是该目录自身"})
            continue
        if target is not None and _is_descendant(db, cat.id, target.id):
            skipped.append({"id": cid, "name": cat.name, "reason": "不能移动到自己的子目录下"})
            continue

        new_parent_id = target.id if target is not None else None
        # 同级重名（排除自身）
        dup_q = db.query(ServiceCategory).filter(
            ServiceCategory.name == cat.name,
            ServiceCategory.id != cat.id,
        )
        if new_parent_id is None:
            dup_q = dup_q.filter(ServiceCategory.parent_id.is_(None))
        else:
            dup_q = dup_q.filter(ServiceCategory.parent_id == new_parent_id)
        if dup_q.first():
            skipped.append({
                "id": cid, "name": cat.name,
                "reason": f"目标层级下已存在同名目录「{cat.name}」",
            })
            continue

        sub_depth = _subtree_height(db, cat.id) - 1
        if new_level + sub_depth > ServiceCategory.MAX_LEVEL:
            skipped.append({
                "id": cid, "name": cat.name,
                "reason": (
                    f"其下还有 {sub_depth} 层子目录，移动后最深层级将达 "
                    f"L{new_level + sub_depth}，超过上限 {ServiceCategory.MAX_LEVEL}"
                ),
            })
            continue

        cat.parent_id = new_parent_id
        cat.level = new_level
        _refresh_descendant_levels(db, cat)
        moved.append(cat.id)

    db.commit()
    logger.info(
        "目录已批量移动: moved=%s, skipped=%s, target_parent_id=%s, operator=%s",
        len(moved), len(skipped), target_parent_id, current_user.username,
    )
    return {"moved": len(moved), "moved_ids": moved, "skipped": skipped}


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "delete")),
):
    """删除目录类别：类别下仍有子目录或材料时拒绝（须先清空）。"""
    category = _get_category_or_404(db, category_id)
    # 检查直接子目录
    child_count = (
        db.query(func.count(ServiceCategory.id))
        .filter(ServiceCategory.parent_id == category_id)
        .scalar() or 0
    )
    if child_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"该目录下还有 {child_count} 个子目录，请先删除子目录",
        )
    # 检查直接材料
    count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.category_id == category_id)
        .scalar() or 0
    )
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"目录下还有 {count} 个材料，请先删除或转移后再删除目录",
        )
    db.delete(category)
    db.commit()
    return None


# 导出目录时单次最多打包文件数（防止一次性打包过多导致内存/磁盘溢出）
CATEGORY_EXPORT_MAX_FILES = 500


@router.get("/categories/{category_id}/export")
def export_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """导出目录：将该目录及其所有子目录递归打包为 zip，保留目录结构。

    - zip 顶层为该目录名，内部每个子目录对应一个文件夹（同名目录自动追加序号防冲突）。
    - 空子目录也会作为空文件夹保留在 zip 中。
    - 总文件数上限 500，超出提示缩小导出范围。
    - 缺失落盘文件跳过（不影响其余打包），权限：deliverable.view 即可。
    """
    import tempfile

    root = _get_category_or_404(db, category_id)
    # 收集所有后代类别 ID（不含自身），再合并自身
    descendant_ids = _collect_descendant_ids(db, category_id)
    all_cat_ids = [category_id, *descendant_ids]
    cats = (
        db.query(ServiceCategory)
        .filter(ServiceCategory.id.in_(all_cat_ids))
        .all()
    )
    cat_by_id: dict[int, ServiceCategory] = {c.id: c for c in cats}

    # 计算每个目录相对导出根的 zip 内路径（root → root/sub/subsub）
    def _rel_path(cat_id: int) -> str:
        parts: list[str] = []
        cur = cat_by_id.get(cat_id)
        safety = 0
        while cur and safety <= ServiceCategory.MAX_LEVEL:
            parts.append(cur.name)
            if cur.id == root.id:
                break
            if cur.parent_id is None or cur.parent_id not in cat_by_id:
                break
            cur = cat_by_id.get(cur.parent_id)
            safety += 1
        return "/".join(reversed(parts))

    rel_paths: dict[int, str] = {c.id: _rel_path(c.id) for c in cats}

    # 统计文件总数（含子目录），超过上限直接拒绝
    total_count = (
        db.query(func.count(Deliverable.id))
        .filter(Deliverable.category_id.in_(all_cat_ids))
        .scalar() or 0
    )
    if total_count == 0:
        raise HTTPException(status_code=400, detail="该目录及子目录下没有可导出的文件")
    if total_count > CATEGORY_EXPORT_MAX_FILES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"目录下共 {total_count} 个文件，超过单次导出上限 "
                f"{CATEGORY_EXPORT_MAX_FILES}，请缩小导出范围"
            ),
        )

    deliverables = (
        db.query(Deliverable)
        .filter(Deliverable.category_id.in_(all_cat_ids))
        .order_by(Deliverable.category_id.asc(), Deliverable.created_at.desc())
        .all()
    )

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="dlv_cat_export_")
    os.close(tmp_fd)
    try:
        used_names: set[str] = set()
        dirs_with_files: set[str] = set()

        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in deliverables:
                src = _stored_path(d.stored_name)
                if not os.path.isfile(src):
                    logger.warning(
                        "导出目录跳过缺失文件: id=%s stored=%s", d.id, d.stored_name
                    )
                    continue
                dir_path = rel_paths.get(d.category_id) or root.name
                # 标记本目录及其所有祖先为已写入（避免后续给它们补空目录占位）
                parts = dir_path.split("/")
                for i in range(1, len(parts) + 1):
                    dirs_with_files.add("/".join(parts[:i]))
                # 同目录下文件名冲突自动追加序号
                base_name = d.filename
                arcname = f"{dir_path}/{base_name}"
                if arcname in used_names:
                    name_base, ext = os.path.splitext(base_name)
                    i = 1
                    while f"{dir_path}/{name_base}({i}){ext}" in used_names:
                        i += 1
                    arcname = f"{dir_path}/{name_base}({i}){ext}"
                used_names.add(arcname)
                zf.write(src, arcname)

            # 为没有任何文件的子目录补空目录条目（保留目录结构）
            for c in cats:
                dir_path = rel_paths.get(c.id)
                if not dir_path or dir_path in dirs_with_files:
                    continue
                dir_entry = f"{dir_path}/"
                if dir_entry not in used_names:
                    zf.writestr(dir_entry, "")
                    used_names.add(dir_entry)

        # zip 文件名：<目录名>_<时间戳>.zip
        safe_name = (
            root.name.replace("/", "_").replace("\\", "_").strip() or "export"
        )
        zip_name = f"{safe_name}_{datetime.now():%Y%m%d_%H%M%S}.zip"
        quoted = quote(zip_name)
        ascii_name = zip_name.encode("ascii", errors="replace").decode()
        actual_file_count = sum(1 for n in used_names if not n.endswith("/"))

        def _stream():
            try:
                with open(tmp_path, "rb") as f:
                    while True:
                        chunk = f.read(64 * 1024)
                        if not chunk:
                            break
                        yield chunk
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        return StreamingResponse(
            _stream(),
            media_type="application/zip",
            headers={
                "Content-Disposition": (
                    f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"
                ),
                "X-Export-Count": str(actual_file_count),
                "Content-Length": str(os.path.getsize(tmp_path)),
            },
        )
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


# ============ 2. 材料 ============

@router.get("")
def list_deliverables(
    category_id: int,
    search: str = "",
    page: int = 1,
    size: int = 20,
    sort: str = "created_at",
    order: str = "desc",
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """材料分页列表（按类别过滤，支持名称/文件名模糊搜索，支持按列排序）。"""
    if page < 1:
        page = 1
    if size < 1 or size > 100:
        size = 20
    q = db.query(Deliverable).filter(Deliverable.category_id == category_id)
    if search.strip():
        kw = f"%{search.strip()}%"
        q = q.filter(
            (Deliverable.name.like(kw))
            | (Deliverable.filename.like(kw))
            | (Deliverable.version.like(kw))
        )
    total = q.count()
    # 排序字段白名单，避免直传列名；默认保持上传时间倒序
    sort_col = {
        "name": Deliverable.name,
        "filename": Deliverable.filename,
        "version": Deliverable.version,
        "size": Deliverable.file_size,
        "created_at": Deliverable.created_at,
    }.get(sort or "", Deliverable.created_at)
    sort_order = sort_col.asc() if order == "asc" else sort_col.desc()
    rows = (
        q.order_by(sort_order, Deliverable.id.asc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    users = _user_map(db, [r.created_by for r in rows])
    return {
        "items": [r.to_dict(creator_name=users.get(r.created_by, "")) for r in rows],
        "total": total,
        "page": page,
        "size": size,
    }


@router.get("/all-ids")
def list_all_deliverable_ids(
    category_id: int,
    search: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """获取当前条件下所有材料 ID（不分页，用于前端跨页全选）。

    - 按 category_id 精确过滤（仅当前目录，不含子目录，与列表口径一致）。
    - 最多返回 10000 条，超出提示缩小范围。
    """
    q = db.query(Deliverable.id).filter(Deliverable.category_id == category_id)
    if search.strip():
        kw = f"%{search.strip()}%"
        q = q.filter(
            (Deliverable.name.like(kw))
            | (Deliverable.filename.like(kw))
            | (Deliverable.version.like(kw))
        )
    rows = q.order_by(Deliverable.created_at.desc()).limit(10001).all()
    ids = [r[0] for r in rows]
    truncated = len(ids) > 10000
    if truncated:
        ids = ids[:10000]
    return {"ids": ids, "total": len(ids), "truncated": truncated}


@router.post("", status_code=201)
async def upload_deliverable(
    category_id: int = Form(...),
    file: UploadFile = File(...),
    name: str = Form(""),
    version: str = Form(""),
    description: str = Form(""),
    relative_path: str = Form(""),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """上传材料：白名单校验 + 200MB 限制 + uuid 落盘。

    名称缺省时取原始文件名（去扩展名）。
    可选 ``relative_path``（如 ``季度报告/实施方案/方案.docx``）：
    在目标目录下按原文件夹结构自动创建/复用子目录后再落文件，类似 Windows 文件夹迁移。
    """
    root_category = _get_category_or_404(db, category_id)
    ext = _validate_upload(file)

    # 读取文件内容（超限即拒，不落盘）
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小不能超过 200MB")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="文件内容为空")

    filename = os.path.basename(file.filename or f"file.{ext}")
    display_name = sanitize_text(name).strip() or os.path.splitext(filename)[0]
    if not display_name:
        display_name = filename
    if len(display_name) > 200:
        raise HTTPException(status_code=400, detail="材料名称不能超过 200 字")

    dir_segments = _parse_relative_dir(relative_path, filename)
    target_category = (
        _ensure_category_path(db, root_category, dir_segments, current_user)
        if dir_segments
        else root_category
    )

    # 同目录内容判重：完全相同的文件自动跳过，避免重复材料
    content_hash = hashlib.sha256(content).hexdigest()
    duplicate = _find_duplicate(db, target_category.id, content, content_hash)
    if duplicate is not None:
        # 判重过程中可能回填了存量哈希，此处统一提交
        db.commit()
        logger.info(
            "上传判重命中，已跳过: category_id=%s, file=%s, existing_id=%s, operator=%s",
            target_category.id, filename, duplicate.id, current_user.username,
        )
        return JSONResponse(
            status_code=200,
            content={
                **duplicate.to_dict(),
                "duplicate": True,
                "existing_id": duplicate.id,
                "existing_name": duplicate.name,
            },
        )

    stored_name = f"{datetime.utcnow():%Y%m%d}_{uuid.uuid4().hex[:12]}.{ext}"
    with open(_stored_path(stored_name), "wb") as f:
        f.write(content)

    deliverable = Deliverable(
        category_id=target_category.id,
        name=display_name,
        version=sanitize_text(version)[:50] if version else None,
        description=sanitize_text(description) if description else None,
        filename=filename,
        stored_name=stored_name,
        file_size=len(content),
        file_ext=ext,
        content_hash=content_hash,
        created_by=current_user.id,
    )
    db.add(deliverable)
    db.commit()
    db.refresh(deliverable)
    logger.info(
        "材料已上传: id=%s, category_id=%s, name=%s, file=%s, relative_path=%s, operator=%s",
        deliverable.id, target_category.id, display_name, filename,
        relative_path or "", current_user.username,
    )
    return deliverable.to_dict(creator_name=current_user.username)


@router.post("/batch-download")
def batch_download(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """批量下载材料：将多个文件打包为 zip 流式返回。

    - 请求体 ``{"ids": [1, 2, 3]}``，最多 50 个。
    - 文件名冲突自动追加序号，如 ``报告.xlsx`` → ``报告(1).xlsx``。
    - 缺失文件跳过（不影响其余打包）。
    """
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="请选择要下载的文件")
    if len(raw_ids) > BATCH_DOWNLOAD_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"批量下载最多 {BATCH_DOWNLOAD_MAX} 个文件，请减少选择数量",
        )
    # 去重 + 转整
    ids: list[int] = []
    seen: set[int] = set()
    for x in raw_ids:
        try:
            iid = int(x)
        except (TypeError, ValueError):
            continue
        if iid in seen:
            continue
        seen.add(iid)
        ids.append(iid)

    deliverables = (
        db.query(Deliverable).filter(Deliverable.id.in_(ids)).all()
    )
    if not deliverables:
        raise HTTPException(status_code=404, detail="未找到指定文件")

    # 按 ids 顺序保持稳定（deliverables 来自 IN 查询，顺序不定，重排）
    by_id = {d.id: d for d in deliverables}
    ordered = [by_id[i] for i in ids if i in by_id]

    # 写入临时 zip 文件后流式返回（避免大体积全量驻留内存）
    import tempfile
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="dlv_batch_")
    os.close(tmp_fd)
    try:
        used_names: set[str] = set()
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in ordered:
                src = _stored_path(d.stored_name)
                if not os.path.isfile(src):
                    logger.warning("批量下载跳过缺失文件: id=%s stored=%s", d.id, d.stored_name)
                    continue
                arcname = d.filename
                if arcname in used_names:
                    base, ext = os.path.splitext(d.filename)
                    i = 1
                    while f"{base}({i}){ext}" in used_names:
                        i += 1
                    arcname = f"{base}({i}){ext}"
                used_names.add(arcname)
                zf.write(src, arcname)

        zip_name = f"deliverables_{datetime.now():%Y%m%d_%H%M%S}.zip"
        quoted = quote(zip_name)
        ascii_name = zip_name.encode("ascii", errors="replace").decode()

        def _stream():
            try:
                with open(tmp_path, "rb") as f:
                    while True:
                        chunk = f.read(64 * 1024)
                        if not chunk:
                            break
                        yield chunk
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        return StreamingResponse(
            _stream(),
            media_type="application/zip",
            headers={
                "Content-Disposition": (
                    f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"
                ),
                "X-Batch-Count": str(len(used_names)),
            },
        )
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


@router.put("/{deliverable_id}")
async def update_deliverable(
    deliverable_id: int,
    name: str = Form(""),
    version: str = Form(""),
    description: str = Form(""),
    category_id: int = Form(0),
    file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """更新材料元数据（名称/版本/描述/所属类别），可选替换文件。"""
    deliverable = _get_deliverable_or_404(db, deliverable_id)

    if name.strip():
        v = sanitize_text(name).strip()
        if len(v) > 200:
            raise HTTPException(status_code=400, detail="材料名称不能超过 200 字")
        deliverable.name = v
    deliverable.version = sanitize_text(version)[:50] if version.strip() else deliverable.version
    if description.strip():
        deliverable.description = sanitize_text(description)
    # 可选转移类别
    if category_id and category_id != deliverable.category_id:
        _get_category_or_404(db, category_id)
        deliverable.category_id = category_id

    # 可选替换文件（先写新文件，成功后删旧文件）
    if file is not None and file.filename:
        ext = _validate_upload(file)
        content = await file.read()
        if len(content) > MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail="文件大小不能超过 200MB")
        if len(content) == 0:
            raise HTTPException(status_code=400, detail="文件内容为空")
        content_hash = hashlib.sha256(content).hexdigest()
        # 与上传同口径：同目录内容相同则拒绝，避免绕过判重制造重复材料
        duplicate = _find_duplicate(db, deliverable.category_id, content, content_hash)
        if duplicate is not None and duplicate.id != deliverable.id:
            raise HTTPException(
                status_code=409,
                detail=f"同目录已有内容相同的材料「{duplicate.name}」，无需重复上传",
            )
        old_stored = deliverable.stored_name
        stored_name = f"{datetime.utcnow():%Y%m%d}_{uuid.uuid4().hex[:12]}.{ext}"
        with open(_stored_path(stored_name), "wb") as f:
            f.write(content)
        deliverable.filename = os.path.basename(file.filename)
        deliverable.stored_name = stored_name
        deliverable.file_size = len(content)
        deliverable.file_ext = ext
        deliverable.content_hash = content_hash
        # 删除旧文件（失败仅记日志）
        try:
            old_path = _stored_path(old_stored)
            if os.path.isfile(old_path):
                os.remove(old_path)
        except OSError as exc:
            logger.warning("替换材料时删除旧文件失败: %s (%s)", old_stored, exc)

    db.commit()
    db.refresh(deliverable)
    return deliverable.to_dict()


@router.delete("/{deliverable_id}", status_code=204)
def delete_deliverable(
    deliverable_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "delete")),
):
    """删除材料：删除落盘文件 + 数据库记录。"""
    deliverable = _get_deliverable_or_404(db, deliverable_id)
    stored_name = deliverable.stored_name
    filename = deliverable.filename
    db.delete(deliverable)
    db.commit()
    try:
        path = _stored_path(stored_name)
        if os.path.isfile(path):
            os.remove(path)
    except OSError as exc:
        logger.warning("删除材料文件失败: %s (%s)", stored_name, exc)
    logger.info(
        "材料已删除: id=%s, name=%s, file=%s, operator=%s",
        deliverable_id, deliverable.name, filename, current_user.username,
    )
    return None


@router.post("/batch-delete")
def batch_delete(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "delete")),
):
    """批量删除材料：删除落盘文件 + 数据库记录。

    - 请求体 ``{"ids": [1, 2, 3]}``，最多 50 个。
    - 缺失 ID 计入 ``not_found``，不影响其余删除。
    - 落盘文件删除失败仅记日志，不回滚数据库（与单删除一致）。
    """
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="请选择要删除的文件")
    if len(raw_ids) > BATCH_DOWNLOAD_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"批量删除最多 {BATCH_DOWNLOAD_MAX} 个文件，请减少选择数量",
        )
    # 去重 + 转整
    ids: list[int] = []
    seen: set[int] = set()
    for x in raw_ids:
        try:
            iid = int(x)
        except (TypeError, ValueError):
            continue
        if iid in seen:
            continue
        seen.add(iid)
        ids.append(iid)

    deliverables = (
        db.query(Deliverable).filter(Deliverable.id.in_(ids)).all()
    )
    found_ids = {d.id for d in deliverables}
    not_found = sum(1 for i in ids if i not in found_ids)

    # 先收集落盘文件名，再批量删除数据库记录（统一 commit）
    to_remove_files: list[str] = []
    for d in deliverables:
        to_remove_files.append((d.id, d.name, d.filename, d.stored_name))
        db.delete(d)
    db.commit()

    # 落盘文件清理（失败仅记日志）
    for did, name, filename, stored_name in to_remove_files:
        try:
            path = _stored_path(stored_name)
            if os.path.isfile(path):
                os.remove(path)
        except OSError as exc:
            logger.warning("批量删除材料文件失败: id=%s stored=%s (%s)", did, stored_name, exc)

    logger.info(
        "材料已批量删除: count=%s, operator=%s",
        len(to_remove_files), current_user.username,
    )
    return {
        "deleted": len(to_remove_files),
        "not_found": not_found,
    }


@router.post("/batch-move")
def batch_move(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """批量移动材料到目标目录。

    - 请求体 ``{"ids": [1, 2, 3], "target_category_id": 10}``，最多 50 个。
    - 仅更新材料的 ``category_id``（落盘文件无需移动），目标目录须存在。
    - 缺失 ID 计入 ``not_found``，不影响其余移动。
    """
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    target_category_id = payload.get("target_category_id") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="请选择要移动的文件")
    if len(raw_ids) > BATCH_MOVE_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"批量移动最多 {BATCH_MOVE_MAX} 个文件，请减少选择数量",
        )
    try:
        target_id = int(target_category_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="目标目录参数非法")
    _get_category_or_404(db, target_id)

    # 去重 + 转整
    ids: list[int] = []
    seen: set[int] = set()
    for x in raw_ids:
        try:
            iid = int(x)
        except (TypeError, ValueError):
            continue
        if iid in seen:
            continue
        seen.add(iid)
        ids.append(iid)

    # 全部 id 都非法时直接返回，避免 in_([]) 退化 SQL
    if not ids:
        return {"moved": 0, "not_found": 0}

    deliverables = (
        db.query(Deliverable).filter(Deliverable.id.in_(ids)).all()
    )
    found_ids = {d.id for d in deliverables}
    not_found = sum(1 for i in ids if i not in found_ids)

    # 仅更新所属目录，落盘文件不用移动
    for d in deliverables:
        d.category_id = target_id
        d.updated_at = datetime.utcnow()
    db.commit()

    logger.info(
        "材料已批量移动: count=%s, target_category_id=%s, operator=%s",
        len(deliverables), target_id, current_user.username,
    )
    return {
        "moved": len(deliverables),
        "not_found": not_found,
    }


@router.get("/{deliverable_id}/download")
def download_deliverable(
    deliverable_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """下载材料文件（以原始文件名返回，RFC 5987 UTF-8 编码支持中文）。"""
    deliverable = _get_deliverable_or_404(db, deliverable_id)
    path = _stored_path(deliverable.stored_name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件已丢失，请联系管理员")
    quoted = quote(deliverable.filename)
    ascii_name = deliverable.filename.encode("ascii", errors="replace").decode()
    return FileResponse(
        path,
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"
            )
        },
    )


# 可在线预览/编辑的文本类文件扩展名
TEXT_EXTENSIONS = {"txt", "csv", "md"}
# 可浏览器内嵌预览的文件扩展名（iframe / img）
INLINE_PREVIEW_EXTENSIONS = {"pdf", "txt", "csv", "md"}


@router.get("/{deliverable_id}/preview")
def preview_deliverable(
    deliverable_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """预览材料文件（inline 方式返回，供浏览器内嵌展示）。"""
    deliverable = _get_deliverable_or_404(db, deliverable_id)
    path = _stored_path(deliverable.stored_name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件已丢失，请联系管理员")
    quoted = quote(deliverable.filename)
    ascii_name = deliverable.filename.encode("ascii", errors="replace").decode()
    return FileResponse(
        path,
        headers={
            "Content-Disposition": (
                f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"
            ),
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
        },
    )


@router.get("/{deliverable_id}/content")
def get_deliverable_content(
    deliverable_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "view")),
):
    """获取文本类材料的文本内容（用于前端在线编辑器加载）。

    仅支持 txt / csv / md 文件；其他类型返回 400 提示下载查看。
    """
    deliverable = _get_deliverable_or_404(db, deliverable_id)
    if deliverable.file_ext not in TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="该文件类型不支持在线查看内容，请下载后打开",
        )
    path = _stored_path(deliverable.stored_name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件已丢失，请联系管理员")
    # 限制读取大小，防止超大文本撑爆内存（最多 5MB 文本）
    max_read = 5 * 1024 * 1024
    if deliverable.file_size and deliverable.file_size > max_read:
        raise HTTPException(
            status_code=400,
            detail="文件过大，不支持在线编辑，请下载后修改",
        )
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        # 尝试 GBK 兜底
        try:
            with open(path, "r", encoding="gbk", errors="replace") as f:
                content = f.read()
        except Exception:
            raise HTTPException(status_code=400, detail="文件编码无法识别")
    return {
        "id": deliverable.id,
        "filename": deliverable.filename,
        "file_ext": deliverable.file_ext,
        "content": content,
        "size": deliverable.file_size,
    }


@router.put("/{deliverable_id}/content")
def update_deliverable_content(
    deliverable_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("deliverable", "edit")),
):
    """保存文本类材料的修改内容（在线编辑后保存）。

    请求体 ``{"content": "..."}``；仅支持 txt / csv / md，内容不超过 5MB。
    保存后更新 file_size。
    """
    deliverable = _get_deliverable_or_404(db, deliverable_id)
    if deliverable.file_ext not in TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="该文件类型不支持在线编辑",
        )
    content = payload.get("content") if isinstance(payload, dict) else None
    if content is None or not isinstance(content, str):
        raise HTTPException(status_code=400, detail="缺少 content 字段")
    if len(content.encode("utf-8")) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="内容过大，不支持在线保存（上限 5MB）")

    path = _stored_path(deliverable.stored_name)
    # 写入临时文件再原子替换，避免写一半崩溃损坏原文件
    tmp_path = path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, path)
    except Exception as exc:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=500, detail="保存失败") from exc

    deliverable.file_size = os.path.getsize(path)
    deliverable.updated_at = datetime.utcnow()
    db.commit()
    logger.info(
        "材料内容已更新: id=%s, size=%s, operator=%s",
        deliverable.id, deliverable.file_size, current_user.username,
    )
    return {
        "id": deliverable.id,
        "file_size": deliverable.file_size,
        "updated_at": to_beijing_iso(deliverable.updated_at),
    }
