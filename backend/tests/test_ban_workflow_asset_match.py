"""手动封禁弹窗资产匹配预检（GET /ban-workflow/asset-match）单元测试。

覆盖：
- ``_asset_match_for_ip``：双来源（资产发现 + 资产清单）映射与优先级、
  仅发现命中、仅清单命中、双来源未命中、匹配异常降级（与工单安全
  上下文 ``_match_asset`` 完全同口径，由复用保证，此处验证映射正确性）
- ``query_asset_match`` 端点：多 IP 并行、输入去重、非法 IP / 超上限 /
  空输入拒绝、单 IP 匹配异常不阻塞其余 IP、命中统计
"""
import pytest
from fastapi import HTTPException

import app.api.v1.ban_workflow as bw
import app.core.ticket_enrichment as te


class _FakeDB:
    def query(self, model):  # noqa: ARG002
        raise AssertionError("FakeDB 不应触发真实查询（来源均已被 patch）")


# ---------------------------------------------------------------------------
# _asset_match_for_ip：_match_asset → 前端展示结构映射
# ---------------------------------------------------------------------------

def _matched_payload(source="asset_discovery", discovery=None, inventory=None):
    return {
        "matched": True,
        "source": source,
        "source_label": "资产发现-云主机资产" if source == "asset_discovery" else "资产清单-主机资产",
        "asset_name": "web-00" if source == "asset_discovery" else "srv-01",
        "discovery": discovery,
        "inventory": inventory,
    }


def _discovery_raw():
    return {
        "resource_type": "cloud_host",
        "resource_label": "云主机资产",
        "source_label": "资产发现-云主机资产",
        "asset_name": "web-00",
        "asset_ip": "100.66.1.25",
        "matches": [
            {
                "source_label": "资产发现-云主机资产",
                "resource_type": "cloud_host",
                "resource_label": "云主机资产",
                "instance_name": "web-00",
                "ip_address": "100.66.1.25",
                "user_department": "运维部",
            },
        ],
        "truncated": False,
    }


def _inventory_raw():
    return {
        "asset_id": 4665,
        "asset_name": "坪山新区内部网",
        "asset_ip": "10.144.1.2",
        "source_label": "资产清单-主机资产",
        "fields": {"ip": "10.144.1.2", "department": "坪山", "owner": "张三"},
    }


def test_asset_match_for_ip_both_sources(monkeypatch):
    """双来源同时命中：资产列表 = 发现命中记录 + 清单命中记录，发现优先在前。"""
    monkeypatch.setattr(
        te, "_match_asset",
        lambda db, ip: _matched_payload(discovery=_discovery_raw(), inventory=_inventory_raw()),
    )
    result = bw._asset_match_for_ip(_FakeDB(), "100.66.1.25")
    assert result["matched"] is True
    assert result["source"] == "asset_discovery"
    assert result["source_label"] == "资产发现-云主机资产"
    sources = [a["source"] for a in result["assets"]]
    assert sources[0] == "asset_discovery"
    assert sources[-1] == "asset_inventory"
    discovery_hit = result["assets"][0]
    assert discovery_hit["source_label"] == "资产发现-云主机资产"
    assert discovery_hit["asset_name"] == "web-00"
    assert discovery_hit["details"]["instance_name"] == "web-00"
    inventory_hit = result["assets"][-1]
    assert inventory_hit["source_label"] == "资产清单-主机资产"
    assert inventory_hit["asset_name"] == "坪山新区内部网"
    assert inventory_hit["details"]["ip"] == "10.144.1.2"


def test_asset_match_for_ip_discovery_only(monkeypatch):
    """仅资产发现命中（资产清单无该 IP）：只返回发现来源条目。"""
    monkeypatch.setattr(
        te, "_match_asset",
        lambda db, ip: _matched_payload(discovery=_discovery_raw(), inventory=None),
    )
    result = bw._asset_match_for_ip(_FakeDB(), "100.66.1.25")
    assert result["matched"] is True
    assert all(a["source"] == "asset_discovery" for a in result["assets"])


def test_asset_match_for_ip_inventory_only(monkeypatch):
    """仅资产清单命中（资产发现无该 IP）：只返回清单来源条目，source 为清单。"""
    monkeypatch.setattr(
        te, "_match_asset",
        lambda db, ip: _matched_payload(
            source="asset_inventory",
            discovery=None, inventory=_inventory_raw(),
        ),
    )
    result = bw._asset_match_for_ip(_FakeDB(), "10.144.1.2")
    assert result["matched"] is True
    assert result["source"] == "asset_inventory"
    assert len(result["assets"]) == 1
    assert result["assets"][0]["source"] == "asset_inventory"


def test_asset_match_for_ip_both_miss(monkeypatch):
    """双来源均未命中：matched=False，资产列表为空。"""
    monkeypatch.setattr(te, "_match_asset", lambda db, ip: {"matched": False})
    result = bw._asset_match_for_ip(_FakeDB(), "8.8.8.8")
    assert result == {"matched": False, "assets": []}


def test_asset_match_for_ip_error_degrades(monkeypatch):
    """底层匹配异常：单 IP 降级为 matched=False + error，不向上抛出。"""
    def _boom(db, ip):
        raise RuntimeError("db down")
    monkeypatch.setattr(te, "_match_asset", _boom)
    result = bw._asset_match_for_ip(_FakeDB(), "1.2.3.4")
    assert result["matched"] is False
    assert "资产匹配失败" in result["error"]
    assert result["assets"] == []


def test_asset_match_for_ip_reuses_ticket_enrichment(monkeypatch):
    """复用验证：_asset_match_for_ip 必须调用工单安全上下文的 _match_asset
    （保证匹配维度 / 优先级 / 去重逻辑完全一致，不得自行实现匹配规则）。"""
    calls = []

    def _spy(db, ip):
        calls.append(ip)
        return {"matched": False}

    monkeypatch.setattr(te, "_match_asset", _spy)
    bw._asset_match_for_ip(_FakeDB(), "1.2.3.4")
    assert calls == ["1.2.3.4"]


# ---------------------------------------------------------------------------
# query_asset_match 端点（直接调用函数体，权限依赖由路由层保证）
# ---------------------------------------------------------------------------

def _patch_matcher(monkeypatch, table):
    """table: ip -> matched payload（未列出的 IP 返回未命中）。"""
    monkeypatch.setattr(bw, "_asset_match_for_ip", lambda db, ip: table.get(
        ip, {"matched": False, "assets": []},
    ))


def test_endpoint_multi_ip_parallel_and_stats(monkeypatch):
    """多 IP 并行查询：逐 IP 返回结果，命中统计与总数正确。"""
    _patch_matcher(monkeypatch, {
        "100.66.1.25": {"matched": True, "source": "asset_discovery", "assets": []},
        "10.144.1.2": {"matched": True, "source": "asset_inventory", "assets": []},
    })
    res = bw.query_asset_match(ips="100.66.1.25, 10.144.1.2, 8.8.8.8", db=_FakeDB())
    assert res["total"] == 3
    assert res["matched"] == 2
    assert [i["ip"] for i in res["items"]] == ["100.66.1.25", "10.144.1.2", "8.8.8.8"]
    assert res["fetched_at"]
    # 未命中 IP：matched=False 且不带 error
    miss = res["items"][2]
    assert miss["matched"] is False and "error" not in miss


def test_endpoint_dedupes_duplicate_ips(monkeypatch):
    """重复 IP 去重：同一 IP 只匹配一次，顺序按首次出现。"""
    _patch_matcher(monkeypatch, {"1.1.1.1": {"matched": True, "assets": []}})
    res = bw.query_asset_match(ips="1.1.1.1, 2.2.2.2, 1.1.1.1", db=_FakeDB())
    assert res["total"] == 2
    assert [i["ip"] for i in res["items"]] == ["1.1.1.1", "2.2.2.2"]


def test_endpoint_rejects_invalid_ip():
    """非法输入（域名 / CIDR / 文本）直接 400，不触发任何匹配。"""
    for bad in ("evil.com", "10.0.0.0/8", "1.2.3.4-1.2.3.20", "not-an-ip"):
        with pytest.raises(HTTPException) as exc:
            bw.query_asset_match(ips=bad, db=_FakeDB())
        assert exc.value.status_code == 400


def test_endpoint_rejects_empty_and_over_limit(monkeypatch):
    """空列表与超过 20 个 IP 拒绝（与封禁目标多值上限一致）；恰好 20 个放行。"""
    with pytest.raises(HTTPException) as exc:
        bw.query_asset_match(ips="  ", db=_FakeDB())
    assert exc.value.status_code == 400
    many = ",".join(f"10.0.0.{i}" for i in range(1, 22))
    with pytest.raises(HTTPException) as exc:
        bw.query_asset_match(ips=many, db=_FakeDB())
    assert exc.value.status_code == 400
    # 恰好 20 个（上限内）不应抛出
    _patch_matcher(monkeypatch, {})
    ok = ",".join(f"10.0.0.{i}" for i in range(1, 21))
    res = bw.query_asset_match(ips=ok, db=_FakeDB())
    assert res["total"] == 20


def test_endpoint_single_ip_error_does_not_block_others(monkeypatch):
    """单 IP 匹配异常不阻塞其余 IP：异常条目带 error，其余正常返回。"""
    def _matcher(db, ip):
        if ip == "9.9.9.9":
            return {"matched": False, "error": "资产匹配失败: db down", "assets": []}
        return {"matched": True, "source": "asset_discovery", "assets": []}
    monkeypatch.setattr(bw, "_asset_match_for_ip", _matcher)
    res = bw.query_asset_match(ips="1.1.1.1, 9.9.9.9", db=_FakeDB())
    assert res["total"] == 2
    assert res["matched"] == 1
    assert res["items"][0]["matched"] is True
    assert "资产匹配失败" in res["items"][1]["error"]
