"""数据源采集：并行拉取设备动作 / HTTP 工具 / 静态数据。

复用既有能力，不重复实现 HTTP 细节：
- ``device_action`` → ``app.devices.action_executor.execute_device_action``
  （鉴权、超时、TLS、重试、SSRF 防护、DeviceCallLog 全部复用）；
- ``http_tool`` → ``app.core.tool_http_runner.run_http_tool``
  （声明式请求、鉴权、JSONPath 响应提取全部复用）；
- ``static`` 仅用于试运行、单测与演示。

采集只负责"拿到原始响应"，字段抽取与转换在 ``transform.py``。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable

from app.report.errors import (
    SRC_AUTH,
    SRC_HTTP_4XX,
    SRC_HTTP_5XX,
    SRC_INVALID,
    SRC_NETWORK,
    SRC_PARSE,
    SRC_RATE_LIMIT,
    SRC_TIMEOUT,
    ReportError,
    is_retryable,
)
from app.report.transform import build_data_context, run_cross_checks

_PARAM_RE = re.compile(r"\{\{\s*(?:run|params)\.([A-Za-z_]\w*)\s*\}\}")
_FULL_PARAM_RE = re.compile(r"^\{\{\s*(?:run|params)\.([A-Za-z_]\w*)\s*\}\}$")

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_CONCURRENCY = 5


@dataclass
class SourceResult:
    """单个数据源的采集结果。"""

    source_key: str
    ok: bool
    data: Any = None
    status_code: int | None = None
    latency_ms: int = 0
    attempts: int = 1
    error_code: str | None = None
    error_message: str | None = None
    response_hash: str | None = None
    device_id: int | None = None
    action_id: int | None = None
    fetched_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "source_key": self.source_key,
            "ok": self.ok,
            "status_code": self.status_code,
            "latency_ms": self.latency_ms,
            "attempts": self.attempts,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "response_hash": self.response_hash,
            "device_id": self.device_id,
            "action_id": self.action_id,
            "fetched_at": self.fetched_at,
        }


def render_params(value: Any, params: dict | None) -> Any:
    """递归替换 ``{{run.xxx}}`` / ``{{params.xxx}}`` 占位符。

    若字符串整体就是一个占位符，保留原始类型（数字仍是数字）。
    """
    params = params or {}
    if isinstance(value, str):
        full = _FULL_PARAM_RE.match(value.strip())
        if full:
            return params.get(full.group(1), "")
        return _PARAM_RE.sub(lambda match: str(params.get(match.group(1), "")), value)
    if isinstance(value, dict):
        return {key: render_params(item, params) for key, item in value.items()}
    if isinstance(value, list):
        return [render_params(item, params) for item in value]
    return value


def _classify_status(status_code: int | None) -> str:
    if status_code is None:
        return SRC_NETWORK
    if status_code in (401, 403):
        return SRC_AUTH
    if status_code == 429:
        return SRC_RATE_LIMIT
    if 400 <= status_code < 500:
        return SRC_HTTP_4XX
    if status_code >= 500:
        return SRC_HTTP_5XX
    return SRC_NETWORK


def _hash_payload(data: Any) -> str | None:
    if data is None:
        return None
    try:
        text = json.dumps(data, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:  # noqa: BLE001
        text = str(data)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Fetchers
# --------------------------------------------------------------------------- #
class StaticFetcher:
    """静态数据源：直接返回配置中的 payload（试运行/单测用）。"""

    async def fetch(self, spec: dict, params: dict) -> tuple[Any, int | None]:
        if "payload" not in spec:
            raise ReportError(SRC_INVALID, "static 数据源缺少 payload")
        return render_params(spec.get("payload"), params), None


class DeviceActionFetcher:
    """设备动作数据源：复用 execute_device_action（同步阻塞，放线程执行）。"""

    async def fetch(self, spec: dict, params: dict) -> tuple[Any, int | None]:
        action_id = spec.get("action_id")
        if not isinstance(action_id, int) or action_id <= 0:
            raise ReportError(SRC_INVALID, "device_action 缺少合法的 action_id")
        device_id = spec.get("device_id")
        timeout = spec.get("timeout_seconds")
        call_params = render_params(spec.get("params") or {}, params)

        def _run() -> tuple[Any, int | None]:
            from app.database import SessionLocal
            from app.devices.action_executor import execute_device_action
            from app.models.device import Device, DeviceAction

            db = SessionLocal()
            try:
                action = db.query(DeviceAction).filter(DeviceAction.id == action_id).first()
                if action is None:
                    raise ReportError(SRC_INVALID, f"设备动作不存在: action_id={action_id}")
                if not action.enabled:
                    raise ReportError(SRC_INVALID, f"设备动作已禁用: {action.name}")
                if device_id is not None and action.device_id != int(device_id):
                    raise ReportError(
                        SRC_INVALID,
                        f"动作归属不匹配: action_id={action_id} 属于设备 {action.device_id}",
                    )
                device = db.query(Device).filter(Device.id == action.device_id).first()
                if device is None:
                    raise ReportError(SRC_INVALID, f"设备不存在: id={action.device_id}")
                if not device.enabled:
                    raise ReportError(SRC_INVALID, f"设备已禁用: {device.name}")

                result = execute_device_action(
                    device,
                    action,
                    call_params,
                    float(timeout) if timeout else None,
                    db=db,
                    source="report",
                )
                if not result.get("success"):
                    status_code = result.get("status_code")
                    raise ReportError(
                        _classify_status(status_code),
                        result.get("error") or "设备动作执行失败",
                        {"status_code": status_code},
                    )
                return result.get("response_body"), result.get("status_code")
            finally:
                db.close()

        return await asyncio.to_thread(_run)


class HttpToolFetcher:
    """HTTP 工具数据源：复用声明式 HTTP 工具执行器。"""

    async def fetch(self, spec: dict, params: dict) -> tuple[Any, int | None]:
        tool_id = spec.get("tool_id")
        tool_name = str(spec.get("tool_name") or "").strip()
        call_params = render_params(spec.get("params") or {}, params)

        from app.core.tool_http_runner import run_http_tool
        from app.database import SessionLocal
        from app.models.tool import Tool

        db = SessionLocal()
        try:
            query = db.query(Tool)
            if isinstance(tool_id, int) and tool_id > 0:
                tool = query.filter(Tool.id == tool_id).first()
            elif tool_name:
                tool = query.filter(Tool.name == tool_name).first()
            else:
                raise ReportError(SRC_INVALID, "http_tool 缺少 tool_id 或 tool_name")
            if tool is None:
                raise ReportError(SRC_INVALID, "HTTP 工具不存在")
            if not tool.enabled:
                raise ReportError(SRC_INVALID, f"HTTP 工具已禁用: {tool.name}")
            if tool.tool_type != "http":
                raise ReportError(SRC_INVALID, f"工具不是 HTTP 类型: {tool.name}")
            http_config = tool.http_config or {}
            schema = tool.parameters_schema or []
        finally:
            db.close()

        data = await run_http_tool(http_config, call_params, schema)
        if isinstance(data, dict) and data.get("error"):
            raise ReportError(SRC_PARSE, str(data.get("error")))
        return data, None


def default_fetchers() -> dict[str, Any]:
    return {
        "device_action": DeviceActionFetcher(),
        "http_tool": HttpToolFetcher(),
        "static": StaticFetcher(),
    }


# --------------------------------------------------------------------------- #
# 采集编排
# --------------------------------------------------------------------------- #
async def _collect_one(
    spec: dict,
    params: dict,
    fetcher,
    *,
    default_timeout: float,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> SourceResult:
    source_key = str(spec.get("source_key") or "").strip()
    retry = spec.get("retry") or {}
    max_attempts = retry.get("max_attempts") if isinstance(retry, dict) else 1
    max_attempts = max_attempts if isinstance(max_attempts, int) else 1
    max_attempts = max(1, min(max_attempts, 5))
    timeout = spec.get("timeout_seconds") or default_timeout

    last_error: ReportError | None = None
    started = time.perf_counter()
    attempts_used = 0

    for attempt in range(1, max_attempts + 1):
        attempts_used = attempt
        try:
            data, status_code = await asyncio.wait_for(
                fetcher.fetch(spec, params), timeout=float(timeout)
            )
            return SourceResult(
                source_key=source_key,
                ok=True,
                data=data,
                status_code=status_code,
                latency_ms=int((time.perf_counter() - started) * 1000),
                attempts=attempt,
                response_hash=_hash_payload(data),
                device_id=spec.get("device_id"),
                action_id=spec.get("action_id"),
                fetched_at=_now_iso(),
            )
        except asyncio.TimeoutError:
            last_error = ReportError(SRC_TIMEOUT, f"采集超时（{timeout}s）")
        except ReportError as exc:
            last_error = exc
        except Exception as exc:  # noqa: BLE001
            last_error = ReportError(SRC_NETWORK, f"采集异常: {exc}")

        assert last_error is not None
        if attempt >= max_attempts or not is_retryable(last_error.code):
            break
        # 指数退避 + 上限，避免长时间占用并发槽位
        await (sleep or asyncio.sleep)(min(0.5 * (2 ** (attempt - 1)), 5.0))

    return SourceResult(
        source_key=source_key,
        ok=False,
        latency_ms=int((time.perf_counter() - started) * 1000),
        attempts=attempts_used,
        error_code=last_error.code if last_error else SRC_NETWORK,
        error_message=last_error.message if last_error else "采集失败",
        device_id=spec.get("device_id"),
        action_id=spec.get("action_id"),
        fetched_at=_now_iso(),
    )


async def collect_sources(
    specs: list[dict],
    params: dict | None = None,
    *,
    fetchers: dict[str, Any] | None = None,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    default_timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, SourceResult]:
    """并行采集全部数据源，返回 ``source_key -> SourceResult``。

    单个数据源失败不会中断其他数据源；失败信息由调用方按降级策略处理。
    """
    fetchers = fetchers or default_fetchers()
    params = params or {}
    semaphore = asyncio.Semaphore(max(1, int(max_concurrency)))
    results: dict[str, SourceResult] = {}

    async def _wrapped(spec: dict) -> tuple[str, SourceResult]:
        source_key = str(spec.get("source_key") or "").strip()
        source_type = str(spec.get("source_type") or "").strip()
        async with semaphore:
            fetcher = fetchers.get(source_type)
            if fetcher is None:
                return source_key, SourceResult(
                    source_key=source_key,
                    ok=False,
                    error_code=SRC_INVALID,
                    error_message=f"不支持的数据源类型: {source_type}",
                    fetched_at=_now_iso(),
                )
            return source_key, await _collect_one(
                spec, params, fetcher, default_timeout=default_timeout
            )

    pairs = await asyncio.gather(*[_wrapped(spec) for spec in specs if isinstance(spec, dict)])
    for source_key, result in pairs:
        if source_key:
            results[source_key] = result
    return results


async def collect_and_build(
    specs: list[dict],
    bindings: list[dict],
    params: dict | None = None,
    *,
    cross_checks: list[dict] | None = None,
    fetchers: dict[str, Any] | None = None,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
) -> dict:
    """采集 + 抽取 + 交叉核对的一站式入口（供运行编排与试运行调用）。"""
    sources = await collect_sources(
        specs,
        params,
        fetchers=fetchers,
        max_concurrency=max_concurrency,
    )
    built = build_data_context(bindings, sources, fetched_at=_now_iso())
    built["issues"].extend(run_cross_checks(built["context"], cross_checks))
    built["sources"] = {key: value.to_dict() for key, value in sources.items()}
    built["ok"] = built["ok"] and not any(
        issue.get("severity") == "error" for issue in built["issues"]
    )
    return built
