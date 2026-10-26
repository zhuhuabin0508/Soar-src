"""_value_to_intervals 解析规则测试（含倒置范围防御）。"""
import ipaddress

from app.agent.tool_builders import _value_to_intervals


def _ip(s: str) -> int:
    return int(ipaddress.IPv4Address(s))


def test_single_ip_and_cidr():
    assert _value_to_intervals("58.250.157.1") == [(_ip("58.250.157.1"), _ip("58.250.157.1"))]
    assert _value_to_intervals("198.51.100.0/24") == [
        (_ip("198.51.100.0"), _ip("198.51.100.255"))
    ]


def test_normal_range_and_shorthand():
    assert _value_to_intervals("113.108.60.224-113.108.60.254") == [
        (_ip("113.108.60.224"), _ip("113.108.60.254"))
    ]
    # 末段简写
    assert _value_to_intervals("61.144.224.185-187") == [
        (_ip("61.144.224.185"), _ip("61.144.224.187"))
    ]
    # 不完整起始 IP 自动补 .0
    assert _value_to_intervals("198.51.100-198.51.100.254") == [
        (_ip("198.51.100.0"), _ip("198.51.100.254"))
    ]


def test_reversed_range_same_24_is_swapped():
    # 同 /24 倒置视为笔误，交换后匹配
    assert _value_to_intervals("61.144.227.220-61.144.227.226") == [
        (_ip("61.144.227.220"), _ip("61.144.227.226"))
    ]
    assert _value_to_intervals("10.0.0.5-10.0.0.1") == [
        (_ip("10.0.0.1"), _ip("10.0.0.5"))
    ]


def test_reversed_range_cross_subnet_is_dropped():
    # 跨网段倒置 = 脏数据（172.46.9.1-17.46.9.62 丢了一个 "2"）：
    # 盲目交换会得到 17.46.9.62-172.46.9.1 的巨型区间，让任意 IP 误命中
    assert _value_to_intervals("172.46.9.1-17.46.9.62") == []
    assert _value_to_intervals("10.0.2.1-1.0.2.254") == []
    # 倒置但仅跨相邻 /24（非同 /24）同样丢弃
    assert _value_to_intervals("10.0.1.5-10.0.0.1") == []


def test_comma_separated_values_merge():
    assert _value_to_intervals("203.0.113.1,203.0.113.2") == [
        (_ip("203.0.113.1"), _ip("203.0.113.1")),
        (_ip("203.0.113.2"), _ip("203.0.113.2")),
    ]
    # 混合：合法段 + 脏段（脏段为空，不影响其余部分）
    assert _value_to_intervals("1.2.3.4,172.46.9.1-17.46.9.62") == [
        (_ip("1.2.3.4"), _ip("1.2.3.4")),
    ]


def test_garbage_returns_empty():
    assert _value_to_intervals("") == []
    assert _value_to_intervals("not-an-ip") == []
    assert _value_to_intervals("abc-def") == []
