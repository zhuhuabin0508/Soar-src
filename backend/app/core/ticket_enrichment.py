"""工单发起时自动研判（v2 多 IP）：源/目的 IP 资产匹配 + 威胁情报查询 + 智能体研判。

发起工单时对首节点 ``src_ip`` / ``dst_ip`` 字段自动执行（按字段开关）：
1. 资产匹配（``auto_asset``，默认开启）：**两个来源都查**——资产发现
   （综合运管平台，IP 精确匹配，与智能体检索同口径）与资产清单
   （复用告警资产富化 AssetLibEnricher 的索引：单 IP 精确 + CIDR/
   起止范围包含，内存缓存 TTL 600s）。资产发现优先级更高：
   ``asset.source`` 为主命中来源（发现命中 ``"asset_discovery"``，
   否则清单命中 ``"asset_inventory"``），``discovery`` / ``inventory``
   键各携完整命中结果（可同时命中并列展示）；
2. 威胁情报（``auto_intel``，默认开启）：复用工具 ``get_threat_intel``
   （app.tools.context_tools），并发批量查（信号量限流防打爆情报源）；
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
          "threat": {...get_threat_intel 原样，lite 时仅保留精简键...},
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
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Optional

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
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


def _extract_ips(value) -> tuple[list[str], list[str]]:
    """字段值 → (有效单 IP 列表, 非单 IP 条目列表)。

    多值表达式按逗号/分号分隔逐段校验：合法单 IP 进入研判；网段/
    范围/非法文本记入 skipped（调用方写入 errors 提示不参与研判）。
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
        try:
            ipaddress.ip_address(part)
        except ValueError:
            if part not in skipped:
                skipped.append(part)
            continue
        if part not in ips:
            ips.append(part)
    return ips, skipped


def _locate_ip_fields(field_defs: list, values: dict) -> list[dict]:
    """从首节点字段定义中定位 src_ip / dst_ip 字段并提取全部有效 IP。

    匹配规则：字段 key 为 src_ip / dst_ip（兜底 alert_field_mapping），
    且字段值含至少一个有效 IP。返回 ``[{role, label, ips, skipped,
    asset, intel, agent}]``，其中 ``asset``（资产匹配）与 ``intel``
    （威胁情报）默认 True、``agent``（智能体研判）默认 False；仅有旧
    合并键 ``auto_enrich`` 的存量模板按其值兜底。
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
        ips, skipped = _extract_ips(values.get(key))
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


def _query_threat_intel_batch(ips: list[str]) -> list[dict]:
    """并发调用 get_threat_intel（信号量限流，单事件循环跑完全部 IP）。

    单个 IP 查询失败返回 ``{"error": "..."}``，不影响其余 IP。
    """
    from app.tools.context_tools import get_threat_intel

    async def _gather():
        sem = asyncio.Semaphore(INTEL_CONCURRENCY)

        async def _one(ip: str) -> dict:
            async with sem:
                try:
                    return await get_threat_intel(ip)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("威胁情报查询失败, ip=%s: %s", ip, exc)
                    return {"error": f"查询失败: {exc}", "ip": ip}

        return await asyncio.gather(*[_one(ip) for ip in ips])

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


def _entry_tier(idx: int, asset: dict | None, threat: dict | None) -> str:
    """存储分级：风险 IP 保留全字段（full），其余精简（lite）。"""
    if idx < LITE_FULL_TOP:
        return "full"
    if isinstance(threat, dict):
        if threat.get("is_malicious"):
            return "full"
        if threat.get("severity") in ("high", "critical"):
            return "full"
    if _asset_criticality(asset) in ("high", "critical"):
        return "full"
    return "lite"


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


def _apply_tier(entry: dict, idx: int, force_full: bool = False) -> None:
    """按分级就地瘦身 entry：full 原样保留，lite 剔除大字段。"""
    if force_full:
        entry["detail"] = "full"
        return
    tier = _entry_tier(idx, entry.get("asset"), entry.get("threat"))
    entry["detail"] = tier
    if tier == "lite":
        asset = entry.get("asset")
        if isinstance(asset, dict) and asset.get("matched"):
            entry["asset"] = _lite_asset(asset)
        threat = entry.get("threat")
        if isinstance(threat, dict):
            entry["threat"] = _lite_threat(threat)


def _compute_stats(entries: list[dict], total_original: int | None = None) -> dict:
    """由 entries 计算 stats（发起构建与 requery 回写后共用）。

    pending 条目（后台研判中）不计入各风险维度；``intel_failed`` 以
    显式 ``threat=None`` 判定（未开启情报的条目无 threat 键，不算失败）；
    ``asset_failed`` 以 asset.error 键判定。
    """
    stats = {
        "total": len(entries),
        "src": sum(1 for e in entries if "src_ip" in (e.get("roles") or [])),
        "dst": sum(1 for e in entries if "dst_ip" in (e.get("roles") or [])),
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
        t = e.get("threat")
        if t is None and "threat" in e:
            stats["intel_failed"] += 1
        elif isinstance(t, dict):
            if t.get("is_malicious"):
                stats["malicious"] += 1
            if t.get("severity") in ("high", "critical"):
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

    返回 ``(entries, errors)``：entries 与 plan_ips 等长同序；agent 仅写
    ``{"pending": True}`` 占位（由后台线程完成）。
    """
    asset_ips = [p["ip"] for p in plan_ips if p.get("asset")]
    intel_ips = [p["ip"] for p in plan_ips if p.get("intel")]
    assets = _query_assets(db, asset_ips)
    threats = _query_threat_intel_batch(intel_ips) if intel_ips else []
    threat_map = dict(zip(intel_ips, threats))

    entries: list[dict] = []
    errors: list[str] = []
    for idx, p in enumerate(plan_ips):
        ip = p["ip"]
        entry: dict = {"ip": ip, "roles": list(p.get("roles") or [])}
        if p.get("asset"):
            asset, err = assets.get(ip, ({"matched": False}, None))
            entry["asset"] = asset
            if err:
                errors.append(err)
        if p.get("intel"):
            t = threat_map.get(ip)
            if isinstance(t, dict) and not t.get("error"):
                entry["threat"] = t
            else:
                entry["threat"] = None
                reason = t.get("error") if isinstance(t, dict) else "未知错误"
                errors.append(f"{ip} 威胁情报查询失败: {reason}")
        if p.get("agent"):
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
        db, ip,
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
                "（自动研判仅支持单个 IP，网段/范围/文本条目已跳过）"
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
        # 链式执行智能体研判（同线程串行，避免与 enrichment 回写并发覆盖）
        agent_ips = [p["ip"] for p in plan["ips"] if p.get("agent")]
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
