"""值班管理 API。

核心能力：
- 值班人员 CRUD + Excel 批量导入 / 模板下载（人员不分白班/晚班）
- 值班表手动新建（按日期范围逐日指定白班/晚班人员，每班可多人）+ 确认发布
- 值班表查看（列表 / 月视图，含人员姓名电话富化）+ 整条记录编辑 + 图形化拖拽排班
- 请假申请 + 审批（请假期间标记需调整）
- 调班记录查询
- 特殊日期覆盖（手动标记某日为工作日/非工作日，覆盖内置节假日表）

权限：view 可查看/导出，edit 可新增/编辑/排班/审批，delete 可删除人员/记录。
"""
import io
import logging
import uuid
from datetime import date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.holidays import get_holiday_name, is_holiday
from app.core.sanitizer import sanitize_text
from app.core.timezone import beijing_now, to_beijing_iso
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.duty import (
    DutyAdjustmentLog,
    DutyLeaveLog,
    DutyMember,
    DutyRecord,
    DutyRotationCursor,
)
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.common import paginate as paginate_query
from app.schemas.duty import (
    BatchIds,
    DUTY_CATEGORIES,
    GraphAssignRequest,
    ManualScheduleCreateRequest,
    RecordEditRequest,
    LeaveApprove,
    LeaveCreate,
    ManualAdjustRequest,
    MemberBatchStatusUpdate,
    MemberReorderRequest,
    RecordStatusUpdate,
    ScheduleCopyRequest,
    ScheduleGenerateRequest,
    SpecialDatesUpdate,
    DutyMemberCreate,
    DutyMemberUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/duty", tags=["duty"])

# 值班类别中文 → 标识映射（Excel 导入用）
_CATEGORY_LABEL_MAP = {
    "长期白班": "PERMANENT_DAY",
    "白班": "DAY",
    "晚班": "NIGHT",
    "permanent_day": "PERMANENT_DAY",
    "day": "DAY",
    "night": "NIGHT",
}
_SPECIAL_DATES_KEY = "duty_special_dates"
WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 值班表类型：DAILY=日常运营 / RESERVE=重保 / ALL=全部（只用于查看与导出，不参与生成）
ROSTER_TYPE_LABELS = {"DAILY": "日常运营", "RESERVE": "重保", "ALL": "全部"}


# ============ 辅助函数 ============

def _get_member_or_404(db: Session, member_id: int, include_deleted: bool = False) -> DutyMember:
    """按 ID 查值班人员，不存在/已删除抛 404。"""
    q = db.query(DutyMember).filter(DutyMember.id == member_id)
    if not include_deleted:
        q = q.filter(DutyMember.deleted_at.is_(None))
    member = q.first()
    if member is None:
        raise HTTPException(status_code=404, detail="值班人员不存在")
    return member


def _get_record_or_404(db: Session, record_id: int) -> DutyRecord:
    rec = db.query(DutyRecord).filter(DutyRecord.id == record_id).first()
    if rec is None:
        raise HTTPException(status_code=404, detail="值班记录不存在")
    return rec


def _load_special_dates(db: Session) -> dict[str, str]:
    """从 SystemConfig 读取特殊日期覆盖 {YYYY-MM-DD: holiday/workday}。"""
    cfg = db.query(SystemConfig).filter(SystemConfig.key == _SPECIAL_DATES_KEY).first()
    if not cfg or not cfg.value:
        return {}
    import json
    try:
        data = json.loads(cfg.value)
        return {k: v for k, v in data.items() if v in ("holiday", "workday")}
    except (ValueError, TypeError):
        return {}


def _save_special_dates(db: Session, overrides: dict[str, str]) -> None:
    import json
    cfg = db.query(SystemConfig).filter(SystemConfig.key == _SPECIAL_DATES_KEY).first()
    payload = json.dumps(overrides, ensure_ascii=False)
    if cfg is None:
        cfg = SystemConfig(key=_SPECIAL_DATES_KEY, value=payload,
                          description="值班管理-特殊日期覆盖（手动标记工作日/非工作日）")
        db.add(cfg)
    else:
        cfg.value = payload
    db.commit()


def _sync_records_is_holiday(db: Session, dates: set[date]) -> None:
    """特殊日期变更后，同步刷新受影响日期的排班记录 is_holiday。"""
    if not dates:
        return
    overrides = _load_special_dates(db)
    recs = db.query(DutyRecord).filter(DutyRecord.duty_date.in_(dates)).all()
    for r in recs:
        r.is_holiday = is_holiday(r.duty_date, overrides)
    db.commit()


def _active_members_by_category(db: Session, category: str) -> list[DutyMember]:
    """取某类别下启用且未删除的人员，按 sort_order、id 排序（轮换顺序）。"""
    return (
        db.query(DutyMember)
        .filter(
            DutyMember.duty_category == category,
            DutyMember.status == "active",
            DutyMember.deleted_at.is_(None),
        )
        .order_by(DutyMember.sort_order.asc(), DutyMember.id.asc())
        .all()
    )


def _day_rotation_pool(db: Session) -> list[DutyMember]:
    """非工作日白班轮换池：DAY + PERMANENT_DAY 合并，按 sort_order、id 全局排序。

    长期白班人员也参与节假日/周末白班轮换，故将其纳入同一轮换池。
    工作日白班仍优先取 PERMANENT_DAY 主值班人（见 generate 逻辑），仅在无长期白班时回退至此池轮换。
    """
    pool = _active_members_by_category(db, "DAY") + _active_members_by_category(db, "PERMANENT_DAY")
    return sorted(pool, key=lambda m: (m.sort_order, m.id))


def _cursor_category(roster_type: str, category: str) -> str:
    """轮换游标键：日常运营沿用 DAY/NIGHT，重保使用 RESERVE:DAY/NIGHT。

    两类值班表各自独立轮换，互不影响；已有日常游标数据无需迁移。
    """
    return category if roster_type == "DAILY" else f"{roster_type}:{category}"


def _get_cursor(db: Session, category: str) -> DutyRotationCursor:
    cur = db.query(DutyRotationCursor).filter(DutyRotationCursor.category == category).first()
    if cur is None:
        cur = DutyRotationCursor(category=category, last_index=-1)
        db.add(cur)
        db.flush()
    return cur


def _pick_next(members: list[DutyMember], last_index: int, skip_ids: set[int]):
    """从 last_index 的下一位开始轮换，跳过 skip_ids 中的人员。

    Returns:
        (member_or_None, new_index)。全员被跳过/列表为空时返回 (None, last_index)。
    """
    if not members:
        return None, last_index
    n = len(members)
    for offset in range(n):
        idx = (last_index + 1 + offset) % n  # 从下一位开始
        m = members[idx]
        if m.id in skip_ids:
            continue
        return m, idx
    return None, last_index


def _member_index(members: list[DutyMember], member_id: int) -> int:
    """返回 member_id 在轮换列表中的下标（按 sort_order 排序），不存在返回 -1。"""
    for i, m in enumerate(members):
        if m.id == member_id:
            return i
    return -1


def _load_approved_leaves(db: Session, start: date, end: date):
    """取日期范围内已批准的请假记录。"""
    return (
        db.query(DutyLeaveLog)
        .filter(
            DutyLeaveLog.status == "approved",
            DutyLeaveLog.start_date <= end,
            DutyLeaveLog.end_date >= start,
        )
        .all()
    )


def _leave_skip_ids(leaves, d: date, shift: str) -> set[int]:
    """计算某天某班次应跳过的请假人员 ID 集合。shift: DAY/NIGHT。"""
    skip = set()
    for lv in leaves:
        if lv.start_date <= d <= lv.end_date and lv.shift in ("ALL", shift):
            skip.add(lv.member_id)
    return skip


def _member_brief(member: DutyMember | None) -> dict | None:
    """人员精简信息（用于富化值班记录）。"""
    if member is None:
        return None
    return {
        "id": member.id,
        "name": member.name,
        "phone": member.phone,
        "group_name": member.group_name,
    }


def _parse_member_ids(raw) -> list[int]:
    """解析逗号分隔的人员ID文本（去重保序）。"""
    if not raw:
        return []
    ids: list[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            mid = int(part)
        except (TypeError, ValueError):
            continue
        if mid not in ids:
            ids.append(mid)
    return ids


def _record_member_ids(rec: DutyRecord, shift: str) -> list[int]:
    """取某班次的人员ID列表；新列优先，旧单值列兜底。"""
    raw = rec.day_member_ids if shift == "DAY" else rec.night_member_ids
    ids = _parse_member_ids(raw)
    if ids:
        return ids
    legacy = rec.day_member_id if shift == "DAY" else rec.night_member_id
    return [legacy] if legacy else []


def _set_record_member_ids(rec: DutyRecord, shift: str, ids: list[int]) -> None:
    """写入某班次人员列表，并同步旧单值列（第一人）以兼容历史逻辑。"""
    clean: list[int] = []
    for mid in ids:
        if mid and mid not in clean:
            clean.append(int(mid))
    text_value = ",".join(str(mid) for mid in clean) or None
    if shift == "DAY":
        rec.day_member_ids = text_value
        rec.day_member_id = clean[0] if clean else None
    else:
        rec.night_member_ids = text_value
        rec.night_member_id = clean[0] if clean else None


def _load_member_map(db: Session, ids: set[int]) -> dict[int, DutyMember]:
    if not ids:
        return {}
    rows = db.query(DutyMember).filter(DutyMember.id.in_(ids)).all()
    return {m.id: m for m in rows}


def _enrich_record(db: Session, rec: DutyRecord, approved_leaves: list = None) -> dict:
    """值班记录富化：附带白班/晚班人员列表、日期类型名称、星期、请假影响标记。

    - ``day_members`` / ``night_members``：该班次全部人员（支持多人）；
      ``day_member`` / ``night_member`` 保留为第一人，兼容旧前端。
    - ``day_member_names`` / ``night_member_names``：逗号分隔的姓名，便于直接展示。
    - ``day_needs_adjust`` / ``night_needs_adjust``：该班次任一人处于已批准请假
      范围内（需手动替换或重新分配）。
    - ``approved_leaves`` 可选预加载列表，避免 N+1 查询；为 None 时内部查询。
    """
    day_ids = _record_member_ids(rec, "DAY")
    night_ids = _record_member_ids(rec, "NIGHT")
    member_map = _load_member_map(db, set(day_ids) | set(night_ids))
    day_members = [_member_brief(member_map[mid]) for mid in day_ids if mid in member_map]
    night_members = [_member_brief(member_map[mid]) for mid in night_ids if mid in member_map]
    d = rec.duty_date
    # 查询覆盖该日的已批准请假（影响 DAY/NIGHT/ALL 班次）
    if approved_leaves is None:
        approved_leaves = (
            db.query(DutyLeaveLog)
            .filter(
                DutyLeaveLog.status == "approved",
                DutyLeaveLog.start_date <= d,
                DutyLeaveLog.end_date >= d,
            )
            .all()
        )
    day_set = set(day_ids)
    night_set = set(night_ids)
    day_needs = False
    night_needs = False
    for lv in approved_leaves:
        if lv.member_id in day_set and lv.shift in ("DAY", "ALL"):
            day_needs = True
        if lv.member_id in night_set and lv.shift in ("NIGHT", "ALL"):
            night_needs = True
    return {
        **rec.to_dict(),
        "weekday": WEEKDAY_CN[d.weekday()],
        "day_type": "非工作日" if rec.is_holiday else "工作日",
        "holiday_name": get_holiday_name(d) if rec.is_holiday else None,
        "day_members": day_members,
        "night_members": night_members,
        "day_member": day_members[0] if day_members else None,
        "night_member": night_members[0] if night_members else None,
        "day_member_names": "，".join(m["name"] for m in day_members),
        "night_member_names": "，".join(m["name"] for m in night_members),
        "day_needs_adjust": day_needs,
        "night_needs_adjust": night_needs,
    }


def _daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def _to_xlsx_bytes(rows: list[list], sheet_name: str = "Sheet1") -> bytes:
    """生成 .xlsx 字节流。rows[0] 为表头。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name
    header_fill = PatternFill(start_color="FF0066CC", end_color="FF0066CC", fill_type="solid")
    header_font = Font(color="FFFFFFFF", bold=True)
    for r_idx, row in enumerate(rows, 1):
        for c_idx, val in enumerate(row, 1):
            cell = ws.cell(row=r_idx, column=c_idx, value=val)
            if r_idx == 1:
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center", vertical="center")
    # 自适应列宽
    for c_idx in range(1, len(rows[0]) + 1):
        max_len = 0
        for r_idx in range(1, len(rows) + 1):
            v = ws.cell(row=r_idx, column=c_idx).value
            if v is not None:
                # 中文按 2 计算宽度
                length = sum(2 if ord(ch) > 127 else 1 for ch in str(v))
                if length > max_len:
                    max_len = length
        ws.column_dimensions[get_column_letter(c_idx)].width = min(max(max_len + 2, 10), 40)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ============ 值班人员管理 ============

@router.get("/members")
def list_members(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    group_name: str = Query("", description="按组别筛选"),
    duty_category: str = Query("", description="按值班类别筛选"),
    keyword: str = Query("", description="姓名模糊搜索"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "view")),
):
    """值班人员列表（分页，支持组别/类别筛选 + 姓名模糊搜索）。"""
    q = db.query(DutyMember).filter(DutyMember.deleted_at.is_(None))
    if group_name:
        q = q.filter(DutyMember.group_name == group_name)
    if duty_category in DUTY_CATEGORIES:
        q = q.filter(DutyMember.duty_category == duty_category)
    if keyword:
        q = q.filter(DutyMember.name.like(f"%{keyword}%"))
    q = q.order_by(DutyMember.sort_order.asc(), DutyMember.id.asc())
    return paginate_query(q, page, size)


@router.get("/members/all")
def list_all_members(
    category: str = Query("", description="按值班类别筛选（用于排班选择器）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "view")),
):
    """全部启用人员（不分页，供前端选择器/排班使用）。"""
    q = db.query(DutyMember).filter(
        DutyMember.deleted_at.is_(None), DutyMember.status == "active"
    )
    if category in DUTY_CATEGORIES:
        q = q.filter(DutyMember.duty_category == category)
    q = q.order_by(DutyMember.sort_order.asc(), DutyMember.id.asc())
    return [m.to_dict() for m in q.all()]


@router.post("/members", status_code=201)
def create_member(
    body: DutyMemberCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "edit")),
):
    """新增值班人员。"""
    member = DutyMember(
        name=sanitize_text(body.name).strip(),
        phone=sanitize_text(body.phone).strip(),
        group_name=sanitize_text(body.group_name).strip(),
        duty_category=body.duty_category or "ANY",
        is_primary=body.is_primary if body.duty_category == "PERMANENT_DAY" else False,
        sort_order=body.sort_order,
        status=body.status,
    )
    if not member.name:
        raise HTTPException(status_code=400, detail="姓名不能为空")
    if not member.phone:
        raise HTTPException(status_code=400, detail="电话不能为空")
    db.add(member)
    db.commit()
    db.refresh(member)
    return member.to_dict()


@router.put("/members/{member_id}")
def update_member(
    member_id: int,
    body: DutyMemberUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "edit")),
):
    """编辑值班人员。修改值班类别后将影响后续值班表生成。"""
    member = _get_member_or_404(db, member_id)
    category_changed = body.duty_category is not None and body.duty_category != member.duty_category
    for field in ("name", "phone", "group_name", "duty_category", "is_primary", "sort_order", "status"):
        val = getattr(body, field, None)
        if val is not None:
            if field in ("name", "phone", "group_name"):
                val = sanitize_text(val).strip() if val else val
            setattr(member, field, val)
    # is_primary 仅对 PERMANENT_DAY 有效
    if member.duty_category != "PERMANENT_DAY":
        member.is_primary = False
    if member.name == "":
        raise HTTPException(status_code=400, detail="姓名不能为空")
    if member.phone == "":
        raise HTTPException(status_code=400, detail="电话不能为空")
    db.commit()
    db.refresh(member)
    return {**member.to_dict(), "category_changed": category_changed}


@router.delete("/members/{member_id}")
def delete_member(
    member_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "delete")),
):
    """软删除值班人员。历史值班记录保留；若有未来值班安排，返回需重新排班提示。"""
    member = _get_member_or_404(db, member_id)
    today = date.today()
    future_recs = db.query(DutyRecord).filter(DutyRecord.duty_date >= today).all()
    future_count = sum(
        1 for r in future_recs
        if member_id in _record_member_ids(r, "DAY") or member_id in _record_member_ids(r, "NIGHT")
    )
    member.deleted_at = beijing_now()
    db.commit()
    return {
        "deleted": True,
        "future_duty_count": future_count,
        "message": f"已删除该人员，历史值班记录保留；该人员有 {future_count} 条未来值班安排，建议手动调整"
        if future_count else "已删除该人员",
    }


@router.get("/members/import-template")
def download_member_template(
    _user: User = Depends(require_permission("duty_member", "view")),
):
    """下载值班人员 Excel 导入模板。"""
    headers = ["姓名", "电话", "组别", "排序", "状态"]
    example = ["张三", "13800138000", "运维组", "0", "启用"]
    note = [
        ["# 导入说明：值班人员不再区分白班/晚班类别，所有人员均可参与任意班次排班"],
        ["# 状态 可选 启用 / 停用；排序 为数字，值小的排在前面"],
        ["# 导入时请删除以 # 开头的说明行"],
    ]
    rows = [headers, example] + note
    content = _to_xlsx_bytes(rows, "值班人员导入模板")
    from urllib.parse import quote
    filename = quote("值班人员导入模板.xlsx")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.post("/members/import")
def import_members(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "edit")),
):
    """Excel 批量导入值班人员。返回成功/失败条数与错误明细。"""
    from openpyxl import load_workbook

    filename = file.filename or ""
    if not filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx / .xls 文件")
    try:
        wb = load_workbook(file.file, read_only=True, data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Excel 文件解析失败，请使用下载的模板")
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header = [str(c or "").strip() for c in next(rows_iter)]
    except StopIteration:
        raise HTTPException(status_code=400, detail="Excel 文件为空")

    # 列名 → 索引（容错匹配）
    def col(name: str) -> int:
        for i, h in enumerate(header):
            if name in h:
                return i
        return -1

    idx_name = col("姓名")
    idx_phone = col("电话")
    idx_group = col("组别")
    idx_cat = col("值班类别")  # 兼容旧模板，已废弃
    idx_primary = col("主值班")
    idx_sort = col("排序")
    idx_status = col("状态")
    if idx_name < 0 or idx_phone < 0:
        raise HTTPException(status_code=400, detail="缺少必填列：姓名 / 电话")

    success = 0
    errors: list[str] = []
    line = 1
    for row in rows_iter:
        line += 1
        if not row or all(c is None or str(c).strip() == "" for c in row):
            continue
        if str(row[0] or "").strip().startswith("#"):
            continue
        name = str(row[idx_name] or "").strip()
        phone = str(row[idx_phone] or "").strip()
        group_name = str(row[idx_group] or "").strip() if idx_group >= 0 else ""
        cat_raw = str(row[idx_cat] or "").strip() if idx_cat >= 0 else ""
        category = _CATEGORY_LABEL_MAP.get(cat_raw) or _CATEGORY_LABEL_MAP.get(cat_raw.lower()) or "ANY"
        if not name or not phone:
            errors.append(f"第{line}行：姓名/电话不能为空")
            continue
        is_primary = False
        if idx_primary >= 0:
            pv = str(row[idx_primary] or "").strip()
            is_primary = pv in ("是", "1", "true", "Y", "y")
        sort_order = 0
        if idx_sort >= 0 and row[idx_sort] is not None:
            try:
                sort_order = int(row[idx_sort])
            except (TypeError, ValueError):
                sort_order = 0
        status = "active"
        if idx_status >= 0:
            sv = str(row[idx_status] or "").strip()
            status = "inactive" if sv in ("停用", "inactive", "0") else "active"
        member = DutyMember(
            name=sanitize_text(name), phone=sanitize_text(phone),
            group_name=sanitize_text(group_name), duty_category=category,
            is_primary=is_primary if category == "PERMANENT_DAY" else False,
            sort_order=sort_order, status=status,
        )
        db.add(member)
        success += 1
    db.commit()
    return {"success": success, "errors": errors, "total_errors": len(errors)}


# ============ 值班表生成 ============

@router.post("/schedule/manual-create")
def manual_create_schedule(
    body: ManualScheduleCreateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """手动新建值班表：按日期范围提交每天的白班/晚班人员（替代原自动生成）。

    - ``conflict_strategy=overwrite``：已有记录按提交内容覆盖；``fill``：仅创建缺失日期；
    - 每条记录支持一个班次多人；已过期记录跳过；
    - 新建记录状态按 ``auto_publish`` 为草稿或已发布；
    - 直接写入记录，不调整轮换游标；覆盖已有记录时按人员增减写调班日志。
    """
    if body.end_date < body.start_date:
        raise HTTPException(status_code=400, detail="结束日期不能早于起始日期")
    span = (body.end_date - body.start_date).days + 1
    if span > 62:
        raise HTTPException(status_code=400, detail="手动新建单次最多 62 天")
    if not body.days:
        raise HTTPException(status_code=400, detail="请至少选择一天并填写排班人员")

    seen_dates: set[date] = set()
    normalized: list[tuple[date, list[int], list[int]]] = []
    all_member_ids: set[int] = set()
    for item in body.days:
        if item.duty_date < body.start_date or item.duty_date > body.end_date:
            raise HTTPException(status_code=400, detail=f"日期 {item.duty_date} 超出所选范围")
        if item.duty_date in seen_dates:
            raise HTTPException(status_code=400, detail=f"日期 {item.duty_date} 重复提交")
        seen_dates.add(item.duty_date)
        day_ids = list(dict.fromkeys(int(i) for i in item.day_member_ids if i))
        night_ids = list(dict.fromkeys(int(i) for i in item.night_member_ids if i))
        if set(day_ids) & set(night_ids):
            raise HTTPException(status_code=400, detail=f"{item.duty_date} 同一人不能同时排白班和晚班")
        all_member_ids.update(day_ids)
        all_member_ids.update(night_ids)
        normalized.append((item.duty_date, day_ids, night_ids))

    if all_member_ids:
        rows = (
            db.query(DutyMember)
            .filter(DutyMember.id.in_(all_member_ids), DutyMember.deleted_at.is_(None))
            .all()
        )
        found = {m.id for m in rows}
        missing = all_member_ids - found
        if missing:
            raise HTTPException(status_code=400, detail="存在不存在的值班人员，请刷新后重试")

    overrides = _load_special_dates(db)
    existing = {
        r.duty_date: r
        for r in db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date >= body.start_date,
            DutyRecord.duty_date <= body.end_date,
            DutyRecord.roster_type == body.roster_type,
        )
        .all()
    }
    status = "published" if body.auto_publish else "draft"
    reason = "新建值班表"
    created = updated = skipped = 0
    for duty_date, day_ids, night_ids in sorted(normalized, key=lambda x: x[0]):
        rec = existing.get(duty_date)
        if rec is not None and (rec.status == "expired" or body.conflict_strategy == "fill"):
            skipped += 1
            continue
        if rec is None:
            rec = DutyRecord(
                duty_date=duty_date,
                roster_type=body.roster_type,
                is_holiday=is_holiday(duty_date, overrides),
                status=status,
                generated_batch="manual",
            )
            db.add(rec)
            db.flush()
            _set_record_member_ids(rec, "DAY", day_ids)
            _set_record_member_ids(rec, "NIGHT", night_ids)
            created += 1
            continue

        # 覆盖已有记录：按人员增减写调班日志
        for shift, new_ids in (("DAY", day_ids), ("NIGHT", night_ids)):
            old_ids = _record_member_ids(rec, shift)
            for mid in (mid for mid in new_ids if mid not in old_ids):
                db.add(DutyAdjustmentLog(
                    duty_record_id=rec.id, shift=shift,
                    original_member_id=None, new_member_id=mid,
                    reason=reason, operator_id=user.id, operated_at=beijing_now(),
                ))
            for mid in (mid for mid in old_ids if mid not in new_ids):
                db.add(DutyAdjustmentLog(
                    duty_record_id=rec.id, shift=shift,
                    original_member_id=mid, new_member_id=None,
                    reason=reason, operator_id=user.id, operated_at=beijing_now(),
                ))
            _set_record_member_ids(rec, shift, new_ids)
        rec.is_holiday = is_holiday(duty_date, overrides)
        rec.status = status
        updated += 1

    db.commit()
    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "total": len(normalized),
    }


@router.post("/schedule/confirm")
def confirm_schedule(
    start_date: date = Query(...),
    end_date: date = Query(...),
    roster_type: Literal["DAILY", "RESERVE", "ALL"] = Query("DAILY", description="值班表类型（ALL=全部）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """确认发布值班表（将范围内指定类型的草稿记录改为已发布；ALL=两类一起发布）。"""
    q = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= start_date,
        DutyRecord.duty_date <= end_date,
    )
    if roster_type != "ALL":
        q = q.filter(DutyRecord.roster_type == roster_type)
    recs = q.all()
    published = 0
    for r in recs:
        if r.status == "draft":
            r.status = "published"
            published += 1
    db.commit()
    return {"published": published, "total": len(recs)}


@router.get("/schedule")
def list_schedule(
    start_date: date = Query(..., description="起始日期"),
    end_date: date = Query(..., description="结束日期"),
    group_name: str = Query("", description="按组别筛选"),
    member_id: int = Query(0, description="按人员筛选"),
    roster_type: Literal["DAILY", "RESERVE", "ALL"] = Query("DAILY", description="值班表类型（ALL=全部）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "view")),
):
    """值班表列表视图（富化人员信息），按值班表类型过滤；ALL 返回两类全部记录。"""
    q = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= start_date,
        DutyRecord.duty_date <= end_date,
    )
    if roster_type != "ALL":
        q = q.filter(DutyRecord.roster_type == roster_type)
    q = q.order_by(DutyRecord.duty_date.asc(), DutyRecord.roster_type.asc())
    recs = q.all()
    result = [_enrich_record(db, r) for r in recs]
    # 组别/人员筛选在富化后做
    if group_name or member_id:
        filtered = []
        for r in result:
            day_ms = r.get("day_members") or []
            night_ms = r.get("night_members") or []
            if group_name:
                g_ok = any(m["group_name"] == group_name for m in day_ms + night_ms)
                if not g_ok:
                    continue
            if member_id:
                m_ok = any(m["id"] == member_id for m in day_ms + night_ms)
                if not m_ok:
                    continue
            filtered.append(r)
        result = filtered
    return {"items": result, "total": len(result)}


@router.get("/schedule/month")
def month_schedule(
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
    roster_type: Literal["DAILY", "RESERVE", "ALL"] = Query("DAILY", description="值班表类型（ALL=全部）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "view")),
):
    """值班表月视图：返回该月每天的记录（富化），便于日历渲染。

    ``roster_type=ALL`` 时每天可能同时存在日常/重保两条记录，故以 ``entries``
    列表返回（按 DAILY→RESERVE 排序），同时保留单类型视图的原有字段结构。
    """
    start = date(year, month, 1)
    if month == 12:
        end = date(year, 12, 31)
    else:
        end = date(year, month + 1, 1) - timedelta(days=1)
    q = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= start,
        DutyRecord.duty_date <= end,
    )
    if roster_type != "ALL":
        q = q.filter(DutyRecord.roster_type == roster_type)
    recs = q.order_by(DutyRecord.duty_date.asc(), DutyRecord.roster_type.asc()).all()
    by_date: dict[str, list[dict]] = {}
    for r in recs:
        by_date.setdefault(r.duty_date.isoformat(), []).append(_enrich_record(db, r))
    # 同一日期下固定「日常运营 → 重保」顺序
    for items in by_date.values():
        items.sort(key=lambda x: 0 if x.get("roster_type") == "DAILY" else 1)
    overrides = _load_special_dates(db)
    today = date.today()
    # 补齐当月每一天（无记录的日期返回占位结构）
    days = []
    for d in _daterange(start, end):
        key = d.isoformat()
        entries = by_date.get(key, [])
        is_hol = is_holiday(d, overrides)
        common = {
            "duty_date": key,
            "weekday": WEEKDAY_CN[d.weekday()],
            "day_type": "非工作日" if is_hol else "工作日",
            "is_holiday": is_hol,
            "holiday_name": get_holiday_name(d) if is_hol else None,
            "is_today": d == today,
        }
        if roster_type == "ALL":
            days.append({**common, "entries": entries})
            continue
        if not entries:
            days.append({
                **common,
                "roster_type": roster_type,
                "day_members": [],
                "night_members": [],
                "day_member": None,
                "night_member": None,
                "day_member_names": "",
                "night_member_names": "",
                "status": None,
            })
        else:
            # 实时套用特殊日期覆盖重新计算，避免排班生成后设置的特殊日期不生效
            item = entries[0]
            item["is_holiday"] = is_hol
            item["day_type"] = common["day_type"]
            item["holiday_name"] = common["holiday_name"]
            item["is_today"] = d == today
            days.append(item)
    return {"year": year, "month": month, "days": days}


@router.put("/schedule/{record_id}")
def adjust_record(
    record_id: int,
    body: ManualAdjustRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """手动调班快捷入口：把某天某班次替换为指定人员（单人）。

    多人排班请使用「编辑值班记录」接口（``/schedule/{id}/edit``）。
    直接修改记录，不调整轮换游标、不重排其他日期。
    """
    rec = _get_record_or_404(db, record_id)
    if rec.status == "expired":
        raise HTTPException(status_code=400, detail="已过期的值班记录不可调整")
    new_member = _get_member_or_404(db, body.new_member_id) if body.new_member_id else None
    other_ids = _record_member_ids(rec, "NIGHT" if body.shift == "DAY" else "DAY")
    if new_member is not None and new_member.id in other_ids:
        raise HTTPException(status_code=400, detail="同一人不能在同一天同时排白班和晚班")

    original_ids = _record_member_ids(rec, body.shift)
    target_ids = [new_member.id] if new_member else []
    if original_ids != target_ids:
        _set_record_member_ids(rec, body.shift, target_ids)
        db.add(DutyAdjustmentLog(
            duty_record_id=rec.id,
            shift=body.shift,
            original_member_id=original_ids[0] if original_ids else None,
            new_member_id=new_member.id if new_member else None,
            reason=sanitize_text(body.reason)[:500],
            operator_id=user.id,
            operated_at=beijing_now(),
        ))
    db.commit()
    db.refresh(rec)
    return _enrich_record(db, rec)


@router.post("/schedule/graph/assign")
def graph_assign(
    body: GraphAssignRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """图形化排班：把人员拖到某日某班次（追加），或从班次移除。

    - ``action=add``：追加人员到该班次（已在班次中则忽略），支持多人；
    - ``action=remove``：从该班次移除指定人员；
    - 记录不存在时自动创建（草稿，批次 ``graph``），便于在空日历上直接拖拽；
    - 只修改当前格，不重锚定轮换游标、不自动重排后续草稿；
    - 每次实际变化写入调班日志（原因默认「图形化排班」）。
    """
    if body.member_id is None:
        raise HTTPException(status_code=400, detail="缺少值班人员ID")
    member = _get_member_or_404(db, body.member_id)

    rec = (
        db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date == body.duty_date,
            DutyRecord.roster_type == body.roster_type,
        )
        .first()
    )
    if rec is not None and rec.status == "expired":
        raise HTTPException(status_code=400, detail="已过期的值班记录不可调整")
    if rec is None and body.action == "remove":
        raise HTTPException(status_code=400, detail="该班次尚未安排人员")

    created = False
    if rec is None:
        if member.status != "active":
            raise HTTPException(status_code=400, detail="该人员已停用，不能参与排班")
        overrides = _load_special_dates(db)
        rec = DutyRecord(
            duty_date=body.duty_date,
            roster_type=body.roster_type,
            is_holiday=is_holiday(body.duty_date, overrides),
            status="draft",
            generated_batch="graph",
        )
        db.add(rec)
        db.flush()
        created = True

    shift_ids = _record_member_ids(rec, body.shift)
    other_ids = _record_member_ids(rec, "NIGHT" if body.shift == "DAY" else "DAY")
    changed = False
    if body.action == "add":
        if member.status != "active":
            raise HTTPException(status_code=400, detail="该人员已停用，不能参与排班")
        if member.id in other_ids:
            raise HTTPException(status_code=400, detail="同一人不能在同一天同时排白班和晚班")
        if member.id not in shift_ids:
            shift_ids.append(member.id)
            changed = True
    else:
        if member.id in shift_ids:
            shift_ids = [mid for mid in shift_ids if mid != member.id]
            changed = True

    if changed:
        _set_record_member_ids(rec, body.shift, shift_ids)
        db.add(DutyAdjustmentLog(
            duty_record_id=rec.id,
            shift=body.shift,
            original_member_id=member.id if body.action == "remove" else None,
            new_member_id=member.id if body.action == "add" else None,
            reason=sanitize_text(body.reason or "图形化排班")[:500],
            operator_id=user.id,
            operated_at=beijing_now(),
        ))
    db.commit()
    db.refresh(rec)
    result = _enrich_record(db, rec)
    result["created"] = created
    result["changed"] = changed
    return result


@router.put("/schedule/{record_id}/edit")
def edit_record(
    record_id: int,
    body: RecordEditRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """整条值班记录编辑：草稿/已发布均可，一次修改白班、晚班与记录状态。

    - 白班/晚班均以人员 ID 列表提交，支持一个班次多人；
    - 直接修改记录字段，不重锚定轮换游标、不自动重排后续草稿；
    - 每个人员的增减都写入调班日志（原因默认「数据编辑」）；
    - 已过期记录不可编辑；同一人不能同时出现在白班和晚班。
    """
    rec = _get_record_or_404(db, record_id)
    if rec.status == "expired":
        raise HTTPException(status_code=400, detail="已过期的值班记录不可编辑")

    def _normalize(ids, legacy_id):
        if ids is not None:
            return list(dict.fromkeys(int(i) for i in ids if i))
        if legacy_id:
            return [legacy_id]
        return None  # None = 不修改

    day_ids = _normalize(body.day_member_ids, body.day_member_id)
    night_ids = _normalize(body.night_member_ids, body.night_member_id)

    for mid in set((day_ids or []) + (night_ids or [])):
        _get_member_or_404(db, mid)
    if day_ids and night_ids and set(day_ids) & set(night_ids):
        raise HTTPException(status_code=400, detail="同一人不能在同一天同时排白班和晚班")

    reason = sanitize_text(body.reason or "数据编辑")[:500]
    changed = 0
    for shift, new_ids in (("DAY", day_ids), ("NIGHT", night_ids)):
        if new_ids is None:
            continue
        old_ids = _record_member_ids(rec, shift)
        added = [mid for mid in new_ids if mid not in old_ids]
        removed = [mid for mid in old_ids if mid not in new_ids]
        if not added and not removed:
            continue
        _set_record_member_ids(rec, shift, new_ids)
        for mid in added:
            db.add(DutyAdjustmentLog(
                duty_record_id=rec.id, shift=shift,
                original_member_id=None, new_member_id=mid,
                reason=reason, operator_id=user.id, operated_at=beijing_now(),
            ))
        for mid in removed:
            db.add(DutyAdjustmentLog(
                duty_record_id=rec.id, shift=shift,
                original_member_id=mid, new_member_id=None,
                reason=reason, operator_id=user.id, operated_at=beijing_now(),
            ))
        changed += len(added) + len(removed)

    if body.status is not None and body.status != rec.status:
        rec.status = body.status
        changed += 1

    db.commit()
    db.refresh(rec)
    result = _enrich_record(db, rec)
    result["changed"] = changed
    return result


@router.put("/schedule/{record_id}/status")
def update_record_status(
    record_id: int,
    body: RecordStatusUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """变更单条值班记录状态（发布/过期）。"""
    rec = _get_record_or_404(db, record_id)
    rec.status = body.status
    db.commit()
    db.refresh(rec)
    return _enrich_record(db, rec)


@router.delete("/schedule/{record_id}", status_code=204)
def delete_record(
    record_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "delete")),
):
    """删除单条值班记录（admin / duty:delete）。硬删除，同时清理关联调班日志。

    适用于修正错误排班/移除孤立记录；整段重排请使用「生成值班表」(overwrite)。
    """
    rec = _get_record_or_404(db, record_id)
    # 级联清理该记录的调班日志（外键无约束，显式删除避免孤儿）
    db.query(DutyAdjustmentLog).filter(DutyAdjustmentLog.duty_record_id == record_id).delete(synchronize_session=False)
    db.delete(rec)
    db.commit()
    logger.warning("值班记录已删除: id=%s, date=%s, operator=%s", record_id, rec.duty_date, user.username)
    return None


@router.get("/schedule/export")
def export_schedule(
    start_date: date = Query(...),
    end_date: date = Query(...),
    roster_type: Literal["DAILY", "RESERVE", "ALL"] = Query("DAILY", description="值班表类型（ALL=全部）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "view")),
):
    """导出指定类型的值班表为 Excel；ALL 导出两类全部记录（含类型列）。"""
    q = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= start_date,
        DutyRecord.duty_date <= end_date,
    )
    if roster_type != "ALL":
        q = q.filter(DutyRecord.roster_type == roster_type)
    recs = q.order_by(DutyRecord.duty_date.asc(), DutyRecord.roster_type.asc()).all()
    status_cn = {"draft": "草稿", "published": "已发布", "expired": "已过期"}
    headers = ["日期", "星期", "值班表类型", "日期类型", "白班人员", "白班电话", "晚班人员", "晚班电话", "状态"]
    rows = [headers]
    member_cache: dict[int, DutyMember] = {}
    for rec in recs:
        def _get(mid):
            if mid is None:
                return None
            if mid not in member_cache:
                member_cache[mid] = db.query(DutyMember).filter(DutyMember.id == mid).first()
            return member_cache[mid]
        day_ms = [m for m in (_get(mid) for mid in _record_member_ids(rec, "DAY")) if m]
        night_ms = [m for m in (_get(mid) for mid in _record_member_ids(rec, "NIGHT")) if m]
        rows.append([
            rec.duty_date.isoformat(),
            WEEKDAY_CN[rec.duty_date.weekday()],
            ROSTER_TYPE_LABELS.get(rec.roster_type, rec.roster_type),
            "非工作日" if rec.is_holiday else "工作日",
            "，".join(m.name for m in day_ms) or "待分配",
            "，".join(m.phone for m in day_ms),
            "，".join(m.name for m in night_ms) or "待分配",
            "，".join(m.phone for m in night_ms),
            status_cn.get(rec.status, rec.status),
        ])
    content = _to_xlsx_bytes(rows, "值班表")
    from urllib.parse import quote
    type_label = ROSTER_TYPE_LABELS.get(roster_type, roster_type)
    filename = quote(f"{type_label}值班表_{start_date}_{end_date}.xlsx")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


# ============ 请假管理 ============

@router.get("/leaves")
def list_leaves(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    status: str = Query("", description="按审批状态筛选"),
    member_id: int = Query(0, description="按人员筛选"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_leave", "view")),
):
    """请假记录列表（分页，富化人员姓名）。"""
    q = db.query(DutyLeaveLog)
    if status in ("pending", "approved", "rejected"):
        q = q.filter(DutyLeaveLog.status == status)
    if member_id:
        q = q.filter(DutyLeaveLog.member_id == member_id)
    q = q.order_by(DutyLeaveLog.created_at.desc())
    page = max(1, page)
    size = max(1, min(size, 200))
    total = q.count()
    items = q.offset((page - 1) * size).limit(size).all()
    member_ids = list({it.member_id for it in items})
    member_map = {m.id: m for m in db.query(DutyMember).filter(DutyMember.id.in_(member_ids)).all()} if member_ids else {}
    return {
        "items": [
            {**it.to_dict(), "member_name": member_map[it.member_id].name if it.member_id in member_map else None}
            for it in items
        ],
        "total": total,
        "page": page,
        "size": size,
        "pages": (total + size - 1) // size if total > 0 else 0,
    }


@router.post("/leaves", status_code=201)
def create_leave(
    body: LeaveCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_leave", "edit")),
):
    """提交请假申请。"""
    _get_member_or_404(db, body.member_id)
    if body.end_date < body.start_date:
        raise HTTPException(status_code=400, detail="请假结束日期不能早于开始日期")
    leave = DutyLeaveLog(
        member_id=body.member_id,
        start_date=body.start_date,
        end_date=body.end_date,
        shift=body.shift,
        reason=sanitize_text(body.reason)[:500],
        status="pending",
    )
    db.add(leave)
    db.commit()
    db.refresh(leave)
    return leave.to_dict()


@router.put("/leaves/{leave_id}/approve")
def approve_leave(
    leave_id: int,
    body: LeaveApprove,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_leave", "edit")),
):
    """审批请假申请（approved=批准，rejected=拒绝）。

    批准后该人员请假期间自动跳过排班；已生成的班次会标记为 needs_adjust
    （由 _enrich_record 动态计算，无需主动改 DutyRecord）。
    """
    leave = db.query(DutyLeaveLog).filter(DutyLeaveLog.id == leave_id).first()
    if leave is None:
        raise HTTPException(status_code=404, detail="请假记录不存在")
    if leave.status != "pending":
        raise HTTPException(status_code=400, detail="该请假申请已审批，不可重复审批")
    leave.status = body.status
    leave.operator_id = user.id
    leave.approve_reason = sanitize_text(body.reason)[:500] if body.reason else None
    db.commit()
    db.refresh(leave)
    # 批准时检查是否影响已发布值班表，返回影响天数供前端提示
    affected_count = 0
    if body.status == "approved":
        affected_recs = (
            db.query(DutyRecord)
            .filter(
                DutyRecord.duty_date >= leave.start_date,
                DutyRecord.duty_date <= leave.end_date,
                DutyRecord.status == "published",
            )
            .all()
        )
        for r in affected_recs:
            if leave.member_id in _record_member_ids(r, "DAY") and leave.shift in ("DAY", "ALL"):
                affected_count += 1
            if leave.member_id in _record_member_ids(r, "NIGHT") and leave.shift in ("NIGHT", "ALL"):
                affected_count += 1
    result = leave.to_dict()
    result["affected_count"] = affected_count
    return result


@router.delete("/leaves/{leave_id}", status_code=204)
def delete_leave(
    leave_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_leave", "delete")),
):
    """删除请假记录（admin / 拥有 duty:delete 权限）。硬删除，不可恢复。

    仅删除请假记录本身，不回溯已受影响的值班表（如需调整，手动调班或重新生成）。
    """
    leave = db.query(DutyLeaveLog).filter(DutyLeaveLog.id == leave_id).first()
    if leave is None:
        raise HTTPException(status_code=404, detail="请假记录不存在")
    db.delete(leave)
    db.commit()
    logger.warning("请假记录已删除: id=%s, member_id=%s, operator=%s", leave_id, leave.member_id, user.username)
    return None


@router.post("/leaves/batch-delete")
def batch_delete_leaves(
    body: BatchIds,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_leave", "delete")),
):
    """批量删除请假记录（admin / duty:delete）。单次上限 50 条，跳过不存在的 ID。"""
    ids = [i for i in (body.ids or [])][:50]
    if not ids:
        raise HTTPException(status_code=400, detail="未提供待删除 ID")
    deleted = db.query(DutyLeaveLog).filter(DutyLeaveLog.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    logger.warning("批量删除请假记录 %d 条, operator=%s, ids=%s", deleted, user.username, ids)
    return {"deleted": deleted, "not_found": len(ids) - deleted}


# ============ 调班记录 ============

@router.get("/adjustment-logs")
def list_adjustment_logs(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    start_date: date = Query(None, description="按调整日期起（关联值班记录日期）"),
    end_date: date = Query(None, description="按调整日期止"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_log", "view")),
):
    """调班记录列表（分页，富化人员姓名/操作人/值班日期）。"""
    q = db.query(DutyAdjustmentLog).order_by(DutyAdjustmentLog.operated_at.desc())
    if start_date or end_date:
        sub = db.query(DutyRecord.id).filter()
        if start_date:
            sub = sub.filter(DutyRecord.duty_date >= start_date)
        if end_date:
            sub = sub.filter(DutyRecord.duty_date <= end_date)
        rec_ids = [r[0] for r in sub.all()]
        q = q.filter(DutyAdjustmentLog.duty_record_id.in_(rec_ids)) if rec_ids else q.filter(False)
    page = max(1, page)
    size = max(1, min(size, 200))
    total = q.count()
    items = q.offset((page - 1) * size).limit(size).all()
    # 批量富化
    rec_ids = list({it.duty_record_id for it in items})
    rec_map = {r.id: r for r in db.query(DutyRecord).filter(DutyRecord.id.in_(rec_ids)).all()} if rec_ids else {}
    m_ids = list({x for it in items for x in (it.original_member_id, it.new_member_id) if x})
    op_ids = list({it.operator_id for it in items})
    member_rows = db.query(DutyMember).filter(DutyMember.id.in_(m_ids)).all() if m_ids else []
    member_map = {m.id: m.name for m in member_rows}
    member_phone_map = {m.id: m.phone for m in member_rows}
    op_map = {u.id: u.username for u in db.query(User).filter(User.id.in_(op_ids)).all()} if op_ids else {}
    return {
        "items": [
            {
                **it.to_dict(),
                "duty_date": rec_map[it.duty_record_id].duty_date.isoformat() if it.duty_record_id in rec_map else None,
                "original_member_name": member_map.get(it.original_member_id),
                "original_member_phone": member_phone_map.get(it.original_member_id),
                "new_member_name": member_map.get(it.new_member_id),
                "new_member_phone": member_phone_map.get(it.new_member_id),
                "operator_name": op_map.get(it.operator_id),
            }
            for it in items
        ],
        "total": total,
        "page": page,
        "size": size,
        "pages": (total + size - 1) // size if total > 0 else 0,
    }


@router.delete("/adjustment-logs/{log_id}", status_code=204)
def delete_adjustment_log(
    log_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_log", "delete")),
):
    """删除调班记录（admin / duty:delete）。硬删除日志条目，不回退实际班次变更。

    如需回退班次到调整前的人员，请先使用「撤销调班」(revert) 再删除日志。
    """
    log = db.query(DutyAdjustmentLog).filter(DutyAdjustmentLog.id == log_id).first()
    if log is None:
        raise HTTPException(status_code=404, detail="调班记录不存在")
    db.delete(log)
    db.commit()
    logger.warning("调班记录已删除: id=%s, record_id=%s, operator=%s", log_id, log.duty_record_id, user.username)
    return None


@router.post("/adjustment-logs/batch-delete")
def batch_delete_adjustment_logs(
    body: BatchIds,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_log", "delete")),
):
    """批量删除调班记录（admin / duty:delete）。单次上限 50 条，跳过不存在的 ID。"""
    ids = [i for i in (body.ids or [])][:50]
    if not ids:
        raise HTTPException(status_code=400, detail="未提供待删除 ID")
    deleted = db.query(DutyAdjustmentLog).filter(DutyAdjustmentLog.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    logger.warning("批量删除调班记录 %d 条, operator=%s, ids=%s", deleted, user.username, ids)
    return {"deleted": deleted, "not_found": len(ids) - deleted}


# ============ 特殊日期覆盖 ============

@router.get("/special-dates")
def get_special_dates(
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "view")),
):
    """获取特殊日期覆盖列表。"""
    overrides = _load_special_dates(db)
    items = [{"date": k, "day_type": v} for k, v in sorted(overrides.items())]
    return {"items": items, "total": len(items)}


@router.put("/special-dates")
def update_special_dates(
    body: SpecialDatesUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """批量设置特殊日期覆盖（整体覆盖式）。"""
    overrides: dict[str, str] = {}
    for item in body.items:
        overrides[item.date.isoformat()] = item.day_type
    _save_special_dates(db, overrides)
    return {"total": len(overrides)}


@router.post("/special-dates")
def add_special_date(
    item: SpecialDatesUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """单条新增特殊日期（合并入已有覆盖，不覆盖整体）。"""
    overrides = _load_special_dates(db)
    for it in item.items:
        overrides[it.date.isoformat()] = it.day_type
    _save_special_dates(db, overrides)
    return {"total": len(overrides)}


@router.delete("/special-dates/{d}")
def delete_special_date(
    d: date,
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """删除单条特殊日期覆盖。"""
    overrides = _load_special_dates(db)
    key = d.isoformat()
    if key in overrides:
        del overrides[key]
        _save_special_dates(db, overrides)
        _sync_records_is_holiday(db, {d})
    return {"deleted": True, "total": len(overrides)}


# ============ 统计面板 ============

@router.get("/schedule/stats")
def schedule_stats(
    start_date: date = Query(..., description="起始日期"),
    end_date: date = Query(..., description="结束日期"),
    roster_type: Literal["DAILY", "RESERVE", "ALL"] = Query("DAILY", description="值班表类型（ALL=全部）"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_schedule", "view")),
):
    """值班表统计面板：总天数/记录数、白班/晚班已排人次、待分配人次、需调整人次、已发布/草稿数。

    - ``roster_type=ALL`` 时 total 为两类记录数之和（某天两类都有记录则计 2）。
    - ``needs_adjust_count``：受已批准请假影响、需手动替换的班次数（含白班+晚班）。
    """
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="结束日期不能早于起始日期")
    q = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= start_date,
        DutyRecord.duty_date <= end_date,
    )
    if roster_type != "ALL":
        q = q.filter(DutyRecord.roster_type == roster_type)
    recs = q.all()
    approved_leaves = _load_approved_leaves(db, start_date, end_date)
    total = len(recs)
    day_assigned = sum(1 for r in recs if _record_member_ids(r, "DAY"))
    night_assigned = sum(1 for r in recs if _record_member_ids(r, "NIGHT"))
    day_pending = total - day_assigned
    night_pending = total - night_assigned
    needs_adjust = 0
    for r in recs:
        day_ids = set(_record_member_ids(r, "DAY"))
        night_ids = set(_record_member_ids(r, "NIGHT"))
        for lv in approved_leaves:
            if lv.member_id in day_ids and lv.shift in ("DAY", "ALL"):
                needs_adjust += 1
                break
        for lv in approved_leaves:
            if lv.member_id in night_ids and lv.shift in ("NIGHT", "ALL"):
                needs_adjust += 1
                break
    published = sum(1 for r in recs if r.status == "published")
    draft = sum(1 for r in recs if r.status == "draft")
    return {
        "total": total,
        "day_assigned": day_assigned,
        "night_assigned": night_assigned,
        "day_pending": day_pending,
        "night_pending": night_pending,
        "needs_adjust": needs_adjust,
        "published": published,
        "draft": draft,
    }


# ============ 撤销调班 ============

@router.post("/adjustment-logs/{log_id}/revert")
def revert_adjustment(
    log_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_log", "edit")),
):
    """撤销某次调班：将该班次恢复为调班前的原值班人，并记录一条反向调班日志。

    - 不影响轮换游标。
    - 已过期记录不可撤销。
    - 仅可撤销「最近一次」针对该班次的调整（避免连锁回退歧义）。
    """
    log = db.query(DutyAdjustmentLog).filter(DutyAdjustmentLog.id == log_id).first()
    if log is None:
        raise HTTPException(status_code=404, detail="调班记录不存在")
    rec = db.query(DutyRecord).filter(DutyRecord.id == log.duty_record_id).first()
    if rec is None:
        raise HTTPException(status_code=404, detail="关联值班记录已删除，无法撤销")
    if rec.status == "expired":
        raise HTTPException(status_code=400, detail="已过期的值班记录不可撤销调班")
    current_ids = _record_member_ids(rec, log.shift)
    # 校验该班次未被后续调整：新增日志要求人员仍在班次，移除日志要求人员仍不在班次
    if log.new_member_id is not None:
        if log.new_member_id not in current_ids:
            raise HTTPException(status_code=400, detail="该班次在此次调班后又被调整，无法直接撤销（请手动调整）")
    elif log.original_member_id is not None and log.original_member_id in current_ids:
        raise HTTPException(status_code=400, detail="该班次在此次调班后又被调整，无法直接撤销（请手动调整）")
    # 恢复：撤销新增则移除该人；撤销移除则把该人加回
    target_ids = list(current_ids)
    if log.new_member_id is not None:
        target_ids = [mid for mid in target_ids if mid != log.new_member_id]
    if log.original_member_id is not None and log.original_member_id not in target_ids:
        target_ids.insert(0, log.original_member_id)
    _set_record_member_ids(rec, log.shift, target_ids)
    # 记录反向调班日志
    revert_log = DutyAdjustmentLog(
        duty_record_id=rec.id,
        shift=log.shift,
        original_member_id=log.new_member_id,
        new_member_id=log.original_member_id,
        reason=f"撤销调班 #{log.id}",
        operator_id=user.id,
        operated_at=beijing_now(),
    )
    db.add(revert_log)
    db.commit()
    db.refresh(rec)
    return {
        "reverted": True,
        "log_id": log_id,
        "new_log_id": revert_log.id,
        "record": _enrich_record(db, rec),
    }


# ============ 复制值班表 ============

@router.post("/schedule/copy")
def copy_schedule(
    body: ScheduleCopyRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_schedule", "edit")),
):
    """复制值班表：将源日期范围的排班按天平移到目标起始日期。

    - 按天平移：target_date = source_date + (target_start - source_start)。
    - 目标日期已有记录时跳过（不覆盖），保证不误删已排班次。
    - 新记录状态默认 draft，auto_publish=True 时为 published。
    - 不会推进轮换游标（仅复制人员分配）。
    """
    if body.source_end < body.source_start:
        raise HTTPException(status_code=400, detail="源结束日期不能早于源起始日期")
    delta = (body.target_start - body.source_start).days
    if delta == 0:
        raise HTTPException(status_code=400, detail="目标起始日期与源起始日期相同")
    source_recs = (
        db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date >= body.source_start,
            DutyRecord.duty_date <= body.source_end,
            DutyRecord.roster_type == body.roster_type,
        )
        .order_by(DutyRecord.duty_date.asc())
        .all()
    )
    if not source_recs:
        raise HTTPException(status_code=400, detail="源日期范围内无值班记录可复制")
    # 目标范围内已有记录的日期集合（用于跳过）；仅看同一类型，另一类型不受影响
    target_dates = [r.duty_date + timedelta(days=delta) for r in source_recs]
    existing = {
        r.duty_date
        for r in db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date.in_(target_dates),
            DutyRecord.roster_type == body.roster_type,
        )
        .all()
    }
    batch = uuid.uuid4().hex[:12]
    status = "published" if body.auto_publish else "draft"
    copied = 0
    skipped = 0
    new_recs = []
    for src in source_recs:
        td = src.duty_date + timedelta(days=delta)
        if td in existing:
            skipped += 1
            continue
        overrides = _load_special_dates(db)
        is_hol = is_holiday(td, overrides)
        nr = DutyRecord(
            duty_date=td,
            roster_type=body.roster_type,
            day_member_ids=src.day_member_ids,
            night_member_ids=src.night_member_ids,
            day_member_id=src.day_member_id,
            night_member_id=src.night_member_id,
            is_holiday=is_hol,
            status=status,
            generated_batch=f"copy-{batch}",
        )
        db.add(nr)
        new_recs.append(nr)
        copied += 1
    db.commit()
    for nr in new_recs:
        db.refresh(nr)
    logger.info("用户 %s 复制值班表：源 %s~%s → 目标起始 %s，复制 %d 条，跳过 %d 条",
                user.username, body.source_start, body.source_end, body.target_start, copied, skipped)
    return {
        "copied": copied,
        "skipped": skipped,
        "batch": f"copy-{batch}",
        "target_start": body.target_start.isoformat(),
        "items": [_enrich_record(db, nr) for nr in new_recs],
    }


# ============ 轮班公平性统计 ============

@router.get("/members/stats")
def member_stats(
    start_date: date = Query(None, description="起始日期（默认近 90 天）"),
    end_date: date = Query(None, description="结束日期（默认今天）"),
    roster_type: Literal["DAILY", "RESERVE"] = Query("DAILY", description="值班表类型"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_permission("duty_member", "view")),
):
    """轮班公平性统计：按人员统计白班/晚班次数，计算最大/最小/平均与偏离度。

    返回每人的 day_count / night_count / total，以及 fairness 摘要。
    """
    if end_date is None:
        end_date = date.today()
    if start_date is None:
        start_date = end_date - timedelta(days=90)
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="结束日期不能早于起始日期")
    members = (
        db.query(DutyMember)
        .filter(DutyMember.deleted_at.is_(None))
        .order_by(DutyMember.sort_order.asc(), DutyMember.id.asc())
        .all()
    )
    recs = (
        db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date >= start_date,
            DutyRecord.duty_date <= end_date,
            DutyRecord.roster_type == roster_type,
        )
        .all()
    )
    day_map: dict[int, int] = {}
    night_map: dict[int, int] = {}
    for r in recs:
        for mid in _record_member_ids(r, "DAY"):
            day_map[mid] = day_map.get(mid, 0) + 1
        for mid in _record_member_ids(r, "NIGHT"):
            night_map[mid] = night_map.get(mid, 0) + 1
    items = []
    for m in members:
        dc = day_map.get(m.id, 0)
        nc = night_map.get(m.id, 0)
        items.append({
            "id": m.id,
            "name": m.name,
            "group_name": m.group_name,
            "status": m.status,
            "day_count": dc,
            "night_count": nc,
            "total": dc + nc,
        })
    # 值班人员不再分类别，统一按全部人员计算公平性
    totals = [it["total"] for it in items if it["total"] > 0]
    if totals:
        mx = max(totals)
        mn = min(totals)
        avg = round(sum(totals) / len(totals), 1)
        fairness = {"ALL": {"max": mx, "min": mn, "avg": avg, "gap": mx - mn}}
    else:
        fairness = {"ALL": {"max": 0, "min": 0, "avg": 0, "gap": 0}}
    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "items": items,
        "fairness": fairness,
    }


# ============ 批量启用/停用 ============

@router.post("/members/batch-update-status")
def batch_update_member_status(
    body: MemberBatchStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_member", "edit")),
):
    """批量启用/停用值班人员。停用后该人员不再参与后续轮换（已有排班保留）。"""
    ids = list(dict.fromkeys(body.ids))  # 去重保序
    members = (
        db.query(DutyMember)
        .filter(DutyMember.id.in_(ids), DutyMember.deleted_at.is_(None))
        .all()
    )
    updated = []
    for m in members:
        if m.status != body.status:
            m.status = body.status
            updated.append(m.id)
    db.commit()
    logger.info("用户 %s 批量%s %d 名值班人员", user.username,
                "启用" if body.status == "active" else "停用", len(updated))
    return {
        "updated": len(updated),
        "updated_ids": updated,
        "skipped": len(ids) - len(members),
    }


@router.post("/members/reorder")
def reorder_members(
    body: MemberReorderRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("duty_member", "edit")),
):
    """批量重排值班人员顺序：按传入的 ordered_ids 顺序依次赋予 sort_order=1,2,3...

    用于前端拖拽排序后持久化。轮换顺序由 sort_order（升序）决定，重排后立即
    影响后续值班表生成。未传入的人员保持原 sort_order 不变。
    """
    ordered_ids = list(dict.fromkeys(body.ordered_ids))  # 去重保序
    members = (
        db.query(DutyMember)
        .filter(DutyMember.id.in_(ordered_ids), DutyMember.deleted_at.is_(None))
        .all()
    )
    by_id = {m.id: m for m in members}
    updated = 0
    for new_order, mid in enumerate(ordered_ids, start=1):
        m = by_id.get(mid)
        if m is not None and m.sort_order != new_order:
            m.sort_order = new_order
            updated += 1
    db.commit()
    logger.info("用户 %s 重排 %d 名值班人员顺序（更新 %d 项）", user.username, len(ordered_ids), updated)
    return {"updated": updated, "total": len(ordered_ids)}


# ============ 值班监控大屏 ============

@router.get("/dashboard")
def duty_dashboard(
    roster_type: Literal["DAILY", "RESERVE"] = Query("DAILY", description="值班表类型"),
    db: Session = Depends(get_db),
    _user = Depends(require_permission("duty_dashboard", "view")),
):
    """值班监控大屏聚合数据：当前班次/主备、今日记录、近7天排班、异常提醒、本月轮换统计。

    服务端按北京时间判断当前班次：09:00~18:00 为白班，其余为晚班。
    所有日期/人员信息均富化，前端可直接渲染。
    ``roster_type`` 决定大屏展示哪一类值班表（日常运营 / 重保）。
    """
    now = beijing_now()
    today = now.date()
    current_shift = "DAY" if time(9, 0) <= now.time() < time(18, 0) else "NIGHT"
    weekday_cn = WEEKDAY_CN[today.weekday()]

    # 今日记录（按值班表类型隔离）
    today_rec = db.query(DutyRecord).filter(
        DutyRecord.duty_date == today,
        DutyRecord.roster_type == roster_type,
    ).first()
    today_info = _enrich_record(db, today_rec) if today_rec else None

    # 当前班次值班人员（支持多人）
    cur_ids = _record_member_ids(today_rec, current_shift) if today_rec else []
    cur_map = _load_member_map(db, set(cur_ids))
    current_members = [_member_brief(cur_map[mid]) for mid in cur_ids if mid in cur_map]
    current_member = current_members[0] if current_members else None
    # 值班人员不再分类别，原有「长期白班备班」概念取消
    backup_member = None

    # 近 7 天排班（含今天）
    end7 = today + timedelta(days=6)
    recs7 = {
        r.duty_date: r
        for r in db.query(DutyRecord)
        .filter(
            DutyRecord.duty_date >= today,
            DutyRecord.duty_date <= end7,
            DutyRecord.roster_type == roster_type,
        )
        .all()
    }
    leaves7 = _load_approved_leaves(db, today, end7)
    upcoming_7days = []
    pending_anomalies = []
    for i in range(7):
        d = today + timedelta(days=i)
        rec = recs7.get(d)
        if rec:
            info = _enrich_record(db, rec, approved_leaves=leaves7)
        else:
            info = {
                "duty_date": d.isoformat(),
                "roster_type": roster_type,
                "weekday": WEEKDAY_CN[d.weekday()],
                "day_type": "非工作日" if is_holiday(d) else "工作日",
                "holiday_name": get_holiday_name(d) if is_holiday(d) else None,
                "is_today": d == today,
                "is_holiday": is_holiday(d),
                "day_members": [],
                "night_members": [],
                "day_member": None,
                "night_member": None,
                "day_member_names": "",
                "night_member_names": "",
                "day_needs_adjust": False,
                "night_needs_adjust": False,
                "status": None,
            }
        # 待分配异常
        if rec is None or not _record_member_ids(rec, "DAY"):
            pending_anomalies.append({"date": d.isoformat(), "weekday": WEEKDAY_CN[d.weekday()], "shift": "白班", "is_holiday": is_holiday(d)})
        if rec is None or not _record_member_ids(rec, "NIGHT"):
            pending_anomalies.append({"date": d.isoformat(), "weekday": WEEKDAY_CN[d.weekday()], "shift": "晚班", "is_holiday": is_holiday(d)})
        upcoming_7days.append(info)

    # 请假影响（覆盖近7天）
    leave_anomalies = []
    for lv in leaves7:
        m = db.query(DutyMember).filter(DutyMember.id == lv.member_id).first()
        leave_anomalies.append({
            "member_name": m.name if m else "未知",
            "start_date": lv.start_date.isoformat(),
            "end_date": lv.end_date.isoformat(),
            "shift": lv.shift,
            "reason": lv.reason,
        })

    # 近期调班记录（近7天 operated_at）
    since = now - timedelta(days=7)
    recent_logs = (
        db.query(DutyAdjustmentLog)
        .filter(DutyAdjustmentLog.operated_at >= since)
        .order_by(DutyAdjustmentLog.operated_at.desc())
        .limit(10)
        .all()
    )
    log_rec_ids = list({x.duty_record_id for x in recent_logs})
    log_rec_map = {r.id: r for r in db.query(DutyRecord).filter(DutyRecord.id.in_(log_rec_ids)).all()} if log_rec_ids else {}
    log_m_ids = list({x for x in recent_logs for x in (x.original_member_id, x.new_member_id) if x})
    log_m_map = {m.id: m.name for m in db.query(DutyMember).filter(DutyMember.id.in_(log_m_ids)).all()} if log_m_ids else {}
    adjustment_anomalies = []
    for lg in recent_logs:
        rec = log_rec_map.get(lg.duty_record_id)
        adjustment_anomalies.append({
            "duty_date": rec.duty_date.isoformat() if rec else None,
            "original_member_name": log_m_map.get(lg.original_member_id),
            "new_member_name": log_m_map.get(lg.new_member_id),
            "shift": lg.shift,
            "operated_at": lg.operated_at.isoformat() if lg.operated_at else None,
        })

    # 即将交班（支持多人）
    if current_shift == "DAY":
        handover_time = "18:00"
        next_shift = "NIGHT"
        next_ids = _record_member_ids(today_rec, "NIGHT") if today_rec else []
    else:
        handover_time = "明日 09:00"
        next_shift = "DAY"
        tom = db.query(DutyRecord).filter(
            DutyRecord.duty_date == today + timedelta(days=1),
            DutyRecord.roster_type == roster_type,
        ).first()
        next_ids = _record_member_ids(tom, "DAY") if tom else []
    next_map = _load_member_map(db, set(next_ids))
    next_members = [_member_brief(next_map[mid]) for mid in next_ids if mid in next_map]
    upcoming_handover = {
        "next_shift": next_shift,
        "time": handover_time,
        "member": next_members[0] if next_members else None,
        "members": next_members,
    }

    # 本月轮换统计（按人员，分类别）
    month_start = today.replace(day=1)
    if today.month == 12:
        month_end = today.replace(day=31)
    else:
        month_end = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
    month_recs = db.query(DutyRecord).filter(
        DutyRecord.duty_date >= month_start,
        DutyRecord.duty_date <= month_end,
        DutyRecord.roster_type == roster_type,
    ).all()
    day_map: dict = {}
    night_map: dict = {}
    for r in month_recs:
        for mid in _record_member_ids(r, "DAY"):
            day_map[mid] = day_map.get(mid, 0) + 1
        for mid in _record_member_ids(r, "NIGHT"):
            night_map[mid] = night_map.get(mid, 0) + 1
    members_all = (
        db.query(DutyMember)
        .filter(DutyMember.deleted_at.is_(None), DutyMember.status == "active")
        .order_by(DutyMember.sort_order.asc(), DutyMember.id.asc())
        .all()
    )
    rotation_stats = []
    member_groups: list[str] = []
    for m in members_all:
        dc = day_map.get(m.id, 0)
        nc = night_map.get(m.id, 0)
        rotation_stats.append({
            "id": m.id,
            "name": m.name,
            "day_count": dc,
            "night_count": nc,
            "total": dc + nc,
        })
        group_name = (m.group_name or "").strip() or "未分组"
        if group_name not in member_groups:
            member_groups.append(group_name)

    needs_adjust_count = sum(1 for r in upcoming_7days if r.get("day_needs_adjust") or r.get("night_needs_adjust"))
    has_anomaly = bool(pending_anomalies) or needs_adjust_count > 0

    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"),
        "today": today.isoformat(),
        "roster_type": roster_type,
        "roster_type_label": ROSTER_TYPE_LABELS.get(roster_type, roster_type),
        "weekday": weekday_cn,
        "current_shift": current_shift,
        "current_member": current_member,
        "current_members": current_members,
        "backup_member": backup_member,
        "today_record": today_info,
        "upcoming_7days": upcoming_7days,
        "anomalies": {
            "pending": pending_anomalies,
            "leaves": leave_anomalies,
            "adjustments": adjustment_anomalies,
            "upcoming_handover": upcoming_handover,
            "needs_adjust_count": needs_adjust_count,
        },
        "rotation_stats": rotation_stats,
        "member_groups": member_groups,
        "month_range": {"start": month_start.isoformat(), "end": month_end.isoformat()},
        "has_anomaly": has_anomaly,
    }
