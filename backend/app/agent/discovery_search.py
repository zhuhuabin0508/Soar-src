import asyncio
import ipaddress
import logging
import re

from sqlalchemy import or_, text
from sqlalchemy.exc import SQLAlchemyError

from app.api.v1.govcloud import RESOURCE_TYPES
from app.core.govcloud_schema import EXTRA_IP_KEYS, EXTRA_NAME_KEYS
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
_KEEP = (
    "id",
    "source_id",
    "cmdb_id",
    "instance_id",
    "instance_name",
    "inst_name",
    "name",
    "ip_address",
    "floatip_address",
    "cidr",
    "user_department",
    "applicant_department",
    "host_status",
    "operating_system",
    "biz_region_name",
    "bandwidth",
    "bind_instance",
)
# 青藤主机输出保留字段（与 Excel 表字段体系不同，display_ip/hostname 会对齐到通用展示字段）
_QT_KEEP = (
    "id",
    "source_id",
    "agent_id",
    "hostname",
    "display_ip",
    "connection_ip",
    "external_ip",
    "internal_ip",
    "os_type",
    "platform",
    "agent_status_label",
    "biz_group",
    "charge_name",
    "serial_number",
    "last_online_time",
    "qingteng_device_id",
    "qingteng_device_name",
)


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


def _compact(resource_type: str, mapping) -> dict:
    meta = RESOURCE_TYPES[resource_type]
    if resource_type == "qingteng_host":
        data = {
            "source": "asset_discovery",
            "resource_type": "qingteng_host",
            "resource_label": meta.get("excel_name") or meta.get("label") or resource_type,
        }
        for key in _QT_KEEP:
            value = mapping.get(key)
            if value not in (None, ""):
                data[key] = value
        # 对齐 Excel 资产的通用展示字段：LLM 与合并逻辑统一按 ip_address / instance_name 理解
        if not data.get("ip_address") and mapping.get("display_ip"):
            data["ip_address"] = mapping["display_ip"]
        if not data.get("instance_name") and mapping.get("hostname"):
            data["instance_name"] = mapping["hostname"]
        return data
    extra = mapping.get("extra_excel") or {}
    if not isinstance(extra, dict):
        extra = {}
    data = {
        "source": "asset_discovery",
        "resource_type": resource_type,
        "resource_label": meta.get("excel_name") or meta.get("label") or resource_type,
    }
    for key in _KEEP:
        value = mapping.get(key)
        if value not in (None, ""):
            data[key] = value
    _fill_display_fields(data, extra)
    if "instance_name" not in data:
        fallback = data.get("inst_name") or data.get("name")
        if fallback:
            data["instance_name"] = fallback
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
    if resource_type == "qingteng_host":
        selected = _columns(model, (*_QT_KEEP, "extra"))
    else:
        selected = _columns(model, (*_KEEP, "extra_excel"))
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
