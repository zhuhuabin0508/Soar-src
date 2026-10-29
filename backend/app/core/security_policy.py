"""等保安全策略模块。

提供可配置的安全策略（通过 SystemConfig 键值对存储）：
- Session 超时：JWT token 有效期（分钟）
- 账户锁定：连续 N 次密码错误后冻结 M 分钟
- 密码复杂度：最小长度、大小写/数字/特殊字符要求

策略读取流程：
1. 从 SystemConfig 表读取 ``security.*`` 前缀的配置项
2. 未配置时使用 DEFAULT_SECURITY_POLICY 默认值
"""
import logging
import re
from datetime import datetime, timedelta
from app.core.timezone import beijing_now, beijing_now_iso
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# 等保基础版默认安全策略
DEFAULT_SECURITY_POLICY: dict[str, Any] = {
    # Session 超时（分钟），默认 8 小时 = 480 分钟
    "security.session_timeout_minutes": 480,
    # 账户锁定：连续登录失败次数阈值
    "security.max_login_attempts": 5,
    # 账户锁定时长（分钟）
    "security.lockout_duration_minutes": 15,
    # 密码最小长度
    "security.password_min_length": 8,
    # 密码必须包含大写字母
    "security.password_require_uppercase": True,
    # 密码必须包含小写字母
    "security.password_require_lowercase": True,
    # 密码必须包含数字
    "security.password_require_digit": True,
    # 密码必须包含特殊字符
    "security.password_require_special": True,
    # 密码有效期（天），0 表示不过期
    "security.password_expiry_days": 0,
    # 历史密码不能重复次数（0 表示不检查）
    "security.password_history_count": 3,
    # 锁定后是否自动解锁（False 表示需人工解锁）
    "security.lockout_auto_unlock": True,
    # 登录二次验证（MFA）：管理员是否强制开启 OTP
    "security.mfa_enabled": False,
    # 登录 IP 白名单（逗号分隔，空表示不限制）
    "security.login_ip_whitelist": "",
    # 异常登录通知
    "security.login_notification": True,
    # 审计日志保留时长（天）
    "security.audit_log_retention_days": 90,
    # 敏感操作二次确认（删除/重置/导出等）
    "security.sensitive_op_confirm": True,
    # 单点登录（SSO）开关
    "security.sso_enabled": False,
    # SSO 提供商类型：LDAP / OIDC / 空
    "security.sso_provider": "",
    # SSO 配置（JSON 字符串：server_url / client_id / client_secret 等）
    "security.sso_config": "",
    # 启用的登录方式（JSON 数组字符串，如 '["password", "otp", "sso"]'，默认全启用）
    "security.login_methods": '["password", "otp", "sso"]',
    # SSO 提供商列表（JSON 数组字符串，元素如 {"id": "wecom", "name": "企业微信"}；
    # 为空时回退到 security.sso_provider 单提供商配置）
    "security.sso_providers": "",
}

# 类型映射：用于从 SystemConfig 读取的字符串值转换为正确类型
_BOOL_KEYS = {
    "security.password_require_uppercase",
    "security.password_require_lowercase",
    "security.password_require_digit",
    "security.password_require_special",
    "security.lockout_auto_unlock",
    "security.mfa_enabled",
    "security.login_notification",
    "security.sensitive_op_confirm",
    "security.sso_enabled",
}
_INT_KEYS = {
    "security.session_timeout_minutes",
    "security.max_login_attempts",
    "security.lockout_duration_minutes",
    "security.password_min_length",
    "security.password_expiry_days",
    "security.password_history_count",
    "security.audit_log_retention_days",
}


def _coerce_value(key: str, raw: str) -> Any:
    """将 SystemConfig 中的字符串值转换为正确类型。"""
    if key in _BOOL_KEYS:
        return str(raw).strip().lower() in ("true", "1", "yes", "on")
    if key in _INT_KEYS:
        try:
            return int(raw)
        except (ValueError, TypeError):
            return DEFAULT_SECURITY_POLICY.get(key, 0)
    return raw


def get_security_policy(db: Session) -> dict[str, Any]:
    """从 SystemConfig 读取安全策略，未配置的用默认值填充。

    Returns:
        完整的安全策略字典（所有键均为正确类型）。
    """
    from app.models.system_config import SystemConfig

    # 从数据库读取所有 security.* 前缀的配置
    db_configs = (
        db.query(SystemConfig)
        .filter(SystemConfig.key.like("security.%"))
        .all()
    )
    db_map = {c.key: c.value for c in db_configs}

    # 合并默认值与数据库值
    policy = {}
    for key, default_val in DEFAULT_SECURITY_POLICY.items():
        if key in db_map:
            policy[key] = _coerce_value(key, db_map[key])
        else:
            policy[key] = default_val
    return policy


def is_account_locked(user, policy: dict[str, Any]) -> tuple[bool, int]:
    """检查用户是否被锁定。

    Returns:
        ``(locked, remaining_seconds)``：locked=True 时 remaining_seconds 为剩余锁定秒数；
        ``remaining_seconds < 0`` 表示策略为「需人工解锁」模式，须管理员
        （``POST /users/{user_id}/unlock``）解除锁定。
    """
    if not user.locked_until:
        return False, 0
    # 需人工解锁模式：锁定后不随时间自动放行，仅管理员可解锁
    if not policy.get("security.lockout_auto_unlock", True):
        return True, -1
    now = beijing_now()
    if now < user.locked_until:
        remaining = int((user.locked_until - now).total_seconds())
        return True, remaining
    # 锁定已过期，重置
    return False, 0


def record_login_failure(user, db: Session, policy: dict[str, Any]) -> dict[str, Any]:
    """记录一次登录失败，达到阈值时锁定账户。

    Returns:
        ``{"locked": bool, "remaining_attempts": int, "lockout_seconds": int}``
    """
    max_attempts = policy.get("security.max_login_attempts", 5)
    lockout_minutes = policy.get("security.lockout_duration_minutes", 15)

    user.failed_login_count = (user.failed_login_count or 0) + 1
    remaining = max(0, max_attempts - user.failed_login_count)

    if user.failed_login_count >= max_attempts:
        user.locked_until = beijing_now() + timedelta(minutes=lockout_minutes)
        logger.warning(
            "账户已锁定: username=%s, failed_count=%d, lockout_minutes=%d",
            user.username, user.failed_login_count, lockout_minutes,
        )
        db.commit()
        return {
            "locked": True,
            "remaining_attempts": 0,
            "lockout_seconds": lockout_minutes * 60,
        }

    db.commit()
    return {
        "locked": False,
        "remaining_attempts": remaining,
        "lockout_seconds": 0,
    }


def record_login_success(user, db: Session) -> None:
    """登录成功时重置失败计数与锁定状态。"""
    if user.failed_login_count or user.locked_until:
        user.failed_login_count = 0
        user.locked_until = None
        db.commit()


def validate_password_complexity(
    password: str, policy: dict[str, Any]
) -> list[str]:
    """校验密码复杂度，返回错误消息列表（空列表表示通过）。

    校验规则：
    - 最小长度
    - 必须包含大写字母（如启用）
    - 必须包含小写字母（如启用）
    - 必须包含数字（如启用）
    - 必须包含特殊字符（如启用）
    """
    errors: list[str] = []
    min_len = policy.get("security.password_min_length", 8)
    if len(password) < min_len:
        errors.append(f"密码长度不能少于 {min_len} 位")

    if policy.get("security.password_require_uppercase") and not re.search(r"[A-Z]", password):
        errors.append("密码必须包含大写字母")
    if policy.get("security.password_require_lowercase") and not re.search(r"[a-z]", password):
        errors.append("密码必须包含小写字母")
    if policy.get("security.password_require_digit") and not re.search(r"\d", password):
        errors.append("密码必须包含数字")
    if policy.get("security.password_require_special") and not re.search(r'[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/\\|`~]', password):
        errors.append("密码必须包含特殊字符")

    return errors
