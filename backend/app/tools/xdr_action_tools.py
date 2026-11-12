"""深信服 XDR 设备动作智能体工具包（统一调用入口）。

设计要点：
- 工具定义由 ``app.core.tools.definitions.xdr_actions`` 从内置动作清单
  （``SANGFOR_XDR_ACTIONS``）自动生成：一个动作对应一个工具，工具名由
  API 路径生成（如 ``/alerts/list`` → ``xdr_alerts_list``）。
- 所有工具共用本模块的 ``run_xdr_action``：按 action_key 解析 XDR 设备与
  DeviceAction，复用 ``execute_device_action`` 完成 AK/SK 签名、超时、重试与
  调用日志（source='agent'），不重复实现认证协议。
- 返回值统一为结构化结果（ok/status/http_status/code/message/data/error/
  latency_ms/device/action），便于智能体直接解析与决策。

沙箱中的工具代码通过 tool_runner 注入的 ``run_xdr_action`` 调用本模块，
不直接 import（工具沙箱禁止 import）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone as _dt_timezone
from typing import Any, Optional

from app.core.sangfor_xdr_actions import SANGFOR_XDR_ACTIONS
from app.database import SessionLocal
from app.devices.action_executor import _HIGH_RISK_LEVELS, execute_device_action
from app.models.device import Device, DeviceAction

logger = logging.getLogger(__name__)

XDR_AUTH_TYPE = "sangfor_xdr"

_CAMEL_BOUNDARY_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def build_action_key(api_path: str) -> str:
    """把 XDR API 路径转换为稳定的工具名（action_key）。

    例：``/api/xdr/v1/alerts/list`` → ``xdr_alerts_list``；
    ``/api/xdr/v1/alerts/countFusion`` → ``xdr_alerts_count_fusion``。
    """
    parts = [p for p in (api_path or "").strip("/").split("/") if p]
    if parts[:2] == ["api", "xdr"]:
        parts = parts[2:]
    if parts and parts[0] == "v1":
        parts = parts[1:]
    name = _CAMEL_BOUNDARY_RE.sub("_", "_".join(parts))
    name = re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()
    return f"xdr_{name}" if name else "xdr_action"


def _example_dict(action_def: dict[str, Any]) -> Optional[dict]:
    """解析示例请求体（example_payload 可能带 'POST /path' 前缀）。"""
    raw = action_def.get("example_payload") or ""
    start = raw.find("{")
    if start < 0:
        return None
    try:
        data = json.loads(raw[start:])
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _walk_keys(value: Any, acc: set[str]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            acc.add(k)
            _walk_keys(v, acc)
    elif isinstance(value, list):
        for v in value:
            _walk_keys(v, acc)


def _split_nested_params(
    action_def: dict[str, Any], params: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[str]]:
    """剔除被错误平铺到顶层的嵌套字段。

    内置动作的 params_schema 含少量文档子结构字段（如 ``aggFuncs`` 下的
    name/func/param、``areaInfos`` 下的 areaName/branchIds）。它们被标注为
    required 但不是顶层请求参数，若按 schema 下发会导致请求体字段错位。
    此处以 example_payload 为准：既不在示例顶层、又出现在示例嵌套结构中的
    字段判定为嵌套字段，从顶层参数中剔除。
    """
    example = _example_dict(action_def)
    if not example:
        return params, []
    top_keys = set(example.keys())
    all_keys: set[str] = set()
    _walk_keys(example, all_keys)
    nested_only = all_keys - top_keys

    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    for p in params:
        name = p["name"]
        if name not in top_keys and name in nested_only:
            dropped.append(name)
        else:
            kept.append(p)
    return kept, dropped


def _build_action_index() -> tuple[
    dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, list[str]]
]:
    by_key: dict[str, dict[str, Any]] = {}
    schemas: dict[str, list[dict[str, Any]]] = {}
    nested: dict[str, list[str]] = {}
    for action_def in SANGFOR_XDR_ACTIONS:
        key = build_action_key(action_def["api_path"])
        by_key[key] = action_def
        raw_params = [
            p
            for p in (action_def.get("params_schema") or [])
            if isinstance(p, dict) and p.get("name")
        ]
        kept, dropped = _split_nested_params(action_def, raw_params)
        schemas[key] = kept
        nested[key] = dropped
    return by_key, schemas, nested


XDR_ACTION_DEFINITIONS, XDR_ACTION_PARAM_SCHEMAS, XDR_ACTION_NESTED_FIELDS = (
    _build_action_index()
)
XDR_ACTION_KEYS: list[str] = list(XDR_ACTION_DEFINITIONS.keys())


class XdrToolError(Exception):
    """工具层可预期的失败（参数/设备/权限等），携带结构化错误信息。"""

    def __init__(
        self,
        error_type: str,
        message: str,
        *,
        retryable: bool = False,
        details: Optional[dict] = None,
    ) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.retryable = retryable
        self.details = details or {}


def get_action_definition(action_key: str) -> dict[str, Any]:
    """按工具名取动作定义；不存在时抛 XdrToolError。"""
    action_def = XDR_ACTION_DEFINITIONS.get(action_key)
    if action_def is None:
        raise XdrToolError(
            "unknown_action",
            f"未知的 XDR 动作: {action_key}",
            details={"available_actions": XDR_ACTION_KEYS},
        )
    return action_def


def _coerce_value(param: dict[str, Any], value: Any) -> Any:
    """按 params_schema 的类型声明转换/校验单个参数值。"""
    type_name = str(param.get("type") or "string").lower()
    label = param.get("label") or param.get("name")

    if type_name in ("integer", "int", "long"):
        if isinstance(value, bool):
            raise ValueError(f"参数「{label}」必须是整数")
        if isinstance(value, float):
            if not value.is_integer():
                raise ValueError(f"参数「{label}」必须是整数，当前值: {value!r}")
            return int(value)
        if isinstance(value, int):
            return value
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            raise ValueError(f"参数「{label}」必须是整数，当前值: {value!r}") from None

    if type_name in ("number", "float", "double"):
        if isinstance(value, bool):
            raise ValueError(f"参数「{label}」必须是数字")
        try:
            return float(str(value).strip()) if isinstance(value, str) else float(value)
        except (TypeError, ValueError):
            raise ValueError(f"参数「{label}」必须是数字，当前值: {value!r}") from None

    if type_name in ("boolean", "bool"):
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1", "yes", "y", "是"):
            return True
        if text in ("false", "0", "no", "n", "否"):
            return False
        raise ValueError(f"参数「{label}」必须是布尔值（true/false），当前值: {value!r}")

    if type_name in ("array", "list"):
        parsed = value
        if isinstance(parsed, str):
            try:
                parsed = json.loads(parsed)
            except ValueError:
                raise ValueError(f"参数「{label}」必须是合法的 JSON 数组") from None
        if not isinstance(parsed, list):
            raise ValueError(f"参数「{label}」必须是 JSON 数组")
        return parsed

    if type_name in ("object", "json", "dict"):
        parsed = value
        if isinstance(parsed, str):
            try:
                parsed = json.loads(parsed)
            except ValueError:
                raise ValueError(f"参数「{label}」必须是合法的 JSON 对象") from None
        if not isinstance(parsed, dict):
            raise ValueError(f"参数「{label}」必须是 JSON 对象")
        return parsed

    # string / ip / cidr 及其他类型统一按字符串处理
    return value if isinstance(value, str) else str(value)


def validate_action_params(
    action_key: str, params: Optional[dict[str, Any]]
) -> dict[str, Any]:
    """校验并规整工具入参（必填、类型、枚举、未知参数）。

    Returns:
        规整后的参数（仅包含 schema 中声明的参数；未传的可选参数若
        schema 声明了非空默认值则在本层回填——无 body_template 的动作
        执行器不会合并默认值，需在此补齐，保证与工具参数描述的
        “（默认值: …）”口径一致）。

    Raises:
        XdrToolError: validation_error，details 含 missing/invalid/unknown。
    """
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise XdrToolError("validation_error", "params 必须是 JSON 对象")

    schema_params = XDR_ACTION_PARAM_SCHEMAS.get(action_key) or []
    schema = {p["name"]: p for p in schema_params}
    cleaned: dict[str, Any] = {}
    missing: list[str] = []
    invalid: dict[str, str] = {}
    unknown: list[str] = []

    for name, param in schema.items():
        default = param.get("default")
        # 空容器默认值（[] / {} / 空串）不回填：与不下发语义相同，
        # 避免请求体膨胀；其余非空默认值在本层回填
        has_default = (
            default is not None and default != "" and default not in ([], {})
        )
        if name not in params:
            if param.get("required") and not has_default:
                missing.append(name)
            elif has_default:
                cleaned[name] = default
            continue
        value = params[name]
        if value is None or (isinstance(value, str) and not value.strip()):
            # 空值视为未填写：有默认值回填默认值，避免覆盖成空串
            if param.get("required") and not has_default:
                missing.append(name)
            elif has_default:
                cleaned[name] = default
            continue
        try:
            coerced = _coerce_value(param, value)
        except ValueError as exc:
            invalid[name] = str(exc)
            continue
        enum = param.get("enum")
        if isinstance(enum, list) and enum:
            allowed = [str(v) for v in enum]
            if str(coerced) not in allowed:
                invalid[name] = f"参数「{param.get('label') or name}」取值必须是 {enum} 之一"
                continue
        cleaned[name] = coerced

    unknown = [k for k in params.keys() if k not in schema]

    if missing or invalid or unknown:
        parts: list[str] = []
        if missing:
            parts.append("缺少必填参数: " + ", ".join(missing))
        if invalid:
            parts.append("参数格式错误: " + "; ".join(invalid.values()))
        if unknown:
            parts.append("不支持的参数: " + ", ".join(unknown))
        raise XdrToolError(
            "validation_error",
            "；".join(parts),
            details={"missing": missing, "invalid": invalid, "unknown": unknown},
        )
    return cleaned


def _resolve_device(db, device_id: Any) -> Device:
    """解析目标 XDR 设备（未指定时要求唯一已启用 XDR 设备）。"""
    if device_id is not None:
        try:
            device_id = int(device_id)
        except (TypeError, ValueError):
            raise XdrToolError("validation_error", "device_id 必须是整数") from None
        device = db.query(Device).filter(Device.id == device_id).first()
        if device is None:
            raise XdrToolError("device_not_found", f"设备不存在: device_id={device_id}")
        if not device.enabled:
            raise XdrToolError("device_disabled", f"设备已禁用: {device.name}")
        return device

    devices = (
        db.query(Device)
        .filter(Device.enabled.is_(True), Device.auth_type == XDR_AUTH_TYPE)
        .order_by(Device.id.asc())
        .all()
    )
    if not devices:
        # 兜底：设备认证方式可能为 inherit，按动作认证类型反查所属设备
        action = (
            db.query(DeviceAction)
            .filter(
                DeviceAction.enabled.is_(True),
                DeviceAction.auth_type == XDR_AUTH_TYPE,
            )
            .order_by(DeviceAction.id.asc())
            .first()
        )
        if action is not None:
            device = (
                db.query(Device)
                .filter(Device.id == action.device_id, Device.enabled.is_(True))
                .first()
            )
            if device is not None:
                devices = [device]

    if not devices:
        raise XdrToolError(
            "device_not_configured",
            "未找到已启用的深信服 XDR 设备：请先在「设备对接 → 内置设备库」"
            "用深信服XDR 模板创建设备并配置 XDR 管理地址与联动码",
        )
    if len(devices) > 1:
        raise XdrToolError(
            "device_ambiguous",
            "检测到多台已启用的深信服 XDR 设备，请通过 device_id 指定目标设备",
            details={
                "devices": [{"id": d.id, "name": d.name} for d in devices],
            },
        )
    return devices[0]


def _resolve_action(db, device: Device, action_def: dict[str, Any]) -> DeviceAction:
    """在目标设备上定位对应动作（优先 API 路径，其次动作名）。"""
    api_path = action_def.get("api_path") or ""
    action = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.device_id == device.id,
            DeviceAction.api_path == api_path,
            DeviceAction.enabled.is_(True),
        )
        .first()
    )
    if action is None:
        action = (
            db.query(DeviceAction)
            .filter(
                DeviceAction.device_id == device.id,
                DeviceAction.name == action_def.get("name"),
                DeviceAction.enabled.is_(True),
            )
            .first()
        )
    if action is None:
        raise XdrToolError(
            "action_not_found",
            f"设备「{device.name}」未配置动作「{action_def.get('name')}」({api_path})",
            details={
                "hint": "请在内置设备库重新复用该设备，或确认该设备是否为深信服 XDR 模板创建",
            },
        )
    return action


def _check_high_risk_permission(db, action: DeviceAction, user_id: Optional[int]) -> None:
    """中高风险动作的服务端权限门禁（与设备动作执行入口保持一致）。"""
    if str(action.risk_level or "").lower() not in _HIGH_RISK_LEVELS:
        return
    if user_id is None:
        raise XdrToolError(
            "permission_denied",
            "中高风险设备动作需要在用户会话中执行（缺少发起用户上下文）",
        )
    from app.dependencies import _check_matrix_permission
    from app.models.user import User

    invoking_user = db.query(User).filter(User.id == user_id).first()
    if invoking_user is None or not _check_matrix_permission(
        db, invoking_user, "ban_workflow", "edit"
    ):
        raise XdrToolError(
            "permission_denied",
            "权限不足：中高风险处置动作需要「封禁工作台-编辑」权限",
        )


def _extract_business_message(body: Any) -> Optional[str]:
    if isinstance(body, dict):
        for key in ("message", "msg", "errorMsg", "error", "code"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None
    if isinstance(body, str) and body.strip():
        return body.strip()[:300]
    return None


def _classify_error(
    status_code: Optional[int], error: Optional[str], business_message: Optional[str]
) -> tuple[str, bool]:
    """把执行失败归类为工具错误类型，并给出是否可重试。"""
    text = f"{error or ''} {business_message or ''}".lower()
    if status_code in (401, 403):
        return "auth_error", False
    if status_code == 404:
        return "not_found_error", False
    if status_code == 429:
        return "rate_limited", True
    if isinstance(status_code, int) and status_code >= 500:
        return "server_error", True
    if isinstance(status_code, int) and status_code >= 400:
        return "http_error", False
    if "timeout" in text or "timed out" in text:
        return "timeout", True
    if "connect" in text or "connection" in text or "network" in text:
        return "connection_error", True
    if any(k in text for k in ("联动码", "签名", "凭据", "auth")):
        return "auth_error", False
    return "request_error", False


def _business_failed(body: Any) -> bool:
    """HTTP 200 但 XDR 业务码非成功时视为业务失败。"""
    if not isinstance(body, dict) or "code" not in body:
        return False
    code = str(body.get("code")).strip().lower()
    return code not in ("success", "ok", "0", "200")


def _error_result(
    error_type: str,
    message: str,
    *,
    action_key: str,
    action_def: Optional[dict[str, Any]] = None,
    device_meta: Optional[dict] = None,
    action_meta: Optional[dict] = None,
    retryable: bool = False,
    details: Optional[dict] = None,
    latency_ms: int = 0,
    http_status: Optional[int] = None,
) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "failed",
        "http_status": http_status,
        "code": None,
        "message": None,
        "data": None,
        "error": {
            "type": error_type,
            "message": message,
            "retryable": retryable,
            "details": details or {},
        },
        "latency_ms": latency_ms,
        "device": device_meta,
        "action": action_meta
        or {
            "key": action_key,
            "name": action_def.get("name"),
            "api_path": action_def.get("api_path"),
            "http_method": action_def.get("http_method"),
        },
    }


def _format_result(
    result: dict[str, Any],
    *,
    action_key: str,
    action_def: dict[str, Any],
    device_meta: dict,
    action_meta: dict,
) -> dict[str, Any]:
    """把执行器返回值转换为智能体可直接解析的结构化结果。"""
    body = result.get("response_body")
    http_ok = bool(result.get("success"))
    latency_ms = int(result.get("latency_ms") or 0)

    data = body
    raw_response = None
    code = None
    message = None
    if isinstance(body, dict):
        code = body.get("code")
        message = body.get("message") or body.get("msg")
        # XDR 统一响应 {code, message, data}：解包业务数据，保留原始响应便于排查
        if "data" in body and ("code" in body or "message" in body):
            data = body.get("data")
            raw_response = body

    ok = http_ok and not _business_failed(body)
    out: dict[str, Any] = {
        "ok": ok,
        "status": "success" if ok else "failed",
        "http_status": result.get("status_code"),
        "code": code,
        "message": message,
        "data": data,
        "error": None,
        "latency_ms": latency_ms,
        "device": device_meta,
        "action": action_meta,
    }
    if raw_response is not None:
        out["raw_response"] = raw_response

    if not ok:
        business_message = _extract_business_message(body)
        error_type, retryable = _classify_error(
            result.get("status_code"), result.get("error"), business_message
        )
        if http_ok and _business_failed(body):
            error_type, retryable = "business_error", False
        out["error"] = {
            "type": error_type,
            "message": business_message
            or result.get("error")
            or "XDR 接口返回失败",
            "retryable": retryable,
            "details": {"http_status": result.get("status_code")},
        }
    return out


def _execute_sync(
    action_key: str,
    params: Optional[dict[str, Any]],
    device_id: Optional[int],
    timeout: Optional[float],
    agent_id: Optional[int],
    user_id: Optional[int],
) -> dict[str, Any]:
    started = time.perf_counter()
    action_def: Optional[dict[str, Any]] = None

    # 1) 动作定义与参数校验（在请求设备前硬拦截，避免无效请求与占位符
    #    原样下发）；unknown_action 也走结构化错误路径，details 保留
    #    available_actions 供 LLM 自纠错
    try:
        action_def = get_action_definition(action_key)
        cleaned = validate_action_params(action_key, params)
    except XdrToolError as exc:
        return _error_result(
            exc.error_type,
            exc.message,
            action_key=action_key,
            action_def=action_def,
            retryable=exc.retryable,
            details=exc.details,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    device_meta: Optional[dict] = None
    db = SessionLocal()
    try:
        device = _resolve_device(db, device_id)
        device_meta = {"id": device.id, "name": device.name, "type": device.type}
        action = _resolve_action(db, device, action_def)
        action_meta = {
            "key": action_key,
            "id": action.id,
            "name": action.name,
            "api_path": action.api_path,
            "http_method": action.http_method,
            "risk_level": action.risk_level,
        }
        _check_high_risk_permission(db, action, user_id)

        # 2) 统一执行：认证签名 / 超时 / 重试 / 调用日志全部复用执行引擎。
        # 必填校验已在本层按纠正后的 schema 完成（嵌套字段不属于顶层参数），
        # 故跳过执行器对原始 schema 的必填校验。
        result = execute_device_action(
            device,
            action,
            cleaned,
            timeout,
            db=db,
            source="agent",
            agent_id=agent_id,
            user_id=user_id,
            skip_required_check=True,
        )
        return _format_result(
            result,
            action_key=action_key,
            action_def=action_def,
            device_meta=device_meta,
            action_meta=action_meta,
        )
    except XdrToolError as exc:
        return _error_result(
            exc.error_type,
            exc.message,
            action_key=action_key,
            action_def=action_def,
            device_meta=device_meta,
            retryable=exc.retryable,
            details=exc.details,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("XDR 工具执行异常: action=%s", action_key)
        return _error_result(
            "internal_error",
            f"{type(exc).__name__}: {exc}",
            action_key=action_key,
            action_def=action_def,
            device_meta=device_meta,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass


async def run_xdr_action(
    action_key: str,
    params: Optional[dict[str, Any]] = None,
    device_id: Optional[int] = None,
    timeout: Optional[float] = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """XDR 设备动作统一调用入口（供智能体工具调用）。

    Args:
        action_key: 工具名/动作键（如 ``xdr_alerts_list``）。
        params: 业务参数键值对，按该动作的参数 schema 校验。
        device_id: 可选目标设备 ID；仅一台已启用 XDR 设备时可省略。
        timeout: 可选 HTTP 超时覆盖（默认取设备配置，缺省 30 秒）。
        agent_id / user_id: 审计归属（写入设备调用日志，行为 source='agent'）。

    Returns:
        dict: ``{ok, status, http_status, code, message, data, error, latency_ms,
        device, action}``；失败时 ``error`` 含 type/message/retryable/details。
    """
    return await asyncio.to_thread(
        _execute_sync, action_key, params, device_id, timeout, agent_id, user_id
    )


# ================= 资产组查询专用工具（基于「资产组列表查询」动作封装） =================

def _flatten_branch_tree(
    nodes: Any,
    depth: int = 1,
    parent_path: str = "",
) -> list[dict[str, Any]]:
    """把 branchlist 返回的资产组树压平为带层级信息的列表。"""
    flat: list[dict[str, Any]] = []
    if not isinstance(nodes, list):
        return flat
    for node in nodes:
        if not isinstance(node, dict):
            continue
        name = str(node.get("name") or "").strip()
        path = f"{parent_path}/{name}" if parent_path else name
        flat.append(
            {
                "id": node.get("id"),
                "name": name,
                "parent_id": node.get("parentId"),
                "depth": depth,
                "path": path,
                "children_count": len(node.get("children") or []),
            }
        )
        flat.extend(
            _flatten_branch_tree(node.get("children"), depth + 1, path)
        )
    return flat


async def query_xdr_asset_group(
    group_name: Optional[str] = None,
    group_id: Optional[int] = None,
    include_descendants: bool = True,
    device_id: Optional[int] = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """查询 XDR 资产组及其下属资产组 ID（智能体专用工具）。

    基于「资产组列表查询」动作（GET /api/xdr/v1/bigscreen/branchlist）封装：
    拉取完整资产组层级树后，按名称（先精确后包含匹配）或 ID 定位目标资产组，
    返回其 ID、名称、父资产组 ID、层级路径，以及全部下级资产组
    （含二级资产组）的 ID 与名称。

    Args:
        group_name: 目标资产组名称（如 ``深圳市政数局资产``），支持精确与包含匹配。
        group_id: 目标资产组 ID；与 group_name 二选一，同时提供时按 ID 优先。
        include_descendants: 是否返回全部下级资产组（默认 True）。
        device_id: 可选目标设备 ID；仅一台已启用 XDR 设备时可省略。
        agent_id / user_id: 审计归属（写入设备调用日志，source='agent'）。

    Returns:
        dict: ``{ok, matched, group, children, descendants, descendant_ids,
        total_groups, available_groups, error}``；
        未匹配到时 ``matched=False`` 且 ``available_groups`` 提供全量
        资产组名称与 ID 供智能体自纠错。
    """
    result = await run_xdr_action(
        "xdr_bigscreen_branchlist",
        {},
        device_id=device_id,
        agent_id=agent_id,
        user_id=user_id,
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "matched": False,
            "error": result.get("error") or {
                "type": "xdr_api_error",
                "message": result.get("message") or "资产组列表查询失败",
            },
        }

    flat = _flatten_branch_tree(result.get("data"))
    if not flat:
        return {
            "ok": False,
            "matched": False,
            "error": {
                "type": "empty_data",
                "message": "资产组列表返回为空，请确认 XDR 平台已创建资产组",
            },
        }

    target = None
    if group_id is not None:
        target = next((g for g in flat if g["id"] == group_id), None)
    elif group_name:
        name = str(group_name).strip()
        target = next((g for g in flat if g["name"] == name), None)
        if target is None:
            target = next((g for g in flat if name in g["name"]), None)

    payload: dict[str, Any] = {
        "ok": True,
        "total_groups": len(flat),
    }
    if target is None:
        payload["matched"] = False
        payload["available_groups"] = [
            {"id": g["id"], "name": g["name"], "parent_id": g["parent_id"]}
            for g in flat
        ]
        payload["error"] = {
            "type": "group_not_found",
            "message": (
                f"未找到资产组：{group_name or group_id}；"
                "available_groups 已返回全量资产组名称与 ID，请从中选择后重试"
            ),
        }
        return payload

    payload["matched"] = True
    payload["group"] = {
        "id": target["id"],
        "name": target["name"],
        "parent_id": target["parent_id"],
        "depth": target["depth"],
        "path": target["path"],
    }
    descendants = [g for g in flat if g["depth"] > target["depth"] and g["path"].startswith(target["path"] + "/")]
    payload["children"] = [
        {
            "id": g["id"],
            "name": g["name"],
            "parent_id": g["parent_id"],
            "children_count": g["children_count"],
        }
        for g in descendants
        if g["depth"] == target["depth"] + 1
    ]
    if include_descendants:
        payload["descendants"] = [
            {
                "id": g["id"],
                "name": g["name"],
                "parent_id": g["parent_id"],
                "depth": g["depth"],
                "path": g["path"],
            }
            for g in descendants
        ]
        payload["descendant_ids"] = [g["id"] for g in descendants]
    return payload


# ================= 资产组告警统计专用工具（资产组展开 + trends 按等级统计） =================

# XDR 告警等级值 → 名称（实测：70=严重 / 50=高危 / 30=中危）
XDR_ALERT_SEVERITY_NAMES = {70: "严重", 50: "高危", 30: "中危", 10: "低危"}

_BEIJING_TZ = _dt_timezone(timedelta(hours=8))

_TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d",
)


def _severity_label(value: Any) -> str:
    """把等级数值映射为名称（未知等级保留数字）。"""
    try:
        num = int(value)
    except (TypeError, ValueError):
        return str(value)
    return XDR_ALERT_SEVERITY_NAMES.get(num, str(num))


def _parse_time_value(value: Any, *, is_end: bool) -> Optional[int]:
    """把时间参数解析为秒级时间戳：int/数字串直接用，日期串按北京时间。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    dt = None
    for fmt in _TIME_FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
            break
        except ValueError:
            continue
    if dt is None:
        return None
    if len(s) <= 10 and is_end:
        dt = dt.replace(hour=23, minute=59, second=59)
    return int(dt.replace(tzinfo=_BEIJING_TZ).timestamp())


def _collect_severity_counts(node: Any, acc: dict[str, int]) -> None:
    """递归收集 trends 按等级分桶响应中的 等级→数量 并累加。

    兼容多种桶形态：trends 实测形态 ``{"name": "70", "item": [{"value": 179,
    "name": <毫秒时间戳>}]}``（跨时间桶求和）、``{"severity": 70, "count": 173}``、
    ``{"70": 173}`` 数值映射，以及嵌套 list/dict 包裹结构。
    """
    if isinstance(node, list):
        for item in node:
            _collect_severity_counts(item, acc)
        return
    if not isinstance(node, dict):
        return

    # trends 实测形态：name=等级值，item=各时间桶 {value: 数量, name: 毫秒时间戳}
    bucket_items = node.get("item")
    if "name" in node and isinstance(bucket_items, list) and bucket_items:
        bucket_total = 0
        for entry in bucket_items:
            if isinstance(entry, dict):
                raw = entry.get("value")
                if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                    bucket_total += int(raw)
        label = _severity_label(node["name"])
        acc[label] = acc.get(label, 0) + bucket_total
        return

    sev = None
    for key in ("severity", "alertSeverity", "alert_severity"):
        if key in node:
            sev = node[key]
            break
    count = None
    for key in ("count", "docCount", "doc_count", "value"):
        raw = node.get(key)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            count = int(raw)
            break
    if sev is not None and count is not None:
        label = _severity_label(sev)
        acc[label] = acc.get(label, 0) + count
        return

    # 兼容 {"70": 173, "50": 140} 等级值 → 数量 的直接映射形态
    if node and all(
        isinstance(k, str) and k.lstrip("-").isdigit()
        and isinstance(v, (int, float)) and not isinstance(v, bool)
        for k, v in node.items()
    ):
        for k, v in node.items():
            label = _severity_label(k)
            acc[label] = acc.get(label, 0) + int(v)
        return

    for child in node.values():
        _collect_severity_counts(child, acc)


async def query_xdr_alert_stats(
    group_name: Optional[str] = None,
    group_id: Optional[int] = None,
    time_field: str = "lastTime",
    start_timestamp: Any = None,
    end_timestamp: Any = None,
    include_descendants: bool = True,
    device_id: Optional[int] = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """统计指定 XDR 资产组在时间范围内的各等级告警数量（智能体专用工具）。

    与 XDR 平台告警页口径一致：先把目标资产组展开为「资产组 ID + 全部下挂
    子资产组 ID」，再用「告警趋势统计」（POST /api/xdr/v1/alerts/trends，
    filterParam.hostBranchIds 过滤）按等级分桶统计并求和，
    一步返回与平台资产组筛选一致的结果。

    Args:
        group_name: 目标资产组名称（如 ``深圳市政数局资产``），与 group_id 二选一。
        group_id: 目标资产组 ID；同时提供时按 ID 优先。
        time_field: 统计口径（AlertTimeFieldTypeEnum），默认 ``lastTime``
            （最近发生时间=当日活跃，平台告警页默认口径）；
            ``firstTime`` 为首次产生时间=当日新增口径。
        start_timestamp / end_timestamp: 时间范围，秒级时间戳或北京时间字符串
            （如 ``2026-11-12 00:00:00``）；缺省为北京时间今日全天。
        include_descendants: 是否把全部下级资产组并入统计范围（默认 True，
            与平台资产组树筛选行为一致）。
        device_id: 可选目标设备 ID；仅一台已启用 XDR 设备时可省略。
        agent_id / user_id: 审计归属（写入设备调用日志，source='agent'）。

    Returns:
        dict: ``{ok, matched, group, time_field, time_range, total,
        by_severity, group_scope, error}``；``by_severity`` 为按等级从高到低
        排序的 ``{level, name, count}`` 列表。
    """
    invalid: Optional[dict[str, str]] = None
    if not group_name and group_id is None:
        invalid = {"group": "group_name 与 group_id 必须提供其一"}
    time_field = str(time_field or "lastTime").strip()
    if time_field not in ("firstTime", "lastTime"):
        invalid = invalid or {}
        invalid["time_field"] = "time_field 只支持 firstTime / lastTime"
    start_ts = _parse_time_value(start_timestamp, is_end=False)
    end_ts = _parse_time_value(end_timestamp, is_end=True)
    if (start_timestamp is not None and start_ts is None) or (
        end_timestamp is not None and end_ts is None
    ):
        invalid = invalid or {}
        invalid["time_range"] = "start/end 时间格式无法解析（支持秒级时间戳或北京时间字符串）"
    if start_ts is None or end_ts is None:
        now = datetime.now(_BEIJING_TZ)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        if start_ts is None:
            start_ts = int(day_start.timestamp())
        if end_ts is None:
            end_ts = int(day_start.timestamp()) + 86399
    if start_ts >= end_ts:
        invalid = invalid or {}
        invalid["time_range"] = "start 时间必须早于 end 时间"
    if invalid:
        return {
            "ok": False,
            "matched": False,
            "error": {
                "type": "invalid_params",
                "message": "；".join(f"{k}: {v}" for k, v in invalid.items()),
            },
        }

    # 1) 资产组展开：目标资产组 + 全部下挂子资产组 ID（与平台资产组树筛选一致）
    group_result = await query_xdr_asset_group(
        group_name=group_name,
        group_id=group_id,
        include_descendants=True,
        device_id=device_id,
        agent_id=agent_id,
        user_id=user_id,
    )
    if not group_result.get("ok"):
        return {
            "ok": False,
            "matched": False,
            "error": group_result.get("error")
            or {"type": "xdr_api_error", "message": "资产组列表查询失败"},
        }
    if not group_result.get("matched"):
        out = {
            "ok": False,
            "matched": False,
            "error": group_result.get("error")
            or {"type": "group_not_found", "message": "未找到目标资产组"},
        }
        if group_result.get("available_groups"):
            out["available_groups"] = group_result["available_groups"]
        return out

    group = group_result["group"]
    descendant_ids = list(group_result.get("descendant_ids") or [])
    if include_descendants:
        branch_ids = [group["id"]] + descendant_ids
    else:
        branch_ids = [group["id"]]

    # 2) trends 按等级统计：filterParam.hostBranchIds 是唯一生效的资产组过滤
    trends_result = await run_xdr_action(
        "xdr_alerts_trends",
        {
            "startTimestamp": start_ts,
            "endTimestamp": end_ts,
            "timeField": time_field,
            "interval": "1d",
            "aggBy": ["severity"],
            "aggFuncs": [{"name": "count", "func": "count", "param": "uuId"}],
            "filterParam": {"hostBranchIds": branch_ids},
        },
        device_id=device_id,
        agent_id=agent_id,
        user_id=user_id,
    )
    if not trends_result.get("ok"):
        return {
            "ok": False,
            "matched": True,
            "group": {"id": group["id"], "name": group["name"], "path": group["path"]},
            "error": trends_result.get("error")
            or {
                "type": "xdr_api_error",
                "message": trends_result.get("message") or "告警趋势统计查询失败",
            },
        }

    # 3) 各时间桶按等级求和
    acc: dict[str, int] = {}
    _collect_severity_counts(trends_result.get("data"), acc)
    level_of = {name: lv for lv, name in XDR_ALERT_SEVERITY_NAMES.items()}
    by_severity = sorted(
        (
            {
                "level": level_of.get(label, int(label) if str(label).lstrip("-").isdigit() else -1),
                "name": label,
                "count": count,
            }
            for label, count in acc.items()
        ),
        key=lambda item: -item["level"],
    )
    return {
        "ok": True,
        "matched": True,
        "group": {"id": group["id"], "name": group["name"], "path": group["path"]},
        "time_field": time_field,
        "time_field_meaning": (
            "lastTime=当日活跃告警（平台告警页默认口径）"
            if time_field == "lastTime"
            else "firstTime=当日新增告警"
        ),
        "time_range": {
            "start_timestamp": start_ts,
            "end_timestamp": end_ts,
            "start": datetime.fromtimestamp(start_ts, _BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
            "end": datetime.fromtimestamp(end_ts, _BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        },
        "group_scope": {
            "include_descendants": bool(include_descendants),
            "branch_id_count": len(branch_ids),
            "descendant_group_count": len(descendant_ids),
        },
        "total": sum(item["count"] for item in by_severity),
        "by_severity": by_severity,
        "error": None,
    }
