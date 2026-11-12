"""Device 安全设备模型。

存储安全设备（防火墙/WAF/IPS/EDR等）的连接信息，
每个设备可配置多个动作（DeviceAction），供工作流中的设备动作节点调用。

v2 增强：
- Device 新增连接状态、心跳时间、标签、认证方式、超时/重试/TLS 校验等
- DeviceAction 新增动作分类、风险等级、版本号、调用统计字段
- 新增 DeviceCallLog 记录每次动作调用的完整日志
"""
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, func

from app.database import Base


class Device(Base):
    """安全设备模型。"""
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False, comment="设备名称")
    type = Column(String(64), nullable=False, default="firewall", comment="设备类型: firewall/waf/ips/ids/edr/soar/custom")
    vendor = Column(String(128), nullable=False, default="", comment="厂商: 如 深信服/绿盟/天融信/paloalto/fortinet")
    version = Column(String(64), nullable=False, default="", comment="设备版本（固件/软件版本号）")
    ip_address = Column(String(64), nullable=False, default="", comment="设备 IP 地址（管理地址，可选）")
    api_url = Column(String(512), nullable=False, default="", comment="设备 API 基地址，如 https://203.0.113.1:8443/api")
    api_key = Column(String(512), nullable=False, default="", comment="API Key 或 Token")
    username = Column(String(128), nullable=False, default="", comment="用户名（Basic Auth 时用）")
    password = Column(String(256), nullable=False, default="", comment="密码（Basic Auth 时用）")
    enabled = Column(Boolean, nullable=False, default=True, comment="是否启用")
    description = Column(String(512), nullable=False, default="", comment="设备描述")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # v2: 连接状态与健康检查
    # online / offline / abnormal / unconfigured / disabled
    status = Column(String(32), nullable=False, default="unconfigured", comment="连接状态")
    last_heartbeat = Column(DateTime, nullable=True, comment="最近一次心跳/测试时间")
    last_test_error = Column(Text, nullable=True, comment="最近一次连接失败原因")
    last_test_latency_ms = Column(Integer, nullable=True, comment="最近一次连接延迟(ms)")
    # v2: 多标签（JSON 数组，如 ["核心", "生产环境"]）
    tags = Column(Text, nullable=False, default="[]", comment="标签 JSON 数组")
    # v2: 认证方式（统一字段，与 api_key/username/password 配合使用）
    # none / api_key / basic / bearer / oauth2 / mtls
    auth_type = Column(String(32), nullable=False, default="api_key", comment="认证方式")
    # v2: 连接参数
    timeout = Column(Integer, nullable=True, comment="请求超时(秒)")
    max_retries = Column(Integer, nullable=True, comment="最大重试次数")
    verify_tls = Column(Boolean, nullable=False, default=False, comment="是否校验 TLS 证书")
    # v2: 厂商 Logo 图标（emoji 或标识）
    icon = Column(String(32), nullable=False, default="", comment="设备图标")
    # v3: 设备级解析策略绑定（parse_strategies.id）；NULL=按日志内容路由/渠道指定，
    # 该设备所有接收渠道（未手动指定策略的）默认用此策略的多规则解析。
    parser_strategy_id = Column(Integer, nullable=True, comment="设备级解析策略 ID（NULL=自动）")

    def __repr__(self):
        return f"<Device id={self.id} name={self.name!r} type={self.type!r}>"


class DeviceAction(Base):
    """设备动作模型。每个动作对应一个 API 调用。"""
    __tablename__ = "device_actions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    device_id = Column(Integer, nullable=False, index=True, comment="所属设备 ID")
    name = Column(String(128), nullable=False, comment="动作名称，如 封禁IP")
    action_type = Column(String(64), nullable=False, default="custom", comment="动作类型: block_ip/unblock_ip/quarantine_host/isolate_endpoint/add_ioc/delete_ioc/custom")
    http_method = Column(String(16), nullable=False, default="POST", comment="HTTP 方法: GET/POST/PUT/DELETE/PATCH")
    api_path = Column(String(512), nullable=False, default="", comment="API 路径（拼在 api_url 后），如 /block/ip")
    # 参数 schema: JSON 数组 [{name, type, required, default, description, placeholder}]
    params_schema = Column(String(4096), nullable=False, default="[]", comment="参数定义 JSON")
    # 额外请求头: JSON 对象 {"X-Custom-Header": "value"}
    headers = Column(String(2048), nullable=False, default="{}", comment="额外请求头 JSON")
    # 请求体模板（含变量占位符 {{param_name}}），留空则用 params 自动构造 JSON
    body_template = Column(String(4096), nullable=False, default="", comment="请求体模板")
    auth_type = Column(String(32), nullable=False, default="api_key", comment="认证方式: api_key/basic/bearer/none")
    enabled = Column(Boolean, nullable=False, default=True, comment="是否启用")
    description = Column(String(2000), nullable=False, default="", comment="动作描述（含接口口径/参数说明，可超 512 字符）")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # v2: 动作分类
    # block(阻断类) / query(查询类) / dispose(处置类) / notify(通知类) / other
    category = Column(String(32), nullable=False, default="other", comment="动作分类")
    # v2: 风险等级 readonly / high_risk
    risk_level = Column(String(32), nullable=False, default="readonly", comment="风险等级")
    # v2: 版本管理
    version = Column(Integer, nullable=False, default=1, comment="动作版本号")
    # v2: 调用统计
    last_call_at = Column(DateTime, nullable=True, comment="最近一次调用时间")
    call_count_24h = Column(Integer, nullable=False, default=0, comment="最近24小时调用次数")
    success_count_24h = Column(Integer, nullable=False, default=0, comment="最近24小时成功次数")
    avg_latency_ms = Column(Integer, nullable=True, comment="平均响应延迟(ms)")
    # v2: 示例数据
    example_payload = Column(Text, nullable=True, comment="示例请求体")
    example_response = Column(Text, nullable=True, comment="示例响应体")

    def __repr__(self):
        return f"<DeviceAction id={self.id} device_id={self.device_id} name={self.name!r}>"


class DeviceCallLog(Base):
    """设备动作调用日志：记录每次设备动作执行的完整信息。"""
    __tablename__ = "device_call_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    device_id = Column(Integer, nullable=True, index=True, comment="设备 ID")
    device_name = Column(String(255), nullable=False, default="", comment="设备名称(冗余)")
    action_id = Column(Integer, nullable=True, index=True, comment="动作 ID")
    action_name = Column(String(128), nullable=False, default="", comment="动作名称(冗余)")
    # 来源：manual_test / workflow / agent / api
    source = Column(String(64), nullable=False, default="manual_test", comment="调用来源")
    # 关联的工作流/智能体
    workflow_id = Column(Integer, nullable=True, comment="关联工作流 ID")
    agent_id = Column(Integer, nullable=True, comment="关联智能体 ID")
    # 请求/响应摘要
    request_summary = Column(Text, nullable=True, comment="请求参数摘要")
    response_summary = Column(Text, nullable=True, comment="响应摘要")
    # 结果
    status = Column(String(32), nullable=False, default="success", index=True, comment="success/failed")
    status_code = Column(Integer, nullable=True, comment="HTTP 状态码")
    latency_ms = Column(Integer, nullable=True, comment="耗时(ms)")
    error_message = Column(Text, nullable=True, comment="错误信息")
    # 调用者
    user_id = Column(Integer, nullable=True, comment="调用者用户 ID")
    source_ip = Column(String(64), nullable=True, comment="来源 IP")
    created_at = Column(DateTime, server_default=func.now(), index=True, comment="调用时间")

    def __repr__(self):
        return f"<DeviceCallLog id={self.id} device={self.device_name!r} action={self.action_name!r} status={self.status!r}>"
