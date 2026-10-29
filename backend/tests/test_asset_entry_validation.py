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
)
from app.core.asset_ip_index import _validate_asset_ip_fields
from app.core.ip_validation import (
    IPValidationError,
    looks_like_ip_key,
    validate_ban_target,
    validate_cidr_list,
    validate_extra_ip_fields,
    validate_ip_expression,
    validate_listen_bind,
    validate_single_ip,
)
from app.models.asset import Asset, AssetTypeTemplate


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
# 表达式校验（app.core.ip_validation.validate_ip_expression）
# ============================================================================

@pytest.mark.parametrize("dirty", [
    "172.46.9.1-17.46.9.62",       # 丢 "2" → 倒置跨网段
    "10.0.2.1-1.0.2.254",          # 丢 "1" → 倒置跨网段
    "176.16.173.1-176.13.173.254", # 13↔16 笔误 → 倒置
    "10.0.0.5-10.0.0.1",           # 同 /24 倒置
])
def test_reject_reversed_ranges(dirty):
    with pytest.raises(ValueError, match="起始 IP 大于结束 IP"):
        validate_ip_expression(dirty, "网段")


@pytest.mark.parametrize("dirty", [
    "143.146.79.0/2",   # 截断产物：覆盖 128.0.0.0/2
    "0.0.0.0/7",
    "10.0.0.0/4",
])
def test_reject_giant_cidr(dirty):
    with pytest.raises(ValueError, match="掩码"):
        validate_ip_expression(dirty, "网段")


def test_reject_huge_range():
    with pytest.raises(ValueError, match="跨度过大"):
        validate_ip_expression("1.0.0.1-200.0.0.1", "网段")


@pytest.mark.parametrize("dirty", [
    "10.1",        # 残缺 IP
    "192.168",
    "300.1.1.1",   # 非法段值
    "1.2.3.4.5",
])
def test_reject_incomplete_or_invalid_ip(dirty):
    with pytest.raises(ValueError):
        validate_ip_expression(dirty, "IP地址")


def test_reject_bad_cidr_and_range_endpoints():
    with pytest.raises(ValueError, match="网段"):
        validate_ip_expression("192.0.2.0/abc", "网段")
    with pytest.raises(ValueError, match="结束地址无效"):
        validate_ip_expression("192.0.2.1-xxx", "网段")
    # 嵌 IP 的主机名不是合法 IP 表达式（ip 字段禁止主机名）
    with pytest.raises(ValueError):
        validate_ip_expression("node-192.0.2.10", "IP地址")


def test_reject_each_bad_segment_in_multi_value():
    # 多值中任一段非法 → 整体报错
    with pytest.raises(ValueError, match="第3段"):
        validate_ip_expression("192.0.2.0/24,10.0.0.1,172.46.9.1-17.46.9.62", "网段")


@pytest.mark.parametrize("ok", [
    "192.0.2.10",                          # 单 IP
    "10.0.0.0/8",                          # 合法大网段下限
    "198.51.100.0/24",
    "192.0.2.1-192.0.2.100",               # 完整范围
    "192.0.2.1-100",                       # 短格式范围
    "10.0.0.1-10.0.0.100",                 # 范围
    "10.0.0.*",                            # 末段通配
    "10.0.*.*",                            # 末两段通配
    "10.*.*.*",                            # 末三段通配
    "143.146.72.128/25,143.146.79.0/24",   # 多 CIDR
    "10.0.0.1,10.0.0.2;10.0.0.3",          # 多值分隔符
    "10.0.0.1、10.0.0.2，10.0.0.3",          # 中文分隔符
    "10.0.0.0/24 192.0.2.1-10",            # 混合多值
    "fe80::1",                             # IPv6 单值放行
    "2001:DB8::1",                         # IPv6 大写放行
    "fe80::/64",                           # IPv6 网段放行
    "2001:db8::1-2001:db8::ff",            # IPv6 范围放行
    "240e::/96,fe80::1",                   # IPv6 多值放行
])
def test_accept_valid_values(ok):
    validate_ip_expression(ok, "网段")  # 不抛异常


@pytest.mark.parametrize("dirty", [
    "web-01",
    "web-01.example.com",
    "财务服务器",
    "待定",
    "N/A",
    "n/a",
    "123办公室",
    "2024",
    "10",
    "1.2.3.4:22",           # 带端口
    "1.2.3.4/24 # 备注",     # 带注释
    "fe80::1%eth0",         # 带 zone id
    "*.*.*.*",              # 通配覆盖全部四段
    "10.0.*.5",             # 中间段通配
])
def test_reject_hostname_text_and_bad_wildcard(dirty):
    with pytest.raises(ValueError):
        validate_ip_expression(dirty, "IP地址")


def test_reject_leading_zero_octet():
    with pytest.raises(ValueError):
        validate_ip_expression("010.0.0.1", "IP地址")


def test_allow_space_separated_multi_value():
    # 空白分隔多值：与检索层 _split_tokens 语义一致，逐段校验
    validate_ip_expression("10.0.0.1 10.0.0.2", "IP地址")
    with pytest.raises(ValueError, match="第2段"):
        validate_ip_expression("10.0.0.1 300.1.1.1", "IP地址")
    # 文本不再被当作合法段放行
    with pytest.raises(ValueError, match="第2段"):
        validate_ip_expression("10.0.0.1、财务服务器", "IP地址")


def test_reject_bare_shorthand_and_slash_text():
    # "数字-数字"/"数字/数字" 视为残缺 IP 表达式（缺基础 IP）→ 拦截
    with pytest.raises(ValueError, match="起始地址无效"):
        validate_ip_expression("1-100", "IP地址")
    with pytest.raises(ValueError, match="网段"):
        validate_ip_expression("24/7服务", "IP地址")


def test_empty_and_none_pass():
    validate_ip_expression("", "ip")
    validate_ip_expression(None, "ip")


# ============================================================================
# _check_asset_field_len（禁止静默截断）
# ============================================================================

def test_len_check_accepts_129_char_multi_cidr():
    # 历史案例值（129 字符）：ip 列扩为 varchar(256) 后可完整存储，
    # 此前列宽 128 会把它截断成 128 字符、末段 /24 变 /2 产生脏数据
    value = "143.146.72.128/25,143.146.73.0/24,143.146.74.0/24,143.146.75.0/24,143.146.76.0/24,143.146.77.0/24,143.146.78.0/24,143.146.79.0/24"
    assert len(value) == 129
    _check_asset_field_len("143.146.72.128/25", value)


def test_len_check_accepts_800_char_multi_ip_list():
    # ip 列扩为 varchar(2048) 后，实测 800+ 字符的多 IP 列表可完整存储
    # （导入"A会保持在线系统资产"场景：单条多 IP 合并列表约 800 字符）
    value = ",".join(f"10.0.{i // 256}.{i % 256}" for i in range(80))
    assert 700 < len(value) < 2048
    _check_asset_field_len("10.0.0.0", value)


def test_len_check_rejects_overlong_ip():
    # 超过 2048 的多 IP 列表仍被拦截（报错而非截断，提示拆分导入）
    value = ",".join(f"10.0.{i // 256}.{i % 256}" for i in range(220))
    assert len(value) > 2048
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


def test_template_dispatch_rejects_text_in_typed_field():
    # ip 类型字段中的非 IP 文本（待定/N/A/主机名）一律拒绝，避免脏数据入库
    tpl = _net_tpl()
    with pytest.raises(ValueError, match="EIP"):
        _apply_template_to_asset(
            tpl, {"网段": "192.0.2.0/24", "名称": "测试", "EIP": "待分配"}
        )


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


# ============================================================================
# 场景化校验：单 IP / CIDR 列表 / 封禁目标 / 监听地址 / 扩展字段
# ============================================================================

def test_validate_single_ip_rules():
    assert validate_single_ip(" 10.0.0.1 ") == "10.0.0.1"
    assert validate_single_ip("2001:DB8::1") == "2001:db8::1"
    assert validate_single_ip("", allow_empty=True) == ""
    with pytest.raises(IPValidationError):
        validate_single_ip("")
    for bad in ("10.0.0.0/8", "10.0.0.1-10.0.0.9", "10.0.0.*", "10.0.0.1,10.0.0.2"):
        with pytest.raises(IPValidationError):
            validate_single_ip(bad)


def test_validate_cidr_list_rules():
    assert validate_cidr_list("10.0.0.0/8, 192.0.2.1") == "10.0.0.0/8,192.0.2.1"
    with pytest.raises(IPValidationError):
        validate_cidr_list("10.0.0.1-10.0.0.9")
    with pytest.raises(IPValidationError):
        validate_cidr_list("10.0.0.*")


def test_validate_ban_target_rules():
    # 封禁目标允许 CIDR / 范围 / 多值
    assert validate_ban_target("10.0.0.0/8") == "10.0.0.0/8"
    assert validate_ban_target("10.0.0.1-10.0.0.9") == "10.0.0.1-10.0.0.9"
    assert validate_ban_target("1.2.3.4,10.0.0.0/8") == "1.2.3.4,10.0.0.0/8"
    assert validate_ban_target("2001:db8::1") == "2001:db8::1"
    # 通配会误封全网，拒绝
    with pytest.raises(IPValidationError):
        validate_ban_target("10.*.*.*")
    with pytest.raises(IPValidationError):
        validate_ban_target("待定")


def test_validate_listen_bind_rules():
    assert validate_listen_bind("") == ""
    assert validate_listen_bind("0.0.0.0") == "0.0.0.0"
    assert validate_listen_bind("::") == "::"
    with pytest.raises(IPValidationError):
        validate_listen_bind("0.0.0.0/0")


def test_validate_ip_expression_normalizes():
    # IPv6 小写 + 多值统一英文逗号
    assert _normalize("2001:DB8::1、fe80::/64") == "2001:db8::1,fe80::/64"


def _normalize(value):
    from app.core.ip_validation import validate_ip_expression

    return validate_ip_expression(value)


def test_looks_like_ip_key():
    assert looks_like_ip_key("ip")
    assert looks_like_ip_key("src_ip")
    assert looks_like_ip_key("dst_ip")
    assert looks_like_ip_key("public_ip")
    assert looks_like_ip_key("EIP")
    assert looks_like_ip_key("cidr")
    assert looks_like_ip_key("ipv6")
    assert not looks_like_ip_key("description")
    assert not looks_like_ip_key("name")
    assert not looks_like_ip_key("")


def test_validate_extra_ip_fields():
    extra = {"src_ip": " 10.0.0.1 ", "note": "待定", "dst_ip": "2001:DB8::1"}
    out = validate_extra_ip_fields(extra)
    # IP 类值归一化，非 IP 字段原样保留（哪怕内容是文本）
    assert out["src_ip"] == "10.0.0.1"
    assert out["dst_ip"] == "2001:db8::1"
    assert out["note"] == "待定"
    with pytest.raises(IPValidationError):
        validate_extra_ip_fields({"src_ip": "待定"})
    with pytest.raises(IPValidationError):
        validate_extra_ip_fields({"host_ip": "node-192.0.2.10"})
    # 非 dict 直接原样返回，不抛异常
    assert validate_extra_ip_fields(None) is None


# ============================================================================
# ORM 事件硬拦截（智能体工具直接写库的最后防线）
# ============================================================================

def test_orm_guard_rejects_invalid_ip_on_insert():
    asset = Asset(agent_id=0, identifier="x", ip="待定")
    with pytest.raises(ValueError, match="IP"):
        _validate_asset_ip_fields(asset, is_insert=True)


def test_orm_guard_rejects_invalid_extra_on_insert():
    asset = Asset(agent_id=0, identifier="x", ip="10.0.0.1", extra_fields={"wan_ip": "N/A"})
    with pytest.raises(ValueError, match="wan_ip"):
        _validate_asset_ip_fields(asset, is_insert=True)


def test_orm_guard_normalizes_and_ignores_non_ip_fields():
    asset = Asset(
        agent_id=0,
        identifier="x",
        ip=" 2001:DB8::1 ",
        extra_fields={"src_ip": "10.0.0.1", "note": "待定"},
    )
    _validate_asset_ip_fields(asset, is_insert=True)
    assert asset.ip == "2001:db8::1"
    assert asset.extra_fields == {"src_ip": "10.0.0.1", "note": "待定"}


def test_orm_guard_validates_ip_typed_identifier():
    """identifier_type=ip/cidr 时标识列也按 IP 校验（老工具代码绕过 API 的兜底）。"""
    asset = Asset(
        agent_id=0, identifier="待定", identifier_type="ip", ip="10.0.0.1",
    )
    with pytest.raises(ValueError, match="标识"):
        _validate_asset_ip_fields(asset, is_insert=True)


def test_orm_guard_allows_custom_identifier():
    """identifier_type=custom（主机名等）不应被当成 IP 拒绝。"""
    asset = Asset(
        agent_id=0, identifier="web-01", identifier_type="custom", ip="10.0.0.1",
    )
    _validate_asset_ip_fields(asset, is_insert=True)
    assert asset.identifier == "web-01"


# ============================================================================
# 边界：仅分隔符输入（曾静默当空值放过）、key 识别覆盖
# ============================================================================

@pytest.mark.parametrize("bad", [",", "；", " , ; 、 ", "，"])
def test_separator_only_input_rejected(bad):
    """仅由分隔符组成的输入不是"空值"，必须报错（前后端规则一致）。"""
    with pytest.raises(IPValidationError):
        validate_ip_expression(bad)
    with pytest.raises(IPValidationError):
        validate_single_ip(bad)
    with pytest.raises(IPValidationError):
        validate_ban_target(bad)


def test_looks_like_ip_key_address_variants():
    # ip_address / ipv4_addr / src_ip_addr 等常见命名要能识别
    for key in (
        "ip_address", "ip_addresses", "ip_addr", "ip_addrs",
        "ipv4_address", "ipv6_addr", "src_ip_address", "public_ip_addr",
    ):
        assert looks_like_ip_key(key), key
    # 裸地址词不能被误判为 IP 字段
    for key in ("address", "email_address", "mac_address", "note"):
        assert not looks_like_ip_key(key), key


def test_validate_extra_ip_fields_address_key():
    out = validate_extra_ip_fields({"ip_address": " 2001:DB8::1 "})
    assert out["ip_address"] == "2001:db8::1"
    with pytest.raises(IPValidationError):
        validate_extra_ip_fields({"ip_address": "待定"})


def test_banned_ip_compare_key_normalizes_case_and_space():
    """封禁记录查重键：兼容历史未归一化写法（大小写/首尾空格）。"""
    from app.api.v1.banned_ips import _ip_compare_key

    assert _ip_compare_key("  2001:DB8::1 ") == "2001:db8::1"
    assert _ip_compare_key("10.0.0.1") == _ip_compare_key(" 10.0.0.1 ")
    assert _ip_compare_key(None) == ""

