"""③ Enricher 阶段：富化器插件（默认清单为空，空转保证行为等价）。

富化器协议：``enrich(norm: NormalizedEvent, db) -> None``，按
``enricher_registry`` 注册；本阶段把结果写入 ``norm.enrichments``
（不覆盖解析产出的原字段，落库时并入 extensions 由 Normalizer 决定）。

内置富化器：
- AssetEnricher（默认不启用）：按 src_ip/host_ip 关联 devices 表，
  补 asset_id 与内网标注到 enrichments。
- AssetLibEnricher（默认启用）：按 host→src→dst IP 匹配 assets 资产库
  （支持单 IP 精确 + CIDR/范围包含），命中后将关联资产写入
  relate_asset_id / relate_asset_name / relate_asset_ip 列落库。
"""
import ipaddress
import json
import logging
import re
import threading
import time

from ..registry import _BaseRegistry, stage_registry
from .base_stage import BaseStage, PipelineData

logger = logging.getLogger(__name__)


class EnricherRegistry(_BaseRegistry):
    """富化器注册表（键 = name 属性）。"""

    def __init__(self) -> None:
        super().__init__("enricher")

    def _key_of(self, cls) -> str:
        return getattr(cls, "name", "") or getattr(cls, "__name__", "")


enricher_registry = EnricherRegistry()


class AssetEnricher:
    """资产关联富化：按事件 src_ip / host_ip 匹配 devices 表。

    命中时在 norm.enrichments["asset"] 记录 {asset_id, device_name, ip_field}，
    并在 asset_id 为空时补填 asset_id（仅补空，不覆盖）。
    """

    name = "asset"

    def enrich(self, norm, db) -> None:  # pragma: no cover - 依赖 DB，容器内验证
        try:
            ips = []
            for key in ("src_ip", "host_ip"):
                val = norm.get_field(key)
                if not val:
                    continue
                if isinstance(val, str):
                    try:
                        parsed = json.loads(val)
                        if isinstance(parsed, list):
                            ips.extend(str(x) for x in parsed if x)
                            continue
                    except (ValueError, TypeError):
                        pass
                ips.append(str(val))
            if not ips:
                return
            from sqlalchemy import text as sa_text

            for ip in ips[:3]:  # 最多探测前 3 个 IP，避免大数组拖慢
                row = db.execute(
                    sa_text("SELECT id, device_name FROM devices WHERE ip_address = :ip LIMIT 1"),
                    {"ip": ip},
                ).first()
                if row:
                    norm.enrichments.setdefault("asset", {
                        "asset_id": row[0],
                        "device_name": row[1],
                        "ip_field": ip,
                    })
                    if norm.get_field("asset_id") in (None, ""):
                        norm.set_field("asset_id", str(row[0]))
                    return
        except Exception:  # noqa: BLE001
            logger.exception("资产富化异常（忽略）")


# ===== 资产库索引（内存缓存，AssetLibEnricher 使用） =====
_ASSET_INDEX_TTL_S = 600  # 10 分钟；资产写接口通过 invalidate_asset_index 主动失效
_asset_index_lock = threading.Lock()
_asset_index_cache: dict = {"built_at": 0.0, "single": {}, "nets": []}


def invalidate_asset_index() -> None:
    """资产数据变更后主动失效索引缓存（下次匹配时重建）。"""
    with _asset_index_lock:
        _asset_index_cache["built_at"] = 0.0


# 多值分隔符：与导入校验 ip_validation.split_ip_expression、检索层 _value_to_intervals 一致
_IP_SPLIT_RE = re.compile(r"[,;，；、\s]+")


def _parse_ip_list(raw: str):
    """资产 ip 字段（IP / CIDR / 起止范围 / 多值）→ 可匹配条目列表。

    分隔符与导入校验 ``ip_validation.split_ip_expression``、检索层
    ``tool_builders._value_to_intervals`` 对齐（逗号/分号/顿号/换行/空白）：
    Excel 单元格内换行的多 IP（如 ``202.104.131.26\\n120.234.15.170``）
    曾因只按逗号拆分而整串解析失败，资产不进索引 → 工单安全上下文与告警
    富化均匹配不到。范围支持末段简写（``61.144.224.185-187``）与倒置防御。
    """
    text = str(raw or "").strip()
    if not text:
        return []
    # 整串先按单段解析（"a.b.c.d - a.b.c.e" 带空格的范围不会被空白拆散）
    whole = _parse_ip_part(text)
    if whole is not None:
        return [whole]
    out = []
    for part in _IP_SPLIT_RE.split(text):
        if not part:
            continue
        entry = _parse_ip_part(part)
        if entry is not None:
            out.append(entry)
    return out


def _parse_single_ip(value: str):
    """解析单个 IP（IPv4/IPv6），失败返回 None。"""
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _complete_ip(value: str):
    """对残缺 IPv4 补 .0 后解析（如 ``198.51.100``），保持数据质量兜底。"""
    octets = (value or "").split(".")
    if not value or len(octets) > 4:
        return None
    while len(octets) < 4:
        octets.append("0")
    return _parse_single_ip(".".join(octets))


def _parse_ip_range(part: str):
    """``start-end``（含末段简写）→ (start, end)；非法/脏数据返回 None。

    倒置范围仅同 /24 时视为笔误交换（如 ``61.144.227.220-61.144.227.226``），
    跨网段倒置（如 ``172.46.9.1-17.46.9.62``）视为脏数据丢弃，避免生成
    覆盖大半个地址空间的巨型区间导致任意 IP 误命中（与检索层同口径）。
    """
    start_str, _, end_str = part.partition("-")
    start_str, end_str = start_str.strip(), end_str.strip()
    start = _parse_single_ip(start_str) or _complete_ip(start_str)
    if start is None:
        return None
    # 末段简写：end 无点且为纯数字（如 "187"）→ 替换 start 的最后一段
    octets = str(start).split(".")
    if "." not in end_str and end_str.isdigit():
        last = int(end_str)
        if start.version == 4 and 0 <= last <= 255:
            end = _parse_single_ip(".".join(octets[:3] + [str(last)]))
        else:
            end = _complete_ip(end_str)
    else:
        end = _parse_single_ip(end_str) or _complete_ip(end_str)
    if end is None or start.version != end.version:
        return None
    s, e = int(start), int(end)
    if s <= e:
        return start, end
    if start.version == 4 and (s >> 8) == (e >> 8):
        return end, start
    return None


def _parse_ip_part(part: str):
    """单段 → 索引条目 ``("ip", 文本)`` / ``("net", 网段)`` / ``("range", 起, 止)``。"""
    if "/" in part:
        try:
            return ("net", ipaddress.ip_network(part, strict=False))
        except ValueError:
            return None
    if "-" in part:
        parsed = _parse_ip_range(part)
        return ("range", parsed[0], parsed[1]) if parsed else None
    if _parse_single_ip(part) is None:
        return None
    return ("ip", part)


def _build_asset_index(db) -> None:
    """（重）构建资产索引：单 IP 精确 dict + CIDR/范围列表。"""
    from sqlalchemy import text as sa_text

    single: dict = {}
    nets: list = []
    rows = db.execute(
        sa_text("SELECT id, name, ip FROM assets WHERE ip IS NOT NULL AND ip != ''")
    ).fetchall()
    for aid, name, ip in rows:
        for item in _parse_ip_list(ip or ""):
            if item[0] == "ip":
                single.setdefault(item[1], (aid, name))
            else:
                nets.append((item, aid, name))
    # 网段按网络地址/起始地址排序（IPv4 与 IPv6 不兼容比较，按字符串分组排序）
    nets.sort(key=lambda x: str(x[0][1]))
    _asset_index_cache["single"] = single
    _asset_index_cache["nets"] = nets
    _asset_index_cache["built_at"] = time.time()
    logger.info("资产库索引已构建: 单IP=%d 网段/范围=%d", len(single), len(nets))


def _match_asset_ip(ip: str, index: dict):
    """单个 IP 匹配资产索引：单 IP 精确优先，再 CIDR/范围包含。"""
    hit = index["single"].get(ip)
    if hit:
        return hit
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    for item, aid, name in index["nets"]:
        if item[0] == "net":
            if addr.version == item[1].version and addr in item[1]:
                return (aid, name)
        else:  # range
            if addr.version == item[1].version and item[1] <= addr <= item[2]:
                return (aid, name)
    return None


class AssetLibEnricher:
    """本地资产库关联富化：按 host_ip → src_ip → dst_ip 逐级匹配 assets 表。

    - IP 值支持 JSON 数组字符串（如 XDR host_ip），过滤 fe80:: 链路本地地址；
    - 单 IP 精确匹配优先，未命中再 CIDR / 起止范围包含判断；
    - 命中即停，写 relate_asset_id / relate_asset_name / relate_asset_ip
      （仅补空不覆盖），经 NormalizedEvent.to_alert_fields 落入 alert_events。
    """

    name = "asset_lib"

    def enrich(self, norm, db) -> None:
        try:
            if norm.get_field("relate_asset_id"):
                return  # 已有关联资产，跳过
            with _asset_index_lock:
                if time.time() - _asset_index_cache["built_at"] > _ASSET_INDEX_TTL_S:
                    _build_asset_index(db)
                index = {
                    "single": _asset_index_cache["single"],
                    "nets": _asset_index_cache["nets"],
                }
            for field in ("host_ip", "src_ip", "dst_ip"):
                val = norm.get_field(field)
                if not val:
                    continue
                ips = []
                s = str(val)
                try:
                    parsed = json.loads(s)
                    if isinstance(parsed, list):
                        ips = [str(x) for x in parsed if x]
                    else:
                        ips = [s]
                except (ValueError, TypeError):
                    ips = [s]
                ips = [ip for ip in ips if not ip.startswith("fe80::")][:5]
                for ip in ips:
                    hit = _match_asset_ip(ip, index)
                    if hit:
                        norm.set_field("relate_asset_id", hit[0])
                        norm.set_field("relate_asset_name", hit[1] or "")
                        norm.set_field("relate_asset_ip", ip)
                        return
        except Exception:  # noqa: BLE001
            logger.exception("资产库富化异常（忽略）")


enricher_registry.register(AssetEnricher)
enricher_registry.register(AssetLibEnricher)


@stage_registry.register
class EnricherStage(BaseStage):
    """富化步骤（config.enrichers = 启用的富化器 name 列表，默认空）。"""

    name = "enricher"

    def process(self, data: PipelineData, sink, db) -> None:
        names = self.config.get("enrichers") or []
        if not names:
            return
        enrichers = []
        for name in names:
            cls = enricher_registry.get(name)
            if cls is None:
                logger.warning("富化器未注册，已跳过: %s", name)
                continue
            try:
                enrichers.append(cls() if isinstance(cls, type) else cls)
            except Exception:  # noqa: BLE001
                logger.exception("富化器实例化失败: %s", name)
        if not enrichers:
            return
        for norm in data.normalized:
            for en in enrichers:
                try:
                    enrich_fn = getattr(en, "enrich", None) or en
                    enrich_fn(norm, db)
                except Exception:  # noqa: BLE001
                    logger.exception("富化器 %s 执行异常（忽略）", getattr(en, "name", en))
