"""青藤组件检索的单元测试。

覆盖：
- normalize_keyword / name_matches：词边界匹配，redis 不命中 redisson
- clean_version：占位版本识别
- aggregate：排除词、去重、版本优先级、端口过滤、截断告警
- search_components：接口 mock、分页结果聚合与缓存

运行：python -m pytest tests/test_qingteng_component_search.py -v
"""
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import app.core.qingteng_component_search as qcs  # noqa: E402
from app.core.qingteng_component_search import (  # noqa: E402
    aggregate,
    clean_version,
    name_matches,
    normalize_keyword,
    search_components,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    qcs._CACHE.clear()
    yield
    qcs._CACHE.clear()


def test_normalize_keyword():
    assert normalize_keyword("  Redis ") == "redis"
    assert normalize_keyword("ＮＧＩＮＸ") == "nginx"


@pytest.mark.parametrize("bad", ["", " ", "r"])
def test_normalize_keyword_rejects_short(bad):
    with pytest.raises(ValueError):
        normalize_keyword(bad)


def test_name_matches_word_boundary():
    assert name_matches("redis", "redis") == (True, "exact")
    assert name_matches("redis-server", "redis") == (True, "prefix")
    assert name_matches("my-redis-6.2", "redis") == (True, "contains")
    assert name_matches("redisson", "redis") == (False, "")
    assert name_matches("jdkzip-utils", "jdk") == (False, "")


def test_name_matches_chinese_keyword_falls_back_to_substring():
    assert name_matches("达梦数据库管理系统", "达梦") == (True, "contains")
    assert name_matches("达梦", "达梦") == (True, "exact")
    assert name_matches("Oracle Database", "达梦") == (False, "")
    # 混合中文 + 英文按子串匹配，不做 ASCII 词边界拆分
    assert name_matches("东方通TongWeb", "东方通TongWeb") == (True, "exact")


def test_clean_version():
    assert clean_version("17.0.9+9-1~deb12u1") == ("17.0.9+9-1~deb12u1", "17.0.9+9-1~deb12u1")
    assert clean_version("1:6.2.7-1") == ("1:6.2.7-1", "6.2.7-1")
    for placeholder in ("", "-", "unknown", "未知", "0.0.0", None):
        assert clean_version(placeholder) == ("", "")


def _redis_rows():
    return {
        "app": [
            {"agentId": "a1", "displayIp": "10.0.0.1", "hostname": "app-01", "name": "Redis", "version": "6.2.7"},
        ],
        "pkg": [
            {"agentId": "a1", "displayIp": "10.0.0.1", "name": "redis-server", "version": "6.2.7-1"},
            {"agentId": "a1", "displayIp": "10.0.0.1", "name": "redis-server", "version": "6.2.7-1"},
            {"agentId": "a1", "displayIp": "10.0.0.1", "name": "redis-tools", "version": "6.2.7-1"},
            {"agentId": "a1", "displayIp": "10.0.0.1", "name": "redis-doc", "version": ""},
        ],
        "process": [
            {"agentId": "a2", "displayIp": "10.0.0.2", "hostname": "cache-02", "name": "redis-server",
             "packageVersion": "", "pid": 100, "uname": "redis"},
        ],
        "port": [
            {"agentId": "a2", "displayIp": "10.0.0.2", "processName": "redis-server", "port": 6379,
             "proto": "tcp", "bindIp": "0.0.0.0"},
            {"agentId": "a3", "displayIp": "10.0.0.3", "processName": "redisson-worker", "port": 6379},
        ],
        "service": [],
        "dbinfo": [],
    }


def test_aggregate_filters_and_dedupes():
    result = aggregate("redis", _redis_rows())

    assert result["summary"]["host_count"] == 2
    hosts = {h["agent_id"]: h for h in result["hosts"]}
    assert set(hosts) == {"a1", "a2"}

    a1 = hosts["a1"]
    components = sorted(e["component"] for e in a1["evidence"])
    assert components == ["Redis", "redis-server"]  # redis-tools/doc 被排除，重复包去重
    assert a1["version_known"] is True
    # app 优先级高于 pkg，排在前面
    assert a1["evidence"][0]["source"] == "app"

    a2 = hosts["a2"]
    assert [e["source"] for e in a2["evidence"]] == ["process", "port"]
    assert a2["version_known"] is False
    assert a2["evidence"][0]["confidence"] == "低"

    assert result["data_quality"]["excluded_rows"] == 2
    assert result["data_quality"]["duplicate_rows"] == 1
    assert any("排除" in w for w in result["warnings"])


def test_aggregate_port_filter_keeps_listening_hosts_only():
    rows = _redis_rows()
    rows["app"].append({"agentId": "a9", "displayIp": "10.0.0.9", "name": "redis", "version": "7.0.0"})
    result = aggregate("redis", rows, port=6379)

    assert [h["agent_id"] for h in result["hosts"]] == ["a2"]


def test_aggregate_has_more_and_limit():
    rows = {
        "pkg": [
            {"agentId": f"a{i}", "displayIp": f"10.0.0.{i}", "name": "redis-server", "version": "6.2.7"}
            for i in range(1, 6)
        ]
    }
    result = aggregate("redis", rows, limit=3)
    assert result["summary"]["host_count"] == 5
    assert result["summary"]["returned_host_count"] == 3
    assert result["has_more"] is True


def _device():
    return types.SimpleNamespace(
        id=1, name="测试青藤", api_url="https://10.0.0.1",
        timeout=10, verify_tls=False, username="u", password="p",
    )


def test_search_components_mocks_sources_and_caches(monkeypatch):
    calls = []

    monkeypatch.setattr(qcs, "_qingteng_login", lambda *a, **kw: ("c", "j", "s"))

    def fake_fetch(client, base_url, comid, jwt, signkey, path, params):
        calls.append((path, params))
        if path.endswith("/app/linux"):
            return [{"agentId": "a1", "displayIp": "10.0.0.1", "name": "redis", "version": "6.2.7"}]
        return []

    monkeypatch.setattr(qcs, "_fetch_rows", fake_fetch)

    result = search_components(_device(), "redis")
    assert result["summary"]["host_count"] == 1
    assert result["hosts"][0]["evidence"][0]["version"] == "6.2.7"
    assert result["device"]["id"] == 1
    assert any(p.endswith("/pkg/linux") for p, _ in calls)
    assert ("port", "6379") not in [(k, str(v)) for p, q in calls for k, v in q.items()]

    # 第二次命中缓存，不再请求青藤
    count = len(calls)
    search_components(_device(), "redis")
    assert len(calls) == count

    # 强制刷新会重新拉取
    search_components(_device(), "redis", force_refresh=True)
    assert len(calls) == count * 2


def test_search_components_validates_port_and_keyword(monkeypatch):
    monkeypatch.setattr(qcs, "_qingteng_login", lambda *a, **kw: ("c", "j", "s"))
    with pytest.raises(ValueError):
        search_components(_device(), "redis", port=70000)
    with pytest.raises(ValueError):
        search_components(_device(), "r")
