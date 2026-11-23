"""文件接收对外接口调用日志中间件。

只记录 ``/api/v1/file-receive/open`` 前缀，包含 401/403/429 等拒绝请求，
不影响主流程；落库在线程池执行，避免同步 DB 往返阻塞事件循环。
"""
import logging
import time

from fastapi import Request
from fastapi.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)


def _parse_upload_id(path: str) -> str | None:
    parts = [p for p in path.split("/") if p]
    try:
        idx = parts.index("receipts")
    except ValueError:
        return None
    if idx + 1 >= len(parts):
        return None
    candidate = parts[idx + 1]
    if candidate == "by-request":
        return None
    return candidate[:64]


def _write_log(
    *,
    source_id: int | None,
    source_code: str,
    method: str,
    path: str,
    status_code: int,
    error_code: str | None,
    request_id: str | None,
    upload_id: str | None,
    client_ip: str,
    bytes_count: int,
    duration_ms: int,
    user_agent: str,
) -> None:
    try:
        from app.database import SessionLocal
        from app.models.file_receive import FileReceiveAccessLog

        db = SessionLocal()
        try:
            db.add(
                FileReceiveAccessLog(
                    source_id=source_id,
                    source_code=(source_code or "")[:64],
                    method=method[:8],
                    path=path[:255],
                    status_code=status_code,
                    error_code=error_code,
                    request_id=(request_id or None),
                    upload_id=upload_id,
                    client_ip=(client_ip or "")[:64],
                    bytes=bytes_count,
                    duration_ms=duration_ms,
                    user_agent=(user_agent or "")[:255],
                )
            )
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("文件接收访问日志写入失败（不阻断）: %s", exc)


async def file_receive_access_middleware(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/v1/file-receive/open"):
        return await call_next(request)

    start = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    except Exception:
        status_code = 500
        raise
    finally:
        duration_ms = int((time.perf_counter() - start) * 1000)
        try:
            bytes_count = int(request.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            bytes_count = 0
        await run_in_threadpool(
            _write_log,
            source_id=getattr(request.state, "fr_source_id", None),
            source_code=getattr(request.state, "fr_source_code", ""),
            method=request.method,
            path=path,
            status_code=status_code,
            error_code=getattr(request.state, "fr_error_code", None),
            request_id=getattr(request.state, "fr_request_id", None),
            upload_id=_parse_upload_id(path),
            client_ip=(request.client.host if request.client else "") or "",
            bytes_count=bytes_count,
            duration_ms=duration_ms,
            user_agent=request.headers.get("user-agent") or "",
        )
