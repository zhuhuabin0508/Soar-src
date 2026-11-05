"""工单设备动作异步执行：运行记录、排队与节点结果回写。

设计要点：
- 提交时只做参数定稿/校验并落库，设备 HTTP 调用交给 Celery Worker；
- ``ticket_device_runs`` 每行对应一个“节点记录 + 动作槽位”，唯一约束保证重复提交不重复下发；
- 重试复用同一行并累计 attempts；失败项可单独重试，成功封禁可发起撤销/补偿。
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm.attributes import flag_modified

from app.core.timezone import beijing_now, to_beijing_iso
from app.models.ticket import TicketDeviceRun, TicketNodeRecord

logger = logging.getLogger(__name__)


def plan_to_run(plan: dict, params: dict | None = None) -> dict:
    """把 ``plan_device_runs`` 的计划转为可落库字段。"""
    device = plan["device"]
    action = plan["action"]
    return {
        "device_id": device.id,
        "action_id": action.id,
        "device_name": device.name or "",
        "action_name": action.name or "",
        "action_type": action.action_type or "",
        "params": dict(plan.get("params") or params or {}),
    }


def create_runs_for_plans(
    db,
    ticket,
    node_record: TicketNodeRecord,
    plans: list[dict],
    result_items: list[dict],
    *,
    created_by_id: Optional[int],
    created_by_name: str = "",
) -> list[TicketDeviceRun]:
    """按计划创建执行记录，并把 run_id 回填到节点 device_result 的对应条目。"""
    runs: list[TicketDeviceRun] = []
    by_index = {int(it.get("index")): it for it in result_items}
    for plan in plans:
        spec = plan_to_run(plan)
        index = int(plan.get("index"))
        run = TicketDeviceRun(
            ticket_id=ticket.id,
            node_record_id=node_record.id,
            node_key=node_record.node_key,
            node_name=node_record.node_name,
            action_index=index,
            kind="execute",
            status="queued",
            attempts=0,
            idempotency_key=f"{ticket.id}:{node_record.id}:{index}:execute",
            created_by_id=created_by_id,
            created_by_name=created_by_name or "",
            updated_at=beijing_now(),
            **spec,
        )
        db.add(run)
        db.flush()
        runs.append(run)
        item = by_index.get(index)
        if item is not None:
            item["run_id"] = run.id
    node_record.device_result = {"items": result_items}
    flag_modified(node_record, "device_result")
    return runs


def enqueue_run(run_id: int) -> bool:
    """提交 Celery 任务；失败时返回 False，由调用方标记为可重试。"""
    try:
        from app.tasks.ticket_device_tasks import execute_ticket_device_run
        execute_ticket_device_run.delay(run_id)
        return True
    except Exception:
        logger.exception("工单设备动作任务排队失败 run_id=%s", run_id)
        return False


def mark_enqueue_failed(run_id: int, error: str) -> None:
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        run = (
            db.query(TicketDeviceRun)
            .filter(TicketDeviceRun.id == run_id)
            .with_for_update()
            .first()
        )
        if not run:
            return
        # 防御：delay 抛异常不代表消息未被 broker 接收（publish 超时类失败），
        # Worker 可能已执行成功；已到终态的 run 不回退为 failed，
        # 避免覆盖真实结果、诱导人工重试导致设备动作重复下发
        if run.status in ("success", "compensated"):
            return
        run.status = "failed"
        run.error = error
        run.finished_at = beijing_now()
        run.updated_at = beijing_now()
        db.commit()
        apply_run_to_node_record(db, run)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("标记设备任务排队失败异常 run_id=%s", run_id)
    finally:
        db.close()


def _success_value(status: str) -> Optional[bool]:
    if status in ("success", "compensated"):
        return True
    if status == "failed":
        return False
    return None


def _read_items(data) -> tuple[list[dict], bool]:
    """读取节点 device_result（兼容单对象与 {"items": [...]} 两种存量格式）。"""
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return list(data["items"]), True
    if isinstance(data, dict) and data:
        return [dict(data)], False
    return [], True


def apply_run_to_node_record(db, run: TicketDeviceRun) -> None:
    """把执行记录状态写回节点 ``device_result``，供时间线实时展示。"""
    record = db.query(TicketNodeRecord).filter(TicketNodeRecord.id == run.node_record_id).first()
    if not record:
        return
    items, wrapped = _read_items(record.device_result)
    target = next((it for it in items if int(it.get("index", -1)) == int(run.action_index)), None)
    if target is None:
        target = {"index": run.action_index, "skipped": False}
        items.append(target)

    target.update({
        "index": run.action_index,
        "run_id": run.id,
        "kind": run.kind,
        "device_id": run.device_id,
        "action_id": run.action_id,
        "device_name": run.device_name,
        "action_name": run.action_name,
        "action_type": run.action_type,
        "params": run.params or {},
        "attempts": run.attempts,
        "status": run.status,
        "success": _success_value(run.status),
        "status_code": run.status_code,
        "error": run.error,
        "latency_ms": run.latency_ms,
        "finished_at": to_beijing_iso(run.finished_at) if run.finished_at else None,
    })

    # 撤销动作成功后，把原封禁记录标记为已撤销（含原节点时间线条目）
    if run.kind == "compensate" and run.compensation_of_run_id:
        orig = (
            db.query(TicketDeviceRun)
            .filter(TicketDeviceRun.id == run.compensation_of_run_id)
            .first()
        )
        if orig is not None:
            if run.status == "success":
                orig.status = "compensated"
                orig.updated_at = beijing_now()
                target["compensated_by_run_id"] = run.id
                _mark_run_item(db, orig, "compensated", compensated_by_run_id=run.id)
            elif run.status == "failed":
                target["compensation_error"] = run.error

    record.device_result = {"items": items} if wrapped else (items[0] if items else None)
    flag_modified(record, "device_result")


def _mark_run_item(db, run: TicketDeviceRun, status: str, **extra) -> None:
    """更新某条执行记录在原节点 device_result 中对应条目的状态。"""
    record = db.query(TicketNodeRecord).filter(TicketNodeRecord.id == run.node_record_id).first()
    if not record:
        return
    items, wrapped = _read_items(record.device_result)
    for item in items:
        if int(item.get("index", -1)) != int(run.action_index):
            continue
        item["status"] = status
        item["success"] = _success_value(status)
        if extra:
            item.update(extra)
        break
    else:
        return
    record.device_result = {"items": items} if wrapped else (items[0] if items else None)
    flag_modified(record, "device_result")
