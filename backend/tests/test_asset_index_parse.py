"""资产清单索引 IP 解析测试（换行/中文分隔多值、范围简写、IPv6 网段）。

回归案例：``assets.ip`` 存的是 Excel 单元格内换行的多 IP
（``202.104.131.26\\n120.234.15.170\\n10.44.8.82``），旧解析只按逗号/分号
拆分，整串解析失败 → 该资产不进索引 → 工单安全上下文资产匹配与告警
资产富化都命中不到。
"""
import ipaddress

import app.core.log_receiver_manager.pipeline.enricher_stage as es


def _ip(s: str):
    return ipaddress.ip_address(s)


def test_newline_separated_multi_ip():
    assert es._parse_ip_list("202.104.131.26\n120.234.15.170\n10.44.8.82") == [
        ("ip", "202.104.131.26"),
        ("ip", "120.234.15.170"),
        ("ip", "10.44.8.82"),
    ]


def test_crlf_tab_and_cjk_separators():
    assert es._parse_ip_list("1.2.3.4\r\n5.6.7.8") == [("ip", "1.2.3.4"), ("ip", "5.6.7.8")]
    assert es._parse_ip_list("1.2.3.4\t5.6.7.8") == [("ip", "1.2.3.4"), ("ip", "5.6.7.8")]
    # 中文逗号/顿号/分号与半角分号均视为分段
    assert es._parse_ip_list("10.0.0.1，10.0.0.2、10.0.0.3;10.0.0.4") == [
        ("ip", "10.0.0.1"),
        ("ip", "10.0.0.2"),
        ("ip", "10.0.0.3"),
        ("ip", "10.0.0.4"),
    ]


def test_cidr_range_and_shorthand():
    net = es._parse_ip_list("198.51.100.0/24")[0]
    assert net[0] == "net" and str(net[1]) == "198.51.100.0/24"
    assert es._parse_ip_list("113.108.60.224-113.108.60.254") == [
        ("range", _ip("113.108.60.224"), _ip("113.108.60.254"))
    ]
    # 末段简写：61.144.224.185-187 → 185..187
    assert es._parse_ip_list("61.144.224.185-187") == [
        ("range", _ip("61.144.224.185"), _ip("61.144.224.187"))
    ]
    # 带空格的范围整串解析，不被空白拆成两段
    assert es._parse_ip_list("113.108.60.224 - 113.108.60.254") == [
        ("range", _ip("113.108.60.224"), _ip("113.108.60.254"))
    ]
    # 段落 + 范围混合
    assert es._parse_ip_list("10.0.0.1\n10.0.0.10-10.0.0.20") == [
        ("ip", "10.0.0.1"),
        ("range", _ip("10.0.0.10"), _ip("10.0.0.20")),
    ]


def test_reversed_range_defense():
    # 同 /24 倒置视为笔误交换后匹配
    assert es._parse_ip_list("10.0.0.5-10.0.0.1") == [
        ("range", _ip("10.0.0.1"), _ip("10.0.0.5"))
    ]
    # 跨网段倒置属脏数据，丢弃以免生成巨型区间误命中
    assert es._parse_ip_list("172.46.9.1-17.46.9.62") == []


def test_ipv6_network_kept():
    entries = es._parse_ip_list("240e:cf:8800:37:2::/96")
    assert entries and entries[0][0] == "net"
    assert str(entries[0][1]) == "240e:cf:8800:37:2::/96"


def test_garbage_and_empty():
    assert es._parse_ip_list("") == []
    assert es._parse_ip_list(None) == []
    assert es._parse_ip_list("not-an-ip") == []
    # 合法段与脏段混排：脏段丢弃、合法段保留
    assert es._parse_ip_list("1.2.3.4,172.46.9.1-17.46.9.62") == [("ip", "1.2.3.4")]


def test_index_and_match_newline_multi_ip(monkeypatch):
    """构建索引后换行多 IP 资产的任一 IP 均可命中（工单研判同口径）。"""
    rows = [(109067, "电子票据系统", "202.104.131.26\n120.234.15.170\n10.44.8.82")]
    monkeypatch.setattr(es, "_asset_index_cache", {"built_at": 0.0, "single": {}, "nets": []})

    class _FakeResult:
        def fetchall(self):
            return rows

    class _FakeDB:
        def execute(self, *args, **kwargs):  # noqa: ARG002
            return _FakeResult()

    es._build_asset_index(_FakeDB())
    index = {"single": es._asset_index_cache["single"], "nets": es._asset_index_cache["nets"]}
    assert es._match_asset_ip("202.104.131.26", index) == (109067, "电子票据系统")
    assert es._match_asset_ip("10.44.8.82", index) == (109067, "电子票据系统")
    assert es._match_asset_ip("203.0.113.9", index) is None
