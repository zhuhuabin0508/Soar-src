"""安博通阻断器黑名单查询智能体工具。

供智能体批量判断目标「是否已被封禁」，支持单 IP / 域名 / CIDR 网段 /
IP 范围（含末段简写）/ 末段通配，多目标一次传入。

查询口径（与设备黑名单语义一致）：
- 单 IP / 域名：未拉取全量列表时走设备「查询指定黑名单」精确查询（毫秒级，可并发）；
- 网段 / 范围 / 通配：设备单条查询无法表达区间，改为全量拉取黑名单列表后
  在本地做区间匹配——命中包括「条目 IP 落在查询区间内」与「条目本身是
  与查询区间重叠的网段/范围」两种；
- 一次调用只拉取一次全量列表：同批的区间目标与单 IP/域名目标都复用它，
  避免重复下发设备请求；
- 查询失败与「未封禁」严格区分：失败条目返回 error，不计入未封禁。

返回结构见 :func:`query_anbotong_blacklist`。
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

from app.core.ip_validation import parse_ip_token, split_ip_expression, validate_domain_token
from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.devices.anbotong import (
    QUERY_TIMEOUT_CAP_SECONDS,
    fetch_all_blacklist_entries,
    find_anbotong_action,
    find_anbotong_device,
    query_blacklist_entry,
)

logger = logging.getLogger(__name__)

# 单次批量查询的目标数上限（与手动封禁 20 个目标的上限留出余量）
MAX_QUERY_TARGETS = 100
# 单个目标返回的命中条目上限：网段/范围可能命中大量条目，只返回样本，
# 其余用 matched_count / truncated 提示
MAX_QUERY_ENTRIES = 20
# PostgreSQL BIGINT 上限：设备永久条目的 leftTime 为 uint64 最大值，归一为 -1
_BIGINT_MAX = 9223372036854775807


def _to_int(value: Any) -> Optional[int]:
    """尽量把设备返回值转成整数（兼容字符串数字）。"""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        try:
            return int(float(str(value).strip()))
        except (TypeError, ValueError):
            return None


def _entry_view(entry: dict[str, Any]) -> dict[str, Any]:
    """设备黑名单条目 → 返回视图：永久条目 leftTime 归一为 -1。"""
    out = dict(entry)
    left = _to_int(out.get("leftTime"))
    age = _to_int(out.get("age"))
    permanent = (age is not None and age < 0) or (left is not None and left > _BIGINT_MAX)
    if permanent:
        out["leftTime"] = -1
    out["permanent"] = permanent
    return out


def _parse_query(token: str) -> dict[str, Any]:
    """解析单个查询目标。

    Returns:
        合法目标：``{target, type, version, start, end}``（域名无 version/start/end）；
        非法目标：``{target, error}``。
    """
    text = str(token or "").strip()
    try:
        iv = parse_ip_token(text, allow_cidr=True, allow_range=True, allow_wildcard=True)
        return {
            "target": iv.text,
            "type": iv.kind,  # single / cidr / range / wildcard
            "version": iv.version,
            "start": iv.start,
            "end": iv.end,
        }
    except ValueError as ip_exc:
        try:
            domain = validate_domain_token(text)
        except ValueError:
            return {"target": text, "error": f"目标格式不合法：{ip_exc}"}
        return {"target": domain, "type": "domain"}


def _entry_interval(text: Any) -> Optional[tuple[int, int, int]]:
    """把设备黑名单条目解析为 ``(version, start, end)``；域名/非法格式返回 None。

    设备条目可能来自平台下发（单 IP / CIDR / 范围）或控制台手工添加，
    这里按同样的三种形态宽松解析，不套用录入侧的严格校验（如 /8 下限）。
    """
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        ip = ipaddress.ip_address(raw)
        return ip.version, int(ip), int(ip)
    except ValueError:
        pass
    if "/" in raw:
        try:
            net = ipaddress.ip_network(raw, strict=False)
        except ValueError:
            return None
        return net.version, int(net.network_address), int(net.broadcast_address)
    if raw.count("-") == 1:
        left, right = (p.strip() for p in raw.split("-", 1))
        try:
            start = ipaddress.ip_address(left)
        except ValueError:
            return None
        try:
            end = ipaddress.ip_address(right)
        except ValueError:
            # 末段简写：192.0.2.1-100
            if start.version == 4 and right.isdigit() and int(right) <= 255:
                try:
                    end = ipaddress.ip_address(f"{left.rsplit('.', 1)[0]}.{int(right)}")
                except ValueError:
                    return None
            else:
                return None
        if start.version != end.version or int(end) < int(start):
            return None
        return start.version, int(start), int(end)
    return None


def _coverage(intervals: list[tuple[int, int]], start: int, end: int) -> str:
    """计算查询区间被命中条目区间的覆盖程度：full / partial。"""
    cur = start
    for seg_start, seg_end in sorted(intervals):
        if seg_start > cur:
            break
        cur = max(cur, seg_end + 1)
        if cur > end:
            return "full"
    return "partial"


def _match_from_entries(query: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, Any]:
    """在已拉取的黑名单条目中匹配单个目标。"""
    matched: list[dict[str, Any]] = []
    intervals: list[tuple[int, int]] = []
    for entry in entries:
        blist = str(entry.get("blist") or "").strip()
        if not blist:
            continue
        if query["type"] == "domain":
            if blist.rstrip(".").lower() == query["target"]:
                matched.append(entry)
            continue
        iv = _entry_interval(blist)
        if iv is None or iv[0] != query["version"]:
            continue
        if iv[1] <= query["end"] and iv[2] >= query["start"]:
            matched.append(entry)
            intervals.append((iv[1], iv[2]))

    matched_count = len(matched)
    if not matched_count:
        return {
            "target": query["target"],
            "query_type": query["type"],
            "banned": False,
            "match_type": None,
            "coverage": None,
            "matched_count": 0,
            "truncated": False,
            "entries": [],
            "error": None,
        }

    if query["type"] == "domain":
        exact = True  # 域名只有精确命中才会进入 matched
        coverage = None
    elif query["type"] == "single":
        exact = any(s == e for s, e in intervals)
        coverage = None
    else:
        exact = any(s == query["start"] and e == query["end"] for s, e in intervals)
        coverage = _coverage(intervals, query["start"], query["end"])
    return {
        "target": query["target"],
        "query_type": query["type"],
        "banned": True,
        "match_type": "exact" if exact else ("covered" if query["type"] == "single" else "overlap"),
        "coverage": coverage,
        "matched_count": matched_count,
        "truncated": matched_count > MAX_QUERY_ENTRIES,
        "entries": [_entry_view(e) for e in matched[:MAX_QUERY_ENTRIES]],
        "error": None,
    }


def _query_exact(db, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """单 IP / 域名走设备精确查询（并发，最多 8 路）。"""
    device, action, err = find_anbotong_action(db, "query")
    if err:
        return [
            {
                "target": q["target"],
                "query_type": q["type"],
                "banned": None,
                "match_type": None,
                "coverage": None,
                "matched_count": 0,
                "truncated": False,
                "entries": [],
                "error": err,
            }
            for q in queries
        ]
    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    out: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(len(queries), 8)) as pool:
        futures = [
            (q, pool.submit(query_blacklist_entry, device, action, q["target"], timeout=timeout))
            for q in queries
        ]
        for query, future in futures:
            target = query["target"]
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001
                logger.warning("安博通黑名单精确查询异常 target=%s: %s", target, exc)
                out.append({
                    "target": target,
                    "query_type": query["type"],
                    "banned": None,
                    "match_type": None,
                    "coverage": None,
                    "matched_count": 0,
                    "truncated": False,
                    "entries": [],
                    "error": f"查询异常: {exc}",
                })
                continue
            if not result.get("success"):
                out.append({
                    "target": target,
                    "query_type": query["type"],
                    "banned": None,
                    "match_type": None,
                    "coverage": None,
                    "matched_count": 0,
                    "truncated": False,
                    "entries": [],
                    "error": result.get("error") or "设备查询失败",
                })
                continue
            entry = result.get("entry")
            found = bool(result.get("found")) and isinstance(entry, dict) and bool(entry)
            out.append({
                "target": target,
                "query_type": query["type"],
                "banned": found,
                "match_type": "exact" if found else None,
                "coverage": None,
                "matched_count": 1 if found else 0,
                "truncated": False,
                "entries": [_entry_view(entry)] if found else [],
                "error": None,
            })
    return out


def _query_sync(targets: str) -> dict[str, Any]:
    """同步查询实现（由 :func:`query_anbotong_blacklist` 调度到线程池）。"""
    tokens = split_ip_expression(targets)
    if not tokens:
        return {"success": False, "error": "请提供要查询的目标（IP / CIDR / 范围 / 域名）"}
    if len(tokens) > MAX_QUERY_TARGETS:
        return {
            "success": False,
            "error": f"单次最多查询 {MAX_QUERY_TARGETS} 个目标（当前 {len(tokens)} 个），请拆分后重试",
        }

    parsed = [_parse_query(t) for t in tokens]
    db = SessionLocal()
    try:
        device, device_err = find_anbotong_device(db)
        if device_err:
            return {"success": False, "error": device_err, "items": []}

        # 区间类目标（网段 / 范围 / 通配）需要全量列表；只要有一个就拉一次
        range_queries = [
            q for q in parsed
            if not q.get("error") and q["type"] not in ("single", "domain")
        ]
        exact_queries = [
            q for q in parsed
            if not q.get("error") and q["type"] in ("single", "domain")
        ]
        notes: list[str] = []
        list_result: Optional[dict[str, Any]] = None
        scanned_entries = 0
        scan_truncated = False
        if range_queries:
            list_result = fetch_all_blacklist_entries(db, source="agent")
            if list_result.get("success"):
                scanned_entries = len(list_result.get("entries") or [])
                scan_truncated = bool(list_result.get("truncated"))
                if scan_truncated:
                    notes.append("黑名单条目超过单次扫描上限，网段/范围结果可能不完整")
            else:
                notes.append(
                    f"黑名单列表拉取失败（{list_result.get('error') or '未知原因'}），"
                    "网段/范围查询不可用"
                )

        matched_map: dict[int, dict[str, Any]] = {}
        if list_result is not None and list_result.get("success"):
            entries = list_result.get("entries") or []
            for idx, q in enumerate(parsed):
                if q.get("error"):
                    continue
                matched_map[idx] = _match_from_entries(q, entries)
        elif exact_queries:
            # 无全量列表（纯单 IP/域名查询，或列表拉取失败）：走设备精确查询
            exact_results = _query_exact(db, exact_queries)
            by_target = {r["target"]: r for r in exact_results}
            for idx, q in enumerate(parsed):
                if q.get("error"):
                    continue
                result = by_target.get(q["target"])
                if result is not None:
                    matched_map[idx] = result

        items: list[dict[str, Any]] = []
        for idx, q in enumerate(parsed):
            if q.get("error"):
                items.append({
                    "target": q["target"],
                    "query_type": None,
                    "banned": None,
                    "matched_count": 0,
                    "entries": [],
                    "error": q["error"],
                })
                continue
            result = matched_map.get(idx)
            if result is None:
                # 区间目标遇列表拉取失败：明确报错，不能当作未封禁
                items.append({
                    "target": q["target"],
                    "query_type": q["type"],
                    "banned": None,
                    "matched_count": 0,
                    "entries": [],
                    "error": "黑名单列表不可用，无法完成该目标查询",
                })
                continue
            items.append(result)

        banned_count = sum(1 for item in items if item.get("banned") is True)
        clean_count = sum(1 for item in items if item.get("banned") is False)
        error_count = sum(1 for item in items if item.get("banned") is None)
        state = {
            "success": True,
            "source": "anbotong_blacklist",
            "device": {"id": device.id, "name": device.name},
            "total": len(items),
            "banned_count": banned_count,
            "clean_count": clean_count,
            "error_count": error_count,
            "scanned_entries": scanned_entries,
            "scan_truncated": scan_truncated,
            "items": items,
            "note": "；".join(notes) if notes else None,
            "fetched_at": beijing_now().isoformat(),
        }
        return state
    finally:
        db.close()


async def query_anbotong_blacklist(targets: str) -> dict[str, Any]:
    """批量查询目标是否在安博通阻断器黑名单中（智能体工具入口）。

    Args:
        targets: 查询目标表达式，逗号/分号/空白分隔；每项支持单 IP、域名、
            CIDR 网段、IP 范围（含末段简写）与末段通配。

    Returns:
        ``{success, source, device, total, banned_count, clean_count,
        error_count, scanned_entries, scan_truncated, items, note, fetched_at}``；
        ``items`` 每项含 ``target / query_type / banned / match_type /
        coverage / matched_count / truncated / entries / error``。
    """
    return await asyncio.to_thread(_query_sync, targets)
