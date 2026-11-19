"""青藤万相组件检索：按组件关键字（如 redis）反查主机、命中证据与组件版本。

青藤资产清单接口的 ``name`` 参数是**模糊匹配**（``redis`` 会命中 ``redisson``、
``redis-cli`` 等），且不同资源类型的名称/版本字段不一致，本模块在拉取后统一清洗：

- NFKC 归一化 + 小写，名称按非字母数字切分为词元，关键字按**词边界**匹配；
- 排除词过滤：客户端/工具/文档/源码包等（``redis-tools``、``redis-doc`` 不计入）；
- 占位版本（``-`` / ``unknown`` / ``未知`` / ``0.0.0``）统一标记为「版本未知」；
- 按 ``agentId`` 聚合，同主机同组件同版本去重，证据按来源优先级排序。

版本取值优先级：``app.version`` > ``pkg.version`` > ``process.packageVersion``。

结果缓存 10 分钟（按设备 + 关键字 + 端口），支持强制刷新。
"""
from __future__ import annotations

import copy
import logging
import re
import threading
import time
import unicodedata
from typing import Any, Iterable

import httpx

from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import _qingteng_login, _qingteng_signheaders
from app.models.device import Device

logger = logging.getLogger(__name__)

PAGE_SIZE = 500
MAX_PAGES = 201
# 单资源类型（linux + win 合计）记录上限，避免超大环境占满内存
MAX_ROWS_PER_SOURCE = 100_000
# 缓存有效期（秒）
CACHE_TTL = 600
# 单次返回主机上限的保护值
MAX_LIMIT = 200

# 资源类型 → 接口与字段口径（顺序即证据优先级）
SOURCE_SPECS: dict[str, dict[str, Any]] = {
    "app": {
        "label": "软件应用",
        "path": "/external/api/assets/app/{os}",
        "name_param": "name",
        "version_fields": ("version",),
    },
    "pkg": {
        "label": "安装包",
        "path": "/external/api/assets/pkg/{os}",
        "name_param": "name",
        "version_fields": ("version",),
    },
    "process": {
        "label": "运行进程",
        "path": "/external/api/assets/process/{os}",
        "name_param": "name",
        "version_fields": ("packageVersion", "version"),
    },
    "dbinfo": {
        "label": "数据库",
        "path": "/external/api/assets/dbinfo/{os}",
        "name_param": "name",
        "version_fields": ("version",),
    },
    "service": {
        "label": "服务/启动项",
        "path": "/external/api/assets/service/{os}",
        "name_param": "name",
        "version_fields": (),
    },
    "port": {
        "label": "监听端口",
        "path": "/external/api/assets/port/{os}",
        "name_param": "processName",
        "version_fields": (),
    },
}

SOURCE_PRIORITY = {name: i for i, name in enumerate(SOURCE_SPECS)}

# 通用的非组件词元（文档、调试、源码、示例包等），命中即排除
_BASE_EXCLUDE_TOKENS = frozenset({
    "doc", "docs", "debug", "debuginfo", "devel", "dev", "develop",
    "source", "src", "test", "tests", "sample", "samples",
    "example", "examples", "manual", "man",
})

# 关键字维度的额外排除词：客户端/工具/辅助进程不算目标组件
_KEYWORD_EXCLUDE_WORDS: dict[str, tuple[str, ...]] = {
    "redis": (
        "cli", "tools", "sentinel", "py", "python", "java", "js",
        "hiredis", "ioredis", "predis", "phpredis", "redisson", "jedis", "lettuce",
    ),
}

_PLACEHOLDER_VERSIONS = frozenset({
    "", "-", "--", "unknown", "未知", "n/a", "na", "none", "null", "nil",
    "0", "0.0", "0.0.0", "?", "??", "not installed", "未采集", "未获取", "无",
})

_TOKEN_RE = re.compile(r"[0-9a-z]+")
_EPOCH_RE = re.compile(r"^\d+:")

# (设备 ID, 关键字, 端口, 是否明细) → 结果；查询只读，重建时整体替换
_CACHE: dict[tuple[Any, str, int | None, bool], dict[str, Any]] = {}
_BUILD_LOCK = threading.Lock()


def normalize_keyword(keyword: str) -> str:
    """关键字归一化：NFKC、去首尾空白、转小写。

    Raises:
        ValueError: 关键字为空或少于 2 个字符。
    """
    text = unicodedata.normalize("NFKC", str(keyword or "")).strip().lower()
    if len(text) < 2:
        raise ValueError("组件关键字至少 2 个字符，示例：redis")
    return text


def _tokens(text: str) -> list[str]:
    """按非字母数字切词，用于词边界匹配与排除词判断。"""
    return _TOKEN_RE.findall(str(text or "").lower())


def name_matches(name: str, keyword: str) -> tuple[bool, str]:
    """判断组件名是否命中关键字。

    英文/数字按词边界匹配（redis 不命中 redisson）；中文等非 ASCII
    关键字没有词边界概念，退化为子串匹配（达梦命中「达梦数据库」）。

    Returns:
        (是否命中, 命中类型 ``exact``/``prefix``/``contains``)
    """
    text = unicodedata.normalize("NFKC", str(name or "")).strip().lower()
    kw = unicodedata.normalize("NFKC", str(keyword or "")).strip().lower()
    if not kw:
        return False, ""
    # 含中文等非 ASCII 字符的关键字没有词边界，按子串匹配
    if any(ord(ch) > 127 for ch in kw):
        if kw not in text:
            return False, ""
        return True, "exact" if text == kw else "contains"

    kw_tokens = _tokens(kw)
    if not kw_tokens:
        return False, ""

    tokens = _tokens(text)
    if not tokens:
        return False, ""
    n = len(kw_tokens)
    for i in range(len(tokens) - n + 1):
        if tokens[i:i + n] != kw_tokens:
            continue
        if len(tokens) == n:
            return True, "exact"
        return True, "prefix" if i == 0 else "contains"
    return False, ""


def _exclude_tokens(keyword: str) -> frozenset[str]:
    """该关键字适用的排除词元集合（通用词 + 关键字专属词）。"""
    extra = _KEYWORD_EXCLUDE_WORDS.get(keyword, ())
    return _BASE_EXCLUDE_TOKENS | {t.lower() for t in extra}


def _is_excluded(tokens: Iterable[str], excludes: frozenset[str]) -> bool:
    return any(t in excludes for t in tokens)


def clean_version(value: Any) -> tuple[str, str]:
    """版本清洗：返回 (原始版本, 归一化版本)；占位值返回 ("", "")。"""
    raw = str(value or "").strip()
    if raw.lower() in _PLACEHOLDER_VERSIONS:
        return "", ""
    norm = _EPOCH_RE.sub("", raw).strip()
    if not norm or norm.lower() in _PLACEHOLDER_VERSIONS:
        return "", ""
    return raw, norm


def _pick_version(row: dict, spec: dict) -> tuple[str, str]:
    """按字段优先级取第一个有效版本。"""
    for field in spec.get("version_fields") or ():
        raw, norm = clean_version(row.get(field))
        if norm:
            return raw, norm
    return "", ""


def _host_key(row: dict) -> str:
    return str(row.get("agentId") or row.get("displayIp") or row.get("internalIp") or "")


def _host_ctx(row: dict) -> dict[str, Any]:
    return {
        "agent_id": str(row.get("agentId") or ""),
        "host_ip": str(row.get("displayIp") or row.get("internalIp") or ""),
        "display_ip": str(row.get("displayIp") or ""),
        "internal_ip": str(row.get("internalIp") or ""),
        "external_ip": str(row.get("externalIp") or ""),
        "host_name": str(row.get("hostname") or ""),
        "biz_group": str(row.get("bizGroup") or ""),
        "remark": str(row.get("remark") or ""),
    }


def _confidence(match_type: str, version_known: bool, source: str) -> str:
    """证据等级：组件名精确命中且版本可靠为高；端口监听为运行态强证据取中。"""
    if source == "port":
        return "中"
    if not version_known:
        return "低"
    return "高" if match_type == "exact" else "中"


def _evidence(row: dict, source: str, name: str, version: str, match_type: str) -> dict[str, Any]:
    spec = SOURCE_SPECS[source]
    known = bool(version)
    evidence = {
        "source": source,
        "source_label": spec["label"],
        "component": name,
        "version": version or "",
        "version_state": "known" if known else "unknown",
        "match_type": match_type,
        "confidence": _confidence(match_type, known, source),
    }
    for field in ("path", "binPath", "configPath", "installTime", "type", "publisher"):
        value = row.get(field)
        if value not in (None, ""):
            evidence[field] = value
    if source == "port":
        evidence["port"] = row.get("port")
        evidence["proto"] = str(row.get("proto") or "")
        evidence["bind_ip"] = str(row.get("bindIp") or "")
    if source == "process":
        evidence["pid"] = row.get("pid")
        evidence["uname"] = str(row.get("uname") or "")
        evidence["start_args"] = str(row.get("startArgs") or "")
    if source == "dbinfo":
        evidence["db_port"] = row.get("port")
    return evidence


def aggregate(
    keyword: str,
    source_rows: dict[str, list[dict]],
    port: int | None = None,
    limit: int = 20,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    """把各资源类型的清单行聚合为主机维度的检索结果（纯函数，便于单测）。"""
    kw = normalize_keyword(keyword)
    excludes = _exclude_tokens(kw)
    notes = list(warnings or [])
    hosts: dict[str, dict[str, Any]] = {}
    seen: set[tuple[str, str, str, str]] = set()
    stats = {
        "scanned_rows": 0,
        "matched_rows": 0,
        "mismatched_rows": 0,
        "excluded_rows": 0,
        "duplicate_rows": 0,
        "unknown_version_rows": 0,
    }

    # 端口条件：只保留该端口确实在监听的主机（其它来源仅作证据补充）
    port_agents: set[str] | None = None
    if port is not None:
        port_agents = set()
        for row in source_rows.get("port", []):
            if str(row.get("port") or "").strip() == str(port):
                port_agents.add(_host_key(row))

    for source, rows in source_rows.items():
        spec = SOURCE_SPECS.get(source)
        if spec is None:
            continue
        for row in rows:
            stats["scanned_rows"] += 1
            name = str(row.get(spec["name_param"]) or "").strip()
            matched, match_type = name_matches(name, kw)
            if not matched:
                stats["mismatched_rows"] += 1
                continue
            if _is_excluded(_tokens(name), excludes):
                stats["excluded_rows"] += 1
                continue
            key = _host_key(row)
            if not key:
                stats["mismatched_rows"] += 1
                continue
            if port_agents is not None and key not in port_agents:
                continue

            version, norm_version = _pick_version(row, spec)
            if not version:
                stats["unknown_version_rows"] += 1
            stats["matched_rows"] += 1

            dedupe_key = (key, source, name.lower(), norm_version)
            if dedupe_key in seen:
                stats["duplicate_rows"] += 1
                continue
            seen.add(dedupe_key)

            host = hosts.get(key)
            if host is None:
                host = _host_ctx(row)
                host["evidence"] = []
                hosts[key] = host
            else:
                # 列表行字段可能不全，空值用后续行补齐
                for field, value in _host_ctx(row).items():
                    if not host.get(field) and value:
                        host[field] = value
            host["evidence"].append(_evidence(row, source, name, version, match_type))

    if port is not None and not port_agents:
        notes.append(f"端口 {port} 未在青藤端口清单中命中，已无法按端口过滤")

    total_hosts = len(hosts)
    detail_hosts = []
    for host in hosts.values():
        host["evidence"].sort(
            key=lambda e: (SOURCE_PRIORITY.get(e["source"], 99), e["component"].lower())
        )
        host["hit_count"] = len(host["evidence"])
        host["version_known"] = any(e["version_state"] == "known" for e in host["evidence"])
        detail_hosts.append(host)

    # 有版本的、命中证据多的排前面
    detail_hosts.sort(
        key=lambda h: (not h["version_known"], -h["hit_count"], h.get("host_ip") or "")
    )
    has_more = len(detail_hosts) > limit
    if has_more:
        notes.append(f"命中主机 {len(detail_hosts)} 台，仅返回前 {limit} 台，请缩小关键字或加端口条件")
    returned = detail_hosts[:limit]

    unknown_hosts = sum(1 for h in detail_hosts if not h["version_known"])
    if stats["unknown_version_rows"]:
        notes.append(
            f"{stats['unknown_version_rows']} 条命中记录的版本为空或占位值，已标记为「版本未知」"
        )
    if stats["excluded_rows"]:
        notes.append(
            f"已排除 {stats['excluded_rows']} 条客户端/工具/文档类记录（如 redis-cli、redis-doc）"
        )

    return {
        "keyword": kw,
        "port": port,
        "built_at": beijing_now().strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {
            "host_count": total_hosts,
            "returned_host_count": len(returned),
            "evidence_count": sum(h["hit_count"] for h in detail_hosts),
            "version_known_host_count": total_hosts - unknown_hosts,
            "version_unknown_host_count": unknown_hosts,
        },
        "data_quality": {
            **stats,
            "exclude_keywords": sorted(excludes),
        },
        "has_more": has_more,
        "warnings": notes,
        "hosts": returned,
    }


def search_components(
    device: Device,
    keyword: str,
    port: int | None = None,
    limit: int = 20,
    detail: bool = False,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """检索组件关键字命中的主机及证据。

    Args:
        device: auth_type=qingteng 的设备（使用其 api_url/凭据/超时/TLS 配置）。
        keyword: 组件关键字，如 redis / nginx / openjdk。
        port: 可选，只保留该端口在监听的主机（端口清单参与证据）。
        limit: 返回主机数上限（默认 20，最大 200）。
        detail: 是否在结果中附带各资源类型的原始行数统计。
        force_refresh: 忽略 10 分钟缓存。

    Raises:
        ValueError: 关键字或端口非法。
        RuntimeError: 登录或接口失败（单资源失败降级为告警）。
    """
    kw = normalize_keyword(keyword)
    if port is not None:
        try:
            port = int(port)
        except (TypeError, ValueError):
            raise ValueError("port 必须为整数") from None
        if not 0 < port < 65536:
            raise ValueError("port 必须在 1-65535 之间")
    limit = max(1, min(int(limit or 20), MAX_LIMIT))

    cache_key = (getattr(device, "id", None), kw, port, bool(detail))
    cached = _CACHE.get(cache_key)
    if not force_refresh and cached and cached["expires_at"] > time.time():
        return copy.deepcopy(cached["result"])

    with _BUILD_LOCK:
        cached = _CACHE.get(cache_key)
        if not force_refresh and cached and cached["expires_at"] > time.time():
            return copy.deepcopy(cached["result"])
        result = _build(device, kw, port, limit, detail)
        _CACHE[cache_key] = {"expires_at": time.time() + CACHE_TTL, "result": result}
        return copy.deepcopy(result)


def _build(device: Device, keyword: str, port: int | None, limit: int, detail: bool) -> dict[str, Any]:
    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="青藤 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    comid, jwt, signkey = _qingteng_login(device, timeout, verify)

    source_rows: dict[str, list[dict]] = {}
    raw_counts: dict[str, int] = {}
    failed_sources: set[str] = set()
    warnings: list[str] = []

    with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
        for source, spec in SOURCE_SPECS.items():
            rows: list[dict] = []
            failed_os: list[str] = []
            for os_type in ("linux", "win"):
                path = spec["path"].format(os=os_type)
                params: dict[str, Any] = {spec["name_param"]: keyword}
                if source == "port" and port is not None:
                    params["port"] = str(port)
                try:
                    rows.extend(
                        _fetch_rows(client, base_url, comid, jwt, signkey, path, params)
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "青藤组件检索拉取失败 source=%s os=%s err=%s", source, os_type, exc
                    )
                    failed_os.append(os_type)
            if failed_os and len(failed_os) == 2:
                warnings.append(f"{spec['label']}清单拉取失败：{source}")
                failed_sources.add(source)
            elif failed_os:
                warnings.append(f"{spec['label']}清单 {','.join(failed_os)} 拉取失败")
            source_rows[source] = rows
            raw_counts[source] = len(rows)

    # 端口清单整体不可用时不再按端口过滤，避免误报“无主机命中”
    effective_port = port
    if port is not None and "port" in failed_sources:
        effective_port = None
        warnings.append(f"端口清单拉取失败，本次未按端口 {port} 过滤，结果可能偏多")

    result = aggregate(keyword, source_rows, port=effective_port, limit=limit, warnings=warnings)
    result["requested_port"] = port
    result["device"] = {"id": getattr(device, "id", None), "name": getattr(device, "name", "")}
    if detail:
        # 明细模式附加各资源类型原始行数，便于排查“为什么没命中”
        result["data_quality"]["source_rows"] = raw_counts

    logger.info(
        "青藤组件检索完成 device=%s(%s) keyword=%s port=%s hosts=%d rows=%s",
        getattr(device, "name", ""), getattr(device, "id", None), keyword, port,
        result["summary"]["host_count"], raw_counts,
    )
    return result


def _fetch_rows(
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    path: str,
    params: dict[str, Any],
) -> list[dict]:
    """分页拉取列表；接口忽略分页时通过记录重复检测提前退出。"""
    rows: list[dict] = []
    seen: set[str] = set()
    page = 0
    while page < MAX_PAGES and len(rows) < MAX_ROWS_PER_SOURCE:
        query = {**params, "page": page, "size": PAGE_SIZE}
        headers, _, final_url = _qingteng_signheaders(
            comid, jwt, signkey, "GET", query, None, f"{base_url}{path}",
        )
        resp = client.get(final_url, headers=headers)
        data = _parse(resp, path)
        page_rows = data.get("rows") or []
        if not page_rows:
            break
        added = 0
        for row in page_rows:
            key = _row_key(row)
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
            added += 1
        total = int(data.get("total") or 0)
        if added == 0 or len(page_rows) < PAGE_SIZE:
            break
        page += 1
        if total and len(rows) >= total:
            break
    if len(rows) >= MAX_ROWS_PER_SOURCE:
        logger.warning("青藤组件检索达到记录上限 %d path=%s", MAX_ROWS_PER_SOURCE, path)
    return rows


def _row_key(row: dict) -> str:
    """单条清单记录去重键；接口忽略分页时可据此提前退出。"""
    return "|".join(
        str(row.get(k) or "")
        for k in (
            "id", "agentId", "pid", "name", "processName",
            "port", "path", "version", "packageVersion",
        )
    )


def _parse(resp: httpx.Response, phase: str) -> dict:
    if resp.status_code >= 400:
        raise RuntimeError(f"青藤接口失败 HTTP {resp.status_code}: {resp.text[:300]} ({phase})")
    try:
        data = resp.json() or {}
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"青藤接口返回非 JSON: {resp.text[:200]} ({phase})") from None
    if data.get("success") is False:
        raise RuntimeError(
            f"青藤接口失败: {data.get('message') or data.get('errorMessage') or data} ({phase})"
        )
    error_msg = data.get("errorMessage") or data.get("errorDesc") or ""
    if data.get("errorCode") not in (None, "", 0, "0") or error_msg:
        raise RuntimeError(
            f"青藤接口失败: {data.get('errorCode') or ''} {error_msg or data} ({phase})".strip()
        )
    return data
