"""跨系统文件接收对外接口（Access Key + HMAC 签名认证）。"""
import hashlib
import json
import logging
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.file_receive import service
from app.core.file_receive.auth import authenticate
from app.core.file_receive.errors import FileReceiveError
from app.core.file_receive.validators import MAX_BODY_BYTES
from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/file-receive/open", tags=["file-receive-open"])

CONTRACT_VERSION = "2026-11-01"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _trace_id(request: Request) -> str:
    return getattr(request.state, "fr_trace_id", None) or uuid.uuid4().hex[:16]


def _ok(request: Request, data: dict, *, status_code: int = 200) -> JSONResponse:
    trace_id = _trace_id(request)
    return JSONResponse(
        status_code=status_code,
        content={
            "code": "OK",
            "message": "success",
            "request_id": getattr(request.state, "fr_request_id", None),
            "trace_id": trace_id,
            "data": data,
        },
        headers={"X-Trace-Id": trace_id, "X-Contract-Version": CONTRACT_VERSION},
    )


async def _read_json(request: Request) -> tuple[bytes, dict]:
    content_type = (request.headers.get("content-type") or "").lower()
    if "application/json" not in content_type:
        raise FileReceiveError("FR-TYPE-004", 415, "Content-Type 必须为 application/json")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise FileReceiveError("FR-VAL-009", 413, "JSON 请求体超过 32 KiB")
    if not raw:
        raise FileReceiveError("FR-VAL-002", 400, "请求体不能为空")
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        raise FileReceiveError("FR-VAL-002", 400, "请求体不是合法 JSON")
    if not isinstance(payload, dict):
        raise FileReceiveError("FR-VAL-002", 400, "请求体必须是 JSON 对象")
    return raw, payload


@router.post("/receipts")
async def create_receipt(
    request: Request,
    db: Session = Depends(get_db),
):
    raw, payload = await _read_json(request)
    source = authenticate(request, db, hashlib.sha256(raw).hexdigest())
    result = await run_in_threadpool(
        service.create_receipt,
        db,
        source,
        payload,
        client_ip=getattr(request.state, "fr_client_ip", ""),
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )
    request.state.fr_request_id = result.get("request_id")
    return _ok(request, result)


@router.put("/receipts/{upload_id}/parts/{part_no}")
async def upload_part(
    upload_id: str,
    part_no: int,
    request: Request,
    db: Session = Depends(get_db),
):
    declared = (request.headers.get("x-content-sha256") or "").strip().lower()
    source = authenticate(request, db, declared or EMPTY_SHA256)
    result = await service.save_part(db, source, upload_id, part_no, request)
    return _ok(request, result)


@router.post("/receipts/{upload_id}/complete")
async def complete_receipt(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    raw, payload = await _read_json(request)
    source = authenticate(request, db, hashlib.sha256(raw).hexdigest())
    result, status_code = await run_in_threadpool(
        service.complete_receipt, db, source, upload_id, payload
    )
    request.state.fr_request_id = result.get("request_id")
    return _ok(request, result, status_code=status_code)


@router.get("/receipts/by-request/{request_id}")
async def get_by_request(
    request_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    source = authenticate(request, db, EMPTY_SHA256)
    request.state.fr_request_id = request_id
    result = service.get_by_request(db, source, request_id)
    return _ok(request, result)


@router.get("/receipts/{upload_id}")
async def get_session(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    source = authenticate(request, db, EMPTY_SHA256)
    result = service.get_session(db, source, upload_id)
    request.state.fr_request_id = result.get("request_id")
    return _ok(request, result)


@router.post("/receipts/{upload_id}/abort")
async def abort_receipt(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    source = authenticate(request, db, EMPTY_SHA256)
    result, status_code = await run_in_threadpool(
        service.abort_receipt, db, source, upload_id
    )
    request.state.fr_request_id = result.get("request_id")
    return _ok(request, result, status_code=status_code)


@router.post("/receipts/{upload_id}/retry")
async def retry_receipt(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    source = authenticate(request, db, EMPTY_SHA256)
    result, status_code = await run_in_threadpool(
        service.retry_receipt, db, source, upload_id
    )
    request.state.fr_request_id = result.get("request_id")
    return _ok(request, result, status_code=status_code)
