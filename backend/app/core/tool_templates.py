"""内置工具模板定义。

供 ``/tools/templates`` 接口返回（供新建参考）与启动时种子数据（``app/main.py``）共用。
每个模板的 ``code`` 复用 ``app.tools.context_tools`` 与 ``app.devices.firewall`` 的 mock 实现，
通过 import 调用既有异步函数，保证模板工具与运行时工具行为一致。

约定：``code`` 内必须定义 ``async def run(**kwargs)``，返回任意可 JSON 序列化结果。
"""
from typing import Any

# 通用 IP 参数 schema
_IP_PARAM: list[dict[str, Any]] = [
    {"name": "ip", "type": "String", "required": True, "description": "待查询的 IP 地址，例如 8.8.8.8"}
]

# 内置工具模板清单（顺序固定，便于展示）
TOOL_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "check_whitelist",
        "description": "查询 IP 是否命中内网白名单（可信内网网段），返回布尔值。",
        "parameters_schema": _IP_PARAM,
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import check_whitelist\n"
            "    ip = kwargs.get('ip', '')\n"
            "    return await check_whitelist(ip)\n"
        ),
    },
    {
        "name": "get_asset_info",
        "description": "查询 IP 对应的资产归属信息，包括部门、负责人、是否为关键资产。",
        "parameters_schema": _IP_PARAM,
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import get_asset_info\n"
            "    ip = kwargs.get('ip', '')\n"
            "    return await get_asset_info(ip)\n"
        ),
    },
    {
        "name": "get_threat_intel",
        "description": "查询 IP 的威胁情报，返回是否恶意、标签、置信度。",
        "parameters_schema": _IP_PARAM,
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import get_threat_intel\n"
            "    ip = kwargs.get('ip', '')\n"
            "    return await get_threat_intel(ip)\n"
        ),
    },
    {
        "name": "check_subnet",
        "description": "查询 IP 所在 /24 子网信息，包括网段与网关。",
        "parameters_schema": _IP_PARAM,
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import check_subnet\n"
            "    ip = kwargs.get('ip', '')\n"
            "    return await check_subnet(ip)\n"
        ),
    },
    {
        "name": "list_documents",
        "description": "列出智能体可读取的已上传文档（未分段原文，来自对话中上传的文件）。先调用此工具获取 file_id，再用 read_document 读取内容。",
        "parameters_schema": [],
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import list_documents\n"
            "    return await list_documents()\n"
        ),
    },
    {
        "name": "read_document",
        "description": "读取一个已上传文档的未分段原文（整篇纯文本）。与知识库分段检索互补：本工具返回整篇文件内容，适合通读完整文档（如查阅完整 IP 地址表、整份报告）。file_id 可通过 list_documents 获取。",
        "parameters_schema": [
            {"name": "file_id", "type": "Integer", "required": True, "description": "要读取的文档 ID（通过 list_documents 获取）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    from app.tools.context_tools import read_document\n"
            "    file_id = kwargs.get('file_id')\n"
            "    return await read_document(file_id)\n"
        ),
    },
]


def get_template_by_name(name: str) -> dict[str, Any] | None:
    """按名称查找内置模板。"""
    for tpl in TOOL_TEMPLATES:
        if tpl["name"] == name:
            return tpl
    return None
