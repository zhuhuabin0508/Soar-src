"""用户管理 API。

仅授权用户可查看用户列表，编辑/删除需更高权限。
不可删除/禁用当前登录账号，系统至少保留一个管理员。
"""
import csv
import io
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.database import get_db
from app.dependencies import get_current_user, is_admin, require_permission
from app.models.role import Role
from app.models.user import User
from app.schemas.user import (
    ResetPasswordRequest,
    UserCreate,
    UserOut,
    UserUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["users"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("user", "view")),
) -> list[UserOut]:
    """列出所有用户（含角色显示名）。"""
    logger.info("列出所有用户")
    users = db.query(User).order_by(User.id).all()
    # 批量查询角色名，避免 N+1
    role_ids = {u.role_id for u in users if u.role_id}
    roles_map: dict[int, str] = {}
    if role_ids:
        roles = db.query(Role).filter(Role.id.in_(role_ids)).all()
        roles_map = {r.id: r.name for r in roles}
    result = []
    for u in users:
        data = UserOut.model_validate(u)
        data.role_name = roles_map.get(u.role_id) if u.role_id else None
        result.append(data)
    return result


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
) -> User:
    """创建用户。

    安全防护（防特权提升）：指定角色（``role``/``role_id``）或启用状态
    （``is_active``）为高敏感操作，仅限 admin 执行；非 admin 用户仅能以
    默认 ``analyst`` 角色创建普通用户，不能创建管理员账号。
    """
    # 角色/启用状态为敏感字段：仅 admin 可指定（防特权升级 / Mass Assignment）
    if not is_admin(current, db):
        if body.role not in ("analyst", None) or body.role_id is not None or body.is_active is not True:
            raise HTTPException(status_code=403, detail="仅管理员可创建管理员或指定角色/启用状态")

    existing = db.query(User).filter(User.username == body.username).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"用户名 '{body.username}' 已存在")

    # 等保密码复杂度校验（与系统设置中的密码策略一致）
    from app.core.security_policy import get_security_policy, validate_password_complexity
    policy = get_security_policy(db)
    errors = validate_password_complexity(body.password, policy)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))

    # 根据 role 名称解析 role_id
    role_id = body.role_id
    if not role_id and body.role:
        role = db.query(Role).filter(Role.name == body.role).first()
        if role:
            role_id = role.id

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        email=body.email,
        role=body.role,
        role_id=role_id,
        is_active=body.is_active,
        allowed_login_methods=body.allowed_login_methods,
        # 新建用户首次登录需改密
        must_change_password=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info("用户创建: id=%s, username=%s", user.id, user.username)
    return user


# ==================== 批量导入 / 导出 ====================

# 导入模板列（顺序即模板列顺序）
_IMPORT_HEADERS = ["用户名", "初始密码", "显示名", "邮箱", "角色", "状态", "允许登录方式", "手机", "部门"]
# 导出列（不含密码哈希等敏感字段）
_EXPORT_HEADERS = ["用户名", "显示名", "邮箱", "角色", "状态", "允许登录方式", "手机", "部门", "创建时间", "最后登录时间"]
_LOGIN_METHOD_VALUES = {"password", "otp", "sso"}
_BUILTIN_ROLES = {"admin", "analyst", "viewer"}


def _xlsx_bytes(rows: list[list], sheet_name: str = "Sheet1") -> bytes:
    """生成 .xlsx 字节流（首行表头蓝底白字，参考 duty 模块样式）。"""
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
                cell.alignment = Alignment(horizontal="center")
    # 简单列宽：表头字符数 * 2 + 4
    for c_idx, h in enumerate(rows[0] if rows else [], 1):
        ws.column_dimensions[get_column_letter(c_idx)].width = min(40, len(str(h)) * 2 + 8)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _parse_import_rows(filename: str, raw: bytes) -> list[list]:
    """解析上传文件为行列表（含表头行）。支持 .xlsx / .csv。"""
    name = (filename or "").lower()
    if name.endswith(".xlsx"):
        from openpyxl import load_workbook

        try:
            wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Excel 文件解析失败: {exc}") from exc
        ws = wb.active
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append(["" if c is None else str(c).strip() for c in row])
        return rows
    if name.endswith(".csv"):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("gbk", errors="replace")
        return [["" if c is None else str(c).strip() for c in row] for row in csv.reader(io.StringIO(text))]
    raise ValueError("仅支持 .xlsx / .csv 文件")


def _parse_bool(val: str) -> Optional[bool]:
    """解析状态列：启用/true/是/1 → True；禁用/false/否/0 → False；其他 → None。"""
    v = (val or "").strip().lower()
    if v in ("启用", "true", "是", "1", "yes"):
        return True
    if v in ("禁用", "false", "否", "0", "no"):
        return False
    return None


def _parse_login_methods(val: str) -> Optional[list[str]]:
    """解析允许登录方式列：逗号/顿号/分号分隔；空 → None（允许全部）。"""
    v = (val or "").strip()
    if not v:
        return None
    parts = [p.strip().lower() for p in v.replace("，", ",").replace("、", ",").replace(";", ",").split(",") if p.strip()]
    invalid = [p for p in parts if p not in _LOGIN_METHOD_VALUES]
    if invalid:
        raise ValueError(f"允许登录方式取值无效: {'、'.join(invalid)}（仅支持 password/otp/sso）")
    return parts or None


@router.get("/import-template")
def download_import_template(
    _: User = Depends(require_permission("user", "view")),
) -> StreamingResponse:
    """下载用户批量导入 Excel 模板（含示例行与填写说明）。"""
    example = ["zhangsan", "Init@2026", "张三", "zhangsan@example.com", "analyst", "启用", "password,otp", "13800138000", "安全运营部"]
    notes = [
        ["# 用户名（必填）：2-64 字符，唯一；初始密码（新建必填）：需满足系统密码复杂度策略"],
        ["# 角色：admin / analyst / viewer 或系统中的自定义角色名；留空默认 analyst（仅管理员可指定其他角色）"],
        ["# 状态：启用 / 禁用；留空默认启用（仅管理员可指定）；允许登录方式：password/otp/sso 逗号分隔，留空允许全部"],
        ["# 已存在用户：跳过策略忽略该行；覆盖策略按非空列更新（初始密码非空则重置，留空保留原密码）"],
        ["# 导入时请删除以 # 开头的说明行"],
    ]
    content = _xlsx_bytes([_IMPORT_HEADERS, example] + notes, "用户导入模板")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=users_import_template.xlsx"},
    )


@router.post("/import")
async def import_users(
    file: UploadFile = File(..., description="xlsx/csv 用户清单"),
    conflict_strategy: str = Query("skip", description="冲突策略：skip 跳过已存在 / overwrite 覆盖更新"),
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
) -> dict:
    """批量导入用户（xlsx/csv）。

    安全防护（与单个创建/更新接口一致）：
    - 非 admin 仅可导入 analyst 角色且默认启用的用户，不可指定其他角色/禁用状态；
    - 非 admin 覆盖更新时仅更新资料字段（显示名/邮箱/手机/部门/登录方式/重置密码），
      且不可覆盖管理员账号；
    - 每行密码均做等保复杂度校验；新建用户强制首次登录改密。
    - 返回 ``{total, inserted, updated, skipped, errors}``，行级错误不中断整体导入。
    """
    from app.core.security_policy import get_security_policy, validate_password_complexity

    raw = await file.read()
    try:
        rows = _parse_import_rows(file.filename or "", raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not rows:
        raise HTTPException(status_code=400, detail="文件为空")
    # 跳过首部空行，取第一个非空行为表头
    header_idx = next((i for i, r in enumerate(rows) if any(c for c in r)), -1)
    if header_idx < 0:
        raise HTTPException(status_code=400, detail="文件为空")
    header = rows[header_idx]
    data_rows = rows[header_idx + 1:]
    if len(data_rows) > 10000:
        raise HTTPException(status_code=413, detail=f"行数过多（{len(data_rows)}），请分批导入（每次 ≤10000 行）")

    # 列名 → 索引（容错包含匹配）
    def col(name: str) -> int:
        for i, h in enumerate(header):
            if h and name in h:
                return i
        return -1

    idx = {k: col(k) for k in _IMPORT_HEADERS}
    if idx["用户名"] < 0:
        raise HTTPException(status_code=400, detail="缺少必填列：用户名")

    # 预加载：已有用户名、角色名 → ID、密码策略
    existing_users: dict[str, User] = {u.username: u for u in db.query(User).all()}
    roles_map: dict[str, int] = {r.name: r.id for r in db.query(Role).all()}
    policy = get_security_policy(db)
    strategy = conflict_strategy if conflict_strategy in ("skip", "overwrite") else "skip"
    admin_op = is_admin(current, db)

    def cell(row: list, key: str) -> str:
        i = idx[key]
        return row[i] if 0 <= i < len(row) else ""

    total = inserted = updated = skipped = 0
    errors: list[dict] = []
    seen: set[str] = set()  # 文件内重复用户名去重

    for line, row in enumerate(data_rows, start=header_idx + 2):
        if not row or all(c == "" for c in row):
            continue
        first = row[0] or ""
        if first.startswith("#"):
            continue
        total += 1
        username = cell(row, "用户名")
        password = cell(row, "初始密码")
        display_name = cell(row, "显示名")
        email = cell(row, "邮箱")
        role_name = cell(row, "角色")
        status_val = cell(row, "状态")
        methods_val = cell(row, "允许登录方式")
        phone = cell(row, "手机")
        department = cell(row, "部门")

        def fail(msg: str):
            errors.append({"row": line, "username": username, "msg": msg})
            nonlocal skipped
            skipped += 1

        if not username or not (2 <= len(username) <= 64):
            fail("用户名必填且长度 2-64")
            continue
        if username in seen:
            fail("文件内重复的用户名")
            continue
        seen.add(username)

        # 状态 / 角色解析（带合法性校验）
        is_active_val = _parse_bool(status_val)
        if status_val.strip() and is_active_val is None:
            fail(f"状态取值无效: {status_val}（应为 启用/禁用）")
            continue
        try:
            allowed_methods = _parse_login_methods(methods_val)
        except ValueError as exc:
            fail(str(exc))
            continue

        role_id: Optional[int] = None
        if role_name:
            if role_name in roles_map:
                role_id = roles_map[role_name]
            elif role_name not in _BUILTIN_ROLES:
                fail(f"角色不存在: {role_name}")
                continue
        # 非 admin 防特权提升：仅可导入默认启用的 analyst（状态留空视为默认启用，仅明确禁用被拒）
        if not admin_op and (role_name not in ("", "analyst") or is_active_val is False):
            fail("仅管理员可指定角色或禁用状态")
            continue

        existing = existing_users.get(username)
        if existing and strategy == "skip":
            skipped += 1
            continue

        if existing:
            # ===== 覆盖更新 =====
            if not admin_op and is_admin(existing, db):
                fail("仅管理员可覆盖管理员账号")
                continue
            # 不可通过导入禁用/降级自己
            if existing.id == current.id and is_active_val is False:
                fail("不可禁用当前登录账号")
                continue
            # 非 admin 不可改角色/启用状态（敏感字段，与更新接口一致）
            if not admin_op and (role_name or is_active_val is not None):
                fail("仅管理员可修改用户角色或启用状态")
                continue
            # 密码校验前置：失败则整行跳过，不落任何字段修改
            if password:
                pwd_errors = validate_password_complexity(password, policy)
                if pwd_errors:
                    fail("；".join(pwd_errors))
                    continue
            if display_name:
                existing.display_name = display_name
            if email:
                existing.email = email
            if phone:
                existing.phone = phone
            if department:
                existing.department = department
            if allowed_methods is not None:
                existing.allowed_login_methods = allowed_methods
            if admin_op:
                if role_name:
                    existing.role = role_name
                    existing.role_id = role_id
                if is_active_val is not None:
                    existing.is_active = is_active_val
            if password:
                existing.password_hash = hash_password(password)
                existing.must_change_password = True
            updated += 1
        else:
            # ===== 新建 =====
            if not password:
                fail("新建用户初始密码必填")
                continue
            pwd_errors = validate_password_complexity(password, policy)
            if pwd_errors:
                fail("；".join(pwd_errors))
                continue
            final_role = role_name or "analyst"
            user = User(
                username=username,
                password_hash=hash_password(password),
                display_name=display_name or None,
                email=email or None,
                role=final_role,
                role_id=role_id,
                is_active=is_active_val if is_active_val is not None else True,
                allowed_login_methods=allowed_methods,
                phone=phone or None,
                department=department or None,
                must_change_password=True,
            )
            db.add(user)
            existing_users[username] = user
            inserted += 1

    db.commit()
    logger.info(
        "用户批量导入: operator=%s, total=%d, inserted=%d, updated=%d, skipped=%d, errors=%d",
        current.username, total, inserted, updated, skipped, len(errors),
    )
    return {
        "total": total,
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors[:100],
    }


@router.get("/export")
def export_users(
    ids: str = Query("", description="指定用户 ID 列表（逗号分隔）；为空导出全部"),
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "view")),
    request: Request = None,
) -> StreamingResponse:
    """导出用户列表为 xlsx（不含密码等敏感字段）。

    - 未传 ``ids``：导出全部用户；
    - 传 ``ids``：只导出选中的用户（用于「导出选中」）。
    """
    from app.core.audit import get_client_ip, log_audit

    query = db.query(User)
    if ids:
        id_list = [int(p) for p in ids.split(",") if p.strip().isdigit()]
        if id_list:
            query = query.filter(User.id.in_(id_list))
    users = query.order_by(User.id).all()

    # 角色名映射（自定义角色优先显示 role_name）
    role_ids = {u.role_id for u in users if u.role_id}
    roles_map: dict[int, str] = {}
    if role_ids:
        roles_map = {r.id: r.name for r in db.query(Role).filter(Role.id.in_(role_ids)).all()}

    def _fmt(t) -> str:
        return t.strftime("%Y-%m-%d %H:%M:%S") if t else ""

    rows = [_EXPORT_HEADERS]
    for u in users:
        role_display = (roles_map.get(u.role_id) if u.role_id else None) or u.role
        rows.append([
            u.username,
            u.display_name or "",
            u.email or "",
            role_display,
            "启用" if u.is_active else "禁用",
            ",".join(u.allowed_login_methods) if u.allowed_login_methods else "",
            u.phone or "",
            u.department or "",
            _fmt(u.created_at),
            _fmt(u.last_login_at),
        ])

    content = _xlsx_bytes(rows, "用户列表")
    # 审计：导出操作（GET 请求不被中间件捕获，需手动记录）
    log_audit(
        db, user_id=current.id, username=current.username, action="export",
        resource_type="user", ip_address=get_client_ip(request) if request else None,
        result="success", detail={"count": len(users), "ids": ids},
    )
    db.commit()
    filename = f"users_{datetime.now().strftime('%Y%m%d')}.xlsx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.put("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
) -> User:
    """更新用户信息（不含密码）。

    安全防护（防特权提升）：修改角色字段（``role``/``role_id``）与启用状态
    （``is_active``）为高敏感操作，仅限 admin 执行。仅拥有 ``user:edit``
    权限的非 admin 用户只能更新 ``display_name``/``email``/``allowed_login_methods``
    等非敏感资料字段，杜绝通过批量更新把普通账号提升为管理员。
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 角色/启用状态为敏感字段：仅 admin 可修改（防特权升级 / Mass Assignment）
    sensitive_fields = ("role", "role_id", "is_active")
    if any(getattr(body, f, None) is not None for f in sensitive_fields) and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="仅管理员可修改用户角色或启用状态")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(user, key, value)
    db.commit()
    db.refresh(user)
    logger.info("用户更新: id=%s", user_id)
    return user


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "delete")),
) -> None:
    """删除用户（不可删除自己，系统至少保留一个管理员）。"""
    if current.id == user_id:
        raise HTTPException(status_code=400, detail="不可删除当前登录账号")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 保护最后一个管理员（role 字段或 role_id 指向 admin 角色均计入）
    if is_admin(user, db):
        admin_role_ids = [r.id for r in db.query(Role).filter(Role.name == "admin").all()]
        conds = [User.role == "admin"]
        if admin_role_ids:
            conds.append(User.role_id.in_(admin_role_ids))
        admin_count = db.query(User).filter(or_(*conds)).count()
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="系统至少保留一个管理员账号")

    db.delete(user)
    db.commit()
    logger.info("用户删除: id=%s", user_id)
    return None


@router.post("/{user_id}/reset-password", response_model=UserOut)
def reset_password(
    user_id: int,
    body: ResetPasswordRequest,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
) -> User:
    """管理员重置用户密码。

    安全防护（防接管）：重置 admin 账号密码为高敏感操作，仅限 admin 执行，
    防止仅持 ``user:edit`` 的自定义角色用户重置管理员密码后登录接管系统。
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 目标是管理员账号时仅 admin 可重置（防垂直越权接管）
    if is_admin(user, db) and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="仅管理员可重置管理员账号的密码")

    # 等保密码复杂度校验（与系统设置中的密码策略一致）
    from app.core.security_policy import get_security_policy, validate_password_complexity
    policy = get_security_policy(db)
    errors = validate_password_complexity(body.new_password, policy)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))

    user.password_hash = hash_password(body.new_password)
    # 管理员重置后强制用户下次登录改密
    user.must_change_password = True
    db.commit()
    db.refresh(user)
    logger.info(
        "密码重置: user_id=%s, operator=%s, target_is_admin=%s",
        user_id, current.username, is_admin(user, db),
    )
    return user


@router.post("/{user_id}/toggle-active", response_model=UserOut)
def toggle_active(
    user_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
) -> User:
    """启用/禁用用户（不可禁用自己；禁用管理员需 admin 且系统至少保留一个）。"""
    if current.id == user_id:
        raise HTTPException(status_code=400, detail="不可禁用当前登录账号")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 禁用/启用管理员账号为高敏感操作：仅 admin 可执行
    if is_admin(user, db) and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="仅管理员可启停管理员账号")
    # 禁用（而非启用）admin 时校验最后一个管理员保护
    if user.is_active and is_admin(user, db):
        conds = [User.role == "admin"]
        from app.models.role import Role as _Role
        admin_role_ids = [
            r.id for r in db.query(_Role.id).filter(_Role.name == "admin").all()
        ]
        if admin_role_ids:
            from sqlalchemy import or_
            conds.append(User.role_id.in_(admin_role_ids))
        from sqlalchemy import or_ as _or
        admin_count = db.query(User).filter(_or(*conds)).count()
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="系统至少保留一个管理员账号")

    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)
    logger.info("用户启停: user_id=%s, active=%s, operator=%s", user_id, user.is_active, current.username)
    return user


@router.post("/{user_id}/force-logout")
def force_logout(
    user_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("user", "edit")),
    authorization: Optional[str] = Header(None),
) -> dict:
    """强制下线指定用户的所有会话（管理员操作）。

    将该用户当前所有活跃会话的 token 拉黑并删除会话记录，
    受影响的设备在下一次请求时将收到 401 未认证错误。

    安全策略：
    - 不可强制下线自己（避免误操作，请使用「退出登录」）
    - 记录审计日志（含操作者 IP）
    - 默认下线该用户全部会话；如需保留当前管理员会话，
      ``except_sid`` 可由调用方扩展（当前不传，下线目标用户的全部）

    Args:
        user_id: 目标用户 ID。
        request: HTTP 请求（用于获取客户端 IP）。
        db: 数据库会话。
        current: 当前登录用户（鉴权）。
        authorization: Authorization 头（保留以与 auth 模块一致，本接口不使用）。

    Returns:
        ``{"ok": True, "revoked": <被下线的会话数>}``。
    """
    from app.core.session import revoke_all_sessions
    from app.core.audit import get_client_ip, log_audit

    if current.id == user_id:
        raise HTTPException(status_code=400, detail="不可强制下线当前登录账号，请使用「退出登录」")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    revoked = revoke_all_sessions(user_id)
    ip = get_client_ip(request)
    log_audit(
        db,
        user_id=current.id,
        username=current.username,
        action="force_logout",
        resource_type="user",
        resource_id=str(user_id),
        ip_address=ip,
        result="success",
        detail={"target_user": user.username, "revoked_sessions": revoked},
    )
    logger.info(
        "强制下线: operator=%s, target_user_id=%s, target_username=%s, revoked=%d",
        current.username, user_id, user.username, revoked,
    )
    return {"ok": True, "revoked": revoked}
