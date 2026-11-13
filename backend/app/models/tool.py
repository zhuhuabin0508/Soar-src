"""Tool 数据模型。

支持两种工具类型：
- ``code``：用户可编辑的 Python 工具代码，约定定义 ``async def run(**kwargs)``，
  由 ``app/core/tool_runner.py`` 编译加载并在沙箱中执行。
- ``http``：声明式 HTTP 接口工具，配置存于 ``http_config``（method/url/headers/body/
  鉴权/超时重试/响应解析），由 ``app/core/tool_http_runner.py`` 直接发起 httpx 请求，
  无需编写代码。适合接入外部 RESTful API。

``parameters_schema`` 描述入参结构，供前端表单与 Agent 工具绑定使用。
HTTP 工具的参数 schema 元素额外支持 ``location``(query/body/header/path)、
``default``、``enum`` 字段，用于参数映射与提取。
"""
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON

from app.database import Base


class Tool(Base):
    """可编辑工具模型。"""

    __tablename__ = "tools"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    # 参数 schema：[{name, type, required, description, location, default, enum}]
    # - code 工具：name/type/required/description
    # - http 工具：额外 location(query/body/header/path)、default、enum
    parameters_schema = Column(JSON, nullable=True)
    code = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    # 工具类型：'code'（Python 代码）| 'http'（声明式 HTTP 接口）| 'framework'（框架内置）
    tool_type = Column(String(32), nullable=False, default="code")
    # 工具集分类：file_operations / security / cron_jobs / memory / computer_use /
    # clarifying_question / task_planning / task_delegation 等，用于前端分组展示
    category = Column(String(64), nullable=True)
    # 多标签：JSON 数组，如 ["安全运营", "网络资产"]，支持自定义标签
    tags = Column(JSON, nullable=True)
    # HTTP 工具配置（仅 tool_type=='http' 使用）：
    # {method, url, headers:[{key,value}], body_type(json/form/xml/none),
    #  body_content(支持 {{param}} 占位符，渲染为嵌套 JSON body),
    #  auth_type(none/bearer/api_key/oauth2/x360_signature), auth_config,
    #  timeout, retry, response_jsonpath, error_handling}
    # x360_signature 为 360 网关统一签名（360 情报 API 通用）：
    #  auth_config={apikey, salt}，每次请求动态计算 X-360-Signature 头
    http_config = Column(JSON, nullable=True)
    # 创建者用户ID（资源级 owner 权限控制），null 表示历史数据/系统创建
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    # 是否为系统内置工具（种子数据）：内置工具不可硬删除，只能禁用，
    # 防止容器重启后种子逻辑重新插入已被用户删除的工具。
    is_preset = Column(Boolean, default=False, nullable=False, server_default="false")
    # 工具来源：builtin | framework | security | custom
    tool_source = Column(String(32), nullable=True)

    def __repr__(self) -> str:
        return f"<Tool id={self.id} name={self.name!r} type={self.tool_type!r} enabled={self.enabled}>"
