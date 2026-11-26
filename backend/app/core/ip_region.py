"""IP 归属地区查询（IP 地址库点查）。

封禁台账 ``ban_records.region`` 要求归属地区非空：手动封禁由用户填写或自动
识别，其余封禁来源（工单同步 / 工作流 / 导入）在未提供时统一用
:func:`resolve_ban_region` 兜底，无法识别（IPv6 / 网段 / 域名 / 地址库无命中）
落为「未知」。
"""
import ipaddress
import logging

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# 未知地区兜底值（台账要求 region 非空）
UNKNOWN_REGION = "未知"

# 点查结果按库优先级选取归属信息：国内运营商地理库最精确，其次注册持有者库；
# 港澳/境外库各自覆盖对应网段；云服务库只覆盖国内云网段，作为「中国」兜底。
_REGION_LIBRARY_PRIORITY = ("geo_cn", "holder_cn", "hk_mo", "overseas", "cloud_cn")
# 归属地区落库长度上限：ban_records.region 为 64，legacy banned_ips.region 为 50，
# 统一截断到 50 保证两侧都能写入
_REGION_MAX_LEN = 50

# ISO 3166-1 alpha-2 国家代码 → 中文国家名（Babel/CLDR，首次使用时加载）
_ZH_COUNTRY_NAMES: dict[str, str] | None = None


def _country_name_zh(code) -> str:
    """把国家代码转换成中文国家名；无映射返回空串。"""
    global _ZH_COUNTRY_NAMES
    if _ZH_COUNTRY_NAMES is None:
        try:
            from babel import Locale

            _ZH_COUNTRY_NAMES = {
                str(key).upper(): str(name)
                for key, name in Locale("zh").territories.items()
                if len(str(key)) == 2
            }
        except Exception:  # noqa: BLE001
            _ZH_COUNTRY_NAMES = {}
            logger.warning("Babel 中文国家名映射不可用，境外归属地区将保留英文", exc_info=True)
    return _ZH_COUNTRY_NAMES.get(str(code or "").strip().upper(), "")


def _compose_region_text(match: dict) -> str:
    """把一条 IP 地址库命中记录拼成「国家 省 市」文本（去重、截断）。"""
    library_type = match.get("library_type")
    if library_type == "overseas":
        # 境外库的国家/省州/城市均为英文，且省州/城市没有权威中文映射：
        # 归属地区只取中文国家名，避免「美国 New Jersey ...」中英混排
        zh_name = _country_name_zh(
            match.get("geo_country_code") or match.get("rir_country")
        )
        if zh_name:
            return zh_name[:_REGION_MAX_LEN]
        return str(match.get("country_geo") or "").strip()[:_REGION_MAX_LEN]

    parts: list[str] = []

    def add(value) -> None:
        text = str(value or "").strip()
        if not text:
            return
        for idx, part in enumerate(parts):
            if text == part or text in part:
                # 完全相同，或新值已被更完整的已有值包含（省=市 / 香港 vs 中国香港）
                return
            if part in text:
                # 已有值是新值的一部分：用更具体的新值替换（如 中国 → 中国香港）
                parts[idx] = text
                return
        parts.append(text)

    if library_type in ("geo_cn", "cloud_cn"):
        # 这两个库只收录中国大陆网段且不含国家字段，补「中国」前缀
        add("中国")
    add(match.get("country_geo"))
    add(match.get("province"))
    add(match.get("city"))
    return " ".join(parts)[:_REGION_MAX_LEN]


def lookup_ip_region(db: Session, ip: str) -> tuple[str, str]:
    """查询单个 IPv4 的归属地区。

    Returns:
        ``(归属地区文本, 命中的库中文名)``；非 IPv4 / 地址库无命中 / 查询异常
        返回 ``("", "")``，调用方按无归属地区处理，不影响封禁主流程。
    """
    try:
        addr = ipaddress.IPv4Address(str(ip or "").strip())
    except ValueError:
        return "", ""
    try:
        # 复用 IP 地址库的跨库点查（GiST ip_range @>，毫秒级）
        from app.api.v1.ip_library import _lookup_matches

        matches = _lookup_matches(db, int(addr))
    except Exception:  # noqa: BLE001
        logger.warning("IP 地址库归属地区查询失败 ip=%s", ip, exc_info=True)
        return "", ""
    by_type = {
        m.get("library_type"): m
        for m in matches
        if isinstance(m, dict) and m.get("library_type")
    }
    for library_type in _REGION_LIBRARY_PRIORITY:
        match = by_type.get(library_type)
        if not match:
            continue
        text = _compose_region_text(match)
        if text:
            return text, str(match.get("library_label") or "")
    return "", ""


def resolve_ban_region(db: Session, ip: str) -> str:
    """解析封禁目标的归属地区，无法识别时兜底「未知」（保证落库非空）。"""
    region, _ = lookup_ip_region(db, ip)
    return region or UNKNOWN_REGION
