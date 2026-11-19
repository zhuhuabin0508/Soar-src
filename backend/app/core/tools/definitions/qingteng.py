from typing import Any

from app.core.tools.types import TOOL_SOURCE_SECURITY


def _qingteng_tool(
    name: str,
    description: str,
    params: list[dict[str, Any]],
    category: str = "security",
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """构造青藤工具种子定义：code 直接透传注入的封装函数（无 import，过沙箱）。"""
    return {
        "name": name,
        "description": description,
        "parameters_schema": params,
        "code": (
            "async def run(**kwargs):\n"
            f"    return await {name}(**kwargs)\n"
        ),
        "tool_type": "code",
        "category": category,
        "tags": tags or [],
        "enabled": True,
        "is_preset": True,
        "tool_source": TOOL_SOURCE_SECURITY,
    }


QINGTENG_TOOLS: list[dict[str, Any]] = [
    _qingteng_tool(
        "qingteng_login",
        "青藤云：登录指定设备并返回认证信息（signKey/jwt/comId）。device ∈ gongwuyun/baremetal/apptjd。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
        ],
        "security",
        ["青藤", "认证", "qingteng"],
    ),
    _qingteng_tool(
        "qingteng_query",
        "青藤云：通用签名请求。method∈GET/POST，path 为 /external/api/... 路径，params 为查询参数，body 为 POST 体。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "path", "type": "String", "required": True, "description": "API 路径，如 /external/api/assets/host/linux"},
            {"name": "params", "type": "Object", "required": False, "description": "查询参数 key-value"},
            {"name": "method", "type": "String", "required": False, "description": "GET 或 POST，默认 GET", "default": "GET"},
            {"name": "body", "type": "Object", "required": False, "description": "POST 请求体"},
        ],
        "security",
        ["青藤", "通用", "qingteng"],
    ),
    _qingteng_tool(
        "qingteng_post",
        "青藤云：通用签名 POST 请求。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "path", "type": "String", "required": True, "description": "API 路径"},
            {"name": "body", "type": "Object", "required": False, "description": "POST 请求体"},
        ],
        "security",
        ["青藤", "通用", "qingteng"],
    ),
    _qingteng_tool(
        "qingteng_assets",
        "青藤云：资产查询。resource∈host/container/vm；os_type∈linux/windows；filters 为额外筛选。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "resource", "type": "String", "required": False, "description": "host/container/vm，默认 host", "default": "host"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选 key-value（如 business 业务组）"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "资产", "qingteng_assets"],
    ),
    _qingteng_tool(
        "qingteng_detect",
        "青藤云：入侵检测查询（进程/弱口令/webshell 等）。resource 为检测子路径，param.action 为动作。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "resource", "type": "String", "required": True, "description": "检测子路径，如 process/weakpwd/webshell"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows"},
            {"name": "param", "type": "Object", "required": False, "description": "附加参数（含 action/extra）"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "入侵检测", "qingteng_detect"],
    ),
    _qingteng_tool(
        "qingteng_risk",
        "青藤云：风险查询（弱口令/漏洞/补丁/弱文件/PoC）。action∈weakpwd_list/risk_list/patch_list/weakfile_list/poc_list。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "action", "type": "String", "required": False, "description": "weakpwd_list/risk_list/patch_list/weakfile_list/poc_list，默认 weakpwd_list", "default": "weakpwd_list"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows，默认 linux", "default": "linux"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选（如 risk_type）"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "风险", "qingteng_risk"],
    ),
    _qingteng_tool(
        "qingteng_vul_check",
        "青藤云：漏洞核查查询。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows，默认 linux", "default": "linux"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "漏洞", "qingteng_vul_check"],
    ),
    _qingteng_tool(
        "qingteng_baseline",
        "青藤云：基线核查查询。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows，默认 linux", "default": "linux"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "基线", "qingteng_baseline"],
    ),
    _qingteng_tool(
        "qingteng_system_audit",
        "青藤云：系统审核日志查询。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows，默认 linux", "default": "linux"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "系统审计", "qingteng_system_audit"],
    ),
    _qingteng_tool(
        "qingteng_microseg",
        "青藤云：微隔离策略查询。action 为动作（默认 list）。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "action", "type": "String", "required": False, "description": "动作，默认 list", "default": "list"},
            {"name": "filters", "type": "Object", "required": False, "description": "额外筛选"},
            {"name": "page", "type": "Integer", "required": False, "description": "页码，默认 0", "default": 0},
            {"name": "size", "type": "Integer", "required": False, "description": "每页条数，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "微隔离", "qingteng_microseg"],
    ),
    _qingteng_tool(
        "qingteng_export_all",
        "青藤云：批量导出资产（分页拉全量）。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "resource", "type": "String", "required": False, "description": "host/container/vm，默认 host", "default": "host"},
            {"name": "os_type", "type": "String", "required": False, "description": "linux/windows"},
            {"name": "page_size", "type": "Integer", "required": False, "description": "每页条数，默认 500", "default": 500},
        ],
        "security",
        ["青藤", "导出", "qingteng_export_all"],
    ),
    _qingteng_tool(
        "qingteng_search_component",
        "青藤云：按组件关键字（如 redis）检索主机清单，返回主机、命中证据（应用/安装包/进程/数据库/服务/端口）与版本；"
        "已做词边界与排除词清洗，不命中 redisson/redis-cli 等干扰项。结果为疑似存在该组件，不代表存在漏洞。",
        [
            {"name": "device", "type": "String", "required": False, "description": "设备标识，默认 gongwuyun", "default": "gongwuyun"},
            {"name": "keyword", "type": "String", "required": True, "description": "组件关键字，如 redis / nginx / openjdk"},
            {"name": "port", "type": "Integer", "required": False, "description": "只保留该端口在监听的主机，如 6379"},
            {"name": "limit", "type": "Integer", "required": False, "description": "返回主机数上限，默认 20", "default": 20},
        ],
        "security",
        ["青藤", "组件检索", "资产", "qingteng_search_component"],
    ),
]
