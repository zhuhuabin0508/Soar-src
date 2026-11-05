"""会话与令牌黑名单管理（基于 Redis）。

设计要点：
- JWT 在签发时注入 ``jti``（唯一标识），``sid``（会话 ID，默认等于 jti）。
- 登录时创建会话记录 ``session:{user_id}:{sid}``，含设备/IP/登录时间，TTL = token 有效期。
- 登出/刷新/强制下线时，将 ``jti`` 加入黑名单 ``blacklist:{jti}``（TTL = token 剩余有效期），
  并删除对应会话记录。``get_current_user`` 解析 token 后校验 jti 未被拉黑。
- 刷新令牌（sliding session）：旧 jti 进黑名单 + 旧会话删除，签发新 token + 新会话。
- Redis 不可用时黑名单校验失败按已吊销处理，拒绝继续使用该 token。
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)

# Redis 键前缀
_SESSION_KEY_PREFIX = "session:"      # session:{user_id}:{sid}
_BLACKLIST_KEY_PREFIX = "blacklist:"  # blacklist:{jti}

# 默认会话 TTL（秒），与 JWT 有效期对齐
_DEFAULT_SESSION_TTL = 7200  # 2 小时


def create_session(
    user_id: int,
    jti: str,
    sid: Optional[str] = None,
    device_info: Optional[dict] = None,
    ip_address: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> str:
    """登录成功后创建会话记录。

    Args:
        user_id: 用户 ID。
        jti: JWT 唯一标识。
        sid: 会话 ID（默认与 jti 相同，同一会话刷新时 sid 不变以保持会话连续性）。
        device_info: 设备信息（User-Agent / 平台 / 浏览器等）。
        ip_address: 登录 IP。
        ttl_seconds: 会话有效期（默认 2 小时）。

    Returns:
        会话 ID（sid）。
    """
    session_id = sid or jti
    ttl = ttl_seconds or _DEFAULT_SESSION_TTL
    payload = {
        "user_id": user_id,
        "jti": jti,
        "sid": session_id,
        "device": device_info or {},
        "ip": ip_address or "unknown",
        "login_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        redis_client = get_redis()
        redis_client.setex(
            f"{_SESSION_KEY_PREFIX}{user_id}:{session_id}",
            ttl,
            json.dumps(payload, ensure_ascii=False),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("创建会话记录失败（Redis 不可用，降级）: %s", exc)
    return session_id


def is_token_blacklisted(jti: str) -> bool:
    """检查 token 的 jti 是否已被拉黑（登出/刷新/强制下线）。

    Redis 不可用时视为已拉黑，避免登出和强制下线在故障期间失效。
    """
    if not jti:
        return False
    try:
        return bool(get_redis().get(f"{_BLACKLIST_KEY_PREFIX}{jti}"))
    except Exception as exc:  # noqa: BLE001
        logger.error("黑名单校验失败，拒绝放行: %s", exc)
        return True


def blacklist_token(jti: str, ttl_seconds: int) -> None:
    """将 token 的 jti 加入黑名单（登出/刷新/强制下线时调用）。

    TTL 设为 token 剩余有效期，过期后自动清理，避免黑名单无限增长。
    """
    if not jti or ttl_seconds <= 0:
        return
    try:
        get_redis().setex(f"{_BLACKLIST_KEY_PREFIX}{jti}", ttl_seconds, "1")
    except Exception as exc:  # noqa: BLE001
        logger.warning("加入黑名单失败（Redis 不可用）: %s", exc)


def revoke_session(user_id: int, sid: str, jti: Optional[str] = None, ttl_seconds: int = 0) -> bool:
    """撤销会话：删除会话记录 + 拉黑 token（强制下线/登出）。

    Args:
        user_id: 用户 ID。
        sid: 会话 ID。
        jti: JWT 唯一标识（可选，传入则同时拉黑 token）。
        ttl_seconds: 黑名单 TTL（token 剩余有效期），<=0 时不拉黑。

    Returns:
        True 表示会话存在并已删除；False 表示会话不存在或 Redis 不可用。
    """
    try:
        redis_client = get_redis()
        key = f"{_SESSION_KEY_PREFIX}{user_id}:{sid}"
        existed = redis_client.delete(key)
        if jti and ttl_seconds > 0:
            blacklist_token(jti, ttl_seconds)
        return bool(existed)
    except Exception as exc:  # noqa: BLE001
        logger.warning("撤销会话失败（Redis 不可用）: %s", exc)
        return False


def list_sessions(user_id: int) -> list[dict]:
    """列出用户所有活跃会话（用于「登录设备管理」）。

    返回按登录时间倒序排列的会话列表，每项含 sid/jti/device/ip/login_at。
    """
    try:
        redis_client = get_redis()
        pattern = f"{_SESSION_KEY_PREFIX}{user_id}:*"
        sessions = []
        for key in redis_client.scan_iter(pattern):
            raw = redis_client.get(key)
            if not raw:
                continue
            try:
                data = json.loads(raw)
                # 附带剩余 TTL（秒）
                ttl = redis_client.ttl(key)
                data["ttl_seconds"] = max(0, ttl)
                sessions.append(data)
            except (json.JSONDecodeError, TypeError):
                continue
        # 按登录时间倒序
        sessions.sort(key=lambda s: s.get("login_at", ""), reverse=True)
        return sessions
    except Exception as exc:  # noqa: BLE001
        logger.warning("列出会话失败（Redis 不可用）: %s", exc)
        return []


def revoke_all_sessions(user_id: int, except_sid: Optional[str] = None) -> int:
    """撤销用户所有会话（修改密码/重置密码时调用）。

    Args:
        user_id: 用户 ID。
        except_sid: 排除的会话 ID（通常是当前会话，避免修改密码后立即登出自己）。

    Returns:
        被撤销的会话数。
    """
    try:
        redis_client = get_redis()
        pattern = f"{_SESSION_KEY_PREFIX}{user_id}:*"
        count = 0
        for key in redis_client.scan_iter(pattern):
            if except_sid and key.endswith(f":{except_sid}"):
                continue
            raw = redis_client.get(key)
            if raw:
                try:
                    data = json.loads(raw)
                    jti = data.get("jti")
                    if jti:
                        blacklist_token(jti, data.get("ttl_seconds", 0) or 3600)
                except (json.JSONDecodeError, TypeError):
                    pass
            redis_client.delete(key)
            count += 1
        return count
    except Exception as exc:  # noqa: BLE001
        logger.warning("撤销全部会话失败（Redis 不可用）: %s", exc)
        return 0
