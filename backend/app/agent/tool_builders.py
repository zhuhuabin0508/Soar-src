"""工具入参与知识库、资产检索工具构造。"""
from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from pydantic import BaseModel, Field, create_model

logger = logging.getLogger(__name__)

_TYPE_MAP = {
    "String": str,
    "Number": float,
    "Boolean": bool,
    "Object": dict,
    "Array": list,
}

def _build_args_model(tool_name: str, parameters_schema: list[dict] | None):
    """根据 parameters_schema 动态构造 pydantic 入参模型。

    schema 元素结构：``{name, type, required, description}``。
    """
    fields: dict[str, Any] = {}
    for param in parameters_schema or []:
        name = param.get("name")
        if not name:
            continue
        ptype = param.get("type", "String")
        py_type = _TYPE_MAP.get(ptype, str)
        required = bool(param.get("required", False))
        desc = param.get("description", "")
        if required:
            fields[name] = (py_type, Field(..., description=desc))
        else:
            fields[name] = (Optional[py_type], Field(None, description=desc))
    safe_name = "".join(c if c.isalnum() else "_" for c in tool_name) or "Tool"
    return create_model(f"{safe_name}Args", **fields)


def _build_db_tools(db, enabled_tools: list[str]) -> list:
    """把启用的 DB 工具加载为 LangChain StructuredTool。

    Args:
        db: 数据库会话。
        enabled_tools: 工具名称列表。

    Returns:
        StructuredTool 实例列表（加载失败的工具被跳过并记录日志）。
    """
    from langchain_core.tools import StructuredTool

    from app.core.tool_runner import load_tool_function
    from app.models.tool import Tool

    tools: list = []
    if not enabled_tools:
        return tools
    for name in enabled_tools:
        # search_assets 由 _build_asset_tool 注册，避免与 DB code 工具重复挂载
        if name == "search_assets":
            continue
        tool = db.query(Tool).filter(Tool.name == name, Tool.enabled.is_(True)).first()
        if tool is None:
            logger.warning("DB 工具未找到或未启用: %s", name)
            continue
        try:
            run_fn = load_tool_function(tool)
        except Exception as exc:  # noqa: BLE001
            logger.warning("DB 工具加载失败: %s, error=%s", name, exc)
            continue
        args_model = _build_args_model(tool.name, tool.parameters_schema)

        # 用工厂绑定每次迭代的 run_fn/name，避免闭包延迟捕获导致全部工具共用最后一份引用
        def _make_coroutine(rfn, tname):
            async def _coroutine(**kwargs):
                try:
                    return await rfn(**kwargs)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("工具 %s 执行异常: %s", tname, exc)
                    return {"error": str(exc)}
            return _coroutine

        structured = StructuredTool.from_function(
            name=tool.name,
            description=tool.description or f"DB 工具 {tool.name}",
            args_schema=args_model,
            coroutine=_make_coroutine(run_fn, name),
        )
        tools.append(structured)
        logger.info("已加载 DB 工具为 StructuredTool: %s", name)
    return tools


def _build_kb_tool(enabled_kbs: list[int]):
    """构造知识库检索工具（搜索所有启用知识库）。"""
    if not enabled_kbs:
        return None
    from langchain_core.tools import StructuredTool

    class SearchKBArgs(BaseModel):
        query: str = Field(..., description="检索查询字符串")
        kb_id: Optional[int] = Field(None, description="指定知识库 id；不传则检索所有启用知识库")

    kb_ids = list(enabled_kbs)

    async def _coroutine(query: str, kb_id: Optional[int] = None):
        from app.core.kb_retriever import search_kb

        targets = list(kb_ids)
        if kb_id is not None:
            # 指定库优先；若该库已删或不在启用列表，改搜全部启用库
            if kb_id in kb_ids:
                hits = await search_kb(kb_id, query)
                if hits:
                    return hits
            targets = [kid for kid in kb_ids if kid != kb_id]
        results: list = []
        for kid in targets:
            results.extend(await search_kb(kid, query))
        return results

    return StructuredTool.from_function(
        name="search_knowledge_base",
        description="在已启用的知识库中检索相关文档。可指定 kb_id，不传则检索所有启用知识库。",
        args_schema=SearchKBArgs,
        coroutine=_coroutine,
    )


def _build_file_query_tool(enabled_kbs: list[int]):
    """构造知识库文件查询工具（读取原始 Excel/CSV 文件，按条件精确查询）。

    与 ``search_knowledge_base``（语义检索）互补：本工具返回结构化表格行列数据，
    适合精确查询 Excel 中的特定 IP、部门、资产等字段值。
    """
    if not enabled_kbs:
        return None
    from langchain_core.tools import StructuredTool

    class FileQueryArgs(BaseModel):
        query: str = Field(
            "",
            description="查询条件。支持关键词（任意列包含即命中）或 '列名=值' 精确过滤。"
            "例如 '203.0.113.1' 或 '部门=研发部'。留空则返回前几行预览。",
        )
        doc_id: Optional[int] = Field(
            None, description="指定文档 id（优先级最高）。不传则在所有启用知识库中搜索。"
        )
        kb_id: Optional[int] = Field(
            None, description="指定知识库 id。不传则搜索所有启用知识库。"
        )
        sheet: Optional[str] = Field(
            None, description="Excel sheet 名（不传则读第一个 sheet）"
        )
        limit: Optional[int] = Field(
            20, description="返回行数上限，默认 20，最大 200"
        )

    kb_ids = list(enabled_kbs)

    async def _coroutine(
        query: str = "",
        doc_id: Optional[int] = None,
        kb_id: Optional[int] = None,
        sheet: Optional[str] = None,
        limit: int = 20,
    ):
        from app.core.kb_file_query import query_kb_file

        return query_kb_file(
            query=query,
            kb_id=kb_id,
            doc_id=doc_id,
            sheet=sheet,
            limit=limit,
            enabled_kbs=kb_ids,
        )

    return StructuredTool.from_function(
        name="query_kb_file",
        description=(
            "查询知识库中的表格文件（Excel/CSV），返回结构化行列数据。"
            "适合精确查询 IP 列表、资产台账、人员信息等结构化数据。"
            "支持按列名=值过滤，或关键词模糊匹配。"
            "与 search_knowledge_base（语义检索）互补：本工具返回原始表格行数据。"
        ),
        args_schema=FileQueryArgs,
        coroutine=_coroutine,
    )


def _all_asset_type_codes() -> list[str]:
    """读取全部资产类型 code；无模板时返回空列表。"""
    return list(_asset_type_labels().keys())


def _asset_type_labels() -> dict[str, str]:
    """资产类型 code → 中文显示名（来自 AssetTypeTemplate）。"""
    from app.database import SessionLocal
    from app.models.asset import AssetTypeTemplate

    db = SessionLocal()
    try:
        rows = db.query(AssetTypeTemplate.code, AssetTypeTemplate.name).order_by(
            AssetTypeTemplate.sort_order.asc(), AssetTypeTemplate.id.asc()
        ).all()
        return {code: name for code, name in rows}
    except Exception:  # noqa: BLE001
        logger.warning("读取资产类型模板失败，search_assets 无类型名称映射")
        return {}
    finally:
        db.close()


# ============================================================================
# 资产全表扫描缓存（进程内共享）
#
# 背景：资产表可达 10 万行级，逐行把 ip/identifier/extra_fields 解析为 IP 整数
# 区间约需数秒；资产数据变化频率低（月级导入），用短 TTL 缓存把后续查询
# 降为内存整数比较（毫秒级）。缓存条目：(id, type_code, department, intervals)。
# 另按 IP 首八位组（/8）建分桶索引，把单次查询的扫描量从全表降到单桶，
# 支撑百级 IP 的批量研判不超时。
# ============================================================================
_ASSET_SCAN_CACHE: dict = {"ts": 0.0, "rows": None, "buckets": None}
_ASSET_SCAN_CACHE_TTL = 60.0  # 秒；资产写入后最长延迟 60 秒可见
_asset_scan_lock = threading.Lock()
_EMPTY_INTERVALS: list[tuple[int, int]] = []  # 无 IP 字段行的共享空区间（省内存）


def _parse_single_ip(s: str):
    """尝试解析为单个 IPv4 地址，失败返回 None。"""
    import ipaddress

    s = (s or "").strip()
    if not s:
        return None
    try:
        return ipaddress.IPv4Address(s)
    except (ipaddress.AddressValueError, ValueError):
        return None


def _complete_ip(s: str):
    """对不完整 IP 字符串补 .0 后解析（如 ``198.51.100`` → ``198.51.100.0``）。

    资产数据存在质量问题（如 ``198.51.100-198.51.100.254`` 起始 IP 缺最后一段），
    这里做防御性补全。
    """
    s = (s or "").strip()
    if not s:
        return None
    octets = s.split(".")
    while len(octets) < 4:
        octets.append("0")
    if len(octets) > 4:
        return None
    return _parse_single_ip(".".join(octets))


def _value_to_intervals(stored: str) -> list[tuple[int, int]]:
    """把存储值解析为 IP 整数区间列表（一次解析，多个查询目标共用）。

    支持的格式：
    - 逗号分隔多值: ``203.0.113.1,203.0.113.2``（逐段解析合并）
    - CIDR: ``198.51.100.0/24`` → [网络号, 广播地址]
    - 完整范围: ``113.108.60.224-113.108.60.254``
    - 末段简写: ``61.144.224.185-187``（仅最后一位变化，等价 185-187）
    - 不完整 IP（数据质量）: ``198.51.100-198.51.100.254``（起始缺段自动补 .0）
    - 单 IP: ``58.250.157.1`` → [ip, ip]

    解析失败的部分返回空区间（不影响其余部分）。
    倒置范围（start > end）仅当两端同 /24 时交换匹配；跨网段倒置（如
    ``172.46.9.1-17.46.9.62``）视为脏数据丢弃，避免生成误命中全网的巨型区间。
    """
    import ipaddress

    stored = (stored or "").strip()
    if not stored:
        return []

    if "," in stored:
        out: list[tuple[int, int]] = []
        for part in stored.split(","):
            out.extend(_value_to_intervals(part))
        return out

    # 1. CIDR 格式 (198.51.100.0/24)
    if "/" in stored:
        try:
            net = ipaddress.IPv4Network(stored, strict=False)
            return [(int(net.network_address), int(net.broadcast_address))]
        except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
            return []

    # 2. IP 范围格式 (start-end)
    if "-" in stored:
        parts = stored.split("-", 1)
        if len(parts) == 2:
            start_str = parts[0].strip()
            end_str = parts[1].strip()
            start_ip = _parse_single_ip(start_str) or _complete_ip(start_str)
            if start_ip is None:
                return []
            # 末段简写：end_str 无点且为纯数字（如 "187"）时，替换 start 的最后一段
            # 例：61.144.224.185-187 → end = 61.144.224.187
            # 必须先于 _complete_ip 判断，否则 "187" 会被补成 187.0.0.0 产生超大范围
            if "." not in end_str and end_str.isdigit():
                octets = str(start_ip).split(".")
                last = int(end_str)
                if 0 <= last <= 255:
                    octets[3] = str(last)
                    end_ip = _parse_single_ip(".".join(octets))
                else:
                    end_ip = _complete_ip(end_str)
            else:
                end_ip = _parse_single_ip(end_str) or _complete_ip(end_str)
            if end_ip is not None:
                s, e = int(start_ip), int(end_ip)
                if s <= e:
                    return [(s, e)]
                # 倒置范围（start > end）：两端同 /24 视为笔误，交换后继续匹配
                # （如 61.144.227.220-61.144.227.226）；跨网段倒置几乎必为脏数据
                # （如 172.46.9.1-17.46.9.62，交换后会生成覆盖 17.x-172.x 的
                # 巨型区间，导致任意 IP 误命中），直接丢弃。
                if (s >> 8) == (e >> 8):
                    return [(e, s)]
                return []
        return []

    # 3. 单 IP 精确匹配 (58.250.157.1)
    single = _parse_single_ip(stored)
    if single is not None:
        return [(int(single), int(single))]

    return []


def _intervals_from_fields(ip, identifier, extra_fields) -> list[tuple[int, int]]:
    """一行资产的所有 IP 字段（ip/identifier/extra 中的 IP/EIP/CIDR）解析为区间并集。"""
    values = [ip or "", identifier or ""]
    extra = extra_fields if isinstance(extra_fields, dict) else {}
    for key, val in extra.items():
        if not val:
            continue
        lk = str(key).lower()
        if lk in ("eip", "ip", "cidr", "public_ip", "wan_ip", "nat_ip") or "ip" in lk or "cidr" in lk:
            values.append(str(val))
    out: list[tuple[int, int]] = []
    for v in values:
        if v:
            out.extend(_value_to_intervals(v))
    return out or _EMPTY_INTERVALS


def _get_asset_scan_rows(db):
    """全表扫描缓存：返回 [(id, type_code, department, intervals)]，TTL 内直接复用。

    全量扫描（不截断——旧实现 ``limit(50000)`` 会漏掉第 5 万行之后的资产）。
    重扫在锁外进行，并发时最多重复扫一次（幂等），不会长时间持锁。
    同时维护首八位组分桶索引（见 ``_ASSET_SCAN_CACHE``）。
    """
    import time

    with _asset_scan_lock:
        if (
            _ASSET_SCAN_CACHE["rows"] is not None
            and time.monotonic() - _ASSET_SCAN_CACHE["ts"] < _ASSET_SCAN_CACHE_TTL
        ):
            return _ASSET_SCAN_CACHE["rows"]

    from app.models.asset import Asset

    cols = (Asset.id, Asset.type_code, Asset.department, Asset.ip, Asset.identifier, Asset.extra_fields)
    rows = db.query(*cols).all()
    parsed = [
        (r.id, r.type_code, r.department, _intervals_from_fields(r.ip, r.identifier, r.extra_fields))
        for r in rows
    ]
    # 分桶索引：首八位组 → [(start, end, row_idx)]；区间注册到其覆盖的每个桶
    buckets: dict[int, list[tuple[int, int, int]]] = {}
    for idx, (_rid, _tc, _dep, intervals) in enumerate(parsed):
        for s, e in intervals:
            for b in range(s >> 24, (e >> 24) + 1):
                buckets.setdefault(b, []).append((s, e, idx))
    with _asset_scan_lock:
        _ASSET_SCAN_CACHE["ts"] = time.monotonic()
        _ASSET_SCAN_CACHE["rows"] = parsed
        _ASSET_SCAN_CACHE["buckets"] = buckets
    return parsed


def _bucket_match_ip(ti: int) -> list[int]:
    """桶索引查单 IP：返回命中区间的行下标（已去重）。"""
    buckets = _ASSET_SCAN_CACHE["buckets"] or {}
    out: list[int] = []
    seen: set[int] = set()
    for s, e, idx in buckets.get(ti >> 24, ()):
        if s <= ti <= e and idx not in seen:
            seen.add(idx)
            out.append(idx)
    return out


def _bucket_match_net(ns: int, ne: int) -> list[int]:
    """桶索引查网段重叠：返回与 [ns, ne] 有交集的行下标（已去重）。"""
    buckets = _ASSET_SCAN_CACHE["buckets"] or {}
    out: list[int] = []
    seen: set[int] = set()
    for b in range(ns >> 24, (ne >> 24) + 1):
        for s, e, idx in buckets.get(b, ()):
            if s <= ne and ns <= e and idx not in seen:
                seen.add(idx)
                out.append(idx)
    return out


def _split_tokens(keyword: str) -> list[str]:
    """拆分多值 keyword：逗号/分号/空白（含中文标点）分隔。"""
    import re

    if not keyword:
        return []
    return [t for t in re.split(r"[,;，；、\s]+", keyword.strip()) if t]


def _discovery_ip_tokens(keyword: str) -> list[str]:
    """提取 keyword 中的 IPv4/CIDR token（规范化字符串），供资产发现查询。

    资产发现数据约数十万行，只支持 IP/CIDR/CMDB ID 精确匹配，
    因此仅把 IP 类 token 传给资产发现；名称/部门等文本 token 不在其检索范围。
    """
    import ipaddress

    out: list[str] = []
    for t in _split_tokens(keyword):
        ip = _parse_single_ip(t)
        if ip is not None:
            out.append(str(ip))
            continue
        if "/" in t:
            try:
                out.append(str(ipaddress.IPv4Network(t.strip(), strict=False)))
            except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
                continue
    return out


# 资产发现命中在 search_assets 返回结构中的分组键（与资产类型中文分组的顶层 key 并列）
_DISCOVERY_GROUP_KEY = "资产发现"


def _merge_discovery_results(payload: dict, discovery: dict) -> dict:
    """把资产发现（综合运管平台爬取）命中合并进 search_assets 返回结构。

    - 单查询目标：顶层追加 ``资产发现`` 分组（资产清单按类型分组的结构不变）
    - 批量：每个 IP/CIDR 目标的条目追加 ``资产发现`` 分组，命中时 ``matched``
      置 True；文本目标不追加（资产发现未查询该类关键词）
    - 查询出错：追加 ``资产发现_error`` 说明；截断时追加 ``资产发现_truncated``。
      两者均不影响资产清单结果。
    """
    if not isinstance(payload, dict) or not isinstance(discovery, dict):
        return payload

    def _attach(entry: dict, item: dict) -> None:
        entry[_DISCOVERY_GROUP_KEY] = list(item.get("assets") or [])
        if item.get("error"):
            entry["资产发现_error"] = item["error"]
        if item.get("truncated"):
            entry["资产发现_truncated"] = True

    if payload.get("batch"):
        # discovery 返回可能是批量（多 token）或单目标（keyword 混有文本 token）两种形状
        if discovery.get("batch"):
            by_query = {item.get("query"): item for item in discovery.get("queries") or []}
        elif discovery.get("query"):
            by_query = {discovery.get("query"): discovery}
        else:
            # 整个资产发现查询失败（超时等，返回无 query 维度的 error 形状）：
            # 顶层记一次错误说明，不影响资产清单结果
            if discovery.get("error"):
                payload["资产发现_error"] = discovery["error"]
            return payload
        for entry in payload.get("queries") or []:
            item = by_query.get(entry.get("query"))
            if item is None:
                continue
            _attach(entry, item)
            if item.get("assets"):
                entry["matched"] = True
        return payload

    # 单目标：discovery 返回本身就是该目标的命中
    _attach(payload, discovery)
    return payload


def _should_attach_search_assets(
    enabled_tools: list[str] | None,
    enabled_asset_types: list[str] | None,
) -> bool:
    """未勾选任何资产类型时不注册 search_assets。"""
    return bool(enabled_asset_types)


async def execute_search_assets(
    keyword: str = "",
    department: str = "",
    type_code: str | None = None,
    limit: int = 20,
    type_codes: list[str] | None = None,
):
    """供工具沙箱 / 测试页调用的资产检索入口。

    行为与运行时 ``search_assets`` 一致：keyword 含 IPv4/CIDR 时，
    除资产清单外同时检索资产发现数据并合并返回（见 ``_build_asset_tool``）。
    """
    codes = list(type_codes or [])
    if not codes:
        # 无 agent 上下文（工具管理页测试 / 工作流 tool 节点直调）：
        # 回退全部资产类型，行为与「智能体勾选全部类型」一致（不按类型过滤），
        # 与 get_asset_info 无上下文回退全库查询的先例保持一致。
        codes = _all_asset_type_codes()
    tool = _build_asset_tool(codes)
    if tool is None:
        return {"error": "未勾选资产类型，search_assets 不可用", "count": 0}
    result = await tool.coroutine(
        keyword=keyword or "",
        department=department or "",
        type_code=type_code,
        limit=limit,
    )
    return result if isinstance(result, dict) else {"count": len(result or []), "assets": result or []}


def _build_asset_tool(enabled_asset_types: list[str]):
    """构造资产检索工具（在关联的资产类型范围内检索）。

    检索范围由智能体勾选的 ``enabled_asset_types`` 决定：
    - 未勾选：不注册本工具
    - 勾选部分类型：只查这些 ``type_code``
    - 勾选全部类型：不按类型过滤（同一 IP 在主机/网段/出口等多类下都会返回）

    IP 匹配策略（ip 列可能存储单 IP / IP 范围 / CIDR 三种格式）：
    - keyword 为单个 IPv4 时：做 **IP 包含判断**（查询 IP 是否落在存储值的
      网段/范围内），而非子串匹配。例：查 ``113.108.60.240`` 会命中
      ``113.108.60.224-113.108.60.254`` 的网段资产。
    - keyword 为 CIDR（如 ``198.51.100.0/24``）时：做网段重叠判断。
    - keyword 非 IP 时：走 ilike 子串匹配（IP/名称/标识/负责人）。

    资产发现联动（IP 查询）：
    - keyword 含 IPv4/CIDR 时，除资产清单外**并发**检索资产发现数据
      （综合运管平台爬取的云主机/裸金属/网络资源/弹性IP，精确匹配，见
      ``app.agent.discovery_search``），命中以 ``资产发现`` 分组合并进返回
      结构（见 ``_merge_discovery_results``）；查询失败只记日志，不影响
      资产清单结果。
    - 文本关键词（名称/部门等）仅检索资产清单。
    """
    type_codes_in = list(dict.fromkeys(enabled_asset_types or []))
    if not type_codes_in:
        return None
    import ipaddress
    from langchain_core.tools import StructuredTool
    from sqlalchemy import or_

    class SearchAssetsArgs(BaseModel):
        keyword: str = Field(
            "",
            description="按 IP/名称/标识/负责人模糊搜索。传入单个 IP（如 198.51.100.1）"
            "会自动匹配包含该 IP 的网段/CIDR/范围资产，并同时在资产发现"
            "（云主机/裸金属/网络资源/弹性IP）中精确检索该 IP。"
            "支持逗号/分号/空白分隔批量查询（如 '198.51.100.1,203.0.113.5'），"
            "一次调用返回每个 IP 各自的命中，批量研判 IP 时务必合并为一次调用。",
        )
        department: str = Field("", description="按使用单位/部门精确筛选")
        type_code: Optional[str] = Field(
            None,
            description="忽略。检索范围由智能体勾选的资产类型决定，同一 IP 会返回所有类型下的命中。",
        )
        limit: int = Field(20, description="非 IP 查询的条数上限，默认20。按 IP 查询会跨类型返回全部命中。")

    type_codes = list(type_codes_in)
    all_template_codes = set(_all_asset_type_codes())
    # 全选（勾选覆盖当前全部模板）时不按 type_code 过滤，避免漏掉未分类或同 IP 多类型记录
    filter_by_types = None if (all_template_codes and set(type_codes) >= all_template_codes) else type_codes

    type_labels = _asset_type_labels()

    def _serialize(r) -> dict:
        extra = r.extra_fields if isinstance(r.extra_fields, dict) else {}
        code = r.type_code or "(uncategorized)"
        return {
            "id": r.id, "name": r.name, "ip": r.ip, "identifier": r.identifier,
            "department": r.department, "owner": r.owner,
            "type_code": code,
            "type_name": type_labels.get(code, code),
            "status": r.status, "criticality": r.criticality,
            "eip": extra.get("eip") or extra.get("EIP"),
            "extra_fields": extra or None,
        }

    def _pack(rows) -> dict:
        """按资产类型分组返回，顶层 key 为类型中文名（如 出口地址 / 主机资产）。"""
        bucket_codes = list(type_labels.keys()) if filter_by_types is None else list(type_codes)
        if not bucket_codes:
            bucket_codes = list(dict.fromkeys(
                [(r.type_code or "(uncategorized)") for r in rows]
            ))
        grouped: dict[str, list] = {code: [] for code in bucket_codes}
        for r in rows:
            code = r.type_code or "(uncategorized)"
            if code not in grouped:
                grouped[code] = []
            grouped[code].append(_serialize(r))

        result: dict = {"count": len(rows)}
        for code in bucket_codes:
            label = type_labels.get(code, code)
            result[label] = grouped.get(code, [])
        return result

    def _run_query_sync(keyword: str, department: str, limit: int):
        """同步执行检索（由 ``asyncio.to_thread`` 调度到线程池，不阻塞事件循环）。

        Session 在本函数内创建并关闭，不跨线程传递。
        """
        from app.database import SessionLocal
        from app.models.asset import Asset
        db = SessionLocal()
        try:
            max_limit = min(max(limit, 1), 50)
            ip_hit_cap = 500

            # token 分类：单 IP / CIDR / 文本
            tokens = _split_tokens(keyword)
            ip_toks: list = []
            net_toks: list = []
            text_toks: list[str] = []
            for t in tokens:
                ip = _parse_single_ip(t)
                if ip is not None:
                    ip_toks.append(ip)
                    continue
                if "/" in t:
                    try:
                        net_toks.append(ipaddress.IPv4Network(t.strip(), strict=False))
                        continue
                    except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
                        pass
                text_toks.append(t)

            q = db.query(Asset)
            if filter_by_types is not None:
                q = q.filter(Asset.type_code.in_(filter_by_types))
            if department:
                q = q.filter(Asset.department == department)

            def _text_query(t: str):
                kw = f"%{t}%"
                return (
                    q.filter(or_(Asset.ip.ilike(kw), Asset.name.ilike(kw),
                                 Asset.identifier.ilike(kw), Asset.owner.ilike(kw)))
                    .order_by(Asset.id.desc())
                    .limit(max_limit)
                    .all()
                )

            per_token: list[tuple[str, list]] = []  # (token 展示值, 命中行)
            if ip_toks or net_toks:
                # 全表扫描缓存：[(id, type_code, department, intervals)]，TTL 内跨调用复用；
                # 类型/部门过滤在内存完成（缓存行已带 type_code/department）；
                # 命中下标经首八位组分桶索引查找，支撑百级 IP 批量不超时
                scan_rows = _get_asset_scan_rows(db)

                def _hit_rows(idx_list: list[int]) -> list[int]:
                    """桶命中下标 → 通过类型/部门过滤的资产 id（截断至 ip_hit_cap）。"""
                    out = []
                    for idx in idx_list:
                        _rid, rc, rdep, _ivs = scan_rows[idx]
                        if filter_by_types is not None and rc not in filter_by_types:
                            continue
                        if department and (rdep or "") != department:
                            continue
                        out.append(_rid)
                        if len(out) >= ip_hit_cap:
                            break
                    return out

                for ip in ip_toks:
                    hit_ids = _hit_rows(_bucket_match_ip(int(ip)))
                    rows = (
                        db.query(Asset).filter(Asset.id.in_(hit_ids)).order_by(Asset.id.desc()).all()
                        if hit_ids else []
                    )
                    per_token.append((str(ip), rows))
                for net in net_toks:
                    ns = int(net.network_address)
                    ne = int(net.broadcast_address)
                    hit_ids = _hit_rows(_bucket_match_net(ns, ne))
                    rows = (
                        db.query(Asset).filter(Asset.id.in_(hit_ids)).order_by(Asset.id.desc()).all()
                        if hit_ids else []
                    )
                    per_token.append((str(net), rows))
            for t in text_toks:
                per_token.append((t, _text_query(t)))

            if not per_token:
                # 空 keyword：返回空分组（与原行为一致）
                return _pack([])
            if len(per_token) == 1:
                # 单一查询目标：保持原有按类型分组的返回结构
                return _pack(per_token[0][1])

            # 批量：按查询目标分组返回，方便 LLM 逐 IP 对应命中结果
            seen_ids: set = set()
            total = 0
            queries: list[dict] = []
            for tok, rows in per_token:
                queries.append({"query": tok, "matched": bool(rows), **_pack(rows)})
                for r in rows:
                    if r.id not in seen_ids:
                        seen_ids.add(r.id)
                        total += 1
            return {"batch": True, "count": total, "queries": queries}
        finally:
            db.close()

    async def _coroutine(keyword="", department="", type_code=None, limit=20):
        import asyncio

        # 同步 DB 查询 + CPU 逐行过滤放线程池执行：全表扫描曾直接跑在事件循环里，
        # 批量研判时多次调用会累积阻塞，导致 SSE 的 tool_end 推送发不出、前端转圈。
        inventory_task = asyncio.to_thread(
            _run_query_sync, keyword or "", department or "", int(limit or 20)
        )

        # IP/CIDR 查询同时检索资产发现数据（综合运管平台爬取的云主机/裸金属/
        # 网络资源/弹性IP，精确匹配），与资产清单查询并发执行；
        # 失败只记日志，不影响资产清单结果（合并结构见 _merge_discovery_results）。
        disc_tokens = _discovery_ip_tokens(keyword or "")

        async def _discovery() -> Optional[dict]:
            if not disc_tokens:
                return None
            try:
                from app.agent.discovery_search import execute_search_discovered_assets

                return await execute_search_discovered_assets(
                    keyword=",".join(disc_tokens), limit=10
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("search_assets 资产发现查询失败（忽略）: %s", exc)
                return None

        inventory, discovery = await asyncio.gather(inventory_task, _discovery())
        if discovery:
            _merge_discovery_results(inventory, discovery)
        return inventory

    scope_desc = (
        "已勾选全部资产类型，不按类型过滤；同一 IP 在主机资产/网段/出口地址等类型下的记录都会返回。"
        if filter_by_types is None
        else f"仅检索已勾选类型 {type_codes}；同一 IP 在这些类型下的记录都会返回。"
    )
    return StructuredTool.from_function(
        name="search_assets",
        description=(
            f"检索资产清单与资产发现数据。{scope_desc}"
            "支持逗号/分号/空白分隔的批量查询（如 '1.2.3.4,5.6.7.8'），"
            "一次调用返回每个查询目标各自的命中——批量研判多个 IP 时必须合并为一次调用，不要逐个查询。"
            "传入单个 IP 会匹配包含该 IP 的网段/CIDR/范围/EIP，并同时在资产发现"
            "（云主机/裸金属/网络资源/弹性IP）中精确检索该 IP，命中以「资产发现」分组返回；"
            "传入 CIDR 会匹配重叠网段。"
            "按名称/部门等文本查询时仅检索资产清单。"
        ),
        args_schema=SearchAssetsArgs,
        coroutine=_coroutine,
    )
