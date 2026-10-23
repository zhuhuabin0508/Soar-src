"""DeviceGateway：设备唯一执行缝（async 门面）。"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Optional

from sqlalchemy import func, text

logger = logging.getLogger(__name__)

IDEMPOTENCY_WINDOW_SECONDS = 300  # 幂等去重时间窗 5 分钟


def build_idempotency_key(*, source: str, device_id: int, action_type: str,
                          params: dict | None, agent_id: int | None = None,
                          workflow_id: int | None = None) -> str:
    """幂等键 = hash(source, agent_id, workflow_id, device_id, action_type, 业务主键)。"""
    params = params or {}
    business_key = str(params.get("ip") or params.get("hostname")
                       or params.get("ioc") or params.get("target") or "")
    raw = f"{source}:{agent_id or 0}:{workflow_id or 0}:{device_id}:{action_type}:{business_key}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class DeviceGateway:
    @staticmethod
    async def invoke(
        db,
        device_id: int,
        *,
        action_id: Optional[int] = None,
        action_type: Optional[str] = None,
        params: Optional[dict] = None,
        source: str,                     # manual_test / workflow / agent / api
        user_id: Optional[int] = None,
        source_ip: Optional[str] = None,
        agent_id: Optional[int] = None,
        workflow_id: Optional[int] = None,
        correlation_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """统一设备执行入口。返回 {success, status_code, response_body, error,
        latency_ms, idempotent_replay}。"""
        from app.devices.action_executor import (
            execute_device_action, find_device_action_by_type,
        )
        from app.models.device import Device, DeviceAction, DeviceCallLog

        params = params or {}

        # 1) 解析 device + action
        if action_id is not None:
            action = db.query(DeviceAction).filter(DeviceAction.id == action_id).first()
            if action is None:
                return _err(f"动作不存在: action_id={action_id}")
            device = db.query(Device).filter(Device.id == action.device_id).first()
            if device is None:
                return _err(f"设备不存在: device_id={action.device_id}")
        elif action_type is not None:
            device, action, dev_err = find_device_action_by_type(db, device_id, action_type)
            if dev_err:
                return _err(dev_err)
        else:
            return _err("必须提供 action_id 或 action_type")

        # 2) 幂等查重（写日志前，5 分钟窗口）
        # 注意：created_at 由 server_default=func.now() 写 DB 服务器时钟，
        # 窗口起点须用同一时钟（func.now()）计算，用 beijing_now 会产生 8 小时偏差。
        # 事务级咨询锁串行化同 key 并发，避免「双查未命中 → 双发设备」。
        if idempotency_key:
            try:
                lock_key = int(
                    hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:15],
                    16,
                )
                db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})
            except Exception:  # noqa: BLE001
                logger.debug("幂等咨询锁不可用，降级为无锁查重: key=%s", idempotency_key)
            window_start = func.now() - text(
                f"interval '{IDEMPOTENCY_WINDOW_SECONDS} seconds'"
            )
            replay = (
                db.query(DeviceCallLog)
                .filter(DeviceCallLog.idempotency_key == idempotency_key,
                        DeviceCallLog.created_at >= window_start)
                .first()
            )
            if replay is not None:
                logger.info("幂等命中，跳过设备调用: key=%s", idempotency_key)
                return {
                    "success": replay.status == "success",
                    "status_code": replay.status_code,
                    "response_body": replay.response_summary,
                    "error": replay.error_message,
                    "latency_ms": replay.latency_ms,
                    "idempotent_replay": True,
                }

        # 3) async 包装同步 httpx（execute_device_action 是同步的）。
        #    worker 线程内不碰 db（SQLAlchemy Session 非线程安全），故 db=None +
        #    skip_log=True，只执行 HTTP；DeviceCallLog 回到主线程写（见第 4 步）。
        result = await asyncio.to_thread(
            execute_device_action,
            device, action, params, timeout,
            db=None, source=source, workflow_id=workflow_id, agent_id=agent_id,
            user_id=user_id, skip_log=True,
        )
        result["idempotent_replay"] = False

        # 4) 回主线程写 DeviceCallLog（含幂等键/关联键）
        _write_call_log(
            db, device=device, action=action, source=source, params=params,
            workflow_id=workflow_id, agent_id=agent_id, user_id=user_id,
            source_ip=source_ip,
            result=result, idempotency_key=idempotency_key,
            correlation_id=correlation_id,
        )
        return result


def _write_call_log(db, *, device, action, source, params, workflow_id, agent_id,
                    user_id, source_ip=None, result, idempotency_key, correlation_id) -> None:
    """在主线程写 DeviceCallLog（避免 SQLAlchemy Session 跨线程使用）。"""
    import json as _json

    from app.devices.action_executor import record_device_call

    try:
        req_summary = _json.dumps(
            {"device_id": device.id, "action_id": getattr(action, "id", None),
             "params": params},
            ensure_ascii=False,
        )[:2000]
    except Exception:  # noqa: BLE001
        req_summary = str(params)[:2000]
    try:
        resp_summary = _json.dumps(result.get("response_body"), ensure_ascii=False)[:2000]
    except Exception:  # noqa: BLE001
        resp_summary = str(result.get("response_body"))[:2000]

    record_device_call(
        db, device=device, action=action, source=source,
        workflow_id=workflow_id, agent_id=agent_id, user_id=user_id,
        source_ip=source_ip,
        request_summary=req_summary, response_summary=resp_summary,
        status="success" if result.get("success") else "failed",
        status_code=result.get("status_code"),
        latency_ms=result.get("latency_ms"),
        error_message=result.get("error"),
        idempotency_key=idempotency_key, correlation_id=correlation_id,
    )


def _err(msg: str) -> dict:
    return {"success": False, "status_code": None, "response_body": None,
            "error": msg, "latency_ms": 0, "idempotent_replay": False}
