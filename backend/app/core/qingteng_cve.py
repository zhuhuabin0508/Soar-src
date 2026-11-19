"""青藤万相 CVE 影响面实时查询。

青藤没有“按 CVE 查主机”的直接接口，本模块在进程内做一层索引：
- 漏洞检测：``/external/api/vul/poc/{os}/list`` 拿主机命中记录，详情 ``cves`` 提供 CVE；
- 补丁检测：``/external/api/vul/patch/{os}/list`` 拿主机命中记录，详情 ``ref`` 提供 CVE；
- 详情按唯一 ``vulId`` / ``patchId`` 拉取并缓存，避免按主机重复调用；
- 按 CVE 建立倒排索引，查询时直接返回主机及命中证据。

进程/组件清单不参与 CVE 判定（其中没有 CVE 字段），仅可作为辅助展示。
缓存默认 10 分钟，可显式 refresh 强制重建。
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterable

import httpx

from app.core.security import validate_outbound_url
from app.core.timezone import beijing_now
from app.devices.action_executor import _qingteng_login, _qingteng_signheaders
from app.models.device import Device

logger = logging.getLogger(__name__)

# 单个 OS 资源的分页参数（青藤接口未声明过滤条件，按全量拉取处理）
PAGE_SIZE = 500
MAX_PAGES = 200
# 单类风险主机命中记录上限，避免超大环境占用过多内存
MAX_LIST_ROWS = 200_000
# 详情并发度与总量上限，避免异常环境拖垮平台
DETAIL_WORKERS = 6
MAX_DETAIL_ITEMS = 5000
# 索引缓存有效期（秒）
CACHE_TTL = 600

_CVE_RE = re.compile(r"CVE-\d{4}-\d{4,7}", re.IGNORECASE)

# 风险等级：漏洞接口 0-4；补丁接口 1-4
_POC_SEVERITY = {0: "信息", 1: "低危", 2: "中危", 3: "高危", 4: "危急"}
_PATCH_SEVERITY = {1: "低危", 2: "中危", 3: "高危", 4: "危急"}

SOURCE_LABELS = {
    "linux_poc": "Linux 漏洞检测",
    "win_poc": "Windows 漏洞检测",
    "linux_patch": "Linux 补丁",
    "win_patch": "Windows 补丁",
}

# device_id -> 索引；查询只读，重建时整体替换
_CACHE: dict[int, dict[str, Any]] = {}
_BUILD_LOCK = threading.Lock()


def normalize_cve(value: str) -> str:
    """CVE 编号归一化：去空格、转大写、校验格式。"""
    cve = (value or "").strip().upper()
    if not _CVE_RE.fullmatch(cve):
        raise ValueError("CVE 编号格式不正确，示例：CVE-2024-21762")
    return cve


def extract_cves(value: Any) -> list[str]:
    """从 ``cves`` 数组或逗号分隔的 ``ref`` 字符串中提取 CVE 列表。"""
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        text = ",".join(str(v) for v in value if v is not None)
    else:
        text = str(value)
    return sorted({m.group(0).upper() for m in _CVE_RE.finditer(text)})


def query_cve_hosts(device: Device, cve: str, force_refresh: bool = False) -> dict[str, Any]:
    """查询指定 CVE 在青藤中命中的主机及命中证据。

    Raises:
        ValueError: CVE 格式错误。
        RuntimeError: 登录或核心接口失败。
    """
    cve = normalize_cve(cve)
    index = _get_index(device, force_refresh=force_refresh)

    host_hits: dict[int, list[tuple[str, str]]] = defaultdict(list)
    for source, vul_id, host_idx in index["hits_by_cve"].get(cve, []):
        host_hits[host_idx].append((source, vul_id))

    hosts = []
    for host_idx, pairs in host_hits.items():
        host = dict(index["hosts"][host_idx])
        hits = []
        seen = set()
        for source, vul_id in pairs:
            key = (source, vul_id)
            if key in seen:
                continue
            seen.add(key)
            meta = index["meta"].get(key)
            if not meta:
                continue
            hits.append({
                "source": source,
                "source_label": SOURCE_LABELS.get(source, source),
                "vul_id": vul_id,
                **meta,
            })
        # 命中按危险等级倒序，其次按漏洞名
        hits.sort(key=lambda h: (-int(h.get("severity_code") or 0), h.get("vul_name") or ""))
        if not hits:
            continue
        host["hits"] = hits
        host["hit_count"] = len(hits)
        hosts.append(host)

    hosts.sort(key=lambda h: (h.get("host_ip") or "", h.get("host_name") or ""))

    return {
        "cve": cve,
        "covered": bool(index["hits_by_cve"].get(cve)),
        "built_at": index["built_at"],
        "summary": {
            "host_count": len(hosts),
            "hit_count": sum(h["hit_count"] for h in hosts),
            "source_count": len(index["source_counts"]),
        },
        "source_counts": index["source_counts"],
        "warnings": index["warnings"],
        "hosts": hosts,
    }


def _get_index(device: Device, force_refresh: bool = False) -> dict[str, Any]:
    """取设备索引；过期或强制刷新时重建。"""
    cached = _CACHE.get(device.id)
    if not force_refresh and cached and cached["expires_at"] > time.time():
        return cached
    with _BUILD_LOCK:
        cached = _CACHE.get(device.id)
        if not force_refresh and cached and cached["expires_at"] > time.time():
            return cached
        index = _build_index(device)
        _CACHE[device.id] = index
        return index


def _build_index(device: Device) -> dict[str, Any]:
    base_url = (device.api_url or "").rstrip("/")
    validate_outbound_url(base_url, field="青藤 api_url")
    timeout = float(device.timeout or 30)
    verify = bool(device.verify_tls)
    comid, jwt, signkey = _qingteng_login(device, timeout, verify)

    hosts: list[dict[str, Any]] = []
    host_index: dict[str, int] = {}
    meta: dict[tuple[str, str], dict[str, Any]] = {}
    hits_by_cve: dict[str, list[tuple[str, str, int]]] = defaultdict(list)
    source_counts: dict[str, int] = {}
    warnings: list[str] = []

    with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
        for source, path, detail_prefix in (
            ("linux_poc", "/external/api/vul/poc/linux/list", "/external/api/vul/poc/linux/"),
            ("win_poc", "/external/api/vul/poc/win/list", "/external/api/vul/poc/win/"),
            ("linux_patch", "/external/api/vul/patch/linux/list", "/external/api/vul/patch/linux/"),
            ("win_patch", "/external/api/vul/patch/win/list", "/external/api/vul/patch/win/"),
        ):
            try:
                rows = _fetch_all_rows(client, base_url, comid, jwt, signkey, path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("青藤 CVE 索引拉取失败 source=%s err=%s", source, exc)
                warnings.append(f"{SOURCE_LABELS[source]}拉取失败：{exc}")
                continue
            try:
                count = _merge_source(
                    source, rows, detail_prefix, client, base_url, comid, jwt, signkey,
                    hosts, host_index, meta, hits_by_cve, warnings,
                )
                source_counts[source] = count
            except Exception as exc:  # noqa: BLE001
                logger.warning("青藤 CVE 索引构建失败 source=%s err=%s", source, exc)
                warnings.append(f"{SOURCE_LABELS[source]}详情解析失败：{exc}")

    logger.info(
        "青藤 CVE 索引完成 device=%s(%s) hosts=%d sources=%s warnings=%d",
        device.name, device.id, len(hosts), source_counts, len(warnings),
    )
    return {
        "built_at": beijing_now().strftime("%Y-%m-%d %H:%M:%S"),
        "expires_at": time.time() + CACHE_TTL,
        "hosts": hosts,
        "meta": meta,
        "hits_by_cve": dict(hits_by_cve),
        "source_counts": source_counts,
        "warnings": warnings,
    }


def _merge_source(
    source: str,
    rows: Iterable[dict],
    detail_prefix: str,
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    hosts: list[dict],
    host_index: dict[str, int],
    meta: dict[tuple[str, str], dict],
    hits_by_cve: dict[str, list[tuple[str, str, int]]],
    warnings: list[str] | None = None,
) -> int:
    """把一类风险的 list 记录与详情合并进索引。"""
    records: list[tuple[str, str, dict]] = []  # (vul_id, record_id, host_ctx)
    first_record: dict[str, str] = {}
    for row in rows:
        vul_id = str(row.get("vulId") or row.get("patchId") or "").strip()
        record_id = str(row.get("id") or "").strip()
        if not vul_id or not record_id:
            continue
        first_record.setdefault(vul_id, record_id)
        records.append((vul_id, record_id, _host_ctx(row)))
        if len(first_record) >= MAX_DETAIL_ITEMS:
            break

    details = _fetch_details(
        client, base_url, comid, jwt, signkey, detail_prefix, first_record,
    )
    missing = len(first_record) - len(details)
    if warnings is not None and missing > 0:
        warnings.append(f"{SOURCE_LABELS[source]}有 {missing} 个检测项详情拉取失败，相关主机可能漏报")

    is_patch = source.endswith("_patch")
    mapped = 0
    for vul_id, _record_id, host in records:
        detail = details.get(vul_id)
        if not detail:
            continue
        cves = extract_cves(detail.get("ref") if is_patch else detail.get("cves"))
        if not cves:
            continue
        mapped += 1
        meta_key = (source, vul_id)
        if meta_key not in meta:
            meta[meta_key] = _patch_meta(detail, vul_id) if is_patch else _poc_meta(detail, vul_id)
        host_key = host.get("agent_id") or host.get("host_ip") or ""
        if not host_key:
            continue
        idx = host_index.get(host_key)
        if idx is None:
            idx = len(hosts)
            host_index[host_key] = idx
            hosts.append(host)
        for cve in cves:
            hits_by_cve[cve].append((source, vul_id, idx))
    if warnings is not None and records and mapped == 0:
        warnings.append(f"{SOURCE_LABELS[source]}未解析到 CVE 字段，已跳过（该接口可能不返回 cves/ref）")
    return len(first_record)


def _fetch_all_rows(
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    path: str,
) -> list[dict]:
    """分页拉取列表；接口忽略分页时通过重复记录检测提前退出。"""
    rows: list[dict] = []
    seen: set[str] = set()
    page = 0
    while page < MAX_PAGES and len(rows) < MAX_LIST_ROWS:
        params = {"page": page, "size": PAGE_SIZE}
        headers, _, final_url = _qingteng_signheaders(
            comid, jwt, signkey, "GET", params, None, f"{base_url}{path}",
        )
        resp = client.get(final_url, headers=headers)
        data = _parse(resp, path)
        page_rows = data.get("rows") or []
        if not page_rows:
            break
        added = 0
        for row in page_rows:
            rid = _row_key(row)
            if rid in seen:
                continue
            seen.add(rid)
            rows.append(row)
            added += 1
        total = int(data.get("total") or 0)
        if added == 0 or len(page_rows) < PAGE_SIZE or (total and len(rows) >= total):
            break
        page += 1
    if len(rows) >= MAX_LIST_ROWS:
        logger.warning("青藤风险列表达到记录上限 %d，可能截断 path=%s", MAX_LIST_ROWS, path)
    return rows


def _fetch_details(
    client: httpx.Client,
    base_url: str,
    comid: str,
    jwt: str,
    signkey: str,
    detail_prefix: str,
    id_map: dict[str, str],
) -> dict[str, dict]:
    """按唯一 vulId/patchId 并发拉取详情，返回 {vul_id: detail}。"""
    if not id_map:
        return {}

    def one(item: tuple[str, str]) -> tuple[str, dict | None]:
        vul_id, record_id = item
        try:
            headers, _, final_url = _qingteng_signheaders(
                comid, jwt, signkey, "GET", {}, None,
                f"{base_url}{detail_prefix}{record_id}",
            )
            resp = client.get(final_url, headers=headers)
            return vul_id, _parse(resp, f"{detail_prefix}{record_id}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("青藤风险详情拉取失败 vul=%s record=%s err=%s", vul_id, record_id, exc)
            return vul_id, None

    result: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=DETAIL_WORKERS) as pool:
        for vul_id, detail in pool.map(one, list(id_map.items())):
            if detail:
                result[vul_id] = detail
    return result


def _row_key(row: dict) -> str:
    """列表记录去重键；缺少 id 时退化为漏洞/补丁 + 主机组合。"""
    record_id = str(row.get("id") or "")
    if record_id:
        return record_id
    return "|".join(
        str(row.get(k) or "")
        for k in ("vulId", "patchId", "agentId", "displayIp", "internalIp")
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


def _host_ctx(row: dict) -> dict[str, Any]:
    return {
        "agent_id": str(row.get("agentId") or ""),
        "host_ip": str(row.get("displayIp") or row.get("internalIp") or ""),
        "display_ip": str(row.get("displayIp") or ""),
        "internal_ip": str(row.get("internalIp") or ""),
        "external_ip": str(row.get("externalIp") or ""),
        "host_name": str(row.get("hostname") or ""),
        "biz_group_id": row.get("bizGroupId") or row.get("group"),
        "biz_group": str(row.get("bizGroup") or ""),
        "remark": str(row.get("remark") or ""),
        "tags": row.get("hostTagList") or row.get("hostTags") or [],
        "white_rule_effect": bool(row.get("whiteRuleEffect")),
        "updated_time": str(row.get("updatedTime") or ""),
    }


def _poc_meta(detail: dict, vul_id: str) -> dict[str, Any]:
    severity = detail.get("severity")
    return {
        "vul_name": str(detail.get("vulName") or vul_id),
        "severity_code": _to_int(severity),
        "severity": _POC_SEVERITY.get(_to_int(severity), ""),
        "check_type": "漏洞检测",
        "apps": detail.get("apps") or [],
        "app_version": str(detail.get("appVersion") or ""),
        "check_info": str(detail.get("checkInfo") or ""),
        "poc_check_info": str(detail.get("pocCheckInfo") or ""),
        "poc_check_results": detail.get("pocCheckResults") or [],
        "remed_description": str(detail.get("remedDescription") or ""),
        "restart_opts": _to_int(detail.get("restartOpts")),
        "has_exp": bool(detail.get("hasExp")),
        "has_poc": bool(detail.get("hasPoc")),
        "kernel": bool(detail.get("kernel")),
        "remote": bool(detail.get("remote")),
        "local_escalation": bool(detail.get("localEscalation")),
        "cvss_score": detail.get("cvssScore"),
        "cvss": str(detail.get("cvss") or ""),
        "refs": str(detail.get("refs") or ""),
        "exp_refs": str(detail.get("expRefs") or ""),
        "public_date": str(detail.get("publicDate") or ""),
        "first_check_time": str(detail.get("firstCheckTime") or ""),
    }


def _patch_meta(detail: dict, vul_id: str) -> dict[str, Any]:
    severity = detail.get("severity")
    check = detail.get("check") if isinstance(detail.get("check"), dict) else {}
    return {
        "vul_name": str(detail.get("patchName") or vul_id),
        "severity_code": _to_int(severity),
        "severity": _PATCH_SEVERITY.get(_to_int(severity), ""),
        "check_type": "补丁检测",
        "apps": detail.get("apps") or [],
        "kb_num": str(detail.get("kbNum") or ""),
        "bullet_id": str(detail.get("bulletId") or ""),
        "install_package": str(detail.get("installPackage") or ""),
        "restart_opts": _to_int(detail.get("restartOpts")),
        "remed_desc": str(detail.get("remedDesc") or ""),
        "remed_cmd": str(detail.get("remedCmd") or ""),
        "publish_time": str(detail.get("publishTime") or ""),
        "has_exp": bool(detail.get("hasExp")),
        "has_poc": bool(detail.get("hasPoc")),
        "kernel": bool(detail.get("isKernel")),
        "remote": bool(detail.get("isRemote")),
        "local_escalation": bool(detail.get("isLocalEscalation")),
        "cvss_score": detail.get("cvssScore"),
        "cvss": str(detail.get("cvssDetail") or ""),
        "check_details": check.get("details") or [],
        "business_impact": _to_int(detail.get("businessImpact")),
        "first_check_time": str(detail.get("firstCheckTime") or ""),
    }


def _to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
