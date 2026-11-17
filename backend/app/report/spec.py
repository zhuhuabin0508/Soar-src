"""报告模板规格（template spec / manifest）与配置校验。

本模块只做纯函数校验，不依赖数据库与文档解析，便于单测与前端复用口径。

术语：
- **template spec**：AI 或人工产出的结构化模板描述（章节 + 占位符）；
- **manifest**：从 docx 解析出的实际占位符清单，是映射配置的唯一契约；
- **token**：占位符标识，规范为 ``域.指标[.属性]``，如 ``summary.total_alert``。
"""
from __future__ import annotations

import re
from typing import Any

FORMAT_VERSION = 1

# 占位符命名规范：小写字母开头，至少两级（域.指标），允许数字与下划线
TOKEN_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")

PLACEHOLDER_TYPES = {"text", "number", "date", "enum", "boolean", "table", "image"}
COLUMN_TYPES = {"text", "number", "date", "enum", "boolean"}

# 转换算子白名单：禁止任意表达式/代码，保证可审计与可校验
TRANSFORM_OPS = {
    "to_int",
    "to_float",
    "round",
    "date_format",
    "map_values",
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "join",
    "split",
    "truncate",
    "mask",
    "unit_convert",
    "default",
}

SOURCE_TYPES = {"device_action", "http_tool", "static"}

CROSS_CHECK_TYPES = {"sum_equals", "range", "date_within", "non_negative", "row_count"}

DEGRADE_POLICIES = {"fail", "degrade_mark", "last_known", "skip_section", "default"}


def _issue(code: str, message: str, path: str = "") -> dict:
    """构造一条校验问题；path 用 JSON 风格定位，便于前端高亮。"""
    return {"code": code, "message": message, "path": path}


def normalize_token(raw: Any) -> str:
    """规整 token：去空白、统一小写、折叠多余空格。"""
    return re.sub(r"\s+", "", str(raw or "")).lower()


def is_valid_token(token: str) -> bool:
    return bool(TOKEN_PATTERN.match(token or ""))


def slugify_token(token: str) -> str:
    """token 转稳定的占位符 id（仅用于展示与关联，不参与渲染）。"""
    return "p_" + re.sub(r"[^a-z0-9]+", "_", (token or "").lower()).strip("_")


def infer_placeholder_type(token: str) -> str:
    """按 token 末尾语义猜测类型，解析 docx 时作为默认值，人工可覆盖。"""
    tail = (token or "").rsplit(".", 1)[-1]
    if tail in {"count", "num", "total", "number", "amount", "qty"} or tail.endswith("_count"):
        return "number"
    if tail in {"rate", "ratio", "percent", "percentage"}:
        return "number"
    if tail in {"date", "time", "datetime", "start_time", "end_time"} or tail.endswith("_date"):
        return "date"
    if tail in {"enabled", "is_xxx"} or tail.startswith("is_"):
        return "boolean"
    return "text"


# --------------------------------------------------------------------------- #
# 模板规格 / manifest
# --------------------------------------------------------------------------- #
def validate_template_spec(spec: Any) -> list[dict]:
    """校验 template spec 或 manifest，返回问题列表（空列表=通过）。"""
    issues: list[dict] = []
    if not isinstance(spec, dict):
        return [_issue("TPL_INVALID", "模板规格必须是对象", "$")]

    if spec.get("format_version") != FORMAT_VERSION:
        issues.append(
            _issue(
                "TPL_INVALID",
                f"format_version 必须为 {FORMAT_VERSION}",
                "$.format_version",
            )
        )

    sections = spec.get("sections", [])
    if not isinstance(sections, list):
        issues.append(_issue("TPL_INVALID", "sections 必须是数组", "$.sections"))
        sections = []
    section_ids: set[str] = set()
    for index, section in enumerate(sections):
        path = f"$.sections[{index}]"
        if not isinstance(section, dict):
            issues.append(_issue("TPL_INVALID", "章节必须是对象", path))
            continue
        section_id = str(section.get("id") or "").strip()
        if not section_id:
            issues.append(_issue("TPL_INVALID", "章节 id 不能为空", f"{path}.id"))
        elif section_id in section_ids:
            issues.append(_issue("TPL_INVALID", f"章节 id 重复: {section_id}", f"{path}.id"))
        section_ids.add(section_id)
        if not str(section.get("title") or "").strip():
            issues.append(_issue("TPL_INVALID", "章节标题不能为空", f"{path}.title"))

    placeholders = spec.get("placeholders", [])
    if not isinstance(placeholders, list) or not placeholders:
        issues.append(_issue("TPL_INVALID", "至少需要一个占位符", "$.placeholders"))
        placeholders = []

    seen_ids: set[str] = set()
    seen_tokens: set[str] = set()
    for index, item in enumerate(placeholders):
        path = f"$.placeholders[{index}]"
        if not isinstance(item, dict):
            issues.append(_issue("TPL_INVALID", "占位符必须是对象", path))
            continue

        placeholder_id = str(item.get("id") or "").strip()
        token = normalize_token(item.get("token"))
        ptype = str(item.get("type") or "text").strip().lower()

        if not placeholder_id:
            issues.append(_issue("TPL_INVALID", "占位符 id 不能为空", f"{path}.id"))
        elif placeholder_id in seen_ids:
            issues.append(_issue("TPL_INVALID", f"占位符 id 重复: {placeholder_id}", f"{path}.id"))
        seen_ids.add(placeholder_id)

        if not token:
            issues.append(_issue("TPL_INVALID", "占位符 token 不能为空", f"{path}.token"))
        elif not is_valid_token(token):
            issues.append(
                _issue(
                    "TPL_INVALID",
                    f"占位符命名不规范（应形如 summary.total_alert）: {token}",
                    f"{path}.token",
                )
            )
        elif token in seen_tokens:
            issues.append(_issue("TPL_INVALID", f"占位符 token 重复: {token}", f"{path}.token"))
        seen_tokens.add(token)

        if ptype not in PLACEHOLDER_TYPES:
            issues.append(
                _issue("TPL_INVALID", f"不支持的占位符类型: {ptype}", f"{path}.type")
            )

        if ptype == "table":
            columns = item.get("columns", [])
            if not isinstance(columns, list) or not columns:
                issues.append(_issue("TPL_INVALID", "表格占位符必须定义 columns", f"{path}.columns"))
                columns = []
            column_keys: set[str] = set()
            for c_index, column in enumerate(columns):
                c_path = f"{path}.columns[{c_index}]"
                if not isinstance(column, dict):
                    issues.append(_issue("TPL_INVALID", "表格列必须是对象", c_path))
                    continue
                key = str(column.get("key") or "").strip()
                if not key:
                    issues.append(_issue("TPL_INVALID", "表格列 key 不能为空", f"{c_path}.key"))
                elif key in column_keys:
                    issues.append(_issue("TPL_INVALID", f"表格列 key 重复: {key}", f"{c_path}.key"))
                column_keys.add(key)
                ctype = str(column.get("type") or "text").strip().lower()
                if ctype not in COLUMN_TYPES:
                    issues.append(
                        _issue("TPL_INVALID", f"不支持的列类型: {ctype}", f"{c_path}.type")
                    )
            max_rows = item.get("max_rows")
            if max_rows is not None and (not isinstance(max_rows, int) or max_rows <= 0):
                issues.append(
                    _issue("TPL_INVALID", "max_rows 必须是正整数", f"{path}.max_rows")
                )

        if "required" in item and not isinstance(item.get("required"), bool):
            issues.append(_issue("TPL_INVALID", "required 必须是布尔值", f"{path}.required"))

    # token 前缀冲突：同时存在 a 与 a.b 会导致上下文结构不唯一
    for token in sorted(seen_tokens):
        parts = token.split(".")
        for depth in range(1, len(parts)):
            prefix = ".".join(parts[:depth])
            if prefix in seen_tokens:
                issues.append(
                    _issue(
                        "TPL_INVALID",
                        f"占位符前缀冲突: {prefix} 与 {token}",
                        "$.placeholders",
                    )
                )
    return issues


# --------------------------------------------------------------------------- #
# 数据采集配置
# --------------------------------------------------------------------------- #
def validate_data_sources(sources: Any) -> list[dict]:
    """校验数据源配置列表。"""
    issues: list[dict] = []
    if not isinstance(sources, list):
        return [_issue("SRC_INVALID", "data_sources 必须是数组", "$.data_sources")]

    seen_keys: set[str] = set()
    for index, source in enumerate(sources):
        path = f"$.data_sources[{index}]"
        if not isinstance(source, dict):
            issues.append(_issue("SRC_INVALID", "数据源必须是对象", path))
            continue

        key = str(source.get("source_key") or "").strip()
        if not key:
            issues.append(_issue("SRC_INVALID", "source_key 不能为空", f"{path}.source_key"))
        elif key in seen_keys:
            issues.append(_issue("SRC_INVALID", f"source_key 重复: {key}", f"{path}.source_key"))
        seen_keys.add(key)

        source_type = str(source.get("source_type") or "").strip().lower()
        if source_type not in SOURCE_TYPES:
            issues.append(
                _issue(
                    "SRC_INVALID",
                    f"不支持的 source_type: {source_type or '(空)'}",
                    f"{path}.source_type",
                )
            )
            continue

        if source_type == "device_action":
            action_id = source.get("action_id")
            if not isinstance(action_id, int) or action_id <= 0:
                issues.append(
                    _issue("SRC_INVALID", "device_action 必须提供正整数 action_id", f"{path}.action_id")
                )
            device_id = source.get("device_id")
            if device_id is not None and (not isinstance(device_id, int) or device_id <= 0):
                issues.append(
                    _issue("SRC_INVALID", "device_id 必须是正整数", f"{path}.device_id")
                )
        elif source_type == "http_tool":
            tool_id = source.get("tool_id")
            tool_name = str(source.get("tool_name") or "").strip()
            if (not isinstance(tool_id, int) or tool_id <= 0) and not tool_name:
                issues.append(
                    _issue(
                        "SRC_INVALID",
                        "http_tool 必须提供 tool_id 或 tool_name",
                        f"{path}.tool_id",
                    )
                )
        elif source_type == "static":
            if "payload" not in source:
                issues.append(
                    _issue("SRC_INVALID", "static 数据源必须提供 payload", f"{path}.payload")
                )

        timeout = source.get("timeout_seconds")
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
            issues.append(
                _issue("SRC_INVALID", "timeout_seconds 必须是正数", f"{path}.timeout_seconds")
            )

        retry = source.get("retry")
        if retry is not None:
            if not isinstance(retry, dict):
                issues.append(_issue("SRC_INVALID", "retry 必须是对象", f"{path}.retry"))
            else:
                attempts = retry.get("max_attempts")
                if attempts is not None and (not isinstance(attempts, int) or attempts < 1 or attempts > 5):
                    issues.append(
                        _issue(
                            "SRC_INVALID",
                            "max_attempts 必须在 1~5 之间",
                            f"{path}.retry.max_attempts",
                        )
                    )

        policy = source.get("on_error")
        if policy is not None and policy not in DEGRADE_POLICIES:
            issues.append(
                _issue("SRC_INVALID", f"不支持的 on_error: {policy}", f"{path}.on_error")
            )
    return issues


# --------------------------------------------------------------------------- #
# 映射配置
# --------------------------------------------------------------------------- #
def _validate_transforms(transforms: Any, path: str) -> list[dict]:
    issues: list[dict] = []
    if transforms is None:
        return issues
    if not isinstance(transforms, list):
        return [_issue("MAP_TRANSFORM", "transforms 必须是数组", path)]
    for index, op in enumerate(transforms):
        op_path = f"{path}[{index}]"
        if not isinstance(op, dict):
            issues.append(_issue("MAP_TRANSFORM", "转换算子必须是对象", op_path))
            continue
        name = str(op.get("op") or "").strip()
        if name not in TRANSFORM_OPS:
            issues.append(
                _issue("MAP_TRANSFORM", f"不支持的转换算子: {name or '(空)'}", f"{op_path}.op")
            )
    return issues


def validate_mapping(
    mapping: Any,
    placeholders: list[dict] | None = None,
    *,
    require_complete: bool = True,
) -> list[dict]:
    """校验映射配置；传入 placeholders 时同时校验占位符引用是否有效。

    Args:
        require_complete: 为 True 时要求必填占位符全部绑定（发布前使用）；
            草稿保存可传 False，允许分批配置。
    """
    issues: list[dict] = []
    if not isinstance(mapping, dict):
        return [_issue("MAP_MISSING", "mapping 必须是对象", "$.mapping")]

    bindings = mapping.get("bindings")
    if not isinstance(bindings, list):
        return [_issue("MAP_MISSING", "bindings 必须是数组", "$.mapping.bindings")]
    if not bindings and require_complete:
        return [_issue("MAP_MISSING", "至少需要一条映射绑定", "$.mapping.bindings")]
    bindings = bindings or []

    known_ids = {str(p.get("id")) for p in (placeholders or []) if isinstance(p, dict)}
    known_tokens = {normalize_token(p.get("token")) for p in (placeholders or []) if isinstance(p, dict)}
    placeholder_by_id = {
        str(p.get("id")): p for p in (placeholders or []) if isinstance(p, dict)
    }

    bound_ids: set[str] = set()
    bound_tokens: set[str] = set()
    for index, binding in enumerate(bindings):
        path = f"$.mapping.bindings[{index}]"
        if not isinstance(binding, dict):
            issues.append(_issue("MAP_MISSING", "绑定必须是对象", path))
            continue

        placeholder_id = str(binding.get("placeholder_id") or "").strip()
        token = normalize_token(binding.get("token"))
        if not placeholder_id and not token:
            issues.append(
                _issue("MAP_MISSING", "绑定必须提供 placeholder_id 或 token", path)
            )
            continue
        if known_ids and placeholder_id and placeholder_id not in known_ids:
            issues.append(
                _issue("MAP_MISSING", f"占位符不存在: {placeholder_id}", f"{path}.placeholder_id")
            )
        if known_tokens and token and token not in known_tokens:
            issues.append(_issue("MAP_MISSING", f"占位符不存在: {token}", f"{path}.token"))
        if placeholder_id:
            if placeholder_id in bound_ids:
                issues.append(
                    _issue("MAP_MISSING", f"占位符重复绑定: {placeholder_id}", f"{path}.placeholder_id")
                )
            bound_ids.add(placeholder_id)
        if token:
            if token in bound_tokens:
                issues.append(_issue("MAP_MISSING", f"占位符重复绑定: {token}", f"{path}.token"))
            bound_tokens.add(token)

        if not str(binding.get("source_key") or "").strip():
            issues.append(_issue("MAP_MISSING", "绑定缺少 source_key", f"{path}.source_key"))
        if not str(binding.get("path") or "").strip():
            issues.append(_issue("MAP_MISSING", "绑定缺少 path", f"{path}.path"))

        policy = binding.get("on_missing")
        if policy is not None and policy not in DEGRADE_POLICIES:
            issues.append(
                _issue("MAP_MISSING", f"不支持的 on_missing: {policy}", f"{path}.on_missing")
            )

        issues.extend(_validate_transforms(binding.get("transforms"), f"{path}.transforms"))

        placeholder = placeholder_by_id.get(placeholder_id) or {}
        is_table = placeholder.get("type") == "table" or binding.get("type") == "table"
        if is_table:
            columns = binding.get("columns")
            if not isinstance(columns, dict) or not columns:
                issues.append(
                    _issue("MAP_MISSING", "表格绑定必须定义 columns 映射", f"{path}.columns")
                )
            else:
                for key, column in columns.items():
                    c_path = f"{path}.columns.{key}"
                    if not isinstance(column, dict) or not str(column.get("path") or "").strip():
                        issues.append(_issue("MAP_MISSING", "表格列缺少 path", c_path))
                        continue
                    issues.extend(_validate_transforms(column.get("transforms"), f"{c_path}.transforms"))
            limit = binding.get("limit")
            if limit is not None and (not isinstance(limit, int) or limit <= 0):
                issues.append(_issue("MAP_MISSING", "limit 必须是正整数", f"{path}.limit"))

    # 必填占位符未绑定（草稿保存时允许不完整）
    if require_complete:
        for placeholder in placeholders or []:
            if not isinstance(placeholder, dict) or not placeholder.get("required"):
                continue
            placeholder_id = str(placeholder.get("id"))
            placeholder_token = normalize_token(placeholder.get("token"))
            if placeholder_id not in bound_ids and placeholder_token not in bound_tokens:
                issues.append(
                    _issue(
                        "MAP_MISSING",
                        f"必填占位符未绑定: {placeholder.get('token') or placeholder.get('id')}",
                        f"$.placeholders.{placeholder.get('id')}",
                    )
                )

    checks = mapping.get("cross_checks")
    if checks is not None:
        if not isinstance(checks, list):
            issues.append(_issue("VAL_CROSS_CHECK", "cross_checks 必须是数组", "$.mapping.cross_checks"))
        else:
            for index, check in enumerate(checks):
                c_path = f"$.mapping.cross_checks[{index}]"
                if not isinstance(check, dict):
                    issues.append(_issue("VAL_CROSS_CHECK", "核对规则必须是对象", c_path))
                    continue
                check_type = str(check.get("type") or "").strip()
                if check_type not in CROSS_CHECK_TYPES:
                    issues.append(
                        _issue(
                            "VAL_CROSS_CHECK",
                            f"不支持的核对类型: {check_type or '(空)'}",
                            f"{c_path}.type",
                        )
                    )
    return issues
