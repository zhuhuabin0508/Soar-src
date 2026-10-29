"""工单发起时自动研判：源/目的 IP 资产匹配 + 威胁情报查询 + 智能体研判。

发起工单时对首节点 ``src_ip`` / ``dst_ip`` 字段自动执行（按字段开关）：
1. 资产匹配（``auto_asset``，默认开启）：**两个来源都查**——资产发现
   （综合运管平台，IP 精确匹配，与智能体检索同口径）与资产清单
   （复用告警资产富化 AssetLibEnricher 的索引：单 IP 精确 + CIDR/
   起止范围包含，内存缓存 TTL 600s）。资产发现优先级更高：
   ``asset.source`` 为主命中来源（发现命中 ``"asset_discovery"``，
   否则清单命中 ``"asset_inventory"``），``discovery`` / ``inventory``
   键各携完整命中结果（可同时命中并列展示）；
2. 威胁情报（``auto_intel``，默认开启）：复用工具 ``get_threat_intel``
   （app.tools.context_tools），与智能体工具 API 调用一致；
3. 智能体研判（``auto_agent``，默认关闭）：调用 IP 风险研判智能体
   （``agent_client.analyze_ip_risk``，即「IP风险智能研判与封禁决策」，
   经 ``BAN_ANALYST_AGENT_ID`` 指定，输出模式 ban_risk_analyze）。
   结果仅保留 risk_level / action / monitoring_advice / reasons
   （风险等级 / 处置建议 / 决策依据），处置结果
   （is_banned / ban_plan / need_confirm）不落库不展示。

结果写入 ``Ticket.enrichment_data``（JSON），随工单全程流转，
各节点处理人只读可见。结构::

    {
      "sources": [
        {
          "role": "src_ip",              # src_ip / dst_ip
          "label": "源IP地址",            # 快照字段显示名
          "ip": "10.144.1.2",
          "asset": {"matched": true, "source": "asset_discovery",
                    "asset_name": "web-01", "asset_ip": "10.144.1.2",
                    "discovery": {...资产发现命中（resource_label/matches...）...},
                    "inventory": {...资产清单命中（asset_id/fields...）...}},
                                                # 两来源都查、发现优先；未命中 {"matched": false}
          "threat": {...get_threat_intel 原样返回...},
          "agent": {"risk_level": "高危", "action": "ban",
                    "monitoring_advice": "封禁后持续观察该网段",
                    "reasons": ["境外恶意 IP", ...]}
                                                # auto_agent 开启时字段；发起时为
                                                # {"pending": true}（后台研判中），
                                                # 完成后回写研判结果 / 失败为 null；
                                                # 未开启时无该键
        }
      ],
      "enriched_at": "2026-10-20T22:30:00",
      "errors": ["..."]     # 部分失败记录（不影响工单发起）
    }

设计要点：
- 字段定位：首节点字段中 type=ip 且 key 为 src_ip / dst_ip
  （兜底 alert_field_mapping 为 src_ip / dst_ip）；
- 开关：资产匹配 ``auto_asset`` 与威胁情报 ``auto_intel`` 独立控制
  （默认开启）；``auto_agent`` 显式为 True 时追加智能体研判
  （默认关闭）。兼容存量模板：字段仅有旧合并键 ``auto_enrich``
  （同时控制资产匹配与威胁情报）时，两个开关均按其值兜底；
- 多值 IP（逗号/分号分隔）取第一个有效地址；
- 单个来源研判失败仅记入 errors，不阻塞工单发起。
"""
import asyncio
import copy
import ipaddress
import logging
import threading
import time
from typing import Optional

from sqlalchemy.orm.attributes import flag_modified

from app.core.log_receiver_manager.pipeline.enricher_stage import (
    _ASSET_INDEX_TTL_S,
    _asset_index_cache,
    _asset_index_lock,
    _build_asset_index,
    _match_asset_ip,
)
from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# 参与自动研判的 IP 角色及兜底字段 key
_IP_ROLES = ("src_ip", "dst_ip")


def _extract_ip(value) -> Optional[str]:
    """字段值 → 首个有效 IP（支持逗号/分号分隔多值；无效返回 None）。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    for part in s.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ipaddress.ip_address(part)
            return part
        except ValueError:
            continue
    return None


def _locate_ip_fields(field_defs: list, values: dict) -> list[dict]:
    """从首节点字段定义中定位 src_ip / dst_ip 字段并提取有效 IP。

    匹配规则：字段 key 为 src_ip / dst_ip（兜底 alert_field_mapping），
    且字段值为有效 IP。返回 ``[{role, label, ip, asset, intel, agent}]``，
    其中 ``asset``（资产匹配）与 ``intel``（威胁情报）默认 True、
    ``agent``（智能体研判）默认 False；仅有旧合并键 ``auto_enrich``
    的存量模板按其值兜底。
    """
    found: list[dict] = []
    for f in field_defs or []:
        if not isinstance(f, dict):
            continue
        key = str(f.get("key") or "")
        mapping = str(f.get("alert_field_mapping") or "")
        role = key if key in _IP_ROLES else (mapping if mapping in _IP_ROLES else "")
        if not role or any(item["role"] == role for item in found):
            continue
        ip = _extract_ip(values.get(key))
        if not ip:
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
            "ip": ip,
            "asset": asset,
            "intel": intel,
            "agent": f.get("auto_agent") is True,
        })
    return found


# 资产发现命中的展示上限（安全上下文卡片展示够用，避免多命中撑爆）
_DISCOVERY_MATCH_LIMIT = 5


def _match_discovery_asset(db, ip: str) -> Optional[dict]:
    """查询资产发现（综合运管平台）数据。

    复用资产发现检索 ``_search_token`` 的 IP 精确匹配口径（IP 列 +
    extra_excel IP 键，全部资源类型），与智能体 ``search_assets`` /
    ``search_discovered_assets`` 工具一致。命中返回
    ``{resource_type, resource_label, asset_name, asset_ip, matches, truncated}``
    （``matches`` 为全部命中记录）；未命中返回 None；查询失败仅记日志
    返回 None（不影响工单发起）。
    """
    from app.agent.discovery_search import _search_token
    from app.api.v1.govcloud import RESOURCE_TYPES

    try:
        result = _search_token(db, ip, list(RESOURCE_TYPES.keys()), _DISCOVERY_MATCH_LIMIT)
    except Exception as exc:  # noqa: BLE001
        logger.warning("工单资产发现查询失败, ip=%s: %s", ip, exc)
        return None
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

    with _asset_index_lock:
        if time.time() - _asset_index_cache["built_at"] > _ASSET_INDEX_TTL_S:
            _build_asset_index(db)
        index = {
            "single": _asset_index_cache["single"],
            "nets": _asset_index_cache["nets"],
        }
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
    两来源均未命中返回 ``{"matched": False}``。
    """
    inventory = _match_inventory_asset(db, ip)
    discovery = _match_discovery_asset(db, ip)
    if inventory is None and discovery is None:
        return {"matched": False}
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
    return {
        "matched": True,
        **primary,
        "discovery": discovery,
        "inventory": inventory,
    }


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


def decorate_asset_source_labels(db, enrichment: dict | None) -> dict | None:
    """补齐 enrichment 中资产匹配的 ``source_label``（幂等，只补缺失键）。

    工单详情展示前调用：存量工单保存的 enrichment 没有来源标签，资产类型
    模板也可能被改名，按当前数据推导即可满足展示需要。返回深拷贝，避免
    ORM JSON 列被就地修改后误落库。
    """
    if not isinstance(enrichment, dict):
        return enrichment
    sources = enrichment.get("sources")
    if not isinstance(sources, list):
        return enrichment

    data = copy.deepcopy(enrichment)
    type_names: dict[str, str] | None = None
    for source in data.get("sources") or []:
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


def _query_threat_intel_batch(ips: list[str]) -> list[dict]:
    """并发调用 get_threat_intel（单事件循环跑完所有 IP，缩短发起耗时）。

    单个 IP 查询失败返回 ``{"error": "..."}``，不影响其余 IP。
    """
    from app.tools.context_tools import get_threat_intel

    async def _gather():
        async def _one(ip: str) -> dict:
            try:
                return await get_threat_intel(ip)
            except Exception as exc:  # noqa: BLE001
                logger.warning("威胁情报查询失败, ip=%s: %s", ip, exc)
                return {"error": f"查询失败: {exc}", "ip": ip}

        return await asyncio.gather(*[_one(ip) for ip in ips])

    return asyncio.run(_gather())


# 智能体研判结果仅保留的展示字段（风险等级 / 处置建议 / 决策依据）；
# 处置结果（is_banned / ban_plan / need_confirm 等）不落库不展示
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
        db, ip,
        {"alert_name": title or ""},
        instance_id=None,
        node_key="ticket_enrichment",
        agent_id=agent_id,
    )
    if not isinstance(decision, dict):
        raise ValueError(f"智能体研判返回结构异常: {type(decision).__name__}")
    return {f: decision.get(f) for f in _AGENT_FIELDS}


def _agent_bg_worker(ticket_id: int, tasks: list[tuple[str, str, str]], title: str) -> None:
    """后台线程：逐 IP 智能体研判并回写 ``enrichment_data``（不阻塞工单发起）。

    研判与回写共用独立 ``SessionLocal``（请求 Session 随响应关闭，不可跨线程）。
    前端轮询 ``agent.pending`` 占位消失即视为完成；本进程重启会丢失
    进行中的任务（占位将停留，dev 可接受）。
    """
    from app.database import SessionLocal
    from app.models.ticket import Ticket

    session = SessionLocal()
    try:
        results: dict[str, dict] = {}
        errors: list[str] = []
        for role, label, ip in tasks:
            try:
                results[role] = _run_agent_analysis(session, ip, title)
            except Exception as exc:  # noqa: BLE001
                logger.warning("工单智能体研判失败, ip=%s: %s", ip, exc)
                results[role] = None
                errors.append(f"{label} 智能体研判失败: {exc}")
        ticket = session.query(Ticket).filter(Ticket.id == ticket_id).first()
        if ticket is None or not isinstance(ticket.enrichment_data, dict):
            logger.warning("工单智能体研判回写跳过: ticket=%s 不存在或无研判数据", ticket_id)
            return
        # 必须在深拷贝副本上修改：直接原地改旧对象会污染属性历史快照，
        # 导致 SQLAlchemy 判定"新旧值相等"而不生成 UPDATE（回写静默丢失）
        data = copy.deepcopy(ticket.enrichment_data)
        for s in data.get("sources") or []:
            agent = s.get("agent")
            if s.get("role") in results and isinstance(agent, dict) and agent.get("pending"):
                s["agent"] = results[s["role"]]
        data.setdefault("errors", []).extend(errors)
        ticket.enrichment_data = data
        # JSON 列强制标记已修改，双保险绕过值相等性折叠
        flag_modified(ticket, "enrichment_data")
        session.commit()
        logger.info(
            "工单智能体研判回写完成: ticket=%s, ip数=%d, 失败=%d",
            ticket_id, len(tasks), len(errors),
        )
    except Exception:  # noqa: BLE001
        session.rollback()
        logger.exception("工单智能体研判后台任务异常: ticket=%s", ticket_id)
    finally:
        session.close()


def start_agent_analysis_bg(ticket_id: int, tasks: list[tuple[str, str, str]], title: str) -> None:
    """启动后台线程执行智能体研判（发起工单后调用，立即返回不阻塞）。

    Args:
        ticket_id: 已落库的工单 ID。
        tasks: ``[(role, label, ip)]`` 待研判列表（auto_agent 开启的 IP）。
        title: 工单标题（智能体告警上下文）。
    """
    if not tasks:
        return
    threading.Thread(
        target=_agent_bg_worker,
        args=(ticket_id, tasks, title),
        daemon=True,
        name=f"ticket-agent-{ticket_id}",
    ).start()


def build_ticket_enrichment(db, field_defs: list, values: dict, title: str = "") -> Optional[dict]:
    """构建工单自动研判结果（发起时调用一次）。

    Args:
        title: 工单标题，作为智能体研判的告警上下文（alert_name）。

    资产匹配与威胁情报按各自开关独立执行（毫秒级）；智能体研判仅写入
    ``{"pending": true}`` 占位，由 ``start_agent_analysis_bg`` 后台
    线程异步完成并回写（LLM 耗时较长，不阻塞工单发起与流转）。
    无有效 src_ip / dst_ip，或全部开关关闭时返回 None（不留空结构）。
    任何整体异常均向上抛出由调用方兜底；单来源失败记入 errors。
    """
    located = _locate_ip_fields(field_defs, values)
    if not located:
        return None
    # 全部开关关闭：无需研判
    if not any(item["asset"] or item["intel"] or item["agent"] for item in located):
        return None

    # 威胁情报批量并发查询（Mock 0.3-0.8s 延迟，并发后仅一次等待）；
    # 未开启威胁情报（auto_intel=False）的 IP 不参与批量
    intel_ips = [item["ip"] if item["intel"] else None for item in located]
    threats = _query_threat_intel_batch([ip for ip in intel_ips if ip])
    threat_iter = iter(threats)

    sources: list[dict] = []
    errors: list[str] = []
    for item in located:
        entry = {"role": item["role"], "label": item["label"], "ip": item["ip"]}
        if item["asset"]:
            try:
                entry["asset"] = _match_asset(db, item["ip"])
            except Exception as exc:  # noqa: BLE001
                logger.warning("工单资产匹配失败, ip=%s: %s", item["ip"], exc)
                entry["asset"] = {"matched": False}
                errors.append(f"{item['label']} 资产匹配失败: {exc}")
        if item["intel"]:
            threat = next(threat_iter)
            if isinstance(threat, dict) and not threat.get("error"):
                entry["threat"] = threat
            else:
                entry["threat"] = None
                errors.append(f"{item['label']} 威胁情报查询失败: {threat.get('error') if threat else '未知错误'}")
        if item["agent"]:
            # 智能体研判：仅写占位，由 start_agent_analysis_bg 后台异步完成
            entry["agent"] = {"pending": True}
        sources.append(entry)

    logger.info(
        "工单自动研判完成: roles=%s, 资产命中=%s/%d, 威胁情报=%d, 智能体研判=%d, 错误=%d",
        [item["role"] for item in located],
        sum(1 for s in sources if s.get("asset", {}).get("matched")),
        sum(1 for item in located if item["asset"]),
        sum(1 for item in located if item["intel"]),
        sum(1 for s in sources if s.get("agent")),
        len(errors),
    )
    return {
        "sources": sources,
        "enriched_at": beijing_now().isoformat(),
        "errors": errors,
    }
