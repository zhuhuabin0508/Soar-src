"""开放 API 网关鉴权与调用监控。

安全设计：
- API Key 认证：请求头 ``X-API-Key: {access_key}:{secret}``；
  secret 明文不落库（仅存 SHA-256），创建/重置时一次性返回。
- 防爆破：同一 access_key 连续校验失败 10 次锁定 10 分钟（Redis 计数）。
- IP 白名单：应用配置 allowed_ips 非空时，客户端 IP 必须在名单内。
- 数据授权：应用必须被授权（open_api_scopes）对应 resource_code 才可调用。
- 独立限流：每应用 rate_limit_per_minute（Redis 固定窗口），
  Redis 不可用时降级放行（与 JWT 黑名单降级策略一致）。

监控设计：
- ``open_api_call_middleware`` 记录所有命中 ``/api/v1/open/`` 的请求
  （含 401/403/429 拒绝）到 ``open_api_call_logs``，并累加应用调用统计。
"""
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Callable

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip
from app.core.timezone import beijing_now
from app.database import get_db

logger = logging.getLogger(__name__)

# 请求头名称与格式
_API_KEY_HEADER = "X-API-Key"

# 防爆破：连续失败 N 次锁定 M 秒
_FAIL_LIMIT = 10
_FAIL_LOCK_SECONDS = 600
# Redis 键前缀
_RL_PREFIX = "open_api:rl:"          # 限流：{access_key}:{epoch分钟}
_FAIL_PREFIX = "open_api:fail:"      # 失败计数：{access_key}


# ============ 密钥生成 ============

def generate_key_pair() -> tuple[str, str, str]:
    """生成 (access_key, secret, secret_hash)。

    - access_key：``ak_`` + 32 位随机 hex，公开标识
    - secret：``sk_`` + 64 位随机 hex，仅创建/重置响应中一次性返回
    - secret_hash：secret 的 SHA-256 摘要，落库用于校验
    """
    access_key = "ak_" + secrets.token_hex(16)
    secret = "sk_" + secrets.token_hex(32)
    return access_key, secret, hash_secret(secret)


def hash_secret(secret: str) -> str:
    """计算 secret 的 SHA-256 摘要（64位hex）。

    API key 为 67 字节高熵随机值，快哈希即可满足安全要求，
    避免 bcrypt 慢哈希拖累高频校验。
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


# ============ Redis 辅助（不可用一律降级/放行，不阻断业务） ============

def _is_locked(access_key: str) -> bool:
    """查询防爆破锁定状态（Redis 不可用时视为未锁定）。"""
    try:
        from app.core.redis_client import get_redis

        fails = get_redis().get(f"{_FAIL_PREFIX}{access_key}")
        return fails is not None and int(fails) >= _FAIL_LIMIT
    except Exception:  # noqa: BLE001
        return False


def _record_failure(access_key: str) -> None:
    """记录一次校验失败（TTL 600s，失败不阻断主流程）。"""
    try:
        from app.core.redis_client import get_redis

        key = f"{_FAIL_PREFIX}{access_key}"
        r = get_redis()
        count = r.incr(key)
        if count == 1:
            r.expire(key, _FAIL_LOCK_SECONDS)
        if int(count) == _FAIL_LIMIT:
            logger.warning("开放 API 密钥连续失败达到阈值，临时锁定: ak=%s", access_key)
    except Exception:  # noqa: BLE001
        pass


def _clear_failures(access_key: str) -> None:
    """校验成功后清空失败计数。"""
    try:
        from app.core.redis_client import get_redis

        get_redis().delete(f"{_FAIL_PREFIX}{access_key}")
    except Exception:  # noqa: BLE001
        pass


def _check_rate_limit(access_key: str, limit: int) -> None:
    """Redis 固定窗口限流：超限抛 429。

    key 按「分钟窗口」滚动（open_api:rl:{ak}:{epoch//60}），每分钟独立计数；
    Redis 不可用时降级放行（与平台既有降级策略一致）。
    """
    try:
        from app.core.redis_client import get_redis

        window = int(time.time()) // 60
        key = f"{_RL_PREFIX}{access_key}:{window}"
        r = get_redis()
        count = r.incr(key)
        if count == 1:
            r.expire(key, 120)
        if int(count) > limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"调用频率超过配额（{limit} 次/分钟），请稍后重试",
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("开放 API 限流检查失败（降级放行）: %s", exc)


# ============ 鉴权依赖 ============

def parse_api_key_header(value: str) -> tuple[str, str]:
    """解析 ``{access_key}:{secret}`` 头，格式非法抛 401。"""
    if not value or ":" not in value:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API Key 格式错误，应为 X-API-Key: {access_key}:{secret}",
        )
    access_key, _, secret = value.partition(":")
    access_key = access_key.strip()
    secret = secret.strip()
    # 长度防御：防超长 Key 喷 Redis 失败计数键 / 溢出日志列
    if not access_key or not secret or len(access_key) > 128 or len(secret) > 512:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API Key 格式错误，应为 X-API-Key: {access_key}:{secret}",
        )
    return access_key, secret


def authenticate_request(
    request: Request,
    x_api_key: str,
    db: Session,
    resource_code: str = "",
):
    """开放 API 鉴权核心（路由内直接调用）。

    校验链：锁定检查 → 应用存在/启用/未过期 → secret 匹配 → IP 白名单 →
    scope 授权（resource_code 非空时）→ 限流。
    通过后把应用/资源挂到 ``request.state`` 供调用日志中间件读取。
    """
    from app.models.open_api import OpenApiApp, OpenApiScope

    access_key, secret = parse_api_key_header(x_api_key or "")

    if _is_locked(access_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="密钥连续校验失败已被临时锁定，请 10 分钟后重试",
        )

    app = db.query(OpenApiApp).filter(OpenApiApp.access_key == access_key).first()
    if app is None:
        _record_failure(access_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API Key 无效")

    # 尽早挂 state：后续 403（停用/过期/白名单/未授权）与 429（限流）
    # 的拒绝调用日志、应用统计也能正确归属到该应用
    request.state.open_api_app = app
    request.state.open_api_resource = resource_code or None
    request.state.open_api_access_key = access_key

    if app.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="该应用已被停用")
    if app.expires_at is not None and app.expires_at <= beijing_now():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="该应用密钥已过期")

    if not hmac.compare_digest(hash_secret(secret), app.secret_hash or ""):
        _record_failure(access_key)
        logger.warning("开放 API secret 校验失败: ak=%s, app=%s", access_key, app.app_name)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API Key 无效")
    _clear_failures(access_key)

    # IP 白名单：仅信任 TCP 直连对端地址（request.client.host）。
    # X-Forwarded-For 由客户端可伪造，不能作为安全判据；若经反向代理部署，
    # 请在代理层透传真实 IP（proxy_protocol）或将代理 IP 纳入白名单。
    try:
        allowed = json.loads(app.allowed_ips or "[]")
    except (TypeError, ValueError):
        allowed = []
    if allowed:
        peer_ip = (request.client.host if request.client else None) or "unknown"
        if peer_ip not in allowed:
            logger.warning(
                "开放 API IP 白名单拒绝: ak=%s, ip=%s", access_key, peer_ip
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="客户端 IP 不在该应用的白名单内",
            )

    # 数据授权（scope）
    if resource_code:
        scoped = (
            db.query(OpenApiScope)
            .filter(OpenApiScope.app_id == app.id, OpenApiScope.resource_code == resource_code)
            .first()
        )
        if scoped is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"该应用未被授权访问资源: {resource_code}",
            )

    # 独立限流（配额为 NULL 时兜底 60/分，防 TypeError 被吞导致无限放行）
    _check_rate_limit(access_key, app.rate_limit_per_minute or 60)

    return app


def verify_api_key(resource_code: str) -> Callable:
    """开放 API 鉴权依赖工厂（资源编码固定时使用，如静态端点）。

    用法：``Depends(verify_api_key("alerts"))``。
    """

    def _checker(
        request: Request,
        x_api_key: str = Header(None, alias=_API_KEY_HEADER),
        db: Session = Depends(get_db),
    ):
        return authenticate_request(request, x_api_key, db, resource_code)

    return _checker


# ============ 调用日志中间件 ============

async def open_api_call_middleware(request: Request, call_next: Callable):
    """开放 API 调用监控中间件：记录所有 ``/api/v1/open/`` 请求。

    - 401/403/429 拒绝同样记录（监控爆破与误配置）。
    - 请求体为空（GET），仅记录查询参数摘要，绝不含密钥。
    - 应用调用统计（total_calls/last_call_at）与日志同事务维护。
    - 记录失败仅 warning，不阻断主流程（模式与 audit_middleware 一致）。
    """
    path = request.url.path
    if not (path.startswith("/api/v1/open/") or path == "/api/v1/open"):
        return await call_next(request)

    start = time.perf_counter()
    status_code = 500
    error_message = None
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    except HTTPException as exc:
        status_code = exc.status_code
        error_message = str(exc.detail)
        raise
    except Exception as exc:  # noqa: BLE001
        error_message = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        # 落库放线程池执行：开放 API 为第三方高频 GET 轮询场景，
        # 同步 DB 往返若留在事件循环线程会拖慢整个服务（含其他 async 路由）
        await run_in_threadpool(_record_call_log, request, status_code, elapsed_ms, error_message)


def _record_call_log(request: Request, status_code: int, elapsed_ms: int, error_message) -> None:
    """用独立 DB session 落一条调用日志（失败不阻断，同步累加应用统计）。"""
    try:
        import json as _json

        from app.database import SessionLocal
        from app.models.open_api import OpenApiApp, OpenApiCallLog

        app = getattr(request.state, "open_api_app", None)
        resource = getattr(request.state, "open_api_resource", None) or _resource_from_path(
            request.url.path
        )
        app_id = getattr(app, "id", None)
        app_name = getattr(app, "app_name", "") or _ak_name(request)

        # 查询参数摘要（截断防超长；密钥在 Header 中不会出现在 query）
        try:
            qp = _json.dumps(dict(request.query_params), ensure_ascii=False)
        except Exception:  # noqa: BLE001
            qp = str(request.query_params)
        if len(qp) > 1000:
            qp = qp[:1000]

        db = SessionLocal()
        try:
            db.add(
                OpenApiCallLog(
                    app_id=app_id,
                    app_name=app_name,
                    resource_code=resource,
                    method=request.method,
                    path=request.url.path,
                    query_params=qp,
                    status_code=status_code,
                    response_ms=elapsed_ms,
                    client_ip=get_client_ip(request),
                    user_agent=(request.headers.get("user-agent") or "")[:255],
                    error_message=error_message,
                )
            )
            if app_id is not None:
                db.query(OpenApiApp).filter(OpenApiApp.id == app_id).update(
                    {"total_calls": OpenApiApp.total_calls + 1, "last_call_at": beijing_now()},
                    synchronize_session=False,
                )
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("开放 API 调用日志记录失败（不阻断）: %s", exc)


def _resource_from_path(path: str) -> str:
    """从 ``/api/v1/open/{resource}`` 提取资源编码（鉴权失败时兜底）。"""
    parts = [p for p in path.split("/") if p]
    # ["api", "v1", "open", "{resource}"]
    if len(parts) >= 4 and parts[2] == "open":
        return parts[3]
    return ""


def _ak_name(request: Request) -> str:
    """鉴权失败时从 X-API-Key 提取 access_key 作为 app_name 兜底快照。"""
    try:
        raw = request.headers.get("x-api-key") or ""
        return parse_api_key_header(raw)[0] if ":" in raw else ""
    except HTTPException:
        return ""
