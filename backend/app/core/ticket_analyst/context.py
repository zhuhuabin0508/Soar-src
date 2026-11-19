# -*- coding: utf-8 -*-
"""工单研判多维安全上下文采集。

为待研判 IP 批量拉取四个维度（资产/威胁情报取自 ``enrichment_data``
已算好的 entry，不重复查询；黑名单/白名单/地址库由本模块补查）：

- 黑名单：``BannedIP`` 有效封禁记录（active 且未过期）
- 白名单：安博通设备白名单（内存索引，毫秒级）
- IP 地址库：跨库点查（仅 IPv4；复用 ``ip_library._lookup_matches``）
- 资产匹配 / 威胁情报 / 360 情报：工单 enrichment_data 对应 entry

全部为本地库/内存查询，无外部网络调用；200 IP 总耗时 < 2s。
每个维度带 ``degraded`` 降级标记（查询异常时置 True，规则按未命中降级）。
"""

from __future__ import annotations

import ipaddress
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# 黑名单记录序列化字段（规则证据引用）
_BLACKLIST_FIELDS = (
    "ip", "ban_level", "ban_duration", "expired_at", "region",
    "reason", "violation_count", "status", "source", "device_name",
)


def _query_blacklist(db, ips: list[str]) -> dict[str, dict]:
    """黑名单批量查询：单次 ``in_()``，仅保留有效记录（active 且未过期）。

    过期判定与 ``api/v1/banned_ips.py`` 同口径（北京时间比较）。
    无记录的 IP 返回 ``records=[] / degraded=False``：无命中不得误报为采集失败。
    """
    from app.core.timezone import beijing_now
    from app.models.banned_ip import BannedIP

    out: dict[str, dict] = {ip: {"records": [], "degraded": False} for ip in ips}
    if not ips:
        return out
    try:
        rows = db.query(BannedIP).filter(BannedIP.ip.in_(ips)).all()
        now = beijing_now()
        for r in rows:
            if r.status != "active" or r.expired_at is None or r.expired_at < now:
                continue
            rec = {}
            for f in _BLACKLIST_FIELDS:
                val = getattr(r, f, None)
                rec[f] = val.isoformat(sep=" ") if hasattr(val, "isoformat") else val
            out.setdefault(r.ip, {"records": [], "degraded": False})["records"].append(rec)
    except Exception:  # noqa: BLE001
        logger.warning("黑名单批量查询失败（按降级处理）", exc_info=True)
        out = {ip: {"records": [], "degraded": True} for ip in ips}
    return out


def _query_whitelist(db, ips: list[str]) -> dict[str, dict]:
    """白名单批量匹配：安博通内存索引单次调用。"""
    from app.core.anbotong_whitelist import match_targets

    out: dict[str, dict] = {ip: {"hit": False, "match_type": None, "entries": [], "degraded": False} for ip in ips}
    if not ips:
        return out
    try:
        result = match_targets(db, ips)
        for item in result.get("items") or []:
            ip = str(item.get("target") or "")
            if ip not in out:
                continue
            out[ip] = {
                "hit": bool(item.get("matched")),
                "match_type": item.get("match_type"),
                "entries": item.get("entries") or [],
                "degraded": False,
            }
    except Exception:  # noqa: BLE001
        logger.warning("白名单批量匹配失败（按降级处理）", exc_info=True)
        out = {ip: {**v, "degraded": True} for ip, v in out.items()}
    return out


def _query_ip_library(db, ips: list[str]) -> dict[str, dict]:
    """IP 地址库跨库点查：逐 IP GiST 点查（毫秒级；IPv6 不支持按降级处理）。"""
    from app.api.v1.ip_library import _lookup_matches

    out: dict[str, dict] = {}
    for ip in ips:
        try:
            addr = ipaddress.IPv4Address(ip.strip())
        except ValueError:
            out[ip] = {"matches": [], "degraded": True, "reason": "地址库仅支持 IPv4 点查"}
            continue
        try:
            out[ip] = {"matches": _lookup_matches(db, int(addr)), "degraded": False}
        except Exception:  # noqa: BLE001
            logger.warning("地址库点查失败, ip=%s（按降级处理）", ip, exc_info=True)
            out[ip] = {"matches": [], "degraded": True, "reason": "地址库查询异常"}
    return out


def gather_contexts(db, ticket_id: int, ips: list[str], title: str = "") -> dict[str, dict]:
    """批量组装待研判 IP 的多维安全上下文。

    Args:
        db: 只读查询用 Session（由调用方持有；本函数不改库不提交）。
        ticket_id: 工单 ID（读取 enrichment_data 中已算好的资产/情报 entry）。
        ips: 待研判 IP 列表。
        title: 工单标题（研判场景上下文）。

    Returns:
        ``{ip: ctx}``，ctx 结构见模块头注释；条目缺失的维度为 None。
    """
    from app.core.ticket_enrichment import _enrichment_entries
    from app.models.ticket import Ticket

    entries_map: dict[str, dict] = {}
    if ticket_id:
        ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
        if ticket is not None and isinstance(ticket.enrichment_data, dict):
            for e in _enrichment_entries(ticket.enrichment_data):
                if isinstance(e, dict) and e.get("ip"):
                    entries_map[str(e["ip"])] = e

    blacklist_map = _query_blacklist(db, ips)
    whitelist_map = _query_whitelist(db, ips)
    lib_map = _query_ip_library(db, ips)

    contexts: dict[str, dict] = {}
    for ip in ips:
        entry = entries_map.get(ip) or {}
        contexts[ip] = {
            "ip": ip,
            "roles": list(entry.get("roles") or []),
            "title": title,
            "blacklist": blacklist_map.get(ip, {"records": [], "degraded": True}),
            "whitelist": whitelist_map.get(ip, {"hit": False, "match_type": None, "entries": [], "degraded": True}),
            "ip_library": lib_map.get(ip, {"matches": [], "degraded": True}),
            # 资产/威胁情报/360 情报：直接复用 enrichment entry（不重复查询）
            "asset": entry.get("asset"),
            "threat": entry.get("threat"),
            "ti_360": entry.get("ti_360"),
        }
    return contexts
