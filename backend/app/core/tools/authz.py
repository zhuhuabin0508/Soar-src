"""对话内角色权限闸：has_permission / resolve_user_permissions / user_may_call。"""
from __future__ import annotations

from typing import Any, Optional

from app.core.permissions import has_permission, resolve_user_permissions
from sqlalchemy.orm import Session


def required_permission_set(
    required: Any,
) -> tuple[tuple[str, str], ...]:
    """把单权限 (module, action) 或权限序列统一为序列（空序列 = 不设门槛）。

    - ("device", "edit")            → (("device", "edit"),)
    - (("a","b"), ("c","d"))        → 原样（须全部满足）
    - None / ()                     → ()
    """
    if required is None:
        return ()
    if len(required) == 2 and all(isinstance(x, str) for x in required):
        return ((required[0], required[1]),)
    return tuple(required)


def user_may_call(
    user: Any,
    db: Session,
    required: Optional[tuple[str, str] | tuple[tuple[str, str], ...]],
) -> bool:
    """用户是否有权调用工具：所需权限（单个或多个）须全部满足。

    - required 为 None / 空序列 → 放行（不设门槛）
    - 管理员放行（is_admin）
    - 多权限序列 = 全部满足才放行（工作流工具按图推导的权限并集）
    """
    perms = required_permission_set(required)
    if user is None or not perms:
        return True
    from app.dependencies import is_admin

    if is_admin(user, db):
        return True
    permissions = resolve_user_permissions(user, db)
    return all(has_permission(permissions, module, action) for module, action in perms)
