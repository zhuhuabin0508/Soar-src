"""青藤 CVE 影响面查询的单元测试。

覆盖：
- normalize_cve / extract_cves：CVE 编号归一化与字段解析
- _merge_source：列表记录 + 详情 → CVE 倒排索引（同一漏洞多主机只拉一次详情）
- query_cve_hosts：命中聚合、去重、排序与未收录判断

运行：python -m pytest tests/test_qingteng_cve.py -v
"""
import os
import sys
import types
from collections import defaultdict

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import app.core.qingteng_cve as cve_mod  # noqa: E402
from app.core.qingteng_cve import extract_cves, normalize_cve, query_cve_hosts  # noqa: E402


def test_normalize_cve():
    assert normalize_cve(" cve-2024-21762 ") == "CVE-2024-21762"
    assert normalize_cve("CVE-2021-44228") == "CVE-2021-44228"


@pytest.mark.parametrize("bad", ["", "CVE-2024", "2024-21762", "CVE-2024-abcde", "CVE-2024-12345678"])
def test_normalize_cve_rejects_invalid(bad):
    with pytest.raises(ValueError):
        normalize_cve(bad)


def test_extract_cves_from_string_and_list():
    assert extract_cves("CVE-2024-1111, cve-2024-2222;CVE-2024-1111") == [
        "CVE-2024-1111", "CVE-2024-2222",
    ]
    assert extract_cves(["CVE-2024-3333", "CVE-2024-3333"]) == ["CVE-2024-3333"]
    assert extract_cves(None) == []
    assert extract_cves("KB5034441") == []


def test_merge_source_builds_cve_index_without_duplicate_detail_calls(monkeypatch):
    rows = [
        {"id": 11, "vulId": "v1", "agentId": "a1", "displayIp": "10.0.0.1", "hostname": "h1"},
        {"id": 12, "vulId": "v1", "agentId": "a2", "displayIp": "10.0.0.2", "hostname": "h2"},
        {"id": 13, "vulId": "v2", "agentId": "a1", "displayIp": "10.0.0.1", "hostname": "h1"},
    ]
    calls = []

    def fake_details(client, base, comid, jwt, signkey, prefix, id_map):
        calls.append(dict(id_map))
        return {
            "v1": {"cves": ["CVE-2024-1111"], "vulName": "漏洞一", "severity": 4},
            "v2": {"cves": "CVE-2024-2222", "vulName": "漏洞二", "severity": 3},
        }

    monkeypatch.setattr(cve_mod, "_fetch_details", fake_details)

    hosts, host_index, meta, hits = [], {}, {}, defaultdict(list)
    count = cve_mod._merge_source(
        "linux_poc", rows, "/detail/", None, "http://qt", "c", "j", "s",
        hosts, host_index, meta, hits,
    )

    assert count == 2  # 唯一 vulId 数量
    assert calls == [{"v1": "11", "v2": "13"}]  # 每个 vulId 只取一次详情
    assert len(hosts) == 2
    assert meta[("linux_poc", "v1")]["severity"] == "危急"
    assert [(s, v) for s, v, _ in hits["CVE-2024-1111"]] == [
        ("linux_poc", "v1"), ("linux_poc", "v1"),
    ]


def _synthetic_index():
    return {
        "built_at": "2026-11-19 10:00:00",
        "expires_at": 0,
        "hosts": [
            {"agent_id": "a1", "host_ip": "10.0.0.1", "host_name": "h1", "biz_group": "核心"},
            {"agent_id": "a2", "host_ip": "10.0.0.2", "host_name": "h2", "biz_group": "办公"},
        ],
        "meta": {
            ("linux_poc", "v1"): {"vul_name": "漏洞一", "severity_code": 4, "severity": "危急"},
            ("linux_patch", "p1"): {"vul_name": "补丁一", "severity_code": 2, "severity": "中危"},
        },
        "hits_by_cve": {
            "CVE-2024-1111": [
                ("linux_poc", "v1", 0),
                ("linux_patch", "p1", 0),
                ("linux_poc", "v1", 0),  # 重复记录应去重
            ],
            "CVE-2024-2222": [("linux_patch", "p1", 1)],
        },
        "source_counts": {"linux_poc": 1, "linux_patch": 1},
        "warnings": [],
    }


def test_query_cve_hosts_groups_dedupes_and_sorts(monkeypatch):
    monkeypatch.setattr(cve_mod, "_get_index", lambda device, force_refresh=False: _synthetic_index())
    result = query_cve_hosts(types.SimpleNamespace(id=1), "cve-2024-1111")

    assert result["covered"] is True
    assert result["summary"]["host_count"] == 1
    assert result["summary"]["hit_count"] == 2  # 重复的 linux_poc 记录被去重
    assert [h["source"] for h in result["hosts"][0]["hits"]] == ["linux_poc", "linux_patch"]
    assert result["hosts"][0]["hits"][0]["severity"] == "危急"


def test_query_cve_hosts_not_covered(monkeypatch):
    monkeypatch.setattr(cve_mod, "_get_index", lambda device, force_refresh=False: _synthetic_index())
    result = query_cve_hosts(types.SimpleNamespace(id=1), "CVE-2024-9999")

    assert result["covered"] is False
    assert result["hosts"] == []
    assert result["summary"]["host_count"] == 0


def test_query_cve_hosts_rejects_bad_cve(monkeypatch):
    monkeypatch.setattr(cve_mod, "_get_index", lambda device, force_refresh=False: _synthetic_index())
    with pytest.raises(ValueError):
        query_cve_hosts(types.SimpleNamespace(id=1), "not-a-cve")
