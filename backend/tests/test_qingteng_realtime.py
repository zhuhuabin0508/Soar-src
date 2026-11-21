"""青藤实时查询（按需，不落库）单元测试。"""
import os
import sys
import types
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import app.core.qingteng_realtime as rt  # noqa: E402
from app.core.qingteng_realtime import (  # noqa: E402
    REALTIME_MODULES,
    _matches,
    _scalar,
    realtime_query,
)


def _device():
    return types.SimpleNamespace(
        id=7, name="青藤万相(安管五部)", api_url="https://10.0.0.1",
        timeout=5, verify_tls=False,
    )


def test_module_config_has_groups_and_columns():
    assert set(REALTIME_MODULES) >= {
        "account", "accountgroup", "webapp", "website",
        "process", "port", "service", "pkg", "app", "dbinfo", "webframe",
    }
    assert "qingteng_asset" in REALTIME_MODULES["account"]["groups"]
    assert "qingteng_component" in REALTIME_MODULES["pkg"]["groups"]
    assert REALTIME_MODULES["port"]["columns"]


def test_requires_at_least_one_filter():
    with pytest.raises(ValueError):
        realtime_query(_device(), "account")


def test_unknown_module_rejected():
    with pytest.raises(ValueError):
        realtime_query(_device(), "not-a-module", keyword="x")


def test_matches_and_scalar():
    row = {"name": "Redis Server", "version": "7.0.1", "processes": [1, 2]}
    assert _matches(row, "redis", ("name",))
    assert not _matches(row, "mysql", ("name",))
    assert _scalar("x") == "x"
    assert _scalar(None) is None
    assert _scalar([1]) is None


class _FakeResp:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, headers=None):
        page = int(parse_qs(urlparse(url).query).get("page", ["0"])[0])
        rows = self.rows if page == 0 else []
        return _FakeResp({"code": 0, "data": {"total": len(self.rows), "rows": rows}})


def _patch(monkeypatch, rows):
    monkeypatch.setattr(rt, "_qingteng_login", lambda *a, **kw: ("c", "j", "s"))
    monkeypatch.setattr(rt.httpx, "Client", lambda *a, **kw: _FakeClient(rows))


def test_realtime_query_filters_and_masks_sensitive(monkeypatch):
    rows = [
        {
            "agentId": "a1", "hostname": "h1", "displayIp": "10.0.0.1",
            "name": "root", "home": "/root", "status": 1, "uid": 0, "gid": 0,
            "password": "should-not-leak",
        },
        {
            "agentId": "a2", "hostname": "h2", "displayIp": "10.0.0.2",
            "name": "redis", "home": "/var/lib/redis", "status": 1, "uid": 999, "gid": 999,
        },
    ]
    _patch(monkeypatch, rows)
    result = realtime_query(_device(), "account", keyword="redis", limit=10)

    assert result["matched"] == 1
    assert result["rows"][0]["name"] == "redis"
    assert result["rows"][0]["osType"] == "linux"
    assert "password" not in result["rows"][0]
    assert result["rows"][0]["uid"] == 999
    assert any(c["key"] == "uid" for c in result["columns"])


def test_realtime_query_port_filter(monkeypatch):
    rows = [
        {"agentId": "a1", "hostname": "h1", "port": 443, "proto": "https", "type": "nginx"},
        {"agentId": "a2", "hostname": "h2", "port": 8443, "proto": "https", "type": "java"},
    ]
    _patch(monkeypatch, rows)
    result = realtime_query(_device(), "website", port=443, limit=10)

    assert result["matched"] == 1
    assert result["rows"][0]["port"] == 443


def test_realtime_query_respects_os_type(monkeypatch):
    _patch(monkeypatch, [{"agentId": "a1", "hostname": "h1", "name": "root"}])
    result = realtime_query(_device(), "account", agent_id="a1", os_type="win")
    assert result["rows"][0]["osType"] == "win"
