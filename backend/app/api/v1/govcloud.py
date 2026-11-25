"""政务云资产 API：按资源类型分表，Excel「原始数据」列一比一入库。

不导入 Sheet「数据统计」及统计类表头；分布统计由库内字段自行聚合（前端暂不展示）。
"""
from __future__ import annotations

import csv
import io
import json
import logging
import time
from datetime import datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.govcloud_schema import (
    HEADER_ALIAS,
    EXTRA_IP_KEYS,
    EXTRA_NAME_KEYS,
    FIELD_LABELS,
    RESERVED_COLUMNS,
    RESOURCE_EXCEL_FIELDS,
    SOURCE_ID_KEYS,
    excel_attr,
    norm_header_key,
    skip_excel_header,
)
from app.core.qingteng_asset_sync import get_qingteng_devices, sync_device_hosts
from app.core.qingteng_component_search import search_components
from app.core.qingteng_cve import query_cve_hosts
from app.core.qingteng_realtime import REALTIME_MODULES, realtime_query
from app.core.jiaotu_asset_sync import get_jiaotu_devices
from app.core.tianqing_asset_sync import get_tianqing_devices, sync_device_endpoints
from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import require_permission
from app.models.device import Device
from app.models.govcloud_asset import GovCloudImportBatch, RESOURCE_MODELS
from app.models.qingteng_host import (
    QingtengHostAsset,
    QINGTENG_FIELD_LABELS,
    QINGTENG_HOST_FIELDS,
    QINGTENG_LIST_FIELDS,
)
from app.models.qingteng_component import (
    COMPONENT_SOURCES,
    QingtengComponentAsset,
    QINGTENG_COMPONENT_FIELD_LABELS,
    QINGTENG_COMPONENT_FIELDS,
    QINGTENG_COMPONENT_LIST_FIELDS,
)
from app.models.qingteng_asset_item import (
    ASSET_MODULE_LABELS,
    ASSET_MODULES,
    QingtengAssetItem,
    QINGTENG_ASSET_FIELD_LABELS,
    QINGTENG_ASSET_FIELDS,
    QINGTENG_ASSET_LIST_FIELDS,
)
from app.models.jiaotu_asset_item import (
    JIAOTU_ASSET_FIELD_LABELS,
    JIAOTU_ASSET_FIELDS,
    JIAOTU_ASSET_LIST_FIELDS,
    JIAOTU_MODULE_LABELS,
    JIAOTU_MODULES,
    JiaotuAssetItem,
)
from app.models.jiaotu_host import (
    JIAOTU_HOST_FIELD_LABELS,
    JIAOTU_HOST_FIELDS,
    JIAOTU_HOST_LIST_FIELDS,
    JiaotuHostAsset,
)
from app.models.tianqing_endpoint import (
    TIANQING_ENDPOINT_FIELDS,
    TIANQING_FIELD_LABELS,
    TIANQING_LIST_FIELDS,
)
from app.models.tianqing_software import (
    TIANQING_SOFTWARE_FIELD_LABELS,
    TIANQING_SOFTWARE_FIELDS,
    TIANQING_SOFTWARE_LIST_FIELDS,
    TianqingSoftwareAsset,
)
from app.models.user import User
from app.tasks.qingteng_component_tasks import (
    sync_qingteng_components,
    sync_qingteng_modules,
)
from app.tasks.jiaotu_asset_tasks import sync_jiaotu_assets
from app.tasks.tianqing_software_tasks import sync_tianqing_software

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/govcloud", tags=["govcloud"])

RESOURCE_TYPES = {
    "cloud_host": {
        "label": "云主机",
        "excel_name": "云主机资产",
        "source_group": "itsm_ops",
        "filename_hints": ("云主机", "cloud_host"),
        "search_fields": (
            "instance_name", "inst_name", "ip_address", "floatip_address",
            "user_department", "applicant_department", "source_id",
        ),
    },
    "bare_metal": {
        "label": "裸金属",
        "excel_name": "裸金属资产",
        "source_group": "itsm_ops",
        "filename_hints": ("裸金属", "bare_metal"),
        "search_fields": (
            "instance_name", "inst_name", "ip_address", "floatip_address",
            "user_department", "applicant_department", "source_id",
        ),
    },
    "e_government_network": {
        "label": "网络资源",
        "excel_name": "网络资源资产",
        "source_group": "itsm_ops",
        "filename_hints": ("网络资源", "e_government_network", "network"),
        "search_fields": (
            "instance_name", "inst_name", "name", "ip_address",
            "user_department", "applicant_department", "source_id",
        ),
    },
    "elastic_ip": {
        "label": "弹性IP",
        "excel_name": "弹性IP资产",
        "source_group": "itsm_ops",
        "filename_hints": ("弹性IP", "弹性ip", "elastic_ip"),
        "search_fields": (
            "instance_name", "inst_name", "ip_address", "floatip_address",
            "user_department", "applicant_department", "source_id",
        ),
    },
    # 椒图云锁：凭据来自设备管理（auth_type=jiaotu），API 拉取主机与资产明细。
    # resource_type 实际取值带设备维度："jiaotu_host:<设备ID>" / "jiaotu_asset:<设备ID>"
    "jiaotu_host": {
        "label": "椒图主机",
        "excel_name": "椒图云锁主机资产",
        "source_group": "jiaotu_host",
        "filename_hints": (),
        "search_fields": (
            "machine_name", "intranet_ip", "extranet_ip", "machine_uuid",
            "os_name", "cpu", "jiaotu_device_name",
        ),
        "api_sync": True,
    },
    "jiaotu_asset": {
        "label": "椒图资产明细",
        "excel_name": "椒图云锁资产明细",
        "source_group": "jiaotu_asset",
        "filename_hints": (),
        "search_fields": (
            "name", "name_norm", "version", "machine_name", "intranet_ip",
            "protocol", "path", "module", "jiaotu_device_name",
        ),
        "api_sync": True,
    },
    # 奇安信天擎终端：凭据来自设备管理（auth_type=tianqing），ODP API 拉取入库。
    # resource_type 实际取值带设备维度："tianqing_endpoint:<设备ID>"（每台天擎一张数据表卡片）。
    "tianqing_endpoint": {
        "label": "天擎终端",
        "excel_name": "天擎终端资产",
        "source_group": "tianqing_endpoint",
        "filename_hints": (),
        "search_fields": (
            "computer_name", "ip", "report_ip", "mac", "client_id",
            "login_account", "group_name", "tianqing_device_name",
        ),
        "api_sync": True,
    },
    # 天擎组件（终端已安装软件）：同样按设备维度生成 "tianqing_software:<设备ID>"
    "tianqing_software": {
        "label": "天擎组件",
        "excel_name": "天擎组件资产",
        "source_group": "tianqing_software",
        "filename_hints": (),
        "search_fields": (
            "soft_name", "name_norm", "version", "soft_id", "corp",
            "computer_name", "ip", "client_id", "install_source",
            "group_name", "tianqing_device_name",
        ),
        "api_sync": True,
    },
    # 青藤主机：凭据来自设备管理（auth_type=qingteng），API 拉取入库而非 Excel 导入。
    # resource_type 实际取值带设备维度："qingteng_host:<设备ID>"（每台青藤一张数据表卡片）。
    "qingteng_host": {
        "label": "青藤主机",
        "excel_name": "青藤主机资产",
        "source_group": "qingteng_host",
        "filename_hints": (),
        "search_fields": (
            "hostname", "display_ip", "connection_ip", "external_ip",
            "agent_id", "biz_group", "serial_number", "charge_name", "remark",
        ),
    },
    # 青藤组件：同样按设备维度生成 "qingteng_component:<设备ID>" 数据表卡片
    "qingteng_component": {
        "label": "青藤组件",
        "excel_name": "青藤组件资产",
        "source_group": "qingteng_component",
        "filename_hints": (),
        "search_fields": (
            "name", "name_norm", "version", "display_ip", "hostname",
            "agent_id", "path", "component_type", "qingteng_device_name",
        ),
    },
    # 青藤资产明细：账号 / 用户组 / Web 应用 / Web 站点，按模块 tab 展示
    "qingteng_asset": {
        "label": "青藤资产明细",
        "excel_name": "青藤资产明细",
        "source_group": "qingteng_asset",
        "filename_hints": (),
        "search_fields": (
            "name", "name_norm", "version", "display_ip", "hostname",
            "agent_id", "path", "status", "module", "qingteng_device_name",
        ),
    },
}

# 青藤主机模型注册（数据表卡片由设备列表动态派生，见 meta/summary）
RESOURCE_MODELS["qingteng_host"] = QingtengHostAsset
RESOURCE_MODELS["qingteng_component"] = QingtengComponentAsset
RESOURCE_MODELS["qingteng_asset"] = QingtengAssetItem
RESOURCE_MODELS["tianqing_software"] = TianqingSoftwareAsset
RESOURCE_MODELS["jiaotu_host"] = JiaotuHostAsset
RESOURCE_MODELS["jiaotu_asset"] = JiaotuAssetItem

# 支持 "<类型>:<设备ID>" 后缀的资产类型（青藤 + 天擎 + 椒图）
QINGTENG_DEVICE_TYPES = ("qingteng_host", "qingteng_component", "qingteng_asset")
JIAOTU_DEVICE_TYPES = ("jiaotu_host", "jiaotu_asset")
DEVICE_DIMENSION_TYPES = (
    *QINGTENG_DEVICE_TYPES,
    *JIAOTU_DEVICE_TYPES,
    "tianqing_endpoint",
    "tianqing_software",
)

SOURCE_GROUPS = {
    "itsm_ops": {
        "label": "综合运管平台资产发现",
        "index": "",
        "enabled": True,
        "sort_order": 1,
        "description": "综合运管平台每周全量爬取，对应云主机 / 裸金属 / 网络资源 / 弹性IP 四张 Excel",
    },
    "intranet_mapping": {
        "label": "内网资产测绘",
        "index": "1.1",
        "enabled": False,
        "sort_order": 2,
        "description": "内网资产测绘结果，后续接入",
    },
    "qingteng_host": {
        "label": "青藤主机资产发现",
        "index": "1.2",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 3,
        "description": "登录设备管理中配置的青藤平台（支持多台），API 拉取 linux / win 主机清单入库",
    },
    "qingteng_component": {
        "label": "青藤组件资产发现",
        "index": "1.2.1",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 3,
        "description": "按青藤设备同步安装包 / 软件应用 / 数据库 / Jar 包 / Web 框架清单，支撑 CVE 版本匹配",
    },
    "qingteng_asset": {
        "label": "青藤资产明细",
        "index": "1.2.2",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 3,
        "description": "按模块同步系统账号 / 用户组 / Web 应用 / Web 站点等资产明细，支持按模块 tab 浏览",
    },
    "jiaotu_host": {
        "label": "椒图云锁主机资产发现",
        "index": "1.3",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 4,
        "description": "登录设备管理中配置的椒图云锁平台（支持多台），API 拉取服务器清单与硬件概况",
    },
    "jiaotu_asset": {
        "label": "椒图云锁资产明细",
        "index": "1.3.1",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 5,
        "description": "按主机同步安装包 / 端口 / 进程 / 数据库 / Web 服务 / Web 框架 / 账号等资产明细",
    },
    "tianqing_endpoint": {
        "label": "天擎终端资产发现",
        "index": "1.4",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 6,
        "description": "登录设备管理中配置的奇安信天擎平台（ODP），API 拉取终端基础信息、在线状态与版本",
    },
    "tianqing_software": {
        "label": "天擎组件资产发现",
        "index": "1.4.1",
        "enabled": False,  # 实际启用状态按设备列表动态派生（meta/summary 内覆盖）
        "sort_order": 7,
        "description": "按天擎终端逐台拉取已安装软件清单（名称 / 版本 / 厂商 / 安装时间），支撑 CVE 版本匹配",
    },
}

MAX_ROWS = 250000
MAX_FILE_SIZE = 200 * 1024 * 1024
UPSERT_CHUNK = 500
# 导出流式分块行数：每块一次查询，避免一次性加载全表
EXPORT_CHUNK = 2000
# 导出尾部追加的业务列（与列表页展示口径一致，便于追溯入库/同步时间）
EXPORT_TAIL_COLUMNS = ("source_id", "created_at", "updated_at")
# 青藤导出尾部业务列（额外带来源青藤平台名，多平台数据可追溯）
QT_EXPORT_TAIL_COLUMNS = ("source_id", "qingteng_device_name", "created_at", "updated_at")
# 天擎导出尾部业务列
TQ_EXPORT_TAIL_COLUMNS = ("source_id", "tianqing_device_name", "created_at", "updated_at")
# 椒图导出尾部业务列
JT_EXPORT_TAIL_COLUMNS = ("source_id", "jiaotu_device_name", "created_at", "updated_at")


def _keyword_clauses(model, meta: dict, kw: str) -> list:
    """构造 keyword 模糊搜索条件（列表与导出共用同一口径）。"""
    like = f"%{kw}%"
    clauses = [model.source_id.ilike(like)]
    if hasattr(model, "cmdb_id"):
        clauses.append(model.cmdb_id.ilike(like))
    for field in meta.get("search_fields") or []:
        if field in ("source_id", "_id"):
            continue
        col = getattr(model, excel_attr(field), None)
        if col is not None:
            clauses.append(col.ilike(like))
    extra = getattr(model, "extra_excel", None)
    if extra is not None:
        for key in (*EXTRA_IP_KEYS, *EXTRA_NAME_KEYS):
            clauses.append(extra[key].astext.ilike(like))
    return clauses


def _csv_val(val) -> str:
    """导出单元格序列化：None→空串，datetime→YYYY-mm-dd HH:MM:SS。"""
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d %H:%M:%S")
    return str(val)


def _row_cells(
    row,
    fields: list[str],
    extra_keys: list[str],
    extra_col: str = "extra_excel",
    tail: tuple = EXPORT_TAIL_COLUMNS,
) -> list[str]:
    """导出行序列化：字段列 + extra 追加列 + 业务尾部列（source_id/时间等）。"""
    cells = [_csv_val(getattr(row, excel_attr(f), "")) for f in fields]
    extra = getattr(row, extra_col, None)
    extra = extra if isinstance(extra, dict) else {}
    cells.extend(_csv_val(extra.get(k)) for k in extra_keys)
    cells.extend(_csv_val(getattr(row, k, "")) for k in tail)
    return cells


def _resolve_type(resource_type: str) -> tuple[str, dict, int | None]:
    """解析资源类型：支持青藤的设备维度 ``qingteng_host:<设备ID>`` /
    ``qingteng_component:<设备ID>``。

    返回 (基础类型, 类型元数据, 设备 ID)。青藤之外的多余后缀视为非法。
    """
    base, _, dev = (resource_type or "").partition(":")
    meta = RESOURCE_TYPES.get(base)
    if not meta:
        raise HTTPException(status_code=400, detail="不支持的资源类型")
    if ":" in (resource_type or ""):
        if base not in DEVICE_DIMENSION_TYPES:
            raise HTTPException(status_code=400, detail="该资源类型不支持设备维度参数")
        if not dev or not dev.isdigit():
            raise HTTPException(
                status_code=400,
                detail=f"该资源类型格式应为 {base}:<设备ID>",
            )
        return base, meta, int(dev)
    return base, meta, None


def _require_type(resource_type: str) -> dict:
    """按基础类型校验（兼容旧调用；带设备后缀时取基础类型元数据）。"""
    base, meta, _ = _resolve_type(resource_type)
    return meta


def _model(resource_type: str):
    base, _, _ = _resolve_type(resource_type)
    return RESOURCE_MODELS[base]


def _device_filter(model, base: str, device_id: int | None):
    """设备维度过滤（青藤 / 天擎）；None 表示全部设备，其它类型返回 None。"""
    if base in QINGTENG_DEVICE_TYPES and device_id is not None:
        return model.qingteng_device_id == device_id
    if base in ("tianqing_endpoint", "tianqing_software") and device_id is not None:
        return model.tianqing_device_id == device_id
    if base in JIAOTU_DEVICE_TYPES and device_id is not None:
        return model.jiaotu_device_id == device_id
    return None


def _qt_columns() -> list[dict]:
    """青藤主机列表页展示列（详情/导出用全量字段，见 export）。"""
    return [{"key": k, "label": QINGTENG_FIELD_LABELS.get(k, k)} for k in QINGTENG_LIST_FIELDS]


def _qt_component_columns() -> list[dict]:
    """青藤组件列表页展示列。"""
    return [
        {"key": k, "label": QINGTENG_COMPONENT_FIELD_LABELS.get(k, k)}
        for k in QINGTENG_COMPONENT_LIST_FIELDS
    ]


# 青藤资产明细：按模块的列表列定义（模块 tab 切换时复用）
_QT_ASSET_MODULE_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "account": [
        ("hostname", "主机名"), ("display_ip", "展示 IP"), ("os_type", "系统类型"),
        ("name", "账号名"), ("status", "状态"), ("path", "家目录"),
        ("uid", "UID"), ("gid", "GID"), ("lastLoginTime", "最后登录"),
        ("biz_group", "业务组"),
    ],
    "accountgroup": [
        ("hostname", "主机名"), ("display_ip", "展示 IP"), ("os_type", "系统类型"),
        ("name", "用户组名"), ("gid", "GID"), ("biz_group", "业务组"),
    ],
    "webapp": [
        ("hostname", "主机名"), ("display_ip", "展示 IP"), ("os_type", "系统类型"),
        ("name", "Web 应用"), ("version", "版本"), ("path", "应用路径"),
        ("serverName", "服务名"), ("domainName", "域名"), ("biz_group", "业务组"),
    ],
    "website": [
        ("hostname", "主机名"), ("display_ip", "展示 IP"), ("os_type", "系统类型"),
        ("name", "站点"), ("port", "端口"), ("proto", "协议"), ("status", "站点类型"),
        ("path", "根路径"), ("biz_group", "业务组"),
    ],
}


def _qt_asset_columns(module: str = "") -> list[dict]:
    """青藤资产明细列表页展示列；指定模块时按模块字段展示。"""
    columns = _QT_ASSET_MODULE_COLUMNS.get(module)
    if columns:
        return [{"key": k, "label": label} for k, label in columns]
    return [
        {"key": k, "label": QINGTENG_ASSET_FIELD_LABELS.get(k, k)}
        for k in QINGTENG_ASSET_LIST_FIELDS
    ]


# 椒图资产明细：按模块的列表列定义（模块 tab 切换时复用）
_JIAOTU_ASSET_MODULE_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "install_package": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "安装包"), ("version", "版本"), ("releaseNo", "发布号"),
        ("installTime", "安装时间"), ("publisher", "厂商"), ("path", "安装路径"),
        ("packageSizeStr", "大小"),
    ],
    "port": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "进程名"), ("port", "端口"), ("protocol", "协议"), ("status", "状态"),
    ],
    "process": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "进程名"), ("version", "版本"), ("start_user", "运行用户"), ("pid", "PID"),
    ],
    "database": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "数据库"), ("version", "版本"), ("port", "端口"),
        ("path", "绑定 IP"), ("start_user", "运行用户"),
    ],
    "web_server": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "Web 服务"), ("version", "版本"), ("port", "端口"),
        ("path", "进程路径"), ("start_user", "运行用户"), ("status", "服务类型"),
    ],
    "web_frame": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "Web 框架"), ("version", "版本"), ("path", "框架路径"),
    ],
    "account": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "账号名"), ("status", "角色"), ("lastLoginTime", "最后登录"),
    ],
    "network_connection": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "进程名"), ("protocol", "协议"), ("path", "连接"), ("status", "连接状态"),
    ],
    "start_service": [
        ("machine_name", "服务器名"), ("intranet_ip", "内网 IP"), ("os_type", "系统类型"),
        ("name", "服务名"), ("status", "启动状态"), ("path", "脚本路径"),
        ("publisher", "发布者"),
    ],
}


def _jiaotu_asset_columns(module: str = "") -> list[dict]:
    """椒图资产明细列表页展示列；指定模块时按模块字段展示。"""
    columns = _JIAOTU_ASSET_MODULE_COLUMNS.get(module)
    if columns:
        return [{"key": k, "label": label} for k, label in columns]
    return [
        {"key": k, "label": JIAOTU_ASSET_FIELD_LABELS.get(k, k)}
        for k in JIAOTU_ASSET_LIST_FIELDS
    ]


def _jiaotu_module_tabs() -> list[dict]:
    return [{"value": m, "label": JIAOTU_MODULE_LABELS[m]} for m in JIAOTU_MODULES]


def _columns(resource_type: str, module: str = "") -> list[dict]:
    base, _, _ = _resolve_type(resource_type)
    if base == "qingteng_host":
        return _qt_columns()
    if base == "qingteng_component":
        return _qt_component_columns()
    if base == "qingteng_asset":
        return _qt_asset_columns(module)
    if base == "jiaotu_host":
        return [
            {"key": k, "label": JIAOTU_HOST_FIELD_LABELS.get(k, k)}
            for k in JIAOTU_HOST_LIST_FIELDS
        ]
    if base == "jiaotu_asset":
        return _jiaotu_asset_columns(module)
    if base == "tianqing_endpoint":
        return [
            {"key": k, "label": TIANQING_FIELD_LABELS.get(k, k)}
            for k in TIANQING_LIST_FIELDS
        ]
    if base == "tianqing_software":
        return [
            {"key": k, "label": TIANQING_SOFTWARE_FIELD_LABELS.get(k, k)}
            for k in TIANQING_SOFTWARE_LIST_FIELDS
        ]
    cols = []
    for key in RESOURCE_EXCEL_FIELDS[base]:
        cols.append({"key": key, "label": FIELD_LABELS.get(key, key)})
    return cols


def _cell_value(val) -> str:
    if val is None:
        return ""
    if isinstance(val, (dict, list)):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, bool):
        return "true" if val else "false"
    return str(val).strip()


def _normalize_header(key: str) -> str:
    """表头归一化：中文标签（如导出 CSV 的表头「实例名称/IP」）与英文字段名的
    空格/大小写/下划线变体（「Instance Name」「INSTANCE_NAME」）映射回英文字段名，
    使导出口径的文件可直接再导入；未知表头原样返回（进 extra_excel），
    统计类表头不受影响。键口径与 HEADER_ALIAS 构建共用 norm_header_key。
    """
    k = (key or "").strip()
    if not k or skip_excel_header(k):
        return k
    field = HEADER_ALIAS.get(norm_header_key(k))
    return field if field else k


def _decode_csv_bytes(raw: bytes) -> str:
    """CSV 解码：UTF-8（含 BOM）优先，GBK/GB18030 兜底（Excel 中文另存常见）。"""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("gb18030")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="CSV 编码无法解析（支持 UTF-8 / GBK，请勿使用 UTF-16 等格式另存）",
        )


def _rows_from_grid(rows_iter) -> list[dict]:
    """CSV / Excel 共用的行构建：首行表头归一化，后续行按键取值。

    口径：短行补空、空行跳过、统计类表头列忽略、超过 MAX_ROWS 拒绝，
    两种格式走同一实现，避免口径漂移。
    """
    try:
        headers = [_normalize_header(_cell_value(h)) for h in next(rows_iter)]
    except StopIteration:
        return []
    result: list[dict] = []
    for row in rows_iter:
        item = {}
        empty = True
        for i, key in enumerate(headers):
            if skip_excel_header(key):
                continue
            val = _cell_value(row[i] if i < len(row) else "")
            if val:
                empty = False
            item[key] = val
        if not empty:
            result.append(item)
        if len(result) > MAX_ROWS:
            raise HTTPException(status_code=413, detail=f"行数过多，最多 {MAX_ROWS} 行")
    return result


def _parse_csv(raw: bytes) -> list[dict]:
    """解析 CSV（首行表头），行结构与 ``_parse_excel`` 同一套口径。"""
    return _rows_from_grid(csv.reader(io.StringIO(_decode_csv_bytes(raw))))


def _parse_excel(raw: bytes) -> list[dict]:
    """只读 Sheet「原始数据」，跳过「数据统计」页和统计类表头。"""
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = None
    for sheet in wb.worksheets:
        title = (sheet.title or "").strip()
        if title == "数据统计":
            continue
        if title == "原始数据":
            ws = sheet
            break
    if ws is None:
        for sheet in wb.worksheets:
            if (sheet.title or "").strip() != "数据统计":
                ws = sheet
                break
    if ws is None:
        return []
    return _rows_from_grid(ws.iter_rows(values_only=True))


def _source_id(row: dict) -> str:
    for key in SOURCE_ID_KEYS:
        val = _cell_value(row.get(key))
        if val:
            return val[:128]
    ip = _cell_value(row.get("ip_address") or row.get("ip"))
    name = _cell_value(row.get("instance_name") or row.get("inst_name") or row.get("name"))
    if ip or name:
        return f"{ip}|{name}"[:128]
    return ""


def _row_to_values(resource_type: str, row: dict, batch_id: int, now) -> dict:
    fields = RESOURCE_EXCEL_FIELDS[resource_type]
    known = set(fields)
    values = {
        "source_id": _source_id(row),
        "batch_id": batch_id,
        "created_at": now,
        "updated_at": now,
    }
    extra = {}
    for key, raw in row.items():
        if skip_excel_header(key):
            continue
        val = _cell_value(raw)
        if key in RESERVED_COLUMNS:
            if key == "source_id":
                # 唯一标识已由 _source_id 使用（导出 CSV 回导场景），不再进 extra
                continue
            extra[key] = val
            continue
        if key in known:
            values[excel_attr(key)] = val
        else:
            extra[key] = val
    for field in fields:
        attr = excel_attr(field)
        values.setdefault(attr, "")
    values["extra_excel"] = extra
    return values


def infer_resource_type(filename: str, explicit: str) -> str:
    if explicit:
        _require_type(explicit)
        return explicit
    name = (filename or "").lower()
    for code, meta in RESOURCE_TYPES.items():
        for hint in meta["filename_hints"]:
            if hint.lower() in name:
                return code
    raise HTTPException(
        status_code=400,
        detail="无法从文件名识别资源类型，请选择：云主机 / 裸金属 / 网络资源 / 弹性IP",
    )


def _excel_columns(resource_type: str) -> list[dict]:
    base, _, _ = _resolve_type(resource_type)
    if base == "tianqing_endpoint":
        return _columns(base)
    cols = []
    for key in RESOURCE_EXCEL_FIELDS[base]:
        cols.append({"key": key, "label": FIELD_LABELS.get(key, key)})
    return cols


def _type_payload(code: str, meta: dict, device: Device | None = None) -> dict:
    """资源类型 payload；青藤按设备生成（code 带设备维度，卡片名 = 设备名）。"""
    real_code = f"{code}:{device.id}" if device else code
    return {
        "code": real_code,
        "label": (device.name if device else meta["label"]),
        "excel_name": (device.name if device else meta.get("excel_name")) or meta["label"],
        "source_group": meta.get("source_group", "itsm_ops"),
        "excel_columns": _columns(real_code),
        "device_id": device.id if device else None,
        "api_sync": bool(meta.get("api_sync")),
    }


def _asset_module_tabs() -> list[dict]:
    """青藤资产明细的模块 tab 配置。"""
    return [{"value": m, "label": ASSET_MODULE_LABELS[m]} for m in ASSET_MODULES]


def _qingteng_table_payloads(
    db: Session,
    base: str = "qingteng_host",
    devices: list[Device] | None = None,
) -> list[dict]:
    """青藤数据表卡片：每台已启用的青藤设备一张（多青藤零配置纳管）。"""
    meta = RESOURCE_TYPES[base]
    devices = devices if devices is not None else get_qingteng_devices(db)
    payloads = [_type_payload(base, meta, device=dev) for dev in devices]
    if base == "qingteng_asset":
        for p in payloads:
            p["modules"] = _asset_module_tabs()
    return payloads


def _batch_consistent(live: int, batch: GovCloudImportBatch | None) -> bool:
    """库内条数是否与批次对齐。

    批次未成功（pending/running/partial/failed）时一律视为未对齐，
    避免部分同步（失败源保留旧数据）被误判为「已对齐」。
    """
    if batch is None:
        # 从未同步过的空表不能算「已对齐」，否则新接入设备会误显示为已对齐
        return False
    if (batch.status or "").lower() != "success":
        return False
    return live == int(batch.unique_source_ids or 0) and int(batch.skipped or 0) == 0


def _qingteng_group_tables(db: Session, gcode: str, devices: list[Device]) -> list[dict]:
    """青藤分组下按设备统计的数据表卡片（主机/组件/资产明细共用）。"""
    model = RESOURCE_MODELS[gcode]
    if gcode == "qingteng_host":
        columns = _qt_columns()
    elif gcode == "qingteng_component":
        columns = _qt_component_columns()
    else:
        columns = _qt_asset_columns()
    tables = []
    for dev in devices:
        code = f"{gcode}:{dev.id}"
        live = int(
            db.query(func.count(model.id))
            .filter(model.qingteng_device_id == dev.id)
            .scalar() or 0
        )
        last_batch = (
            db.query(GovCloudImportBatch)
            .filter(GovCloudImportBatch.resource_type == code)
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
        consistent = _batch_consistent(live, last_batch)
        table = {
            "code": code,
            "label": dev.name,
            "excel_name": dev.name,
            "excel_columns": columns,
            "total": live,
            "consistent": consistent,
            "last_batch": last_batch.to_dict() if last_batch else None,
            "device_id": dev.id,
        }
        if gcode == "qingteng_asset":
            table["modules"] = _asset_module_tabs()
        tables.append(table)
    return tables


def _tianqing_group_tables(
    db: Session,
    devices: list[Device],
    base: str = "tianqing_endpoint",
) -> list[dict]:
    """天擎分组下按设备统计的数据表卡片（终端 / 组件共用）。"""
    model = RESOURCE_MODELS[base]
    columns = _columns(base)
    tables = []
    for dev in devices:
        code = f"{base}:{dev.id}"
        live = int(
            db.query(func.count(model.id))
            .filter(model.tianqing_device_id == dev.id)
            .scalar() or 0
        )
        last_batch = (
            db.query(GovCloudImportBatch)
            .filter(GovCloudImportBatch.resource_type == code)
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
        tables.append({
            "code": code,
            "label": dev.name,
            "excel_name": dev.name,
            "source_group": base,
            "excel_columns": columns,
            "total": live,
            "consistent": _batch_consistent(live, last_batch),
            "last_batch": last_batch.to_dict() if last_batch else None,
            "device_id": dev.id,
            "api_sync": True,
        })
    return tables


def _jiaotu_group_tables(
    db: Session,
    devices: list[Device],
    base: str = "jiaotu_host",
) -> list[dict]:
    """椒图分组下按设备统计的数据表卡片（主机 / 资产明细共用）。"""
    model = RESOURCE_MODELS[base]
    columns = _columns(base)
    tables = []
    for dev in devices:
        code = f"{base}:{dev.id}"
        live = int(
            db.query(func.count(model.id))
            .filter(model.jiaotu_device_id == dev.id)
            .scalar() or 0
        )
        last_batch = (
            db.query(GovCloudImportBatch)
            .filter(GovCloudImportBatch.resource_type == code)
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
        table = {
            "code": code,
            "label": dev.name,
            "excel_name": dev.name,
            "source_group": base,
            "excel_columns": columns,
            "total": live,
            "consistent": _batch_consistent(live, last_batch),
            "last_batch": last_batch.to_dict() if last_batch else None,
            "device_id": dev.id,
            "api_sync": True,
        }
        if base == "jiaotu_asset":
            table["modules"] = _jiaotu_module_tabs()
        tables.append(table)
    return tables


@router.get("/meta")
def govcloud_meta(
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    qingteng_devices = get_qingteng_devices(db)
    qingteng_host_tables = _qingteng_table_payloads(db, "qingteng_host", qingteng_devices)
    qingteng_component_tables = _qingteng_table_payloads(db, "qingteng_component", qingteng_devices)
    qingteng_asset_tables = _qingteng_table_payloads(db, "qingteng_asset", qingteng_devices)
    tianqing_devices = get_tianqing_devices(db)
    tianqing_tables = _tianqing_group_tables(db, tianqing_devices)
    tianqing_software_tables = _tianqing_group_tables(db, tianqing_devices, "tianqing_software")
    jiaotu_devices = get_jiaotu_devices(db)
    jiaotu_host_tables = _jiaotu_group_tables(db, jiaotu_devices, "jiaotu_host")
    jiaotu_asset_tables = _jiaotu_group_tables(db, jiaotu_devices, "jiaotu_asset")
    types = [
        _type_payload(code, meta)
        for code, meta in RESOURCE_TYPES.items()
        if code not in DEVICE_DIMENSION_TYPES
    ]
    types.extend(qingteng_host_tables)
    types.extend(qingteng_component_tables)
    types.extend(qingteng_asset_tables)
    types.extend(tianqing_tables)
    types.extend(tianqing_software_tables)
    types.extend(jiaotu_host_tables)
    types.extend(jiaotu_asset_tables)
    groups = []
    for gcode, gmeta in SOURCE_GROUPS.items():
        if gcode == "qingteng_host":
            tables, enabled = qingteng_host_tables, bool(qingteng_host_tables)
        elif gcode == "qingteng_component":
            tables, enabled = qingteng_component_tables, bool(qingteng_component_tables)
        elif gcode == "qingteng_asset":
            tables, enabled = qingteng_asset_tables, bool(qingteng_asset_tables)
        elif gcode == "jiaotu_host":
            tables, enabled = jiaotu_host_tables, bool(jiaotu_host_tables)
        elif gcode == "jiaotu_asset":
            tables, enabled = jiaotu_asset_tables, bool(jiaotu_asset_tables)
        elif gcode == "tianqing_endpoint":
            tables, enabled = tianqing_tables, bool(tianqing_tables)
        elif gcode == "tianqing_software":
            tables, enabled = tianqing_software_tables, bool(tianqing_software_tables)
        else:
            tables = [t for t in types if t.get("source_group") == gcode]
            enabled = bool(gmeta.get("enabled", True))
        groups.append({
            "code": gcode,
            "label": gmeta["label"],
            "index": gmeta.get("index", ""),
            "enabled": enabled,
            "sort_order": gmeta.get("sort_order", 0),
            "description": gmeta.get("description", ""),
            "tables": tables,
        })
    groups.sort(key=lambda g: g["sort_order"])
    return {
        "types": types,
        "groups": groups,
        "field_labels": {
            **FIELD_LABELS,
            **QINGTENG_FIELD_LABELS,
            **QINGTENG_COMPONENT_FIELD_LABELS,
            **QINGTENG_ASSET_FIELD_LABELS,
            **TIANQING_FIELD_LABELS,
            **TIANQING_SOFTWARE_FIELD_LABELS,
            **JIAOTU_HOST_FIELD_LABELS,
            **JIAOTU_ASSET_FIELD_LABELS,
        },
    }


@router.get("/summary")
def govcloud_summary(
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    groups = []
    qingteng_devices = get_qingteng_devices(db)
    tianqing_devices = get_tianqing_devices(db)
    jiaotu_devices = get_jiaotu_devices(db)
    for gcode, gmeta in SOURCE_GROUPS.items():
        tables = []
        if gcode in QINGTENG_DEVICE_TYPES:
            # 每台青藤设备一张数据表卡片（主机 / 组件）：总数/一致性按设备维度统计
            tables = _qingteng_group_tables(db, gcode, qingteng_devices)
            groups.append({
                "code": gcode,
                "label": gmeta["label"],
                "index": gmeta.get("index", ""),
                "enabled": bool(qingteng_devices),
                "sort_order": gmeta.get("sort_order", 0),
                "description": gmeta.get("description", ""),
                "tables": tables,
            })
            continue
        if gcode == "jiaotu_host":
            tables = _jiaotu_group_tables(db, jiaotu_devices, "jiaotu_host")
            groups.append({
                "code": gcode,
                "label": gmeta["label"],
                "index": gmeta.get("index", ""),
                "enabled": bool(jiaotu_devices),
                "sort_order": gmeta.get("sort_order", 0),
                "description": gmeta.get("description", ""),
                "tables": tables,
            })
            continue
        if gcode == "jiaotu_asset":
            tables = _jiaotu_group_tables(db, jiaotu_devices, "jiaotu_asset")
            groups.append({
                "code": gcode,
                "label": gmeta["label"],
                "index": gmeta.get("index", ""),
                "enabled": bool(jiaotu_devices),
                "sort_order": gmeta.get("sort_order", 0),
                "description": gmeta.get("description", ""),
                "tables": tables,
            })
            continue
        if gcode == "tianqing_endpoint":
            tables = _tianqing_group_tables(db, tianqing_devices)
            groups.append({
                "code": gcode,
                "label": gmeta["label"],
                "index": gmeta.get("index", ""),
                "enabled": bool(tianqing_devices),
                "sort_order": gmeta.get("sort_order", 0),
                "description": gmeta.get("description", ""),
                "tables": tables,
            })
            continue
        if gcode == "tianqing_software":
            tables = _tianqing_group_tables(db, tianqing_devices, "tianqing_software")
            groups.append({
                "code": gcode,
                "label": gmeta["label"],
                "index": gmeta.get("index", ""),
                "enabled": bool(tianqing_devices),
                "sort_order": gmeta.get("sort_order", 0),
                "description": gmeta.get("description", ""),
                "tables": tables,
            })
            continue
        for code, meta in RESOURCE_TYPES.items():
            if meta.get("source_group") != gcode or code in DEVICE_DIMENSION_TYPES:
                continue
            model = RESOURCE_MODELS[code]
            live = int(db.query(func.count(model.id)).scalar() or 0)
            last_batch = (
                db.query(GovCloudImportBatch)
                .filter(GovCloudImportBatch.resource_type == code)
                .order_by(GovCloudImportBatch.id.desc())
                .first()
            )
            consistent = _batch_consistent(live, last_batch)
            tables.append({
                "code": code,
                "label": meta["label"],
                "excel_name": meta.get("excel_name") or meta["label"],
                "excel_columns": _columns(code),
                "total": live,
                "consistent": consistent,
                "last_batch": last_batch.to_dict() if last_batch else None,
            })
        groups.append({
            "code": gcode,
            "label": gmeta["label"],
            "index": gmeta.get("index", ""),
            "enabled": bool(gmeta.get("enabled", True)),
            "sort_order": gmeta.get("sort_order", 0),
            "description": gmeta.get("description", ""),
            "tables": tables,
        })
    groups.sort(key=lambda g: g["sort_order"])
    return {"groups": groups}


@router.get("/assets")
def list_govcloud_assets(
    resource_type: str = Query(..., description="资源类型（青藤为 qingteng_host:<设备ID>）"),
    keyword: str = Query("", description="名称/IP/部门/source_id 模糊搜索"),
    module: str = Query("", description="青藤资产明细模块筛选（account/accountgroup/webapp/website）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    base, meta, device_id = _resolve_type(resource_type)
    model = _model(resource_type)
    query = db.query(model)
    dev_filter = _device_filter(model, base, device_id)
    if dev_filter is not None:
        query = query.filter(dev_filter)
    if module and base in ("qingteng_asset", "jiaotu_asset"):
        query = query.filter(model.module == module)
    kw = keyword.strip()
    if kw:
        query = query.filter(or_(*_keyword_clauses(model, meta, kw)))

    total = query.count()
    rows = (
        query.order_by(model.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "columns": _columns(resource_type, module),
        "items": [r.to_dict() for r in rows],
    }


@router.get("/export")
def export_govcloud_assets(
    resource_type: str = Query(..., description="资源类型（青藤为 qingteng_host:<设备ID>）"),
    keyword: str = Query("", description="与列表一致的搜索条件（可选）"),
    module: str = Query("", description="青藤资产明细模块筛选（可选）"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "export")),
    request: Request = None,
) -> StreamingResponse:
    """导出指定资源类型为 CSV（UTF-8 BOM，Excel 可直接打开）。

    - 列：该类型 Excel 字段（field_label 作表头）+ extra_excel 出现过的
      额外列（追加尾部，爬虫新增列不丢）+ source_id/入库时间/更新时间；
      青藤为全量主机字段 + extra + 来源青藤平台
    - 行：按 id 升序全量导出；传 keyword 时与列表搜索口径一致
    - 流式分块写出，避免一次性加载全表（单次导入上限 25 万行）
    """
    base, meta, device_id = _resolve_type(resource_type)
    model = _model(resource_type)
    kw = keyword.strip()
    kw_clauses = _keyword_clauses(model, meta, kw) if kw else []
    dev_filter = _device_filter(model, base, device_id)
    module_filter = (
        model.module == module if module and base in ("qingteng_asset", "jiaotu_asset") else None
    )

    if base == "qingteng_host":
        fields = list(QINGTENG_HOST_FIELDS)
        labels = QINGTENG_FIELD_LABELS
        extra_col = "extra"
        tail = QT_EXPORT_TAIL_COLUMNS
    elif base == "qingteng_component":
        # 组件来源导出中文标签（source_type_label 为模型属性）
        fields = ["source_type_label"] + [
            f for f in QINGTENG_COMPONENT_FIELDS if f != "source_type"
        ]
        labels = QINGTENG_COMPONENT_FIELD_LABELS
        extra_col = "extra"
        tail = QT_EXPORT_TAIL_COLUMNS
    elif base == "qingteng_asset":
        fields = ["module_label"] + [
            f for f in QINGTENG_ASSET_FIELDS if f != "module"
        ]
        labels = QINGTENG_ASSET_FIELD_LABELS
        extra_col = "payload"
        tail = QT_EXPORT_TAIL_COLUMNS
    elif base == "tianqing_endpoint":
        fields = list(TIANQING_ENDPOINT_FIELDS)
        labels = TIANQING_FIELD_LABELS
        extra_col = "extra"
        tail = TQ_EXPORT_TAIL_COLUMNS
    elif base == "tianqing_software":
        fields = list(TIANQING_SOFTWARE_FIELDS)
        labels = TIANQING_SOFTWARE_FIELD_LABELS
        extra_col = "extra"
        tail = TQ_EXPORT_TAIL_COLUMNS
    elif base == "jiaotu_host":
        fields = list(JIAOTU_HOST_FIELDS)
        labels = JIAOTU_HOST_FIELD_LABELS
        extra_col = "extra"
        tail = JT_EXPORT_TAIL_COLUMNS
    elif base == "jiaotu_asset":
        fields = ["module_label"] + [
            f for f in JIAOTU_ASSET_FIELDS if f != "module"
        ]
        labels = JIAOTU_ASSET_FIELD_LABELS
        extra_col = "payload"
        tail = JT_EXPORT_TAIL_COLUMNS
    else:
        fields = RESOURCE_EXCEL_FIELDS[base]
        labels = FIELD_LABELS
        extra_col = "extra_excel"
        tail = EXPORT_TAIL_COLUMNS
    # extra 中出现过的额外列（jsonb_object_keys 汇总去重），保证新列不丢；
    # 排除与尾部业务列同名的键，避免 CSV 出现重复表头
    extra_keys = sorted(
        k for k in db.execute(
            text(f"SELECT DISTINCT k FROM {model.__tablename__}, jsonb_object_keys({extra_col}) AS k")
        ).scalars()
        if k not in fields and k not in tail
    )
    headers = (
        [labels.get(f, f) for f in fields]
        + [labels.get(k, k) for k in extra_keys]
        + list(tail)
    )

    # 审计：导出操作（GET 请求不被中间件捕获，需手动记录）
    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="export",
            resource_type="asset_discovery",
            detail=f"{resource_type} keyword={kw!r}",
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("导出审计写入失败（忽略）: %s", exc)

    def _iter_csv():
        buf = io.StringIO()
        buf.write("\ufeff")  # BOM：Excel 直接打开不乱码
        csv.writer(buf).writerow(headers)
        yield buf.getvalue()

        last_id = 0
        exported = 0
        while True:
            query = db.query(model).filter(model.id > last_id)
            if kw_clauses:
                query = query.filter(or_(*kw_clauses))
            if dev_filter is not None:
                query = query.filter(dev_filter)
            if module_filter is not None:
                query = query.filter(module_filter)
            rows = query.order_by(model.id).limit(EXPORT_CHUNK).all()
            if not rows:
                break
            chunk = io.StringIO()
            writer = csv.writer(chunk)
            for row in rows:
                last_id = row.id
                exported += 1
                writer.writerow(_row_cells(row, fields, extra_keys, extra_col, tail))
            yield chunk.getvalue()
            if len(rows) < EXPORT_CHUNK:
                break
        logger.info("资产发现导出: type=%s keyword=%r rows=%d", resource_type, kw, exported)

    excel_name = meta.get("excel_name") or meta["label"]
    filename = f"{excel_name}_{beijing_now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        _iter_csv(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/assets/{resource_type}/{asset_id}")
def get_govcloud_asset(
    resource_type: str,
    asset_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    model = _model(resource_type)
    rec = db.query(model).filter(model.id == asset_id).first()
    if rec is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return rec.to_dict()


@router.get("/batches")
def list_batches(
    resource_type: str = Query("", description="可选，按类型筛选"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    query = db.query(GovCloudImportBatch)
    if resource_type:
        _require_type(resource_type)
        query = query.filter(GovCloudImportBatch.resource_type == resource_type)
    rows = query.order_by(GovCloudImportBatch.id.desc()).limit(limit).all()
    return {"items": [r.to_dict() for r in rows]}


@router.get("/consistency")
def check_consistency(
    resource_type: str = Query(..., description="资源类型（青藤为 qingteng_host:<设备ID>）"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    base, _, device_id = _resolve_type(resource_type)
    model = _model(resource_type)
    dev_filter = _device_filter(model, base, device_id)
    live_query = db.query(func.count(model.id))
    if dev_filter is not None:
        live_query = live_query.filter(dev_filter)
    live = int(live_query.scalar() or 0)
    last_full = (
        db.query(GovCloudImportBatch)
        .filter(
            GovCloudImportBatch.resource_type == resource_type,
            or_(
                GovCloudImportBatch.import_mode == "full",
                GovCloudImportBatch.import_mode.is_(None),
                GovCloudImportBatch.import_mode == "",
            ),
            # 运行中的批次不计入一致性基准（组件异步同步会先建 pending 批次）
            GovCloudImportBatch.status.notin_(("pending", "running")),
        )
        .order_by(GovCloudImportBatch.id.desc())
        .first()
    )
    last_batch = (
        db.query(GovCloudImportBatch)
        .filter(GovCloudImportBatch.resource_type == resource_type)
        .order_by(GovCloudImportBatch.id.desc())
        .first()
    )
    if last_full is None:
        return {
            "resource_type": resource_type,
            "live_count": live,
            "excel_rows": last_batch.excel_rows if last_batch else 0,
            "unique_source_ids": last_batch.unique_source_ids if last_batch else 0,
            "consistent": live == 0,
            "last_batch": last_batch.to_dict() if last_batch else None,
            "message": (
                "尚未做过全量导入，无法按全量爬取校验一致性"
                if last_batch
                else "尚未导入过该类型，库内应为空才算一致"
            ),
        }
    batch_ok = (last_full.status or "success").lower() == "success"
    consistent = batch_ok and live == last_full.unique_source_ids and last_full.skipped == 0
    if last_full.consistent != int(consistent) or last_full.live_count != live:
        last_full.consistent = int(consistent)
        last_full.live_count = live
        db.commit()
    return {
        "resource_type": resource_type,
        "live_count": live,
        "excel_rows": last_full.excel_rows,
        "unique_source_ids": last_full.unique_source_ids,
        "skipped": last_full.skipped,
        "consistent": consistent,
        "last_batch": last_batch.to_dict() if last_batch else None,
        "last_full": last_full.to_dict(),
        "message": (
            "与最近一次全量导入一致"
            if consistent
            else (
                f"最近一次全量为部分完成（{last_full.status}），失败/截断来源保留旧数据，不计为对齐"
                if not batch_ok
                else f"与最近一次全量不一致：库内 {live} 条，全量唯一 ID {last_full.unique_source_ids} 条"
            )
        ),
    }


@router.post("/import")
def import_govcloud_excel(
    file: UploadFile = File(..., description="爬虫产出的 xlsx / csv"),
    resource_type: str = Query("", description="cloud_host / bare_metal / e_government_network / elastic_ip"),
    mode: str = Query("full", description="导入模式：full 全量对齐 / incremental 增量 upsert 不删除"),
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "import")),
) -> dict:
    """导入爬虫产出的 xlsx / csv（同步 def：走 FastAPI 线程池，防止大文件
    同步解析阻塞事件循环导致全站 502，与 assets.import_assets 同口径）。"""
    filename = file.filename or "upload"
    lower = filename.lower()
    is_csv = lower.endswith(".csv")
    if not (is_csv or lower.endswith(".xlsx")):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx / .csv（爬虫输出格式）")
    import_mode = mode if mode in ("full", "incremental") else "full"
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(raw) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="文件超过 200MB")

    rtype = infer_resource_type(filename, resource_type)
    rtype_base = rtype.split(":", 1)[0]
    if rtype_base in QINGTENG_DEVICE_TYPES:
        raise HTTPException(
            status_code=400,
            detail="青藤主机/组件来自 API 同步（设备管理配置青藤设备后一键拉取），不支持 Excel 导入",
        )
    if rtype_base == "tianqing_endpoint":
        raise HTTPException(
            status_code=400,
            detail="天擎终端为 API 同步来源（设备管理配置天擎设备后一键拉取），不支持 Excel 导入",
        )
    if rtype_base == "tianqing_software":
        raise HTTPException(
            status_code=400,
            detail="天擎组件为 API 同步来源（按终端拉取已安装软件），不支持 Excel 导入",
        )
    if rtype_base in JIAOTU_DEVICE_TYPES:
        raise HTTPException(
            status_code=400,
            detail="椒图云锁主机/资产明细为 API 同步来源（设备管理配置椒图设备后一键拉取），不支持 Excel 导入",
        )
    model = _model(rtype)
    started = time.perf_counter()
    rows = _parse_csv(raw) if is_csv else _parse_excel(raw)
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="未解析到数据行（xlsx 需 Sheet「原始数据」；csv 需首行为表头）",
        )

    skipped = 0
    seen: dict[str, dict] = {}
    duplicate = 0
    for row in rows:
        sid = _source_id(row)
        if not sid:
            skipped += 1
            continue
        if sid in seen:
            duplicate += 1
        seen[sid] = row

    unique_rows = list(seen.values())
    if not unique_rows:
        # 全部行都识别不出唯一标识：多为表头不匹配（如非爬虫口径的文件）。
        # 直接拒绝，避免产生「全量 0 条」批次并把全量模式下库内数据误删。
        raise HTTPException(
            status_code=400,
            detail=(
                f"{len(rows)} 行均无法识别唯一标识（需要 _id / instance_id / source_id 列），"
                "请确认表头与爬虫输出一致（导出的 CSV 可直接再导入）"
            ),
        )
    unique_ids = set(seen.keys())
    existing_ids = {r[0] for r in db.query(model.source_id).all()}
    inserted = len(unique_ids - existing_ids)
    updated = len(unique_ids & existing_ids)
    deleted = len(existing_ids - unique_ids) if import_mode == "full" else 0

    batch = GovCloudImportBatch(
        resource_type=rtype,
        filename=filename[:300],
        file_size=len(raw),
        excel_rows=len(rows),
        unique_source_ids=len(unique_ids),
        inserted=inserted,
        updated=updated,
        deleted=deleted,
        skipped=skipped,
        live_count=0,
        consistent=0,
        import_mode=import_mode,
        created_by=user.id,
        created_at=beijing_now(),
    )
    db.add(batch)
    db.flush()

    now = beijing_now()
    values = [_row_to_values(rtype, row, batch.id, now) for row in unique_rows]
    excel_attrs = [excel_attr(f) for f in RESOURCE_EXCEL_FIELDS[rtype]]
    update_cols = [*excel_attrs, "extra_excel", "batch_id", "updated_at"]

    for i in range(0, len(values), UPSERT_CHUNK):
        chunk = values[i:i + UPSERT_CHUNK]
        stmt = insert(model).values(chunk)
        excluded = stmt.excluded
        stmt = stmt.on_conflict_do_update(
            index_elements=["source_id"],
            set_={col: getattr(excluded, col) for col in update_cols},
        )
        db.execute(stmt)

    if import_mode == "full":
        db.query(model).filter(model.batch_id != batch.id).delete(synchronize_session=False)

    live = int(db.query(func.count(model.id)).scalar() or 0)
    consistent = live == len(unique_ids) and skipped == 0 if import_mode == "full" else skipped == 0
    notes = []
    notes.append("全量导入：已删除文件中不存在的旧记录" if import_mode == "full" else "增量导入：仅新增/更新，未删除库内既有记录")
    if not is_csv:
        notes.append("未导入 Sheet「数据统计」")
    if duplicate:
        notes.append(f"文件内重复 source_id {duplicate} 条，已按最后一条保留")
    if skipped:
        notes.append(f"缺少 _id/instance_id 跳过 {skipped} 条")
    if not consistent:
        notes.append(f"同步后库内 {live} 与唯一 ID {len(unique_ids)} 不一致")
    batch.live_count = live
    batch.consistent = int(consistent)
    batch.duration_ms = int((time.perf_counter() - started) * 1000)
    batch.note = "；".join(notes)
    db.commit()

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="import",
            resource_type="asset_discovery",
            resource_id=str(batch.id),
            detail=f"{rtype} {import_mode} excel={len(rows)} live={live}",
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as extra_exc:  # noqa: BLE001
        logger.warning("导入审计写入失败（忽略）: %s", extra_exc)
    logger.info(
        "政务云导入: mode=%s type=%s excel=%d unique=%d live=%d inserted=%d updated=%d deleted=%d consistent=%s",
        import_mode, rtype, len(rows), len(unique_ids), live, inserted, updated, deleted, consistent,
    )
    return {
        "resource_type": rtype,
        "import_mode": import_mode,
        "excel_rows": len(rows),
        "unique_source_ids": len(unique_ids),
        "inserted": inserted,
        "updated": updated,
        "deleted": deleted,
        "skipped": skipped,
        "live_count": live,
        "consistent": consistent,
        "duration_ms": batch.duration_ms,
        "note": batch.note,
        "batch": batch.to_dict(),
    }


class QingtengSyncRequest(BaseModel):
    """青藤主机同步请求：不传 device_ids 同步全部已启用的青藤设备。"""
    device_ids: list[int] = Field(default_factory=list, description="青藤设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")


@router.post("/qingteng/sync")
def sync_qingteng_hosts(
    payload: QingtengSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """手动触发青藤主机同步：逐台登录青藤平台，分页拉取 linux / win 主机清单入库。

    - 凭据复用设备管理（auth_type=qingteng 的 api_url/用户名/密码）；
    - 单台失败不阻断其它设备，逐台返回结果；
    - 同步口径与 Excel 导入对齐（full 删除青藤平台已不存在的记录）。
    """
    devices = get_qingteng_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"青藤设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的青藤设备：请先在「设备管理」新建设备（认证方式选择「青藤签名」），"
                   "配置 API 地址与 Console 用户名/密码后启用",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    results = []
    for dev in devices:
        try:
            res = sync_device_hosts(db, dev, user_id=user.id, mode=import_mode)
            results.append({"success": True, **res})
        except Exception as exc:  # noqa: BLE001
            logger.warning("青藤同步失败: device=%s(%d) err=%s", dev.name, dev.id, exc)
            results.append({
                "success": False,
                "device_id": dev.id,
                "device_name": dev.name,
                "import_mode": import_mode,
                "error": str(exc),
            })

    ok_count = sum(1 for r in results if r.get("success"))
    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"qingteng {import_mode} devices={len(devices)} ok={ok_count} "
                f"failed={len(results) - ok_count}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success" if ok_count == len(results) else "partial",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "success": ok_count == len(results),
        "mode": import_mode,
        "device_count": len(devices),
        "ok_count": ok_count,
        "results": results,
    }


class QingtengComponentSyncRequest(BaseModel):
    """青藤组件同步请求：不传 device_ids 同步全部已启用的青藤设备。"""
    device_ids: list[int] = Field(default_factory=list, description="青藤设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")
    sources: list[str] = Field(
        default_factory=list,
        description="组件来源：pkg/app/dbinfo/jar_pkg/webframe（空 = 全部）",
    )


@router.post("/qingteng/component-sync", status_code=202)
def sync_qingteng_components_endpoint(
    payload: QingtengComponentSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """异步触发青藤组件清单同步（Celery 任务 + 批次进度轮询）。

    - 先为每台设备创建 pending 批次，再派发 ``sync_qingteng_components``；
    - 同一设备已有 pending/running 批次时拒绝重复派发；
    - 派发失败（Redis/Celery 未就绪）返回 503 并把批次置为 failed。
    """
    devices = get_qingteng_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"青藤设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的青藤设备：请先在「设备管理」配置并启用青藤设备",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    invalid = [s for s in payload.sources if s not in COMPONENT_SOURCES]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的组件来源: {invalid}，可选: {list(COMPONENT_SOURCES)}",
        )
    sources = list(dict.fromkeys(payload.sources)) or list(COMPONENT_SOURCES)

    device_ids = [d.id for d in devices]
    active_types = [f"qingteng_component:{did}" for did in device_ids]
    active_query = db.query(GovCloudImportBatch).filter(
        GovCloudImportBatch.resource_type.in_(active_types),
        GovCloudImportBatch.status.in_(("pending", "running")),
    )
    # 超过 2 小时仍未完成的批次视为失效（worker 被硬杀/漏改状态），允许重新派发
    stale_before = beijing_now() - timedelta(hours=2)
    stale = active_query.filter(GovCloudImportBatch.created_at < stale_before).all()
    if stale:
        for b in stale:
            b.status = "failed"
            b.phase = "超时"
            b.percent = 100
            b.note = "同步任务超过 2 小时未完成，已标记失败"
        db.commit()
    active = active_query.filter(GovCloudImportBatch.created_at >= stale_before).all()
    if active:
        busy_ids = {
            int(b.resource_type.split(":", 1)[-1])
            for b in active
            if b.resource_type.split(":", 1)[-1].isdigit()
        }
        name_by_id = {d.id: d.name for d in devices}
        names = "、".join(name_by_id.get(i, str(i)) for i in sorted(busy_ids))
        raise HTTPException(
            status_code=409,
            detail=f"设备 {names} 已有组件同步任务在运行，请等待完成后再试",
        )

    now = beijing_now()
    batches: list[tuple[Device, GovCloudImportBatch]] = []
    for dev in devices:
        batch = GovCloudImportBatch(
            resource_type=f"qingteng_component:{dev.id}",
            filename=f"API同步组件:{dev.name}"[:300],
            file_size=0,
            excel_rows=0,
            unique_source_ids=0,
            inserted=0,
            updated=0,
            deleted=0,
            skipped=0,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            status="pending",
            phase="等待执行",
            percent=0,
            stats={},
            note="",
            created_by=user.id,
            created_at=now,
        )
        db.add(batch)
        db.flush()
        batches.append((dev, batch))
    db.commit()

    task_id = ""
    try:
        task = sync_qingteng_components.delay(
            device_ids, user.id, import_mode, sources,
        )
        task_id = str(getattr(task, "id", "") or "")
        for _dev, batch in batches:
            batch.stats = {**(batch.stats or {}), "task_id": task_id}
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("青藤组件同步任务派发失败: %s", exc)
        for _dev, batch in batches:
            batch.status = "failed"
            batch.phase = "派发失败"
            batch.percent = 100
            batch.note = f"异步任务派发失败（Redis/Celery 未就绪）: {exc}"[:2000]
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="组件同步任务派发失败，请确认后台任务服务（Celery worker）已启动",
        )

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"qingteng components {import_mode} devices={device_ids} "
                f"sources={','.join(sources)} task={task_id}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "mode": import_mode,
        "sources": sources,
        "task_id": task_id,
        "batches": [
            {
                "device_id": dev.id,
                "device_name": dev.name,
                "batch_id": batch.id,
                "status": batch.status,
            }
            for dev, batch in batches
        ],
    }


@router.get("/qingteng/component-sync/status")
def qingteng_component_sync_status(
    batch_id: int | None = Query(None, description="批次 ID"),
    device_id: int | None = Query(None, description="青藤设备 ID（取最近批次）"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """查询组件同步批次进度（前端轮询）。"""
    if batch_id is None and device_id is None:
        raise HTTPException(status_code=400, detail="batch_id 与 device_id 至少传一个")
    query = db.query(GovCloudImportBatch)
    if batch_id is not None:
        batch = query.filter(GovCloudImportBatch.id == batch_id).first()
    else:
        batch = (
            query.filter(GovCloudImportBatch.resource_type == f"qingteng_component:{device_id}")
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
    if batch is None or not (batch.resource_type or "").startswith("qingteng_component:"):
        raise HTTPException(status_code=404, detail="同步批次不存在")
    return batch.to_dict()


class QingtengModuleSyncRequest(BaseModel):
    """青藤资产明细模块同步请求。"""
    device_ids: list[int] = Field(default_factory=list, description="青藤设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")
    modules: list[str] = Field(
        default_factory=list,
        description="模块：account/accountgroup/webapp/website（空 = 全部）",
    )


@router.post("/qingteng/module-sync", status_code=202)
def sync_qingteng_modules_endpoint(
    payload: QingtengModuleSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """异步触发青藤资产明细同步（账号 / 用户组 / Web 应用 / Web 站点）。"""
    devices = get_qingteng_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"青藤设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的青藤设备：请先在「设备管理」配置并启用青藤设备",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    invalid = [m for m in payload.modules if m not in ASSET_MODULES]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的资产模块: {invalid}，可选: {list(ASSET_MODULES)}",
        )
    modules = list(dict.fromkeys(payload.modules)) or list(ASSET_MODULES)

    device_ids = [d.id for d in devices]
    active_types = [f"qingteng_asset:{did}" for did in device_ids]
    active_query = db.query(GovCloudImportBatch).filter(
        GovCloudImportBatch.resource_type.in_(active_types),
        GovCloudImportBatch.status.in_(("pending", "running")),
    )
    stale_before = beijing_now() - timedelta(hours=2)
    stale = active_query.filter(GovCloudImportBatch.created_at < stale_before).all()
    if stale:
        for b in stale:
            b.status = "failed"
            b.phase = "超时"
            b.percent = 100
            b.note = "同步任务超过 2 小时未完成，已标记失败"
        db.commit()
    active = active_query.filter(GovCloudImportBatch.created_at >= stale_before).all()
    if active:
        busy_ids = {
            int(b.resource_type.split(":", 1)[-1])
            for b in active
            if b.resource_type.split(":", 1)[-1].isdigit()
        }
        name_by_id = {d.id: d.name for d in devices}
        names = "、".join(name_by_id.get(i, str(i)) for i in sorted(busy_ids))
        raise HTTPException(
            status_code=409,
            detail=f"设备 {names} 已有资产同步任务在运行，请等待完成后再试",
        )

    now = beijing_now()
    batches: list[tuple[Device, GovCloudImportBatch]] = []
    for dev in devices:
        batch = GovCloudImportBatch(
            resource_type=f"qingteng_asset:{dev.id}",
            filename=f"API同步资产:{dev.name}"[:300],
            file_size=0,
            excel_rows=0,
            unique_source_ids=0,
            inserted=0,
            updated=0,
            deleted=0,
            skipped=0,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            status="pending",
            phase="等待执行",
            percent=0,
            stats={},
            note="",
            created_by=user.id,
            created_at=now,
        )
        db.add(batch)
        db.flush()
        batches.append((dev, batch))
    db.commit()

    task_id = ""
    try:
        task = sync_qingteng_modules.delay(
            device_ids, user.id, import_mode, modules,
        )
        task_id = str(getattr(task, "id", "") or "")
        for _dev, batch in batches:
            batch.stats = {**(batch.stats or {}), "task_id": task_id}
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("青藤资产同步任务派发失败: %s", exc)
        for _dev, batch in batches:
            batch.status = "failed"
            batch.phase = "派发失败"
            batch.percent = 100
            batch.note = f"异步任务派发失败（Redis/Celery 未就绪）: {exc}"[:2000]
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="资产同步任务派发失败，请确认后台任务服务（Celery worker）已启动",
        )

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"qingteng asset modules {import_mode} devices={device_ids} "
                f"modules={','.join(modules)} task={task_id}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "mode": import_mode,
        "modules": modules,
        "task_id": task_id,
        "batches": [
            {
                "device_id": dev.id,
                "device_name": dev.name,
                "batch_id": batch.id,
                "status": batch.status,
            }
            for dev, batch in batches
        ],
    }


@router.get("/qingteng/module-sync/status")
def qingteng_module_sync_status(
    batch_id: int | None = Query(None, description="批次 ID"),
    device_id: int | None = Query(None, description="青藤设备 ID（取最近批次）"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """查询资产明细同步批次进度（前端轮询）。"""
    if batch_id is None and device_id is None:
        raise HTTPException(status_code=400, detail="batch_id 与 device_id 至少传一个")
    query = db.query(GovCloudImportBatch)
    if batch_id is not None:
        batch = query.filter(GovCloudImportBatch.id == batch_id).first()
    else:
        batch = (
            query.filter(GovCloudImportBatch.resource_type == f"qingteng_asset:{device_id}")
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
    if batch is None or not (batch.resource_type or "").startswith("qingteng_asset:"):
        raise HTTPException(status_code=404, detail="同步批次不存在")
    return batch.to_dict()


@router.get("/qingteng/realtime-modules")
def qingteng_realtime_modules(
    group: str = Query("", description="青藤分组：qingteng_host/qingteng_component/qingteng_asset"),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """实时查询可用模块（按资产发现分组过滤）。"""
    return {
        "modules": [
            {
                "value": code,
                "label": spec["label"],
                "os_types": list(spec["os_types"]),
            }
            for code, spec in REALTIME_MODULES.items()
            if not group or group in spec.get("groups", ())
        ]
    }


@router.get("/qingteng/realtime-query")
def qingteng_realtime_query(
    device_id: int = Query(..., description="青藤设备 ID"),
    module: str = Query(..., description="资产模块：account/accountgroup/webapp/website/process/port/service/pkg/app/dbinfo/webframe"),
    keyword: str = Query("", description="名称/版本/路径关键词"),
    agent_id: str = Query("", description="Agent ID（精确）"),
    ip: str = Query("", description="主机 IP（青藤为模糊匹配）"),
    hostname: str = Query("", description="主机名"),
    port: int | None = Query(None, description="端口（站点/端口/数据库模块有效）"),
    os_type: str = Query("", description="linux/win，空=全部"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """实时查询青藤资产（不落库），结果直接返回前端。"""
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None or (device.auth_type or "") != "qingteng":
        raise HTTPException(status_code=404, detail="青藤设备不存在")
    if not device.enabled:
        raise HTTPException(status_code=400, detail="青藤设备未启用")
    try:
        return realtime_query(
            device,
            module,
            keyword=keyword,
            agent_id=agent_id,
            ip=ip,
            hostname=hostname,
            port=port,
            os_type=os_type,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("青藤实时查询失败 device=%s module=%s err=%s", device_id, module, exc)
        raise HTTPException(status_code=502, detail=f"青藤实时查询失败: {exc}") from exc


@router.get("/qingteng/cve-hosts")
def qingteng_cve_hosts(
    device_id: int = Query(..., description="青藤设备 ID"),
    cve: str = Query(..., description="CVE 编号，如 CVE-2024-21762"),
    refresh: bool = Query(False, description="是否强制重建索引"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """按 CVE 实时查询青藤中命中的主机及每台主机的命中证据。

    - 索引来自青藤漏洞检测（cves）与补丁检测（ref），缓存 10 分钟；
    - 主机上下文优先取已同步的主机资产（负责人/机房/资产编号/在线状态）；
    - 进程与组件清单不含 CVE 字段，不参与命中判定。
    """
    device = (
        db.query(Device)
        .filter(
            Device.id == device_id,
            Device.auth_type == "qingteng",
            Device.enabled.is_(True),
        )
        .first()
    )
    if device is None:
        raise HTTPException(status_code=404, detail="青藤设备不存在或未启用")

    try:
        result = query_cve_hosts(device, cve, force_refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.warning("青藤 CVE 查询失败 device=%s(%d) cve=%s err=%s", device.name, device.id, cve, exc)
        raise HTTPException(status_code=502, detail=f"青藤 CVE 查询失败: {exc}")

    agent_ids = [h.get("agent_id") for h in result.get("hosts", []) if h.get("agent_id")]
    if agent_ids:
        records = (
            db.query(QingtengHostAsset)
            .filter(
                QingtengHostAsset.qingteng_device_id == device.id,
                QingtengHostAsset.agent_id.in_(agent_ids),
            )
            .all()
        )
        extra = {r.agent_id: r for r in records}
        for host in result["hosts"]:
            rec = extra.get(host.get("agent_id"))
            if rec is None:
                continue
            host["owner"] = rec.charge_name or ""
            host["location"] = rec.host_location or ""
            host["os_type"] = rec.os_type or ""
            host["online_status"] = rec.online_status
            host["agent_status"] = rec.agent_status_label or ""
            host["last_online_time"] = rec.last_online_time or ""
            host["host_name"] = host.get("host_name") or rec.hostname or ""
            host["biz_group"] = host.get("biz_group") or rec.biz_group or ""

    return result


@router.get("/qingteng/component-hosts")
def qingteng_component_hosts(
    device_id: int = Query(..., description="青藤设备 ID"),
    keyword: str = Query(..., description="组件关键字，如 redis / nginx / openjdk"),
    port: int | None = Query(None, description="只保留该端口在监听的主机，如 6379"),
    limit: int = Query(20, ge=1, le=200, description="返回主机数上限"),
    refresh: bool = Query(False, description="是否忽略 10 分钟缓存"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """按组件关键字检索青藤主机清单，返回主机、命中证据与组件版本。

    - 覆盖软件应用 / 安装包 / 进程 / 数据库 / 服务 / 监听端口六类清单；
    - 名称经词边界匹配与排除词清洗（redis 不会命中 redisson / redis-cli 等）；
    - 主机上下文补齐已同步的负责人 / 机房 / 在线状态；
    - 结果为「疑似存在该组件」，不等于组件存在漏洞。
    """
    device = (
        db.query(Device)
        .filter(
            Device.id == device_id,
            Device.auth_type == "qingteng",
            Device.enabled.is_(True),
        )
        .first()
    )
    if device is None:
        raise HTTPException(status_code=404, detail="青藤设备不存在或未启用")

    try:
        result = search_components(
            device, keyword, port=port, limit=limit, force_refresh=refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "青藤组件检索失败 device=%s(%d) keyword=%s err=%s",
            device.name, device.id, keyword, exc,
        )
        raise HTTPException(status_code=502, detail=f"青藤组件检索失败: {exc}")

    agent_ids = [h.get("agent_id") for h in result.get("hosts", []) if h.get("agent_id")]
    if agent_ids:
        records = (
            db.query(QingtengHostAsset)
            .filter(
                QingtengHostAsset.qingteng_device_id == device.id,
                QingtengHostAsset.agent_id.in_(agent_ids),
            )
            .all()
        )
        extra = {r.agent_id: r for r in records}
        for host in result["hosts"]:
            rec = extra.get(host.get("agent_id"))
            if rec is None:
                continue
            host["owner"] = rec.charge_name or ""
            host["location"] = rec.host_location or ""
            host["os_type"] = rec.os_type or ""
            host["online_status"] = rec.online_status
            host["agent_status"] = rec.agent_status_label or ""
            host["last_online_time"] = rec.last_online_time or ""
            host["host_name"] = host.get("host_name") or rec.hostname or ""
            host["biz_group"] = host.get("biz_group") or rec.biz_group or ""

    return result


# ============================================================================
# 奇安信天擎终端同步
# ============================================================================

class TianqingSyncRequest(BaseModel):
    """天擎终端同步请求：不传 device_ids 同步全部已启用的天擎设备。"""

    device_ids: list[int] = Field(default_factory=list, description="天擎设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")


@router.post("/tianqing/sync")
def sync_tianqing_endpoints(
    payload: TianqingSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """手动触发天擎终端同步：逐台登录 ODP，分页拉取全网终端入库。

    - 凭据复用设备管理（auth_type=tianqing 的 api_url/AppKey/AppSecret）；
    - oid/asset_id 通过 ODP ``/license_component/v1/get/asset`` 自动获取；
    - 单台失败不阻断其它设备，逐台返回结果。
    """
    devices = get_tianqing_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"天擎设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的天擎设备：请先在「设备管理」新建设备（认证方式选择「奇安信天擎」），"
                   "配置 grpc-web 地址与 AppKey/AppSecret 后启用",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    results = []
    for dev in devices:
        try:
            res = sync_device_endpoints(db, dev, user_id=user.id, mode=import_mode)
            results.append({"success": True, **res})
        except Exception as exc:  # noqa: BLE001
            logger.warning("天擎同步失败: device=%s(%d) err=%s", dev.name, dev.id, exc)
            results.append({
                "success": False,
                "device_id": dev.id,
                "device_name": dev.name,
                "import_mode": import_mode,
                "error": str(exc),
            })

    ok_count = sum(1 for r in results if r.get("success"))
    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"tianqing {import_mode} devices={len(devices)} ok={ok_count} "
                f"failed={len(results) - ok_count}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success" if ok_count == len(results) else "partial",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "success": ok_count == len(results),
        "mode": import_mode,
        "device_count": len(devices),
        "ok_count": ok_count,
        "results": results,
    }


# ============================================================================
# 奇安信天擎组件（终端软件）异步同步
# ============================================================================

class TianqingSoftwareSyncRequest(BaseModel):
    """天擎组件同步请求：不传 device_ids 同步全部已启用的天擎设备。"""

    device_ids: list[int] = Field(default_factory=list, description="天擎设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")
    limit: int = Field(
        0, ge=0, le=100000,
        description="仅同步前 N 台终端（0 = 全部；大于 0 时不做全量删除，供调试）",
    )


@router.post("/tianqing/software-sync", status_code=202)
def sync_tianqing_software_endpoint(
    payload: TianqingSoftwareSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """异步触发天擎组件（终端软件）同步（Celery 任务 + 批次进度轮询）。

    - 终端范围取自已同步的 ``tianqing_endpoints``（未同步终端时返回 400）；
    - 先为每台设备创建 pending 批次，再派发 ``sync_tianqing_software``；
    - 同一设备已有 pending/running 批次时拒绝重复派发；
    - 派发失败（Redis/Celery 未就绪）返回 503 并把批次置为 failed。
    """
    devices = get_tianqing_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"天擎设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的天擎设备：请先在「设备管理」配置并启用天擎设备",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    device_ids = [d.id for d in devices]
    active_types = [f"tianqing_software:{did}" for did in device_ids]
    active_query = db.query(GovCloudImportBatch).filter(
        GovCloudImportBatch.resource_type.in_(active_types),
        GovCloudImportBatch.status.in_(("pending", "running")),
    )
    # 任务上限 6 小时，超过 7 小时仍未完成的批次视为失效（worker 被硬杀/漏改状态）
    stale_before = beijing_now() - timedelta(hours=7)
    stale = active_query.filter(GovCloudImportBatch.created_at < stale_before).all()
    if stale:
        for b in stale:
            b.status = "failed"
            b.phase = "超时"
            b.percent = 100
            b.note = "同步任务超过 7 小时未完成，已标记失败"
        db.commit()
    active = active_query.filter(GovCloudImportBatch.created_at >= stale_before).all()
    if active:
        busy_ids = {
            int(b.resource_type.split(":", 1)[-1])
            for b in active
            if b.resource_type.split(":", 1)[-1].isdigit()
        }
        name_by_id = {d.id: d.name for d in devices}
        names = "、".join(name_by_id.get(i, str(i)) for i in sorted(busy_ids))
        raise HTTPException(
            status_code=409,
            detail=f"设备 {names} 已有组件同步任务在运行，请等待完成后再试",
        )

    now = beijing_now()
    batches: list[tuple[Device, GovCloudImportBatch]] = []
    for dev in devices:
        batch = GovCloudImportBatch(
            resource_type=f"tianqing_software:{dev.id}",
            filename=f"API同步组件:{dev.name}"[:300],
            file_size=0,
            excel_rows=0,
            unique_source_ids=0,
            inserted=0,
            updated=0,
            deleted=0,
            skipped=0,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            status="pending",
            phase="等待执行",
            percent=0,
            stats={},
            note="",
            created_by=user.id,
            created_at=now,
        )
        db.add(batch)
        db.flush()
        batches.append((dev, batch))
    db.commit()

    task_id = ""
    try:
        task = sync_tianqing_software.delay(
            device_ids, user.id, import_mode, payload.limit,
        )
        task_id = str(getattr(task, "id", "") or "")
        for _dev, batch in batches:
            batch.stats = {**(batch.stats or {}), "task_id": task_id}
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("天擎组件同步任务派发失败: %s", exc)
        for _dev, batch in batches:
            batch.status = "failed"
            batch.phase = "派发失败"
            batch.percent = 100
            batch.note = f"异步任务派发失败（Redis/Celery 未就绪）: {exc}"[:2000]
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="组件同步任务派发失败，请确认后台任务服务（Celery worker）已启动",
        )

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"tianqing software {import_mode} devices={device_ids} "
                f"limit={payload.limit} task={task_id}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "mode": import_mode,
        "limit": payload.limit,
        "task_id": task_id,
        "batches": [
            {
                "device_id": dev.id,
                "device_name": dev.name,
                "batch_id": batch.id,
                "status": batch.status,
            }
            for dev, batch in batches
        ],
    }


@router.get("/tianqing/software-sync/status")
def tianqing_software_sync_status(
    batch_id: int | None = Query(None, description="批次 ID"),
    device_id: int | None = Query(None, description="天擎设备 ID（取最近批次）"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """查询天擎组件同步批次进度（前端轮询）。"""
    if batch_id is None and device_id is None:
        raise HTTPException(status_code=400, detail="batch_id 与 device_id 至少传一个")
    query = db.query(GovCloudImportBatch)
    if batch_id is not None:
        batch = query.filter(GovCloudImportBatch.id == batch_id).first()
    else:
        batch = (
            query.filter(GovCloudImportBatch.resource_type == f"tianqing_software:{device_id}")
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
    if batch is None or not (batch.resource_type or "").startswith("tianqing_software:"):
        raise HTTPException(status_code=404, detail="同步批次不存在")
    return batch.to_dict()


# ============================================================================
# 奇安信椒图云锁资产异步同步（主机清单 + 资产明细）
# ============================================================================

class JiaotuSyncRequest(BaseModel):
    """椒图资产同步请求：不传 device_ids 同步全部已启用的椒图设备。"""

    device_ids: list[int] = Field(default_factory=list, description="椒图设备 ID 列表（空 = 全部）")
    mode: str = Field("full", description="full 全量对齐 / incremental 增量 upsert 不删除")
    limit: int = Field(
        0, ge=0, le=100000,
        description="仅同步前 N 台主机（0 = 全部；大于 0 时不做全量删除，供调试）",
    )


@router.post("/jiaotu/sync", status_code=202)
def sync_jiaotu_assets_endpoint(
    payload: JiaotuSyncRequest,
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "edit")),
) -> dict:
    """异步触发椒图主机与资产明细同步（Celery 任务 + 批次进度轮询）。

    - 每台设备创建两个 pending 批次：``jiaotu_host:<ID>`` / ``jiaotu_asset:<ID>``；
    - 同一设备已有 pending/running 批次时拒绝重复派发；
    - 派发失败（Redis/Celery 未就绪）返回 503 并把批次置为 failed。
    """
    devices = get_jiaotu_devices(db)
    if payload.device_ids:
        wanted = set(payload.device_ids)
        devices = [d for d in devices if d.id in wanted]
        missing = wanted - {d.id for d in devices}
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"椒图设备不存在或未启用: {sorted(missing)}，请到「设备管理」检查",
            )
    if not devices:
        raise HTTPException(
            status_code=400,
            detail="没有已启用的椒图设备：请先在「设备管理」配置并启用椒图云锁设备",
        )

    import_mode = payload.mode if payload.mode in ("full", "incremental") else "full"
    device_ids = [d.id for d in devices]
    active_types = [
        f"{base}:{did}" for base in JIAOTU_DEVICE_TYPES for did in device_ids
    ]
    active_query = db.query(GovCloudImportBatch).filter(
        GovCloudImportBatch.resource_type.in_(active_types),
        GovCloudImportBatch.status.in_(("pending", "running")),
    )
    # 任务上限 3 小时，超过 4 小时仍未完成的批次视为失效
    stale_before = beijing_now() - timedelta(hours=4)
    stale = active_query.filter(GovCloudImportBatch.created_at < stale_before).all()
    if stale:
        for b in stale:
            b.status = "failed"
            b.phase = "超时"
            b.percent = 100
            b.note = "同步任务超过 4 小时未完成，已标记失败"
        db.commit()
    active = active_query.filter(GovCloudImportBatch.created_at >= stale_before).all()
    if active:
        busy_ids = {
            int(b.resource_type.split(":", 1)[-1])
            for b in active
            if b.resource_type.split(":", 1)[-1].isdigit()
        }
        name_by_id = {d.id: d.name for d in devices}
        names = "、".join(name_by_id.get(i, str(i)) for i in sorted(busy_ids))
        raise HTTPException(
            status_code=409,
            detail=f"设备 {names} 已有椒图资产同步任务在运行，请等待完成后再试",
        )

    now = beijing_now()
    batches: list[tuple[Device, GovCloudImportBatch, GovCloudImportBatch]] = []
    for dev in devices:
        host_batch = GovCloudImportBatch(
            resource_type=f"jiaotu_host:{dev.id}",
            filename=f"API同步主机:{dev.name}"[:300],
            file_size=0,
            excel_rows=0,
            unique_source_ids=0,
            inserted=0,
            updated=0,
            deleted=0,
            skipped=0,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            status="pending",
            phase="等待执行",
            percent=0,
            stats={},
            note="",
            created_by=user.id,
            created_at=now,
        )
        asset_batch = GovCloudImportBatch(
            resource_type=f"jiaotu_asset:{dev.id}",
            filename=f"API同步资产:{dev.name}"[:300],
            file_size=0,
            excel_rows=0,
            unique_source_ids=0,
            inserted=0,
            updated=0,
            deleted=0,
            skipped=0,
            live_count=0,
            consistent=0,
            import_mode=import_mode,
            status="pending",
            phase="等待执行",
            percent=0,
            stats={},
            note="",
            created_by=user.id,
            created_at=now,
        )
        db.add(host_batch)
        db.add(asset_batch)
        db.flush()
        batches.append((dev, host_batch, asset_batch))
    db.commit()

    task_id = ""
    try:
        task = sync_jiaotu_assets.delay(
            device_ids, user.id, import_mode, payload.limit,
        )
        task_id = str(getattr(task, "id", "") or "")
        for _dev, host_batch, asset_batch in batches:
            for batch in (host_batch, asset_batch):
                batch.stats = {**(batch.stats or {}), "task_id": task_id}
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("椒图资产同步任务派发失败: %s", exc)
        for _dev, host_batch, asset_batch in batches:
            for batch in (host_batch, asset_batch):
                batch.status = "failed"
                batch.phase = "派发失败"
                batch.percent = 100
                batch.note = f"异步任务派发失败（Redis/Celery 未就绪）: {exc}"[:2000]
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="椒图资产同步任务派发失败，请确认后台任务服务（Celery worker）已启动",
        )

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="sync",
            resource_type="asset_discovery",
            detail=(
                f"jiaotu {import_mode} devices={device_ids} "
                f"limit={payload.limit} task={task_id}"
            ),
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("同步审计写入失败（忽略）: %s", exc)

    return {
        "mode": import_mode,
        "limit": payload.limit,
        "task_id": task_id,
        "batches": [
            {
                "device_id": dev.id,
                "device_name": dev.name,
                "host_batch_id": host_batch.id,
                "asset_batch_id": asset_batch.id,
                "status": host_batch.status,
            }
            for dev, host_batch, asset_batch in batches
        ],
    }


@router.get("/jiaotu/sync/status")
def jiaotu_sync_status(
    batch_id: int | None = Query(None, description="批次 ID"),
    device_id: int | None = Query(None, description="椒图设备 ID（取最近批次）"),
    resource_type: str = Query("jiaotu_host", description="jiaotu_host / jiaotu_asset"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("asset_discovery", "view")),  # noqa: ARG001
) -> dict:
    """查询椒图同步批次进度（前端轮询）。"""
    if batch_id is None and device_id is None:
        raise HTTPException(status_code=400, detail="batch_id 与 device_id 至少传一个")
    base = resource_type if resource_type in JIAOTU_DEVICE_TYPES else "jiaotu_host"
    query = db.query(GovCloudImportBatch)
    if batch_id is not None:
        batch = query.filter(GovCloudImportBatch.id == batch_id).first()
    else:
        batch = (
            query.filter(GovCloudImportBatch.resource_type == f"{base}:{device_id}")
            .order_by(GovCloudImportBatch.id.desc())
            .first()
        )
    if batch is None or not (batch.resource_type or "").startswith(tuple(f"{b}:" for b in JIAOTU_DEVICE_TYPES)):
        raise HTTPException(status_code=404, detail="同步批次不存在")
    return batch.to_dict()
