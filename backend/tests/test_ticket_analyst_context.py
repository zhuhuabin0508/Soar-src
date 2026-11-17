"""工单研判上下文采集单测（monkeypatch 三个维度查询，无需真实 DB）。"""
from types import SimpleNamespace

from app.core.ticket_analyst import context as ctx_mod


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *a, **kw):
        return self

    def first(self):
        return self._result


class _FakeDb:
    def __init__(self, ticket):
        self._ticket = ticket

    def query(self, model):  # noqa: ARG002
        return _FakeQuery(self._ticket)


def _patch_queries(monkeypatch, *, blacklist=None, whitelist=None, ip_library=None):
    monkeypatch.setattr(ctx_mod, "_query_blacklist", lambda db, ips: blacklist or {
        ip: {"records": [], "degraded": False} for ip in ips})
    monkeypatch.setattr(ctx_mod, "_query_whitelist", lambda db, ips: whitelist or {
        ip: {"hit": False, "match_type": None, "entries": [], "degraded": False} for ip in ips})
    monkeypatch.setattr(ctx_mod, "_query_ip_library", lambda db, ips: ip_library or {
        ip: {"matches": [], "degraded": False} for ip in ips})


class TestGatherContexts:
    def test_assembles_entry_and_dims(self, monkeypatch):
        entry = {
            "ip": "1.2.3.4", "roles": ["src_ip"],
            "asset": {"matched": True, "asset_name": "web-01"},
            "threat": {"is_malicious": False},
            "ti_360": {"results": []},
        }
        ticket = SimpleNamespace(id=7, enrichment_data={"ips": [entry]})
        _patch_queries(
            monkeypatch,
            whitelist={"1.2.3.4": {"hit": True, "match_type": "exact",
                                  "entries": [{"wlist": "1.2.3.4"}], "degraded": False}},
        )
        ctxs = ctx_mod.gather_contexts(_FakeDb(ticket), 7, ["1.2.3.4"], title="扫描告警")
        c = ctxs["1.2.3.4"]
        assert c["roles"] == ["src_ip"]
        assert c["title"] == "扫描告警"
        assert c["asset"]["asset_name"] == "web-01"
        assert c["threat"] == {"is_malicious": False}
        assert c["ti_360"] == {"results": []}
        assert c["whitelist"]["hit"] is True
        assert c["blacklist"]["degraded"] is False

    def test_missing_entry_dims_none(self, monkeypatch):
        """enrichment 中无该 IP 条目：资产/情报维度为 None，不抛异常。"""
        ticket = SimpleNamespace(id=7, enrichment_data={"ips": [
            {"ip": "9.9.9.9", "roles": ["src_ip"]}]})
        _patch_queries(monkeypatch)
        ctxs = ctx_mod.gather_contexts(_FakeDb(ticket), 7, ["5.6.7.8"], "")
        c = ctxs["5.6.7.8"]
        assert c["asset"] is None
        assert c["threat"] is None
        assert c["ti_360"] is None

    def test_ticket_missing_or_legacy(self, monkeypatch):
        """工单不存在 / 无 v2 数据：本地三维度仍正常采集。"""
        _patch_queries(
            monkeypatch,
            blacklist={"1.1.1.1": {"records": [{"ban_level": "high"}], "degraded": False}},
        )
        ctxs = ctx_mod.gather_contexts(_FakeDb(None), 999, ["1.1.1.1"], "")
        assert ctxs["1.1.1.1"]["blacklist"]["records"][0]["ban_level"] == "high"
        ctxs = ctx_mod.gather_contexts(
            _FakeDb(SimpleNamespace(id=1, enrichment_data=None)), 1, ["1.1.1.1"], "")
        assert ctxs["1.1.1.1"]["ip_library"]["matches"] == []

    def test_multiple_ips(self, monkeypatch):
        ticket = SimpleNamespace(id=7, enrichment_data={"ips": [
            {"ip": "1.1.1.1", "roles": ["src_ip"], "asset": {"matched": False}},
            {"ip": "2.2.2.2", "roles": ["dst_ip"]},
        ]})
        _patch_queries(monkeypatch)
        ctxs = ctx_mod.gather_contexts(_FakeDb(ticket), 7, ["1.1.1.1", "2.2.2.2"], "t")
        assert set(ctxs) == {"1.1.1.1", "2.2.2.2"}
        assert ctxs["2.2.2.2"]["asset"] is None


class TestDimQueriesDegraded:
    def test_blacklist_exception_degrades(self):
        """查询抛异常：全部 IP 按 degraded 降级，不向外抛。"""
        class BoomDb:
            def query(self, model):  # noqa: ARG002
                raise RuntimeError("db down")

        out = ctx_mod._query_blacklist(BoomDb(), ["1.1.1.1", "2.2.2.2"])
        assert out["1.1.1.1"]["degraded"] is True
        assert out["1.1.1.1"]["records"] == []
        assert out["2.2.2.2"]["degraded"] is True

    def test_whitelist_exception_degrades(self, monkeypatch):
        """match_targets 抛异常：全部 IP 按 degraded 降级。"""
        def boom(db, targets):  # noqa: ARG001
            raise RuntimeError("whitelist down")

        monkeypatch.setattr("app.core.anbotong_whitelist.match_targets", boom)
        out = ctx_mod._query_whitelist(None, ["1.1.1.1"])
        assert out["1.1.1.1"]["degraded"] is True
        assert out["1.1.1.1"]["hit"] is False

    def test_ip_library_ipv6_not_supported(self, monkeypatch):
        """IPv6：地址库降级标记 + 原因。"""
        out = ctx_mod._query_ip_library(None, ["::1"])
        assert out["::1"]["degraded"] is True
        assert out["::1"]["matches"] == []

    def test_ip_library_ipv4_lookup(self, monkeypatch):
        monkeypatch.setattr(
            "app.api.v1.ip_library._lookup_matches",
            lambda db, ip_int: [{"library_type": "overseas", "library_label": "境外"}],
        )
        out = ctx_mod._query_ip_library(None, ["8.8.8.8"])
        assert out["8.8.8.8"]["degraded"] is False
        assert out["8.8.8.8"]["matches"][0]["library_type"] == "overseas"

    def test_empty_ips(self):
        assert ctx_mod._query_blacklist(None, []) == {}
        assert ctx_mod._query_ip_library(None, []) == {}
