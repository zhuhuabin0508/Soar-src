import json
import logging
import re
from datetime import timedelta
from typing import Any, Optional

from app.core.ticket_flow import parse_duration
from app.core.timezone import beijing_now
from app.models.device import Device, DeviceAction, DeviceCallLog

logger = logging.getLogger(__name__)


def _pos_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def device_action_config(node: Optional[dict]) -> Optional[dict]:
    if not isinstance(node, dict):
        return None
    cfg = node.get("device_action")
    if cfg in (None, {}, ""):
        return None
    return cfg if isinstance(cfg, dict) else None


def parse_params_schema(action: DeviceAction) -> list[dict]:
    try:
        schema = json.loads(action.params_schema or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(schema, list):
        return []
    return [p for p in schema if isinstance(p, dict) and p.get("name")]


def prepare_device_params(schema: list[dict], raw: Any) -> tuple[dict, list[str]]:
    if raw in (None, {}):
        raw = {}
    if not isinstance(raw, dict):
        return {}, ["设备参数必须为对象"]
    by_name = {str(p["name"]): p for p in schema}
    errors: list[str] = []
    for key in raw:
        if str(key) not in by_name:
            errors.append(f"参数 {key} 不在该设备动作中")
    out: dict[str, Any] = {}
    for name, spec in by_name.items():
        label = spec.get("label") or spec.get("description") or name
        present = name in raw and raw.get(name) not in (None, "")
        if present:
            value = raw.get(name)
        else:
            value = spec.get("default")
            if value in (None, ""):
                value = None
        if value in (None, ""):
            if spec.get("required"):
                errors.append(f"参数「{label}」为必填")
            continue
        options = spec.get("options")
        if isinstance(options, list) and options and str(value) not in {str(o) for o in options}:
            errors.append(f"参数「{label}」的取值不在可选项中")
            continue
        ptype = str(spec.get("type") or "").lower()
        if ptype in ("ip", "cidr"):
            from app.core.ip_validation import IPValidationError, validate_ip_expression

            try:
                value = validate_ip_expression(str(value), str(label), allow_wildcard=False)
            except IPValidationError as exc:
                errors.append(str(exc))
                continue
        out[name] = value
    return out, errors


def resolve_device_action(db, cfg: dict) -> tuple[Optional[Device], Optional[DeviceAction], Optional[str]]:
    device_id = cfg.get("device_id")
    action_id = cfg.get("action_id")
    if not _pos_int(device_id) or not _pos_int(action_id):
        return None, None, "设备动作配置缺少设备或动作"
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None or not device.enabled:
        return None, None, "设备不存在或已禁用"
    action = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.id == action_id,
            DeviceAction.device_id == device_id,
            DeviceAction.enabled.is_(True),
        )
        .first()
    )
    if action is None:
        return device, None, "动作不存在、未启用或不属于该设备"
    return device, action, None


def _params_form(action: Optional[DeviceAction]) -> list[dict]:
    if action is None:
        return []
    params = []
    for spec in parse_params_schema(action):
        params.append({
            "name": str(spec.get("name")),
            "type": spec.get("type") or "string",
            "required": bool(spec.get("required")),
            "description": spec.get("description") or spec.get("label") or "",
            "default": spec.get("default") if spec.get("default") is not None else "",
            "options": spec.get("options") if isinstance(spec.get("options"), list) else [],
        })
    return params


def _describe_action(db, cfg: Any, extra: Optional[dict] = None) -> dict:
    extra = extra or {}
    if not isinstance(cfg, dict):
        return {**extra, "bound": True, "error": "设备动作配置不合法", "params": []}
    device, action, err = resolve_device_action(db, cfg)
    return {
        **extra,
        "bound": True,
        "device_id": cfg.get("device_id"),
        "action_id": cfg.get("action_id"),
        "device_name": device.name if device is not None else "",
        "action_name": action.name if action is not None else "",
        "action_type": action.action_type if action is not None else "",
        "params": _params_form(action),
        "error": err,
    }


def node_action_configs(node: Optional[dict]) -> list:
    if not isinstance(node, dict):
        return []
    raw = node.get("device_actions")
    if isinstance(raw, list) and raw:
        return list(raw)
    cfg = node.get("device_action")
    if cfg in (None, {}, ""):
        return []
    return [cfg]


def build_device_action_form(db, node: Optional[dict]) -> dict:
    configs = node_action_configs(node)
    if not configs:
        return {"bound": False}
    items = []
    for index, cfg in enumerate(configs):
        item = _describe_action(db, cfg, {"index": index})
        if isinstance(cfg, dict):
            item["judge_field"] = str(cfg.get("judge_field") or "")
            item["judge_value"] = "是" if cfg.get("judge_value") in (None, "") else str(cfg.get("judge_value"))
        else:
            item["judge_field"] = ""
            item["judge_value"] = "是"
        item["manual"] = not item["judge_field"]
        items.append(item)
    return {"bound": True, "mode": "actions", "items": items}


def history_field_values(records) -> dict:
    out: dict[str, Any] = {}
    for record in records or []:
        values = record.get("field_values") if isinstance(record, dict) else getattr(record, "field_values", None)
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            if value not in (None, ""):
                out[str(key)] = value
    return out


def judge_says_execute(item: dict, history: dict) -> bool:
    from app.core.ticket_flow import _normalize_cond_value

    field = str((item or {}).get("judge_field") or "").strip()
    if not field:
        return False
    expect = item.get("judge_value")
    if expect in (None, ""):
        expect = "是"
    actual = _normalize_cond_value(history.get(field))
    expected = _normalize_cond_value(expect)
    if actual is None or (isinstance(actual, str) and not str(actual).strip()):
        return False
    return str(actual) == str(expected)


def annotate_device_form(form: dict, records, current_values: Optional[dict] = None) -> dict:
    """为设备动作表单补充判断结果。

    - current_values：当前节点本次提交的表单值（新语义：判断字段引用本节点字段，
      处理人填写后实时联动）。命中优先级：本次提交值 > 历史记录值（存量模板兼容：
      旧配置的判断字段可能引用前面节点，仍从历史记录取值）。
    """
    from app.core.ticket_flow import _normalize_cond_value

    if not form.get("bound"):
        return form
    history = history_field_values(records)
    if isinstance(current_values, dict):
        for key, value in current_values.items():
            if value not in (None, ""):
                history[str(key)] = value
    items = []
    for item in form.get("items") or []:
        actual = _normalize_cond_value(history.get(str(item.get("judge_field") or "")))
        copied = dict(item)
        copied["manual"] = not str((item or {}).get("judge_field") or "").strip()
        copied["judge_actual"] = "" if actual is None else str(actual)
        copied["execute"] = judge_says_execute(item, history)
        items.append(copied)
    return {**form, "items": items}


def _log_fields(device: Device, action: DeviceAction, params: dict, call: dict, user_id: Optional[int]) -> dict:
    body = call.get("response_body")
    try:
        response_summary = json.dumps(body, ensure_ascii=False)[:2000]
    except (TypeError, ValueError):
        response_summary = str(body)[:2000] if body is not None else None
    return dict(
        device_id=device.id,
        device_name=device.name or "",
        action_id=action.id,
        action_name=action.name or "",
        source="ticket",
        request_summary=json.dumps({"params": params}, ensure_ascii=False)[:2000],
        response_summary=response_summary,
        status="success" if call.get("success") else "failed",
        status_code=call.get("status_code"),
        latency_ms=call.get("latency_ms"),
        error_message=None if call.get("success") else (call.get("error") or "设备动作执行失败"),
        user_id=user_id,
    )


def log_failed_device_call(device: Device, action: DeviceAction, params: dict, call: dict, user_id: Optional[int]) -> None:
    from app.database import SessionLocal

    session = SessionLocal()
    try:
        session.add(DeviceCallLog(**_log_fields(device, action, params, call, user_id)))
        session.commit()
    except Exception:
        logger.exception("写入失败的设备调用日志失败")
        session.rollback()
    finally:
        session.close()


def append_device_call_log(db, device: Device, action: DeviceAction, params: dict, call: dict, user_id: Optional[int]) -> None:
    db.add(DeviceCallLog(**_log_fields(device, action, params, call, user_id)))


def run_ticket_device_action(db, node: dict, raw_params: Any, *, user_id: Optional[int]) -> dict:
    from app.devices.action_executor import execute_device_action

    cfg = device_action_config(node) or {}
    device, action, err = resolve_device_action(db, cfg)
    if err or device is None or action is None:
        return {"ok": False, "status": 400, "detail": err or "设备动作不可用"}
    params, errors = prepare_device_params(parse_params_schema(action), raw_params)
    if errors:
        return {"ok": False, "status": 422, "detail": "；".join(errors)}
    try:
        call = execute_device_action(
            device, action, dict(params),
            db=None, skip_log=True, source="ticket", user_id=user_id,
        )
    except Exception as exc:
        logger.exception("工单下发设备动作异常")
        call = {"success": False, "status_code": None, "response_body": None, "error": str(exc), "latency_ms": 0}
    if not call.get("success"):
        log_failed_device_call(device, action, params, call, user_id)
        return {"ok": False, "status": 400, "detail": call.get("error") or "设备动作执行失败"}
    record = {
        "skipped": False,
        "device_id": device.id,
        "device_name": device.name,
        "action_id": action.id,
        "action_name": action.name,
        "action_type": action.action_type,
        "params": params,
        "success": True,
        "status_code": call.get("status_code"),
        "error": None,
    }
    return {"ok": True, "device": device, "action": action, "params": params, "call": call, "record": record}


def _duration_to_ban(raw: Any) -> tuple[bool, int]:
    text = str(raw if raw is not None else "").strip()
    if text in ("0", "-1", "永久"):
        return True, 0
    if re.fullmatch(r"-?\d+", text):
        seconds = int(text)
        if seconds <= 0:
            return True, 0
        return False, seconds
    return parse_duration(text)


def sync_block_ip_record(db, ticket, node: dict, device: Device, params: dict) -> None:
    from app.core.ip_validation import IPValidationError, validate_ban_target
    from app.models.workflow_ban import BanRecord

    raw_ip = params.get("ip")
    if raw_ip in (None, ""):
        return
    try:
        ip = validate_ban_target(str(raw_ip), "封禁目标")
    except IPValidationError:
        logger.warning("工单设备封禁台账跳过（IP 非法）: ticket=%s", ticket.ticket_no)
        return
    node_key = str(node.get("key") or "")
    dup = (
        db.query(BanRecord)
        .filter(BanRecord.ticket_id == ticket.id, BanRecord.ticket_node == node_key)
        .first()
    )
    if dup is not None:
        return
    permanent, seconds = _duration_to_ban(params.get("duration"))
    if not permanent and seconds < 0:
        logger.warning("工单设备封禁台账跳过（时长非法）: ticket=%s", ticket.ticket_no)
        return
    now = beijing_now()
    db.add(BanRecord(
        ip=ip,
        ban_level="medium",
        ban_duration=0 if permanent else seconds,
        is_permanent=permanent,
        expire_time=None if permanent else now + timedelta(seconds=seconds),
        reason=f"工单同步：{ticket.title}",
        ban_source="ticket",
        status="active",
        ticket_id=ticket.id,
        ticket_no=ticket.ticket_no,
        ticket_node=node_key,
        ban_device=device.name or None,
    ))


# ============ 工作台同步分发 ============
# 按设备动作类型（action_type）注册同步 handler：动作执行成功后，
# 对应类型的信息自动同步到工作台对应模块。后续新动作类型要接入工作台，
# 在此注册即可，工单流转侧代码无需改动。
_WORKBENCH_SYNC_HANDLERS = {
    "block_ip": sync_block_ip_record,  # 封禁 IP → 工作台「已封禁 IP」列表（BanRecord）
}


def sync_device_outcome_to_workbench(
    db, ticket, node: dict, device: Device, action: DeviceAction, params: dict,
) -> bool:
    """设备动作执行成功后按动作类型同步信息到工作台。

    - 返回 True 表示该动作类型已注册同步且已执行；未注册的类型不做任何事
    - 调用方应将其置于独立 SAVEPOINT 中：同步失败仅回滚自身，不阻塞工单流转
    """
    handler = _WORKBENCH_SYNC_HANDLERS.get(str(action.action_type or ""))
    if handler is None:
        return False
    handler(db, ticket, node, device, params)
    return True
