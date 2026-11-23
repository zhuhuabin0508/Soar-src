"""青藤资产实时查询（按需，不落库）。

与资产发现的入库同步是两条独立通道：
- 入库同步：按模块全量/增量拉取，写入 ``qingteng_hosts`` / ``qingteng_components`` /
  ``qingteng_asset_items``，用于搜索、导出、CVE 匹配；
- 实时查询：本模块，按设备 + 模块 + 条件调用青藤接口，结果直接返回给前端/工具，
  不写入数据库，适合临时核查。

支持模块：账号、用户组、Web 应用、Web 站点、进程、端口、启动项、
安装包、软件应用、数据库、Web 框架。
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

import httpx

from app.core.qingteng_component_sync import _to_int
from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import _qingteng_login, _qingteng_signheaders
from app.models.device import Device

logger = logging.getLogger(__name__)

PAGE_SIZE = 200
MAX_PAGES = 5
MAX_LIMIT = 200

_SENSITIVE = re.compile(r"pass(word|wd)|secret|token|private.?key|credential", re.IGNORECASE)

# 模块配置：接口、OS 支持、关键字匹配字段、端口字段、返回列
REALTIME_MODULES: dict[str, dict[str, Any]] = {
    "account": {
        "label": "系统账号",
        "groups": ("qingteng_host", "qingteng_asset"),
        "path": "/external/api/assets/account/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "home"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "账号名"), ("status", "状态"), ("home", "家目录"),
            ("uid", "UID"), ("gid", "GID"), ("lastLoginTime", "最后登录"),
        ],
    },
    "accountgroup": {
        "label": "用户组",
        "groups": ("qingteng_host", "qingteng_asset"),
        "path": "/external/api/assets/accountgroup/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name",),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "用户组名"), ("gid", "GID"),
        ],
    },
    "webapp": {
        "label": "Web 应用",
        "groups": ("qingteng_host", "qingteng_asset"),
        "path": "/external/api/assets/webapp/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("appName", "name", "version", "domainName", "serverName", "webRoot"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("appName", "Web 应用"), ("version", "版本"), ("webRoot", "应用路径"),
            ("serverName", "服务名"), ("domainName", "域名"), ("rootPath", "根路径"),
        ],
    },
    "website": {
        "label": "Web 站点",
        "groups": ("qingteng_host", "qingteng_asset"),
        "path": "/external/api/assets/website/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "proto", "type", "rootPath"),
        "port_key": "port",
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "站点"), ("port", "端口"), ("proto", "协议"),
            ("type", "站点类型"), ("rootPath", "根路径"),
        ],
    },
    "process": {
        "label": "进程",
        "groups": ("qingteng_host",),
        "path": "/external/api/assets/process/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "processName", "path", "user"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "进程名"), ("pid", "PID"), ("user", "运行用户"),
            ("path", "进程路径"), ("startTime", "启动时间"),
        ],
    },
    "port": {
        "label": "端口",
        "groups": ("qingteng_host",),
        "path": "/external/api/assets/port/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("processName", "name", "proto", "bindIp"),
        "port_key": "port",
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("proto", "协议"), ("bindIp", "绑定 IP"), ("port", "端口"),
            ("processName", "进程名"), ("pid", "PID"),
        ],
    },
    "service": {
        "label": "启动项",
        "groups": ("qingteng_host",),
        "path": "/external/api/assets/service/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "serviceName", "path"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "服务名"), ("status", "状态"), ("path", "路径"),
        ],
    },
    "pkg": {
        "label": "安装包",
        "groups": ("qingteng_component",),
        "path": "/external/api/assets/pkg/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "version", "path"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "安装包"), ("version", "版本"), ("path", "安装路径"),
        ],
    },
    "app": {
        "label": "软件应用",
        "groups": ("qingteng_component",),
        "path": "/external/api/assets/app/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "appName", "version", "path"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "软件应用"), ("version", "版本"), ("path", "路径"),
        ],
    },
    "dbinfo": {
        "label": "数据库",
        "groups": ("qingteng_component",),
        "path": "/external/api/assets/dbinfo/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "version", "path"),
        "port_key": "port",
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "数据库"), ("version", "版本"), ("port", "端口"), ("path", "路径"),
        ],
    },
    "webframe": {
        "label": "Web 框架",
        "groups": ("qingteng_component",),
        "path": "/external/api/assets/webframe/{os}",
        "os_types": ("linux", "win"),
        "match_keys": ("name", "version", "path"),
        "columns": [
            ("hostname", "主机名"), ("displayIp", "展示 IP"), ("osType", "系统类型"),
            ("name", "Web 框架"), ("version", "版本"), ("path", "路径"),
        ],
    },
}
REALTIME_MODULE_ORDER = tuple(REALTIME_MODULES)


def _norm(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", text)


def _scalar(value: Any) -> Any:
    """只保留可展示的标量，列表/字典不进结果表。"""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None


def _host_ctx(row: dict, os_type: str) -> dict:
    return {
        "hostname": str(row.get("hostname") or ""),
        "displayIp": str(row.get("displayIp") or ""),
        "internalIp": str(row.get("internalIp") or ""),
        "externalIp": str(row.get("externalIp") or ""),
        "osType": os_type,
        "agentId": str(row.get("agentId") or ""),
        "bizGroup": str(row.get("bizGroup") or ""),
    }


def _matches(row: dict, keyword_norm: str, match_keys: tuple[str, ...]) -> bool:
    if not keyword_norm:
        return True
    keys = match_keys or tuple(row.keys())
    return any(keyword_norm in _norm(row.get(k)) for k in keys)


def _parse(resp: httpx.Response, path: str) -> dict:
    try:
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"青藤接口返回非 JSON: HTTP {resp.status_code}") from exc
    if resp.status_code >= 400:
        message = payload.get("message") if isinstance(payload, dict) else None
        raise RuntimeError(f"青藤接口失败 HTTP {resp.status_code}: {message or payload}")
    if not isinstance(payload, dict):
        raise RuntimeError(f"青藤接口响应格式异常: {path}")
    code = payload.get("code")
    if code not in (None, 0, 200):
        raise RuntimeError(f"青藤接口业务失败 code={code}: {payload.get('message') or payload}")
    return payload.get("data") if isinstance(payload.get("data"), dict) else payload


def realtime_query(
    device: Device,
    module: str,
    *,
    keyword: str = "",
    agent_id: str = "",
    ip: str = "",
    hostname: str = "",
    port: int | None = None,
    os_type: str = "",
    limit: int = 50,
) -> dict[str, Any]:
    """实时查询单台青藤设备的指定模块。"""
    spec = REALTIME_MODULES.get(module)
    if not spec:
        raise ValueError(f"不支持的实时查询模块: {module}")

    keyword = (keyword or "").strip()
    agent_id = (agent_id or "").strip()
    ip = (ip or "").strip()
    hostname = (hostname or "").strip()
    if not any((keyword, agent_id, ip, hostname, port)):
        raise ValueError("至少提供一个查询条件（关键词 / agentId / IP / 主机名 / 端口）")

    limit = max(1, min(int(limit or 50), MAX_LIMIT))
    os_types = [os_type] if os_type in ("linux", "win") else list(spec["os_types"])
    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="青藤 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    comid, jwt, signkey = _qingteng_login(device, timeout, verify)

    keyword_norm = _norm(keyword)
    match_keys = tuple(spec["match_keys"])
    columns = spec["columns"]
    rows: list[dict] = []
    seen: set[tuple] = set()
    warnings: list[str] = []
    scanned = 0
    total = 0

    with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
        for os_name in os_types:
            path = spec["path"].format(os=os_name)
            page = 0
            while page < MAX_PAGES and len(rows) < limit:
                params: dict[str, Any] = {"page": page, "size": PAGE_SIZE}
                if agent_id:
                    params["agentId"] = agent_id
                if ip:
                    params["ip"] = ip
                if hostname:
                    params["hostname"] = hostname
                if port and spec.get("port_key"):
                    params["port"] = int(port)
                if keyword:
                    # 青藤多数资产接口支持 name 模糊过滤；不支持的模块会忽略该参数，
                    # 下面仍会做本地二次匹配兜底。
                    params["name"] = keyword
                headers, _, final_url = _qingteng_signheaders(
                    comid, jwt, signkey, "GET", params, None, f"{base_url}{path}",
                )
                resp = client.get(final_url, headers=headers)
                data = _parse(resp, path)
                page_rows = data.get("rows") or []
                total = max(total, int(data.get("total") or 0))
                if not page_rows:
                    break
                for raw in page_rows:
                    scanned += 1
                    if not isinstance(raw, dict):
                        continue
                    if not _matches(raw, keyword_norm, match_keys):
                        continue
                    row_port = _to_int(raw.get("port"))
                    if port and row_port is not None and row_port != int(port):
                        continue
                    out = _host_ctx(raw, os_name)
                    for key, value in raw.items():
                        if _SENSITIVE.search(key):
                            continue
                        scalar = _scalar(value)
                        if scalar is not None:
                            out[key] = scalar
                    # 同一 agent 在 linux/win 两个接口可能被重复返回，按主机+对象去重
                    dedupe_key = (
                        out.get("agentId") or out.get("displayIp"),
                        out.get("name") or out.get("appName")
                        or out.get("processName") or out.get("proto"),
                        out.get("port"),
                        out.get("path") or out.get("webRoot") or out.get("rootPath"),
                    )
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)
                    rows.append(out)
                    if len(rows) >= limit:
                        break
                if len(page_rows) < PAGE_SIZE:
                    break
                page += 1

    if len(rows) >= limit and total > scanned:
        warnings.append(f"结果按上限截断，仅返回前 {limit} 条；可增加更精确的查询条件")
    elif total > scanned:
        warnings.append(f"仅扫描前 {scanned} 条（共 {total} 条），如需全量请使用资产同步")

    return {
        "device_id": device.id,
        "device_name": device.name,
        "module": module,
        "module_label": spec["label"],
        "filters": {
            "keyword": keyword,
            "agent_id": agent_id,
            "ip": ip,
            "hostname": hostname,
            "port": port,
            "os_type": os_type,
        },
        "columns": [{"key": k, "label": label} for k, label in columns],
        "total": total,
        "scanned": scanned,
        "matched": len(rows),
        "rows": rows,
        "warnings": warnings,
        "queried_at": beijing_now().strftime("%Y-%m-%d %H:%M:%S"),
    }
