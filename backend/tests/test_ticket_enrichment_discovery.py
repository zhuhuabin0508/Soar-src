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


def test_match_discovery_asset_error_returns_none(monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr("app.agent.discovery_search._search_token", _boom)
    assert te._match_discovery_asset(_FakeDB(), "100.66.1.25") is None


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
    data = te.build_ticket_enrichment(_FakeDB(), field_defs, {"src_ip": "100.66.1.25"}, "测试工单")
    entry = data["sources"][0]
    asset = entry["asset"]
    assert asset["source"] == "asset_discovery"
    assert asset["discovery"] is not None and asset["inventory"] is not None
    assert entry["threat"] == {"is_malicious": False}


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
    assert te._extract_ip("10.99.0.1, 192.168.1.1") == "10.99.0.1"
    assert te._extract_ip("无效; 8.8.8.8") == "8.8.8.8"
    assert te._extract_ip("无 IP") is None
