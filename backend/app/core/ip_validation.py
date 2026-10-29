"""IP / CIDR / 范围 / 通配 统一校验与解析。

产品决策（全系统统一口径）：
- 支持 IPv4 与 IPv6 单地址
- 支持 CIDR（IPv4 前缀下限 /8，IPv6 不限）
- 支持 IPv4 范围：完整 ``a.b.c.d-e.f.g.h`` 或末段简写 ``a.b.c.1-100``；
  跨度上限 2^24 个地址（IPv4 约一个 /8；IPv6 范围沿用同一上限，防止误填
  整段地址空间）；倒置范围直接拒绝
- 支持 IPv4 末段通配：``10.0.0.*`` / ``10.0.*.*`` / ``10.*.*.*``；
  拒绝 ``*.*.*.*`` 与中间段通配（``10.0.*.5``）
- 支持多值：逗号 / 分号 / 顿号 / 空白分隔
- 严格拒绝主机名、``待定``、``N/A``、端口、注释、前导零等文本

本模块是后端唯一实现，资产 / 告警规则 / 工单 / 封禁 / 设备动作 /
日志接收器 / 系统配置等入口统一调用；前端对应实现见
``frontend/src/utils/ipValidation.js``（规则保持一致）。
"""
from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass

# IPv4 CIDR 最小前缀长度：/8（如 10.0.0.0/8）为合法大网段下限，/2~/7 视为笔误
IPV4_CIDR_MIN_PREFIX = 8
# IP 范围最大跨度：2^24 = 16777216 个地址（IPv4 约一个 /8）；超过视为录入错误。
# IPv6 范围沿用同一上限（IPv6 一个 /64 远超该值，无业务意义的大范围多为笔误）。
IPV4_RANGE_MAX_ADDRS = 2 ** 24
# 表达式最大长度（assets.ip 列宽 2048）
MAX_EXPRESSION_LEN = 2048

# 多值分隔符：与检索层 _split_tokens / 导入解析保持完全一致
_SEPARATOR_RE = re.compile(r"[,;，；、\s]+")
_OCTET_RE = re.compile(r"^(?:0|[1-9]\d{0,2})$")


class IPValidationError(ValueError):
    """IP 表达式校验失败；消息可直接展示给用户。"""


@dataclass(frozen=True)
class IPInterval:
    """一个 IP 区间（闭区间）及其版本/类型。

    - ``version``: 4 或 6
    - ``start`` / ``end``: 地址整数（IPv4 无符号 32 位，IPv6 无符号 128 位）
    - ``kind``: single / cidr / range / wildcard
    - ``text``: 归一化后的原始片段文本
    """

    version: int
    start: int
    end: int
    kind: str
    text: str


def _label(field_label: str) -> str:
    return f"字段'{field_label}'" if field_label else "IP 字段"


def split_ip_expression(value) -> list[str]:
    """把多值表达式拆成片段（保留顺序，丢弃空段）。"""
    s = "" if value is None else str(value).strip()
    if not s:
        return []
    return [p.strip() for p in _SEPARATOR_RE.split(s) if p.strip()]


def _wildcard_interval(token: str) -> IPInterval:
    """解析 IPv4 末段通配（``10.0.0.*`` 等），非法抛 ValueError。"""
    parts = token.split(".")
    if len(parts) != 4:
        raise ValueError("通配格式需为四段，如 10.0.0.*")
    values: list[int] = []
    stars = 0
    met_star = False
    for part in parts:
        if part == "*":
            stars += 1
            met_star = True
            continue
        if met_star:
            # 星号后面不能再出现数字段（10.0.*.5 / 10.*.0.*）
            raise ValueError("通配符只能出现在末尾连续段（如 10.0.*.*）")
        if not _OCTET_RE.match(part):
            raise ValueError("通配前必须是合法 IPv4 段（0-255，无前导零）")
        values.append(int(part))
    if stars == 0:
        raise ValueError("不是通配格式")
    if stars > 3 or not values:
        # *.*.*.* 覆盖整个地址空间，视为误输入
        raise ValueError("通配不能覆盖全部四段（*.*.*.*），至少保留一段固定前缀")
    start = 0
    end = 0
    for i in range(4):
        if i < len(values):
            start = (start << 8) | values[i]
            end = (end << 8) | values[i]
        else:
            start = start << 8
            end = (end << 8) | 255
    return IPInterval(4, start, end, "wildcard", token)


def _normalize_ipv6_text(token: str) -> str:
    """IPv6 归一化：小写 + 压缩前导零（不改变语义）。"""
    return token.lower()


def parse_ip_token(
    token: str,
    *,
    allow_cidr: bool = True,
    allow_range: bool = True,
    allow_wildcard: bool = True,
    where: str = "",
) -> IPInterval:
    """解析单个 IP/CIDR/范围/通配片段。

    Raises:
        ValueError: 格式非法（消息不含字段前缀，由调用方包装）
    """
    elem = (token or "").strip()
    if not elem:
        raise ValueError("为空")
    prefix = f"{where} " if where else ""
    # 拒绝 IPv6 zone id（fe80::1%eth0）等非标准写法
    if "%" in elem:
        raise ValueError(f"{prefix}不支持带 zone id 的地址")

    # 1. 通配（仅 IPv4，星号只允许末尾连续段）
    if "*" in elem:
        if not allow_wildcard:
            raise ValueError(f"{prefix}不支持通配符")
        try:
            return _wildcard_interval(elem)
        except ValueError as exc:
            raise ValueError(f"{prefix}通配格式不合法：{exc}")

    # 2. CIDR
    if "/" in elem:
        if not allow_cidr:
            raise ValueError(f"{prefix}不支持 CIDR 网段")
        try:
            net = ipaddress.ip_network(elem, strict=False)
        except ValueError:
            raise ValueError(f"{prefix}不是合法的网段（CIDR）格式")
        if net.version == 4 and net.prefixlen < IPV4_CIDR_MIN_PREFIX:
            raise ValueError(
                f"{prefix}掩码 /{net.prefixlen} 过小（覆盖 {net.num_addresses:,} 个地址），"
                f"疑似笔误；IPv4 网段前缀不得小于 /{IPV4_CIDR_MIN_PREFIX}"
            )
        text = str(net) if net.version == 6 else elem
        return IPInterval(
            net.version,
            int(net.network_address),
            int(net.broadcast_address),
            "cidr",
            text,
        )

    # 3. 范围
    if "-" in elem:
        if not allow_range:
            raise ValueError(f"{prefix}不支持 IP 范围")
        if elem.count("-") != 1:
            raise ValueError(f"{prefix}范围格式不合法（应为 起始IP-结束IP）")
        start_str, end_str = (p.strip() for p in elem.split("-", 1))
        if not start_str or not end_str:
            raise ValueError(f"{prefix}范围缺少起始或结束地址")
        is_v6 = ":" in elem
        try:
            start_ip = (
                ipaddress.IPv6Address(start_str)
                if is_v6
                else ipaddress.IPv4Address(start_str)
            )
        except ValueError:
            raise ValueError(
                f"{prefix}范围起始地址无效：'{start_str}'（需完整 "
                f"{'IPv6' if is_v6 else 'IPv4'}）"
            )
        try:
            if is_v6:
                end_ip = ipaddress.IPv6Address(end_str)
            elif end_str.isdigit():
                # 末段简写：同前缀末段（192.0.2.1-100）
                if int(end_str) > 255:
                    raise ValueError
                end_ip = ipaddress.IPv4Address(
                    f"{start_str.rsplit('.', 1)[0]}.{int(end_str)}"
                )
            else:
                end_ip = ipaddress.IPv4Address(end_str)
        except ValueError:
            raise ValueError(
                f"{prefix}范围结束地址无效：'{end_str}'（需完整 "
                f"{'IPv6' if is_v6 else 'IPv4'} 或末段数字）"
            )
        s_int, e_int = int(start_ip), int(end_ip)
        if s_int > e_int:
            raise ValueError(
                f"{prefix}起始 IP 大于结束 IP（倒置范围，疑似丢字/笔误），"
                f"请修正为 {end_ip}-{start_ip}"
            )
        span = e_int - s_int + 1
        if span > IPV4_RANGE_MAX_ADDRS:
            raise ValueError(
                f"{prefix}范围跨度过大（{span:,} 个地址，超过上限 "
                f"{IPV4_RANGE_MAX_ADDRS:,} 个），疑似笔误"
            )
        return IPInterval(
            start_ip.version,
            s_int,
            e_int,
            "range",
            f"{start_ip}-{end_ip}" if is_v6 else elem,
        )

    # 4. 单地址
    try:
        ip = ipaddress.ip_address(elem)
    except ValueError:
        raise ValueError(
            f"{prefix}不是合法的 IP 地址（支持 IPv4/IPv6/CIDR/范围/通配，"
            "不支持主机名、待定、N/A 等文本）"
        )
    text = _normalize_ipv6_text(elem) if ip.version == 6 else elem
    return IPInterval(ip.version, int(ip), int(ip), "single", text)


def parse_ip_expression(
    value,
    *,
    field_label: str = "",
    allow_cidr: bool = True,
    allow_range: bool = True,
    allow_wildcard: bool = True,
    max_len: int = MAX_EXPRESSION_LEN,
) -> list[IPInterval]:
    """解析多值 IP 表达式为区间列表（严格模式，任一段非法即报错）。"""
    label = _label(field_label)
    s = "" if value is None else str(value).strip()
    if not s:
        return []
    if len(s) > max_len:
        raise IPValidationError(
            f"{label}过长（{len(s)} > {max_len} 字符），请拆分后重试"
        )
    tokens = split_ip_expression(s)
    if not tokens:
        # 仅由分隔符组成（如 "," / "；"）不是空值，属于误输入
        raise IPValidationError(
            f"{label}不是合法的 IP 表达式（请输入 IP / CIDR / 范围）"
        )
    intervals: list[IPInterval] = []
    for i, elem in enumerate(tokens):
        where = f"{label}第{i + 1}段 '{elem}'"
        try:
            intervals.append(
                parse_ip_token(
                    elem,
                    allow_cidr=allow_cidr,
                    allow_range=allow_range,
                    allow_wildcard=allow_wildcard,
                    where=where,
                )
            )
        except ValueError as exc:
            raise IPValidationError(str(exc))
    return intervals


def validate_ip_expression(
    value,
    field_label: str = "",
    *,
    allow_cidr: bool = True,
    allow_range: bool = True,
    allow_wildcard: bool = True,
    allow_multi: bool = True,
    max_len: int = MAX_EXPRESSION_LEN,
) -> str:
    """校验并归一化 IP 表达式（单 IP/CIDR/范围/通配/多值）。

    Returns:
        归一化字符串（IPv6 小写、多值用英文逗号连接）；空输入返回 ""。

    Raises:
        IPValidationError: 校验失败，消息可直接展示给用户
    """
    s = "" if value is None else str(value).strip()
    if not s:
        return ""
    intervals = parse_ip_expression(
        s,
        field_label=field_label,
        allow_cidr=allow_cidr,
        allow_range=allow_range,
        allow_wildcard=allow_wildcard,
        max_len=max_len,
    )
    if not allow_multi and len(intervals) > 1:
        raise IPValidationError(f"{_label(field_label)}只允许填写一个地址")
    return ",".join(iv.text for iv in intervals)


def validate_single_ip(
    value,
    field_label: str = "",
    *,
    allow_empty: bool = False,
) -> str:
    """校验单个 IP 地址（IPv4/IPv6），拒绝 CIDR/范围/通配/多值/文本。"""
    s = "" if value is None else str(value).strip()
    if not s:
        if allow_empty:
            return ""
        raise IPValidationError(f"{_label(field_label)}不能为空")
    intervals = parse_ip_expression(
        s,
        field_label=field_label,
        allow_cidr=False,
        allow_range=False,
        allow_wildcard=False,
    )
    if len(intervals) > 1:
        raise IPValidationError(f"{_label(field_label)}只允许填写一个 IP 地址")
    if not intervals:  # 防御：理论不可达（空值已在上面提前返回）
        raise IPValidationError(f"{_label(field_label)}不是合法的 IP 地址")
    return intervals[0].text


def validate_listen_bind(value, field_label: str = "监听地址") -> str:
    """校验日志接收器监听地址：空 / 单 IPv4 / 单 IPv6（含 0.0.0.0、::）。"""
    return validate_single_ip(value, field_label, allow_empty=True)


def validate_cidr_list(value, field_label: str = "") -> str:
    """校验 IP/CIDR 列表（用于告警 ``in_cidr``）；不允许范围与通配。"""
    return validate_ip_expression(
        value,
        field_label,
        allow_cidr=True,
        allow_range=False,
        allow_wildcard=False,
    )


def validate_ban_target(value, field_label: str = "封禁目标") -> str:
    """校验封禁目标：单 IP / CIDR / 范围 / 多值；不允许通配（避免误封全网）。"""
    return validate_ip_expression(
        value,
        field_label,
        allow_cidr=True,
        allow_range=True,
        allow_wildcard=False,
    )


# 字段 key 形如 ip / src_ip / dst_ip / eip / cidr / ipv4 / ipv6 等视为 IP 字段；
# 只做整词匹配，避免 ``description``（含 "ip" 子串）被误判。
_IP_LIKE_KEY_RE = re.compile(
    r"^(?:[a-z0-9]+_)*(?:ip|ips|cidr|cidrs|eip|eips|ipaddr|ipaddress|ipv4|ipv6)$"
)
# 「IP 词 + 地址词」组合：ip_address / ipv4_addr / src_ip_addr 等；要求地址词前
# 必须有 IP 词，避免把裸 ``address``（如 email_address）当成 IP 字段
_IP_ADDR_KEY_RE = re.compile(
    r"^(?:[a-z0-9]+_)*(?:ip|ips|ipv4|ipv6|eip|eips)_(?:addr|addrs|address|addresses)$"
)
_IP_LIKE_KEY_SUFFIX_RE = re.compile(r"(?:^|_)(?:ip|ips|cidr|cidrs|eip|eips)$")


def looks_like_ip_key(key) -> bool:
    """字段 key 是否像 IP 字段（用于无模板/模板外字段的兜底校验）。

    >>> looks_like_ip_key("src_ip"), looks_like_ip_key("description")
    (True, False)
    """
    k = re.sub(r"[^a-z0-9_]", "", str(key or "").lower())
    if not k:
        return False
    if _IP_LIKE_KEY_RE.match(k) or _IP_ADDR_KEY_RE.match(k):
        return True
    return bool(_IP_LIKE_KEY_SUFFIX_RE.search(k))


def validate_extra_ip_fields(extra) -> dict:
    """校验并归一化 extra_fields 中 IP 类 key 的值。

    无模板资产 / 智能体工具写入的扩展字段没有字段定义，只能按 key 猜测类型；
    命中 IP 类 key 且值为字符串时按统一规则校验。

    Args:
        extra: 扩展字段字典（非 dict 直接忽略）

    Returns:
        归一化后的新字典（私有字段值替换为规范写法）；输入非 dict 时原样返回

    Raises:
        IPValidationError: 任一 IP 类值非法
    """
    if not isinstance(extra, dict):
        return extra
    normalized: dict = {}
    for key, val in extra.items():
        if isinstance(val, str) and val.strip() and looks_like_ip_key(key):
            val = validate_ip_expression(val, key)
        normalized[key] = val
    return normalized
