"""系统监控 API。

提供：
- 服务健康检查（数据库 / Redis / 自身）
- 系统性能指标（CPU / 内存 / 磁盘）
- 操作审计日志查询（分页 + 过滤）
"""
import logging
import os
import shutil
import threading
import time
from datetime import datetime
from app.core.timezone import beijing_now, beijing_now_iso
from typing import Optional

import psutil
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.audit_log import AuditLog
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/system-monitor",
    tags=["system-monitor"],
    dependencies=[Depends(get_current_user)],
)

# 容器 → 服务栈分组映射
_CONTAINER_GROUPS = {
    "soar-backend": "SOAR 平台",
    "soar-worker": "SOAR 平台",
    "soar-beat": "SOAR 平台",
    "soar-frontend": "SOAR 平台",
    "soar-postgres": "SOAR 平台",
    "soar-redis": "SOAR 平台",
    "soar-proxy": "SOAR 平台",
    "soar-defectdojo-uwsgi": "DefectDojo 漏洞管理",
    "soar-defectdojo-celeryworker": "DefectDojo 漏洞管理",
    "soar-defectdojo-celerybeat": "DefectDojo 漏洞管理",
    "soar-defectdojo": "DefectDojo 漏洞管理",
    "soar-defectdojo-db": "DefectDojo 漏洞管理",
    "soar-defectdojo-redis": "DefectDojo 漏洞管理",
    "soar-defectdojo-rabbitmq": "DefectDojo 漏洞管理",
    "soar-bloodhound": "BloodHound 攻击路径",
    "soar-bloodhound-neo4j": "BloodHound 攻击路径",
    "soar-bloodhound-appdb": "BloodHound 攻击路径",
    "soar-new-api": "AI 模型网关",
    "soar-new-api-postgres": "AI 模型网关",
    "soar-new-api-redis": "AI 模型网关",
}


def _get_container_group(name: str) -> str:
    """根据容器名匹配所属服务栈分组。"""
    for prefix, group in _CONTAINER_GROUPS.items():
        if name.startswith(prefix):
            return group
    return "其他服务"


# ============ Docker 容器 stats 缓存（懒加载 + TTL） ============
_STATS_CACHE: dict[str, dict] = {}  # {name: {mem_pct, mem_usage, mem_limit, cpu_pct, ts}}
_STATS_LOCK = threading.Lock()
_STATS_TTL = 30  # 缓存有效期（秒），避免频繁调用 c.stats()


def _collect_container_stats(client) -> None:
    """一次性采集所有运行中 SOAR 容器的 stats 并更新缓存。"""
    try:
        for c in client.containers.list(all=True):
            if not c.name.startswith("soar-"):
                continue
            if c.status != "running":
                continue
            try:
                stats = c.stats(stream=False)
                mem_info = stats.get("memory_stats", {})
                mem_usage = mem_info.get("usage", 0)
                mem_limit = mem_info.get("limit", 0)
                mem_pct = round(mem_usage / mem_limit * 100, 1) if mem_limit else 0
                cpu_stats = stats.get("cpu_stats", {})
                precpu = stats.get("precpu_stats", {})
                cpu_total = cpu_stats.get("cpu_usage", {}).get("total_usage", 0)
                precpu_total = precpu.get("cpu_usage", {}).get("total_usage", 0)
                sys_cpu = cpu_stats.get("system_cpu_usage", 0)
                pre_sys = precpu.get("system_cpu_usage", 0)
                online = cpu_stats.get("online_cpus", 1)
                cpu_delta = cpu_total - precpu_total
                sys_delta = sys_cpu - pre_sys
                cpu_pct = round(cpu_delta / sys_delta * online * 100, 2) if sys_delta else 0
                with _STATS_LOCK:
                    _STATS_CACHE[c.name] = {
                        "mem_pct": mem_pct,
                        "mem_usage": mem_usage,
                        "mem_limit": mem_limit,
                        "cpu_pct": cpu_pct,
                        "ts": time.time(),
                    }
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _get_cached_stats(name: str) -> dict | None:
    """从缓存读取容器 stats，缓存过期时触发后台异步刷新。"""
    with _STATS_LOCK:
        s = _STATS_CACHE.get(name)
        if s and time.time() - s.get("ts", 0) <= _STATS_TTL:
            return s
    # 缓存过期或不存在，启动后台线程异步采集（不阻塞当前请求）
    t = threading.Thread(target=_refresh_stats_async, daemon=True, name="stats-refresh")
    t.start()
    # 返回可能存在的旧缓存（即使过期），没有则返回 None
    with _STATS_LOCK:
        return _STATS_CACHE.get(name)


def _refresh_stats_async() -> None:
    """后台异步刷新 stats 缓存。"""
    try:
        client = _get_docker_client()
        if client:
            _collect_container_stats(client)
    except Exception:  # noqa: BLE001
        pass


@router.get("/health", dependencies=[Depends(require_permission("system_monitor", "view"))])
def check_health(db: Session = Depends(get_db)) -> dict:
    """检查各服务健康状态。

    Returns:
        ``{services: [{name, status, latency_ms, detail}], overall: "healthy"/"degraded"} ``
    """
    services = []

    # 1. 数据库健康检查
    try:
        start = datetime.now()
        db.execute(text("SELECT 1"))
        latency = (datetime.now() - start).total_seconds() * 1000
        services.append({
            "name": "PostgreSQL",
            "status": "healthy",
            "latency_ms": round(latency, 2),
            "detail": "连接正常",
            "group": "SOAR 平台",
        })
    except Exception as exc:  # noqa: BLE001
        services.append({
            "name": "PostgreSQL",
            "status": "unhealthy",
            "latency_ms": 0,
            "detail": str(exc),
            "group": "SOAR 平台",
        })

    # 2. Redis 健康检查
    try:
        import redis as redis_lib
        from app.config import settings
        start = datetime.now()
        r = redis_lib.from_url(settings.REDIS_URL, socket_timeout=3)
        r.ping()
        latency = (datetime.now() - start).total_seconds() * 1000
        services.append({
            "name": "Redis",
            "status": "healthy",
            "latency_ms": round(latency, 2),
            "detail": "连接正常",
            "group": "SOAR 平台",
        })
    except Exception as exc:  # noqa: BLE001
        services.append({
            "name": "Redis",
            "status": "unhealthy",
            "latency_ms": 0,
            "detail": str(exc),
            "group": "SOAR 平台",
        })

    # 3. API 服务自身
    services.append({
        "name": "API Server",
        "status": "healthy",
        "latency_ms": 0,
        "detail": f"PID {os.getpid()}",
        "group": "SOAR 平台",
    })

    # 4. Celery Worker（通过检查 Redis 队列是否有消费者间接判断）
    try:
        import redis as redis_lib
        from app.config import settings
        r = redis_lib.from_url(settings.REDIS_URL, socket_timeout=3)
        # 检查 celery 队列长度
        queue_len = r.llen("celery")
        services.append({
            "name": "Celery Worker",
            "status": "healthy",
            "latency_ms": 0,
            "detail": f"队列积压: {queue_len} 条",
            "group": "SOAR 平台",
        })
    except Exception as exc:  # noqa: BLE001
        services.append({
            "name": "Celery Worker",
            "status": "unknown",
            "latency_ms": 0,
            "detail": "无法检测",
            "group": "SOAR 平台",
        })

    # 5. Docker 容器健康检查（列出所有 soar-* 容器并按分组归类）
    try:
        containers = list_service_containers()
        seen_names = {s["name"] for s in services}
        for c in containers.get("services", []):
            cname = c["name"]
            # 跳过已被上面应用级检查覆盖的容器
            app_mapped = {
                "soar-postgres": "PostgreSQL",
                "soar-redis": "Redis",
                "soar-backend-dev": "API Server",
                "soar-backend": "API Server",
                "soar-worker-dev": "Celery Worker",
                "soar-worker": "Celery Worker",
            }
            if cname in app_mapped:
                continue
            services.append({
                "name": cname,
                "status": "healthy" if c.get("running") else "unhealthy",
                "latency_ms": 0,
                "detail": f"镜像: {c.get('image', '?')}",
                "group": _get_container_group(cname),
                "container": True,
                "one_shot": "initializer" in cname,
                "mem_pct": c.get("mem_pct"),
                "mem_usage": c.get("mem_usage"),
                "mem_limit": c.get("mem_limit"),
                "cpu_pct": c.get("cpu_pct"),
            })
            # 一次性容器退出码 0 视为完成（healthy），非 0 视为失败
            if "initializer" in cname and not c.get("running"):
                exit_code = c.get("exit_code")
                if exit_code == 0 or exit_code is None:
                    services[-1]["status"] = "healthy"
                    services[-1]["detail"] = f"已完成初始化（退出码 0）"
                else:
                    services[-1]["detail"] = f"初始化失败（退出码 {exit_code}）"
    except Exception as exc:  # noqa: BLE001
        logger.debug("Docker 容器健康检查失败: %s", exc)

    overall = "healthy" if all(s["status"] == "healthy" for s in services) else "degraded"
    return {"services": services, "overall": overall, "checked_at": beijing_now_iso()}


@router.get("/performance", dependencies=[Depends(require_permission("system_monitor", "view"))])
def get_performance() -> dict:
    """获取系统性能指标（CPU / 内存 / 磁盘）。

    Returns:
        ``{cpu_percent, memory: {total, used, percent}, disk: {total, used, percent}, uptime_seconds}``
    """
    # CPU 使用率
    cpu_percent = psutil.cpu_percent(interval=0.5)

    # 内存
    mem = psutil.virtual_memory()

    # 磁盘（当前工作目录所在分区）
    disk = shutil.disk_usage("/")

    # 进程运行时间
    try:
        process = psutil.Process()
        uptime = int(datetime.now().timestamp() - process.create_time())
    except Exception:  # noqa: BLE001
        uptime = 0

    return {
        "cpu_percent": cpu_percent,
        "cpu_count": psutil.cpu_count(),
        "memory": {
            "total_gb": round(mem.total / 1024 ** 3, 2),
            "used_gb": round(mem.used / 1024 ** 3, 2),
            "percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1024 ** 3, 2),
            "used_gb": round(disk.used / 1024 ** 3, 2),
            "percent": round(disk.used / disk.total * 100, 1),
        },
        "uptime_seconds": uptime,
    }


@router.get("/audit-logs")
def list_audit_logs(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    action: Optional[str] = Query(None, description="按操作类型过滤"),
    resource_type: Optional[str] = Query(None, description="按资源类型过滤"),
    username: Optional[str] = Query(None, description="按用户名模糊过滤"),
    ip_address: Optional[str] = Query(None, description="按 IP 地址模糊过滤"),
    result: Optional[str] = Query(None, description="按操作结果过滤（success/failed）"),
    start_time: Optional[str] = Query(None, description="起始时间（ISO 格式，如 2026-08-01T00:00:00）"),
    end_time: Optional[str] = Query(None, description="结束时间（ISO 格式）"),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("audit_log", "view")),
) -> dict:
    """查询操作审计日志（分页 + 多维过滤）。

    支持的过滤维度（等保审计要求）：
    - 操作类型（action）：login/logout/create/update/delete/export/execute
    - 资源类型（resource_type）：user/role/agent/asset/auth 等
    - 用户名（username）：模糊匹配
    - IP 地址（ip_address）：模糊匹配（追溯异常登录来源）
    - 操作结果（result）：success/failed
    - 时间范围（start_time/end_time）：ISO 格式

    Returns:
        ``{logs: [...], total: N}``
    """
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if resource_type:
        q = q.filter(AuditLog.resource_type == resource_type)
    if username:
        q = q.filter(AuditLog.username.ilike(f"%{username}%"))
    if ip_address:
        q = q.filter(AuditLog.ip_address.ilike(f"%{ip_address}%"))
    if result:
        q = q.filter(AuditLog.result == result)
    if start_time:
        try:
            st = datetime.fromisoformat(start_time)
            q = q.filter(AuditLog.created_at >= st)
        except ValueError:
            pass
    if end_time:
        try:
            et = datetime.fromisoformat(end_time)
            q = q.filter(AuditLog.created_at <= et)
        except ValueError:
            pass

    total = q.count()
    logs = (
        q.order_by(AuditLog.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    return {
        "total": total,
        "logs": [
            {
                "id": l.id,
                "user_id": l.user_id,
                "username": l.username,
                "action": l.action,
                "resource_type": l.resource_type,
                "resource_id": l.resource_id,
                "detail": l.detail,
                "ip_address": l.ip_address,
                "result": l.result,
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in logs
        ],
    }


@router.get("/audit-logs/export")
def export_audit_logs(
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    username: Optional[str] = Query(None),
    ip_address: Optional[str] = Query(None),
    result: Optional[str] = Query(None),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("audit_log", "view")),
    request: Request = None,
) -> StreamingResponse:
    """导出审计日志为 CSV（等保合规存档要求）。

    支持与 ``/audit-logs`` 相同的过滤参数，导出符合条件的全部记录（最多 10000 条）。
    """
    import csv
    import io
    from fastapi.responses import StreamingResponse
    from app.core.audit import get_client_ip, log_audit

    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if resource_type:
        q = q.filter(AuditLog.resource_type == resource_type)
    if username:
        q = q.filter(AuditLog.username.ilike(f"%{username}%"))
    if ip_address:
        q = q.filter(AuditLog.ip_address.ilike(f"%{ip_address}%"))
    if result:
        q = q.filter(AuditLog.result == result)
    if start_time:
        try:
            st = datetime.fromisoformat(start_time)
            q = q.filter(AuditLog.created_at >= st)
        except ValueError:
            pass
    if end_time:
        try:
            et = datetime.fromisoformat(end_time)
            q = q.filter(AuditLog.created_at <= et)
        except ValueError:
            pass

    logs = q.order_by(AuditLog.created_at.desc()).limit(10000).all()

    # 审计：导出操作本身
    ip = get_client_ip(request) if request else "unknown"
    log_audit(db, user_id=user.id, username=user.username, action="export",
              resource_type="audit_log", ip_address=ip, result="success",
              detail={"count": len(logs), "filters": {
                  "action": action, "resource_type": resource_type,
                  "username": username, "result": result,
              }})

    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(["时间", "用户ID", "用户名", "操作类型", "资源类型",
                      "资源ID", "操作详情", "IP地址", "结果"])
    for l in logs:
        writer.writerow([
            l.created_at.strftime("%Y-%m-%d %H:%M:%S") if l.created_at else "",
            l.user_id or "",
            l.username or "",
            l.action,
            l.resource_type or "",
            l.resource_id or "",
            l.detail or "",
            l.ip_address or "",
            l.result,
        ])
    content = buf.getvalue()
    buf.close()
    filename = f"audit_logs_{beijing_now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============ 服务日志（通过 Docker SDK 获取容器日志） ============

def _get_docker_client():
    """获取 Docker 客户端（通过挂载的 docker.sock）。

    失败返回 None（调用方处理）。
    """
    try:
        import docker

        return docker.from_env()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Docker 客户端初始化失败: %s", exc)
        return None


# SOAR 平台相关容器名前缀（只列出这些，避免暴露无关容器）
_SOAR_CONTAINER_PREFIX = "soar-"


@router.get("/services", dependencies=[Depends(require_permission("system_monitor", "view"))])
def list_service_containers() -> dict:
    """列出 SOAR 平台的所有 Docker 容器及状态。

    通过 Docker SDK 获取 ``soar-`` 前缀的容器，返回名称、状态、镜像、运行时长。
    若 docker.sock 未挂载或不可访问，返回 ``{services: [], error: ...}``。
    """
    client = _get_docker_client()
    if client is None:
        return {
            "services": [],
            "error": "无法访问 Docker（docker.sock 未挂载或 Docker SDK 未安装）",
        }
    services = []
    try:
        for c in client.containers.list(all=True):
            if not c.name.startswith(_SOAR_CONTAINER_PREFIX):
                continue
            # 容器状态：created/restarting/running/removing/paused/exited/dead
            status = c.status
            # 镜像信息容错：重建后旧镜像可能已被删除，c.image 访问可能抛 404
            image_tag = ""
            try:
                tags = c.image.tags
                image_tag = tags[0] if tags else (c.image.id[:19] if c.image.id else "")
            except Exception as img_exc:  # noqa: BLE001
                logger.debug("获取容器 %s 镜像信息失败: %s", c.name, img_exc)
                image_tag = "<image-unavailable>"
            services.append({
                "name": c.name,
                "status": status,
                "image": image_tag,
                "short_id": c.short_id,
                "running": status == "running",
                "exit_code": c.attrs.get("State", {}).get("ExitCode"),
            })
            # 运行中的容器从缓存读取内存/CPU 使用率
            if status == "running":
                cached = _get_cached_stats(c.name)
                if cached:
                    services[-1]["mem_pct"] = cached["mem_pct"]
                    services[-1]["mem_usage"] = cached["mem_usage"]
                    services[-1]["mem_limit"] = cached["mem_limit"]
                    services[-1]["cpu_pct"] = cached["cpu_pct"]
        services.sort(key=lambda s: s["name"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("列出容器失败: %s", exc)
        return {"services": [], "error": str(exc)}
    return {"services": services}


@router.get("/services/{container_name}/logs")
def get_service_logs(
    container_name: str,
    tail: int = Query(200, ge=1, le=2000, description="获取最后 N 行日志"),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("audit_log", "view")),
) -> dict:
    """获取指定服务容器的最近日志。

    Args:
        container_name: 容器名（如 ``soar-backend`` / ``soar-postgres``）。
        tail: 获取最后 N 行日志（默认 200，上限 2000）。

    Returns:
        ``{container, tail, logs}``，logs 为字符串行列表。
    """
    # 安全：只允许 soar- 前缀的容器，避免任意容器日志泄露
    if not container_name.startswith(_SOAR_CONTAINER_PREFIX):
        raise HTTPException(status_code=400, detail="仅允许查看 SOAR 平台服务日志")

    client = _get_docker_client()
    if client is None:
        raise HTTPException(status_code=503, detail="无法访问 Docker（docker.sock 未挂载）")
    try:
        container = client.containers.get(container_name)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=f"容器不存在: {container_name}")

    try:
        # timestamps=True 带时间戳；tail=tail 取最后 N 行
        raw = container.logs(tail=tail, timestamps=True)
        # docker logs 返回 bytes，按行解码
        if isinstance(raw, bytes):
            text = raw.decode("utf-8", errors="replace")
        else:
            text = str(raw)
        lines = [ln for ln in text.splitlines() if ln.strip()]
        return {
            "container": container_name,
            "status": container.status,
            "tail": tail,
            "logs": lines,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("获取容器日志失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"获取日志失败（{type(exc).__name__}），详情见服务日志")
