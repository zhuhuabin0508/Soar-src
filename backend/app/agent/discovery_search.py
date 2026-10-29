import asyncio
import ipaddress
import logging
import re

from sqlalchemy import or_, text
from sqlalchemy.exc import SQLAlchemyError

from app.api.v1.govcloud import RESOURCE_TYPES
from app.core.govcloud_schema import EXTRA_IP_KEYS, EXTRA_NAME_KEYS, FIELD_LABELS
from app.models.govcloud_asset import RESOURCE_MODELS

logger = logging.getLogger(__name__)

_MAX_LIMIT = 20
_DEFAULT_LIMIT = 10
_MAX_TOKENS = 30
_STATEMENT_TIMEOUT_MS = 8000
_TOKEN_SPLIT = re.compile(r"[,;，；、\s]+")
_CMDB_ID = re.compile(r"^[0-9a-fA-F]{16,40}$")
_TRGM_READY = None

_IP_COLUMNS = {
    "cloud_host": ("ip_address", "floatip_address"),
    "bare_metal": ("ip_address", "floatip_address"),
    "e_government_network": ("ip_address",),
    "elastic_ip": ("ip_address", "floatip_address"),
    # 青藤主机（API 同步）：IP 分布在多个专用列，JSONB 兜底列叫 extra（非 extra_excel）
    "qingteng_host": ("display_ip", "connection_ip", "external_ip", "internal_ip", "proxy_ip"),
}
_CIDR_COLUMNS = {
    "e_government_network": ("cidr",),
}
_ID_COLUMNS = ("source_id", "cmdb_id", "instance_id", "agent_id")
_TEXT_COLUMNS = {
    "cloud_host": ("instance_name", "inst_name", "user_department", "applicant_department"),
    "bare_metal": ("instance_name", "inst_name", "user_department", "applicant_department"),
    "e_government_network": ("instance_name", "inst_name", "name", "user_department", "applicant_department"),
    "elastic_ip": ("instance_name", "inst_name", "user_department", "applicant_department"),
    "qingteng_host": ("hostname", "biz_group", "charge_name", "remark", "qingteng_device_name", "host_location"),
}

# 内部簿记字段：不透出给 Agent（原始 JSON 列 extra/extra_excel 在 _merge_type_fields 展开）
_INTERNAL_KEYS = {
    "id",
    "batch_id",
    "created_at",
    "updated_at",
    "extra",
    "extra_excel",
    "resource_type",
}
# 输出字段白名单已废弃：改为全字段透出（_merge_type_fields），
# 不同资源类型按各自 Excel 模板列 + extra 扩展字段返回


def split_keywords(keyword: str) -> list[str]:
    return [part for part in _TOKEN_SPLIT.split((keyword or "").strip()) if part][:_MAX_TOKENS]


def classify_keyword(token: str) -> str:
    text_value = (token or "").strip()
    if not text_value:
        return "empty"
    try:
        ipaddress.IPv4Address(text_value)
        return "ip"
    except ipaddress.AddressValueError:
        pass
    if "/" in text_value:
        try:
            ipaddress.IPv4Network(text_value, strict=False)
            return "cidr"
        except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
            pass
    if _CMDB_ID.match(text_value):
        return "id"
    return "text"


def clamp_limit(limit: int) -> int:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        value = _DEFAULT_LIMIT
    return min(max(value, 1), _MAX_LIMIT)


def resolve_resource_types(resource_type: str) -> tuple[list[str], dict | None]:
    code = (resource_type or "").strip()
    if not code:
        return list(RESOURCE_TYPES.keys()), None
    if code not in RESOURCE_TYPES:
        return [], {
            "error": "未知资源类型，可选 cloud_host / bare_metal / e_government_network / elastic_ip / qingteng_host",
            "count": 0,
            "assets": [],
        }
    return [code], None


def _trgm_ready(db) -> bool:
    global _TRGM_READY
    if _TRGM_READY is not None:
        return _TRGM_READY
    try:
        row = db.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).first()
        _TRGM_READY = row is not None
    except SQLAlchemyError:
        _TRGM_READY = False
    return _TRGM_READY


def _columns(model, names):
    found = []
    for name in names:
        column = getattr(model, name, None)
        if column is not None:
            found.append(column)
    return found


def _extra_text(model, key: str):
    # Excel 表的 JSONB 列是 extra_excel；青藤主机表是 extra（键体系也不同，
    # 查询不存在的键返回 NULL 不命中，无害——这里只为兼容两种列名不抛 AttributeError）
    extra_col = getattr(model, "extra_excel", None) or getattr(model, "extra", None)
    return extra_col[key].astext


def _fill_display_fields(data: dict, extra: dict) -> None:
    if not data.get("ip_address"):
        for key in EXTRA_IP_KEYS:
            value = extra.get(key)
            if value:
                data["ip_address"] = value
                break
    if not data.get("instance_name"):
        for key in EXTRA_NAME_KEYS:
            value = extra.get(key)
            if value:
                data["instance_name"] = value
                break


def _merge_type_fields(data: dict, mapping: dict, extra: dict) -> None:
    """全字段透出：不同资源类型字段集不同（云主机有 vcpu/内存/磁盘、网络资源有
    网关/VLAN/VPC、弹性IP有带宽/绑定实例、青藤主机有 CPU/内存/磁盘水位等），
    按记录实际拥有的字段返回，Agent 侧据实展示，不再用固定白名单裁剪。

    - 通用展示字段（ip_address / instance_name 等）由调用方在合并后统一归一，
      此处用 setdefault 避免覆盖。
    - 内部簿记字段（id / batch_id / 时间戳）与原始 JSON 列不透出。
    """
    for key, value in mapping.items():
        if key in _INTERNAL_KEYS:
            continue
        if value in (None, "", [], {}):
            continue
        data.setdefault(key, value)
    for key, value in (extra or {}).items():
        if key in _INTERNAL_KEYS:
            continue
        if value in (None, "", [], {}):
            continue
        data.setdefault(key, value)


def _compact(resource_type: str, mapping) -> dict:
    meta = RESOURCE_TYPES[resource_type]
    if resource_type == "qingteng_host":
        extra = mapping.get("extra") or {}
        if not isinstance(extra, dict):
            extra = {}
        data = {
            "source": "asset_discovery",
            "resource_type": "qingteng_host",
            "resource_label": meta.get("excel_name") or meta.get("label") or resource_type,
        }
        # 全字段透出：青藤主机专有字段（CPU/内存/磁盘水位、标签、位置、负责人等）
        _merge_type_fields(data, mapping, extra)
        # 对齐 Excel 资产的通用展示字段：LLM 与合并逻辑统一按 ip_address / instance_name 理解
        if not data.get("ip_address") and mapping.get("display_ip"):
            data["ip_address"] = mapping["display_ip"]
        if not data.get("instance_name") and mapping.get("hostname"):
            data["instance_name"] = mapping["hostname"]
        if isinstance(extra, dict):
            business_system = extra.get("system_name") or extra.get("business_system")
            if business_system:
                data["business_system"] = business_system
            if extra.get("applicant_name"):
                data["owner"] = extra["applicant_name"]
        if not data.get("department"):
            data["department"] = data.get("biz_group") or data.get("charge_name")
        if not data.get("owner") and data.get("charge_name"):
            data["owner"] = data["charge_name"]
        return data
    extra = mapping.get("extra_excel") or {}
    if not isinstance(extra, dict):
        extra = {}
    data = {
        "source": "asset_discovery",
        "resource_type": resource_type,
        "resource_label": meta.get("excel_name") or meta.get("label") or resource_type,
    }
    # 全字段透出：各资源类型专有字段（云主机 vcpu/内存/磁盘、网络资源 网关/VLAN/VPC、
    # 弹性IP 带宽/绑定实例 等）+ extra_excel 扩展字段（业务系统/环境/托管期限等）
    _merge_type_fields(data, mapping, extra)
    _fill_display_fields(data, extra)
    if "instance_name" not in data:
        fallback = data.get("inst_name") or data.get("name")
        if fallback:
            data["instance_name"] = fallback
    # 统一业务系统/责任人/部门字段，便于 Agent 直接按中文列名映射展示；
    # 数据缺失时保持不写入，由 Agent 展示为「—」，禁止跨来源补全。
    business_system = (
        extra.get("system_name") or extra.get("business_system") or extra.get("业务系统")
    )
    if business_system:
        data["business_system"] = business_system
    owner = extra.get("applicant_name") or extra.get("owner") or extra.get("负责人")
    if owner:
        data["owner"] = owner
    if not data.get("department"):
        data["department"] = data.get("user_department") or data.get("applicant_department")
    return data


def _query_table(db, resource_type: str, mode: str, token: str, limit: int) -> tuple[list[dict], bool]:
    model = RESOURCE_MODELS[resource_type]
    if mode == "ip":
        columns = _columns(model, _IP_COLUMNS.get(resource_type, ()))
        clauses = [column == token for column in columns]
        clauses.extend(_extra_text(model, key) == token for key in EXTRA_IP_KEYS)
    elif mode == "cidr":
        columns = _columns(model, _CIDR_COLUMNS.get(resource_type, ()))
        clauses = [column == token for column in columns]
    elif mode == "id":
        columns = _columns(model, _ID_COLUMNS)
        clauses = [column == token for column in columns]
    else:
        columns = _columns(model, _TEXT_COLUMNS.get(resource_type, ()))
        like = f"%{token}%"
        clauses = [column.ilike(like) for column in columns]
        clauses.extend(_extra_text(model, key).ilike(like) for key in EXTRA_NAME_KEYS)
    if not clauses:
        return [], False
    # 全字段返回：各资源类型字段集不同（云主机有 vcpu/内存/磁盘，网络资源有
    # 网关/VLAN/VPC，弹性IP有带宽/绑定实例，青藤主机有 CPU/内存/磁盘水位），
    # 按 Excel 模板列全量取回，由 _compact 按记录实际字段透出，
    # Agent 侧据实展示（不再用固定白名单裁剪）
    selected = list(model.__table__.columns)
    stmt = db.query(*selected).filter(or_(*clauses)).limit(limit)
    rows = stmt.all()
    names = [column.key for column in selected]
    assets = [_compact(resource_type, dict(zip(names, row))) for row in rows]
    return assets, len(assets) >= limit


def _search_token(db, token: str, resource_types: list[str], limit: int) -> dict:
    mode = classify_keyword(token)
    if mode == "text" and len(token) < 2:
        return {
            "query": token,
            "matched": False,
            "count": 0,
            "truncated": False,
            "assets": [],
            "error": "名称或部门关键词至少 2 个字符，精确查询请传 IP 或 CMDB ID",
        }
    if mode == "text" and not _trgm_ready(db):
        return {
            "query": token,
            "matched": False,
            "count": 0,
            "truncated": False,
            "assets": [],
            "error": "名称或部门模糊搜索需要 pg_trgm 索引，请改用精确 IP 或 CMDB ID",
        }
    assets = []
    truncated = False
    type_errors = []
    for resource_type in resource_types:
        try:
            found, hit_cap = _query_table(db, resource_type, mode, token, limit)
        except SQLAlchemyError:
            raise  # DB 级错误（超时等）按原有语义整体失败
        except Exception as exc:  # noqa: BLE001
            # 单个类型未适配/字段缺失：记录并跳过，不让其余类型的命中一起丢失
            logger.warning("资产发现类型 %s 查询失败（跳过）: %s", resource_type, exc)
            type_errors.append(f"{resource_type} 查询失败")
            continue
        assets.extend(found)
        truncated = truncated or hit_cap
    return {
        "query": token,
        "matched": bool(assets),
        "count": len(assets),
        "truncated": truncated,
        "assets": assets,
        **({"error": "；".join(type_errors)} if type_errors else {}),
    }


def _run_sync(keyword: str, resource_type: str, limit: int) -> dict:
    from app.database import SessionLocal

    resource_types, error = resolve_resource_types(resource_type)
    if error:
        return error
    tokens = split_keywords(keyword)
    if not tokens:
        return {"error": "请提供 IP、CMDB ID、实例名或部门", "count": 0, "assets": []}
    db = SessionLocal()
    try:
        try:
            db.execute(text(f"SET LOCAL statement_timeout = {_STATEMENT_TIMEOUT_MS}"))
        except SQLAlchemyError:
            db.rollback()
        results = [_search_token(db, token, resource_types, limit) for token in tokens]
    except SQLAlchemyError:
        db.rollback()
        return {"error": "资产发现查询超时或失败，请改用精确 IP 或缩小关键词", "count": 0, "assets": []}
    finally:
        db.close()
    if len(results) == 1:
        one = results[0]
        payload = {
            "source": "asset_discovery",
            "query": one["query"],
            "count": one["count"],
            "truncated": one["truncated"],
            "assets": one["assets"],
            # 字段中文名对照（英文键 → 中文列名），供 Agent 按类型实际字段展示
            "field_labels": FIELD_LABELS,
        }
        if one.get("error"):
            payload["error"] = one["error"]
        return payload
    return {
        "source": "asset_discovery",
        "batch": True,
        "count": sum(item["count"] for item in results),
        "truncated": any(item["truncated"] for item in results),
        "queries": results,
        # 字段中文名对照（英文键 → 中文列名），供 Agent 按类型实际字段展示
        "field_labels": FIELD_LABELS,
    }


async def execute_search_discovered_assets(
    keyword: str = "",
    resource_type: str = "",
    limit: int = _DEFAULT_LIMIT,
) -> dict:
    text_keyword = (keyword or "").strip()
    if not text_keyword:
        return {"error": "请提供 IP、CMDB ID、实例名或部门", "count": 0, "assets": []}
    bounded = clamp_limit(limit)
    return await asyncio.to_thread(_run_sync, text_keyword, resource_type or "", bounded)
