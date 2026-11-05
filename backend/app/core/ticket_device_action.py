import json
import logging
import re
from datetime import timedelta
from typing import Any, Optional

from app.core.ticket_flow import parse_duration
from app.core.timezone import beijing_now
from app.models.device import Device, DeviceAction, DeviceCallLog

logger = logging.getLogger(__name__)

# 时长类参数兜底上限（10 年）：schema 未显式配置 max 时防止误传超大值；
# 具体设备上限可在动作 params_schema 中为参数配置 {"max": 秒数} 精确收紧
MAX_DEVICE_DURATION_SECONDS = 10 * 365 * 24 * 3600


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


def prepare_device_params(schema: list[dict], raw: Any, *, check_required: bool = True) -> tuple[dict, list[str]]:
    """校验并整理设备参数。

    ``check_required=False``：必填校验已由调用方完成（如定稿阶段），避免重复报错。
    """
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
            if spec.get("required") and check_required:
                errors.append(f"参数「{label}」为必填")
            continue
        options = spec.get("options")
        if isinstance(options, list) and options and str(value) not in {str(o) for o in options}:
            errors.append(f"参数「{label}」的取值不在可选项中")
            continue
        ptype = str(spec.get("type") or "").lower()
        # 时长类参数：即使设备 schema 标成 string（如安博通 duration），也按名字做统一校验/归一
        is_duration = ptype == "duration" or name.lower() in ("duration", "expire", "ttl", "age")
        if ptype in ("ip", "cidr"):
            from app.core.ip_validation import IPValidationError, validate_ip_expression

            try:
                value = validate_ip_expression(str(value), str(label), allow_wildcard=False)
            except IPValidationError as exc:
                errors.append(str(exc))
                continue
        elif is_duration:
            # 时长参数：接受 永久/45分钟/12小时/3天/纯秒数，统一转换为设备侧取值（-1=永久，否则秒数字符串）
            # 错误提示优先取描述冒号前的短标签，避免把整段参数说明塞进报错
            d_label = str(spec.get("label") or spec.get("description") or name).split("：")[0].strip() or name
            text = str(value).strip()
            if re.fullmatch(r"-?\d+(\.\d+)?", text):
                seconds = float(text)
                value = "-1" if seconds <= 0 else str(int(seconds) if seconds == int(seconds) else seconds)
            else:
                permanent, seconds = parse_duration(text)
                if not permanent and seconds < 0:
                    errors.append(f"参数「{d_label}」的时长格式无法识别（支持：永久、45分钟、12小时、3天 或秒数）")
                    continue
                value = "-1" if permanent else str(seconds)
            # 上限预校验：优先用 schema 的 max（设备允许的最大秒数），否则用全局兜底上限
            if value != "-1":
                raw_limit = spec.get("max")
                try:
                    limit = float(raw_limit) if raw_limit not in (None, "") else MAX_DEVICE_DURATION_SECONDS
                    if float(value) > limit:
                        errors.append(f"参数「{d_label}」的时长超出上限 {int(limit)} 秒（-1 表示永久）")
                        continue
                except (TypeError, ValueError):
                    pass
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
            # 时长/数值类参数上限（秒），供前端输入即时提示；后端提交时仍强制校验
            "max": spec.get("max"),
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


# 参数配置：{参数名: {display: editable/readonly/hidden, default_template: 含变量的模板}}
# display 控制工单详情页展示样式；default_template 支持占位符（resolve_param_template 解析）
def normalized_param_config(cfg: Any) -> dict:
    raw = cfg.get("param_config") if isinstance(cfg, dict) else None
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict] = {}
    for pname, item in raw.items():
        if not str(pname or "").strip() or not isinstance(item, dict):
            continue
        display = str(item.get("display") or "").strip()
        if display not in ("editable", "readonly", "hidden"):
            continue
        entry = {"display": display}
        template = str(item.get("default_template") or "").strip()
        if template:
            entry["default_template"] = template[:200]
        out[str(pname)] = entry
    return out


# reason 参数内置默认：未配置 param_config 的动作，封禁原因自动 隐藏 + 工单同步：{ticket_no}
# （工单详情扩展面板不渲染该参数，提交时仍按模板自动填充下发设备）
_BUILTIN_REASON_CONFIG = {"display": "hidden", "default_template": "工单同步：{ticket_no}"}

_TEMPLATE_VAR_RE = re.compile(r"\{(ticket_no|ticket_title|creator|node|f:[A-Za-z0-9_]+)\}")


def resolve_param_template(template: Any, ctx: Optional[dict]) -> str:
    """解析默认值模板中的变量占位符。

    支持：{ticket_no} {ticket_title} {creator} {node} {f:字段key}；
    未识别的占位符原样保留；解析不到值的占位符置空。
    ctx: {ticket_no, ticket_title, creator, node, field_values}
    """
    text = str(template or "")
    if not text or "{" not in text:
        return text
    ctx = ctx or {}

    def _sub(m: "re.Match") -> str:
        var = m.group(1)
        if var.startswith("f:"):
            value = (ctx.get("field_values") or {}).get(var[2:])
        else:
            value = ctx.get(var)
        if value in (None, ""):
            return ""
        return str(value)

    return _TEMPLATE_VAR_RE.sub(_sub, text)


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
        # 参数快捷选项：模板配置的 {参数名: [{label, value}]}，随表单下发供工单详情页渲染快捷下拉
        presets = cfg.get("param_presets") if isinstance(cfg, dict) else None
        if isinstance(presets, dict) and presets:
            item["param_presets"] = presets
            for p in item.get("params") or []:
                plist = presets.get(str(p.get("name") or ""))
                if isinstance(plist, list):
                    p["presets"] = [x for x in plist if isinstance(x, dict) and str(x.get("label") or "").strip()]
        # 旧版参数映射（参数名 → 字段 key）：字段值经此进入设备参数，前端据此预填
        field_map = cfg.get("params") if isinstance(cfg, dict) else None
        if isinstance(field_map, dict) and field_map:
            item["param_field_map"] = {
                str(k): str(v) for k, v in field_map.items() if str(k).strip() and str(v).strip()
            }
        # 参数配置（展示样式 + 默认值模板）：每个参数附 display / default_template（原始模板，工单侧解析）
        pconf = normalized_param_config(cfg)
        if pconf:
            item["param_config"] = pconf
        # 内置封禁原因只接管封禁动作，且参数名必须是 reason：解封/查询等动作的 reason 保持可编辑
        builtin_reason = str(item.get("action_type") or "") == "block_ip"
        for p in item.get("params") or []:
            pname = str(p.get("name") or "")
            entry = pconf.get(pname)
            if entry is None and pname == "reason" and builtin_reason:
                # 内置默认：未配置的封禁原因自动 隐藏 + 工单同步：{ticket_no}
                entry = _BUILTIN_REASON_CONFIG
            elif (pname == "reason" and builtin_reason and entry is not None
                  and not entry.get("default_template")
                  and entry.get("display") in ("readonly", "hidden")):
                # 仅配置了展示方式、未配置默认值模板时，回填内置的工单同步原因，避免落到动作默认「API添加」
                entry = {**_BUILTIN_REASON_CONFIG, "display": entry.get("display")}
            if entry is not None:
                p["display"] = entry.get("display") or "editable"
                if entry.get("default_template"):
                    p["default_template"] = entry["default_template"]
            else:
                p["display"] = "editable"
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


def build_field_context(records, current_values: Optional[dict] = None) -> dict:
    """模板字段上下文：历史记录值 + 本次提交值。

    本次提交按「键是否出现」覆盖历史值，``""`` / ``0`` / ``False`` 都算出现，
    不能用真值判断，否则本节点清空的值会被历史值或模板盖回去。
    """
    ctx = history_field_values(records)
    if isinstance(current_values, dict):
        for key in current_values:
            ctx[str(key)] = current_values.get(key)
    return ctx


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value == "")


def finalize_device_params(
    item: dict,
    raw_params: Any,
    *,
    overridden: Optional[list] = None,
    ctx: Optional[dict] = None,
) -> tuple[dict, list[str]]:
    """按参数配置定稿本次要下发的设备参数。

    - ``readonly`` / ``hidden``：忽略请求里的值，只用默认值模板（无模板用 schema 默认值）
    - ``editable``：处理人改过的参数（``overridden``）用其输入；否则模板，再否则 schema 默认值；
      没有模板的普通参数仍用请求里提交的非空值
    """
    specs = [p for p in (item or {}).get("params") or [] if isinstance(p, dict) and p.get("name")]
    if raw_params in (None, {}):
        raw_params = {}
    if not isinstance(raw_params, dict):
        return {}, ["设备参数必须为对象"]
    overridden_names = {str(x) for x in (overridden or [])}
    params: dict[str, Any] = {}
    errors: list[str] = []
    for spec in specs:
        name = str(spec.get("name"))
        label = spec.get("description") or spec.get("label") or name
        display = str(spec.get("display") or "editable")
        template = str(spec.get("default_template") or "")
        default = spec.get("default")
        if display in ("readonly", "hidden"):
            value = resolve_param_template(template, ctx) if template else None
            if _blank(value):
                value = default
        elif name in overridden_names:
            value = raw_params.get(name)
        elif template:
            value = resolve_param_template(template, ctx)
            if _blank(value):
                value = default
        elif name in raw_params and not _blank(raw_params.get(name)):
            value = raw_params.get(name)
        else:
            value = default
        if _blank(value):
            if spec.get("required"):
                errors.append(f"参数「{label}」（{name}）为必填")
            continue
        params[name] = value
    return params, errors


def _action_label(item: dict) -> str:
    return f"{item.get('device_name') or '设备'} / {item.get('action_name') or '动作'}"


def prepare_device_run(
    db,
    item: dict,
    raw_params: Any,
    *,
    overridden: Optional[list] = None,
    ctx: Optional[dict] = None,
) -> tuple[Optional[dict], list[str]]:
    """定稿 + 校验单个动作参数，返回可执行计划（不调用设备）。"""
    label = _action_label(item)
    device, action, err = resolve_device_action(
        db, {"device_id": item.get("device_id"), "action_id": item.get("action_id")}
    )
    if err or device is None or action is None:
        return None, [f"「{label}」{err or '设备动作不可用'}"]
    params, errors = finalize_device_params(item, raw_params, overridden=overridden, ctx=ctx)
    # 定稿失败（如必填模板为空）不提前返回，继续校验其余参数，一次返回该动作的全部错误
    params, prepare_errors = prepare_device_params(
        parse_params_schema(action), params, check_required=False,
    )
    errors.extend(prepare_errors)
    if errors:
        return None, [f"「{label}」{e}" for e in errors]
    return {
        "index": item.get("index"),
        "label": label,
        "device": device,
        "action": action,
        "params": params,
    }, []


def plan_device_runs(
    db,
    items: list[dict],
    runs: dict,
    ctx: Optional[dict] = None,
) -> tuple[list[dict], list[str]]:
    """先对全部待执行动作定稿并校验参数；任一失败返回全部错误且不产生计划。"""
    plans: list[dict] = []
    errors: list[str] = []
    for item in items or []:
        run = (runs or {}).get(item.get("index"))
        if run is None:
            run = {}
        params = run.get("params") if isinstance(run, dict) else getattr(run, "params", None)
        overridden = run.get("overridden_params") if isinstance(run, dict) else getattr(run, "overridden_params", None)
        plan, item_errors = prepare_device_run(
            db, item, params or {}, overridden=overridden or [], ctx=ctx,
        )
        errors.extend(item_errors)
        if plan is not None:
            plans.append(plan)
    if errors:
        return [], errors
    return plans, []


def _execute_device_plan(db, plan: dict, *, user_id: Optional[int]) -> dict:
    from app.devices.action_executor import execute_device_action

    device, action, params = plan["device"], plan["action"], plan["params"]
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


def execute_prepared_runs(
    db,
    items: list[dict],
    runs: dict,
    ctx: Optional[dict] = None,
    *,
    user_id: Optional[int],
) -> tuple[list[dict], list[str]]:
    """全部参数校验通过后才逐个调用设备；校验失败时设备调用次数为 0。"""
    plans, errors = plan_device_runs(db, items, runs, ctx)
    if errors:
        return [], errors
    return [_execute_device_plan(db, plan, user_id=user_id) for plan in plans], []


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


def append_device_call_log(db, device: Device, action: DeviceAction, params: dict, call: dict, user_id: Optional[int]):
    log = DeviceCallLog(**_log_fields(device, action, params, call, user_id))
    db.add(log)
    return log


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


def ban_record_reason(params: Any, ticket_no: str) -> str:
    """封禁台账原因：与下发给设备的 reason 一致，没有该参数时回退工单同步文案。"""
    text = str((params or {}).get("reason") or "").strip() if isinstance(params, dict) else ""
    return text or f"工单同步：{ticket_no}"


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
        reason=ban_record_reason(params, ticket.ticket_no),
        ban_source="ticket",
        status="active",
        ticket_id=ticket.id,
        ticket_no=ticket.ticket_no,
        ticket_node=node_key,
        ban_device=device.name or None,
    ))


def sync_unblock_ip_record(db, ticket, node: dict, device: Device, params: dict) -> None:
    """解封成功：把同工单对应封禁台账标记为已解封（撤销补偿）。"""
    from app.core.ip_validation import IPValidationError, validate_ban_target
    from app.models.workflow_ban import BanRecord

    raw = params.get("blist") or params.get("ip")
    if raw in (None, ""):
        return
    try:
        ip = validate_ban_target(str(raw), "解封目标")
    except IPValidationError:
        logger.warning("工单设备解封台账跳过（目标非法）: ticket=%s", ticket.ticket_no)
        return
    now = beijing_now()
    records = (
        db.query(BanRecord)
        .filter(
            BanRecord.ip == ip,
            BanRecord.ticket_id == ticket.id,
            BanRecord.status.in_(["active", "pending_sync", "syncing", "pending_approval"]),
        )
        .all()
    )
    for record in records:
        record.status = "unbanned"
        record.unban_reason = "工单撤销封禁"
        record.unban_operator = f"ticket:{ticket.ticket_no}"[:64]
        record.unban_time = now


# ============ 工作台同步分发 ============
# 按设备动作类型（action_type）注册同步 handler：动作执行成功后，
# 对应类型的信息自动同步到工作台对应模块。后续新动作类型要接入工作台，
# 在此注册即可，工单流转侧代码无需改动。
_WORKBENCH_SYNC_HANDLERS = {
    "block_ip": sync_block_ip_record,  # 封禁 IP → 工作台「已封禁 IP」列表（BanRecord）
    "unblock_ip": sync_unblock_ip_record,  # 解封 IP → 对应工单封禁台账标记已解封（撤销补偿）
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
