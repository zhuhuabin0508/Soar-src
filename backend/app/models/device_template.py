"""内置设备模板库模型。

DeviceTemplate 保存固化的设备基础信息（名称/厂商/类型/协议版本等），
DeviceTemplateAction 保存该设备下固化的动作定义（参数、请求方式/路径、
请求头、请求体模板等）。模板与源设备完全解耦，模板上的修改不影响源设备。
"""
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, func

from app.database import Base


class DeviceTemplate(Base):
    """内置设备模板条目。"""

    __tablename__ = "device_builtin_templates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # 系统内置模板的稳定标识（手动新增/设备快照条目为 NULL，避免唯一冲突）
    code = Column(String(64), nullable=True, unique=True, comment="内置模板唯一标识")
    name = Column(String(255), nullable=False, comment="模板名称（内置条目名称固定）")
    type = Column(String(64), nullable=False, default="custom", comment="设备类型")
    vendor = Column(String(128), nullable=False, default="", comment="设备厂商")
    version = Column(String(64), nullable=False, default="", comment="对接协议/固件版本")
    description = Column(String(512), nullable=False, default="", comment="模板描述")
    api_url = Column(String(512), nullable=False, default="", comment="默认 API 基地址")
    auth_type = Column(String(32), nullable=False, default="api_key", comment="认证方式")
    icon = Column(String(32), nullable=False, default="", comment="设备图标")
    tags = Column(Text, nullable=False, default="[]", comment="标签 JSON 数组")
    timeout = Column(Integer, nullable=True, comment="默认请求超时(秒)")
    max_retries = Column(Integer, nullable=True, comment="默认最大重试次数")
    verify_tls = Column(Boolean, nullable=False, default=False, comment="默认是否校验 TLS")
    # 来源：builtin（系统预置）/ device（从现有设备识别入库）/ manual（页面手动新增）
    source = Column(String(32), nullable=False, default="manual", comment="模板来源")
    source_device_id = Column(Integer, nullable=True, comment="快照来源设备 ID")
    source_device_name = Column(String(255), nullable=False, default="", comment="快照来源设备名称")
    created_by = Column(String(128), nullable=False, default="", comment="创建者用户名")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self) -> str:
        return f"<DeviceTemplate id={self.id} name={self.name!r}>"


class DeviceTemplateAction(Base):
    """内置设备模板下的固化动作定义。"""

    __tablename__ = "device_builtin_template_actions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    template_id = Column(Integer, nullable=False, index=True, comment="所属模板 ID")
    name = Column(String(128), nullable=False, comment="动作名称")
    action_type = Column(String(64), nullable=False, default="custom", comment="动作类型")
    http_method = Column(String(16), nullable=False, default="POST", comment="HTTP 方法")
    api_path = Column(String(512), nullable=False, default="", comment="API 路径")
    params_schema = Column(String(4096), nullable=False, default="[]", comment="参数定义 JSON")
    headers = Column(String(2048), nullable=False, default="{}", comment="额外请求头 JSON")
    body_template = Column(String(4096), nullable=False, default="", comment="请求体模板")
    auth_type = Column(String(32), nullable=False, default="api_key", comment="认证方式")
    enabled = Column(Boolean, nullable=False, default=True, comment="是否启用")
    description = Column(String(2000), nullable=False, default="", comment="动作描述（含接口口径/参数说明，可超 512 字符）")
    category = Column(String(32), nullable=False, default="other", comment="动作分类")
    risk_level = Column(String(32), nullable=False, default="readonly", comment="风险等级")
    version = Column(Integer, nullable=False, default=1, comment="动作版本号")
    example_payload = Column(Text, nullable=True, comment="示例请求体")
    example_response = Column(Text, nullable=True, comment="示例响应体")
    sort_order = Column(Integer, nullable=False, default=0, comment="展示顺序")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self) -> str:
        return f"<DeviceTemplateAction id={self.id} template_id={self.template_id} name={self.name!r}>"
