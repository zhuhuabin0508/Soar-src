"""工单发起时自动研判（v2 多 IP）：源/目的 IP 资产匹配 + 威胁情报查询 + 智能体研判。

发起工单时对首节点 ``src_ip`` / ``dst_ip`` 字段自动执行（按字段开关）：
1. 资产匹配（``auto_asset``，默认开启）：**两个来源都查**——资产发现
   （综合运管平台，IP 精确匹配，与智能体检索同口径）与资产清单
   （复用告警资产富化 AssetLibEnricher 的索引：单 IP 精确 + CIDR/
   起止范围包含，内存缓存 TTL 600s）。资产发现优先级更高：
   ``asset.source`` 为主命中来源（发现命中 ``"asset_discovery"``，
   否则清单命中 ``"asset_inventory"``），``discovery`` / ``inventory``
   键各携完整命中结果（可同时命中并列展示）；
2. 威胁情报（``auto_intel``，默认开启）：统一经已注册工具
   ``get_threat_互联网``（HTTP 工具，平台工具执行口径 load_tool_function →
   run_http_tool）拉取真实情报，响应归一化为原有 threat 结构；并发批量查
   （信号量限流防打爆情报源），工具缺失/禁用/调用失败按「情报查询失败」降级；
3. 智能体研判（``auto_agent``，默认关闭）：调用 IP 风险研判智能体
   （``agent_client.analyze_ip_risk``，输出模式 ban_risk_analyze）。
   结果仅保留 risk_level / action / monitoring_advice / reasons。

v2 结构（多 IP，写入 ``Ticket.enrichment_data``，随工单全程流转）::

    {
      "version": 2,
      "ips": [
        {
          "ip": "10.144.1.2",
          "roles": ["src_ip"],            # 该 IP 出现的角色（可同时 src+dst）
          "detail": "full",                # full / lite 存储分级（见 _entry_tier）
          "asset": {...同 v1 匹配结构...},
          "threat": {...get_threat_互联网 工具响应归一化，lite 时仅保留精简键...},
          "ti_360": {...360 IOC 统一接口归一化；IP 实体另含
                     geo_info（360 IP 批量查询地区信息，
                     失败/未返回时兜底「地区信息未知」）...},
          "agent": {"pending": true}       # auto_agent 开启时的占位，
                                           # 由后台线程完成后回写
        }
      ],
      "role_labels": {"src_ip": "源IP地址", "dst_ip": "目的IP地址"},
      "stats": {                           # 发起时一次算好，折叠统计头直接读
        "total": 86, "src": 52, "dst": 34,  # 去重后独立 IP 数 / 各角色出现数
        "malicious": 6, "severity_high": 4,
        "asset_matched": 23, "asset_critical": 5,
        "intel_failed": 2, "asset_failed": 0,
        "pending": false                   # 后台研判中为 true
      },
      "enriched_at": "2026-11-06T10:00:00",
      "errors": ["..."]                    # 部分失败记录（不影响工单发起）
    }

设计要点（v2 多 IP）：
- 多值 IP（逗号/分号分隔）**全量解析**（v1 仅取第一个有效地址）：
  有效单 IP 逐个研判；网段/范围/非法文本条目记入 errors 不参与研判；
- **跨角色去重合并**：同一 IP 同时出现在源/目的只查一次（roles 数组
  记录出现角色），避免重复查询与重复渲染；
- **研判数量上限 ``MAX_ENRICH_IPS``（200）**：超出截断并在 errors
  与 stats.total_original 中记录；
- **full / lite 分级存储**：风险 IP（恶意 / 高危情报 / 重要资产 / 前
  ``LITE_FULL_TOP`` 个）保留全字段，其余仅存结论级精简键，控制 JSON
  列体积；重新研判（requery）时升级为 full；
- **同步 / 后台切换**：IP 数 ≤ ``SYNC_ENRICH_LIMIT``（20）同步构建
  （发起响应即带全量研判）；更多时先落 pending 占位（发起不阻塞），
  ``start_enrichment_bg`` 后台线程补全后回写，前端轮询 stats.pending；
- 字段定位：首节点字段中 type=ip 且 key 为 src_ip / dst_ip
  （兜底 alert_field_mapping）；
- 开关：``auto_asset`` / ``auto_intel`` / ``auto_agent`` 独立控制，
  兼容存量模板旧合并键 ``auto_enrich``；
- 单个 IP 研判失败仅记入 errors，不阻塞工单发起。
"""
import asyncio
import copy
import ipaddress
import json
import logging
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Optional

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm.attributes import flag_modified

from app.core.asset_index_cache import ensure_asset_index
from app.core.log_receiver_manager.pipeline.enricher_stage import _match_asset_ip
from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# 参与自动研判的 IP 角色及兜底字段 key
_IP_ROLES = ("src_ip", "dst_ip")

# 自动研判数量与并发控制
MAX_ENRICH_IPS = 200          # 研判 IP 数量上限（超出截断并记录）
SYNC_ENRICH_LIMIT = 20        # 超过此数转后台线程研判（发起不阻塞）
LITE_FULL_TOP = 10            # 前 N 个 IP 固定 full 档（保证头部完整可读）
ASSET_QUERY_WORKERS = 10      # 资产匹配线程池大小（资产发现为外部 HTTP）
INTEL_CONCURRENCY = 20        # 威胁情报并发上限（asyncio.Semaphore）

# 后台研判统一线程池：有界并发，避免每个工单新建线程导致线程数无上限；
# 进程重启后遗留的 pending 任务由 resume_pending_enrichments 重新入队。
BG_EXECUTOR_WORKERS = 4
_BG_EXECUTOR = ThreadPoolExecutor(
    max_workers=BG_EXECUTOR_WORKERS,
    thread_name_prefix="ticket-enrich",
)
# 在途任务去重：任务键（kind:ticket_id）→ Future，同一工单同一类任务只跑一个
_BG_TASKS: dict[str, Future] = {}
_BG_TASKS_LOCK = threading.Lock()


def _safe_rollback(db) -> None:
    """数据库异常后回滚，避免失败事务污染后续建单写入。"""
    rollback = getattr(db, "rollback", None)
    if not callable(rollback):
        return
    try:
        rollback()
    except Exception:  # noqa: BLE001
        pass


def _submit_bg_task(key: str, target, *args) -> None:
    """提交后台研判任务：有界线程池 + 同键去重（已在执行则跳过）。"""
    with _BG_TASKS_LOCK:
        running = _BG_TASKS.get(key)
        if running is not None and not running.done():
            logger.info("后台研判任务已在执行，跳过重复提交: %s", key)
            return
        future = _BG_EXECUTOR.submit(target, *args)
        _BG_TASKS[key] = future

    def _cleanup(done: Future) -> None:
        with _BG_TASKS_LOCK:
            if _BG_TASKS.get(key) is done:
                _BG_TASKS.pop(key, None)

    future.add_done_callback(_cleanup)


# 合法域名正则（RFC1034/1035 简化）：至少两级标签、总长 ≤253、
# 标签 1-63 字符且不以 - 开头/结尾；不含协议/路径/端口等杂质
_DOMAIN_RE = re.compile(
    r"(?=^.{1,253}$)^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$"
)


def _is_entity_ip(entity: str) -> bool:
    """判断实体是否为合法 IP（IPv4/IPv6）。"""
    try:
        ipaddress.ip_address(entity)
        return True
    except ValueError:
        return False


def _is_domain_token(entity: str) -> bool:
    """判断字符串是否为可研判的域名实体（非 IP、无协议/路径/端口杂质）。"""
    return bool(_DOMAIN_RE.match(entity or ""))


def _ioc_category(entity: str) -> str:
    """360 IOC 接口 category 自动识别：IP → ``ip``，其余 → ``domain``。"""
    return "ip" if _is_entity_ip(entity) else "domain"


def _extract_ips(value) -> tuple[list[str], list[str]]:
    """字段值 → (有效实体列表, 不参与研判的条目列表)。

    多值表达式按逗号/分号分隔逐段校验：合法单 IP 优先进入研判；
    非段不是 IP 时尝试域名匹配（360 情报支持 domain 类实体）；
    网段/范围/其他非法文本记入 skipped（调用方写入 errors 提示不参与研判）。
    返回的实体列表同时可含 IP 与域名，由后续链路按实体类型分流
    （资产匹配/知道创宇/智能体仅 IP；360 情报 IP 与域名均可）。
    """
    if value is None:
        return [], []
    s = str(value).strip()
    if not s:
        return [], []
    ips: list[str] = []
    skipped: list[str] = []
    for part in s.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if _is_entity_ip(part) or _is_domain_token(part):
            if part not in ips:
                ips.append(part)
        elif part not in skipped:
            skipped.append(part)
    return ips, skipped


# 域名类字段 key（域名或 URL 实体入口；360 情报支持 domain 类实体）
_DOMAIN_ROLES = ("domain_url", "domain")


def _url_host(token: str) -> str:
    """从域名/URL token 中剥取 host（去协议/路径/端口）。

    支持 ``evil.com``、``http://evil.com/a?b=1``、``https://1.2.3.4:8080/x``
    及 ``http://[::1]:8080/`` 形态；剥取失败返回原文（由调用方校验）。
    """
    t = token
    if "://" in t:
        t = t.split("://", 1)[1]
    t = t.split("/", 1)[0]
    if t.startswith("[") and "]" in t:  # http://[::1]:8080/
        return t.split("]", 1)[0].lstrip("[")
    if ":" in t:  # host:port（仅对合法 IPv4/域名主机剥端口）
        head, _, tail = t.rpartition(":")
        if tail.isdigit() and (_is_entity_ip(head) or _is_domain_token(head)):
            return head
    return t


def _extract_domains(value) -> tuple[list[str], list[str]]:
    """域名/URL 字段值 → (实体列表, 非法条目列表)。

    每段先剥协议/路径/端口取 host，host 为合法域名或 IP 即进入研判
    （URL 直接填 IP 形态的场景）；其余记入 skipped。
    """
    if value is None:
        return [], []
    s = str(value).strip()
    if not s:
        return [], []
    entities: list[str] = []
    skipped: list[str] = []
    for part in s.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        host = _url_host(part)
        if _is_domain_token(host) or _is_entity_ip(host):
            if host not in entities:
                entities.append(host)
        elif part not in skipped:
            skipped.append(part)
    return entities, skipped


def _locate_ip_fields(field_defs: list, values: dict) -> list[dict]:
    """从首节点字段定义中定位实体字段并提取全部有效实体（IP 或域名）。

    匹配规则：字段 key 为 src_ip / dst_ip（兜底 alert_field_mapping），
    值可为 IP 或域名；domain_url / domain 字段（域名或 URL，URL 自动
    剥取 host）也纳入研判（360 情报支持 domain 类实体）。返回
    ``[{role, label, ips, skipped, asset, intel, agent}]``（``ips`` 键承载
    IP/域名实体列表），其中 ``asset``（资产匹配）与 ``intel``（威胁
    情报）默认 True、``agent``（智能体研判）默认 False；仅有旧合并键
    ``auto_enrich`` 的存量模板按其值兜底。
    """
    found: list[dict] = []
    for f in field_defs or []:
        if not isinstance(f, dict):
            continue
        key = str(f.get("key") or "")
        mapping = str(f.get("alert_field_mapping") or "")
        role = key if key in _IP_ROLES else (mapping if mapping in _IP_ROLES else "")
        extractor = _extract_ips
        if not role:
            # 域名/URL 字段（domain_url/domain）：360 情报的 domain 实体入口
            d_role = key if key in _DOMAIN_ROLES else (mapping if mapping in _DOMAIN_ROLES else "")
            if d_role:
                role = d_role
                extractor = _extract_domains
        if not role or any(item["role"] == role for item in found):
            continue
        ips, skipped = extractor(values.get(key))
        if not ips:
            continue
        legacy = f.get("auto_enrich")
        asset = f.get("auto_asset")
        if asset is None:
            asset = legacy is not False
        intel = f.get("auto_intel")
        if intel is None:
            intel = legacy is not False
        found.append({
            "role": role,
            "label": f.get("label") or key,
            "ips": ips,
            "skipped": skipped,
            "asset": asset,
            "intel": intel,
            "agent": f.get("auto_agent") is True,
        })
    return found


def _merge_role_ips(located: list[dict]) -> tuple[list[str], dict[str, dict]]:
    """跨角色合并去重：``(有序 IP 列表, {ip: {roles, asset, intel, agent}})``。

    同一 IP 出现于源/目的只保留一份（roles 记录全部出现角色），开关按
    角色取或（任一角色开启即查询）。
    """
    order: list[str] = []
    flags: dict[str, dict] = {}
    for item in located:
        for ip in item["ips"]:
            f = flags.setdefault(
                ip, {"roles": [], "asset": False, "intel": False, "agent": False}
            )
            if item["role"] not in f["roles"]:
                f["roles"].append(item["role"])
            f["asset"] = f["asset"] or bool(item["asset"])
            f["intel"] = f["intel"] or bool(item["intel"])
            f["agent"] = f["agent"] or bool(item["agent"])
            if ip not in order:
                order.append(ip)
    return order, flags


# 资产发现命中的展示上限（安全上下文卡片展示够用，避免多命中撑爆）
_DISCOVERY_MATCH_LIMIT = 5
# 资产发现查询超时（毫秒）：建单同步链路不能被外部检索长期阻塞
_ASSET_QUERY_TIMEOUT_MS = 3000


def _match_discovery_asset(db, ip: str) -> Optional[dict]:
    """查询资产发现（综合运管平台）数据。

    复用资产发现检索 ``_search_token`` 的 IP 精确匹配口径（IP 列 +
    extra_excel IP 键，全部资源类型），与智能体 ``search_assets`` /
    ``search_discovered_assets`` 工具一致。命中返回
    ``{resource_type, resource_label, asset_name, asset_ip, matches, truncated}``
    （``matches`` 为全部命中记录）；未命中返回 None；查询失败返回带
    ``error`` 的字典（供调用方区分"未命中"与"查询失败"）。
    """
    from app.agent.discovery_search import _search_token
    from app.api.v1.govcloud import RESOURCE_TYPES

    try:
        # 简单处理：execute 会自动开启事务，SET LOCAL 在事务内生效
        db.execute(text(f"SET LOCAL statement_timeout = {_ASSET_QUERY_TIMEOUT_MS}"))
    except Exception as exc:  # noqa: BLE001
        logger.debug("资产发现查询设置 statement_timeout 失败（忽略）: %s", exc)

    try:
        result = _search_token(db, ip, list(RESOURCE_TYPES.keys()), _DISCOVERY_MATCH_LIMIT)
    except SQLAlchemyError as exc:
        logger.warning("工单资产发现查询失败, ip=%s: %s", ip, exc)
        _safe_rollback(db)
        return {"asset_ip": ip, "matches": [], "truncated": False, "error": f"资产发现查询失败: {exc}"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单资产发现查询失败, ip=%s: %s", ip, exc)
        return {"asset_ip": ip, "matches": [], "truncated": False, "error": f"资产发现查询失败: {exc}"}
    finally:
        # 恢复默认超时，避免影响同一事务后续的建单写入
        try:
            db.execute(text("SET LOCAL statement_timeout = DEFAULT"))
        except Exception:  # noqa: BLE001
            pass
    if result.get("error") and not result.get("assets"):
        logger.warning("工单资产发现查询返回错误, ip=%s: %s", ip, result.get("error"))
        return {
            "asset_ip": ip,
            "matches": [],
            "truncated": False,
            "error": f"资产发现查询失败: {result.get('error')}",
        }
    matches = [m for m in (result.get("assets") or []) if isinstance(m, dict)]
    if not matches:
        return None
    primary = matches[0]
    for m in matches:
        # 每条命中记录都带详细来源（多次命中可能跨资源类型）
        m.setdefault("source_label", _discovery_source_label(m))
    return {
        "resource_type": primary.get("resource_type") or "",
        "resource_label": primary.get("resource_label") or "",
        "source_label": _discovery_source_label(primary),
        "asset_name": (
            primary.get("instance_name")
            or primary.get("inst_name")
            or primary.get("name")
            or primary.get("cmdb_id")
            or ""
        ),
        "asset_ip": ip,
        "matches": matches,
        "truncated": bool(result.get("truncated")),
    }


def _match_inventory_asset(db, ip: str) -> Optional[dict]:
    """查询资产清单（复用告警富化索引：单 IP 精确 + CIDR/范围包含）。

    命中返回 ``{asset_id, asset_name, asset_ip, fields}``（``fields`` 与
    资产详情接口同口径：所有列 + 标签，排除 raw_content 溯源长文本）；
    未命中返回 None。
    """
    from app.models.asset import Asset
    from app.schemas.common import to_dict

    index = ensure_asset_index(db)
    hit = _match_asset_ip(ip, index)
    if not hit:
        return None
    result = {
        "asset_id": hit[0],
        "asset_name": hit[1] or "",
        "asset_ip": ip,
    }
    record = db.query(Asset).filter(Asset.id == hit[0]).first()
    if record is not None:
        d = to_dict(record)
        d.pop("raw_content", None)
        d["tags"] = [
            {"id": t.id, "name": t.name, "color": t.color}
            for t in (record.tags or [])
        ]
        result["fields"] = d
        # 详细来源标签：资产清单-{知识库名或资产类型模板名}
        result["source_label"] = _inventory_source_label(d, _template_name_map(db))
    return result


def _match_asset(db, ip: str) -> dict:
    """单 IP 同时匹配资产发现与资产清单（两个来源都查）。

    资产发现优先级高于资产清单：``source`` 取主命中来源（发现命中为
    ``"asset_discovery"``，否则清单命中 ``"asset_inventory"``），头部
    链接与资产名按主来源展示；``discovery`` / ``inventory`` 键各自携带
    完整命中结果（可同时存在，也可为 None），前端按发现优先顺序并列
    展示。各块带 ``source_label``（详细数据来源，如
    ``资产发现-裸金属资产`` / ``资产清单-A会保持在线系统清单``）。
    两来源均未命中返回 ``{"matched": False}``；任一来源查询失败时在返回
    结构中携带 ``error``（另一侧成功结果仍保留），供 stats.asset_failed
    统计与前端提示。
    """
    errors: list[str] = []
    inventory = None
    discovery = None
    try:
        inventory = _match_inventory_asset(db, ip)
    except SQLAlchemyError as exc:
        logger.warning("工单资产清单匹配失败, ip=%s: %s", ip, exc)
        _safe_rollback(db)
        errors.append(f"{ip} 资产清单匹配失败: {exc}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单资产清单匹配失败, ip=%s: %s", ip, exc)
        errors.append(f"{ip} 资产清单匹配失败: {exc}")
    try:
        discovery = _match_discovery_asset(db, ip)
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单资产发现匹配失败, ip=%s: %s", ip, exc)
        errors.append(f"{ip} 资产发现匹配失败: {exc}")
    if isinstance(discovery, dict) and discovery.get("error"):
        errors.append(f"{ip} {discovery['error']}")
        discovery = None

    if inventory is None and discovery is None:
        result = {"matched": False}
        if errors:
            result["error"] = "；".join(errors)
        return result
    if discovery is not None:
        primary = {
            "source": "asset_discovery",
            "asset_name": discovery.get("asset_name") or "",
            "asset_ip": ip,
            "resource_type": discovery.get("resource_type") or "",
            "source_label": discovery.get("source_label") or _DISCOVERY_SOURCE_PREFIX,
        }
    else:
        primary = {
            "source": "asset_inventory",
            "asset_name": inventory.get("asset_name") or "",
            "asset_ip": ip,
            "asset_id": inventory.get("asset_id"),
            "source_label": inventory.get("source_label") or _INVENTORY_SOURCE_PREFIX,
        }
    result = {
        "matched": True,
        **primary,
        "discovery": discovery,
        "inventory": inventory,
    }
    if errors:
        result["error"] = "；".join(errors)
    return result


# ---------------------------------------------------------------------------
# 数据来源标签（工单安全上下文「资产匹配」着重展示的详细来源）
#
# 命名与资产查询智能体技能的口径一致：``资产发现-{资源类型}`` /
# ``资产清单-{知识库名或资产类型模板名}``，让处理人一眼看清这条资产
# 来自哪个数据源、哪类清单，而不是只看到笼统的「资产发现 / 资产清单」。
# ---------------------------------------------------------------------------

_DISCOVERY_SOURCE_PREFIX = "资产发现"
_INVENTORY_SOURCE_PREFIX = "资产清单"


def _discovery_source_label(match: dict) -> str:
    """资产发现命中的来源标签：``资产发现-裸金属资产``。"""
    label = str((match or {}).get("resource_label") or "").strip()
    return f"{_DISCOVERY_SOURCE_PREFIX}-{label}" if label else _DISCOVERY_SOURCE_PREFIX


def _template_name_map(db) -> dict[str, str]:
    """资产类型模板 code → 名称（如 meeting_online_system → A会保持在线系统清单）。"""
    from app.models.asset import AssetTypeTemplate

    try:
        return {
            str(code): str(name or "")
            for code, name in db.query(
                AssetTypeTemplate.code, AssetTypeTemplate.name
            ).all()
            if code
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("资产类型模板读取失败（来源标签降级）: %s", exc)
        return {}


def _inventory_source_label(fields: dict | None, type_names: dict[str, str]) -> str:
    """资产清单命中的来源标签：``资产清单-A会保持在线系统清单``。

    优先知识库名称（KB 梳理入库的资产带 ``kb_name``），其次资产类型模板名
    （页面/接口导入的资产按 ``type_code`` 归类），两者都没有时只显示
    ``资产清单``（对应窄需求：仍明确是清单来源，不编造明细）。
    """
    f = fields or {}
    base = str(f.get("kb_name") or "").strip()
    if not base:
        base = str(type_names.get(str(f.get("type_code") or ""), "")).strip()
    return f"{_INVENTORY_SOURCE_PREFIX}-{base}" if base else _INVENTORY_SOURCE_PREFIX


def _enrichment_entries(enrichment: dict | None) -> list[dict]:
    """兼容取出研判条目列表：v2 取 ``ips``，v1 取 ``sources``。"""
    if not isinstance(enrichment, dict):
        return []
    if isinstance(enrichment.get("ips"), list):
        return [e for e in enrichment["ips"] if isinstance(e, dict)]
    if isinstance(enrichment.get("sources"), list):
        return [s for s in enrichment["sources"] if isinstance(s, dict)]
    return []


def decorate_asset_source_labels(db, enrichment: dict | None) -> dict | None:
    """补齐 enrichment 中资产匹配的 ``source_label``（幂等，只补缺失键）。

    工单详情展示前调用：存量工单保存的 enrichment 没有来源标签，资产类型
    模板也可能被改名，按当前数据推导即可满足展示需要。返回深拷贝，避免
    ORM JSON 列被就地修改后误落库。兼容 v1（sources）/ v2（ips）结构。
    """
    if not isinstance(enrichment, dict):
        return enrichment
    if not isinstance(enrichment.get("sources"), list) and not isinstance(
        enrichment.get("ips"), list
    ):
        return enrichment

    data = copy.deepcopy(enrichment)
    type_names: dict[str, str] | None = None
    for source in _enrichment_entries(data):
        asset = (source or {}).get("asset") or {}
        if not isinstance(asset, dict) or not asset.get("matched"):
            continue
        discovery = asset.get("discovery")
        if isinstance(discovery, dict):
            if not discovery.get("source_label"):
                discovery["source_label"] = _discovery_source_label(discovery)
            for match in discovery.get("matches") or []:
                if isinstance(match, dict) and not match.get("source_label"):
                    match["source_label"] = _discovery_source_label(match)
        inventory = asset.get("inventory")
        if isinstance(inventory, dict) and not inventory.get("source_label"):
            if type_names is None:
                type_names = _template_name_map(db)
            inventory["source_label"] = _inventory_source_label(
                inventory.get("fields"), type_names
            )
        if not asset.get("source_label"):
            if isinstance(discovery, dict):
                asset["source_label"] = discovery.get("source_label")
            elif isinstance(inventory, dict):
                asset["source_label"] = inventory.get("source_label")
            elif asset.get("source") == "asset_inventory" and isinstance(
                asset.get("fields"), dict
            ):
                # 旧结构工单：清单命中字段直接挂在 asset 本体上
                if type_names is None:
                    type_names = _template_name_map(db)
                asset["source_label"] = _inventory_source_label(
                    asset["fields"], type_names
                )
            elif asset.get("source") == "asset_discovery":
                asset["source_label"] = _DISCOVERY_SOURCE_PREFIX
    return data


# 威胁情报统一走已注册的 HTTP 工具（工具管理中维护 URL/鉴权/超时）。
# 工具重命名抗性：先按候选名精确匹配，未命中再按 get_threat 前缀找唯一的
# enabled http 工具兜底——工具在管理页改名/微调后缀不再破坏安全上下文集成。
# 注意：候选名只放 HTTP 工具名——不得加入内置 mock 工具名（get_threat_intel，
# code 类型），否则无序 first() 可能随机命中 mock，情报数据时真时假。
TI_TOOL_NAME = "get_threat_互联网_知道创宇ip_analysis"
_TI_TOOL_CANDIDATES = (
    TI_TOOL_NAME,
    "get_threat_互联网",  # 历史名兼容（工具改名前创建的工单/文档引用）
)
# 归一化结果中保留的原始响应长度上限（防止超长 payload 撑爆 enrichment_data）
_TI_RAW_MAX_CHARS = 3000

_MALICIOUS_TRUE = {"true", "1", "yes", "malicious", "mal", "bad", "恶意", "恶意ip", "风险"}
_MALICIOUS_FALSE = {"false", "0", "no", "clean", "safe", "安全", "正常", "白名单"}
_SEVERITY_HIGH = {"high", "critical", "严重", "高", "高危"}
_SEVERITY_MEDIUM = {"medium", "中", "中危", "moderate"}
_MALICIOUS_TAG_HINTS = ("恶意", "malicious", "botnet", "c2", "zombie", "扫描", "scan", "攻击", "attack")


def _ti_first(payload: dict, *keys, default=None):
    """按优先级取第一个非空字段值。"""
    for k in keys:
        v = payload.get(k)
        if v not in (None, "", [], {}):
            return v
    return default


def _ti_coerce_malicious(v) -> Optional[bool]:
    """bool/int/str 统一转恶意判定；无法识别返回 None。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in _MALICIOUS_TRUE:
            return True
        if s in _MALICIOUS_FALSE:
            return False
    return None


def _ti_coerce_confidence(v) -> Optional[float]:
    """置信度统一为 0~1 浮点；无法识别返回 None。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        c = float(v)
        return round(c / 100, 2) if c > 1 else round(c, 2)
    if isinstance(v, str):
        s = v.strip().rstrip("%")
        try:
            c = float(s)
        except ValueError:
            return None
        return round(c / 100, 2) if c > 1 else round(c, 2)
    return None


def _ti_coerce_severity(v) -> Optional[str]:
    """严重程度统一为 low/medium/high；无法识别返回 None。"""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        v = str(int(v))
    if not isinstance(v, str):
        return None
    s = v.strip().lower()
    if s in _SEVERITY_HIGH:
        return "high"
    if s in _SEVERITY_MEDIUM or s == "2":
        return "medium"
    if s in ("low", "低", "低危", "1", "3"):
        return "low"
    return None


def _ti_coerce_str_list(v) -> list:
    """标签/类型字段统一为字符串列表（支持 list 与分隔符字符串）。"""
    if isinstance(v, (list, tuple)):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [p.strip() for p in v.replace("，", ",").replace("、", ",").split(",") if p.strip()]
    return []


def _ti_geo(payload: dict) -> dict:
    """地理位置统一为 geo_info 结构（兼容嵌套 geo/location 与平铺字段）。"""
    geo = None
    for k in ("geo_info", "geo", "location"):
        v = payload.get(k)
        if isinstance(v, dict):
            geo = v
            break
    src = geo if geo is not None else payload
    return {
        "country": _ti_first(src, "country", "country_name", "国家"),
        "region": _ti_first(src, "region", "province", "省份"),
        "city": _ti_first(src, "city", "城市"),
        "isp": _ti_first(src, "isp", "operator", "运营商"),
        "latitude": _ti_first(src, "latitude", "lat"),
        "longitude": _ti_first(src, "longitude", "lng", "lon"),
    }


_YUNAQ_ATTACK_TOOL_LABELS = [
    ("attack_type", "攻击类型"),
    ("recon", "侦察探测"),
    ("free_attack_tool", "免费攻击工具"),
    ("commercial_attack_tool", "商业化攻击工具"),
    ("install_backdoor", "后门植入"),
    ("c2_control", "C2 控制"),
    ("webshell_control", "WebShell 控制"),
    ("proxy_relate", "代理关联"),
    ("tor_trace", "Tor 链路"),
    ("tg_robot", "TG 机器人"),
    ("ddos_attack", "DDoS 攻击"),
]


def _ti_list_items(v) -> list:
    """攻击工具/时段等列表字段统一转字符串列表（元素可为字符串或对象）。"""
    out = []
    if not isinstance(v, (list, tuple)):
        return out
    for x in v:
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
        elif isinstance(x, dict):
            item = next((str(x[k]) for k in ("name", "tool", "desc", "value", "date", "start") if x.get(k) not in (None, "", [])), None)
            if item:
                out.append(item)
    return out


def _yunaq_extract(ip: str, data: dict, ti_name: str = TI_TOOL_NAME) -> dict:
    """gac.yunaq.com ``ip_analysis`` v3 响应结构专用映射。

    实测结构（含 status/data 包装）：``data.basic.addr=[国家,省份,城市]``、
    ``data.basic.isp/location``、``data.attack_tool``（攻击类型与攻击工具
    分类明细）、``data.exploit``、``data.history_perform``（active_date/
    attack_total/attack_hosts_cnt 等攻击统计）、``data.key_period``（攻击
    活跃关键时段）、``data.device_info``、``data.whois``。
    未命中威胁标签/攻击记录时判定为非恶意。
    """
    basic = data.get("basic") if isinstance(data.get("basic"), dict) else {}
    addr = basic.get("addr") if isinstance(basic.get("addr"), list) else []
    location = basic.get("location") if isinstance(basic.get("location"), dict) else {}
    geo_info = {
        "country": (addr[0] or None) if len(addr) > 0 else None,
        "region": (addr[1] or None) if len(addr) > 1 else None,
        "city": (addr[2] or None) if len(addr) > 2 else None,
        "isp": basic.get("isp") or None,
        "latitude": location.get("lat") or None,
        "longitude": location.get("lon") or None,
    }

    attack_tool = data.get("attack_tool") if isinstance(data.get("attack_tool"), dict) else {}
    threat_types = _ti_list_items(attack_tool.get("attack_type"))
    attack_patterns = []
    for key, label in _YUNAQ_ATTACK_TOOL_LABELS[1:]:
        for item in _ti_list_items(attack_tool.get(key)):
            attack_patterns.append(f"{label}：{item}")
    if isinstance(data.get("exploit"), str) and data.get("exploit").strip():
        attack_patterns.append(f"漏洞利用：{data['exploit'].strip()}")

    history = data.get("history_perform") if isinstance(data.get("history_perform"), dict) else {}
    attack_stats = {
        "total": history.get("attack_total") if isinstance(history.get("attack_total"), int) else 0,
        "hosts_cnt": history.get("attack_hosts_cnt") if isinstance(history.get("attack_hosts_cnt"), int) else 0,
    }
    last_seen = history.get("active_date") or None
    key_period = _ti_list_items(data.get("key_period"))
    first_seen = key_period[0] if key_period else None

    device = data.get("device_info") if isinstance(data.get("device_info"), dict) else {}
    ports = device.get("ports") if isinstance(device.get("ports"), dict) else {}
    device_info = {
        "device_type": device.get("device_type") or None,
        "os": device.get("os") or None,
        "host_name": device.get("host_name") or None,
        "ports": [str(p) for p in ports.keys()] if ports else [],
    }
    whois = data.get("whois") if isinstance(data.get("whois"), dict) else {}
    org = whois.get("organization") if isinstance(whois.get("organization"), dict) else {}
    org_info = {
        "netname": whois.get("netname") or None,
        "org_name": org.get("org_name") or whois.get("descr") or None,
    }

    tags = _ti_coerce_str_list(data.get("tags"))
    is_malicious = bool(tags or attack_stats["total"] or attack_patterns or threat_types)
    severity = "high" if is_malicious else "low"
    conf = 0.85 if is_malicious else 0.0

    desc_parts = []
    if is_malicious:
        if tags:
            desc_parts.append(f"被标记「{'、'.join(tags)}」")
        if attack_stats["total"]:
            desc_parts.append(f"历史攻击 {attack_stats['total']} 次（涉及 {attack_stats['hosts_cnt']} 台主机）")
        if last_seen:
            desc_parts.append(f"最近活跃 {last_seen}")
        description = f"该 IP {ip} 经 {ti_name} 查询命中威胁情报：{'，'.join(desc_parts)}。建议立即封禁并排查内网主机与该地址的通信记录。"
    else:
        description = f"该 IP {ip} 经 {ti_name} 查询未命中威胁标签与攻击记录，判定为非恶意。"

    return {
        "ip": ip,
        "is_malicious": is_malicious,
        "tags": tags,
        "confidence": conf,
        "threat_types": threat_types,
        "severity": severity,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "source": ti_name,
        "description": description,
        "geo_info": geo_info,
        "related_malware": [],
        "attack_patterns": attack_patterns,
        "attack_stats": attack_stats,
        "device_info": device_info,
        "org_info": org_info,
    }


def _normalize_tool_threat(ip: str, resp: object, ti_name: str = TI_TOOL_NAME) -> dict:
    """将威胁情报 HTTP 工具原始响应归一化为安全上下文威胁情报结构。

    优先按 gac.yunaq.com ip_analysis 实际结构映射（地理归属/威胁类型/
    攻击链/活跃时间/攻击统计/设备特征/归属组织），其他结构走通用映射；
    输出保持原有 threat 键结构不变（前端展示与 lite 精简零改动），
    原始响应保留在 ``raw``，未映射字段可供智能体研判兜底。

    Raises:
        ValueError: 工具返回错误 / 非对象响应（调用方按单 IP 失败处理）。
    """
    if not isinstance(resp, dict):
        raise ValueError(f"工具返回非对象结果: {type(resp).__name__}")
    if resp.get("error"):
        raise ValueError(f"工具返回错误: {resp.get('error')}")
    # 兼容常见外层包装：{"code"/"status": ..., "data": {...}}
    payload = resp.get("data") if isinstance(resp.get("data"), dict) else resp

    if any(k in payload for k in ("basic", "attack_tool", "history_perform")):
        result = _yunaq_extract(ip, payload, ti_name=ti_name)
    else:
        is_malicious = _ti_coerce_malicious(_ti_first(
            payload, "is_malicious", "malicious", "is_bad", "is_bad_ip", "judgment", "judge", "is_danger",
        ))
        tags = _ti_coerce_str_list(_ti_first(payload, "tags", "tag", "labels", "威胁标签"))
        if is_malicious is None:
            # 未显式给出判定时，从标签推断（含恶意类关键词视为恶意）
            is_malicious = any(any(h in t.lower() for h in _MALICIOUS_TAG_HINTS) for t in tags)
        confidence = _ti_coerce_confidence(_ti_first(
            payload, "confidence", "confidence_score", "score", "置信度",
        ))
        result = {
            "ip": ip,
            "is_malicious": is_malicious,
            "tags": tags,
            "confidence": confidence if confidence is not None else (0.85 if is_malicious else 0.0),
            "threat_types": _ti_coerce_str_list(_ti_first(
                payload, "threat_types", "types", "attack_types", "威胁类型",
            )) or tags,
            "severity": _ti_coerce_severity(_ti_first(
                payload, "severity", "risk_level", "threat_level", "level", "严重程度",
            )) or ("high" if is_malicious else "low"),
            "first_seen": _ti_first(payload, "first_seen", "first_seen_time", "firsttime", "首次发现"),
            "last_seen": _ti_first(payload, "last_seen", "last_seen_time", "updatetime", "update_time", "最后发现"),
            "source": _ti_first(payload, "source", "情报来源") or ti_name,
            "geo_info": _ti_geo(payload),
            "related_malware": _ti_coerce_str_list(_ti_first(
                payload, "related_malware", "malware", "malware_family", "关联恶意软件",
            )),
            "attack_patterns": _ti_coerce_str_list(_ti_first(
                payload, "attack_patterns", "attack_methods", "攻击模式",
            )),
            "description": _ti_first(
                payload, "description", "summary", "remark", "judge_desc", "desc", "描述",
            ) or (
                f"该 IP {ip} 经 {ti_name} 工具查询"
                f"{'判定为恶意' if is_malicious else '未判定为恶意'}"
                + (f"，置信度 {confidence}" if confidence is not None else "") + "。"
            ),
        }

    try:
        raw_text = json.dumps(resp, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        raw_text = str(resp)
    if len(raw_text) > _TI_RAW_MAX_CHARS:
        raw_text = raw_text[:_TI_RAW_MAX_CHARS] + "...(truncated)"
    result["raw"] = raw_text
    return result


def _load_ti_tool_run():
    """加载已注册的威胁情报工具（平台统一工具执行口径）。

    经 load_tool_function → run_http_tool 执行：工具管理中调整 URL/鉴权/
    超时等配置后，工单安全上下文的情报拉取即时跟随，无需改代码。
    查找顺序：候选名精确匹配 → ``get_threat`` 前缀的 enabled http 工具
    兜底（工具重命名后集成不中断）。
    工具缺失/禁用/加载失败返回 ``(None, None)``，条目按「情报查询失败」
    降级，不阻断工单发起与其余 IP 的查询。

    Returns:
        ``(tool_run, tool_name)`` 元组；tool_run 为可调用对象。
    """
    from app.core.tool_runner import load_tool_function
    from app.database import SessionLocal
    from app.models.tool import Tool

    db = SessionLocal()
    try:
        # 精确匹配限定 HTTP 工具 + 按 id 排序，保证确定性命中
        # （候选中不允许出现 code 类 mock 工具名，见 _TI_TOOL_CANDIDATES 注释）
        tool = db.query(Tool).filter(
            Tool.name.in_(_TI_TOOL_CANDIDATES),
            Tool.tool_type == "http",
            Tool.enabled.is_(True),
        ).order_by(Tool.id).first()
        if tool is None:
            tool = db.query(Tool).filter(
                Tool.name.like("get_threat%"),
                Tool.tool_type == "http",
                Tool.enabled.is_(True),
            ).order_by(Tool.id).first()
        if tool is None:
            logger.warning(
                "威胁情报工具未注册或已禁用（候选: %s；或以 get_threat 为前缀的 http 工具），安全上下文情报查询不可用",
                "、".join(_TI_TOOL_CANDIDATES),
            )
            return None, None
        return load_tool_function(tool), tool.name
    except Exception as exc:  # noqa: BLE001
        logger.warning("威胁情报工具加载失败: %s", exc)
        return None, None
    finally:
        db.close()


def _query_threat_intel_batch(ips: list[str]) -> list[dict]:
    """并发执行威胁情报 HTTP 工具（信号量限流，单事件循环跑完全部 IP）。

    按工具入参规范（ip 必填，路径参数由 HTTP 工具 runner 渲染）逐 IP 调用，
    响应经 _normalize_tool_threat 归一化。单个 IP 查询失败返回
    ``{"error": "..."}``，不影响其余 IP。
    """
    tool_run, ti_tool_name = _load_ti_tool_run()
    ti_tool_name = ti_tool_name or TI_TOOL_NAME

    async def _gather():
        if tool_run is None:
            return [{"error": f"威胁情报工具 {ti_tool_name} 不可用", "ip": ip} for ip in ips]
        sem = asyncio.Semaphore(INTEL_CONCURRENCY)

        async def _one(ip: str) -> dict:
            async with sem:
                try:
                    resp = await tool_run(ip=ip)
                    return _normalize_tool_threat(ip, resp, ti_name=ti_tool_name)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("威胁情报查询失败, ip=%s: %s", ip, exc)
                    return {"error": f"查询失败: {exc}", "ip": ip}

        return await asyncio.gather(*[_one(ip) for ip in ips])

    return asyncio.run(_gather())


# ---------------------------------------------------------------------------
# 360 威胁情报（IOC 对外输出统一接口）：加载 / 归一化 / 批量查询
# ---------------------------------------------------------------------------

TI_TOOL_NAME_360 = "get_threat_互联网_360_ioc"
_TI_TOOL_CANDIDATES_360 = (
    TI_TOOL_NAME_360,
    "get_threat_互联网_360",
)

# 危害等级 → 中文标签（level 0-100 整十分级；文档口径：
# 30 以下白 / 30 未知 / 40-50 低危 / 60 中危 / 70 高危 / 80-100 超危）
_360_LEVEL_LABELS: tuple[tuple[int, str], ...] = (
    (80, "超危"), (70, "高危"), (60, "中危"), (40, "低危"), (30, "未知"), (0, "白名单"),
)

# 活跃状态 → 中文标签
_360_STATUS_LABELS = {
    "ACTIVE": "活跃",
    "OVER": "过期/失效",
    "SINKHOLE": "已 Sinkhole 处置",
    "UNKNOWN": "未知",
}


def _360_level_label(level: int) -> str:
    """按 360 文档口径把 level（0-100）映射为中文等级标签。"""
    for threshold, label in _360_LEVEL_LABELS:
        if level >= threshold:
            return label
    return "未知"


def _normalize_360_result(entity: str, resp: object, tool_name: str = TI_TOOL_NAME_360) -> dict:
    """将 360 IOC 统一接口响应归一化为安全上下文 ``ti_360`` 结构。

    全字段保留（危害等级/置信度/活跃状态/病毒名称/用途/时间线/威胁标签
    及其 ttps 分类），原始响应截断存 ``raw``。业务错误（code != "0"）
    或工具错误抛 ValueError（调用方按单实体失败处理）。
    """
    if not isinstance(resp, dict):
        raise ValueError(f"360 工具返回非对象结果: {type(resp).__name__}")
    if resp.get("error"):
        raise ValueError(f"360 工具返回错误: {resp.get('error')}")
    code = str(resp.get("code", "0"))
    if code != "0":
        raise ValueError(f"360 接口业务错误: code={code}, msg={resp.get('msg')}")
    raw_items = resp.get("data") if isinstance(resp.get("data"), list) else []
    results: list[dict] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        tags: list[dict] = []
        for tg in it.get("tags") or []:
            if not isinstance(tg, dict):
                continue
            ttps = tg.get("ttps") if isinstance(tg.get("ttps"), dict) else {}
            tags.append({
                "name": tg.get("name") or tg.get("id") or "",
                "id": tg.get("id") or "",
                "desc": tg.get("desc") or "",
                "severity": tg.get("severity"),
                "source": tg.get("source"),
                "tag_type": tg.get("tag_type") or ttps.get("ti_showname") or "",
                "ti_type_main": ttps.get("ti_type_main") or "",
                "ti_type_sub": ttps.get("ti_type_sub") or "",
                "status": tg.get("status") or "",
            })
        try:
            level = int(it.get("level") or 0)
        except (TypeError, ValueError):
            level = 0
        status_raw = str(it.get("status") or "UNKNOWN")
        results.append({
            "ioc": it.get("ioc") or entity,
            "ioc_type": it.get("ioc_type") or "",
            "level": level,
            "level_label": _360_level_label(level),
            "confidence": it.get("confidence"),
            "status": status_raw,
            "status_label": _360_STATUS_LABELS.get(status_raw, status_raw),
            "first_time": it.get("first_time") or "",
            "last_time": it.get("last_time") or "",
            "expire_time": it.get("expire_time") or "",
            "malware": it.get("malware") or "",
            "function": [str(x) for x in (it.get("function") or []) if x],
            "hit_ioc": it.get("hit_ioc") or "",
            "tags": tags,
        })
    out = {
        "entity": entity,
        "category": _ioc_category(entity),
        "tool_name": tool_name,
        "results": results,
    }
    try:
        raw_text = json.dumps(resp, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        raw_text = str(resp)
    if len(raw_text) > _TI_RAW_MAX_CHARS:
        raw_text = raw_text[:_TI_RAW_MAX_CHARS] + "...(truncated)"
    out["raw"] = raw_text
    return out


def _load_ti_tool_run_360():
    """加载 360 威胁情报 HTTP 工具（候选名精确匹配，不做前缀兜底——
    避免误抓其他情报源工具）。工具缺失/禁用/加载失败返回 ``(None, None)``
    （调用方按「跳过 360 研判」处理，不阻断其余链路）。

    Returns:
        ``(tool_run, tool_name)`` 元组；tool_run 为可调用对象。
    """
    from app.core.tool_runner import load_tool_function
    from app.database import SessionLocal
    from app.models.tool import Tool

    db = SessionLocal()
    try:
        tool = db.query(Tool).filter(
            Tool.name.in_(_TI_TOOL_CANDIDATES_360),
            Tool.tool_type == "http",
            Tool.enabled.is_(True),
        ).order_by(Tool.id).first()
        if tool is None:
            return None, None
        return load_tool_function(tool), tool.name
    except Exception as exc:  # noqa: BLE001
        logger.warning("360 威胁情报工具加载失败: %s", exc)
        return None, None
    finally:
        db.close()


def _query_360_batch(entities: list[str]) -> list[dict]:
    """并发查询 360 威胁情报（category 按实体类型自动识别：IP→ip，域名→domain）。

    工具未注册/禁用时返回空列表（调用方对条目不写 ``ti_360`` 键，
    前端不渲染 360 卡片）；单实体查询失败返回 ``{"error": "..."}``
    （条目 ``ti_360=None``，前端按失败态展示并支持重新研判重试）。
    """
    tool_run, tool_name = _load_ti_tool_run_360()
    if tool_run is None:
        logger.warning(
            "360 威胁情报工具未注册或已禁用（候选: %s），安全上下文跳过 360 研判",
            "、".join(_TI_TOOL_CANDIDATES_360),
        )
        return []

    async def _gather():
        sem = asyncio.Semaphore(INTEL_CONCURRENCY)

        async def _one(entity: str) -> dict:
            async with sem:
                try:
                    resp = await tool_run(query=entity, category=_ioc_category(entity))
                    return _normalize_360_result(entity, resp, tool_name=tool_name)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("360 威胁情报查询失败, entity=%s: %s", entity, exc)
                    return {"error": f"查询失败: {exc}", "entity": entity}

        return await asyncio.gather(*[_one(e) for e in entities])

    return asyncio.run(_gather())


# ---------------------------------------------------------------------------
# 360 IP 情报批量查询（IP 地区信息）：加载 / 提取 / 批量查询
# ---------------------------------------------------------------------------

IP_BATCH_TOOL_NAME_360 = "get_threat_互联网_360_ip_batch"
_TI_TOOL_CANDIDATES_360_IP_BATCH = (
    IP_BATCH_TOOL_NAME_360,
)

# IP 批量查询接口单次上限（文档口径：最多 50 个 IP）
_360_IP_BATCH_SIZE = 50

# 地区信息未知兜底文案（工具缺失/调用失败/未返回地区信息时填充）
_GEO_UNKNOWN_TEXT = "地区信息未知"


def _geo_unknown() -> dict:
    """地区信息未知兜底结构（前端整体展示「地区信息未知」）。"""
    return {"region_text": _GEO_UNKNOWN_TEXT, "unknown": True}


def _normalize_360_ip_geo(geo: dict) -> dict:
    """geo_info → 结构化地区字段 + 拼接文本 ``region_text``。

    拼接格式（结构化字段 + 摘要文本二合一，各项缺省自动跳过）::

        region_text = "国家 省份 城市 · 运营商/注册机构 · ASN AS组织"
        # 例："中国 上海市 上海市 · 阿里云 · AS37963 CNNIC-ALIBABA-CN-NET-AP"

    全部字段为空视为「未返回地区信息」，返回兜底结构由调用方统一处理。
    """
    country = str(geo.get("country") or "").strip()
    province = str(geo.get("province") or "").strip()
    city = str(geo.get("city") or "").strip()
    operator = str(geo.get("operator") or "").strip()
    as_org = str(geo.get("as") or "").strip()
    # asn=0（如私网 IP 返回的全空 geo_info）视为无效，避免拼出「AS0」
    try:
        asn_num = int(geo.get("asn")) if geo.get("asn") not in (None, "") else None
    except (TypeError, ValueError):
        asn_num = None
    asn = asn_num if asn_num is not None and asn_num > 0 else None
    if asn is not None:
        asn_text = f"AS{asn}" + (f" {as_org}" if as_org else "")
    elif as_org:
        asn_text = as_org
    else:
        asn_text = ""
    location = " ".join(x for x in (country, province, city) if x)
    parts = [p for p in (location, operator, asn_text) if p]
    if not parts:
        return _geo_unknown()
    return {
        "country": country,
        "province": province,
        "city": city,
        "operator": operator,
        "as_org": as_org,
        "asn": asn,
        "region_text": " · ".join(parts),
    }


def _extract_360_ip_batch_geo(resp: object) -> dict[str, dict]:
    """解析 360 IP 情报批量查询响应 → ``{ip: geo_info 结构}``。

    响应结构（errno=2000 业务成功）::

        {"errno": 2000, "result": {"<ip>": {"tags": [...], "summary": {
            "geo_info": {"country", "province", "city", "operator", "as", "asn"},
            ...}}}, "invalid": []}

    ``invalid`` 中与 ``result`` 未覆盖的 IP 不进入返回（调用方按
    「地区信息未知」兜底）；响应非对象 / 工具错误 / errno != 2000 抛
    ValueError（由批量查询函数按批降级为空 map）。
    """
    if not isinstance(resp, dict):
        raise ValueError(f"360 IP 批量工具返回非对象结果: {type(resp).__name__}")
    if resp.get("error"):
        raise ValueError(f"360 IP 批量工具返回错误: {resp.get('error')}")
    try:
        errno = int(resp.get("errno") or 0)
    except (TypeError, ValueError):
        errno = -1
    if errno != 2000:
        raise ValueError(f"360 IP 批量接口业务错误: errno={errno}, msg={resp.get('msg')}")
    result = resp.get("result")
    if not isinstance(result, dict):
        return {}
    out: dict[str, dict] = {}
    for ip, item in result.items():
        if not isinstance(item, dict):
            continue
        summary = item.get("summary") if isinstance(item.get("summary"), dict) else item
        geo = summary.get("geo_info")
        if not isinstance(geo, dict):
            continue
        normalized = _normalize_360_ip_geo(geo)
        if not normalized.get("unknown"):
            out[ip] = normalized
    return out


def _load_ip_batch_tool_run_360():
    """加载 360 IP 情报批量查询 HTTP 工具（候选名精确匹配）。

    工具缺失/禁用/加载失败返回 ``(None, None)``（调用方按
    「地区信息未知」兜底，不阻断其余研判链路）。
    """
    from app.core.tool_runner import load_tool_function
    from app.database import SessionLocal
    from app.models.tool import Tool

    db = SessionLocal()
    try:
        tool = db.query(Tool).filter(
            Tool.name.in_(_TI_TOOL_CANDIDATES_360_IP_BATCH),
            Tool.tool_type == "http",
            Tool.enabled.is_(True),
        ).order_by(Tool.id).first()
        if tool is None:
            return None, None
        return load_tool_function(tool), tool.name
    except Exception as exc:  # noqa: BLE001
        logger.warning("360 IP 批量查询工具加载失败: %s", exc)
        return None, None
    finally:
        db.close()


def _query_360_ip_batch_geo(ips: list[str]) -> dict[str, dict]:
    """批量查询 IP 地区情报 → ``{ip: geo_info}``（仅 IP 实体，域名不适用）。

    按 360 接口单次上限（50 个）自动分批、信号量并发查询；工具未注册/
    禁用/单批失败时对应 IP 不进入返回（调用方统一兜底「地区信息未知」），
    不影响原有威胁情报链路。
    """
    if not ips:
        return {}
    tool_run, _tool_name = _load_ip_batch_tool_run_360()
    if tool_run is None:
        logger.warning(
            "360 IP 批量查询工具未注册或已禁用（候选: %s），地区信息按「未知」兜底",
            "、".join(_TI_TOOL_CANDIDATES_360_IP_BATCH),
        )
        return {}
    batches = [
        ips[i:i + _360_IP_BATCH_SIZE]
        for i in range(0, len(ips), _360_IP_BATCH_SIZE)
    ]

    async def _gather():
        sem = asyncio.Semaphore(INTEL_CONCURRENCY)

        async def _one(batch: list[str]) -> dict[str, dict]:
            async with sem:
                try:
                    resp = await tool_run(param=",".join(batch))
                    return _extract_360_ip_batch_geo(resp)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "360 IP 批量查询失败（%s 等 %d 个 IP）: %s",
                        batch[0], len(batch), exc,
                    )
                    return {}

        maps = await asyncio.gather(*[_one(b) for b in batches])
        merged: dict[str, dict] = {}
        for m in maps:
            merged.update(m)
        return merged

    return asyncio.run(_gather())


# ---------------------------------------------------------------------------
# v2 多 IP：查询执行 / 存储分级 / 统计
# ---------------------------------------------------------------------------

def _query_assets(db, ips: list[str]) -> dict[str, tuple[dict, Optional[str]]]:
    """批量资产匹配：``{ip: (asset, error)}`。

    多 IP 时用线程池 + **每线程独立 Session**（SQLAlchemy Session 非线程
    安全，且资产发现为外部 HTTP 调用）；单 IP 直接复用调用方 Session
    （与旧实现一致，便于测试注入 fake db）。
    """
    out: dict[str, tuple[dict, Optional[str]]] = {}
    if not ips:
        return out

    def _one(ip: str, session) -> tuple[str, dict, Optional[str]]:
        try:
            return ip, _match_asset(session, ip), None
        except Exception as exc:  # noqa: BLE001
            logger.warning("工单资产匹配失败, ip=%s: %s", ip, exc)
            return ip, {"matched": False, "error": str(exc)}, f"{ip} 资产匹配失败: {exc}"

    if len(ips) == 1:
        ip, asset, err = _one(ips[0], db)
        out[ip] = (asset, err)
        return out

    from app.database import SessionLocal

    def _task(ip: str):
        session = SessionLocal()
        try:
            return _one(ip, session)
        finally:
            session.close()

    from concurrent.futures import ThreadPoolExecutor

    workers = min(ASSET_QUERY_WORKERS, len(ips))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for ip, asset, err in pool.map(_task, ips):
            out[ip] = (asset, err)
    return out


def _asset_criticality(asset: dict | None) -> str:
    """提取资产清单命中的重要性字段（兼容 v1 旧结构 fields 挂 asset 本体）。"""
    if not isinstance(asset, dict) or not asset.get("matched"):
        return ""
    fields = None
    if isinstance(asset.get("inventory"), dict):
        fields = asset["inventory"].get("fields")
    if not isinstance(fields, dict) and isinstance(asset.get("fields"), dict):
        fields = asset["fields"]
    return str((fields or {}).get("criticality") or "")


def _entry_tier(idx: int, asset: dict | None, threat: dict | None, ti360: dict | None = None) -> str:
    """存储分级：风险实体保留全字段（full），其余精简（lite）。

    360 情报中危（level ≥ 60）及以上的实体也升为 full（任一情报源
    命中恶意即保留全量明细）。
    """
    if idx < LITE_FULL_TOP:
        return "full"
    if isinstance(threat, dict):
        if threat.get("is_malicious"):
            return "full"
        if threat.get("severity") in ("high", "critical"):
            return "full"
    if isinstance(ti360, dict) and _ti360_max_level(ti360) >= 60:
        return "full"
    if _asset_criticality(asset) in ("high", "critical"):
        return "full"
    return "lite"


def _ti360_max_level(ti360: dict) -> int:
    """取 360 情报结果中的最高危害等级（level 0-100；无结果返回 -1）。"""
    levels = [r.get("level") or 0 for r in (ti360.get("results") or [])]
    return max(levels) if levels else -1


def _ti360_malicious(ti360) -> bool:
    """360 口径恶意判定：任一结果 level ≥ 60（中危起步视同恶意）。"""
    return isinstance(ti360, dict) and _ti360_max_level(ti360) >= 60


def _lite_asset(asset: dict) -> dict:
    """lite 档资产匹配：仅保留行内徽标与来源识别所需的精简键。"""
    return {
        "matched": bool(asset.get("matched")),
        "source": asset.get("source"),
        "source_label": asset.get("source_label"),
        "asset_name": asset.get("asset_name"),
        "asset_ip": asset.get("asset_ip"),
    }


def _lite_threat(threat: dict) -> dict:
    """lite 档威胁情报：仅保留结论级精简键（详情可重新研判升级 full）。"""
    geo = threat.get("geo_info") or {}
    return {
        "ip": threat.get("ip"),
        "is_malicious": threat.get("is_malicious"),
        "confidence": threat.get("confidence"),
        "severity": threat.get("severity"),
        "tags": (threat.get("tags") or [])[:3],
        "geo_info": {"country": geo.get("country"), "city": geo.get("city")},
        "source": threat.get("source"),
    }


def _lite_ti_360(ti360: dict) -> dict:
    """lite 档 360 情报：仅保留结论级精简键（详情可重新研判升级 full）。"""
    return {
        "entity": ti360.get("entity"),
        "category": ti360.get("category"),
        "tool_name": ti360.get("tool_name"),
        # 地区信息体量小，lite 档原样保留（IP 实体）
        "geo_info": ti360.get("geo_info"),
        "results": [
            {
                "ioc": r.get("ioc"),
                "ioc_type": r.get("ioc_type"),
                "level": r.get("level"),
                "level_label": r.get("level_label"),
                "confidence": r.get("confidence"),
                "status": r.get("status"),
                "status_label": r.get("status_label"),
                "malware": r.get("malware"),
                "tags": [
                    {"name": tg.get("name"), "severity": tg.get("severity")}
                    for tg in (r.get("tags") or [])[:2]
                ],
            }
            for r in (ti360.get("results") or [])
        ],
    }


def _apply_tier(entry: dict, idx: int, force_full: bool = False) -> None:
    """按分级就地瘦身 entry：full 原样保留，lite 剔除大字段。"""
    if force_full:
        entry["detail"] = "full"
        return
    tier = _entry_tier(idx, entry.get("asset"), entry.get("threat"), entry.get("ti_360"))
    entry["detail"] = tier
    if tier == "lite":
        asset = entry.get("asset")
        if isinstance(asset, dict) and asset.get("matched"):
            entry["asset"] = _lite_asset(asset)
        threat = entry.get("threat")
        if isinstance(threat, dict):
            entry["threat"] = _lite_threat(threat)
        ti360 = entry.get("ti_360")
        if isinstance(ti360, dict):
            entry["ti_360"] = _lite_ti_360(ti360)


def _compute_stats(entries: list[dict], total_original: int | None = None) -> dict:
    """由 entries 计算 stats（发起构建与 requery 回写后共用）。

    pending 条目（后台研判中）不计入各风险维度；``intel_failed`` 以
    显式 ``threat=None`` 判定（未开启情报的条目无 threat 键，不算失败）；
    ``asset_failed`` 以 asset.error 键判定。``malicious`` /
    ``severity_high`` 为双情报源（知道创宇 + 360）去重口径：知道创宇
    ``is_malicious`` 或 360 level ≥ 60 记恶意；任一源高危记高危。
    """
    stats = {
        "total": len(entries),
        "src": sum(1 for e in entries if "src_ip" in (e.get("roles") or [])),
        "dst": sum(1 for e in entries if "dst_ip" in (e.get("roles") or [])),
        "domain": sum(1 for e in entries if e.get("entity_type") == "domain"),
        "malicious": 0,
        "severity_high": 0,
        "asset_matched": 0,
        "asset_critical": 0,
        "intel_failed": 0,
        "asset_failed": 0,
        "pending": any(e.get("pending") or e.get("requery_pending") for e in entries),
    }
    if total_original and total_original > stats["total"]:
        stats["total_original"] = total_original
    for e in entries:
        if e.get("pending") or e.get("requery_pending"):
            continue
        malicious = False
        severity_high = False
        t = e.get("threat")
        if t is None and "threat" in e:
            stats["intel_failed"] += 1
        elif isinstance(t, dict):
            if t.get("is_malicious"):
                malicious = True
            if t.get("severity") in ("high", "critical"):
                severity_high = True
        ti360 = e.get("ti_360")
        if isinstance(ti360, dict) and ti360.get("results"):
            levels = [r.get("level") or 0 for r in ti360["results"]]
            if any(lv >= 60 for lv in levels):
                malicious = True
            if any(lv >= 70 for lv in levels):
                severity_high = True
        if malicious:
            stats["malicious"] += 1
        if severity_high:
            stats["severity_high"] += 1
        a = e.get("asset")
        if isinstance(a, dict):
            if a.get("error"):
                stats["asset_failed"] += 1
            if a.get("matched"):
                stats["asset_matched"] += 1
                if _asset_criticality(a) in ("high", "critical"):
                    stats["asset_critical"] += 1
    return stats


def _query_and_build_entries(
    db, plan_ips: list[dict], force_full: bool = False
) -> tuple[list[dict], list[str]]:
    """对 plan_ips（``[{ip, roles, asset, intel, agent}]``）执行查询并组装 entries。

    实体可为 IP 或域名（``ip`` 键承载），按实体类型自动分流：
    资产匹配 / 知道创宇情报 / 智能体研判仅对 IP 实体生效；
    360 情报对 IP 与域名均可（category 按实体类型自动识别）。

    返回 ``(entries, errors)``：entries 与 plan_ips 等长同序；agent 仅写
    ``{"pending": True}`` 占位（由后台线程完成）。360 结果写入
    ``entry["ti_360"]``（工具未注册时不写键，前端不渲染 360 卡片；
    查询失败写 ``None``，前端按失败态展示）；IP 实体另将 360 IP 批量
    情报的地区信息拼接至 ``ti_360.geo_info``（批量查询失败/未返回
    地区时兜底「地区信息未知」，域名实体不适用不写键）。
    """
    # 资产匹配与知道创宇情报仅支持 IP 实体
    asset_ips = [p["ip"] for p in plan_ips if p.get("asset") and _is_entity_ip(p["ip"])]
    intel_ips = [p["ip"] for p in plan_ips if p.get("intel") and _is_entity_ip(p["ip"])]
    # 360 情报支持 IP 与域名：intel 开启的实体全部参与
    entities_360 = [p["ip"] for p in plan_ips if p.get("intel")]
    assets = _query_assets(db, asset_ips)
    threats = _query_threat_intel_batch(intel_ips) if intel_ips else []
    threat_map = dict(zip(intel_ips, threats))
    ti360_map = dict(zip(entities_360, _query_360_batch(entities_360))) if entities_360 else {}
    # 360 IP 批量情报（地区信息）：仅 IP 实体适用；查询失败/未返回地区
    # 由下方条目组装时统一兜底「地区信息未知」，不影响原有情报链路
    geo_map = _query_360_ip_batch_geo(
        [e for e in entities_360 if _is_entity_ip(e)]
    )

    entries: list[dict] = []
    errors: list[str] = []
    for idx, p in enumerate(plan_ips):
        ip = p["ip"]
        is_domain = not _is_entity_ip(ip)
        entry: dict = {"ip": ip, "roles": list(p.get("roles") or [])}
        if is_domain:
            entry["entity_type"] = "domain"
        if p.get("asset") and not is_domain:
            asset, err = assets.get(ip, ({"matched": False}, None))
            entry["asset"] = asset
            if err:
                errors.append(err)
        if p.get("intel"):
            if not is_domain:
                # 知道创宇情报（IP 情报源，仅支持 IP 实体）
                t = threat_map.get(ip)
                if isinstance(t, dict) and not t.get("error"):
                    entry["threat"] = t
                else:
                    entry["threat"] = None
                    reason = t.get("error") if isinstance(t, dict) else "未知错误"
                    errors.append(f"{ip} 威胁情报查询失败: {reason}")
            # 360 情报（IP 与域名均可，category 自动识别）
            if ip in ti360_map:
                t360 = ti360_map[ip]
                if isinstance(t360, dict) and not t360.get("error"):
                    entry["ti_360"] = t360
                    if not is_domain:
                        # 360 IP 批量情报地区信息拼接到 ti_360.geo_info
                        # （查询失败/未返回地区兜底「地区信息未知」，不中断流程）
                        entry["ti_360"]["geo_info"] = geo_map.get(ip) or _geo_unknown()
                else:
                    entry["ti_360"] = None
                    reason = t360.get("error") if isinstance(t360, dict) else "未知错误"
                    errors.append(f"{ip} 360威胁情报查询失败: {reason}")
        if p.get("agent") and not is_domain:
            entry["agent"] = {"pending": True}
        _apply_tier(entry, idx, force_full=force_full)
        entries.append(entry)
    return entries, errors


# ---------------------------------------------------------------------------
# 智能体研判（仅保留展示字段；处置结果不落库不展示）
# ---------------------------------------------------------------------------

_AGENT_FIELDS = ("risk_level", "action", "monitoring_advice", "reasons")

# 未配置 BAN_ANALYST_AGENT_ID 时按名称兜底查找的智能体名
_TICKET_AGENT_NAME = "IP风险智能研判与封禁决策"


def _resolve_agent_id(db) -> Optional[int]:
    """解析工单智能体研判使用的智能体 ID。

    优先 ``BAN_ANALYST_AGENT_ID``（与封禁工作流一致）；
    未配置时按名称查找「IP风险智能研判与封禁决策」
    （published 状态，同名取最新）。找不到返回 None。
    """
    from app.config import settings
    from app.models.agent import Agent

    agent_id = int(getattr(settings, "BAN_ANALYST_AGENT_ID", 0) or 0)
    if agent_id > 0:
        return agent_id
    agent = (
        db.query(Agent)
        .filter(Agent.name == _TICKET_AGENT_NAME, Agent.publish_status == "published")
        .order_by(Agent.id.desc())
        .first()
    )
    return agent.id if agent else None


def _run_agent_analysis(db, ip: str, title: str) -> dict:
    """调用 IP 风险研判智能体（「IP风险智能研判与封禁决策」）并过滤结果。

    复用 ``agent_client.analyze_ip_risk``（输出模式 ban_risk_analyze，
    含重试与调用审计日志；生产经 ``BAN_ANALYST_AGENT_ID`` 指定智能体，
    未配置时按名称兜底查找；dev/staging 均不可用时回退 HTTP mock）。
    失败向上抛出由调用方记入 errors。

    Returns:
        仅含 ``_AGENT_FIELDS`` 的 dict（处置结果字段已剔除）。
    """
    from app.workflow.agent_client import analyze_ip_risk

    agent_id = _resolve_agent_id(db)
    if agent_id is None:
        raise ValueError(
            f"未找到已发布的智能体「{_TICKET_AGENT_NAME}」，"
            "请在平台创建该智能体或配置 BAN_ANALYST_AGENT_ID"
        )
    decision = analyze_ip_risk(
        ip,
        {"alert_name": title or ""},
        instance_id=None,
        node_key="ticket_enrichment",
        agent_id=agent_id,
    )
    if not isinstance(decision, dict):
        raise ValueError(f"智能体研判返回结构异常: {type(decision).__name__}")
    return {f: decision.get(f) for f in _AGENT_FIELDS}


def _writeback_agent_results(session, ticket_id: int, results: dict, errors: list[str]) -> None:
    """把智能体研判结果回写到 v2 ``enrichment_data.ips[].agent``。

    必须在深拷贝副本上修改并 ``flag_modified``：直接原地改旧对象会污染
    属性历史快照，导致 SQLAlchemy 判定"新旧值相等"而不生成 UPDATE。
    """
    from app.models.ticket import Ticket

    # 行锁：智能体回写与 enrichment/requery 回写并发时避免 JSON 列丢失更新
    ticket = (
        session.query(Ticket)
        .filter(Ticket.id == ticket_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if ticket is None or not isinstance(ticket.enrichment_data, dict):
        logger.warning("工单智能体研判回写跳过: ticket=%s 不存在或无研判数据", ticket_id)
        return
    data = copy.deepcopy(ticket.enrichment_data)
    for e in _enrichment_entries(data):
        if e.get("ip") in results and isinstance(e.get("agent"), dict) and e["agent"].get("pending"):
            e["agent"] = results[e["ip"]]
    if errors:
        data.setdefault("errors", []).extend(errors)
    ticket.enrichment_data = data
    flag_modified(ticket, "enrichment_data")
    session.commit()


def _run_agent_analysis_for_ips(session, ticket_id: int, ips: list[str], title: str) -> None:
    """逐 IP 智能体研判并回写（v2：按 ip 匹配 entries）。"""
    results: dict[str, dict | None] = {}
    errors: list[str] = []
    for ip in ips:
        try:
            results[ip] = _run_agent_analysis(session, ip, title)
        except Exception as exc:  # noqa: BLE001
            logger.warning("工单智能体研判失败, ip=%s: %s", ip, exc)
            results[ip] = None
            errors.append(f"{ip} 智能体研判失败: {exc}")
    _writeback_agent_results(session, ticket_id, results, errors)
    logger.info(
        "工单智能体研判回写完成: ticket=%s, ip数=%d, 失败=%d",
        ticket_id, len(ips), len(errors),
    )


def start_agent_analysis_bg(ticket_id: int, ips: list[str], title: str) -> None:
    """启动后台线程执行智能体研判（发起工单后调用，立即返回不阻塞）。

    Args:
        ticket_id: 已落库的工单 ID。
        ips: 待研判 IP 列表（auto_agent 开启的条目）。
        title: 工单标题（智能体告警上下文）。
    """
    if not ips:
        return
    _submit_bg_task(f"agent:{ticket_id}", _agent_bg_worker, ticket_id, ips, title)


def _agent_bg_worker(ticket_id: int, ips: list[str], title: str) -> None:
    """后台线程：独立 Session 逐 IP 研判并回写（不阻塞工单发起）。"""
    from app.database import LinkageSessionLocal

    session = LinkageSessionLocal()
    try:
        _run_agent_analysis_for_ips(session, ticket_id, ips, title)
    except Exception:  # noqa: BLE001
        session.rollback()
        logger.exception("工单智能体研判后台任务异常: ticket=%s", ticket_id)
    finally:
        session.close()


# ---------------------------------------------------------------------------
# 多 IP 研判构建（同步 / 后台）
# ---------------------------------------------------------------------------

def build_ticket_enrichment(
    db, field_defs: list, values: dict, title: str = ""
) -> tuple[Optional[dict], Optional[dict], list[str]]:
    """构建工单自动研判 v2（多 IP）。

    Returns:
        ``(enrichment, bg_plan, agent_ips)``：
        - ``enrichment``：完整研判结果；IP 数超过 ``SYNC_ENRICH_LIMIT``
          时为 pending 占位结构（stats.pending=True，条目仅含
          ip/roles/pending），由调用方在工单落库后调用
          ``start_enrichment_bg`` 补全；
        - ``bg_plan``：非 None 表示需要后台补全；
        - ``agent_ips``：同步模式下需要智能体研判的 IP（由调用方调用
          ``start_agent_analysis_bg``；后台模式下由 enrichment worker
          内部链式执行，避免双线程并发回写相互覆盖）。

        无有效 IP 或全部开关关闭时返回 ``(None, None, [])``。
    """
    located = _locate_ip_fields(field_defs, values)
    if not located:
        return None, None, []
    order, flags_map = _merge_role_ips(located)
    if not order:
        return None, None, []
    # 全部开关关闭：无需研判
    if not any(f["asset"] or f["intel"] or f["agent"] for f in flags_map.values()):
        return None, None, []

    role_labels = {item["role"]: item["label"] for item in located}
    errors: list[str] = []
    for item in located:
        for token in item.get("skipped") or []:
            errors.append(
                f"{item['label']} 含不参与自动研判的条目：{token}"
                "（自动研判仅支持单个 IP 或域名，网段/范围/文本条目已跳过）"
            )

    truncated = len(order) > MAX_ENRICH_IPS
    if truncated:
        errors.append(
            f"IP 共 {len(order)} 个，超过自动研判上限 {MAX_ENRICH_IPS}，"
            f"仅研判前 {MAX_ENRICH_IPS} 个"
        )
    ips = order[:MAX_ENRICH_IPS]
    plan_ips = [{"ip": ip, **flags_map[ip]} for ip in ips]

    def _base_stats(pending: bool) -> dict:
        return {
            "total": len(ips),
            "src": sum(1 for p in plan_ips if "src_ip" in p["roles"]),
            "dst": sum(1 for p in plan_ips if "dst_ip" in p["roles"]),
            "malicious": 0, "severity_high": 0,
            "asset_matched": 0, "asset_critical": 0,
            "intel_failed": 0, "asset_failed": 0,
            "pending": pending,
            **({"total_original": len(order)} if truncated else {}),
        }

    # IP 数超过同步阈值：先落 pending 占位，工单落库后由后台线程补全
    if len(ips) > SYNC_ENRICH_LIMIT:
        shell_entries = [
            {
                "ip": p["ip"],
                "roles": list(p["roles"]),
                "pending": True,
                # 进程重启后 resume_pending_enrichments 按此恢复每个 IP 的查询开关
                "pending_flags": {
                    "asset": bool(p.get("asset")),
                    "intel": bool(p.get("intel")),
                    "agent": bool(p.get("agent")),
                },
            }
            for p in plan_ips
        ]
        enrichment = {
            "version": 2,
            "ips": shell_entries,
            "role_labels": role_labels,
            "stats": _base_stats(pending=True),
            "enriched_at": beijing_now().isoformat(),
            "errors": errors,
        }
        bg_plan = {"ips": plan_ips, "role_labels": role_labels}
        return enrichment, bg_plan, []

    entries, query_errors = _query_and_build_entries(db, plan_ips)
    errors.extend(query_errors)
    enrichment = {
        "version": 2,
        "ips": entries,
        "role_labels": role_labels,
        "stats": _compute_stats(entries, total_original=len(order) if truncated else None),
        "enriched_at": beijing_now().isoformat(),
        "errors": errors,
    }
    agent_ips = [e["ip"] for e in entries if isinstance(e.get("agent"), dict)]
    logger.info(
        "工单自动研判完成(v2): ip数=%d, 资产命中=%d, 情报恶意=%d, 智能体=%d, 错误=%d",
        len(entries),
        enrichment["stats"]["asset_matched"],
        enrichment["stats"]["malicious"],
        len(agent_ips),
        len(errors),
    )
    return enrichment, None, agent_ips


def _enrichment_bg_worker(ticket_id: int, plan: dict, title: str) -> None:
    """后台线程：批量补全 pending 占位条目并回写，完成后链式执行智能体研判。"""
    from app.database import LinkageSessionLocal
    from app.models.ticket import Ticket

    session = LinkageSessionLocal()
    try:
        entries, errors = _query_and_build_entries(session, plan["ips"])
        # 行锁：查询完成后才加锁，锁窗口仅覆盖合并与提交（只锁单行）
        ticket = (
            session.query(Ticket)
            .filter(Ticket.id == ticket_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        if ticket is None or not isinstance(ticket.enrichment_data, dict):
            logger.warning("工单自动研判回写跳过: ticket=%s 不存在或无研判数据", ticket_id)
            return
        data = copy.deepcopy(ticket.enrichment_data)
        by_ip = {e["ip"]: e for e in entries}
        merged: list[dict] = []
        for old in _enrichment_entries(data):
            fresh = by_ip.get(old.get("ip"))
            if old.get("pending") and fresh is not None:
                fresh["roles"] = old.get("roles") or fresh.get("roles") or []
                merged.append(fresh)
            else:
                merged.append(old)
        data["ips"] = merged
        data["stats"] = _compute_stats(
            merged, total_original=data.get("stats", {}).get("total_original")
        )
        if errors:
            data.setdefault("errors", []).extend(errors)
        data["enriched_at"] = beijing_now().isoformat()
        ticket.enrichment_data = data
        flag_modified(ticket, "enrichment_data")
        session.commit()
        logger.info(
            "工单自动研判后台回写完成: ticket=%s, ip数=%d, 错误=%d",
            ticket_id, len(merged), len(errors),
        )
        # 链式执行智能体研判（同线程串行，避免与 enrichment 回写并发覆盖；
        # 智能体仅支持 IP 研判，域名实体跳过）
        agent_ips = [
            p["ip"] for p in plan["ips"] if p.get("agent") and _is_entity_ip(p["ip"])
        ]
        if agent_ips:
            _run_agent_analysis_for_ips(session, ticket_id, agent_ips, title)
    except Exception:  # noqa: BLE001
        session.rollback()
        logger.exception("工单自动研判后台任务异常: ticket=%s", ticket_id)
    finally:
        session.close()


def start_enrichment_bg(ticket_id: int, plan: dict, title: str) -> None:
    """启动后台线程补全多 IP 研判（工单落库后调用，立即返回不阻塞）。"""
    if not plan:
        return
    _submit_bg_task(f"enrich:{ticket_id}", _enrichment_bg_worker, ticket_id, plan, title)


# ---------------------------------------------------------------------------
# 重新研判（requery）：对指定 IP 重跑资产匹配 + 威胁情报并升级为 full
# ---------------------------------------------------------------------------

def requery_ticket_enrichment(db, ticket, ips: list[str]) -> dict:
    """重新研判安全上下文指定 IP（同步路径；commit 由调用方负责）。

    - 每次重查同时执行资产匹配 + 威胁情报，结果升级为 full 档；
    - 目标超过 ``SYNC_ENRICH_LIMIT`` 时在条目上打 ``requery_pending``
      标记并提交（本函数内 commit，保证标记对后台线程可见），再由
      ``start_requery_bg`` 后台补全，返回 ``pending=True``；
    - 不在工单研判 IP 集合内的请求 IP 记入 ``unknown`` 返回。

    Returns:
        ``{"updated": n, "unknown": [...], "pending": bool}``
    Raises:
        ValueError: 工单无 v2 研判数据（存量 v1 工单不支持）。
    """
    data = ticket.enrichment_data
    if not isinstance(data, dict) or not isinstance(data.get("ips"), list):
        raise ValueError("该工单的研判数据为存量结构，不支持重新研判")
    known = {e.get("ip"): e for e in _enrichment_entries(data) if e.get("ip")}
    unknown = [ip for ip in ips if ip not in known]
    targets = [ip for ip in ips if ip in known]
    if not targets:
        return {"updated": 0, "unknown": unknown, "pending": False}

    total_original = data.get("stats", {}).get("total_original")

    # 超过同步阈值：打标 + commit + 后台线程补全
    if len(targets) > SYNC_ENRICH_LIMIT:
        fresh = copy.deepcopy(data)
        marked = 0
        for e in _enrichment_entries(fresh):
            if e.get("ip") in targets and not e.get("requery_pending"):
                e["requery_pending"] = True
                marked += 1
        fresh["stats"] = _compute_stats(_enrichment_entries(fresh), total_original=total_original)
        ticket.enrichment_data = fresh
        flag_modified(ticket, "enrichment_data")
        db.commit()
        start_requery_bg(ticket.id, targets)
        logger.info("工单重新研判转后台: ticket=%s, ip数=%d", ticket.id, len(targets))
        return {"updated": 0, "unknown": unknown, "pending": True}

    plan_ips = [
        {
            "ip": ip,
            "roles": list(known[ip].get("roles") or []),
            "asset": True,
            "intel": True,
        }
        for ip in targets
    ]
    entries, errors = _query_and_build_entries(db, plan_ips, force_full=True)
    # 查询耗时期间可能有并发的后台回写（如智能体研判完成）：合并前加行锁
    # 重读最新数据，避免用开跑前快照整体覆盖，导致对方结果丢失
    from app.models.ticket import Ticket

    locked = None
    if isinstance(ticket, Ticket):
        locked = (
            db.query(Ticket)
            .filter(Ticket.id == ticket.id)
            .populate_existing()
            .with_for_update()
            .first()
        )
    if locked is not None:
        ticket = locked
    else:
        refresh = getattr(db, "refresh", None)
        if callable(refresh):
            refresh(ticket)
    latest = ticket.enrichment_data if isinstance(ticket.enrichment_data, dict) else data
    fresh = copy.deepcopy(latest)
    by_ip = {e["ip"]: e for e in entries}
    for e in _enrichment_entries(fresh):
        new = by_ip.get(e.get("ip"))
        if new is None:
            continue
        # 保留原 roles 与 agent 结果（agent 重研判不在 requery 范围）
        new["roles"] = e.get("roles") or new.get("roles") or []
        if "agent" in e:
            new["agent"] = e["agent"]
        e.clear()
        e.update(new)
    if errors:
        fresh.setdefault("errors", []).extend(errors)
    fresh["stats"] = _compute_stats(_enrichment_entries(fresh), total_original=total_original)
    ticket.enrichment_data = fresh
    flag_modified(ticket, "enrichment_data")
    logger.info(
        "工单重新研判完成: ticket=%s, ip数=%d, unknown=%d, 错误=%d",
        ticket.id, len(entries), len(unknown), len(errors),
    )
    return {"updated": len(entries), "unknown": unknown, "pending": False}


def _requery_bg_worker(ticket_id: int, ips: list[str]) -> None:
    """后台线程：补全 requery_pending 条目（重查 + 升级 full）并回写。"""
    from app.database import LinkageSessionLocal
    from app.models.ticket import Ticket

    session = LinkageSessionLocal()
    try:
        ticket = session.query(Ticket).filter(Ticket.id == ticket_id).first()
        if ticket is None or not isinstance(ticket.enrichment_data, dict):
            logger.warning("工单重新研判回写跳过: ticket=%s 不存在或无研判数据", ticket_id)
            return
        data = ticket.enrichment_data
        known = {e.get("ip"): e for e in _enrichment_entries(data) if e.get("ip")}
        plan_ips = [
            {
                "ip": ip,
                "roles": list(known.get(ip, {}).get("roles") or []),
                "asset": True,
                "intel": True,
            }
            for ip in ips
        ]
        entries, errors = _query_and_build_entries(session, plan_ips, force_full=True)
        # 查询期间并发的智能体研判回写不能被开跑前快照覆盖：加行锁并重读后再合并
        # （锁窗口仅覆盖合并与提交，只锁单行）
        locked = (
            session.query(Ticket)
            .filter(Ticket.id == ticket_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        if locked is None or not isinstance(locked.enrichment_data, dict):
            logger.warning("工单重新研判回写跳过: ticket=%s 不存在或无研判数据", ticket_id)
            return
        fresh = copy.deepcopy(locked.enrichment_data)
        by_ip = {e["ip"]: e for e in entries}
        for e in _enrichment_entries(fresh):
            new = by_ip.get(e.get("ip"))
            if new is None:
                continue
            new["roles"] = e.get("roles") or new.get("roles") or []
            if "agent" in e:
                new["agent"] = e["agent"]
            e.clear()
            e.update(new)
        if errors:
            fresh.setdefault("errors", []).extend(errors)
        fresh["stats"] = _compute_stats(
            _enrichment_entries(fresh),
            total_original=fresh.get("stats", {}).get("total_original"),
        )
        locked.enrichment_data = fresh
        flag_modified(locked, "enrichment_data")
        session.commit()
        logger.info(
            "工单重新研判后台回写完成: ticket=%s, ip数=%d, 错误=%d",
            ticket_id, len(entries), len(errors),
        )
    except Exception:  # noqa: BLE001
        session.rollback()
        logger.exception("工单重新研判后台任务异常: ticket=%s", ticket_id)
    finally:
        session.close()


def start_requery_bg(ticket_id: int, ips: list[str]) -> None:
    """启动后台线程执行重新研判（标记已由调用方先行落库）。"""
    if not ips:
        return
    _submit_bg_task(f"requery:{ticket_id}", _requery_bg_worker, ticket_id, ips)


def resume_pending_enrichments(db=None) -> dict:
    """恢复进程重启前遗留的 pending / requery_pending 研判任务。

    扫描 ``Ticket.enrichment_data`` 中的占位条目重新入队；启动时在
    ``app.main.lifespan`` 调用一次，避免进程重启后工单永久停留在 pending。
    ``db`` 为空时自建会话（只做扫描，实际查询由后台任务用联动连接池完成）。
    """
    from app.database import LinkageSessionLocal
    from app.models.ticket import Ticket

    own_session = db is None
    session = LinkageSessionLocal() if own_session else db
    try:
        rows = (
            session.query(Ticket.id, Ticket.title, Ticket.enrichment_data)
            .filter(Ticket.enrichment_data.isnot(None))
            .all()
        )
        resumed = requeued = 0
        for ticket_id, title, data in rows:
            entries = _enrichment_entries(data)
            if not entries:
                continue
            plan_ips: list[dict] = []
            requery_ips: list[str] = []
            for entry in entries:
                ip = entry.get("ip")
                if not ip:
                    continue
                if entry.get("requery_pending"):
                    requery_ips.append(ip)
                elif entry.get("pending"):
                    flags = entry.get("pending_flags") or {}
                    plan_ips.append({
                        "ip": ip,
                        "roles": list(entry.get("roles") or []),
                        "asset": flags.get("asset", True),
                        "intel": flags.get("intel", True),
                        "agent": flags.get("agent", False),
                    })
            if plan_ips:
                start_enrichment_bg(
                    ticket_id,
                    {"ips": plan_ips, "role_labels": (data or {}).get("role_labels") or {}},
                    title or "",
                )
                resumed += 1
            if requery_ips:
                start_requery_bg(ticket_id, requery_ips)
                requeued += 1
        if resumed or requeued:
            logger.info(
                "恢复未完成的工单研判: pending=%d requery=%d", resumed, requeued
            )
        return {"pending": resumed, "requery": requeued}
    finally:
        if own_session:
            session.close()
