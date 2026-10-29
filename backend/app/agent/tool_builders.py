"""工具入参与知识库、资产检索工具构造。"""
from __future__ import annotations

import logging
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
# IP 字段解析与持久化区间索引
#
# 解析函数从 app.core.asset_ip_index 导入（单一实现，写入侧/查询侧/导入
# 校验共享同一语义）；该模块把资产 IP 区间落到 asset_ip_intervals 表
# （int4range + GiST 索引），search_assets 的 IP 查询走索引查找而非全表扫描
# （98k 资产冷查询 2.2s → ~1ms 级），且写入侧由 ORM 事件实时同步、无缓存
# 一致性问题。
#
# 此处按原名 re-export，兼容 tests（test_asset_ip_intervals 等）与
# enricher_stage 的既有引用。
# ============================================================================
from app.core.asset_ip_index import (  # noqa: F401
    _complete_ip,
    _intervals_from_fields,
    _parse_any_ip,
    _parse_single_ip,
    _split_fallback,
    _value_to_intervals,
    query_asset_ids_by_ip,
    query_asset_ids_by_ipv6,
    query_asset_ids_by_net,
    query_asset_ids_by_netv6,
)


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
# 资产发现字段中文名对照在返回结构中的顶层键
_DISCOVERY_LABELS_KEY = "资产发现_字段说明"


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

    # 字段中文名对照（英文键 → 中文列名）一次性透出，供 Agent 按类型实际字段展示
    if isinstance(discovery.get("field_labels"), dict):
        payload[_DISCOVERY_LABELS_KEY] = discovery["field_labels"]

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
    # type_codes 参数已废弃：search_assets 始终检索全部资产类型 + 资产发现，
    # 不再按智能体勾选的资产类型过滤（工具注册与否见 tool_engine._register_asset_tools）
    _ = type_codes  # 兼容旧调用方签名
    tool = _build_asset_tool()
    if tool is None:
        return {"error": "资产检索工具不可用", "count": 0}
    result = await tool.coroutine(
        keyword=keyword or "",
        department=department or "",
        type_code=type_code,
        limit=limit,
    )
    return result if isinstance(result, dict) else {"count": len(result or []), "assets": result or []}


def _build_asset_tool(enabled_asset_types: list[str] | None = None):
    """构造资产检索工具（检索全部资产类型 + 资产发现，不按类型勾选过滤）。

    ``enabled_asset_types`` 参数已废弃（保留仅为兼容旧调用方/测试）：
    工具注册后始终检索**全部**资产清单类型（含未分类记录），
    同一 IP 在主机/网段/出口/自定义类型等多类下的命中都会返回。

    IP 匹配策略（ip 列可能存储单 IP / IP 范围 / CIDR 三种格式）：
    - keyword 为单个 IPv4 时：做 **IP 包含判断**（查询 IP 是否落在存储值的
      网段/范围内），而非子串匹配。例：查 ``113.108.60.240`` 会命中
      ``113.108.60.224-113.108.60.254`` 的网段资产。
    - keyword 为 CIDR（如 ``198.51.100.0/24``）时：做网段重叠判断。
    - keyword 非 IP 时：走 ilike 子串匹配（IP/名称/标识/负责人）。

    资产发现联动（IP 查询）：
    - keyword 含 IPv4/CIDR 时，除资产清单外**并发**检索资产发现数据
      （综合运管平台爬取的云主机/裸金属/网络资源/弹性IP + 青藤 API 同步的
      主机资产，精确匹配，见 ``app.agent.discovery_search``），命中以
      ``资产发现`` 分组合并进返回结构（见 ``_merge_discovery_results``）；
      查询失败只记日志，不影响资产清单结果。
    - 文本关键词（名称/部门等）仅检索资产清单。
    """
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
            description="忽略。检索覆盖全部资产类型，同一 IP 会返回所有类型下的命中。",
        )
        limit: int = Field(20, description="非 IP 查询的条数上限，默认20。按 IP 查询会跨类型返回全部命中。")

    # 不按类型过滤：覆盖全部资产类型（含未分类记录），新增类型模板无需改智能体配置
    filter_by_types = None

    type_labels = _asset_type_labels()

    def _serialize(r) -> dict:
        extra = r.extra_fields if isinstance(r.extra_fields, dict) else {}
        code = r.type_code or "(uncategorized)"
        # 标签用于 IP 资产查询结果展示（Agent 技能要求资产清单结果必须带标签列）
        tags = [t.name for t in (getattr(r, "tags", None) or []) if getattr(t, "name", "")]
        return {
            "id": r.id, "name": r.name, "ip": r.ip, "identifier": r.identifier,
            "department": r.department, "owner": r.owner,
            "asset_type": r.asset_type, "location": r.location,
            "type_code": code,
            "type_name": type_labels.get(code, code),
            "status": r.status, "criticality": r.criticality,
            "eip": extra.get("eip") or extra.get("EIP"),
            # 业务系统在知识库梳理时通常落在 extra_fields.system_name
            "business_system": (
                extra.get("system_name") or extra.get("business_system") or extra.get("业务系统")
            ),
            "tags": tags,
            "extra_fields": extra or None,
        }

    def _pack(rows) -> dict:
        """按资产类型分组返回，顶层 key 为类型中文名（如 出口地址 / 主机资产）。"""
        # filter_by_types 恒为 None：按当前全部类型模板分组
        bucket_codes = list(type_labels.keys())
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
                ip = _parse_any_ip(t)
                if ip is not None:
                    ip_toks.append(ip)
                    continue
                if "/" in t:
                    try:
                        net_toks.append(ipaddress.ip_network(t.strip(), strict=False))
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
                # 持久化区间索引（asset_ip_intervals，GiST）：点查 @> / 网段重叠 &&，
                # 替代旧的全表扫描 + 内存缓存（冷查询 2.2s → 索引查找 ~1ms 级）。
                # 索引行由 ORM 事件在资产写入时同步，查询结果始终实时。
                def _load_rows(hit_ids: list[int]) -> list:
                    """命中资产 id → 资产行（应用 department 过滤，截断至 ip_hit_cap）。"""
                    if not hit_ids:
                        return []
                    q2 = db.query(Asset).filter(Asset.id.in_(hit_ids))
                    if department:
                        q2 = q2.filter(Asset.department == department)
                    return q2.order_by(Asset.id.desc()).all()

                for ip in ip_toks:
                    if ip.version == 6:
                        hit_ids = query_asset_ids_by_ipv6(db, int(ip), limit=ip_hit_cap)
                    else:
                        hit_ids = query_asset_ids_by_ip(db, int(ip), limit=ip_hit_cap)
                    per_token.append((str(ip), _load_rows(hit_ids)))
                for net in net_toks:
                    ns = int(net.network_address)
                    ne = int(net.broadcast_address)
                    if net.version == 6:
                        hit_ids = query_asset_ids_by_netv6(db, ns, ne, limit=ip_hit_cap)
                    else:
                        hit_ids = query_asset_ids_by_net(db, ns, ne, limit=ip_hit_cap)
                    per_token.append((str(net), _load_rows(hit_ids)))
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

        # 同步 DB 查询放线程池执行，避免 DB IO 阻塞事件循环（历史上全表扫描
        # 直接跑在事件循环里，批量研判多次调用累积阻塞，SSE 的 tool_end
        # 推送发不出、前端转圈；现 IP 查询已走 GiST 索引，仍保持线程池调度）。
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

    return StructuredTool.from_function(
        name="search_assets",
        description=(
            "检索资产清单与资产发现数据。检索覆盖全部资产类型，不按类型过滤；"
            "同一 IP 在主机资产/网段/出口地址等类型下的记录都会返回。"
            "支持逗号/分号/空白分隔的批量查询（如 '1.2.3.4,5.6.7.8'），"
            "一次调用返回每个查询目标各自的命中——批量研判多个 IP 时必须合并为一次调用，不要逐个查询。"
            "传入单个 IP 会匹配包含该 IP 的网段/CIDR/范围/EIP，并同时在资产发现"
            "（云主机/裸金属/网络资源/弹性IP/青藤主机）中精确检索该 IP，命中以「资产发现」分组返回；"
            "返回结构中「资产发现」是资产发现数据，其余按资产类型分组的是资产清单数据，二者应分开展示。"
            "传入 CIDR 会匹配重叠网段。"
            "按名称/部门等文本查询时仅检索资产清单。"
            "不同资产类型的字段集不同：资产清单记录的 extra_fields 携带该类型模板的自定义字段，"
            "资产发现记录按资源类型全量返回自身字段（顶层「资产发现_字段说明」为英文字段名→中文列名对照）；"
            "展示时以重点字段（IP/主机名/资产类型/业务系统/责任人/部门等）为前列，"
            "再按记录实际拥有的字段补充类型特有字段，不要硬套固定一套字段。"
        ),
        args_schema=SearchAssetsArgs,
        coroutine=_coroutine,
    )
