"""资产入库前校验测试：拦截倒置范围/巨型网段/残缺 IP 等脏数据。

历史脏数据案例（驱动本套校验）：
- 172.46.9.1-17.46.9.62 / 10.0.2.1-1.0.2.254 / 176.16.173.1-176.13.173.254
  丢字导致倒置范围 → 解析成跨网段巨型区间，任意 IP 误命中
- 143.146.79.0/24 列宽截断成 143.146.79.0/2 → 覆盖 128.0.0.0/2 约 10 亿地址
"""
import pytest

from app.api.v1.assets import (
    _apply_template_to_asset,
    _check_asset_field_len,
    _validate_ip_expression,
)
from app.models.asset import AssetTypeTemplate


def _net_tpl(identifier_field="网段", fields=None):
    """构造网段类模板（identifier_field 为 cidr 类型，映射到标准 ip 列）。"""
    if fields is None:
        fields = [
            {"key": "网段", "label": "网段", "type": "cidr", "mapped_to": "standard:ip"},
            {"key": "名称", "label": "名称", "type": "text", "mapped_to": "standard:name"},
            {"key": "EIP", "label": "EIP", "type": "ip", "mapped_to": "extra"},
        ]
    tpl = AssetTypeTemplate(code="network_segment", name="网段/IP信息")
    tpl.identifier_field = identifier_field
    tpl.fields = fields
    return tpl


# ============================================================================
# _validate_ip_expression
# ============================================================================

@pytest.mark.parametrize("dirty", [
    "172.46.9.1-17.46.9.62",       # 丢 "2" → 倒置跨网段
    "10.0.2.1-1.0.2.254",          # 丢 "1" → 倒置跨网段
    "176.16.173.1-176.13.173.254", # 13↔16 笔误 → 倒置
    "10.0.0.5-10.0.0.1",           # 同 /24 倒置
])
def test_reject_reversed_ranges(dirty):
    with pytest.raises(ValueError, match="起始 IP 大于结束 IP"):
        _validate_ip_expression(dirty, "网段")


@pytest.mark.parametrize("dirty", [
    "143.146.79.0/2",   # 截断产物：覆盖 128.0.0.0/2
    "0.0.0.0/7",
    "10.0.0.0/4",
])
def test_reject_giant_cidr(dirty):
    with pytest.raises(ValueError, match="掩码"):
        _validate_ip_expression(dirty, "网段")


def test_reject_huge_range():
    with pytest.raises(ValueError, match="跨度过大"):
        _validate_ip_expression("1.0.0.1-200.0.0.1", "网段")


@pytest.mark.parametrize("dirty", [
    "10.1",        # 残缺 IP
    "192.168",
    "300.1.1.1",   # 非法段值
    "1.2.3.4.5",
])
def test_reject_incomplete_or_invalid_ip(dirty):
    with pytest.raises(ValueError):
        _validate_ip_expression(dirty, "IP地址")


def test_reject_bad_cidr_and_range_endpoints():
    with pytest.raises(ValueError, match="网段"):
        _validate_ip_expression("192.0.2.0/abc", "网段")
    with pytest.raises(ValueError, match="结束地址无效"):
        _validate_ip_expression("192.0.2.1-xxx", "网段")
    # 字母开头的值（如嵌 IP 的主机名）按文本放行，不误判为范围
    _validate_ip_expression("node-192.0.2.10", "IP地址")


def test_reject_any_bad_segment_in_multi_value():
    # 多值中任一段非法 → 整体报错
    with pytest.raises(ValueError, match="第3段"):
        _validate_ip_expression("192.0.2.0/24,10.0.0.1,172.46.9.1-17.46.9.62", "网段")


@pytest.mark.parametrize("ok", [
    "192.0.2.10",                          # 单 IP
    "10.0.0.0/8",                          # 合法大网段下限
    "198.51.100.0/24",
    "192.0.2.1-192.0.2.100",               # 完整范围
    "192.0.2.1-100",                       # 短格式范围
    "143.146.72.128/25,143.146.79.0/24",   # 多 CIDR
    "10.0.0.1,10.0.0.2;10.0.0.3",          # 多值分隔符
    "fe80::1",                             # IPv6 单值放行
    "fe80::/64",                           # IPv6 网段放行
])
def test_accept_valid_values(ok):
    _validate_ip_expression(ok, "网段")  # 不抛异常


@pytest.mark.parametrize("ok", [
    "web-01",
    "web-01.example.com",
    "财务服务器",
    "待定",
    # 数字开头但无点组/斜杠/横线的纯文本：不误判为 IP 数据
    "123办公室",
    "2024",
    "10",
])
def test_allow_hostname_and_text_fallback(ok):
    # 非形似 IP 的文本（主机名等）不受影响
    _validate_ip_expression(ok, "IP地址")


def test_allow_space_separated_multi_value():
    # 空白分隔多值：与检索层 _split_tokens 语义一致，逐段校验
    _validate_ip_expression("10.0.0.1 10.0.0.2", "IP地址")
    _validate_ip_expression("10.0.0.1、财务服务器", "IP地址")
    with pytest.raises(ValueError, match="第2段"):
        _validate_ip_expression("10.0.0.1 300.1.1.1", "IP地址")


def test_reject_bare_shorthand_and_slash_text():
    # "数字-数字"/"数字/数字" 视为残缺 IP 表达式（缺基础 IP）→ 拦截
    with pytest.raises(ValueError, match="起始地址无效"):
        _validate_ip_expression("1-100", "IP地址")
    with pytest.raises(ValueError, match="网段"):
        _validate_ip_expression("24/7服务", "IP地址")


def test_empty_and_none_pass():
    _validate_ip_expression("", "ip")
    _validate_ip_expression(None, "ip")


# ============================================================================
# _check_asset_field_len（禁止静默截断）
# ============================================================================

def test_len_check_accepts_129_char_multi_cidr():
    # 历史案例值（129 字符）：ip 列扩为 varchar(256) 后可完整存储，
    # 此前列宽 128 会把它截断成 128 字符、末段 /24 变 /2 产生脏数据
    value = "143.146.72.128/25,143.146.73.0/24,143.146.74.0/24,143.146.75.0/24,143.146.76.0/24,143.146.77.0/24,143.146.78.0/24,143.146.79.0/24"
    assert len(value) == 129
    _check_asset_field_len("143.146.72.128/25", value)


def test_len_check_rejects_overlong_ip():
    # 超过 256 的多 IP 列表仍被拦截（报错而非截断，提示拆分导入）
    value = ",".join(f"10.0.{i // 256}.{i % 256}" for i in range(30))
    assert len(value) > 256
    with pytest.raises(ValueError, match="过长"):
        _check_asset_field_len("10.0.0.1", value)


def test_len_check_rejects_overlong_identifier():
    with pytest.raises(ValueError, match="identifier"):
        _check_asset_field_len("x" * 256, "10.0.0.1")


# ============================================================================
# _apply_template_to_asset（导入/新增/编辑 共用的字段分发入口）
# ============================================================================

def test_template_dispatch_rejects_dirty_cidr_field():
    tpl = _net_tpl()
    with pytest.raises(ValueError, match="网段"):
        _apply_template_to_asset(tpl, {"网段": "172.46.9.1-17.46.9.62", "名称": "政务内网"})


def test_template_dispatch_rejects_giant_cidr_field():
    tpl = _net_tpl()
    with pytest.raises(ValueError, match="掩码"):
        _apply_template_to_asset(
            tpl,
            {"网段": "143.146.72.128/25,143.146.79.0/2", "名称": "工作网网段"},
        )


def test_template_dispatch_rejects_dirty_ip_extra_field():
    tpl = _net_tpl()
    with pytest.raises(ValueError, match="EIP"):
        _apply_template_to_asset(
            tpl,
            {"网段": "192.0.2.0/24", "名称": "测试", "EIP": "10.0.2.1-1.0.2.254"},
        )


def test_template_dispatch_accepts_valid_and_maps():
    tpl = _net_tpl()
    std, extra, identifier, id_type = _apply_template_to_asset(
        tpl, {"网段": "172.46.9.1-172.46.9.62", "名称": "政务内网"}
    )
    assert identifier == "172.46.9.1-172.46.9.62"
    assert id_type == "cidr"
    assert std["ip"] == "172.46.9.1-172.46.9.62"
    assert std["name"] == "政务内网"


def test_template_dispatch_allows_text_in_typed_field():
    # ip 类型字段中的非 IP 文本（主机名/待定）放行，不误伤正常录入
    tpl = _net_tpl()
    std, extra, identifier, id_type = _apply_template_to_asset(
        tpl, {"网段": "192.0.2.0/24", "名称": "测试", "EIP": "待分配"}
    )
    assert extra["EIP"] == "待分配"


def test_template_dispatch_rejects_incomplete_ip_identifier():
    # ip 类型标识字段：残缺 IP 拦截
    tpl = _net_tpl(
        identifier_field="EIP",
        fields=[
            {"key": "EIP", "label": "EIP", "type": "ip", "mapped_to": "standard:ip"},
            {"key": "名称", "label": "名称", "type": "text", "mapped_to": "standard:name"},
        ],
    )
    with pytest.raises(ValueError, match="EIP"):
        _apply_template_to_asset(tpl, {"EIP": "10.1", "名称": "测试"})
