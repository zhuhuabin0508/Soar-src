"""工单设备动作异步执行任务。

执行语义（重要，接入新动作前必读）：
- 至少一次（at-least-once），非 exactly-once。以下场景会对同一动作**重复下发设备**：
  1) Worker 在调用设备成功后、状态落库前崩溃，记录停留 running，
     超过 STALE_RUNNING_SECONDS 被标记失败，人工重试即再次下发；
  2) Celery acks_late 重新投递时上次执行已超时（同上判定）。
- block_ip / unblock_ip 天然幂等（重复加/删黑名单无害），可安全重试；
  接入非幂等动作（如改配置、下发命令）时，必须由设备端或动作执行器自行保证幂等
  （例如设备侧去重键 / 先查后写），否则不要开放人工重试。
- run 级幂等仅防「重复排队/重复执行同一 run」，不防「重试导致的第二次真实调用」。
"""
from __future__ import annotations

import logging
import time

from app.core.celery_app import celery_app
from app.core.ticket_device_action import (
    append_device_call_log,
    parse_params_schema,
    prepare_device_params,
    sync_device_outcome_to_workbench,
)
from app.core.ticket_device_run import apply_run_to_node_record
from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.models.device import Device, DeviceAction
from app.models.ticket import Ticket, TicketDeviceRun

logger = logging.getLogger(__name__)

# running 超过该秒数视为上次执行中断（Worker 崩溃/硬超时），标记失败交人工重试。
# 需大于设备调用的最大正常耗时（HTTP 超时上限），避免误杀仍在执行的任务。
STALE_RUNNING_SECONDS = 420


def _fail_run(db, run: TicketDeviceRun, error: str, status_code: int | None = None, latency_ms: int | None = None) -> None:
    run.status = "failed"
    run.error = str(error)[:2000]
    run.status_code = status_code
    run.latency_ms = latency_ms
    run.finished_at = beijing_now()
    run.updated_at = beijing_now()
    db.flush()


@celery_app.task(bind=True, name="ticket.execute_device_run", max_retries=0)
def execute_ticket_device_run(self, run_id: int) -> dict:
    """执行单条工单设备动作。

    幂等：成功/已撤销直接跳过；同一 run 不会因 Worker 并发重复调用设备。
    """
    db = SessionLocal()
    run = None
    try:
        run = (
            db.query(TicketDeviceRun)
            .filter(TicketDeviceRun.id == run_id)
            .with_for_update()
            .first()
        )
        if not run:
            return {"ok": False, "error": "执行记录不存在"}
        if run.status in ("success", "compensated"):
            return {"ok": True, "status": run.status, "idempotent": True}
        if run.status == "running":
            # task_acks_late：Worker 崩溃/超时后任务会重新投递。超过硬超时阈值仍停在
            # running 视为上次执行中断，标记失败交给人工重试；未超时则跳过（可能仍在执行）
            started = run.started_at
            stale = bool(started) and (beijing_now() - started).total_seconds() > STALE_RUNNING_SECONDS
            if not stale:
                return {"ok": False, "status": "running", "skipped": True}
            logger.warning("设备任务上次执行中断，标记失败待重试 run_id=%s", run.id)
            _fail_run(db, run, "上次执行中断（Worker 异常或超时），请重试")
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "status": run.status, "error": run.error}

        run.status = "running"
        run.attempts = int(run.attempts or 0) + 1
        run.started_at = beijing_now()
        run.finished_at = None
        run.error = None
        run.updated_at = beijing_now()
        db.commit()

        device = db.query(Device).filter(Device.id == run.device_id).first()
        action = (
            db.query(DeviceAction)
            .filter(DeviceAction.id == run.action_id, DeviceAction.device_id == run.device_id)
            .first()
        )
        if not device:
            _fail_run(db, run, "设备不存在或已删除")
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "error": run.error}
        if not bool(device.enabled):
            _fail_run(db, run, "设备已禁用")
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "error": run.error}
        if not action:
            _fail_run(db, run, "设备动作不存在或已删除")
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "error": run.error}
        if not bool(action.enabled):
            _fail_run(db, run, "设备动作已禁用")
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "error": run.error}

        # Worker 执行前再次按当前 schema 校验，防止模板发布后设备动作定义变更导致非法参数
        params, errors = prepare_device_params(
            parse_params_schema(action), dict(run.params or {}), check_required=False,
        )
        if errors:
            _fail_run(db, run, "；".join(errors))
            apply_run_to_node_record(db, run)
            db.commit()
            return {"ok": False, "error": run.error}

        from app.devices.action_executor import execute_device_action

        started = time.monotonic()
        call = execute_device_action(
            device,
            action,
            params,
            db=None,
            skip_log=True,
            source="ticket",
            user_id=run.created_by_id,
        )
        latency = int((time.monotonic() - started) * 1000)

        log = append_device_call_log(db, device, action, params, call, run.created_by_id)
        db.flush()
        run.call_log_id = getattr(log, "id", None)
        run.latency_ms = int(call.get("latency_ms") or latency)
        run.status_code = call.get("status_code")
        run.finished_at = beijing_now()
        run.updated_at = beijing_now()

        if call.get("success"):
            run.status = "success"
            run.error = None
            # 工作台同步独立 SAVEPOINT，失败不影响设备动作结果落库
            try:
                with db.begin_nested():
                    ticket = db.query(Ticket).filter(Ticket.id == run.ticket_id).first()
                    node = None
                    if ticket and isinstance(ticket.flow_snapshot, dict):
                        node = next(
                            (n for n in (ticket.flow_snapshot.get("nodes") or []) if n.get("key") == run.node_key),
                            None,
                        )
                    if ticket and node:
                        sync_device_outcome_to_workbench(db, ticket, node, device, action, params)
            except Exception:
                logger.exception("工单设备动作成功后同步工作台失败 run_id=%s", run.id)
        else:
            run.status = "failed"
            run.error = str(call.get("error") or "设备动作执行失败")[:2000]

        apply_run_to_node_record(db, run)
        db.commit()
        return {
            "ok": bool(call.get("success")),
            "status": run.status,
            "run_id": run.id,
            "error": run.error,
        }
    except Exception as exc:
        logger.exception("工单设备动作异步执行异常 run_id=%s", run_id)
        db.rollback()
        try:
            fresh = db.query(TicketDeviceRun).filter(TicketDeviceRun.id == run_id).with_for_update().first()
            if fresh and fresh.status not in ("success", "compensated"):
                _fail_run(db, fresh, f"执行异常：{exc}")
                apply_run_to_node_record(db, fresh)
                db.commit()
                return {"ok": False, "status": fresh.status, "error": fresh.error}
        except Exception:
            db.rollback()
            logger.exception("工单设备动作异常状态落库失败 run_id=%s", run_id)
        return {"ok": False, "error": str(exc)}
    finally:
        db.close()
