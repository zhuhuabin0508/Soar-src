"""search_assets 资产发现联动测试：IP 查询合并资产发现数据。"""
import asyncio

from app.agent.tool_builders import (
    _build_asset_tool,
    _discovery_ip_tokens,
    _merge_discovery_results,
    _split_tokens,
)


class _FakeQuery:
    """替身 Query：链式调用全部返回自身，结果恒为空。"""

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def distinct(self, *args, **kwargs):
        return self

    def all(self):
        return []


class _FakeDB:
    """替身 SessionLocal：无数据库环境下所有查询返回空。"""

    def query(self, *args, **kwargs):
        return _FakeQuery()

    def close(self):
        pass


def test_split_tokens_variants():
    assert _split_tokens("") == []
    assert _split_tokens("1.2.3.4") == ["1.2.3.4"]
    assert _split_tokens(" 1.2.3.4，5.6.7.8；web-01 ") == ["1.2.3.4", "5.6.7.8", "web-01"]


def test_discovery_ip_tokens_extracts_ip_and_cidr_only():
    # 单 IP / CIDR 提取并规范化；文本与非 IP token 不进入资产发现查询
    assert _discovery_ip_tokens("1.2.3.4, 财务服务器, 10.0.0.1/24; abc") == [
        "1.2.3.4",
        "10.0.0.0/24",
    ]
    assert _discovery_ip_tokens("财务服务器") == []
    assert _discovery_ip_tokens("") == []
    # IPv6 / 非法 IP / 非法掩码均排除
    assert _discovery_ip_tokens("::1, 300.1.1.1, 10.0.0.0/99") == []


def test_merge_single_target_appends_discovery_group():
    payload = {"count": 1, "主机资产": [{"id": 1, "ip": "1.2.3.4"}]}
    discovery = {
        "source": "asset_discovery",
        "query": "1.2.3.4",
        "count": 2,
        "truncated": False,
        "assets": [
            {"resource_type": "cloud_host", "ip_address": "1.2.3.4"},
            {"resource_type": "elastic_ip", "ip_address": "1.2.3.4"},
        ],
    }
    _merge_discovery_results(payload, discovery)
    assert payload["count"] == 1  # 资产清单计数不变
    assert len(payload["资产发现"]) == 2
    assert "资产发现_error" not in payload
    assert "资产发现_truncated" not in payload


def test_merge_single_target_error_noted():
    payload = {"count": 0, "主机资产": []}
    discovery = {
        "source": "asset_discovery",
        "query": "1.2.3.4",
        "count": 0,
        "truncated": False,
        "assets": [],
        "error": "资产发现查询超时或失败，请改用精确 IP 或缩小关键词",
    }
    _merge_discovery_results(payload, discovery)
    assert payload["资产发现"] == []
    assert "超时" in payload["资产发现_error"]


def test_merge_batch_matches_by_query_and_flags_matched():
    payload = {
        "batch": True,
        "count": 0,
        "queries": [
            {"query": "1.2.3.4", "matched": False, "count": 0, "主机资产": []},
            {"query": "web-01", "matched": False, "count": 0, "主机资产": []},
        ],
    }
    discovery = {
        "source": "asset_discovery",
        "batch": True,
        "count": 1,
        "truncated": False,
        "queries": [
            {
                "query": "1.2.3.4",
                "matched": True,
                "count": 1,
                "truncated": False,
                "assets": [{"resource_type": "bare_metal", "ip_address": "1.2.3.4"}],
            },
        ],
    }
    _merge_discovery_results(payload, discovery)
    ip_entry, text_entry = payload["queries"]
    # IP 目标：命中资产发现 → matched 置 True 并追加分组
    assert ip_entry["matched"] is True
    assert ip_entry["资产发现"][0]["resource_type"] == "bare_metal"
    # 文本目标未查询资产发现：不追加分组、matched 不变
    assert "资产发现" not in text_entry
    assert text_entry["matched"] is False


def test_merge_batch_with_single_discovery_payload():
    # keyword 混有文本 token：资产清单为批量返回、资产发现为单目标返回
    payload = {
        "batch": True,
        "count": 0,
        "queries": [
            {"query": "1.2.3.4", "matched": False, "count": 0, "主机资产": []},
        ],
    }
    discovery = {
        "source": "asset_discovery",
        "query": "1.2.3.4",
        "count": 1,
        "truncated": True,
        "assets": [{"resource_type": "cloud_host"}],
    }
    _merge_discovery_results(payload, discovery)
    entry = payload["queries"][0]
    assert entry["matched"] is True
    assert entry["资产发现"][0]["resource_type"] == "cloud_host"
    assert entry["资产发现_truncated"] is True


def test_merge_batch_with_queryless_error_payload_notes_top_level_error():
    # 批量查询时整个资产发现查询失败（超时等，返回无 query 维度的 error 形状）：
    # 顶层记一次「资产发现_error」，条目与清单结果不受影响
    payload = {
        "batch": True,
        "count": 1,
        "queries": [
            {"query": "1.2.3.4", "matched": True, "count": 1, "主机资产": [{"id": 1}]},
            {"query": "5.6.7.8", "matched": False, "count": 0, "主机资产": []},
        ],
    }
    discovery = {
        "error": "资产发现查询超时或失败，请改用精确 IP 或缩小关键词",
        "count": 0,
        "assets": [],
    }
    _merge_discovery_results(payload, discovery)
    assert payload["资产发现_error"] == discovery["error"]
    # 清单条目原样保留
    assert payload["queries"][0]["matched"] is True
    assert "资产发现" not in payload["queries"][0]
    assert "资产发现" not in payload["queries"][1]


def test_merge_ignores_non_dict_inputs():
    payload = {"count": 0}
    assert _merge_discovery_results(payload, None) is payload
    assert _merge_discovery_results(None, {"assets": []}) is None


def test_asset_tool_coroutine_merges_discovery(monkeypatch):
    """IP 查询：资产清单（空）+ 资产发现命中 → 返回结构含「资产发现」分组。"""
    monkeypatch.setattr("app.database.SessionLocal", _FakeDB)

    async def fake_discovery(keyword="", resource_type="", limit=10):
        assert keyword == "1.2.3.4"
        return {
            "source": "asset_discovery",
            "query": "1.2.3.4",
            "count": 1,
            "truncated": False,
            "assets": [{"resource_type": "cloud_host", "ip_address": "1.2.3.4"}],
        }

    monkeypatch.setattr(
        "app.agent.discovery_search.execute_search_discovered_assets", fake_discovery
    )

    tool = _build_asset_tool(["host_asset"])
    assert tool is not None
    result = asyncio.run(tool.coroutine(keyword="1.2.3.4"))

    assert result["count"] == 0  # 资产清单无命中
    assert result["资产发现"][0]["ip_address"] == "1.2.3.4"


def test_asset_tool_coroutine_batch_merges_per_ip(monkeypatch):
    """批量 IP 查询：每个 IP 各自合并资产发现命中，matched 含发现命中。"""
    monkeypatch.setattr("app.database.SessionLocal", _FakeDB)

    async def fake_discovery(keyword="", resource_type="", limit=10):
        # 只有一个 IP 在资产发现中命中
        queries = []
        for ip in keyword.split(","):
            assets = (
                [{"resource_type": "elastic_ip", "ip_address": ip}] if ip == "5.6.7.8" else []
            )
            queries.append({"query": ip, "matched": bool(assets), "count": len(assets),
                            "truncated": False, "assets": assets})
        return {
            "source": "asset_discovery",
            "batch": True,
            "count": 1,
            "truncated": False,
            "queries": queries,
        }

    monkeypatch.setattr(
        "app.agent.discovery_search.execute_search_discovered_assets", fake_discovery
    )

    tool = _build_asset_tool(["host_asset"])
    result = asyncio.run(tool.coroutine(keyword="1.2.3.4,5.6.7.8"))

    assert result["batch"] is True
    by_query = {entry["query"]: entry for entry in result["queries"]}
    assert by_query["1.2.3.4"]["matched"] is False
    assert by_query["1.2.3.4"]["资产发现"] == []
    assert by_query["5.6.7.8"]["matched"] is True
    assert by_query["5.6.7.8"]["资产发现"][0]["resource_type"] == "elastic_ip"


def test_asset_tool_coroutine_skips_discovery_for_text(monkeypatch):
    """文本查询：不触发资产发现查询。"""
    monkeypatch.setattr("app.database.SessionLocal", _FakeDB)

    async def boom(**kwargs):
        raise AssertionError("文本查询不应调用资产发现")

    monkeypatch.setattr(
        "app.agent.discovery_search.execute_search_discovered_assets", boom
    )

    tool = _build_asset_tool(["host_asset"])
    result = asyncio.run(tool.coroutine(keyword="财务服务器"))

    assert "资产发现" not in result


def test_asset_tool_coroutine_survives_discovery_failure(monkeypatch):
    """资产发现查询异常：只记日志，资产清单结果正常返回。"""
    monkeypatch.setattr("app.database.SessionLocal", _FakeDB)

    async def broken_discovery(**kwargs):
        raise RuntimeError("govcloud 表不可用")

    monkeypatch.setattr(
        "app.agent.discovery_search.execute_search_discovered_assets", broken_discovery
    )

    tool = _build_asset_tool(["host_asset"])
    result = asyncio.run(tool.coroutine(keyword="1.2.3.4"))

    assert result["count"] == 0
    assert "资产发现" not in result
