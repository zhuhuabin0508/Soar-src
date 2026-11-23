"""角色管理 API。

支持自定义角色的增删改查与权限矩阵配置。
系统内置角色（admin/analyst/viewer）不可删除。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.permissions import (
    ACTION_LABELS,
    MODULE_LABELS,
    PERMISSION_MODULES,
    migrate_permissions,
)
from app.database import get_db
from app.dependencies import get_current_user, is_admin, require_permission
from app.models.role import Role
from app.models.user import User
from app.schemas.role import RoleCreate, RoleOut, RoleUpdate

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/roles",
    tags=["roles"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=list[RoleOut])
def list_roles(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("role", "view")),
) -> list[dict]:
    """列出所有角色（含已分配用户数）。"""
    logger.info("列出所有角色")
    roles = db.query(Role).order_by(Role.id).all()
    # 统计每个角色已分配的用户数
    result = []
    for r in roles:
        # 自动迁移旧权限矩阵（workflow / asset → 细分子模块）；不回补新增动作
        perms = migrate_permissions(r.permissions, grant_new_actions=False)
        if perms != r.permissions:
            r.permissions = perms
            db.add(r)
        item = {
            "id": r.id,
            "name": r.name,
            "description": r.description,
            "permissions": perms,
            "is_system": r.is_system,
            "created_at": r.created_at,
            "user_count": db.query(User).filter(User.role_id == r.id).count(),
        }
        result.append(item)
    db.commit()
    return result


@router.get("/modules")
def get_permission_modules() -> dict:
    """获取权限模块定义（供前端渲染权限矩阵表格）。

    返回：
        - ``modules``：``{模块名: [动作列表]}``
        - ``module_labels``：模块中文标签
        - ``action_labels``：动作中文标签
    """
    return {
        "modules": PERMISSION_MODULES,
        "module_labels": MODULE_LABELS,
        "action_labels": ACTION_LABELS,
    }


@router.post("", response_model=RoleOut, status_code=201)
def create_role(
    body: RoleCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("role", "edit")),
) -> Role:
    """创建自定义角色。"""
    existing = db.query(Role).filter(Role.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"角色名 '{body.name}' 已存在")

    role = Role(
        name=body.name,
        description=body.description,
        permissions=body.permissions,
    )
    db.add(role)
    db.commit()
    db.refresh(role)
    logger.info("角色创建: id=%s, name=%s", role.id, role.name)
    return role


@router.put("/{role_id}", response_model=RoleOut)
def update_role(
    role_id: int,
    body: RoleUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(require_permission("role", "edit")),
) -> Role:
    """更新角色（名称/描述/权限矩阵）。

    安全防护（防自扩权）：
    - 修改权限矩阵仅限 admin（否则持 role:edit 的用户可把自己所属角色的
      矩阵改成全权限，绕过所有 require_permission 校验）；
    - 系统内置角色（is_system）的名称/权限不可改；
    - admin 自身所属角色视为系统级，同样不可改。
    """
    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")

    perms_changed = "permissions" in body.model_dump(exclude_unset=True)
    if perms_changed and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="仅管理员可修改角色权限矩阵")
    if role.is_system and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="系统内置角色不可修改")
    # admin 所属角色（含 admin 角色本身）仅 admin 可改
    if role.name == "admin" and not is_admin(current, db):
        raise HTTPException(status_code=403, detail="无权修改管理员角色")

    update_data = body.model_dump(exclude_unset=True)
    if "permissions" in update_data and update_data["permissions"] is not None:
        update_data["permissions"] = migrate_permissions(update_data["permissions"], grant_new_actions=False)
    for key, value in update_data.items():
        setattr(role, key, value)
    db.commit()
    db.refresh(role)
    logger.info("角色更新: id=%s, operator=%s", role_id, current.username)
    return role


@router.delete("/{role_id}", status_code=204)
def delete_role(
    role_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("role", "delete")),
) -> None:
    """删除角色（系统内置角色不可删除，有关联用户时不可删除）。"""
    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")
    if role.is_system:
        raise HTTPException(status_code=400, detail="系统内置角色不可删除")

    # 检查是否有用户关联此角色
    user_count = db.query(User).filter(User.role_id == role_id).count()
    if user_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"该角色下仍有 {user_count} 个用户，请先转移用户后再删除",
        )

    db.delete(role)
    db.commit()
    logger.info("角色删除: id=%s", role_id)
    return None
