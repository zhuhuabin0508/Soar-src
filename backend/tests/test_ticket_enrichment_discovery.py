"""工单安全上下文资产匹配双来源（资产发现优先 + 资产清单）单元测试。

``_match_asset`` 同时查询资产发现与资产清单：``discovery`` / ``inventory``
键各携完整命中结果；``source`` 为主命中来源（发现命中
``asset_discovery`` 优先，否则清单命中 ``asset_inventory``）。
"""
import time
import types

import app.core.ticket_enrichment as te


class _FakeQuery:
    def __init__(self, record):
        self._record = record

    def filter(self, *args):  # noqa: ARG002
        return self

    def first(self):
        return self._record


class _FakeDB:
    def query(self, model):  # noqa: ARG002
        # 资产清单命中后的记录回查：返回带空 tags 的 fake 记录
        return _FakeQuery(types.SimpleNamespace(tags=[]))

    def commit(self):  # requery 后台路径需要
        pass


def _discovery_payload(count=1):
    return {
        "resource_type": "cloud_host",
        "resource_label": "云主机资产",
        "asset_name": "web-00",
        "asset_ip": "100.66.1.25",
        "matches": [
            {
                "source": "asset_discovery",
                "resource_type": "cloud_host",
                "resource_label": "云主机资产",
                "source_id": f"src-{i}",
                "instance_name": f"web-{i:02d}",
                "ip_address": "100.66.1.25",
                "user_department": "测试部门",
            }
            for i in range(count)
        ],
        "truncated": False,
    }


def _inventory_payload():
    return {
        "asset_id": 4665,
        "asset_name": "坪山新区内部网",
        "asset_ip": "10.144.1.2",
        "fields": {"ip": "10.144.1.2", "department": "坪山"},
    }


def test_match_discovery_asset_hit(monkeypatch):
    monkeypatch.setattr(
        "app.agent.discovery_search._search_token",
        lambda db, token, rts, limit: {
            "query": token,
            "matched": True,
            "count": 2,
            "truncated": False,
            "assets": _discovery_payload(2)["matches"],
        },
    )
    result = te._match_discovery_asset(_FakeDB(), "100.66.1.25")
    assert result is not None
    assert result["resource_type"] == "cloud_host"
    assert result["resource_label"] == "云主机资产"
    assert result["asset_name"] == "web-00"
    assert result["asset_ip"] == "100.66.1.25"
    assert len(result["matches"]) == 2
    assert result["truncated"] is False
    assert "matched" not in result  # 内层结构无 matched 键（由外层组装）


def test_match_discovery_asset_name_fallback_chain(monkeypatch):
    assets = [
        {"resource_type": "elastic_ip", "resource_label": "弹性IP",
         "cmdb_id": "6899c2", "ip_address": "1.2.3.4"}
    ]
    monkeypatch.setattr(
        "app.agent.discovery_search._search_token",
        lambda db, token, rts, limit: {"assets": assets, "truncated": True},
    )
    result = te._match_discovery_asset(_FakeDB(), "1.2.3.4")
    # instance_name/inst_name/name 均缺失 → 回退 cmdb_id
    assert result["asset_name"] == "6899c2"
    assert result["truncated"] is True


def test_match_discovery_asset_miss_returns_none(monkeypatch):
    monkeypatch.setattr(
        "app.agent.discovery_search._search_token",
        lambda db, token, rts, limit: {"assets": [], "truncated": False},
    )
    assert te._match_discovery_asset(_FakeDB(), "100.66.1.25") is None


def test_match_discovery_asset_error_returns_error_info(monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr("app.agent.discovery_search._search_token", _boom)
    result = te._match_discovery_asset(_FakeDB(), "100.66.1.25")
    assert result is not None
    assert result["matches"] == []
    assert "db down" in result["error"]


def _patch_sources(monkeypatch, inventory_hit=None, discovery_payload=None):
    """跳过富化索引重建并固定两个来源的查询结果。"""
    monkeypatch.setattr(te, "_asset_index_cache", {"built_at": time.time(), "single": {}, "nets": []})
    monkeypatch.setattr(te, "_build_asset_index", lambda db: None)
    monkeypatch.setattr(
        te, "_match_asset_ip",
        (lambda ip, index: inventory_hit) if inventory_hit else (lambda ip, index: None),
    )
    monkeypatch.setattr(
        te, "_match_discovery_asset",
        (lambda db, ip: discovery_payload) if discovery_payload is not None else (lambda db, ip: None),
    )
    if inventory_hit:
        # 清单命中的记录回查字段（to_dict 为调用时局部导入，patch 模块属性即可）
        monkeypatch.setattr(
            "app.schemas.common.to_dict",
            lambda record: {"ip": "10.144.1.2", "department": "坪山"},
        )


def test_match_asset_both_sources_hit_discovery_priority(monkeypatch):
    _patch_sources(monkeypatch, inventory_hit=(4665, "坪山新区内部网"), discovery_payload=_discovery_payload())
    result = te._match_asset(_FakeDB(), "100.66.1.25")
    assert result["matched"] is True
    # 资产发现优先：source/asset_name 取发现结果
    assert result["source"] == "asset_discovery"
    assert result["asset_name"] == "web-00"
    assert result["resource_type"] == "cloud_host"
    # 两来源完整结果并列携带
    assert result["discovery"]["resource_label"] == "云主机资产"
    assert result["inventory"]["asset_id"] == 4665
    assert result["inventory"]["fields"]["department"] == "坪山"


def test_match_asset_inventory_only(monkeypatch):
    _patch_sources(monkeypatch, inventory_hit=(4665, "坪山新区内部网"), discovery_payload=None)
    result = te._match_asset(_FakeDB(), "10.144.1.2")
    assert result["matched"] is True
    assert result["source"] == "asset_inventory"
    assert result["asset_name"] == "坪山新区内部网"
    assert result["asset_id"] == 4665
    assert result["discovery"] is None
    assert result["inventory"]["fields"]["ip"] == "10.144.1.2"


def test_match_asset_discovery_only(monkeypatch):
    _patch_sources(monkeypatch, inventory_hit=None, discovery_payload=_discovery_payload())
    result = te._match_asset(_FakeDB(), "100.66.1.25")
    assert result["matched"] is True
    assert result["source"] == "asset_discovery"
    assert result["inventory"] is None
    assert result["discovery"]["matches"][0]["instance_name"] == "web-00"


def test_match_asset_both_miss(monkeypatch):
    _patch_sources(monkeypatch, inventory_hit=None, discovery_payload=None)
    assert te._match_asset(_FakeDB(), "8.8.8.8") == {"matched": False}


def test_build_ticket_enrichment_dual_source(monkeypatch):
    _patch_sources(monkeypatch, inventory_hit=(4665, "坪山新区内部网"), discovery_payload=_discovery_payload())
    monkeypatch.setattr(
        te, "_query_threat_intel_batch", lambda ips: [{"is_malicious": False}] * len(ips)
    )
    field_defs = [{"key": "src_ip", "label": "源IP地址"}]
    data, bg_plan, agent_ips = te.build_ticket_enrichment(
        _FakeDB(), field_defs, {"src_ip": "100.66.1.25"}, "测试工单"
    )
    assert bg_plan is None and agent_ips == []
    assert data["version"] == 2
    entry = data["ips"][0]
    assert entry["roles"] == ["src_ip"]
    assert entry["detail"] == "full"
    asset = entry["asset"]
    assert asset["source"] == "asset_discovery"
    assert asset["discovery"] is not None and asset["inventory"] is not None
    assert entry["threat"] == {"is_malicious": False}
    assert data["role_labels"]["src_ip"] == "源IP地址"
    assert data["stats"]["total"] == 1
    assert data["stats"]["asset_matched"] == 1


# ============================================================================
# 详细数据来源标签（「资产发现-裸金属资产」/「资产清单-A会保持在线系统清单」）
# ============================================================================

def test_discovery_source_label_uses_resource_label(monkeypatch):
    """资产发现来源标签取资源类型中文名：资产发现-裸金属资产。"""
    payload = {
        "resource_type": "bare_metal",
        "resource_label": "裸金属资产",
        "instance_name": "bm-01",
        "ip_address": "10.0.0.9",
    }
    monkeypatch.setattr(
        "app.agent.discovery_search._search_token",
        lambda db, token, rts, limit: {"assets": [dict(payload)], "truncated": False},
    )
    result = te._match_discovery_asset(_FakeDB(), "10.0.0.9")
    assert result["source_label"] == "资产发现-裸金属资产"
    assert result["matches"][0]["source_label"] == "资产发现-裸金属资产"


def test_discovery_source_label_without_resource_label():
    """资源类型名为空时退化为「资产发现」，不编造明细。"""
    assert te._discovery_source_label({}) == "资产发现"
    assert te._discovery_source_label({"resource_label": "  "}) == "资产发现"


def test_inventory_source_label_prefers_kb_name():
    """资产清单来源标签优先知识库名：资产清单-A会保持在线系统清单。"""
    label = te._inventory_source_label(
        {"kb_name": "A会保持在线系统清单", "type_code": "meeting_online_system"},
        {"meeting_online_system": "A会保持在线系统清单"},
    )
    assert label == "资产清单-A会保持在线系统清单"


def test_inventory_source_label_falls_back_to_template_name():
    """无知识库名时用资产类型模板名（kb_name 存量普遍为空）。"""
    label = te._inventory_source_label(
        {"kb_name": "", "type_code": "meeting_online_system"},
        {"meeting_online_system": "A会保持在线系统清单"},
    )
    assert label == "资产清单-A会保持在线系统清单"
    assert te._inventory_source_label({"type_code": "unknown"}, {}) == "资产清单"


def test_decorate_asset_source_labels_backfills_and_is_idempotent(monkeypatch):
    """存量 enrichment 无 source_label 时按当前模板名补齐，且不修改原数据。"""
    monkeypatch.setattr(
        te, "_template_name_map", lambda db: {"meeting_online_system": "A会保持在线系统清单"}
    )
    stored = {
        "sources": [
            {
                "role": "src_ip",
                "ip": "10.144.1.2",
                "asset": {
                    "matched": True,
                    "source": "asset_inventory",
                    "asset_name": "新版客服流程管理系统",
                    "asset_ip": "10.144.1.2",
                    "discovery": None,
                    "inventory": {
                        "asset_id": 109080,
                        "asset_name": "新版客服流程管理系统",
                        "fields": {"kb_name": "", "type_code": "meeting_online_system"},
                    },
                },
            },
            {
                "role": "dst_ip",
                "ip": "10.0.0.9",
                "asset": {
                    "matched": True,
                    "source": "asset_discovery",
                    "asset_name": "bm-01",
                    "discovery": {
                        "resource_type": "bare_metal",
                        "resource_label": "裸金属资产",
                        "matches": [{"resource_type": "bare_metal", "resource_label": "裸金属资产"}],
                    },
                    "inventory": None,
                },
            },
        ]
    }
    out = te.decorate_asset_source_labels(_FakeDB(), stored)
    assert out["sources"][0]["asset"]["source_label"] == "资产清单-A会保持在线系统清单"
    assert out["sources"][0]["asset"]["inventory"]["source_label"] == "资产清单-A会保持在线系统清单"
    assert out["sources"][1]["asset"]["source_label"] == "资产发现-裸金属资产"
    assert out["sources"][1]["asset"]["discovery"]["matches"][0]["source_label"] == "资产发现-裸金属资产"
    # 深拷贝：原数据不被就地修改
    assert "source_label" not in stored["sources"][0]["asset"]

    again = te.decorate_asset_source_labels(_FakeDB(), out)
    assert again["sources"][0]["asset"]["source_label"] == "资产清单-A会保持在线系统清单"


def test_decorate_asset_source_labels_handles_legacy_flat_structure(monkeypatch):
    """旧结构工单（字段直接挂在 asset 上）：按 source 判定来源并补标签。"""
    monkeypatch.setattr(
        te, "_template_name_map", lambda db: {"host_asset": "主机资产"}
    )
    stored = {
        "sources": [
            {"ip": "1.1.1.1", "asset": {
                "matched": True, "source": "asset_inventory", "asset_name": "srv",
                "fields": {"type_code": "host_asset", "kb_name": ""},
            }},
            {"ip": "2.2.2.2", "asset": {
                "matched": True, "source": "asset_discovery", "asset_name": "bm",
            }},
        ]
    }
    out = te.decorate_asset_source_labels(_FakeDB(), stored)
    assert out["sources"][0]["asset"]["source_label"] == "资产清单-主机资产"
    assert out["sources"][1]["asset"]["source_label"] == "资产发现"


def test_decorate_asset_source_labels_passthrough():
    """非字典 / 无 sources 的 enrichment 原样返回。"""
    assert te.decorate_asset_source_labels(_FakeDB(), None) is None
    assert te.decorate_asset_source_labels(_FakeDB(), {}) == {}
    assert te.decorate_asset_source_labels(_FakeDB(), {"sources": None}) == {"sources": None}


def test_extract_ip_takes_first_valid():
    # v2：多值全量解析（v1 仅取第一个有效地址）
    ips, skipped = te._extract_ips("10.99.0.1, 192.168.1.1")
    assert ips == ["10.99.0.1", "192.168.1.1"] and skipped == []
    ips, skipped = te._extract_ips("无效; 8.8.8.8")
    assert ips == ["8.8.8.8"] and skipped == ["无效"]
    # 分隔符/字段内去重/网段条目
    ips, skipped = te._extract_ips("1.1.1.1;1.1.1.1, 10.0.0.0/8, 文本")
    assert ips == ["1.1.1.1"] and skipped == ["10.0.0.0/8", "文本"]
    assert te._extract_ips("无 IP") == ([], ["无 IP"])
    assert te._extract_ips("") == ([], [])
    assert te._extract_ips(None) == ([], [])


# ============================================================================
# v2 多 IP：去重合并 / 统计 / 分级存储 / 后台占位
# ============================================================================

def _field_defs():
    return [
        {"key": "src_ip", "label": "源IP地址"},
        {"key": "dst_ip", "label": "目的IP地址"},
    ]


def test_build_multi_ip_dedup_and_stats(monkeypatch):
    """同一 IP 跨角色只查一次，roles 记录全部出现角色，stats 按角色计数。"""
    queried = []
    monkeypatch.setattr(
        te, "_query_assets",
        lambda db, ips: queried.extend(ips) or {
            ip: ({"matched": False}, None) for ip in ips
        },
    )
    monkeypatch.setattr(
        te, "_query_threat_intel_batch",
        lambda ips: [
            {"is_malicious": ip.endswith(".1"), "severity": "high" if ip.endswith(".1") else "low"}
            for ip in ips
        ],
    )
    data, bg_plan, agent_ips = te.build_ticket_enrichment(
        _FakeDB(), _field_defs(),
        {"src_ip": "1.1.1.1, 2.2.2.2", "dst_ip": "2.2.2.2, 3.3.3.3"},
        "多IP工单",
    )
    assert bg_plan is None
    assert [e["ip"] for e in data["ips"]] == ["1.1.1.1", "2.2.2.2", "3.3.3.3"]
    assert queried.count("2.2.2.2") == 1  # 跨角色去重只查一次
    assert data["ips"][1]["roles"] == ["src_ip", "dst_ip"]
    assert data["stats"]["total"] == 3
    assert data["stats"]["src"] == 2 and data["stats"]["dst"] == 2
    assert data["stats"]["malicious"] == 1
    assert data["stats"]["severity_high"] == 1


def test_build_full_lite_tiering(monkeypatch):
    """前 10 个 full；之后仅风险 IP 保留全字段，其余精简为 lite。"""
    ips = [f"10.0.{i // 256}.{i % 256}" for i in range(12)]
    monkeypatch.setattr(
        te, "_query_assets", lambda db, ips_: {ip: ({"matched": False}, None) for ip in ips_}
    )
    monkeypatch.setattr(
        te, "_query_threat_intel_batch",
        lambda ips_: [{"is_malicious": False, "severity": "low", "confidence": 10, "tags": ["a"], "source": "x"} for _ in ips_],
    )
    data, _, _ = te.build_ticket_enrichment(
        _FakeDB(), [{"key": "src_ip", "label": "源IP地址"}],
        {"src_ip": ", ".join(ips)}, "分级工单",
    )
    assert len(data["ips"]) == 12
    assert [e["detail"] for e in data["ips"]] == ["full"] * 10 + ["lite"] * 2
    lite = data["ips"][10]
    assert set(lite["threat"].keys()) == {
        "ip", "is_malicious", "confidence", "severity", "tags", "geo_info", "source"
    }


def test_build_bg_shell_when_over_sync_limit():
    """IP 数超过同步阈值：返回 pending 占位 + bg_plan，不触发任何查询。"""
    ips = ", ".join(f"10.1.{i // 256}.{i % 256}" for i in range(25))
    data, bg_plan, agent_ips = te.build_ticket_enrichment(
        _FakeDB(), [{"key": "src_ip", "label": "源IP地址"}], {"src_ip": ips}, "后台工单",
    )
    assert bg_plan is not None and agent_ips == []
    assert data["stats"]["pending"] is True
    assert all(e.get("pending") for e in data["ips"])
    assert len(bg_plan["ips"]) == 25
    assert all("threat" not in e and "asset" not in e for e in data["ips"])


class _FakeTicket:
    def __init__(self, enrichment):
        self.id = 1
        self.enrichment_data = enrichment


def test_requery_upgrades_entry_and_stats(monkeypatch):
    """重新研判：重跑资产+情报、升级 full、stats 重算，agent 结果保留。"""
    monkeypatch.setattr(
        te, "_query_assets",
        lambda db, ips: {
            ip: ({"matched": True, "source": "asset_inventory", "asset_name": "srv",
                  "source_label": "资产清单", "inventory": {"asset_id": 1, "fields": {}}}, None)
            for ip in ips
        },
    )
    monkeypatch.setattr(
        te, "_query_threat_intel_batch",
        lambda ips: [{"is_malicious": True, "severity": "high", "confidence": 90} for _ in ips],
    )
    monkeypatch.setattr(te, "flag_modified", lambda obj, key: None)
    ticket = _FakeTicket({
        "version": 2,
        "ips": [{"ip": "1.1.1.1", "roles": ["src_ip"], "detail": "lite",
                 "asset": {"matched": False},
                 "threat": {"is_malicious": False},
                 "agent": {"risk_level": "low"}}],
        "stats": {"total": 1, "malicious": 0, "pending": False},
        "errors": [],
    })
    result = te.requery_ticket_enrichment(_FakeDB(), ticket, ["1.1.1.1"])
    assert result == {"updated": 1, "unknown": [], "pending": False}
    entry = ticket.enrichment_data["ips"][0]
    assert entry["detail"] == "full"
    assert entry["threat"]["is_malicious"] is True
    assert entry["agent"] == {"risk_level": "low"}  # 原智能体结果保留
    assert ticket.enrichment_data["stats"]["malicious"] == 1
    assert ticket.enrichment_data["stats"]["asset_matched"] == 1


def test_requery_over_limit_marks_background(monkeypatch):
    """选中 IP 超过同步阈值：打 requery_pending 标记并转后台。"""
    monkeypatch.setattr(te, "start_requery_bg", lambda tid, ips: None)
    monkeypatch.setattr(te, "flag_modified", lambda obj, key: None)
    entries = [
        {"ip": f"10.9.{i // 256}.{i % 256}", "roles": ["src_ip"], "detail": "lite"}
        for i in range(25)
    ]
    ticket = _FakeTicket({"version": 2, "ips": entries, "stats": {"total": 25}, "errors": []})
    result = te.requery_ticket_enrichment(_FakeDB(), ticket, [e["ip"] for e in entries])
    assert result["pending"] is True
    assert all(e.get("requery_pending") for e in ticket.enrichment_data["ips"])
    assert ticket.enrichment_data["stats"]["pending"] is True


def test_requery_rejects_legacy_structure():
    ticket = _FakeTicket({"sources": [{"ip": "1.1.1.1", "role": "src_ip"}]})
    try:
        te.requery_ticket_enrichment(_FakeDB(), ticket, ["1.1.1.1"])
        raise AssertionError("存量 v1 结构应拒绝重新研判")
    except ValueError as exc:
        assert "存量结构" in str(exc)


def test_decorate_asset_source_labels_v2(monkeypatch):
    """v2（ips 扁平结构）同样按来源补齐 source_label。"""
    monkeypatch.setattr(te, "_template_name_map", lambda db: {"host_asset": "主机资产"})
    stored = {
        "version": 2,
        "ips": [
            {"ip": "10.0.0.9", "roles": ["src_ip"], "asset": {
                "matched": True, "source": "asset_discovery", "asset_name": "bm-01",
                "discovery": {
                    "resource_type": "bare_metal", "resource_label": "裸金属资产",
                    "matches": [{"resource_type": "bare_metal", "resource_label": "裸金属资产"}],
                },
                "inventory": None,
            }},
        ],
    }
    out = te.decorate_asset_source_labels(_FakeDB(), stored)
    assert out["ips"][0]["asset"]["source_label"] == "资产发现-裸金属资产"
    assert out["ips"][0]["asset"]["discovery"]["matches"][0]["source_label"] == "资产发现-裸金属资产"
