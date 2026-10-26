"""资产管理 API。

提供资产列表查看（分页+筛选+搜索）、统计、详情、手动新增/编辑/删除、
CSV 导出，以及手动触发资产扫描任务。

供前端「资产管理」页面使用。资产数据由资产管理智能体的工具自动梳理录入，
也可通过本 API 手动管理。
"""
import csv
import io
import ipaddress
import logging
import re

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip
from app.core.log_receiver_manager.pipeline.enricher_stage import invalidate_asset_index
from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_role, require_permission, require_any_permission
from app.models.agent import Agent
from app.models.asset import Asset, AssetChange, AssetCustomField, AssetTag, AssetTypeTemplate
from app.models.user import User
from app.schemas.common import to_dict

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/assets",
    tags=["assets"],
    dependencies=[Depends(get_current_user)],
)


# ============================================================================
# 变更历史辅助（记录失败不阻断主流程，参考 log_audit 容错模式）
# ============================================================================

# Asset 可被记录变更的字段白名单（extra_fields 单独处理）
_TRACKABLE_FIELDS = [
    "type_code", "identifier", "identifier_type", "name", "asset_type",
    "department", "owner", "location", "ip", "criticality", "status",
]

# 字段中文标签（用于变更摘要）
_FIELD_LABELS = {
    "type_code": "资产类型", "identifier": "标识", "identifier_type": "标识类型", "name": "名称",
    "asset_type": "类型", "department": "部门", "owner": "负责人",
    "location": "位置", "ip": "IP", "criticality": "重要性",
    "status": "状态", "extra_fields": "扩展字段",
}

# 资产生命周期状态枚举
_ASSET_STATUS_VALUES = {"in_use", "idle", "repair", "retired", "lost"}

# Asset 模型支持的"标准字段"白名单（不在白名单的字段存入 extra_fields）
# 用于自定义字段创建校验：field_key 不能与标准字段重复
_ASSET_STANDARD_FIELDS = {
    "identifier", "identifier_type", "name", "asset_type",
    "department", "owner", "location", "ip", "criticality",
}


def _asset_snapshot(record: Asset) -> dict:
    """提取资产可追踪字段快照（用于 diff 比较）。"""
    return {
        "type_code": record.type_code,
        "identifier": record.identifier,
        "identifier_type": record.identifier_type,
        "name": record.name,
        "asset_type": record.asset_type,
        "department": record.department,
        "owner": record.owner,
        "location": record.location,
        "ip": record.ip,
        "criticality": record.criticality,
        "status": record.status,
        "extra_fields": record.extra_fields or {},
    }


def _compute_diff(before: dict, after: dict, fields: list[str] | None = None) -> dict:
    """计算两个状态字典的字段级 diff，仅返回变化的字段。

    None 与空字符串视为相同，避免无意义 diff。
    """
    fields = fields or _TRACKABLE_FIELDS
    diff = {}
    for f in fields:
        old_v = before.get(f)
        new_v = after.get(f)
        if (old_v or "") != (new_v or ""):
            diff[f] = {"old": old_v, "new": new_v}
    return diff


def _build_summary(diff: dict) -> str:
    """把 diff 转为人类可读摘要，如「负责人: 张三 → 李四; 重要性: 中 → 高」。"""
    if not diff:
        return ""
    parts = []
    for f, ch in diff.items():
        label = _FIELD_LABELS.get(f, f)
        old_v = ch.get("old")
        new_v = ch.get("new")
        parts.append(f"{label}: {old_v or '空'} → {new_v or '空'}")
    return "; ".join(parts)[:250]


def _record_asset_change(
    db: Session,
    asset_id: int,
    agent_id: int | None,
    action: str,
    changes: dict | None = None,
    summary: str = "",
    user_id: int | None = None,
    username: str | None = None,
    ip_address: str | None = None,
    auto_commit: bool = True,
) -> None:
    """记录一条资产变更历史（失败不阻断主流程）。

    Args:
        auto_commit: 是否立即提交。批量导入时传 False 延迟提交，
            由调用方在循环结束后统一 commit，避免 10 万次 commit 导致超时。
    """
    try:
        ch = AssetChange(
            asset_id=asset_id,
            agent_id=agent_id,
            action=action,
            changes=changes or {},
            summary=summary or "",
            user_id=user_id,
            username=username,
            ip_address=ip_address,
        )
        db.add(ch)
        if auto_commit:
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("记录资产变更历史失败（不阻断主流程）: %s", exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ============================================================================
# 资产类型模板辅助函数
# ============================================================================

def _get_template(db: Session, type_code: str) -> AssetTypeTemplate | None:
    """按 code 查询资产类型模板。type_code 为空返回 None。"""
    if not type_code:
        return None
    return db.query(AssetTypeTemplate).filter(AssetTypeTemplate.code == type_code).first()


def _template_field_map(template: AssetTypeTemplate) -> dict:
    """构建 {field_key: field_def} 映射，便于按 key 查找字段定义。"""
    return {f.get("key"): f for f in (template.fields or []) if f.get("key")}


def _apply_template_to_asset(
    template: AssetTypeTemplate | None,
    raw_fields: dict,
) -> tuple[dict, dict, str, str]:
    """根据模板将 raw_fields 分发到标准字段与 extra_fields，并派生标识。

    遍历 raw_fields 中实际存在的键，按模板字段定义的 ``mapped_to`` 分发：
    - ``standard:<col>`` → 写入 Asset 表对应标准列
    - ``extra``（或其他）→ 写入 extra_fields JSON

    同时从模板的 ``identifier_field`` 派生 ``identifier`` 和 ``identifier_type``
    （ip → ip、cidr → cidr、其他 → custom）。

    Args:
        template: 资产类型模板；None 时所有字段原样塞入 extra_fields。
        raw_fields: 原始字段值字典 ``{field_key: value}``。

    Returns:
        ``(standard_fields, extra_fields, identifier, identifier_type)``
    """
    standard_fields: dict = {}
    extra_fields: dict = {}

    if template is None:
        # 无模板：全部字段塞 extra，无法派生标识
        for k, v in (raw_fields or {}).items():
            if v is None or str(v).strip() == "":
                continue
            extra_fields[k] = v
        return standard_fields, extra_fields, "", "custom"

    field_map = _template_field_map(template)
    identifier = ""
    identifier_type = "custom"

    for key, val in (raw_fields or {}).items():
        if val is None:
            continue
        # 标量值规整为字符串（select/number 统一处理）
        if isinstance(val, (int, float)):
            val = str(val)
        if isinstance(val, str) and val.strip() == "":
            continue
        if isinstance(val, str):
            val = val.strip()

        field_def = field_map.get(key)
        if field_def is None:
            # 模板未定义的字段 → 归入 extra（兼容自定义扩展）
            extra_fields[key] = val
            continue

        # 入库前校验 ip/cidr 类型字段：拦截倒置范围/巨型网段/残缺 IP 等脏数据
        # （只拦截形似 IP 数据的错误值，主机名/文本不受影响）
        if field_def.get("type") in ("ip", "cidr") and isinstance(val, str) and val:
            _validate_ip_expression(val, field_def.get("label") or key)

        mapped_to = field_def.get("mapped_to", "extra")

        # 派生标识：identifier_field 的值作为 identifier
        if key == template.identifier_field:
            identifier = str(val)
            ftype = field_def.get("type", "text")
            if ftype == "ip":
                identifier_type = "ip"
            elif ftype == "cidr":
                identifier_type = "cidr"
            else:
                identifier_type = "custom"

        # 分发到标准列或 extra
        if isinstance(mapped_to, str) and mapped_to.startswith("standard:"):
            col = mapped_to.split(":", 1)[1]
            standard_fields[col] = val
        else:
            extra_fields[key] = val

    return standard_fields, extra_fields, identifier, identifier_type


def _coerce_status(val) -> str:
    """状态值校验，非法值回退 in_use。"""
    return val if val in _ASSET_STATUS_VALUES else "in_use"


def _check_identifier_conflict(
    db: Session,
    type_code: str,
    identifier: str,
    department: str = "",
    exclude_id: int | None = None,
    template: AssetTypeTemplate | None = None,
) -> Asset | None:
    """根据模板 ``allow_aggregate`` 配置检测标识冲突。

    唯一性规则：
    - ``allow_aggregate=False``（默认）：``(type_code, identifier)`` 唯一
    - ``allow_aggregate=True``（聚合模式）：``(type_code, identifier, department)`` 唯一
      同一标识允许不同使用单位（department）共存，列表中按标识分组展开。

    Args:
        db: 数据库会话。
        type_code: 资产类型模板代码。
        identifier: 资产唯一标识（IP/CIDR/主机名等）。
        department: 使用单位/部门（聚合模式下的第二唯一键）。
        exclude_id: 排除自身 ID（更新时传入）。
        template: 模板对象；None 时按非聚合模式处理。

    Returns:
        冲突的 Asset 记录；无冲突返回 None。
    """
    allow_agg = bool(template and template.allow_aggregate)
    q = db.query(Asset).filter(
        Asset.type_code == type_code,
        Asset.identifier == identifier,
    )
    if allow_agg:
        # 聚合模式：同标识 + 同部门才算冲突
        # 部门为空时，空字符串与 NULL 视为相同（避免重复录入空部门）
        dept = (department or "").strip()
        if dept:
            q = q.filter(Asset.department == dept)
        else:
            q = q.filter((Asset.department == "") | (Asset.department.is_(None)))
    if exclude_id is not None:
        q = q.filter(Asset.id != exclude_id)
    return q.first()


def _conflict_detail(
    type_code: str, identifier: str, department: str, template: AssetTypeTemplate | None
) -> str:
    """构造冲突错误详情文案，体现聚合模式下的部门维度。"""
    allow_agg = bool(template and template.allow_aggregate)
    if allow_agg:
        return (
            f"资产已存在（type={type_code}, identifier={identifier}, "
            f"department={department or '(空)'}）"
        )
    return f"资产已存在（type_code={type_code}, identifier={identifier}）"


# ============================================================================
# 请求模型
# ============================================================================


class AssetCreateRequest(BaseModel):
    """手动新增资产请求体。

    支持两种模式：
    1. 模板模式（推荐）：传 ``type_code`` + ``fields``（字段值字典），由模板定义
       自动分发到标准列/extra_fields 并派生标识。
    2. 兼容模式：直接传标准字段（identifier/name/ip 等），无模板。
    """

    type_code: str = Field("", description="资产类型模板代码（模板模式必填）")
    fields: dict | None = Field(None, description="模板字段值字典 {field_key: value}（模板模式）")
    identifier: str = Field("", description="资产唯一标识（留空时模板模式下由 identifier_field 派生；兼容模式下取 ip 值）")
    identifier_type: str = Field("ip", description="标识类型，固定为 ip")
    name: str = Field("", description="资产名称")
    asset_type: str = Field("", description="资产类型")
    department: str = Field("", description="归属部门")
    owner: str = Field("", description="负责人")
    location: str = Field("", description="物理位置")
    ip: str = Field("", description="IP 地址（作为资产唯一标识）")
    criticality: str = Field("medium", description="重要性：low/medium/high/critical")
    status: str = Field("in_use", description="生命周期状态：in_use/idle/repair/retired/lost")
    kb_id: int = Field(0, description="来源知识库 ID")
    kb_name: str = Field("", description="来源知识库名称")
    extra_fields: dict | None = Field(None, description="灵活字段（JSON 对象）")
    tag_ids: list[int] | None = Field(None, description="标签 ID 列表（打标）")


class AssetUpdateRequest(BaseModel):
    """更新资产请求体（所有字段可选）。

    模板模式下传 ``fields``（仅含需修改的字段），按模板分发并部分更新。
    """

    type_code: str | None = Field(None, description="资产类型模板代码（切换类型）")
    fields: dict | None = Field(None, description="模板字段值字典（仅含需修改字段）")
    identifier: str | None = Field(None, description="资产唯一标识")
    identifier_type: str | None = Field(None, description="标识类型")
    name: str | None = Field(None, description="资产名称")
    asset_type: str | None = Field(None, description="资产类型")
    department: str | None = Field(None, description="归属部门")
    owner: str | None = Field(None, description="负责人")
    location: str | None = Field(None, description="物理位置")
    ip: str | None = Field(None, description="IP 地址")
    criticality: str | None = Field(None, description="重要性")
    status: str | None = Field(None, description="生命周期状态")
    kb_id: int | None = Field(None, description="来源知识库 ID")
    kb_name: str | None = Field(None, description="来源知识库名称")
    extra_fields: dict | None = Field(None, description="灵活字段（与已有 extra_fields 合并）")
    tag_ids: list[int] | None = Field(None, description="标签 ID 列表（替换该资产的标签）")


# ============================================================================
# 查询端点
# ============================================================================


def _parse_search_ip(keyword: str):
    """尝试将搜索关键词解析为 IPv4Address / IPv4Network。

    返回 (ip_obj, network_obj) 或 (None, None)：
    - ip_obj: 当 keyword 是合法单 IP 时返回 IPv4Address
    - network_obj: 当 keyword 是 CIDR 时返回 IPv4Network
    """
    s = (keyword or "").strip()
    if not s:
        return None, None
    # CIDR 格式 (219.133.105.0/24)
    if "/" in s:
        try:
            return None, ipaddress.IPv4Network(s, strict=False)
        except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
            return None, None
    # 单 IP 格式 (219.133.105.155)
    try:
        return ipaddress.IPv4Address(s), None
    except (ipaddress.AddressValueError, ValueError):
        return None, None


def _ip_matches_stored(search_ip, search_net, stored: str) -> bool:
    """判断搜索 IP/CIDR 是否命中资产 ip 字段中的存储值。

    支持逗号分隔多值、CIDR、IP 范围、单 IP 等格式。
    内部基于缓存的数值区间做包含/重叠判断（10 万级资产全量扫描也可控）。
    """
    intervals = _cached_intervals(stored)
    if not intervals:
        return False
    if search_ip is not None:
        ip_int = int(search_ip)
        for start, end in intervals:
            if start <= ip_int <= end:
                return True
        return False
    if search_net is not None:
        net_start = int(search_net.network_address)
        net_end = int(search_net.broadcast_address)
        for start, end in intervals:
            if start <= net_end and net_start <= end:
                return True
    return False


# ============ IP 数值化解析（性能关键路径，带模块级缓存） ============

def _ip2int(s: str):
    """快速把点分 IPv4 字符串转 int；非法返回 None（避免 ipaddress 异常开销）。"""
    parts = s.strip().split(".")
    if len(parts) != 4:
        return None
    value = 0
    for p in parts:
        if not p.isdigit():
            return None
        n = int(p)
        if n > 255:
            return None
        value = (value << 8) | n
    return value


def _int_to_ip(value: int) -> str:
    return ".".join(str((value >> s) & 255) for s in (24, 16, 8, 0))


def _parse_stored_intervals(stored) -> list:
    """把资产 ip 字段存储值解析为数值区间列表 [(start, end), ...]。

    支持逗号分隔多值、CIDR、IP 范围（含末段简写 192-254）、单 IP；
    与 _ip_matches_stored 语义一致，但用整数比较替代 ipaddress 对象解析。
    """
    out = []
    for part in (stored or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "/" in part:
            addr, _, mask_s = part.partition("/")
            base = _ip2int(addr)
            if base is None or not mask_s.strip().isdigit():
                continue
            mask = int(mask_s)
            if mask > 32:
                continue
            network_mask = (0xFFFFFFFF << (32 - mask)) & 0xFFFFFFFF if mask else 0
            start = base & network_mask
            end = start | (((1 << (32 - mask)) - 1) if mask < 32 else 0)
            out.append((start, end))
        elif "-" in part:
            a, _, b = part.partition("-")
            start_ip = _ip2int(a)
            end_ip = _ip2int(b)
            # 末段简写：end 为纯数字时替换 start 的最后一段（192.168.1.192-254）
            if end_ip is None and b.strip().isdigit():
                last = int(b.strip())
                if start_ip is not None and last <= 255:
                    end_ip = (start_ip & 0xFFFFFF00) | last
            if start_ip is not None and end_ip is not None and start_ip <= end_ip:
                out.append((start_ip, end_ip))
        else:
            v = _ip2int(part)
            if v is not None:
                out.append((v, v))
    return out


# 模块级解析缓存：资产 ip 存储值 → 区间列表（重复搜索直接命中缓存）
_INTERVAL_CACHE: dict[str, list] = {}
_INTERVAL_CACHE_MAX = 300000


def _cached_intervals(stored) -> list:
    key = stored or ""
    cached = _INTERVAL_CACHE.get(key)
    if cached is None:
        cached = _parse_stored_intervals(key)
        if len(_INTERVAL_CACHE) >= _INTERVAL_CACHE_MAX:
            _INTERVAL_CACHE.clear()
        _INTERVAL_CACHE[key] = cached
    return cached


# 关键词模糊搜索覆盖的字段（大小写不敏感）。
# 背景：department 是该数据集的主要可检索内容 —— 绝大多数资产没有 name，
# 只有 department 有值；此前未纳入搜索，导致这批资产按任何关键词都搜不到。
# 这里集中定义，保证 list_assets 的常规分支与 IP 智能搜索分支始终一致。
_KEYWORD_FIELDS = (
    Asset.identifier,
    Asset.name,
    Asset.ip,
    Asset.owner,
    Asset.department,
    Asset.location,
    Asset.asset_type,
    Asset.kb_name,
)


def _keyword_condition(keyword: str):
    """构造关键词模糊匹配条件：多字段 OR + 大小写不敏感（PostgreSQL ILIKE）。

    - 用 ILIKE 而非 LIKE：LIKE 在 PG 下区分大小写，英文名称/标识会搜不到。
    - 使用 f"%{kw}%" 做包含匹配（真正的"模糊"），而非前缀匹配。
    """
    like = f"%{keyword}%"
    return or_(*[col.ilike(like) for col in _KEYWORD_FIELDS])


def _apply_asset_filters(
    query, kb_id, asset_type, department, criticality, source, keyword,
    status=None, tag_id=None, type_code=None,
):
    """应用资产筛选条件（list_assets 与 /ids 共用，DRY）。

    智能搜索：当 keyword 是合法 IP/CIDR 时，先用 SQL LIKE 模糊匹配拉取候选集，
    再在 Python 层做精确的 CIDR/范围包含判断（含逗号分隔多 IP 场景）。
    """
    if type_code:
        query = query.filter(Asset.type_code == type_code)
    if kb_id is not None:
        query = query.filter(Asset.kb_id == kb_id)
    if asset_type:
        query = query.filter(Asset.asset_type == asset_type)
    if department:
        query = query.filter(Asset.department == department)
    if criticality:
        query = query.filter(Asset.criticality == criticality)
    if status:
        query = query.filter(Asset.status == status)
    if source:
        query = query.filter(Asset.source == source)
    if tag_id:
        # 多对多标签筛选：asset 必须关联该 tag
        query = query.filter(Asset.tags.any(AssetTag.id == tag_id))
    if keyword:
        query = query.filter(_keyword_condition(keyword))
    return query


# 排序字段白名单（防 SQL 注入：仅允许这些列名参与排序）
_SORT_BY_WHITELIST = {
    "id": Asset.id,
    "identifier": Asset.identifier,
    "name": Asset.name,
    "asset_type": Asset.asset_type,
    "criticality": Asset.criticality,
    "status": Asset.status,
    "created_at": Asset.created_at,
    "updated_at": Asset.updated_at,
}


@router.get("", dependencies=[Depends(require_permission("asset_list", "view"))])
def list_assets(
    type_code: str = Query("", description="按资产类型模板代码筛选"),
    kb_id: int | None = Query(None, description="按来源知识库筛选"),
    asset_type: str = Query("", description="按资产类型筛选"),
    department: str = Query("", description="按部门筛选"),
    criticality: str = Query("", description="按重要性筛选：low/medium/high/critical"),
    status: str = Query("", description="按生命周期状态筛选：in_use/idle/repair/retired/lost"),
    source: str = Query("", description="按来源筛选：kb_ingest/agent_add/manual"),
    tag_id: int | None = Query(None, description="按标签 ID 筛选"),
    keyword: str = Query("", description="模糊搜索 identifier/name/ip/owner"),
    sort_by: str = Query("id", description="排序字段：id/identifier/name/asset_type/criticality/status/created_at/updated_at"),
    order: str = Query("desc", description="排序方向：asc/desc"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=200, description="每页条数"),
    db: Session = Depends(get_db),
) -> dict:
    """资产列表（分页 + 多维筛选 + 关键词搜索 + 排序）。

    智能搜索：当 keyword 是合法 IP/CIDR 时，其余筛选条件仍走 SQL，但 ip 命中
    判断在 Python 层用数值区间完成（支持 CIDR/跨段范围/逗号分隔多值存储）。
    单 IP 精准匹配未命中时，额外返回 suggestions（最接近的 5 个 IP 信息）。
    """
    # ===== IP 智能搜索 =====
    search_ip, search_net = _parse_search_ip(keyword)

    # 精确匹配 + 最近 IP 建议（IP 检索统一走轻量列扫描 + Python 数值过滤）
    suggestions: list[dict] = []

    if search_ip or search_net:
        # 背景：资产 ip 字段存在大量大范围存储（CIDR / 跨段范围，如 192.168.194.62/3、
        # 58.250.156.224-218.17.86.254），此前用"前三段前缀 LIKE"拉候选集会漏掉它们，
        # 导致按 IP 永远检索不到资产。改为：其余筛选条件仍走 SQL，ip 命中在 Python 层
        # 用数值区间判断（带模块级缓存，全量 10 万级资产扫描 < 1s）。
        sort_col = _SORT_BY_WHITELIST.get(sort_by, Asset.id)
        order_dir = sort_col.desc() if order.lower() == "desc" else sort_col.asc()
        light_query = _apply_asset_filters(
            db.query(Asset.id, Asset.ip, Asset.identifier, Asset.name, Asset.type_code),
            kb_id, asset_type, department, criticality, source, "", status, tag_id, type_code,
        )
        all_rows = light_query.order_by(order_dir).all()
        filtered_ids: list[int] = []
        for row in all_rows:
            if _ip_matches_stored(search_ip, search_net, row.ip):
                filtered_ids.append(row.id)
            elif search_ip and row.identifier and str(search_ip) == row.identifier:
                filtered_ids.append(row.id)
        total = len(filtered_ids)
        start = (page - 1) * page_size
        page_ids = filtered_ids[start:start + page_size]
        if page_ids:
            records = (
                db.query(Asset)
                .filter(Asset.id.in_(page_ids))
                .all()
            )
            # 保持 light_query 的排序展示
            order_map = {aid: i for i, aid in enumerate(page_ids)}
            records.sort(key=lambda a: order_map.get(a.id, 0))
        else:
            records = []
        # 精准匹配未命中（单 IP）→ 计算最接近的 5 个 IP 信息供前端展示
        if search_ip is not None and total == 0:
            suggestions = _nearest_ip_suggestions(all_rows, search_ip)
    else:
        # ===== 常规搜索（非 IP keyword） =====
        query = _apply_asset_filters(
            db.query(Asset), kb_id, asset_type,
            department, criticality, source, keyword, status, tag_id, type_code,
        )

        # 排序（白名单校验，非法值回退 id）
        sort_col = _SORT_BY_WHITELIST.get(sort_by, Asset.id)
        order_dir = sort_col.desc() if order.lower() == "desc" else sort_col.asc()

        total = query.count()
        records = (
            query.order_by(order_dir)
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

    result = {
        "items": to_dict_list_with_agent_name(records, db),
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size if total > 0 else 0,
    }
    if suggestions:
        result["suggestions"] = suggestions
    return result


def _nearest_ip_suggestions(all_rows, search_ip, limit: int = 5) -> list[dict]:
    """从候选行中找出与搜索 IP 数值最接近的 limit 个 IP 信息。

    每个资产取其各区间到搜索 IP 的最近端点作为代表 IP，按距离升序返回；
    用于"精准匹配未命中"时给用户最接近的 5 个 IP 线索（可点击二次检索）。
    """
    ip_int = int(search_ip)
    best = []
    for row in all_rows:
        intervals = _cached_intervals(row.ip)
        if not intervals:
            continue
        best_dist = None
        best_ip_int = None
        for start, end in intervals:
            if start <= ip_int <= end:
                best_dist, best_ip_int = 0, ip_int
                break
            for edge in (start, end):
                dist = abs(edge - ip_int)
                if best_dist is None or dist < best_dist:
                    best_dist, best_ip_int = dist, edge
        if best_ip_int is not None:
            best.append((best_dist, row.id, best_ip_int, row.ip, row.name or row.identifier or f"资产{row.id}", row.type_code))
    best.sort(key=lambda x: (x[0], x[1]))
    return [
        {
            "ip": _int_to_ip(item[2]),
            "asset_id": item[1],
            "asset_name": item[4],
            "stored_ip": item[3],
            "type_code": item[5],
        }
        for item in best[:limit]
    ]


def _asset_tags_to_list(record: Asset) -> list[dict]:
    """把资产的 tags relationship 序列化为 [{id, name, color}, ...]。"""
    return [{"id": t.id, "name": t.name, "color": t.color} for t in (record.tags or [])]


def to_dict_list_with_agent_name(records: list, db: Session) -> list[dict]:
    """序列化资产列表，附加 tags 便于前端展示。"""
    if not records:
        return []
    result = []
    for r in records:
        d = to_dict(r)
        d["tags"] = _asset_tags_to_list(r)
        result.append(d)
    return result


@router.get("/ids", dependencies=[Depends(require_permission("asset_list", "view"))])
def list_asset_ids(
    type_code: str = Query("", description="按资产类型模板代码筛选"),
    kb_id: int | None = Query(None, description="按来源知识库筛选"),
    asset_type: str = Query("", description="按资产类型筛选"),
    department: str = Query("", description="按部门筛选"),
    criticality: str = Query("", description="按重要性筛选"),
    status: str = Query("", description="按生命周期状态筛选"),
    source: str = Query("", description="按来源筛选"),
    tag_id: int | None = Query(None, description="按标签 ID 筛选"),
    keyword: str = Query("", description="模糊搜索"),
    db: Session = Depends(get_db),
) -> dict:
    """返回当前筛选条件下所有匹配资产的 ID 列表（不分页，跨页全选用）。

    上限 10000 条防止内存爆炸。前端「全选所有匹配结果」调用此端点拿全量 ID，
    再走 batch 端点批量操作。

    注意：此端点必须定义在 ``GET /{asset_id}`` 之前，否则 "ids" 会被
    ``{asset_id}`` 路径参数匹配并尝试解析为整数，返回 422 错误。

    IP 智能匹配口径与 ``GET /assets`` 列表一致：keyword 为合法 IP/CIDR 时，
    用轻量列扫描 + Python 数值区间过滤（支持 CIDR/跨段范围/逗号分隔多值存储）。
    """
    search_ip, search_net = _parse_search_ip(keyword)
    if search_ip or search_net:
        light_query = _apply_asset_filters(
            db.query(Asset.id, Asset.ip, Asset.identifier),
            kb_id, asset_type, department, criticality, source, "", status, tag_id, type_code,
        )
        all_rows = light_query.all()
        ids = []
        for row in all_rows:
            if _ip_matches_stored(search_ip, search_net, row.ip):
                ids.append(row.id)
            elif search_ip and row.identifier and str(search_ip) == row.identifier:
                ids.append(row.id)
            if len(ids) >= 10000:
                break
        return {"ids": ids, "total": len(ids)}
    query = _apply_asset_filters(
        db.query(Asset.id), kb_id, asset_type,
        department, criticality, source, keyword, status, tag_id, type_code,
    )
    rows = query.limit(10000).all()
    ids = [r[0] for r in rows]
    return {"ids": ids, "total": len(ids)}


@router.get("/field-options", dependencies=[Depends(require_permission("asset_list", "view"))])
def get_field_options(
    type_code: str = Query("", description="按资产类型模板代码筛选"),
    db: Session = Depends(get_db),
) -> dict:
    """返回部门/负责人/资产类型的去重值列表（供前端 datalist 补全）。

    基于 Asset 表已有数据 DISTINCT 查询，过滤空值，每个字段限 200 个。
    用于新增/编辑表单和筛选栏的自动补全，避免同义词发散。
    可传 ``type_code`` 限定在某一资产类型范围内补全。
    """
    base = db.query(Asset)
    if type_code:
        base = base.filter(Asset.type_code == type_code)

    def _distinct(col):
        rows = base.with_entities(col).filter(col != "").distinct().limit(200).all()
        return sorted([r[0] for r in rows if r[0]])

    return {
        "departments": _distinct(Asset.department),
        "owners": _distinct(Asset.owner),
        "asset_types": _distinct(Asset.asset_type),
    }


@router.get("/stats", dependencies=[Depends(require_permission("asset_overview", "view"))])
def get_asset_stats(
    type_code: str = Query("", description="按资产类型模板代码筛选"),
    db: Session = Depends(get_db),
) -> dict:
    """资产统计信息（总数 / 按类型 / 按来源 / 按重要性 / 按状态 / 按模板）。"""
    query = db.query(Asset)
    if type_code:
        query = query.filter(Asset.type_code == type_code)

    total = query.count()

    # Python 侧聚合（数据量不大时更清晰，避免复杂 SQL）
    all_records = query.with_entities(
        Asset.type_code, Asset.asset_type, Asset.source,
        Asset.criticality, Asset.status,
    ).all()

    by_type: dict[str, int] = {}
    by_source: dict[str, int] = {}
    by_criticality: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_template: dict[str, int] = {}
    for r in all_records:
        t = r.asset_type or "未分类"
        by_type[t] = by_type.get(t, 0) + 1
        s = r.source or "unknown"
        by_source[s] = by_source.get(s, 0) + 1
        c = r.criticality or "medium"
        by_criticality[c] = by_criticality.get(c, 0) + 1
        st = r.status or "in_use"
        by_status[st] = by_status.get(st, 0) + 1
        tc = r.type_code or "uncategorized"
        by_template[tc] = by_template.get(tc, 0) + 1

    return {
        "total": total,
        "by_type": by_type,
        "by_source": by_source,
        "by_criticality": by_criticality,
        "by_status": by_status,
        "by_template": by_template,
    }


@router.get("/overview", dependencies=[Depends(require_permission("asset_overview", "view"))])
def get_asset_overview(
    db: Session = Depends(get_db),
) -> dict:
    """资产总览可视化数据（供资产总览页 ECharts 渲染）。

    返回结构：
    - ``total``：资产总数
    - ``templates``：模板列表（含元信息 + 该模板下资产数）
    - ``by_template``：按模板代码计数 ``{code: count}``
    - ``by_status``：按生命周期状态计数
    - ``by_criticality``：按重要性计数
    - ``by_department``：按部门计数（Top 15，降序）
    - ``by_cloud``：主机资产按所属云计数（从 extra_fields.cloud 聚合）
    - ``trend``：近 30 天每日新增资产数（按 created_at 日期分组）
    """
    from datetime import timedelta

    base = db.query(Asset)
    total = base.count()

    # 模板元信息 + 每个模板下资产数
    templates = db.query(AssetTypeTemplate).order_by(
        AssetTypeTemplate.sort_order.asc(), AssetTypeTemplate.id.asc()
    ).all()
    tpl_list = []
    for t in templates:
        cnt = base.filter(Asset.type_code == t.code).count()
        tpl_list.append({
            "code": t.code, "name": t.name, "icon": t.icon, "color": t.color,
            "description": t.description or "", "count": cnt,
            "is_preset": t.is_preset,
        })

    # 一次拉取聚合所需字段
    rows = base.with_entities(
        Asset.type_code, Asset.status, Asset.criticality,
        Asset.department, Asset.extra_fields, Asset.created_at,
    ).all()

    by_template: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_criticality: dict[str, int] = {}
    by_department: dict[str, int] = {}
    by_cloud: dict[str, int] = {}
    today = beijing_now().date()
    date_idx = { (today - timedelta(days=i)).isoformat(): 0 for i in range(29, -1, -1) }

    for r in rows:
        tc = r.type_code or "uncategorized"
        by_template[tc] = by_template.get(tc, 0) + 1
        st = r.status or "in_use"
        by_status[st] = by_status.get(st, 0) + 1
        c = r.criticality or "medium"
        by_criticality[c] = by_criticality.get(c, 0) + 1
        dept = (r.department or "").strip()
        if dept:
            by_department[dept] = by_department.get(dept, 0) + 1
        # 主机资产所属云（extra_fields.cloud）
        if r.type_code == "host_asset" and r.extra_fields:
            cloud = (r.extra_fields.get("cloud") or "").strip()
            if cloud:
                by_cloud[cloud] = by_cloud.get(cloud, 0) + 1
        # 趋势
        if r.created_at:
            dkey = r.created_at.strftime("%Y-%m-%d")
            if dkey in date_idx:
                date_idx[dkey] += 1

    # 部门 Top 15
    dept_sorted = sorted(by_department.items(), key=lambda x: x[1], reverse=True)[:15]
    by_department_top = {k: v for k, v in dept_sorted}

    trend = [{"date": d, "count": c} for d, c in date_idx.items()]

    return {
        "total": total,
        "templates": tpl_list,
        "by_template": by_template,
        "by_status": by_status,
        "by_criticality": by_criticality,
        "by_department": by_department_top,
        "by_cloud": by_cloud,
        "trend": trend,
    }


@router.get("/export", dependencies=[Depends(require_permission("asset_list", "view"))])
def export_assets(
    ids: str = Query("", description="指定资产 ID 列表（逗号分隔，如 '1,2,3'）；非空时只导出这些资产"),
    type_code: str = Query("", description="按资产类型模板代码筛选；传了则按模板字段列导出"),
    fields: str = Query("", description="指定导出字段（逗号分隔的模板字段 key）；为空则导出全部字段"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    request: Request = None,
) -> StreamingResponse:
    """导出资产为 CSV。

    - 未传 ``ids``：导出全部资产。
    - 传 ``ids``：只导出指定的资产（用于「导出选中」）。
    - 传 ``type_code``：按该模板的字段定义导出列（field_label 作表头），仅导出该类型资产。
    - 传 ``fields``：仅导出指定字段（逗号分隔的 key），配合 type_code 使用实现字段选择。
    - 未传 ``type_code``：标准列 + 全局自定义字段列（兼容旧逻辑）。
    """
    # 审计：导出操作（GET 请求不被中间件捕获，需手动记录）
    from app.core.audit import get_client_ip, log_audit
    ip = get_client_ip(request) if request else "unknown"
    log_audit(db, user_id=user.id, username=user.username, action="export",
              resource_type="asset", ip_address=ip, result="success",
              detail={"ids": ids, "type_code": type_code})
    # 解析指定字段集合（字段选择）
    selected_fields = set()
    if fields:
        for part in fields.split(","):
            k = part.strip()
            if k:
                selected_fields.add(k)
    query = db.query(Asset)
    if ids:
        # 解析逗号分隔的 ID，忽略非法值
        id_list = []
        for part in ids.split(","):
            part = part.strip()
            if part.isdigit():
                id_list.append(int(part))
        if id_list:
            query = query.filter(Asset.id.in_(id_list))

    output = io.StringIO()
    output.write("\ufeff")  # BOM for Excel
    writer = csv.writer(output)

    # ===== 模板模式：按模板字段定义导出 =====
    if type_code:
        template = _get_template(db, type_code)
        if template is None:
            raise HTTPException(status_code=404, detail=f"模板不存在: {type_code}")
        query = query.filter(Asset.type_code == type_code)
        records = query.order_by(Asset.id.desc()).all()

        # 表头：模板字段 label（按 sort_order）+ 元信息列
        field_defs = sorted(
            template.fields or [],
            key=lambda f: (f.get("sort_order", 0), f.get("key", "")),
        )
        # 字段选择：若指定了 fields，仅保留选中的字段
        if selected_fields:
            field_defs = [f for f in field_defs if f.get("key", "") in selected_fields]
        meta_headers = ["ID", "标识", "状态", "来源", "创建时间"]
        field_labels = [f.get("label", f.get("key", "")) for f in field_defs]
        writer.writerow(meta_headers + field_labels)

        # 字段 key → 取值函数（标准列从 Asset 列取，extra 从 extra_fields 取）
        def _get_field_value(rec: Asset, fdef: dict):
            key = fdef.get("key", "")
            mapped_to = fdef.get("mapped_to", "extra")
            if isinstance(mapped_to, str) and mapped_to.startswith("standard:"):
                col = mapped_to.split(":", 1)[1]
                return getattr(rec, col, "") or ""
            extra = rec.extra_fields or {}
            v = extra.get(key, "")
            return v if v is not None else ""

        for r in records:
            row_meta = [
                r.id, r.identifier, r.status, r.source,
                r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
            ]
            row_vals = [_get_field_value(r, f) for f in field_defs]
            writer.writerow(row_meta + row_vals)

        output.seek(0)
        filename = f"assets_{type_code}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    # ===== 兼容模式：标准列 + 全局自定义字段列 =====
    records = query.order_by(Asset.id.desc()).all()

    # 查询所有自定义字段定义（按 sort_order 排序），用于拆分独立列
    custom_fields = db.query(AssetCustomField).order_by(
        AssetCustomField.sort_order.asc(), AssetCustomField.id.asc()
    ).all()

    # 标准列 + 自定义字段列（field_label 作表头）
    std_headers = [
        "ID", "知识库ID", "知识库名称",
        "标识", "名称", "资产类型",
        "部门", "负责人", "位置", "IP",
        "重要性", "状态", "来源",
        "创建时间", "更新时间",
    ]
    cf_labels = [f.field_label for f in custom_fields]
    writer.writerow(std_headers + cf_labels)

    for r in records:
        extra = r.extra_fields or {}
        # 自定义字段值：按 field_key 从 extra_fields 取值
        cf_values = [extra.get(f.field_key, "") if extra.get(f.field_key) is not None else "" for f in custom_fields]
        writer.writerow([
            r.id, r.kb_id, r.kb_name,
            r.identifier, r.name, r.asset_type,
            r.department, r.owner, r.location, r.ip,
            r.criticality, r.status, r.source,
            r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
            r.updated_at.strftime("%Y-%m-%d %H:%M:%S") if r.updated_at else "",
        ] + cf_values)

    output.seek(0)
    filename = "assets.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ============================================================================
# 批量导入（CSV/Excel）
# ============================================================================

# Asset 模型各字段最大长度（用于导入时截断保护，防止 varchar 超限报 500）
_ASSET_FIELD_MAXLEN = {
    "identifier": 255,
    "name": 255,
    "asset_type": 64,
    "department": 128,
    "owner": 128,
    "location": 128,
    # ip 支持 256：多 IP/多 CIDR 逗号列表（128 截断曾把 /24 截成 /2 产生脏数据）
    "ip": 256,
    "criticality": 16,
    "status": 32,
    "identifier_type": 32,
    "type_code": 64,
    "source": 20,
}

# 批量导入每批提交行数：平衡内存与性能
# 1000 行/commit：10 万行约 100 次 commit，远少于逐行 commit 的 10 万次
_IMPORT_BATCH_SIZE = 1000


def _truncate_field(name: str, value, maxlen: int = None) -> str:
    """截断字段值到数据库列允许的最大长度。

    导入时 Excel/CSV 数据可能包含超长值（如完整部门路径、长描述），
    直接 INSERT 会触发 StringDataRightTruncation 报 500。
    此函数做防御性截断并记日志。
    """
    if value is None:
        return ""
    s = str(value).strip()
    limit = maxlen or _ASSET_FIELD_MAXLEN.get(name, 255)
    if len(s) > limit:
        logger.warning("导入字段 %s 超长（%d > %d），已截断: %s…", name, len(s), limit, s[:30])
        return s[:limit]
    return s


# ============================================================================
# 入库前 IP/CIDR/范围 校验（防脏数据）
# ============================================================================
# 历史脏数据案例（均已修正）：
# - 172.46.9.1-17.46.9.62   丢字导致倒置范围 → 解析成 17.x-172.x 巨型区间
# - 10.0.2.1-1.0.2.254      同上
# - 176.16.173.1-176.13.173.254 同上
# - 143.146.79.0/24 列宽截断成 143.146.79.0/2 → 覆盖 128.0.0.0/2 约 10 亿地址

# IPv4 CIDR 最小前缀长度：/8（如 10.0.0.0/8）为合法大网段下限，/2~/7 视为笔误
_IP_CIDR_MIN_PREFIX = 8
# IP 范围最大跨度：一个 /8（16777216 地址），超过视为录入错误
_IP_RANGE_MAX_ADDRS = 2 ** 24
# "形似 IPv4 数据"：数字开头且带点组（10.1 / 172.46.9.1-... / 143.146.79.0/...），
# 或"数字+斜杠/横线"（1-100、24/7 这类）→ 必须通过严格校验；
# 纯数字或数字开头的文本（"2024"、"123办公室"）与主机名/纯文本放行
_IPISH_RE = re.compile(r"^(?:\d{1,3}(?:\.\d{1,3})+|\d+[/-])")
# "形似 IPv6 数据"（纯十六进制/冒号，可带掩码）
_IPV6ISH_RE = re.compile(r"^[0-9A-Fa-f:]+(/\d+)?$")


def _validate_ip_expression(value, field_label: str = "") -> None:
    """入库前校验 IP/CIDR/范围表达式，拦截倒置范围、巨型网段、残缺 IP 等脏数据。

    只拦截"看起来是 IP 数据但格式错误"的值；主机名、纯文本（含数字开头
    的文本如 ``123办公室``）不受影响（与检索层 ``_value_to_intervals``
    的尽力解析语义保持兼容）。

    校验规则：
    - 多值（逗号/分号/顿号/空白分隔，与检索层 ``_split_tokens`` 一致）
      逐段校验，任一段非法即整体报错
    - IPv4 CIDR：必须是合法网段，且前缀长度不得小于 /8
    - IPv4 范围 start-end：两端必须是完整 IPv4（末段支持 192.0.2.1-100
      短格式）；起始不得大于结束（倒置范围几乎必为丢字笔误）；
      跨度不得超过一个 /8
    - IPv4 单值：必须是完整合法 IPv4（残缺如 ``10.1`` 报错）
    - IPv6：地址/网段须可解析

    Raises:
        ValueError: 校验失败，消息可直接展示给用户
    """
    s = str(value or "").strip()
    if not s:
        return
    label = f"字段'{field_label}'" if field_label else "IP 字段"
    for i, part in enumerate(re.split(r"[,;，；、\s]+", s)):
        elem = part.strip()
        if not elem:
            continue
        where = f"{label}第{i + 1}段 '{elem}'"
        # 非形似 IP 数据（主机名/文本）：放行
        if not _IPISH_RE.match(elem):
            if ":" in elem and _IPV6ISH_RE.match(elem):
                # 形似 IPv6：地址/网段须可解析
                try:
                    if "/" in elem:
                        ipaddress.ip_network(elem, strict=False)
                    else:
                        ipaddress.ip_address(elem)
                except ValueError:
                    raise ValueError(f"{where} 不是合法的 IPv6 地址/网段")
            continue
        # ===== 形似 IPv4 数据：严格校验 =====
        # CIDR：合法网段 + 前缀下限
        if "/" in elem:
            try:
                net = ipaddress.ip_network(elem, strict=False)
            except ValueError:
                raise ValueError(f"{where} 不是合法的网段（CIDR）格式")
            if net.version == 4 and net.prefixlen < _IP_CIDR_MIN_PREFIX:
                raise ValueError(
                    f"{where} 掩码 /{net.prefixlen} 过小（覆盖 {net.num_addresses:,} 个地址），"
                    f"疑似笔误；IPv4 网段前缀不得小于 /{_IP_CIDR_MIN_PREFIX}"
                )
            continue
        # 范围：start-end
        if "-" in elem:
            start_str, _, end_str = elem.partition("-")
            start_str, end_str = start_str.strip(), end_str.strip()
            try:
                start_ip = ipaddress.IPv4Address(start_str)
            except ValueError:
                raise ValueError(f"{where} 范围起始地址无效：'{start_str}'（需完整 IPv4）")
            if end_str.isdigit():
                # 短格式：同前缀末段（192.0.2.1-100）
                prefix = start_str.rsplit(".", 1)[0]
                try:
                    end_ip = ipaddress.IPv4Address(f"{prefix}.{end_str}")
                except ValueError:
                    raise ValueError(f"{where} 范围结束地址无效：'{end_str}'")
            else:
                try:
                    end_ip = ipaddress.IPv4Address(end_str)
                except ValueError:
                    raise ValueError(f"{where} 范围结束地址无效：'{end_str}'（需完整 IPv4）")
            if start_ip > end_ip:
                raise ValueError(
                    f"{where} 起始 IP 大于结束 IP（倒置范围，疑似丢字/笔误），"
                    f"请修正为 {end_ip}-{start_ip}"
                )
            span = int(end_ip) - int(start_ip) + 1
            if span > _IP_RANGE_MAX_ADDRS:
                raise ValueError(
                    f"{where} 范围跨度过大（{span:,} 个地址，超过一个 /8），疑似笔误"
                )
            continue
        # 单值：必须完整合法
        try:
            ipaddress.IPv4Address(elem)
        except ValueError:
            raise ValueError(f"{where} 不是合法的完整 IPv4 地址（残缺 IP 请补全四段）")


def _check_asset_field_len(identifier: str, ip_value: str) -> None:
    """ip/identifier 列宽预检：超长直接报错，禁止静默截断。

    截断会破坏 IP 表达式语义——历史案例：ip 列还是 varchar(128) 时，
    129 字符的多 CIDR 列表被截断，末段 ``143.146.79.0/24`` 变成
    ``143.146.79.0/2``，导致任意 128.x-191.x IP 误命中。
    ip 列现已扩为 varchar(256)，此检查保留作为列宽防线（超长值报错
    而非截断，用户可拆分导入）。
    """
    if identifier and len(identifier) > _ASSET_FIELD_MAXLEN["identifier"]:
        raise ValueError(
            f"identifier 值过长（{len(identifier)} > {_ASSET_FIELD_MAXLEN['identifier']} 字符）"
        )
    if ip_value and len(ip_value) > _ASSET_FIELD_MAXLEN["ip"]:
        raise ValueError(
            f"ip 值过长（{len(ip_value)} > {_ASSET_FIELD_MAXLEN['ip']} 字符），"
            f"多 IP/网段合并存储超出列宽，请缩小范围或拆分为多条导入"
        )


# 导入支持的标准字段列名 → Asset 属性
# identifier 和 identifier_type 不在此映射中：
# - identifier 自动从 ip 列派生（或单独的 identifier 列）
# - identifier_type 固定为 ip
_IMPORT_FIELD_MAP = {
    "name": "name",
    "asset_type": "asset_type",
    "department": "department",
    "owner": "owner",
    "location": "location",
    "ip": "ip",
    "criticality": "criticality",
    "status": "status",
}


@router.get("/import-template", dependencies=[Depends(require_permission("asset_list", "view"))])
def download_import_template(
    type_code: str = Query("", description="资产类型模板代码；传了则按模板字段生成表头与示例"),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """下载资产导入 CSV 模板。

    - 传 ``type_code``：按该模板字段定义生成表头（field_label 作列名）+ 示例行 +
      字段说明。导入时按模板字段映射，identifier 由模板 identifier_field 派生。
    - 未传 ``type_code``：标准字段表头 + 全局自定义字段列 + 多 IP 格式示例（兼容旧逻辑）。
    """
    output = io.StringIO()
    output.write("\ufeff")  # BOM for Excel
    writer = csv.writer(output)

    # ===== 模板模式 =====
    if type_code:
        template = _get_template(db, type_code)
        if template is None:
            raise HTTPException(status_code=404, detail=f"模板不存在: {type_code}")
        field_defs = sorted(
            template.fields or [],
            key=lambda f: (f.get("sort_order", 0), f.get("key", "")),
        )
        # 表头用 field_label
        headers = [f.get("label", f.get("key", "")) for f in field_defs]
        writer.writerow(headers)

        # 示例行：按字段类型/default/options 生成
        example_row = []
        for f in field_defs:
            ftype = f.get("type", "text")
            if f.get("default"):
                example_row.append(f["default"])
            elif ftype == "select" and f.get("options"):
                example_row.append(f["options"][0])
            elif ftype == "number":
                example_row.append("100")
            elif ftype == "date":
                example_row.append("2026-01-01")
            elif ftype == "ip":
                example_row.append("192.0.2.10")
            elif ftype == "cidr":
                example_row.append("192.0.2.0/24")
            else:
                example_row.append(f"示例{f.get('label', f.get('key', ''))}")
        writer.writerow(example_row)

        # 字段说明（必填/类型/选项），导入时删除
        writer.writerow([])
        writer.writerow([f"# 模板：{template.name}（{template.code}），导入时请删除以 # 开头的说明行"])
        writer.writerow([f"# 标识字段：{template.identifier_field}（该列值作为资产唯一标识）"])
        for f in field_defs:
            parts = [f"# {f.get('label', f.get('key', ''))}"]
            parts.append(f"类型={f.get('type', 'text')}")
            if f.get("required"):
                parts.append("必填")
            if f.get("unique"):
                parts.append("唯一")
            if f.get("type") == "select" and f.get("options"):
                parts.append(f"可选值: {' / '.join(f['options'])}")
            writer.writerow([" ".join(parts)])

        # IP 类型标识字段支持多格式展开说明
        id_field_def = next((f for f in field_defs if f.get("key") == template.identifier_field), None)
        if id_field_def and id_field_def.get("type") in ("ip",):
            writer.writerow([])
            writer.writerow(["# IP 标识字段支持多格式（导入时请删除说明行）："])
            writer.writerow(["#   单个 IP：192.0.2.10"])
            writer.writerow(["#   CIDR 网段：192.0.2.0/24（展开为该网段所有主机 IP，合并为一条资产）"])
            writer.writerow(["#   完整范围：198.51.100.1-198.51.100.50（起止 IP 之间所有地址，合并为一条资产）"])
            writer.writerow(["#   短格式范围：203.0.113.1-100（同前缀末段范围，等价于 203.0.113.1-203.0.113.100）"])
            writer.writerow(["#   多 IP 合并：展开后的所有 IP 以逗号拼接存为一条资产记录"])

        output.seek(0)
        filename = f"asset_import_template_{type_code}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    # ===== 兼容模式：标准字段 + 全局自定义字段 =====
    custom_fields = db.query(AssetCustomField).order_by(
        AssetCustomField.sort_order.asc(), AssetCustomField.id.asc()
    ).all()

    # 标准列 + 自定义字段列（identifier 自动从 ip 派生，无需单独列）
    std_headers = [
        "ip", "name", "asset_type",
        "department", "owner", "location", "criticality", "status",
    ]
    cf_labels = [f.field_label for f in custom_fields]
    writer.writerow(std_headers + cf_labels)

    # 示例行：标准字段示例 + 自定义字段占位示例
    std_example = [
        "192.0.2.10", "Web服务器-01", "服务器",
        "运维部", "张三", "机房A-01", "high", "in_use",
    ]
    # 为每个自定义字段生成示例值（select 类型取第一个选项，其他类型给占位文本）
    cf_examples = []
    for f in custom_fields:
        if f.field_type == "select" and f.options:
            cf_examples.append(f.options[0])
        elif f.field_type == "number":
            cf_examples.append("100")
        elif f.field_type == "date":
            cf_examples.append("2026-01-01")
        else:
            cf_examples.append(f"示例{f.field_label}")
    writer.writerow(std_example + cf_examples)

    # 多 IP 格式示例行
    writer.writerow([
        "192.0.2.0/24", "网段服务器", "服务器",
        "运维部", "李四", "机房B", "medium", "in_use",
    ] + [""] * len(cf_labels))
    writer.writerow([
        "198.51.100.1-198.51.100.50", "办公终端", "工作站",
        "行政部", "王五", "办公区", "low", "in_use",
    ] + [""] * len(cf_labels))
    writer.writerow([
        "203.0.113.1-100", "内网设备", "网络设备",
        "网络部", "赵六", "机柜C", "high", "in_use",
    ] + [""] * len(cf_labels))

    # IP 格式说明
    writer.writerow([])  # 空行分隔
    writer.writerow(["# IP 地址支持以下格式（导入时请删除以 # 开头的说明行）："])
    writer.writerow(["#   单个 IP：192.0.2.10"])
    writer.writerow(["#   CIDR 网段：192.0.2.0/24（展开为该网段所有主机 IP，合并为一条资产）"])
    writer.writerow(["#   完整范围：198.51.100.1-198.51.100.50（起止 IP 之间所有地址，合并为一条资产）"])
    writer.writerow(["#   短格式范围：203.0.113.1-100（同前缀末段范围，等价于 203.0.113.1-203.0.113.100）"])
    writer.writerow(["#   多 IP 合并：CIDR/范围展开后的所有 IP 以逗号拼接存为一条资产"])
    writer.writerow(["#   多 IP 设备：一台设备多个 IP 时，合并为一条资产记录便于统一管理"])

    # 如果有 select 类型字段，追加一行注释说明可选项
    select_fields = [f for f in custom_fields if f.field_type == "select" and f.options]
    if select_fields:
        writer.writerow([])
        writer.writerow(["# 以下为 select 类型字段的可选值说明（导入时请删除此部分）"])
        for f in select_fields:
            writer.writerow([f"# {f.field_label}: {' / '.join(f.options)}"])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=asset_import_template.csv"},
    )


def _expand_ip_expression(ip_expr: str, max_count: int = 65536) -> list[str]:
    """将 IP 表达式展开为单个 IP 地址列表。

    支持以下格式：
    - 单个 IP：``192.0.2.10``
    - CIDR：``192.0.2.0/24``、``198.51.100.0/24``
    - 完整范围：``192.0.2.1-192.0.2.100``
    - 短格式范围（同前缀）：``192.0.2.1-100``

    Args:
        ip_expr: IP 表达式字符串
        max_count: 最大展开数量，防止内存爆炸

    Returns:
        单个 IP 字符串列表

    Raises:
        ValueError: 格式无效或展开数量超过 max_count
    """
    ip_expr = ip_expr.strip()
    if not ip_expr:
        return []

    # CIDR 格式：含 /
    if '/' in ip_expr:
        net = ipaddress.ip_network(ip_expr, strict=False)
        # /31 和 /32 的 hosts() 可能为空，直接遍历 network
        hosts = [str(ip) for ip in net.hosts()] or [str(ip) for ip in net]
        if len(hosts) > max_count:
            raise ValueError(
                f"CIDR 范围过大：{ip_expr} 包含 {len(hosts)} 个地址，"
                f"超过单行上限 {max_count}，请缩小范围"
            )
        return hosts

    # 范围格式：含 -
    if '-' in ip_expr:
        parts = ip_expr.split('-', 1)
        start_str = parts[0].strip()
        end_str = parts[1].strip()

        try:
            start_ip = ipaddress.ip_address(start_str)
        except ValueError:
            raise ValueError(f"IP 范围起始地址无效：{start_str}")

        # 判断 end_str 是完整 IP 还是短格式（纯数字）
        if end_str.isdigit():
            # 短格式：192.0.2.1-100 → 起始 IP 的前三段 + 末段数字
            prefix = start_str.rsplit('.', 1)[0]
            end_ip = ipaddress.ip_address(f"{prefix}.{end_str}")
        else:
            try:
                end_ip = ipaddress.ip_address(end_str)
            except ValueError:
                raise ValueError(f"IP 范围结束地址无效：{end_str}")

        if start_ip > end_ip:
            start_ip, end_ip = end_ip, start_ip

        ips = [str(ipaddress.ip_address(i)) for i in range(int(start_ip), int(end_ip) + 1)]
        if len(ips) > max_count:
            raise ValueError(
                f"IP 范围过大：{ip_expr} 包含 {len(ips)} 个地址，"
                f"超过单行上限 {max_count}，请缩小范围"
            )
        return ips

    # 单个 IP（不做严格校验，允许主机名等作为 identifier 的回退）
    return [ip_expr]


def _decode_import_text(raw: bytes) -> str:
    """解码导入文本字节，兼容 UTF-8(SIG) 与 GBK/GB18030。

    中文环境下的 Excel 常将 CSV 保存为 GBK/GB18030（ANSI）编码；若仅按
    UTF-8 解码会导致中文表头/值乱码（如「使用单位」变乱码），进而无法匹配
    模板 label，使用单位落入 extra_fields 而非标准 department 列。
    故先尝试严格 UTF-8，失败则回退到 GB18030（GBK 超集）。
    """
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _parse_import_file(filename: str, raw: bytes) -> list[dict]:
    """解析导入文件为行字典列表（首行作表头）。

    支持 .csv / .xlsx / .xls。返回 ``[{列名: 值}, ...]``。
    """
    if filename.endswith(".csv"):
        text = _decode_import_text(raw)
        reader = csv.DictReader(io.StringIO(text))
        return [dict(r) for r in reader]
    elif filename.endswith(".xlsx"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        try:
            headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
        except StopIteration:
            return []
        result = []
        for row in rows_iter:
            result.append({
                headers[i]: (row[i] if i < len(row) and row[i] is not None else "")
                for i in range(len(headers)) if headers[i]
            })
        return result
    elif filename.endswith(".xls"):
        import xlrd
        book = xlrd.open_workbook(file_contents=raw)
        sheet = book.sheet_by_index(0)
        if sheet.nrows == 0:
            return []
        headers = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
        result = []
        for r in range(1, sheet.nrows):
            result.append({
                headers[c]: sheet.cell_value(r, c) if c < sheet.ncols else ""
                for c in range(len(headers)) if headers[c]
            })
        return result
    else:
        raise ValueError(f"不支持的文件类型: {filename}（仅支持 .csv/.xlsx/.xls）")


@router.post("/import")
async def import_assets(
    file: UploadFile = File(..., description="CSV/XLSX/XLS 文件"),
    type_code: str = Query("", description="资产类型模板代码；传了则按模板字段映射导入"),
    conflict_strategy: str = Query("skip", description="冲突策略：skip跳过/overwrite覆盖/error报错中止"),
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "edit")),
) -> dict:
    """批量导入资产（CSV/Excel）。

    模板模式（传 ``type_code``）：
    - 列名按模板字段 label → key 映射，由 ``_apply_template_to_asset`` 分发到标准列/extra。
    - identifier 由模板 identifier_field 派生；标识字段为 ip 类型时支持多格式展开。
    - 标识字段为 cidr 类型时（如网段），identifier 直接取该列值，不展开。

    兼容模式（未传 ``type_code``）：
    - 列名匹配 _IMPORT_FIELD_MAP；自定义字段列名 → extra_fields。
    - identifier 留空时自动取 ip 值；identifier_type 固定为 ip。

    通用：
    - 缺标识的行跳过并记 error；以 ``#`` 开头的注释行自动跳过。
    - 标识冲突按 conflict_strategy 处理（模板模式下按 (type_code, identifier) 判重）。
    - 限制 100000 行，超限返回 413。
    - 返回 ``{total, inserted, updated, skipped, errors}``。
    """
    raw = await file.read()
    filename = (file.filename or "").lower()

    try:
        rows = _parse_import_file(filename, raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 过滤注释行（模板底部以 # 开头的说明行）和全空行
    def _is_comment_or_empty(row: dict) -> bool:
        first_val = next((v for v in row.values() if v is not None and str(v).strip()), "")
        if isinstance(first_val, str) and first_val.strip().startswith("#"):
            return True
        # 全空行
        if not any(str(v).strip() for v in row.values() if v is not None):
            return True
        return False

    rows = [r for r in rows if not _is_comment_or_empty(r)]

    if len(rows) > 100000:
        raise HTTPException(
            status_code=413,
            detail=f"行数过多（{len(rows)}），请分批导入（每次 ≤100000 行）",
        )

    ip = get_client_ip(request) if request else None
    strategy = conflict_strategy if conflict_strategy in ("skip", "overwrite", "error") else "skip"

    inserted = updated = skipped = 0
    errors: list[dict] = []

    # ===== 模板模式预处理 =====
    template = None
    label_to_key_tpl: dict[str, str] = {}
    id_field_key = ""
    id_field_type = ""
    if type_code:
        template = _get_template(db, type_code)
        if template is None:
            raise HTTPException(status_code=404, detail=f"模板不存在: {type_code}")
        # 构建 label → key 映射
        for f in (template.fields or []):
            label_to_key_tpl[f.get("label", "")] = f.get("key", "")
        id_field_key = template.identifier_field
        id_field_def = next((f for f in (template.fields or []) if f.get("key") == id_field_key), None)
        id_field_type = (id_field_def or {}).get("type", "text")

    # 兼容模式：自定义字段映射
    label_to_key_cf: dict[str, str] = {}
    if not type_code:
        custom_fields = db.query(AssetCustomField).all()
        label_to_key_cf = {f.field_label: f.field_key for f in custom_fields}

    for idx, row in enumerate(rows, start=2):  # start=2：第1行是表头，数据从第2行起
        # ===== 模板模式：按模板字段映射 =====
        if template is not None:
            # 把行数据（列名可能是 label）规整为 {field_key: value}
            raw_fields: dict = {}
            for col, val in row.items():
                if col is None or val is None:
                    continue
                col_str = str(col).strip()
                # 列名优先按 label 映射回 key，否则原样保留
                fkey = label_to_key_tpl.get(col_str, col_str)
                raw_fields[fkey] = val

            # 取标识字段值
            id_expr_raw = raw_fields.get(id_field_key, "")
            id_expr = str(id_expr_raw).strip() if id_expr_raw is not None else ""
            if not id_expr:
                errors.append({"row": idx, "msg": f"缺少标识字段 '{id_field_key}'"})
                skipped += 1
                continue

            # ip 类型标识：支持多格式展开为 IP 列表；cidr/text 等不展开
            if id_field_type == "ip":
                try:
                    id_list = _expand_ip_expression(id_expr)
                except ValueError as exc:
                    errors.append({"row": idx, "msg": str(exc)})
                    skipped += 1
                    continue
                if not id_list:
                    errors.append({"row": idx, "msg": f"无法解析 IP 表达式：{id_expr}"})
                    skipped += 1
                    continue
            else:
                id_list = [id_expr]

            # 方案 A：多 IP 逗号拼接存储为一条资产（不再展开为多条）
            # identifier 用第一个 IP（主 IP），ip 字段存全部 IP 的逗号分隔串
            if id_field_type == "ip" and len(id_list) > 1:
                identifier = id_list[0]
                ip_value = ",".join(id_list)
            else:
                identifier = id_list[0] if id_list else id_expr
                ip_value = id_list[0] if id_list else ""

            # 分发字段（标准/extra）；ip/cidr 类型字段在分发时做入库前校验
            try:
                std_fields, extra_fields, _, _ = _apply_template_to_asset(template, raw_fields)
            except ValueError as exc:
                errors.append({"row": idx, "msg": str(exc)})
                skipped += 1
                continue
            base_name = std_fields.get("name", "")

            # ip/identifier 列宽预检：超长报错跳过，禁止静默截断（截断会破坏
            # IP 表达式语义，历史案例：143.146.79.0/24 被截断成 143.146.79.0/2）
            try:
                _check_asset_field_len(
                    identifier, std_fields.get("ip", ip_value if id_field_type == "ip" else ""),
                )
            except ValueError as exc:
                errors.append({"row": idx, "msg": str(exc)})
                skipped += 1
                continue

            # 冲突检测：按 allow_aggregate 区分
            # 聚合模式下同标识+同部门才算冲突，允许不同使用单位共存
            dept = std_fields.get("department", "")
            existing = _check_identifier_conflict(
                db, type_code, identifier, dept, template=template,
            )
            if existing:
                if strategy == "skip":
                    skipped += 1
                    continue
                if strategy == "error":
                    errors.append({
                        "row": idx,
                        "msg": _conflict_detail(type_code, identifier, dept, template),
                    })
                    skipped += 1
                    continue
                # overwrite
                before = _asset_snapshot(existing)
                for col, val in std_fields.items():
                    if col in ("identifier", "identifier_type"):
                        continue
                    setattr(existing, col, _truncate_field(col, val))
                # ip 标识字段同步 ip 列（多 IP 逗号拼接）
                if id_field_type == "ip" and "ip" not in std_fields:
                    existing.ip = _truncate_field("ip", ip_value)
                if base_name:
                    existing.name = _truncate_field("name", base_name)
                if extra_fields:
                    cur = dict(existing.extra_fields or {})
                    cur.update(extra_fields)
                    existing.extra_fields = cur
                after = _asset_snapshot(existing)
                diff = _compute_diff(before, after)
                if diff:
                    _record_asset_change(
                        db, existing.id, 0, "import", diff,
                        _build_summary(diff), user.id, user.username, ip,
                        auto_commit=False,
                    )
                updated += 1
            else:
                rec = Asset(
                    agent_id=0,
                    type_code=type_code,
                    identifier=_truncate_field("identifier", identifier),
                    identifier_type="ip" if id_field_type == "ip" else ("cidr" if id_field_type == "cidr" else "custom"),
                    name=_truncate_field("name", base_name or std_fields.get("name", "")),
                    asset_type=_truncate_field("asset_type", std_fields.get("asset_type", "")),
                    department=_truncate_field("department", std_fields.get("department", "")),
                    owner=_truncate_field("owner", std_fields.get("owner", "")),
                    location=_truncate_field("location", std_fields.get("location", "")),
                    ip=_truncate_field("ip", std_fields.get("ip", ip_value if id_field_type == "ip" else "")),
                    criticality=_truncate_field("criticality", std_fields.get("criticality", "medium")),
                    status=_coerce_status(std_fields.get("status", "in_use")),
                    extra_fields=dict(extra_fields),
                    source="manual",
                )
                db.add(rec)
                # 批量模式：不逐行 flush，攒够 BATCH_SIZE 再提交
                inserted += 1
            continue  # 模板模式处理完，进入下一行

        # ===== 兼容模式：标准字段 + 自定义字段 =====
        ip_expr = (str(row.get("ip") or "").strip()) or (str(row.get("identifier") or "").strip())
        if not ip_expr:
            errors.append({"row": idx, "msg": "缺少 ip 和 identifier（至少填一项）"})
            skipped += 1
            continue

        try:
            ip_list = _expand_ip_expression(ip_expr)
        except ValueError as exc:
            errors.append({"row": idx, "msg": str(exc)})
            skipped += 1
            continue

        if not ip_list:
            errors.append({"row": idx, "msg": f"无法解析 IP 表达式：{ip_expr}"})
            skipped += 1
            continue

        # 方案 A：多 IP 逗号拼接存储为一条资产（不再展开为多条）
        # identifier 用第一个 IP（主 IP），ip 字段存全部 IP 的逗号分隔串
        identifier = ip_list[0]
        ip_value = ",".join(ip_list) if len(ip_list) > 1 else ip_list[0]

        # 入库前校验 + 列宽预检（防倒置范围/巨型网段等脏数据；超长不截断）
        try:
            _validate_ip_expression(ip_expr, "ip")
            _check_asset_field_len(identifier, ip_value)
        except ValueError as exc:
            errors.append({"row": idx, "msg": str(exc)})
            skipped += 1
            continue

        # 构造资产字段（标准字段 + extra_fields）
        fields: dict = {}
        extra: dict = {}
        for col, val in row.items():
            if val is None or col is None:
                continue
            val = str(val).strip()
            if not val:
                continue
            if col in _IMPORT_FIELD_MAP:
                fields[_IMPORT_FIELD_MAP[col]] = val
            elif col not in ("identifier", "identifier_type", "ip"):
                # 自定义字段：列名可能是 field_label（中文）或 field_key（英文）
                actual_key = label_to_key_cf.get(col, col)
                extra[actual_key] = val
        if extra:
            fields["extra_fields"] = extra

        asset_name = fields.get("name", "")

        # 冲突检测：identifier 唯一
        existing = db.query(Asset).filter(
            Asset.identifier == identifier
        ).first()
        if existing:
            if strategy == "skip":
                skipped += 1
                continue
            if strategy == "error":
                errors.append({"row": idx, "msg": f"identifier={identifier} 已存在"})
                skipped += 1
                continue
            # overwrite：更新已有记录
            before = _asset_snapshot(existing)
            existing.name = _truncate_field("name", asset_name)
            existing.asset_type = _truncate_field("asset_type", fields.get("asset_type", existing.asset_type))
            existing.department = _truncate_field("department", fields.get("department", existing.department))
            existing.owner = _truncate_field("owner", fields.get("owner", existing.owner))
            existing.location = _truncate_field("location", fields.get("location", existing.location))
            existing.ip = _truncate_field("ip", ip_value)
            existing.criticality = _truncate_field("criticality", fields.get("criticality", existing.criticality))
            if fields.get("extra_fields"):
                cur = dict(existing.extra_fields or {})
                cur.update(fields["extra_fields"])
                existing.extra_fields = cur
            after = _asset_snapshot(existing)
            diff = _compute_diff(before, after)
            if diff:
                _record_asset_change(
                    db, existing.id, 0, "import", diff,
                    _build_summary(diff), user.id, user.username, ip,
                    auto_commit=False,
                )
            updated += 1
        else:
            rec = Asset(
                agent_id=0,
                identifier=_truncate_field("identifier", identifier),
                identifier_type="ip",
                name=_truncate_field("name", asset_name),
                asset_type=_truncate_field("asset_type", fields.get("asset_type", "")),
                department=_truncate_field("department", fields.get("department", "")),
                owner=_truncate_field("owner", fields.get("owner", "")),
                location=_truncate_field("location", fields.get("location", "")),
                ip=_truncate_field("ip", ip_value),
                criticality=_truncate_field("criticality", fields.get("criticality", "medium")),
                extra_fields=fields.get("extra_fields", {}),
                source="manual",
            )
            db.add(rec)
            # 批量模式：不逐行 flush，攒够 BATCH_SIZE 再提交
            inserted += 1

        # ===== 批量提交：每 BATCH_SIZE 行 commit 一次，避免逐行 flush 超时 =====
        if (idx - 2) > 0 and (idx - 1) % _IMPORT_BATCH_SIZE == 0:
            db.commit()
            logger.info("导入批量提交: 已处理 %d 行", idx - 1)

    db.commit()
    logger.info(
        "资产导入完成: type_code=%s, strategy=%s, total=%d, inserted=%d, updated=%d, skipped=%d",
        type_code or "(none)", strategy, len(rows), inserted, updated, skipped,
    )
    return {
        "total": len(rows),
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
    }


# ============================================================================
# 资产自定义字段管理（全局共享，所有知识库可用）
# ============================================================================

class CustomFieldCreateRequest(BaseModel):
    """创建自定义字段请求体。"""

    field_key: str = Field(..., description="字段键名（英文，如 mac_address），唯一")
    field_label: str = Field(..., description="显示标签（中文，如 MAC 地址）")
    field_type: str = Field("text", description="字段类型：text/number/date/select")
    options: list[str] | None = Field(None, description="select 类型的选项列表")


@router.get("/custom-fields", dependencies=[Depends(require_any_permission(("asset_list", "view"), ("asset_templates", "view")))])
def list_custom_fields(db: Session = Depends(get_db)) -> list[dict]:
    """列出所有资产自定义字段（按 sort_order 排序）。"""
    from app.models.asset import AssetCustomField

    fields = db.query(AssetCustomField).order_by(
        AssetCustomField.sort_order.asc(),
        AssetCustomField.id.asc(),
    ).all()
    return [to_dict(f) for f in fields]


@router.post("/custom-fields", status_code=201)
def create_custom_field(
    body: CustomFieldCreateRequest,
    db: Session = Depends(get_db),
    _: object = Depends(require_any_permission(("asset_list", "edit"), ("asset_templates", "edit"))),
) -> dict:
    """创建资产自定义字段（需资产清单或类型模板的编辑权限）。

    自定义字段的值存储在 Asset.extra_fields JSON 中，所有知识库共用。
    field_key 不能与标准字段（identifier/name/ip 等）重复。
    """
    from app.models.asset import AssetCustomField

    key = body.field_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="字段键名不能为空")
    if key in _ASSET_STANDARD_FIELDS:
        raise HTTPException(
            status_code=422,
            detail=f"字段键名 '{key}' 与标准字段重复，请使用其他名称",
        )
    # 检查唯一性
    existing = db.query(AssetCustomField).filter(
        AssetCustomField.field_key == key
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"字段键名 '{key}' 已存在")

    # select 类型必须有选项
    if body.field_type == "select" and not body.options:
        raise HTTPException(status_code=422, detail="select 类型字段必须提供选项列表")

    field = AssetCustomField(
        field_key=key,
        field_label=body.field_label.strip(),
        field_type=body.field_type,
        options=body.options or [],
        sort_order=db.query(AssetCustomField).count(),  # 新字段排最后
    )
    db.add(field)
    db.commit()
    db.refresh(field)
    logger.info("创建资产自定义字段: key=%s, label=%s, type=%s", key, body.field_label, body.field_type)
    return to_dict(field)


@router.delete("/custom-fields/{field_id}")
def delete_custom_field(
    field_id: int,
    db: Session = Depends(get_db),
    _: object = Depends(require_any_permission(("asset_list", "edit"), ("asset_templates", "edit"))),
) -> dict:
    """删除资产自定义字段（需资产清单或类型模板的编辑权限）。

    注意：已录入资产 extra_fields 中该字段的值不会被清除（保留历史数据），
    但该字段不再出现在映射配置的下拉选项中。
    """
    from app.models.asset import AssetCustomField

    field = db.query(AssetCustomField).filter(AssetCustomField.id == field_id).first()
    if field is None:
        raise HTTPException(status_code=404, detail="自定义字段不存在")
    logger.info("删除资产自定义字段: id=%s, key=%s", field_id, field.field_key)
    db.delete(field)
    db.commit()
    return {"ok": True}


# ============================================================================
# 资产标签管理（全局共享，多对多分组）
# ============================================================================

class TagCreateRequest(BaseModel):
    """创建标签请求体。"""
    name: str = Field(..., description="标签名称（唯一）")
    color: str = Field("brand", description="标签颜色（tailwind 色名）")


@router.get("/tags", dependencies=[Depends(require_any_permission(("asset_list", "view"), ("asset_templates", "view")))])
def list_tags(
    db: Session = Depends(get_db),
) -> list[dict]:
    """列出所有资产标签（含使用计数）。

    注意：此端点必须定义在 ``GET /{asset_id}`` 之前，否则 "tags" 会被
    ``{asset_id}`` 路径参数匹配并返回 422。
    """
    from sqlalchemy import func

    tags = db.query(AssetTag).order_by(AssetTag.id.asc()).all()
    # 批量统计每个标签的资产数
    result = []
    for t in tags:
        q = db.query(func.count()).select_from(Asset).filter(Asset.tags.any(AssetTag.id == t.id))
        count = q.scalar() or 0
        result.append({"id": t.id, "name": t.name, "color": t.color, "asset_count": count})
    return result


@router.post("/tags", status_code=201)
def create_tag(
    body: TagCreateRequest,
    db: Session = Depends(get_db),
    _: object = Depends(require_any_permission(("asset_list", "edit"), ("asset_templates", "edit"))),
) -> dict:
    """创建资产标签（需资产清单或类型模板的编辑权限）。名称唯一。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="标签名称不能为空")
    existing = db.query(AssetTag).filter(AssetTag.name == name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"标签 '{name}' 已存在")
    tag = AssetTag(name=name, color=body.color.strip() or "brand")
    db.add(tag)
    db.commit()
    db.refresh(tag)
    logger.info("创建资产标签: id=%s, name=%s", tag.id, tag.name)
    return {"id": tag.id, "name": tag.name, "color": tag.color, "asset_count": 0}


@router.delete("/tags/{tag_id}")
def delete_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    _: object = Depends(require_any_permission(("asset_list", "edit"), ("asset_templates", "edit"))),
) -> dict:
    """删除资产标签（需资产清单或类型模板的编辑权限）。

    删除标签会自动解除所有资产的关联（关联表 ondelete=CASCADE），但不删除资产本身。
    """
    tag = db.query(AssetTag).filter(AssetTag.id == tag_id).first()
    if tag is None:
        raise HTTPException(status_code=404, detail="标签不存在")
    logger.info("删除资产标签: id=%s, name=%s", tag_id, tag.name)
    db.delete(tag)
    db.commit()
    return {"ok": True, "deleted": tag_id}


# ============================================================================
# 资产去重检测
# ============================================================================

@router.get("/duplicates", dependencies=[Depends(require_permission("asset_list", "view"))])
def detect_duplicates(
    type_code: str = Query("", description="按资产类型模板代码筛选；为空则检测全部"),
    db: Session = Depends(get_db),
) -> dict:
    """检测疑似重复资产。

    检测逻辑：
    - 非聚合模板（``allow_aggregate=False``）：按 ``(type_code, identifier)`` 分组，
      组内 >1 条即为疑似重复组。
    - 聚合模板（``allow_aggregate=True``）：按 ``(type_code, identifier, department)``
      分组，组内 >1 条才算重复（同标识不同使用单位是合法的，不视为重复）。

    可传 ``type_code`` 限定在某一类型范围内检测。

    此端点必须定义在 ``GET /{asset_id}`` 之前。
    """
    from sqlalchemy import func

    # 预取所有模板的 allow_aggregate 配置：{code: bool}
    tpl_agg_map: dict[str, bool] = {
        t.code: bool(t.allow_aggregate)
        for t in db.query(AssetTypeTemplate.code, AssetTypeTemplate.allow_aggregate).all()
    }

    base = db.query(Asset).filter(
        Asset.identifier != "", Asset.identifier.isnot(None)
    )
    if type_code:
        base = base.filter(Asset.type_code == type_code)

    # 拉取所有候选记录（按 type_code, identifier, department 排序，便于聚合分组）
    rows = base.order_by(Asset.type_code, Asset.identifier, Asset.department).all()

    # Python 侧分组：聚合模板按 (type_code, identifier, department)，非聚合按 (type_code, identifier)
    buckets: dict[tuple, list[Asset]] = {}
    for r in rows:
        tc = r.type_code or ""
        allow_agg = tpl_agg_map.get(tc, False)
        if allow_agg:
            key = (tc, r.identifier, (r.department or "").strip())
        else:
            key = (tc, r.identifier)
        buckets.setdefault(key, []).append(r)

    groups = []
    for key, recs in buckets.items():
        if len(recs) <= 1:
            continue
        tc = key[0]
        identifier = key[1]
        groups.append({
            "type_code": tc,
            "identifier": identifier,
            "ip": recs[0].ip if recs else "",
            "count": len(recs),
            "assets": to_dict_list_with_agent_name(recs, db),
        })
    return {
        "groups": groups,
        "total_groups": len(groups),
        "total_assets": sum(g["count"] for g in groups),
    }


# ============================================================================
# 批量操作
# ============================================================================

# 批量更新允许修改的字段白名单（身份/来源字段不纳入批量修改，避免误改）
_BATCH_UPDATABLE_FIELDS = {
    "criticality", "department", "owner", "asset_type", "location", "status",
}


class BatchUpdateRequest(BaseModel):
    """批量更新资产请求体。

    fields 中仅提供需要修改的字段（key 在 _BATCH_UPDATABLE_FIELDS 白名单内），
    未提供的字段保持不变。空字符串视为"不修改"（前端留空=跳过）。
    add_tags / remove_tags 用于批量打标/取消标签（标签 ID 列表）。
    """

    ids: list[int] = Field(..., description="要更新的资产 ID 列表")
    fields: dict = Field(..., description="待更新字段（criticality/department/owner/asset_type/location/status 子集）")
    add_tags: list[int] | None = Field(None, description="批量打标签（标签 ID 列表）")
    remove_tags: list[int] | None = Field(None, description="批量取消标签（标签 ID 列表）")


@router.patch("/batch")
def batch_update_assets(
    body: BatchUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "edit")),
) -> dict:
    """批量更新资产（需资产清单编辑权限）。

    对 body.ids 指定的资产批量设置 body.fields 中的字段。仅白名单字段生效，
    其余字段忽略。fields 中值为空字符串的字段跳过（不修改）。
    逐条记录 AssetChange(action='batch_update') 字段 diff。
    add_tags/remove_tags 批量打标/取消标签（标签 ID 列表）。
    """
    if not body.ids:
        raise HTTPException(status_code=422, detail="ids 不能为空")
    # 过滤出白名单内且非空的字段
    updates = {
        k: v for k, v in (body.fields or {}).items()
        if k in _BATCH_UPDATABLE_FIELDS and v not in (None, "")
    }
    add_tag_ids = body.add_tags or []
    remove_tag_ids = body.remove_tags or []
    if not updates and not add_tag_ids and not remove_tag_ids:
        raise HTTPException(
            status_code=422,
            detail="没有有效的更新字段或标签操作（仅支持 criticality/department/owner/asset_type/location/status + add_tags/remove_tags）",
        )
    ip = get_client_ip(request)
    # 预取标签对象（避免 N+1）
    tag_map: dict[int, AssetTag] = {}
    all_tag_ids = set(add_tag_ids) | set(remove_tag_ids)
    if all_tag_ids:
        for t in db.query(AssetTag).filter(AssetTag.id.in_(all_tag_ids)).all():
            tag_map[t.id] = t
    # 查出受影响资产，逐条更新并记 diff（不用 bulk update 以便记录每条变更）
    records = db.query(Asset).filter(Asset.id.in_(body.ids)).all()
    updated = 0
    for rec in records:
        before = _asset_snapshot(rec)
        for k, v in updates.items():
            setattr(rec, k, v)
        # 批量打标
        for tid in add_tag_ids:
            t = tag_map.get(tid)
            if t and t not in rec.tags:
                rec.tags.append(t)
        # 批量取消标签
        for tid in remove_tag_ids:
            t = tag_map.get(tid)
            if t and t in rec.tags:
                rec.tags.remove(t)
        after = _asset_snapshot(rec)
        diff = _compute_diff(before, after)
        tag_changes = []
        if add_tag_ids:
            tag_changes.append(f"打标签: {[tag_map[t].name for t in add_tag_ids if t in tag_map]}")
        if remove_tag_ids:
            tag_changes.append(f"取消标签: {[tag_map[t].name for t in remove_tag_ids if t in tag_map]}")
        if diff or tag_changes:
            summary_parts = [_build_summary(diff)] if diff else []
            summary_parts.extend(tag_changes)
            _record_asset_change(
                db, rec.id, rec.agent_id, "batch_update", diff,
                "; ".join(filter(None, summary_parts))[:250], user.id, user.username, ip,
            )
        updated += 1
    db.commit()
    logger.info("批量更新资产: ids=%s, fields=%s, add_tags=%s, remove_tags=%s, updated=%s",
                body.ids, updates, add_tag_ids, remove_tag_ids, updated)
    return {"ok": True, "updated": updated}


@router.get("/{asset_id}", dependencies=[Depends(require_permission("asset_list", "view"))])
def get_asset(asset_id: int, db: Session = Depends(get_db)) -> dict:
    """获取单个资产详情。"""
    record = db.query(Asset).filter(Asset.id == asset_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    d = to_dict(record)
    d["tags"] = _asset_tags_to_list(record)
    return d


@router.get("/{asset_id}/changes", dependencies=[Depends(require_permission("asset_list", "view"))])
def list_asset_changes(
    asset_id: int,
    limit: int = Query(100, ge=1, le=500, description="最多返回条数"),
    db: Session = Depends(get_db),
) -> list[dict]:
    """返回指定资产的变更历史（按时间倒序，用于详情抽屉时间线展示）。

    即使资产已被删除，历史记录仍保留（asset_id 不级联清理）。
    """
    rows = (
        db.query(AssetChange)
        .filter(AssetChange.asset_id == asset_id)
        .order_by(AssetChange.created_at.desc(), AssetChange.id.desc())
        .limit(limit)
        .all()
    )
    return [to_dict(r) for r in rows]


class MergeRequest(BaseModel):
    """资产合并请求体：把 source 资产合并到 target（保留 target，删除 source）。"""
    source_id: int = Field(..., description="被合并的资产 ID（将被删除）")
    # field_strategy: {字段名: "target" | "source"}，未指定的字段保留 target 值
    field_strategy: dict | None = Field(None, description="字段策略：{field: 'target'|'source'}，默认全保留 target")
    merge_extra_fields: bool = Field(True, description="是否把 source 的 extra_fields 合并到 target")


@router.post("/{asset_id}/merge")
def merge_asset(
    asset_id: int,
    body: MergeRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """合并资产（仅 admin）。把 source 合并到 target（asset_id），保留 target，删除 source。

    合并逻辑：
    - field_strategy 指定的字段从 source 取值覆盖 target（策略值 "source" 时）。
    - merge_extra_fields=True 时，source 的 extra_fields 合并到 target（source 优先）。
    - source 的标签合并到 target（去重）。
    - source 的变更历史迁移到 target（asset_id 改为 target）。
    - 最后删除 source 资产，记录 merge 变更历史。
    """
    target = db.query(Asset).filter(Asset.id == asset_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="目标资产不存在")
    source = db.query(Asset).filter(Asset.id == body.source_id).first()
    if source is None:
        raise HTTPException(status_code=404, detail="源资产不存在")
    if target.id == source.id:
        raise HTTPException(status_code=422, detail="不能合并到自身")

    before = _asset_snapshot(target)
    strategy = body.field_strategy or {}

    # 按策略覆盖字段
    _mergeable_fields = _TRACKABLE_FIELDS
    for field in _mergeable_fields:
        if strategy.get(field) == "source":
            setattr(target, field, getattr(source, field))

    # 合并 extra_fields
    if body.merge_extra_fields:
        cur = dict(target.extra_fields or {})
        cur.update(source.extra_fields or {})
        target.extra_fields = cur

    # 合并标签（去重）
    for t in source.tags:
        if t not in target.tags:
            target.tags.append(t)

    # 迁移变更历史
    db.query(AssetChange).filter(AssetChange.asset_id == source.id).update(
        {AssetChange.asset_id: target.id}
    )

    # 删除 source
    ip = get_client_ip(request)
    _record_asset_change(
        db, source.id, source.agent_id, "merge",
        {"merged_into": {"old": None, "new": target.id}},
        f"合并到资产 #{target.id}（已删除）", user.id, user.username, ip,
    )
    db.delete(source)

    # 记录 target 的合并变更
    after = _asset_snapshot(target)
    diff = _compute_diff(before, after, _TRACKABLE_FIELDS + ["extra_fields"])
    _record_asset_change(
        db, target.id, target.agent_id, "merge",
        diff,
        f"合并资产 #{body.source_id}（{diff and _build_summary(diff) or '无字段变更'}）",
        user.id, user.username, ip,
    )

    db.commit()
    db.refresh(target)
    logger.info("合并资产: source=%s → target=%s", body.source_id, target.id)
    d = to_dict(target)
    d["tags"] = _asset_tags_to_list(target)
    return {"ok": True, "merged_into": target.id, "deleted": body.source_id, "asset": d}


# ============================================================================
# 写操作端点
# ============================================================================


@router.post("", status_code=201)
def create_asset(
    body: AssetCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "edit")),
) -> dict:
    """手动新增资产（需资产清单编辑权限）。

    支持两种模式：
    1. 模板模式（``type_code`` + ``fields``）：按模板分发字段并派生标识。
    2. 兼容模式（直接传标准字段）：identifier 留空时自动取 ip 值，identifier_type 固定 ip。

    source 标记为 ``manual``。标识冲突返回 409。记录 AssetChange(action='create')。
    """
    ip_addr = get_client_ip(request)

    # ===== 模板模式 =====
    if body.type_code and body.fields is not None:
        template = _get_template(db, body.type_code)
        if template is None:
            raise HTTPException(status_code=404, detail=f"模板不存在: {body.type_code}")
        # ip/cidr 类型字段入库前校验（防倒置范围/巨型网段/残缺 IP）
        try:
            std_fields, extra_fields, identifier, identifier_type = _apply_template_to_asset(
                template, body.fields
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        if not identifier:
            raise HTTPException(
                status_code=422,
                detail=f"标识字段 '{template.identifier_field}' 不能为空",
            )
        # ip/identifier 列宽预检：超长报错，禁止截断（截断会破坏 IP 表达式语义）
        try:
            _check_asset_field_len(identifier, std_fields.get("ip", ""))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        # 查重：按 allow_aggregate 区分（聚合模式下同标识+同部门才算冲突）
        department = std_fields.get("department", "")
        existing = _check_identifier_conflict(
            db, body.type_code, identifier, department, template=template,
        )
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail=_conflict_detail(body.type_code, identifier, department, template)
                + f", id={existing.id}",
            )
        record = Asset(
            agent_id=0,
            type_code=body.type_code,
            identifier=identifier,
            identifier_type=identifier_type,
            name=std_fields.get("name", ""),
            asset_type=std_fields.get("asset_type", ""),
            department=std_fields.get("department", ""),
            owner=std_fields.get("owner", ""),
            location=std_fields.get("location", ""),
            ip=std_fields.get("ip", ""),
            criticality=std_fields.get("criticality", "medium"),
            status=_coerce_status(std_fields.get("status", "in_use")),
            kb_id=body.kb_id,
            kb_name=body.kb_name,
            source="manual",
            extra_fields=extra_fields,
        )
        db.add(record)
        db.flush()
        if body.tag_ids:
            tags = db.query(AssetTag).filter(AssetTag.id.in_(body.tag_ids)).all()
            record.tags = tags
        db.commit()
        db.refresh(record)
        _record_asset_change(
            db, record.id, 0, "create",
            {"identifier": {"old": None, "new": record.identifier}},
            f"手动新增: {record.identifier}", user.id, user.username, ip_addr,
        )
        logger.info("手动新增资产(模板): id=%s, type=%s, identifier=%s",
                    record.id, body.type_code, record.identifier)
        invalidate_asset_index()
        d = to_dict(record)
        d["tags"] = _asset_tags_to_list(record)
        return d

    # ===== 兼容模式 =====
    identifier = body.identifier.strip() or body.ip.strip()
    if not identifier:
        raise HTTPException(status_code=422, detail="IP 地址不能为空（作为资产唯一标识）")

    # 入库前校验 + 列宽预检（防倒置范围/巨型网段等脏数据；超长不截断）
    try:
        _validate_ip_expression(body.ip, "ip")
        _validate_ip_expression(body.identifier, "identifier")
        _check_asset_field_len(identifier, body.ip or identifier)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # 查重
    existing = db.query(Asset).filter(
        Asset.identifier == identifier,
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"资产已存在（identifier={identifier}, id={existing.id}）",
        )

    record = Asset(
        agent_id=0,
        type_code=body.type_code or None,
        identifier=identifier,
        identifier_type="ip",
        name=body.name,
        asset_type=body.asset_type,
        department=body.department,
        owner=body.owner,
        location=body.location,
        ip=body.ip or identifier,
        criticality=body.criticality,
        status=body.status if body.status in _ASSET_STATUS_VALUES else "in_use",
        kb_id=body.kb_id,
        kb_name=body.kb_name,
        source="manual",
        extra_fields=body.extra_fields or {},
    )
    db.add(record)
    db.flush()
    # 打标签（如有）
    if body.tag_ids:
        tags = db.query(AssetTag).filter(AssetTag.id.in_(body.tag_ids)).all()
        record.tags = tags
    db.commit()
    db.refresh(record)
    _record_asset_change(
        db, record.id, 0, "create",
        {"identifier": {"old": None, "new": record.identifier}},
        f"手动新增: {record.identifier}", user.id, user.username, ip_addr,
    )
    logger.info("手动新增资产: id=%s, identifier=%s", record.id, record.identifier)
    invalidate_asset_index()
    d = to_dict(record)
    d["tags"] = _asset_tags_to_list(record)
    return d


@router.put("/{asset_id}")
def update_asset(
    asset_id: int,
    body: AssetUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "edit")),
) -> dict:
    """更新资产（需资产清单编辑权限）。

    支持两种模式：
    1. 模板模式（``fields`` 非 None）：按模板分发仅更新传入的字段。
       若 ``type_code`` 也传入且与原值不同，则切换类型并重新派生标识。
    2. 兼容模式：直接传标准字段，仅更新非 None 字段；extra_fields 与已有值合并。

    记录 AssetChange(action='update') 字段级 diff。
    """
    record = db.query(Asset).filter(Asset.id == asset_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="资产不存在")

    ip_addr = get_client_ip(request)
    before = _asset_snapshot(record)

    # ===== 模板模式：按模板字段部分更新 =====
    if body.fields is not None:
        effective_type_code = body.type_code or record.type_code
        template = _get_template(db, effective_type_code or "")
        if template is None and effective_type_code:
            raise HTTPException(status_code=404, detail=f"模板不存在: {effective_type_code}")
        if template is not None:
            # ip/cidr 类型字段入库前校验（防倒置范围/巨型网段/残缺 IP）
            try:
                std_fields, extra_fields, new_identifier, new_id_type = _apply_template_to_asset(
                    template, body.fields
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc))
            # ip/identifier 列宽预检：超长报错，禁止截断
            try:
                _check_asset_field_len(
                    new_identifier or record.identifier,
                    std_fields.get("ip", record.ip or ""),
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc))
            # 切换类型
            if body.type_code and body.type_code != record.type_code:
                record.type_code = body.type_code
            # 更新标准列（仅 std_fields 中出现的列）
            for col, val in std_fields.items():
                if col in ("identifier", "identifier_type"):
                    continue
                setattr(record, col, val)
            # extra 合并
            if extra_fields:
                cur = dict(record.extra_fields or {})
                cur.update(extra_fields)
                record.extra_fields = cur
            # 标识变更查重：按 allow_aggregate 区分
            # 聚合模式下，部门变更也要查重（同标识+新部门可能已存在）
            effective_identifier = new_identifier or record.identifier
            effective_department = (
                std_fields["department"] if "department" in std_fields else record.department
            )
            id_changed = bool(new_identifier) and new_identifier != record.identifier
            dept_changed = "department" in std_fields and (
                std_fields["department"] or ""
            ) != (record.department or "")
            if id_changed or (template.allow_aggregate and dept_changed):
                conflict = _check_identifier_conflict(
                    db, record.type_code, effective_identifier, effective_department,
                    exclude_id=record.id, template=template,
                )
                if conflict:
                    raise HTTPException(
                        status_code=409,
                        detail=_conflict_detail(
                            record.type_code, effective_identifier, effective_department, template
                        ) + f"，与资产 #{conflict.id} 冲突",
                    )
                if id_changed:
                    record.identifier = new_identifier
                    record.identifier_type = new_id_type
        # 标签替换
        if body.tag_ids is not None:
            tags = db.query(AssetTag).filter(AssetTag.id.in_(body.tag_ids)).all()
            record.tags = tags
        # kb 相关
        if body.kb_id is not None:
            record.kb_id = body.kb_id
        if body.kb_name is not None:
            record.kb_name = body.kb_name

        after = _asset_snapshot(record)
        diff = _compute_diff(before, after, _TRACKABLE_FIELDS + ["extra_fields"])
        if diff:
            _record_asset_change(
                db, record.id, record.agent_id, "update", diff,
                _build_summary(diff), user.id, user.username, ip_addr,
            )
        db.commit()
        db.refresh(record)
        logger.info("更新资产(模板): id=%s", asset_id)
        invalidate_asset_index()
        d = to_dict(record)
        d["tags"] = _asset_tags_to_list(record)
        return d

    # ===== 兼容模式：直接更新标准字段 =====
    # 入库前校验 + 列宽预检（防倒置范围/巨型网段等脏数据；超长不截断）
    try:
        if body.identifier is not None:
            _validate_ip_expression(body.identifier, "identifier")
        if body.ip is not None:
            _validate_ip_expression(body.ip, "ip")
        _check_asset_field_len(
            body.identifier if body.identifier is not None else record.identifier,
            body.ip if body.ip is not None else record.ip,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # 标量字段
    for field in [
        "type_code", "identifier", "identifier_type", "name", "asset_type",
        "department", "owner", "location", "ip", "criticality", "status", "kb_name",
    ]:
        v = getattr(body, field, None)
        if v is not None:
            setattr(record, field, v)
    if body.kb_id is not None:
        record.kb_id = body.kb_id
    # extra_fields 合并
    if body.extra_fields is not None:
        cur = dict(record.extra_fields or {})
        cur.update(body.extra_fields)
        record.extra_fields = cur
    # 标签替换（tag_ids 非 None 时替换该资产的全部标签）
    if body.tag_ids is not None:
        tags = db.query(AssetTag).filter(AssetTag.id.in_(body.tag_ids)).all()
        record.tags = tags

    after = _asset_snapshot(record)
    # diff 含 _TRACKABLE_FIELDS + extra_fields
    diff = _compute_diff(before, after, _TRACKABLE_FIELDS + ["extra_fields"])
    if diff:
        _record_asset_change(
            db, record.id, record.agent_id, "update", diff,
            _build_summary(diff), user.id, user.username, ip_addr,
        )

    db.commit()
    db.refresh(record)
    logger.info("更新资产: id=%s", asset_id)
    invalidate_asset_index()
    d = to_dict(record)
    d["tags"] = _asset_tags_to_list(record)
    return d


@router.delete("/{asset_id}")
def delete_asset(
    asset_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "delete")),
) -> dict:
    """删除资产（需资产清单删除权限）。记录 AssetChange(action='delete')。"""
    record = db.query(Asset).filter(Asset.id == asset_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    identifier = record.identifier
    agent_id = record.agent_id
    # 删除前记一条变更（asset_id 保留，便于追溯已删除资产的历史）
    _record_asset_change(
        db, record.id, agent_id, "delete",
        {"identifier": {"old": identifier, "new": None}},
        f"删除资产: {identifier}", user.id, user.username, get_client_ip(request),
    )
    db.delete(record)
    db.commit()
    logger.info("删除资产: id=%s, identifier=%s", asset_id, identifier)
    invalidate_asset_index()
    return {"ok": True, "deleted": asset_id}


class BatchDeleteRequest(BaseModel):
    """批量删除资产请求体（用 body 传 ID，避免全选所有匹配时 URL 超长）。"""

    ids: list[int] = Field(..., description="要删除的资产 ID 列表")


@router.delete("")
def batch_delete_assets(
    body: BatchDeleteRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_list", "delete")),
) -> dict:
    """批量删除资产（需资产清单删除权限）。逐条记 AssetChange(action='delete')。"""
    ids = body.ids
    if not ids:
        return {"ok": True, "deleted": 0}
    ip = get_client_ip(request) if request else None
    records = db.query(Asset).filter(Asset.id.in_(ids)).all()
    for rec in records:
        _record_asset_change(
            db, rec.id, rec.agent_id, "delete",
            {"identifier": {"old": rec.identifier, "new": None}},
            f"批量删除: {rec.identifier}", user.id, user.username, ip,
        )
        db.delete(rec)
    db.commit()
    deleted = len(records)
    logger.info("批量删除资产: ids=%s, deleted=%d", ids, deleted)
    invalidate_asset_index()
    return {"ok": True, "deleted": deleted}

