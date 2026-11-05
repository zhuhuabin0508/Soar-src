"""审计日志工具函数。

提供 ``log_audit()`` 用于在关键操作中记录审计日志，以及全局审计中间件
``audit_middleware`` 自动记录用户所有写操作（POST/PUT/DELETE/PATCH）。
"""
import json
import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def log_audit(
    db: Session,
    user_id: Optional[int] = None,
    username: Optional[str] = None,
    action: str = "",
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    detail: Any = None,
    ip_address: Optional[str] = None,
    result: str = "success",
) -> None:
    """记录一条审计日志（失败不阻断主流程）。

    Args:
        db: 数据库会话。
        user_id: 操作者用户 ID。
        username: 操作者用户名。
        action: 操作类型（login/logout/create/update/delete/execute/export）。
        resource_type: 资源类型（workflow/tool/agent/user/role 等）。
        resource_id: 资源 ID。
        detail: 操作详情（任意可 JSON 序列化的对象）。
        ip_address: 客户端 IP。
        result: 操作结果（success/failed）。
    """
    try:
        from app.models.audit_log import AuditLog

        if db is None:
            # 部分调用点（如登出）无 db 会话：仅记日志不落库
            logger.warning("审计日志未落库（db 会话为空）: action=%s, username=%s, result=%s",
                           action, username, result)
            return

        detail_str = None
        if detail is not None:
            try:
                detail_str = json.dumps(detail, ensure_ascii=False, default=str)
            except Exception:  # noqa: BLE001
                detail_str = str(detail)

        log = AuditLog(
            user_id=user_id,
            username=username,
            action=action,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id is not None else None,
            detail=detail_str,
            ip_address=ip_address,
            result=result,
        )
        db.add(log)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("审计日志记录失败（不阻断主流程）: %s", exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ============ 全局审计中间件 ============
# 自动记录用户所有写操作（POST/PUT/DELETE/PATCH）到 audit_logs，
# 包含操作者、模块（资源类型）、资源ID、IP地址、操作结果。

# 触发审计的 HTTP 方法
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# URL path 第二段（资源复数名）→ 资源类型单数名
_RESOURCE_MAP = {
    "agents": "agent",
    "tools": "tool",
    "workflows": "workflow",
    "knowledge-bases": "knowledge_base",
    "users": "user",
    "roles": "role",
    "notifications": "notification",
    "skills": "skill",
    "llm-configs": "llm_config",
    "system-monitor": "system_monitor",
    "system-config": "system_config",
    "agent-files": "agent_file",
    "executions": "execution",
    "assets": "asset",
    "govcloud": "asset_discovery",
    "asset-templates": "asset_template",
    "banned-ips": "banned_ip",
    "devices": "device",
    "backup": "backup",
    "approvals": "approval",
    "dashboard": "dashboard",
    "auth": "auth",
    # 日志采集相关：接收器 / 解析模板（ingest 前缀下主要是 strategies 写操作）
    "log-receivers": "log_receiver",
    "ingest": "strategy",
    # API 开放平台管理操作（应用/密钥/授权）
    "open-admin": "open_api_app",
}


def get_client_ip(request) -> str:
    """从请求中提取客户端真实 IP。

    优先取 ``X-Forwarded-For`` 首个 IP（反向代理场景），其次 ``X-Real-IP``，
    最后回退到 ``request.client.host``。
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


def _is_high_frequency_path(path: str) -> bool:
    """判断是否高频/查询类路径，应跳过审计（避免日志爆炸）。

    跳过：流式对话/测试端点、查询/已读类末段、登录/登出（由 auth 处理器自行记录）。
    """
    lower = path.lower()
    # 流式对话 / 智能体测试端点（高频，非管理操作）
    if "/chat" in lower or "/test/stream" in lower or "/stream" in lower:
        return True
    # 登录 / 登出端点由 auth.py 处理器内部记录（含用户名+IP），避免重复审计
    if lower.endswith("/auth/login") or lower.endswith("/auth/logout"):
        return True
    # 日志上报通道（设备推送数据，高频且非管理操作，不属于增删改审计范围）
    if lower.endswith("/ingest/alert"):
        return True
    # 末段为查询/已读/导出/测试类动作的路径
    last = lower.rstrip("/").rsplit("/", 1)[-1]
    if last in (
        "audit-logs", "health", "performance", "unread-count",
        "read-all", "read", "export", "list", "segments", "test",
    ):
        return True
    return False


def _parse_resource(path: str) -> tuple[str, str]:
    """从 URL path 解析 (resource_type, resource_id)。

    例如 ``/api/v1/agents/123/test`` → ``("agent", "123")``。
    """
    parts = [p for p in path.split("/") if p]
    # parts 形如 ["api", "v1", "agents", "123", ...]
    if len(parts) < 3:
        return "", ""
    res_key = parts[2]
    resource_type = _RESOURCE_MAP.get(res_key, res_key.rstrip("s"))
    resource_id = parts[3] if len(parts) >= 4 and parts[3].isdigit() else ""
    return resource_type, resource_id


def _infer_action(method: str, path: str) -> str:
    """根据 HTTP 方法和路径推断操作类型。"""
    method = method.upper()
    if method == "DELETE":
        return "delete"
    if method in ("PUT", "PATCH"):
        return "update"
    if method == "POST":
        lower = path.lower()
        if "login" in lower:
            return "login"
        if "logout" in lower:
            return "logout"
        if any(k in lower for k in ("/run", "/execute", "/trigger", "/start", "/reingest")):
            return "execute"
        if any(k in lower for k in ("/upload", "/import")):
            return "upload"
        return "create"
    return method.lower()


def _resolve_user(request):
    """从请求 Authorization 头解析当前用户（user_id, username）。

    解析失败（未登录/ token 无效）返回 ``(None, None)``，不抛异常。
    """
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None, None
    token = auth.split(" ", 1)[1].strip()
    try:
        from app.core.security import decode_access_token

        payload = decode_access_token(token)
        return payload.get("sub"), payload.get("username")
    except Exception:  # noqa: BLE001
        return None, None


async def audit_middleware(request, call_next):
    """全局审计中间件：自动记录用户写操作到 ``audit_logs``。

    - 只记录 POST/PUT/PATCH/DELETE（读操作不记录）。
    - 跳过流式对话/测试/查询类高频路径。
    - 从 JWT 解析操作者，从 ``X-Forwarded-For`` 解析 IP。
    - 记录失败不阻断主流程。
    """
    path = request.url.path
    method = request.method

    should_audit = (
        method in _WRITE_METHODS
        and path.startswith("/api/v1/")
        and not _is_high_frequency_path(path)
    )
    if not should_audit:
        return await call_next(request)

    # 请求前解析：用户、IP、资源、动作
    user_id, username = _resolve_user(request)
    ip = get_client_ip(request)
    resource_type, resource_id = _parse_resource(path)
    action = _infer_action(method, path)

    response = None
    status_code = 500
    result = "failed"
    try:
        response = await call_next(request)
        status_code = response.status_code
        result = "failed" if status_code >= 400 else "success"
    except Exception:  # noqa: BLE001
        status_code = 500
        result = "failed"
        _record_request_audit(
            user_id, username, action, resource_type, resource_id,
            method, path, status_code, ip, result,
        )
        raise
    # 正常完成：记录审计
    _record_request_audit(
        user_id, username, action, resource_type, resource_id,
        method, path, status_code, ip, result,
    )
    return response


def _record_request_audit(
    user_id, username, action, resource_type, resource_id,
    method, path, status_code, ip, result,
) -> None:
    """用独立 DB session 记录一条请求审计日志（失败不阻断）。"""
    try:
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            # 用户名以数据库当前值为准：JWT 中的 username 在改名后会变成旧值，
            # 直接采用会让改名后的审计身份与账号实际用户名不一致。
            resolved_username = username
            if user_id and str(user_id).isdigit():
                try:
                    from app.models.user import User

                    row = db.query(User.username).filter(User.id == int(user_id)).first()
                    if row and row[0]:
                        resolved_username = row[0]
                except Exception as exc:  # noqa: BLE001
                    logger.debug("审计用户名回查失败，回退 token 中的用户名: %s", exc)
            log_audit(
                db,
                user_id=int(user_id) if user_id and str(user_id).isdigit() else None,
                username=resolved_username,
                action=action,
                resource_type=resource_type or None,
                resource_id=resource_id or None,
                detail={"method": method, "path": path, "status": status_code},
                ip_address=ip,
                result=result,
            )
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("审计中间件记录失败（不阻断）: %s", exc)
