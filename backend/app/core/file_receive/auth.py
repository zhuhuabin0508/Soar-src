"""来源认证：Access Key + HMAC-SHA256 + 时间戳 + Nonce + IP 白名单。"""
import hashlib
import hmac
import ipaddress
import json
import logging
import threading
import time
import uuid
from datetime import timedelta
from urllib.parse import urlencode

from fastapi import Request
from sqlalchemy.orm import Session

from app.core.file_receive.errors import FileReceiveError
from app.core.file_receive.limiter import check_qps
from app.core.security import decrypt_device_secret
from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

_FAIL_LIMIT = 10
_FAIL_LOCK_SECONDS = 600
_TS_WINDOW_MS = 5 * 60 * 1000

_nonce_cache: dict[str, float] = {}
_nonce_lock = threading.Lock()


def canonical_path(request: Request) -> str:
    """签名路径：path + 按参数名排序的查询串。"""
    path = request.url.path
    items = sorted(request.query_params.multi_items(), key=lambda x: (x[0], x[1]))
    if items:
        path = f"{path}?{urlencode(items)}"
    return path


def _header(request: Request, name: str) -> str:
    return (request.headers.get(name) or "").strip()


def _redis():
    from app.core.redis_client import get_redis

    return get_redis()


def _is_locked(access_key: str) -> bool:
    try:
        value = _redis().get(f"fr:fail:{access_key}")
        return value is not None and int(value) >= _FAIL_LIMIT
    except Exception:  # noqa: BLE001
        return False


def _record_failure(access_key: str) -> None:
    try:
        r = _redis()
        key = f"fr:fail:{access_key}"
        count = r.incr(key)
        if int(count) == 1:
            r.expire(key, _FAIL_LOCK_SECONDS)
        if int(count) == _FAIL_LIMIT:
            logger.warning("文件接收来源密钥连续失败达到阈值，临时锁定: ak=%s", access_key)
    except Exception:  # noqa: BLE001
        pass


def _clear_failures(access_key: str) -> None:
    try:
        _redis().delete(f"fr:fail:{access_key}")
    except Exception:  # noqa: BLE001
        pass


def _check_nonce(access_key: str, nonce: str) -> None:
    key = f"fr:nonce:{access_key}:{nonce}"
    try:
        ok = _redis().set(key, "1", nx=True, ex=600)
        if not ok:
            raise FileReceiveError("FR-SIGN-004", 401, "Nonce 已被使用，疑似重放请求")
        return
    except FileReceiveError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件接收 Nonce 检查 Redis 不可用，降级进程内缓存: %s", exc)
    now = time.time()
    with _nonce_lock:
        # 低频清理过期项
        if len(_nonce_cache) > 10000:
            expired = [k for k, exp in _nonce_cache.items() if exp <= now]
            for k in expired:
                _nonce_cache.pop(k, None)
        if key in _nonce_cache and _nonce_cache[key] > now:
            raise FileReceiveError("FR-SIGN-004", 401, "Nonce 已被使用，疑似重放请求")
        _nonce_cache[key] = now + 600


def _client_ip(request: Request) -> str:
    return (request.client.host if request.client else "") or ""


def _check_ip(source, client_ip: str) -> None:
    try:
        allowed = source.allowed_ips or []
        if isinstance(allowed, str):
            allowed = json.loads(allowed)
    except (TypeError, ValueError):
        allowed = []
    if not allowed:
        return
    try:
        ip = ipaddress.ip_address(client_ip)
    except ValueError:
        raise FileReceiveError("FR-AUTH-004", 403, "客户端 IP 不在来源白名单内")
    for item in allowed:
        try:
            if ip in ipaddress.ip_network(str(item), strict=False):
                return
        except ValueError:
            continue
    raise FileReceiveError("FR-AUTH-004", 403, "客户端 IP 不在来源白名单内")


def _load_source(db: Session, access_key: str):
    from app.models.file_receive import FileReceiveSource

    return db.query(FileReceiveSource).filter(FileReceiveSource.access_key == access_key).first()


def _verify_signature(
    request: Request,
    access_key: str,
    timestamp: str,
    nonce: str,
    body_sha256: str,
    source,
) -> bool:
    canonical = "\n".join(
        [request.method.upper(), canonical_path(request), access_key, timestamp, nonce, body_sha256]
    )
    signature = _header(request, "X-Signature").lower()
    if not signature:
        raise FileReceiveError("FR-SIGN-001", 401, "缺少签名头 X-Signature")
    candidates = [source.secret_enc]
    # 旧密钥仅在轮换后 24 小时内有效，避免长期保留双密钥
    if (
        source.secret_enc_prev
        and source.secret_rotated_at
        and source.secret_rotated_at + timedelta(hours=24) >= beijing_now()
    ):
        candidates.append(source.secret_enc_prev)
    for encrypted in candidates:
        secret = decrypt_device_secret(encrypted)
        if not secret:
            continue
        expected = hmac.new(
            secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if hmac.compare_digest(expected, signature):
            return True
    return False


def authenticate(
    request: Request,
    db: Session,
    body_sha256: str | None = None,
):
    """校验来源身份与签名，返回来源 ORM；失败抛 ``FileReceiveError``。

    Args:
        body_sha256: 请求体 SHA-256。JSON 请求由调用方读原始 Body 后计算；
            分片请求传 ``X-Content-SHA256``；GET 等空 Body 传空串哈希。
    """
    access_key = _header(request, "X-Access-Key")
    timestamp = _header(request, "X-Timestamp")
    nonce = _header(request, "X-Nonce")
    if not access_key:
        raise FileReceiveError("FR-AUTH-001", 401, "缺少认证头 X-Access-Key")
    if not timestamp or not nonce:
        raise FileReceiveError("FR-SIGN-001", 401, "缺少 X-Timestamp 或 X-Nonce")
    if _is_locked(access_key):
        raise FileReceiveError(
            "FR-AUTH-005", 429, "密钥连续校验失败已被临时锁定，请 10 分钟后重试",
            retryable=True, retry_after=600,
        )

    source = _load_source(db, access_key)
    if source is None:
        _record_failure(access_key)
        raise FileReceiveError("FR-AUTH-002", 401, "Access Key 无效")
    if source.status != "active":
        raise FileReceiveError("FR-AUTH-003", 403, "该来源已被停用")

    try:
        ts_ms = int(timestamp)
    except (TypeError, ValueError):
        raise FileReceiveError("FR-SIGN-003", 401, "X-Timestamp 必须是毫秒时间戳")
    if abs(int(time.time() * 1000) - ts_ms) > _TS_WINDOW_MS:
        raise FileReceiveError(
            "FR-SIGN-003", 401, "请求时间戳超出允许窗口（±5 分钟），请校准系统时间",
            retryable=True, retry_after=1,
        )

    _check_ip(source, _client_ip(request))
    _check_nonce(access_key, nonce)

    if body_sha256 is None:
        body_sha256 = hashlib.sha256(b"").hexdigest()
    body_sha256 = body_sha256.strip().lower()
    if len(body_sha256) != 64:
        raise FileReceiveError("FR-SIGN-001", 401, "Body SHA-256 格式非法")

    if not _verify_signature(request, access_key, timestamp, nonce, body_sha256, source):
        _record_failure(access_key)
        logger.warning(
            "文件接收签名校验失败: ak=%s, ip=%s, path=%s",
            access_key, _client_ip(request), request.url.path,
        )
        raise FileReceiveError("FR-SIGN-002", 401, "请求签名不匹配")
    _clear_failures(access_key)

    trace_id = uuid.uuid4().hex[:16]
    request.state.fr_source = source
    # 同时缓存原始值：请求结束后 ORM 实例可能已脱离 Session，中间件不能再访问属性
    request.state.fr_source_id = source.id
    request.state.fr_source_code = source.source_code
    request.state.fr_trace_id = trace_id
    request.state.fr_client_ip = _client_ip(request)

    check_qps(source)
    return source
