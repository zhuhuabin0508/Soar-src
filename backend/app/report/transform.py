"""数据抽取与转换：JSONPath → 白名单算子 → 渲染上下文。

关键原则：
- 只允许白名单转换算子，不执行任意表达式/代码；
- 缺失值不静默填 0，按 ``on_missing`` 策略标记并记录问题；
- 每个绑定记录血缘（来源、路径、响应哈希、抓取时间），随运行快照保存。
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

from app.report.errors import (
    MAP_MISSING,
    MAP_TRANSFORM,
    MAP_TYPE,
    VAL_CROSS_CHECK,
    ReportError,
)
from app.report.spec import normalize_token

_MISSING_MARK = "—"
_NUMERIC_RE = re.compile(r"^-?\d+(\.\d+)?$")


def normalize_jsonpath(path: Any) -> str:
    """补齐 JSONPath 的 ``$`` 前缀，允许用户填写 ``data.total``。"""
    text = str(path or "").strip()
    if not text:
        return "$"
    if text.startswith("$") or text.startswith("["):
        return text
    if text.startswith("."):
        return "$" + text
    return "$." + text


def extract_jsonpath(payload: Any, path: Any) -> Any:
    """按 JSONPath 取值；无命中返回 None，多命中返回列表。

    支持 ``$.data.items[*]``、``$.items[?(@.level=='high')]`` 等 ext 语法。
    """
    if payload is None:
        return None
    normalized = normalize_jsonpath(path)
    if normalized == "$":
        return payload
    try:
        from jsonpath_ng.ext import parse

        expression = parse(normalized)
    except Exception as exc:  # noqa: BLE001
        raise ReportError(MAP_TRANSFORM, f"JSONPath 不合法: {path} ({exc})") from exc

    matches = [match.value for match in expression.find(payload)]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    return matches


def _to_float(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not _NUMERIC_RE.match(text):
        raise ValueError(f"不是数值: {value}")
    return float(text)


def _as_number_list(value: Any) -> list[float]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_to_float(item) for item in value]
    return [_to_float(value)]


def _op_to_int(value: Any, **_: Any) -> int:
    return int(round(_to_float(value)))


def _op_to_float(value: Any, **_: Any) -> float:
    return _to_float(value)


def _op_round(value: Any, ndigits: int = 0, **_: Any) -> float:
    return round(_to_float(value), int(ndigits))


def _op_date_format(value: Any, fmt: str = "%Y-%m-%d", **_: Any) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return _MISSING_MARK
    parsed: datetime | None = None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day)
    elif isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(value)
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"日期格式无法识别: {value}") from exc
    if parsed is None:
        raise ValueError(f"日期格式无法识别: {value}")
    return parsed.strftime(fmt)


def _op_map_values(value: Any, mapping: dict | None = None, default: Any = None, **_: Any) -> Any:
    mapping = mapping or {}
    key = str(value)
    if key in mapping:
        return mapping[key]
    return default if default is not None else value


def _op_count(value: Any, **_: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (list, tuple, dict, set, str)):
        return len(value)
    return 1


def _op_sum(value: Any, **_: Any) -> float | int:
    numbers = _as_number_list(value)
    total = sum(numbers)
    return int(total) if float(total).is_integer() else total


def _op_avg(value: Any, **_: Any) -> float:
    numbers = _as_number_list(value)
    return sum(numbers) / len(numbers) if numbers else 0.0


def _op_min(value: Any, **_: Any) -> float:
    numbers = _as_number_list(value)
    return min(numbers) if numbers else 0.0


def _op_max(value: Any, **_: Any) -> float:
    numbers = _as_number_list(value)
    return max(numbers) if numbers else 0.0


def _op_join(value: Any, sep: str = ",", **_: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return str(sep).join(str(item) for item in value)
    return str(value)


def _op_split(value: Any, sep: str = ",", **_: Any) -> list[str]:
    if value is None:
        return []
    return str(value).split(str(sep))


def _op_truncate(value: Any, length: int = 50, **_: Any) -> str:
    text = "" if value is None else str(value)
    limit = max(int(length), 0)
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _op_mask(
    value: Any,
    keep_start: int = 3,
    keep_end: int = 4,
    mask_char: str = "*",
    **_: Any,
) -> str:
    text = "" if value is None else str(value)
    start = max(int(keep_start), 0)
    end = max(int(keep_end), 0)
    if len(text) <= start + end:
        return (mask_char or "*") * len(text)
    return text[:start] + (mask_char or "*") * 4 + text[len(text) - end :]


_UNIT_FACTORS = {
    "b": 1,
    "kb": 1024,
    "mb": 1024**2,
    "gb": 1024**3,
    "tb": 1024**4,
    "万": 10_000,
    "亿": 100_000_000,
}


def _op_unit_convert(
    value: Any,
    from_unit: str = "b",
    to_unit: str = "mb",
    decimals: int = 2,
    **_: Any,
) -> float:
    source = _UNIT_FACTORS.get(str(from_unit).lower())
    target = _UNIT_FACTORS.get(str(to_unit).lower())
    if not source or not target:
        raise ValueError(f"不支持的单位换算: {from_unit} -> {to_unit}")
    return round(_to_float(value) * source / target, int(decimals))


def _op_default(value: Any, default: Any = _MISSING_MARK, **_: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    return value


_TRANSFORM_HANDLERS = {
    "to_int": _op_to_int,
    "to_float": _op_to_float,
    "round": _op_round,
    "date_format": _op_date_format,
    "map_values": _op_map_values,
    "count": _op_count,
    "sum": _op_sum,
    "avg": _op_avg,
    "min": _op_min,
    "max": _op_max,
    "join": _op_join,
    "split": _op_split,
    "truncate": _op_truncate,
    "mask": _op_mask,
    "unit_convert": _op_unit_convert,
    "default": _op_default,
}


def apply_transforms(value: Any, transforms: Any) -> Any:
    """按顺序应用白名单转换算子。"""
    if not transforms:
        return value
    if not isinstance(transforms, list):
        raise ReportError(MAP_TRANSFORM, "transforms 必须是数组")

    current = value
    for index, operator in enumerate(transforms):
        if not isinstance(operator, dict):
            raise ReportError(MAP_TRANSFORM, f"第 {index + 1} 个转换算子格式错误")
        name = str(operator.get("op") or "").strip()
        handler = _TRANSFORM_HANDLERS.get(name)
        if handler is None:
            raise ReportError(MAP_TRANSFORM, f"不支持的转换算子: {name}")
        kwargs = {key: val for key, val in operator.items() if key != "op"}
        try:
            current = handler(current, **kwargs)
        except ReportError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ReportError(
                MAP_TRANSFORM,
                f"转换算子 {name} 执行失败: {exc}",
                {"operator": operator, "value": current},
            ) from exc
    return current


def _as_table_rows(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    return []


def build_binding_value(binding: dict, payload: Any) -> Any:
    """按一条绑定规则从原始响应中取值（标量或表格）。"""
    path = binding.get("path")
    raw = extract_jsonpath(payload, path)

    is_table = binding.get("type") == "table" or isinstance(binding.get("columns"), dict)
    if not is_table:
        return apply_transforms(raw, binding.get("transforms"))

    rows = _as_table_rows(raw)
    columns = binding.get("columns") or {}
    result: list[dict] = []
    for item in rows:
        row: dict[str, Any] = {}
        for key, column in columns.items():
            if not isinstance(column, dict):
                continue
            # 表格列路径相对单行对象；也允许绝对 $ 路径（对整个 item 求值）
            cell = extract_jsonpath(item, column.get("path"))
            cell = apply_transforms(cell, column.get("transforms"))
            row[key] = _MISSING_MARK if cell is None or cell == "" else cell
        result.append(row)

    sort_rules = binding.get("sort") or []
    for rule in reversed([r for r in sort_rules if isinstance(r, dict)]):
        key = rule.get("by")
        reverse = str(rule.get("order") or "asc").lower() == "desc"
        if key:
            result.sort(key=lambda row: (row.get(key) is None, row.get(key)), reverse=reverse)

    limit = binding.get("limit")
    if isinstance(limit, int) and limit > 0:
        result = result[:limit]
    return result


def _set_nested(context: dict, token: str, value: Any) -> None:
    parts = [part for part in token.split(".") if part]
    if not parts:
        raise ReportError(MAP_TYPE, "占位符 token 为空")
    current = context
    for part in parts[:-1]:
        existing = current.get(part)
        if existing is None:
            existing = {}
            current[part] = existing
        if not isinstance(existing, dict):
            raise ReportError(
                MAP_TYPE,
                f"占位符结构冲突: {part} 同时被用作标量与对象",
            )
        current = existing
    current[parts[-1]] = value


def _resolve(context: dict, token: str) -> Any:
    current: Any = context
    for part in (token or "").split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def build_data_context(
    bindings: list[dict],
    sources: dict[str, Any],
    *,
    fetched_at: str | None = None,
) -> dict:
    """把各数据源响应按映射规则组装为渲染上下文。

    Args:
        bindings: 映射配置中的 ``bindings`` 数组。
        sources: ``source_key -> SourceResult | 原始响应``。
        fetched_at: 采集时间（写入血缘）。

    Returns:
        ``{"context", "lineage", "issues", "ok"}``；``ok=False`` 表示存在
        不可降级的必填缺失。
    """
    context: dict = {}
    lineage: list[dict] = []
    issues: list[dict] = []
    has_error = False

    for index, binding in enumerate(bindings or []):
        if not isinstance(binding, dict):
            issues.append(
                {
                    "code": MAP_MISSING,
                    "severity": "error",
                    "message": f"第 {index + 1} 条绑定格式错误",
                }
            )
            has_error = True
            continue

        token = normalize_token(binding.get("token") or "")
        if not token:
            issues.append(
                {
                    "code": MAP_MISSING,
                    "severity": "error",
                    "message": f"第 {index + 1} 条绑定缺少 token",
                }
            )
            has_error = True
            continue

        source_key = str(binding.get("source_key") or "").strip()
        if source_key not in sources:
            issues.append(
                {
                    "code": MAP_MISSING,
                    "severity": "error",
                    "token": token,
                    "source_key": source_key,
                    "message": f"数据源未返回结果: {source_key}",
                }
            )
            has_error = True
            _set_nested(context, token, _MISSING_MARK)
            continue

        source_result = sources[source_key]
        payload = getattr(source_result, "data", source_result)
        if not describe_source_ok(source_result):
            error_code = getattr(source_result, "error_code", None) or MAP_MISSING
            policy = str(binding.get("on_missing") or ("fail" if binding.get("required") else "degrade_mark"))
            issues.append(
                {
                    "code": error_code,
                    "severity": "error" if policy == "fail" else "warning",
                    "token": token,
                    "source_key": source_key,
                    "message": getattr(source_result, "error_message", None)
                    or f"数据源采集失败: {source_key}",
                }
            )
            if policy == "fail":
                has_error = True
            _set_nested(context, token, _MISSING_MARK)
            continue

        try:
            value = build_binding_value(binding, payload)
        except ReportError as exc:
            issues.append(
                {
                    "code": exc.code,
                    "severity": "error",
                    "token": token,
                    "source_key": source_key,
                    "message": exc.message,
                }
            )
            has_error = True
            _set_nested(context, token, _MISSING_MARK)
            continue

        is_table = binding.get("type") == "table" or isinstance(binding.get("columns"), dict)
        empty = value is None or (isinstance(value, list) and not value) or value == ""
        if empty:
            policy = str(
                binding.get("on_missing") or ("fail" if binding.get("required") else "degrade_mark")
            )
            severity = "error" if policy == "fail" else "warning"
            if policy == "default":
                value = binding.get("default", _MISSING_MARK)
            else:
                value = [] if is_table else _MISSING_MARK
            issues.append(
                {
                    "code": MAP_MISSING,
                    "severity": severity,
                    "token": token,
                    "source_key": source_key,
                    "message": f"字段无数据: {binding.get('path')}",
                }
            )
            if severity == "error":
                has_error = True

        _set_nested(context, token, value)
        lineage.append(
            {
                "token": token,
                "source_key": source_key,
                "path": binding.get("path"),
                "fetched_at": fetched_at,
                "response_hash": getattr(source_result, "response_hash", None),
                "device_id": getattr(source_result, "device_id", None),
                "action_id": getattr(source_result, "action_id", None),
                "status_code": getattr(source_result, "status_code", None),
            }
        )

    return {"context": context, "lineage": lineage, "issues": issues, "ok": not has_error}


def describe_source_ok(source_result: Any) -> bool:
    """兼容 SourceResult 与原始响应：仅显式失败才视为不可用。"""
    if hasattr(source_result, "ok"):
        return bool(source_result.ok)
    return source_result is not None


# --------------------------------------------------------------------------- #
# 交叉核对
# --------------------------------------------------------------------------- #
def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def run_cross_checks(context: dict, checks: list[dict] | None) -> list[dict]:
    """执行配置化交叉核对，返回问题列表（空=全部通过）。"""
    issues: list[dict] = []
    for index, check in enumerate(checks or []):
        if not isinstance(check, dict):
            continue
        check_type = str(check.get("type") or "").strip()
        field = check.get("field")
        value = _resolve(context, str(field or "")) if field else None

        if check_type == "sum_equals":
            detail = _resolve(context, str(check.get("detail") or ""))
            summary = _resolve(context, str(check.get("summary") or ""))
            if isinstance(detail, list) and check.get("item_field"):
                detail = [
                    item.get(check.get("item_field"))
                    for item in detail
                    if isinstance(item, dict)
                ]
            try:
                numbers = _as_number_list(detail)
                total = sum(numbers)
                expected = _to_float(summary)
            except (TypeError, ValueError) as exc:
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"核对规则 #{index + 1} 无法求值: {exc}",
                    }
                )
                continue
            tolerance = _to_float(check.get("tolerance") or 0)
            if abs(total - expected) > tolerance:
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"明细合计 {total} 与汇总值 {expected} 不一致",
                    }
                )
        elif check_type == "range":
            try:
                number = _to_float(value)
            except (TypeError, ValueError):
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field} 不是数值，无法做区间校验",
                    }
                )
                continue
            minimum = check.get("min")
            maximum = check.get("max")
            if minimum is not None and number < _to_float(minimum):
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field}={number} 小于下限 {minimum}",
                    }
                )
            if maximum is not None and number > _to_float(maximum):
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field}={number} 超过上限 {maximum}",
                    }
                )
        elif check_type == "non_negative":
            try:
                number = _to_float(value)
            except (TypeError, ValueError):
                continue
            if number < 0:
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field} 不能为负数: {number}",
                    }
                )
        elif check_type == "date_within":
            moment = _parse_datetime(value)
            start = _parse_datetime(_resolve(context, str(check.get("start") or "")))
            end = _parse_datetime(_resolve(context, str(check.get("end") or "")))
            if moment is None:
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field} 不是合法日期",
                    }
                )
            elif (start and moment < start) or (end and moment > end):
                issues.append(
                    {
                        "code": VAL_CROSS_CHECK,
                        "severity": "error",
                        "message": f"字段 {field}={moment} 不在报告周期内",
                    }
                )
        elif check_type == "row_count":
            expected = check.get("expected")
            if expected is None and check.get("target"):
                expected = _resolve(context, str(check.get("target")))
            try:
                count = len(value) if isinstance(value, list) else 0
                if expected is not None and count != int(expected):
                    issues.append(
                        {
                            "code": VAL_CROSS_CHECK,
                            "severity": "error",
                            "message": f"字段 {field} 行数 {count} 与预期 {expected} 不一致",
                        }
                    )
            except (TypeError, ValueError):
                continue
    return issues
