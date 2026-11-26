# -*- coding: utf-8 -*-
"""安博通黑名单批量查询工具单元测试。

覆盖：
- 查询目标解析（单 IP / CIDR / 范围 / 末段简写 / 通配 / 域名 / 非法）
- 设备黑名单条目解析与区间匹配（精确、被网段覆盖、区间重叠、全/部分覆盖）
- ``_query_sync`` 编排：区间目标走全量列表、单 IP 走设备精确查询、
  设备不可用 / 列表拉取失败 / 非法目标的错误口径
"""
import pytest

import app.tools.anbotong_tools as at
from app.core.tools.catalog import ToolCatalog
from app.core.tools.definitions.builtin import HERMES_BUILTIN_TOOLS


class _FakeQuery:
    def __init__(self, name):
        self.name = name

    def first(self):
        return None


class _FakeDB:
    def query(self, model):  # noqa: ARG002
        return _FakeQuery("q")

    def close(self):
        pass


def _entry(blist, **extra):
    return {"blist": blist, "reason": "API添加", "effectTime": "2026-01-01 00:00:00", **extra}


# ---------------------------------------------------------------------------
# 目标 / 条目解析
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "token,kind,version,start,end",
    [
        ("10.0.0.5", "single", 4, 167772165, 167772165),
        ("10.0.0.0/24", "cidr", 4, 167772160, 167772415),
        ("10.0.0.1-10.0.0.9", "range", 4, 167772161, 167772169),
        ("10.0.0.1-9", "range", 4, 167772161, 167772169),
        ("10.0.0.*", "wildcard", 4, 167772160, 167772415),
    ],
)
def test_parse_query_ip_forms(token, kind, version, start, end):
    q = at._parse_query(token)
    assert q["type"] == kind
    assert q["version"] == version
    assert q["start"] == start
    assert q["end"] == end
    assert "error" not in q


def test_parse_query_domain_and_invalid():
    assert at._parse_query("Evil.Example.com")["type"] == "domain"
    assert at._parse_query("Evil.Example.com")["target"] == "evil.example.com"
    bad = at._parse_query("not-an-ip")
    assert "error" in bad
    assert "格式不合法" in bad["error"]


def test_entry_interval_forms():
    assert at._entry_interval("10.0.0.5") == (4, 167772165, 167772165)
    assert at._entry_interval("10.0.0.0/24") == (4, 167772160, 167772415)
    assert at._entry_interval("10.0.0.1-10.0.0.9") == (4, 167772161, 167772169)
    assert at._entry_interval("10.0.0.1-9") == (4, 167772161, 167772169)
    assert at._entry_interval("evil.example.com") is None
    assert at._entry_interval("") is None


# ---------------------------------------------------------------------------
# 列表匹配
# ---------------------------------------------------------------------------

def test_match_single_exact_and_covered():
    entries = [_entry("10.0.0.5"), _entry("10.0.1.0/24")]
    exact = at._match_from_entries(at._parse_query("10.0.0.5"), entries)
    assert exact["banned"] is True
    assert exact["match_type"] == "exact"
    assert exact["matched_count"] == 1

    covered = at._match_from_entries(at._parse_query("10.0.1.8"), entries)
    assert covered["banned"] is True
    assert covered["match_type"] == "covered"


def test_match_range_partial_and_full_coverage():
    entries = [_entry("10.0.0.5"), _entry("10.0.0.10-10.0.0.20")]
    partial = at._match_from_entries(at._parse_query("10.0.0.0/24"), entries)
    assert partial["banned"] is True
    assert partial["match_type"] == "overlap"
    assert partial["coverage"] == "partial"
    assert partial["matched_count"] == 2

    full = at._match_from_entries(at._parse_query("10.0.0.10-10.0.0.15"), entries)
    assert full["coverage"] == "full"

    none = at._match_from_entries(at._parse_query("10.0.2.0/24"), entries)
    assert none["banned"] is False
    assert none["coverage"] is None


def test_match_domain_and_permanent_flag():
    entries = [_entry("evil.example.com", age="-1", leftTime="18446744073709551615")]
    hit = at._match_from_entries(at._parse_query("evil.example.com"), entries)
    assert hit["banned"] is True
    assert hit["match_type"] == "exact"
    assert hit["coverage"] is None
    assert hit["entries"][0]["leftTime"] == -1
    assert hit["entries"][0]["permanent"] is True


# ---------------------------------------------------------------------------
# _query_sync 编排
# ---------------------------------------------------------------------------

@pytest.fixture()
def patch_env(monkeypatch):
    class _FakeDevice:
        id = 1
        name = "安博通阻断器"
        timeout = 30

    monkeypatch.setattr(at, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(at, "find_anbotong_device", lambda db: (_FakeDevice(), None))


def test_query_sync_range_uses_list(patch_env, monkeypatch):
    monkeypatch.setattr(
        at, "fetch_all_blacklist_entries",
        lambda db, source="agent": {
            "success": True,
            "entries": [_entry("10.0.0.5"), _entry("8.8.8.8")],
            "truncated": False,
        },
    )
    result = at._query_sync("10.0.0.0/24")
    assert result["success"] is True
    assert result["banned_count"] == 1
    assert result["items"][0]["target"] == "10.0.0.0/24"
    assert result["items"][0]["matched_count"] == 1


def test_query_sync_single_ip_uses_exact(patch_env, monkeypatch):
    called = {}

    class _FakeDevice:
        id = 1
        name = "安博通阻断器"
        timeout = 30

    class _FakeAction:
        id = 2
        name = "查询指定黑名单"

    def _fake_find_action(db, kind):
        called["kind"] = kind
        return _FakeDevice(), _FakeAction(), None

    def _fake_query_entry(device, action, target, timeout=None):
        return {"success": True, "found": target == "1.2.3.4", "entry": {"blist": target}}

    monkeypatch.setattr(at, "find_anbotong_action", _fake_find_action)
    monkeypatch.setattr(at, "query_blacklist_entry", _fake_query_entry)

    result = at._query_sync("1.2.3.4, 5.6.7.8")
    assert called["kind"] == "query"
    assert result["banned_count"] == 1
    assert result["clean_count"] == 1
    items = {i["target"]: i for i in result["items"]}
    assert items["1.2.3.4"]["banned"] is True
    assert items["5.6.7.8"]["banned"] is False


def test_query_sync_device_missing(monkeypatch):
    monkeypatch.setattr(at, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(at, "find_anbotong_device", lambda db: (None, "未找到安博通阻断器"))
    result = at._query_sync("1.2.3.4")
    assert result["success"] is False
    assert "未找到安博通阻断器" in result["error"]


def test_query_sync_list_failure_marks_range_error(patch_env, monkeypatch):
    monkeypatch.setattr(
        at, "fetch_all_blacklist_entries",
        lambda db, source="agent": {"success": False, "error": "设备超时"},
    )
    result = at._query_sync("10.0.0.0/24")
    assert result["success"] is True
    item = result["items"][0]
    assert item["banned"] is None
    assert item["error"]
    assert result["error_count"] == 1
    assert result["note"] and "设备超时" in result["note"]


def test_query_sync_invalid_and_limit(patch_env):
    result = at._query_sync("not-an-ip")
    assert result["items"][0]["banned"] is None
    assert "格式不合法" in result["items"][0]["error"]

    over = at._query_sync(",".join(f"10.0.0.{i}" for i in range(1, 102)))
    assert over["success"] is False
    assert "最多查询" in over["error"]


def test_tool_definition_registered():
    defs = {d["name"]: d for d in HERMES_BUILTIN_TOOLS}
    assert "query_anbotong_blacklist" in defs
    definition = defs["query_anbotong_blacklist"]
    assert definition["category"] == "blocking"
    assert definition["parameters_schema"][0]["name"] == "targets"
    assert "query_anbotong_blacklist" in ToolCatalog.seed_code_map()
