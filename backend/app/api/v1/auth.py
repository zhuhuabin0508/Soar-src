"""认证路由：登录、登出、令牌刷新、会话管理、修改密码、获取当前用户。

提供 JWT 登录入口，前端登录页调用 ``POST /auth/login`` 获取 token，
后续请求在 ``Authorization: Bearer <token>`` 头中携带。

安全合规增强：
- 图形验证码校验（防暴力枚举）
- 登录失败审计日志（等保要求）
- 登出/刷新/会话管理（令牌黑名单 + Redis 会话跟踪）
- ``/auth/me`` 返回当前用户的权限矩阵（前端按需驱动菜单/按钮显隐）
"""
import json
import logging
import secrets
from datetime import datetime
from app.core.timezone import beijing_now, beijing_now_iso
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.security import (
    create_access_token,
    decode_access_token,
    get_token_ttl_seconds,
    hash_password,
    verify_password,
)
from app.core.session import (
    create_session,
    list_sessions,
    revoke_all_sessions,
    revoke_session,
)
from app.dependencies import get_current_user
from app.database import get_db
from app.config import settings
from app.models.user import User
from app.models.role import Role
from app.core.permissions import has_permission, DEFAULT_ROLES, migrate_permissions
from app.core.audit import get_client_ip, log_audit
from app.core.redis_client import get_redis
from app.schemas.user import UpdateProfileRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    """登录请求体。"""

    username: str = Field(..., description="用户名")
    password: str = Field(..., description="明文密码")
    captcha_id: str = Field(..., description="验证码 ID（由 /auth/captcha 返回）")
    captcha_code: str = Field(..., description="用户输入的验证码")


class LoginResponse(BaseModel):
    """登录响应体。"""

    access_token: Optional[str] = Field(None, description="JWT 访问令牌（密码登录且未启用 OTP 时直接返回）")
    token_type: str = Field("bearer", description="令牌类型")
    user: Optional["UserInfo"] = Field(None, description="用户信息（需 OTP 二步验证时不返回）")
    # OTP 两步验证：密码正确但用户启用了 OTP 时返回此字段
    requires_otp: bool = Field(False, description="是否需要 OTP 二次验证")
    otp_pending_token: Optional[str] = Field(None, description="OTP 待验证临时 token（5 分钟有效）")


class OtpLoginRequest(BaseModel):
    """OTP 二步验证登录请求体。"""

    otp_pending_token: str = Field(..., description="第一步密码验证返回的临时 token")
    otp_code: str = Field(..., description="6 位 OTP 动态码")


class UserInfo(BaseModel):
    """用户信息（脱敏，不含密码）。"""

    id: int
    username: str
    display_name: Optional[str] = None
    email: Optional[str] = None
    role: str
    role_id: Optional[int] = None
    role_name: Optional[str] = None  # 角色显示名（自定义角色用 roles.name，系统角色映射中文）
    is_active: bool
    # 权限矩阵：{模块: [动作]}，前端按需驱动菜单/按钮显隐
    permissions: dict[str, list[str]] = Field(default_factory=dict)
    # 个人资料扩展字段
    phone: Optional[str] = None
    department: Optional[str] = None
    language: str = "zh-CN"
    timezone: str = "Asia/Shanghai"
    bio: Optional[str] = None
    avatar: Optional[str] = None
    # OTP / SSO 状态（供前端展示绑定状态）
    otp_enabled: bool = False
    sso_linked: bool = False
    allowed_login_methods: Optional[list[str]] = None
    # 首次登录/重置密码后强制改密标记
    must_change_password: bool = False

    class Config:
        from_attributes = True


class ChangePasswordRequest(BaseModel):
    """修改密码请求体。"""

    old_password: str = Field(..., description="原密码")
    new_password: str = Field(..., min_length=1, max_length=128, description="新密码")


# 解决前向引用：LoginResponse 引用 UserInfo
LoginResponse.model_rebuild()


def _resolve_permissions(db: Session, user: User) -> dict[str, list[str]]:
    """解析用户权限矩阵。

    优先级：自定义角色（role_id 关联 Role.permissions） > 内置默认角色（DEFAULT_ROLES）。
    admin 角色自动获得全部权限。
    """
    from app.core.permissions import PERMISSION_MODULES
    from app.dependencies import is_admin

    if is_admin(user, db):
        return {mod: list(actions) for mod, actions in PERMISSION_MODULES.items()}
    # 先查自定义角色
    if user.role_id:
        role = db.query(Role).filter(Role.id == user.role_id).first()
        if role and role.permissions:
            perms = role.permissions
            if isinstance(perms, dict):
                # 迁移旧权限键（如 duty）到二级权限矩阵，供前端菜单/按钮显隐
                migrated = migrate_permissions(perms)
                # 写回角色 JSON，避免侧栏长期读到不含 asset_discovery 的旧矩阵
                if migrated != perms:
                    role.permissions = migrated
                    db.add(role)
                    try:
                        db.commit()
                    except Exception:
                        db.rollback()
                        logger.exception("回写迁移后的角色权限失败: role_id=%s", role.id)
                return migrated
    # fallback 到内置默认角色（DEFAULT_ROLES 是 list，不能 .get）
    for default in DEFAULT_ROLES:
        if default["name"] == user.role:
            return dict(default.get("permissions") or {})
    return {}


def _user_info(db: Session, user: User) -> UserInfo:
    """构造脱敏用户信息（含权限矩阵）。"""
    # 解析角色显示名：优先 role_id 关联的 roles.name（自定义角色），fallback 到 user.role
    role_name = user.role
    if user.role_id:
        role = db.query(Role).filter(Role.id == user.role_id).first()
        if role and role.name:
            role_name = role.name
    return UserInfo(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        role_id=user.role_id,
        role_name=role_name,
        is_active=user.is_active,
        permissions=_resolve_permissions(db, user),
        phone=getattr(user, "phone", None),
        department=getattr(user, "department", None),
        language=getattr(user, "language", "zh-CN") or "zh-CN",
        timezone=getattr(user, "timezone", "Asia/Shanghai") or "Asia/Shanghai",
        bio=getattr(user, "bio", None),
        avatar=getattr(user, "avatar", None),
        otp_enabled=getattr(user, "otp_enabled", False) or False,
        sso_linked=bool(getattr(user, "sso_subject", None)),
        allowed_login_methods=getattr(user, "allowed_login_methods", None),
        must_change_password=bool(getattr(user, "must_change_password", False)),
    )


# ============ 多登录方式支持（登录页） ============

# 合法登录方式白名单（系统配置中的非法值会被过滤）
_ALLOWED_METHODS = ("password", "otp", "sso")

# SSO 提供商 ID → 显示名映射（fallback 单提供商场景使用）
_SSO_PROVIDER_NAMES = {
    "oidc": "OIDC",
    "keycloak": "Keycloak",
    "authentik": "Authentik",
    "google": "Google",
    "ldap": "LDAP 域账号",
    "wecom": "企业微信",
    "dingtalk": "钉钉",
    "feishu": "飞书",
}


def _rate_limit_ip(
    request: Request,
    key: str,
    max_count: int,
    window: int,
    message: str = "请求过于频繁，请稍后重试",
) -> None:
    """基于客户端 IP 的固定窗口限频（Redis INCR + EXPIRE）。

    公开接口防刷通用工具：窗口内首个请求 INCR 后设置过期时间，
    超过 ``max_count`` 次抛 429；Redis 不可用时降级放行（可用性优先，
    与会话/黑名单模块的降级策略一致）。

    Args:
        request: 当前请求（用 ``get_client_ip`` 提取真实 IP）。
        key: 业务键名，Redis 键为 ``rate_limit:{key}:{ip}``。
        max_count: 窗口内允许的最大请求次数。
        window: 窗口长度（秒）。
        message: 超限时的错误提示文案。

    Raises:
        HTTPException: 429 请求过于频繁。
    """
    ip = get_client_ip(request)
    redis_key = f"rate_limit:{key}:{ip}"
    try:
        redis_client = get_redis()
        count = redis_client.incr(redis_key)
        if count == 1:
            redis_client.expire(redis_key, window)
        if count > max_count:
            logger.warning("IP 限频触发: key=%s, ip=%s, count=%d", key, ip, count)
            raise HTTPException(status_code=429, detail=message)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("IP 限频检查失败（Redis 不可用，降级放行）: key=%s, error=%s", key, exc)


def _get_enabled_login_methods(policy: dict) -> list[str]:
    """解析系统启用的登录方式（``security.login_methods``，JSON 数组字符串）。

    读不到该配置或格式非法时默认全部启用（``["password", "otp", "sso"]``），
    结果按白名单过滤并保序去重。
    """
    raw = policy.get("security.login_methods") or ""
    methods: list[str] = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                methods = [m for m in parsed if isinstance(m, str)]
        except (ValueError, TypeError):
            methods = []
    if not methods:
        methods = list(_ALLOWED_METHODS)
    seen: set[str] = set()
    result: list[str] = []
    for m in methods:
        if m in _ALLOWED_METHODS and m not in seen:
            seen.add(m)
            result.append(m)
    return result


def _get_user_login_methods(user: Optional[User], system_methods: list[str]) -> list[str]:
    """计算用户可用的登录方式：用户配置 ∩ 系统启用。

    用户未配置（null/空/非列表）时不限制，返回系统启用全集（向后兼容）。
    """
    allowed = getattr(user, "allowed_login_methods", None) if user is not None else None
    if not allowed or not isinstance(allowed, list):
        return list(system_methods)
    return [m for m in system_methods if m in allowed]


def _lock_message(remaining: int) -> str:
    """构造账户锁定提示文案。

    ``remaining < 0`` 表示策略为「需人工解锁」模式
    （``security.lockout_auto_unlock=False``），锁定不随时间自动解除，
    须管理员在用户管理页执行「解除冻结」（``POST /users/{id}/unlock``）。
    """
    if remaining < 0:
        return "账户已被冻结，请联系管理员解除锁定"
    mins, secs = remaining // 60, remaining % 60
    return f"账户已被锁定，请在 {mins} 分 {secs} 秒后重试"


def _lockout_triggered_message(policy: dict, reason: str) -> str:
    """连续失败达到阈值触发锁定时的提示文案（区分自动/需人工解锁模式）。"""
    if not policy.get("security.lockout_auto_unlock", True):
        return f"{reason}，账户已被冻结，请联系管理员解除锁定"
    minutes = policy.get("security.lockout_duration_minutes", 15)
    return f"{reason}，账户已被锁定 {minutes} 分钟"


@router.get("/login-methods")
def get_login_methods(request: Request, db: Session = Depends(get_db)) -> dict:
    """获取系统启用的登录方式（公开接口，登录页初始化渲染登录 Tab 用）。

    返回 ``{"methods": [...], "sso_enabled": bool, "captcha_enabled": True}``，
    ``methods`` 来自系统配置 ``security.login_methods``（读不到时默认全启用）。
    """
    _rate_limit_ip(request, "login_methods", max_count=30, window=60)
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    return {
        "methods": _get_enabled_login_methods(policy),
        "sso_enabled": bool(policy.get("security.sso_enabled", False)),
        "captcha_enabled": True,
    }


@router.get("/login-methods/user")
def get_user_login_methods_endpoint(
    request: Request,
    username: str,
    db: Session = Depends(get_db),
) -> dict:
    """获取指定用户可用的登录方式（公开接口，防用户名枚举）。

    用户不存在时返回系统启用全集（与「未配置登录方式限制」的用户响应一致，
    不暴露用户是否存在）；用户配置了 ``allowed_login_methods`` 时返回与系统启用方式的交集。
    """
    _rate_limit_ip(request, "login_methods_user", max_count=20, window=60)
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    system_methods = _get_enabled_login_methods(policy)
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        return {"methods": list(system_methods)}
    return {"methods": _get_user_login_methods(user, system_methods)}


@router.get("/sso/providers")
def get_sso_providers(db: Session = Depends(get_db)) -> dict:
    """获取启用的 SSO 提供商列表（公开接口，登录页动态渲染 SSO 登录入口）。

    - SSO 未开启（``security.sso_enabled=false``）时返回空列表；
    - 优先读 ``security.sso_providers``（JSON 数组，元素 ``{"id","name","type"}``，支持多提供商）；
    - 未配置多提供商时回退到 ``security.sso_provider`` 单提供商（兼容存量配置），
      显示名按 ``_SSO_PROVIDER_NAMES`` 映射，未映射的提供商使用原始 ID。
    """
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    if not policy.get("security.sso_enabled", False):
        return {"providers": []}

    providers: list[dict] = []
    raw = policy.get("security.sso_providers") or ""
    if raw:
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and item.get("id"):
                    pid = str(item["id"])
                    ptype = str(item.get("type") or ("ldap" if pid == "ldap" else "oauth2"))
                    providers.append({
                        "id": pid,
                        "name": str(item.get("name") or _SSO_PROVIDER_NAMES.get(pid, pid)),
                        "type": "ldap" if ptype == "ldap" else "oauth2",
                    })
    if not providers:
        # fallback：兼容存量单提供商配置 security.sso_provider
        pid = str(policy.get("security.sso_provider") or "")
        if pid:
            providers.append({
                "id": pid,
                "name": _SSO_PROVIDER_NAMES.get(pid, pid),
                "type": "ldap" if pid == "ldap" else "oauth2",
            })
    return {"providers": providers}


def _load_smtp_config(db: Session) -> Optional[dict]:
    """从系统设置读取 SMTP 邮件配置。"""
    from app.core.mail import load_smtp_config
    return load_smtp_config(db)


def _send_otp_email(smtp: dict, to_email: str, code: str) -> bool:
    """通过 SMTP 发送 OTP 登录验证码邮件。"""
    from app.core.mail import send_otp_email
    return send_otp_email(smtp, to_email, code)


class OtpSendRequest(BaseModel):
    """OTP 登录验证码发送请求体。

    安全防护：``extra="forbid"`` 拒绝任何未在 Schema 中声明的多余字段（如
    isadmin / role / issso 等特权字段），防止 API 成批分配（Mass Assignment）
    注入 —— 客户端注入的敏感字段会直接返回 422，绝不落入业务逻辑。
    """

    model_config = ConfigDict(extra="forbid")

    username: str = Field(..., min_length=1, max_length=64, description="用户名")


@router.post("/otp/send")
def otp_send(body: OtpSendRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    """发送 OTP 登录验证码到用户邮箱（公开接口）。

    安全设计：
    - 用户不存在时返回与成功一致的 ``{"sent": true}``（防用户名枚举，实际不发送）；
    - 单用户 60 秒内仅可发送一次（Redis ``otp_send_limit:{user_id}``）；
    - 验证码为 6 位数字，存 Redis ``otp_login:{user_id}``，5 分钟有效、登录成功后一次性消费；
    - 系统配置了 SMTP（``security.smtp_*``）时发送真实邮件（用户无邮箱返回 400）；
      未配置 SMTP 且开启 ``ENABLE_DEV_CODE`` 时响应附带 ``dev_code``（仅本地调试）；
      未配置 SMTP 且开关关闭时返回 503 业务错误，响应中绝不含验证码。
    """
    _rate_limit_ip(request, "otp_send", max_count=5, window=60, message="请求过于频繁，请稍后重试")
    from app.core.security_policy import get_security_policy, is_account_locked

    ip = get_client_ip(request)
    policy = get_security_policy(db)
    system_methods = _get_enabled_login_methods(policy)

    user = db.query(User).filter(User.username == body.username).first()
    if user is None:
        # 防枚举：与成功响应保持一致
        logger.info("OTP 验证码发送请求，用户不存在: username=%s", body.username)
        log_audit(db, username=body.username, action="otp_send",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "user_not_found"})
        return {"sent": True}

    # 登录方式校验：otp ∈ 用户允许方式 且 ∈ 系统启用方式
    if "otp" not in _get_user_login_methods(user, system_methods):
        raise HTTPException(status_code=400, detail="该用户不支持 OTP 登录")

    # 60 秒单用户发送限频（原子 SETNX）
    try:
        limited = not get_redis().set(f"otp_send_limit:{user.id}", 1, ex=60, nx=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("OTP 发送限频检查失败（Redis 不可用，降级放行）: %s", exc)
        limited = False
    if limited:
        raise HTTPException(status_code=429, detail="验证码已发送，请 60 秒后重试")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")

    locked, remaining = is_account_locked(user, policy)
    if locked:
        raise HTTPException(
            status_code=423,
            detail=_lock_message(remaining),
        )

    smtp = _load_smtp_config(db)
    # 有邮件设施但用户未配置邮箱时无法投递
    if smtp is not None and not user.email:
        raise HTTPException(status_code=400, detail="该用户未配置邮箱，无法接收验证码")

    # 生成 6 位数字验证码并存入 Redis（5 分钟有效）
    code = f"{secrets.randbelow(1000000):06d}"
    try:
        get_redis().setex(f"otp_login:{user.id}", 300, code)
    except Exception as exc:  # noqa: BLE001
        logger.warning("OTP 验证码写入 Redis 失败: %s", exc)
        raise HTTPException(status_code=500, detail="系统繁忙，请稍后重试")

    if smtp is not None:
        if not _send_otp_email(smtp, user.email, code):
            raise HTTPException(status_code=500, detail="验证码邮件发送失败，请稍后重试或联系管理员")
        log_audit(db, user_id=user.id, username=user.username, action="otp_send",
                  resource_type="auth", ip_address=ip, result="success",
                  detail={"channel": "email"})
        return {"sent": True}

    # 开发调试模式：仅当显式开启 ENABLE_DEV_CODE 时，验证码才明文回显到响应
    # （供本地开发调试便利）。生产环境该开关必须为 false。
    if settings.ENABLE_DEV_CODE:
        logger.info("邮件服务未配置且 ENABLE_DEV_CODE 开启，验证码返回给前端（仅限本地开发）: username=%s", user.username)
        log_audit(db, user_id=user.id, username=user.username, action="otp_send",
                  resource_type="auth", ip_address=ip, result="success",
                  detail={"channel": "dev_code"})
        return {"sent": True, "dev_code": code}

    # 邮件服务未配置且未开启 dev_code：不生成可用上下文，返回统一业务错误，
    # 响应中绝不包含验证码或任何暗示验证码值的信息（防未授权账号接管）。
    logger.warning("邮件服务未配置且 ENABLE_DEV_CODE 关闭，拒绝发送 OTP 验证码: username=%s", user.username)
    log_audit(db, user_id=user.id, username=user.username, action="otp_send",
              resource_type="auth", ip_address=ip, result="failed",
              detail={"reason": "smtp_not_configured"})
    raise HTTPException(
        status_code=503,
        detail="验证码邮件服务未配置，请联系管理员",
    )


class OtpDirectLoginRequest(BaseModel):
    """OTP 验证码直接登录请求体（免密码一步登录）。"""

    username: str = Field(..., description="用户名")
    otp_code: str = Field(..., description="6 位验证码（邮箱验证码或 TOTP 动态码）")


@router.post("/login/otp-direct", response_model=LoginResponse)
def login_otp_direct(
    body: OtpDirectLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> LoginResponse:
    """OTP 验证码直接登录（无需密码，区别于密码登录后的两步 OTP 验证 ``/login/otp``）。

    验证码二选一，任一匹配即可：
    - ``POST /auth/otp/send`` 发送到邮箱的 6 位验证码（Redis ``otp_login:{user_id}``）；
    - 用户已启用 TOTP 时的 Authenticator 动态码。

    安全策略与密码登录保持一致：账户锁定检查、失败计数与自动锁定、审计日志。
    """
    from app.core.otp import verify_otp_code
    from app.core.security_policy import (
        get_security_policy,
        is_account_locked,
        record_login_failure,
        record_login_success,
    )

    _rate_limit_ip(request, "otp_direct", max_count=10, window=60, message="请求过于频繁，请稍后重试")
    policy = get_security_policy(db)
    system_methods = _get_enabled_login_methods(policy)
    ip = get_client_ip(request)

    user = db.query(User).filter(User.username == body.username).first()
    if user is None:
        # 模糊提示，防用户名枚举
        logger.warning("OTP 直接登录失败，用户不存在: %s", body.username)
        log_audit(db, username=body.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "otp_direct_user_not_found"})
        raise HTTPException(status_code=401, detail="用户名或验证码错误")

    if not user.is_active:
        logger.warning("OTP 直接登录失败，账号已禁用: %s", body.username)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "account_disabled", "method": "otp_direct"})
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")

    # 登录方式校验：otp ∈ 用户允许方式 且 ∈ 系统启用方式
    if "otp" not in _get_user_login_methods(user, system_methods):
        logger.warning("OTP 直接登录失败，用户未授权 OTP 登录: %s", body.username)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "otp_not_allowed", "method": "otp_direct"})
        raise HTTPException(status_code=403, detail="该用户不支持 OTP 登录")

    # 账户锁定检查（复用与密码登录一致的锁定策略）
    locked, remaining = is_account_locked(user, policy)
    if locked:
        logger.warning("OTP 直接登录失败，账户已锁定: %s, 剩余 %ds", body.username, remaining)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "account_locked", "remaining_seconds": remaining,
                          "method": "otp_direct"})
        raise HTTPException(
            status_code=403,
            detail=_lock_message(remaining),
        )

    # 验证码校验：邮箱验证码（Redis）或 TOTP 动态码，任一匹配即可
    code = body.otp_code.strip()
    email_code_key = f"otp_login:{user.id}"
    matched = False
    try:
        stored = get_redis().get(email_code_key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取邮箱验证码失败（Redis 不可用）: %s", exc)
        stored = None
    if stored and stored == code:
        matched = True
    if not matched and getattr(user, "otp_enabled", False) and getattr(user, "otp_secret", None):
        matched = verify_otp_code(user.otp_secret, code)

    if not matched:
        logger.warning("OTP 直接登录失败，验证码错误: username=%s", body.username)
        result = record_login_failure(user, db, policy)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "wrong_otp_code", "method": "otp_direct",
                          "remaining_attempts": result.get("remaining_attempts")})
        if result["locked"]:
            raise HTTPException(
                status_code=403,
                detail=_lockout_triggered_message(policy, "验证码错误次数过多"),
            )
        raise HTTPException(
            status_code=401,
            detail=f"用户名或验证码错误（剩余尝试次数：{result['remaining_attempts']}）",
        )

    # 登录成功：一次性消费邮箱验证码 + 重置失败计数（与密码登录成功路径一致）
    try:
        get_redis().delete(email_code_key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("删除邮箱验证码失败: %s", exc)
    record_login_success(user, db)
    user.last_login_at = beijing_now()
    db.commit()

    token, jti, sid = create_access_token(user.id, user.username, user.role)
    create_session(
        user_id=user.id,
        jti=jti,
        sid=sid,
        device_info={"user_agent": request.headers.get("user-agent", "")[:200]},
        ip_address=ip,
        ttl_seconds=settings.JWT_EXPIRE_MINUTES * 60,
    )
    log_audit(db, user_id=user.id, username=user.username, action="login",
              resource_type="auth", ip_address=ip, result="success",
              detail="OTP 登录成功")
    logger.info("OTP 直接登录成功: username=%s, jti=%s", user.username, jti)
    return LoginResponse(access_token=token, token_type="bearer", user=_user_info(db, user))


class CaptchaResponse(BaseModel):
    """滑块拼图验证码响应体。"""

    captcha_id: str = Field(..., description="验证码 ID，登录时随 captcha_code 一并提交")
    image: str = Field(..., description="含缺口的背景图（base64 PNG data URL）")
    slider_image: str = Field("", description="拼图块小图（base64 PNG data URL，带透明通道）")
    slider_y: int = Field(0, description="缺口在背景图中的 y 坐标（前端按此定位拼图块）")
    slider_size: int = Field(44, description="拼图块直径（像素）")


@router.get("/captcha", response_model=CaptchaResponse)
def get_captcha(request: Request) -> CaptchaResponse:
    """生成滑块拼图验证码（无需认证）。

    前端登录页加载时与点击「刷新」时调用：渲染 ``image``（含缺口背景）与
    ``slider_image``（拼图块，垂直位置按 ``slider_y``），用户拖动滑块对准缺口，
    松手时的 x 坐标作为 ``captcha_code`` 随登录请求提交（容差 ±5px）。
    验证码 5 分钟过期，校验后立即失效（一次性消费）。

    IP 限频：60 秒内最多 20 次，超限返回 429（防止验证码生成接口被刷）。
    """
    _rate_limit_ip(request, "captcha", max_count=20, window=60, message="请求过于频繁")
    from app.core.captcha import generate_captcha
    data = generate_captcha()
    return CaptchaResponse(**data)


class CaptchaCheckRequest(BaseModel):
    """滑块位置预校验请求体（登录前弹窗内即时反馈，不消费验证码）。"""

    captcha_id: str = Field(..., description="验证码 ID")
    x: int = Field(..., ge=0, le=1000, description="滑块松手时的 x 坐标（像素）")


class CaptchaCheckResponse(BaseModel):
    """滑块位置预校验结果。"""

    passed: bool = Field(..., description="位置是否在容差内")
    expired: bool = Field(False, description="验证码已失效，前端应刷新换图")


@router.post("/captcha/check", response_model=CaptchaCheckResponse)
def check_captcha_position(body: CaptchaCheckRequest, request: Request) -> CaptchaCheckResponse:
    """滑块位置预校验（无需认证，不消费验证码）。

    登录页滑块松手时先调本接口获得「验证通过/未对准」的即时反馈，
    通过后再发起登录请求（登录时 ``verify_captcha`` 做最终校验并一次性消费）。
    同一验证码累计 5 次未对准会作废验证图（expired=True），前端需刷新换图。
    """
    _rate_limit_ip(request, "captcha-check", max_count=30, window=60, message="请求过于频繁")
    from app.core.captcha import check_captcha
    passed, expired = check_captcha(body.captcha_id, body.x)
    return CaptchaCheckResponse(passed=passed, expired=expired)


@router.get("/password-policy")
def get_password_policy(db: Session = Depends(get_db)) -> dict:
    """获取密码复杂度策略（无需认证，登录页/个人中心/用户管理共用）。

    返回前端用于实时校验与提示的密码要求，与系统设置中的配置保持一致。
    """
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    return {
        "min_length": policy.get("security.password_min_length", 8),
        "require_uppercase": policy.get("security.password_require_uppercase", True),
        "require_lowercase": policy.get("security.password_require_lowercase", True),
        "require_digit": policy.get("security.password_require_digit", True),
        "require_special": policy.get("security.password_require_special", True),
    }


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginResponse:
    """用户名密码登录，返回 JWT。

    等保安全增强：
    - 登录前检查账户锁定状态（连续失败 N 次后锁定 M 分钟）
    - 密码错误时累计失败次数，达到阈值自动锁定
    - 登录成功时重置失败计数
    - 图形验证码校验（防暴力枚举）

    Args:
        body: 登录请求体（username + password + captcha_id + captcha_code）。
        db: 数据库会话。

    Returns:
        含 ``access_token`` 与用户信息的响应。

    Raises:
        HTTPException(400): 验证码错误或已过期。
        HTTPException(401): 用户名不存在或密码错误。
        HTTPException(403): 账号已禁用或已锁定。
    """
    from app.core.captcha import verify_captcha
    from app.core.security_policy import (
        get_security_policy,
        is_account_locked,
        record_login_failure,
        record_login_success,
    )

    # 1. 校验图形验证码（最先校验，防暴力枚举）
    if not verify_captcha(body.captcha_id, body.captcha_code):
        logger.warning("验证码校验失败: username=%s, captcha_id=%s", body.username, body.captcha_id)
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    logger.info("登录请求: username=%s", body.username)
    policy = get_security_policy(db)
    user = db.query(User).filter(User.username == body.username).first()
    ip = get_client_ip(request)

    if user is None:
        logger.warning("登录失败，用户不存在: %s", body.username)
        # 审计：用户不存在（等保要求记录登录失败）
        log_audit(db, username=body.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "user_not_found"})
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not user.is_active:
        logger.warning("登录失败，账号已禁用: %s", body.username)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "account_disabled"})
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")

    # 用户级登录方式校验：如果用户配置了 allowed_login_methods，校验是否允许密码登录
    allowed = getattr(user, "allowed_login_methods", None)
    if allowed and isinstance(allowed, list) and "password" not in allowed:
        logger.warning("登录失败，用户未授权密码登录: %s, allowed=%s", body.username, allowed)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "password_not_allowed", "allowed": allowed})
        raise HTTPException(
            status_code=403,
            detail="该账号不允许使用密码登录，请使用其他登录方式",
        )

    # 检查账户锁定状态
    locked, remaining = is_account_locked(user, policy)
    if locked:
        logger.warning("登录失败，账户已锁定: %s, 剩余 %ds", body.username, remaining)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "account_locked", "remaining_seconds": remaining})
        raise HTTPException(
            status_code=403,
            detail=_lock_message(remaining),
        )

    if not verify_password(body.password, user.password_hash):
        logger.warning("登录失败，密码错误: %s", body.username)
        result = record_login_failure(user, db, policy)
        log_audit(db, user_id=user.id, username=user.username, action="login",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "wrong_password",
                          "remaining_attempts": result.get("remaining_attempts")})
        if result["locked"]:
            raise HTTPException(
                status_code=403,
                detail=_lockout_triggered_message(policy, "密码错误次数过多"),
            )
        raise HTTPException(
            status_code=401,
            detail=f"用户名或密码错误（剩余尝试次数：{result['remaining_attempts']}）",
        )

    # 登录成功：重置失败计数
    record_login_success(user, db)
    user.last_login_at = beijing_now()
    db.commit()

    # 记录审计日志（含客户端 IP，便于追溯登录来源）
    log_audit(db, user_id=user.id, username=user.username, action="login",
              resource_type="auth", ip_address=ip, result="success")

    # OTP 两步验证：用户已启用 OTP 时，不直接签发 access_token，
    # 而是返回短期 otp_pending_token，前端需用此 token + OTP 动态码调用第二步
    if getattr(user, "otp_enabled", False) and getattr(user, "otp_secret", None):
        from app.core.security import create_otp_pending_token
        pending_token = create_otp_pending_token(user.id, user.username)
        logger.info("密码验证通过，等待 OTP 二次验证: username=%s", user.username)
        return LoginResponse(
            requires_otp=True,
            otp_pending_token=pending_token,
        )

    # 签发 JWT 并创建会话（Redis 跟踪设备/IP/登录时间）
    token, jti, sid = create_access_token(user.id, user.username, user.role)
    device_info = {"user_agent": request.headers.get("user-agent", "")[:200]}
    create_session(
        user_id=user.id,
        jti=jti,
        sid=sid,
        device_info=device_info,
        ip_address=ip,
        ttl_seconds=settings.JWT_EXPIRE_MINUTES * 60,
    )
    logger.info("登录成功: username=%s, role=%s, jti=%s", user.username, user.role, jti)
    return LoginResponse(access_token=token, token_type="bearer", user=_user_info(db, user))


@router.get("/me", response_model=UserInfo)
def get_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UserInfo:
    """获取当前登录用户信息（用于前端鉴权后回显与角色判断）。

    返回的 ``permissions`` 字段为当前用户的权限矩阵，前端据此驱动菜单/按钮显隐，
    无需在前端硬编码默认角色权限。
    """
    return _user_info(db, user)


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """修改当前用户密码（含等保密码复杂度校验）。

    安全增强：修改密码后撤销当前用户在其他设备上的所有会话（保留当前会话），
    其他设备上的 token 立即失效，需重新登录。

    Args:
        body: 含原密码与新密码。
        user: 当前登录用户（依赖注入）。
        authorization: Authorization 头（用于解析当前会话 ID，排除当前会话）。
        db: 数据库会话。

    Returns:
        ``{"ok": True}``。

    Raises:
        HTTPException(400): 原密码错误、新密码与原密码相同、或密码复杂度不满足要求。
    """
    from app.core.security_policy import (
        get_security_policy,
        validate_password_complexity,
    )
    from app.core.session import revoke_all_sessions

    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    if body.old_password == body.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与原密码相同")

    # 等保密码复杂度校验
    policy = get_security_policy(db)
    errors = validate_password_complexity(body.new_password, policy)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))

    user.password_hash = hash_password(body.new_password)
    # 改密成功后清除首次登录强制改密标记
    user.must_change_password = False
    db.commit()

    # 修改密码后撤销其他设备的会话（保留当前会话）
    _, current_sid = _extract_token_meta(authorization)
    revoked = revoke_all_sessions(user.id, except_sid=current_sid)
    if revoked > 0:
        logger.info("修改密码后撤销 %d 个其他会话: username=%s", revoked, user.username)

    logger.info("用户修改密码成功: username=%s", user.username)
    return {"ok": True}


@router.put("/profile", response_model=UserInfo)
def update_profile(
    body: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserInfo:
    """用户自助修改个人资料（display_name / email / phone / department / language / timezone / bio）。

    Args:
        body: 含待更新字段（未提供则不动）。
        user: 当前登录用户（依赖注入）。
        db: 数据库会话。

    Returns:
        更新后的脱敏用户信息。
    """
    if body.display_name is not None:
        if len(body.display_name) > 128:
            raise HTTPException(status_code=400, detail="显示名长度不能超过 128 个字符")
        user.display_name = body.display_name.strip() or None
    if body.email is not None:
        email = body.email.strip()
        if email and "@" not in email:
            raise HTTPException(status_code=400, detail="邮箱格式不正确")
        user.email = email or None
    if body.phone is not None:
        user.phone = body.phone.strip() or None
    if body.department is not None:
        user.department = body.department.strip() or None
    if body.language is not None:
        user.language = body.language.strip() or "zh-CN"
    if body.timezone is not None:
        user.timezone = body.timezone.strip() or "Asia/Shanghai"
    if body.bio is not None:
        user.bio = body.bio.strip() or None
    if body.avatar is not None:
        # 头像可以是 data URL 或文件路径，限制大小 2MB
        if len(body.avatar) > 2 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="头像数据过大，请上传小于 2MB 的图片")
        user.avatar = body.avatar or None
    db.commit()
    db.refresh(user)
    logger.info("用户更新个人资料成功: username=%s", user.username)
    return _user_info(db, user)


# ============ 会话管理（登出 / 刷新 / 设备列表） ============


@router.post("/logout")
def logout(
    request: Request,
    user: User = Depends(get_current_user),
    authorization: Optional[str] = Header(None),
) -> dict:
    """登出当前会话：将当前 token 的 jti 加入黑名单 + 删除会话记录。

    登出后该 token 立即失效，即使未过期也无法再使用（``get_current_user`` 会校验黑名单）。
    """
    from app.core.session import revoke_session
    # 从 Authorization 头解析当前 token 的 jti/sid
    jti, sid = _extract_token_meta(authorization)
    ttl = _get_token_ttl(authorization)
    if sid:
        revoke_session(user.id, sid, jti=jti, ttl_seconds=ttl)
    ip = get_client_ip(request)
    log_audit(None, user_id=user.id, username=user.username, action="logout",
              resource_type="auth", ip_address=ip, result="success")
    logger.info("用户登出: username=%s, jti=%s", user.username, jti)
    return {"ok": True}


@router.post("/refresh", response_model=LoginResponse)
def refresh_token(
    request: Request,
    user: User = Depends(get_current_user),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> LoginResponse:
    """刷新令牌（滑动会话）：拉黑旧 token + 签发新 token，保持会话连续性。

    前端在 token 接近过期前调用此接口换取新 token，避免用户频繁重新登录。
    新 token 的 ``sid`` 与旧 token 相同（同一会话），``jti`` 不同（新令牌）。
    """
    from app.core.session import revoke_session
    old_jti, old_sid = _extract_token_meta(authorization)
    old_ttl = _get_token_ttl(authorization)
    # 拉黑旧 token + 删除旧会话记录
    if old_sid:
        revoke_session(user.id, old_sid, jti=old_jti, ttl_seconds=old_ttl)
    # 签发新 token（保持 sid 不变 → 会话连续性）
    token, new_jti, sid = create_access_token(
        user.id, user.username, user.role, session_id=old_sid
    )
    # 创建新会话记录
    ip = get_client_ip(request)
    create_session(
        user_id=user.id,
        jti=new_jti,
        sid=sid,
        device_info={"user_agent": request.headers.get("user-agent", "")[:200]},
        ip_address=ip,
        ttl_seconds=settings.JWT_EXPIRE_MINUTES * 60,
    )
    logger.info("令牌刷新: username=%s, old_jti=%s, new_jti=%s", user.username, old_jti, new_jti)
    return LoginResponse(access_token=token, token_type="bearer", user=_user_info(db, user))


class SessionInfo(BaseModel):
    """会话信息（登录设备）。"""

    sid: str = Field(..., description="会话 ID")
    jti: str = Field(..., description="令牌唯一标识")
    ip: str = Field(..., description="登录 IP")
    login_at: str = Field(..., description="登录时间（UTC ISO）")
    device: dict = Field(default_factory=dict, description="设备信息（User-Agent 等）")
    ttl_seconds: int = Field(..., description="剩余有效期（秒）")


@router.get("/sessions", response_model=list[SessionInfo])
def get_sessions(user: User = Depends(get_current_user)) -> list[SessionInfo]:
    """列出当前用户所有活跃会话（登录设备管理）。

    用于「登录设备管理」页面，展示用户在哪些设备/IP 上登录了系统，
    可据此发现异常登录（如陌生 IP / 凌晨登录）。
    """
    sessions = list_sessions(user.id)
    return [
        SessionInfo(
            sid=s.get("sid", ""),
            jti=s.get("jti", ""),
            ip=s.get("ip", "unknown"),
            login_at=s.get("login_at", ""),
            device=s.get("device", {}),
            ttl_seconds=s.get("ttl_seconds", 0),
        )
        for s in sessions
    ]


@router.delete("/sessions/{session_id}")
def revoke_session_endpoint(
    session_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> dict:
    """撤销指定会话（强制下线某设备）。

    撤销后该设备上的 token 立即失效。不能撤销当前会话（用 /auth/logout）。
    """
    from app.core.session import list_sessions, revoke_session
    # 查找会话获取 jti
    sessions = list_sessions(user.id)
    target = next((s for s in sessions if s.get("sid") == session_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="会话不存在或已过期")
    jti = target.get("jti", "")
    ttl = target.get("ttl_seconds", 3600)
    revoke_session(user.id, session_id, jti=jti, ttl_seconds=ttl)
    ip = get_client_ip(request)
    log_audit(None, user_id=user.id, username=user.username, action="delete",
              resource_type="session", resource_id=session_id,
              ip_address=ip, result="success",
              detail={"revoked_jti": jti, "revoked_ip": target.get("ip")})
    logger.info("撤销会话: username=%s, sid=%s, jti=%s", user.username, session_id, jti)
    return {"ok": True}


# ============ OTP 二步验证登录 ============


@router.post("/login/otp", response_model=LoginResponse)
def login_with_otp(
    body: OtpLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> LoginResponse:
    """OTP 二步验证登录（密码验证通过后的第二步）。

    前端在第一步密码登录收到 ``requires_otp=true`` + ``otp_pending_token`` 后，
    弹出 OTP 输入框，用户输入 6 位动态码后调用此接口完成登录。

    Args:
        body: 含 otp_pending_token + otp_code。
        db: 数据库会话。

    Returns:
        含 ``access_token`` 与用户信息的响应。

    Raises:
        HTTPException(400): OTP 验证码错误。
        HTTPException(401): 临时 token 无效或已过期。
    """
    from app.core.security import verify_otp_pending_token
    from app.core.otp import verify_otp_code

    payload = verify_otp_pending_token(body.otp_pending_token)
    if not payload:
        raise HTTPException(status_code=401, detail="登录会话已过期，请重新登录")

    user_id = payload.get("sub")
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="登录会话无效")

    user = db.query(User).filter(User.id == uid).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="用户不存在或已禁用")

    if not getattr(user, "otp_enabled", False):
        raise HTTPException(status_code=400, detail="该用户未启用 OTP 验证")

    if not verify_otp_code(user.otp_secret, body.otp_code.strip()):
        ip = get_client_ip(request)
        log_audit(db, user_id=user.id, username=user.username, action="login_otp",
                  resource_type="auth", ip_address=ip, result="failed",
                  detail={"reason": "wrong_otp_code"})
        raise HTTPException(status_code=400, detail="动态验证码错误")

    # OTP 验证通过，签发正式 access_token
    ip = get_client_ip(request)
    token, jti, sid = create_access_token(user.id, user.username, user.role)
    device_info = {"user_agent": request.headers.get("user-agent", "")[:200]}
    create_session(
        user_id=user.id,
        jti=jti,
        sid=sid,
        device_info=device_info,
        ip_address=ip,
        ttl_seconds=settings.JWT_EXPIRE_MINUTES * 60,
    )
    log_audit(db, user_id=user.id, username=user.username, action="login_otp",
              resource_type="auth", ip_address=ip, result="success")
    logger.info("OTP 验证通过，登录成功: username=%s, jti=%s", user.username, jti)
    return LoginResponse(access_token=token, token_type="bearer", user=_user_info(db, user))


# ============ OTP 管理（绑定 / 启用 / 解绑） ============


class OtpSetupResponse(BaseModel):
    """OTP 绑定初始化响应。"""

    secret: str = Field(..., description="TOTP 密钥（base32，仅本次返回用于手动输入）")
    qr_code: str = Field(..., description="二维码 data URL（base64 PNG），扫码导入 Authenticator")
    otpauth_uri: str = Field(..., description="otpauth:// URI")


@router.post("/otp/setup", response_model=OtpSetupResponse)
def otp_setup(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OtpSetupResponse:
    """生成 OTP 密钥并返回二维码（用户绑定 Authenticator 第一步）。

    生成的密钥会暂存到 ``user.otp_secret`` 但 ``otp_enabled`` 仍为 False，
    需调用 ``POST /auth/otp/enable`` 验证一次动态码后才正式启用。
    """
    from app.core.otp import (
        generate_otp_secret,
        encrypt_otp_secret,
        build_otpauth_uri,
        generate_qr_code_base64,
    )

    # 已启用 OTP 的用户不可重复绑定（需先解绑）
    if getattr(user, "otp_enabled", False):
        raise HTTPException(status_code=400, detail="已绑定 OTP，请先解绑后再重新绑定")

    secret = generate_otp_secret()
    user.otp_secret = encrypt_otp_secret(secret)
    db.commit()

    uri = build_otpauth_uri(user.username, secret)
    qr = generate_qr_code_base64(uri)
    logger.info("用户发起 OTP 绑定: username=%s", user.username)
    return OtpSetupResponse(secret=secret, qr_code=qr, otpauth_uri=uri)


class OtpEnableRequest(BaseModel):
    """OTP 启用请求体。"""

    code: str = Field(..., description="6 位 OTP 动态码（从 Authenticator 获取）")


@router.post("/otp/enable")
def otp_enable(
    body: OtpEnableRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """验证 OTP 动态码并正式启用二步验证。

    用户扫码后从 Authenticator 获取 6 位动态码，调用此接口验证。
    验证通过后 ``otp_enabled`` 设为 True，后续登录需进行 OTP 二次验证。
    """
    from app.core.otp import verify_otp_code

    if getattr(user, "otp_enabled", False):
        raise HTTPException(status_code=400, detail="OTP 已启用")

    if not getattr(user, "otp_secret", None):
        raise HTTPException(status_code=400, detail="请先调用 /auth/otp/setup 生成密钥")

    if not verify_otp_code(user.otp_secret, body.code.strip()):
        raise HTTPException(status_code=400, detail="动态验证码错误，请重试")

    user.otp_enabled = True
    db.commit()
    log_audit(db, user_id=user.id, username=user.username, action="otp_enable",
              resource_type="auth", result="success")
    logger.info("用户启用 OTP 二步验证: username=%s", user.username)
    return {"ok": True, "message": "OTP 二步验证已启用"}


class OtpDisableRequest(BaseModel):
    """OTP 解绑请求体。"""

    code: str = Field(..., description="6 位 OTP 动态码（安全验证，防止他人解绑）")


@router.post("/otp/disable")
def otp_disable(
    body: OtpDisableRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """解绑 OTP（需验证当前动态码，防止他人操作）。

    解绑后 ``otp_enabled`` 设为 False，``otp_secret`` 清空，后续登录不再需要 OTP。
    """
    from app.core.otp import verify_otp_code

    if not getattr(user, "otp_enabled", False):
        raise HTTPException(status_code=400, detail="OTP 未启用")

    if not verify_otp_code(user.otp_secret, body.code.strip()):
        raise HTTPException(status_code=400, detail="动态验证码错误，无法解绑")

    user.otp_enabled = False
    user.otp_secret = None
    db.commit()
    log_audit(db, user_id=user.id, username=user.username, action="otp_disable",
              resource_type="auth", result="success")
    logger.info("用户解绑 OTP: username=%s", user.username)
    return {"ok": True, "message": "OTP 二步验证已解绑"}


# ============ SSO 单点登录 ============


@router.get("/sso/authorize")
def sso_authorize(
    request: Request,
    redirect: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """获取 SSO 授权跳转 URL（前端跳转到此 URL 进行第三方认证）。

    前端在登录页点击「SSO 登录」后调用此接口获取跳转地址，
    然后用 ``window.location.href = url`` 跳转到 SSO 提供商。

    SSO 配置从系统配置 ``security.sso_*`` 读取，需在系统设置中开启 SSO。
    """
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    sso_enabled = policy.get("security.sso_enabled", False)
    if not sso_enabled:
        raise HTTPException(status_code=400, detail="SSO 登录未开启，请联系管理员")

    provider = policy.get("security.sso_provider", "")
    sso_config_raw = policy.get("security.sso_config", "")

    if not provider:
        raise HTTPException(status_code=400, detail="未配置 SSO 提供商")

    # 解析 SSO 配置（JSON）
    import json
    try:
        sso_config = json.loads(sso_config_raw) if sso_config_raw else {}
    except Exception:
        raise HTTPException(status_code=500, detail="SSO 配置格式错误")

    # 构造回调 URL
    base_url = str(request.base_url).rstrip("/")
    callback_url = f"{base_url}/api/v1/auth/sso/callback"
    if redirect:
        callback_url += f"?redirect={redirect}"

    # 根据提供商类型构造授权 URL
    client_id = sso_config.get("client_id", "")
    authorize_url = sso_config.get("authorize_url", "")
    scope = sso_config.get("scope", "openid profile email")
    state = secrets.token_urlsafe(16)
    # state 存入 Redis（10 分钟有效），callback 校验并一次性消费（防 CSRF/重放）
    try:
        get_redis().setex(
            f"sso_state:{state}",
            600,
            json.dumps({"provider": provider, "redirect": redirect or ""}),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("SSO state 存储失败（Redis 不可用，callback 将降级放行）: %s", exc)

    if provider in ("oidc", "keycloak", "authentik", "google"):
        if not authorize_url or not client_id:
            raise HTTPException(status_code=500, detail="SSO 配置不完整（缺少 authorize_url 或 client_id）")
        auth_url = (
            f"{authorize_url}"
            f"?response_type=code"
            f"&client_id={client_id}"
            f"&redirect_uri={callback_url}"
            f"&scope={scope}"
            f"&state={state}"
        )
    elif provider == "ldap":
        # LDAP 不走 OAuth 跳转，而是直接在登录页输入域账号
        auth_url = f"{base_url}/login?method=ldap"
    else:
        # 通用 OAuth2 授权码流程
        if not authorize_url or not client_id:
            raise HTTPException(status_code=500, detail="SSO 配置不完整")
        auth_url = (
            f"{authorize_url}"
            f"?response_type=code"
            f"&client_id={client_id}"
            f"&redirect_uri={callback_url}"
            f"&scope={scope}"
            f"&state={state}"
        )

    logger.info("SSO 授权跳转: provider=%s, state=%s", provider, state)
    return {"authorize_url": auth_url, "provider": provider}


@router.get("/sso/callback")
def sso_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    redirect: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """SSO 回调处理：用授权码换取令牌，获取用户信息，匹配本地账号后签发 JWT。

    第三方认证完成后会跳转回此接口，携带 ``code`` 和 ``state``。
    后端用 code 换取 access_token，再获取用户信息（如 sub/email），
    在本地 users 表中通过 ``sso_subject`` 匹配账号。
    """
    import httpx
    import json
    from app.core.security_policy import get_security_policy

    if not code:
        raise HTTPException(status_code=400, detail="缺少授权码")

    # state CSRF 校验：authorize 生成的 state 存于 Redis（10 分钟有效），
    # 此处必须命中且一次性删除，防止授权码回调被伪造/重放
    if not state:
        raise HTTPException(status_code=400, detail="SSO state 校验失败，请重新发起登录")
    state_data: dict = {}
    try:
        state_key = f"sso_state:{state}"
        state_raw = get_redis().get(state_key)
        if not state_raw:
            raise HTTPException(status_code=400, detail="SSO state 校验失败，请重新发起登录")
        # 一次性消费，防止重放
        get_redis().delete(state_key)
        try:
            parsed_state = json.loads(state_raw)
            if isinstance(parsed_state, dict):
                state_data = parsed_state
        except (ValueError, TypeError):
            state_data = {}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # Redis 不可用时降级放行（可用性优先，与会话/黑名单模块的降级策略一致）
        logger.warning("SSO state 校验失败（Redis 不可用，降级放行）: %s", exc)

    policy = get_security_policy(db)
    provider = policy.get("security.sso_provider", "")
    # state 中记录的提供商必须与当前系统配置一致
    if state_data.get("provider") and provider and state_data["provider"] != provider:
        raise HTTPException(status_code=400, detail="SSO state 校验失败，请重新发起登录")
    sso_config_raw = policy.get("security.sso_config", "")
    try:
        sso_config = json.loads(sso_config_raw) if sso_config_raw else {}
    except Exception:
        raise HTTPException(status_code=500, detail="SSO 配置格式错误")

    token_url = sso_config.get("token_url", "")
    userinfo_url = sso_config.get("userinfo_url", "")
    client_id = sso_config.get("client_id", "")
    client_secret = sso_config.get("client_secret", "")
    base_url = str(request.base_url).rstrip("/")
    callback_url = f"{base_url}/api/v1/auth/sso/callback"

    # 用授权码换取 access_token
    try:
        with httpx.Client(timeout=10) as client:
            token_resp = client.post(token_url, data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": callback_url,
                "client_id": client_id,
                "client_secret": client_secret,
            })
            token_data = token_resp.json()
            access_token_sso = token_data.get("access_token")
            if not access_token_sso:
                logger.warning("SSO 换取令牌失败: %s", token_data)
                raise HTTPException(status_code=400, detail="SSO 认证失败：无法获取令牌")

            # 获取用户信息
            user_resp = client.get(
                userinfo_url,
                headers={"Authorization": f"Bearer {access_token_sso}"},
            )
            user_info = user_resp.json()
    except httpx.HTTPError as exc:
        logger.warning("SSO 网络请求失败: %s", exc)
        raise HTTPException(status_code=500, detail="SSO 服务暂时不可用")

    # 提取 SSO 用户唯一标识（OIDC 用 sub，其他可用 email）
    sso_subject = user_info.get("sub") or user_info.get("id") or ""
    sso_email = user_info.get("email", "")

    if not sso_subject and sso_email:
        sso_subject = sso_email

    if not sso_subject:
        raise HTTPException(status_code=400, detail="SSO 认证失败：无法获取用户标识")

    # 在本地匹配用户（通过 sso_subject 或 email）
    user = db.query(User).filter(User.sso_subject == sso_subject).first()
    if not user and sso_email:
        user = db.query(User).filter(User.email == sso_email).first()
        if user:
            # 首次 SSO 登录，关联 sso_subject
            user.sso_subject = sso_subject
            db.commit()

    if not user:
        raise HTTPException(
            status_code=403,
            detail="SSO 账号未关联本地用户，请联系管理员创建账号并绑定",
        )

    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被禁用")

    # 用户级登录方式校验
    allowed = getattr(user, "allowed_login_methods", None)
    if allowed and isinstance(allowed, list) and "sso" not in allowed:
        raise HTTPException(status_code=403, detail="该账号不允许使用 SSO 登录")

    # 签发 JWT
    ip = get_client_ip(request)
    token, jti, sid = create_access_token(user.id, user.username, user.role)
    create_session(
        user_id=user.id,
        jti=jti,
        sid=sid,
        device_info={"user_agent": request.headers.get("user-agent", "")[:200], "sso": True},
        ip_address=ip,
        ttl_seconds=settings.JWT_EXPIRE_MINUTES * 60,
    )
    user.last_login_at = beijing_now()
    db.commit()
    log_audit(db, user_id=user.id, username=user.username, action="login_sso",
              resource_type="auth", ip_address=ip, result="success",
              detail={"provider": provider, "sso_subject": sso_subject})
    logger.info("SSO 登录成功: username=%s, provider=%s", user.username, provider)

    # 重定向到前端并带上 token（前端从 URL 参数获取）
    frontend_url = redirect or f"{base_url}/login"
    sep = "&" if "?" in frontend_url else "?"
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": _user_info(db, user),
        "redirect_url": f"{frontend_url}{sep}sso_token={token}",
    }


# ============ 辅助函数 ============


def _extract_token_meta(authorization: Optional[str]) -> tuple[str, str]:
    """从 Authorization 头解析 token 的 (jti, sid)。

    解析失败返回 ("", "")。
    """
    if not authorization:
        return "", ""
    parts = authorization.split(" ", 1)
    token = parts[1].strip() if len(parts) == 2 and parts[0].lower() == "bearer" else authorization.strip()
    payload = decode_access_token(token)
    if not payload:
        return "", ""
    return payload.get("jti", ""), payload.get("sid", "")


def _get_token_ttl(authorization: Optional[str]) -> int:
    """从 Authorization 头解析 token 的剩余有效期（秒）。"""
    if not authorization:
        return 0
    parts = authorization.split(" ", 1)
    token = parts[1].strip() if len(parts) == 2 and parts[0].lower() == "bearer" else authorization.strip()
    payload = decode_access_token(token)
    if not payload:
        return 0
    return get_token_ttl_seconds(payload)
