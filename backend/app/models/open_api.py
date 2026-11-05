"""API 开放平台数据模型。

三张表支撑「数据开放网关」：
- ``OpenApiApp``：第三方接入应用（API Key 主体，含密钥哈希/限流配额/IP白名单/过期时间）。
- ``OpenApiScope``：应用被授权可访问的开放资源（可配置数据授权）。
- ``OpenApiCallLog``：每次网关调用的监控日志（状态码/耗时/IP/参数摘要），
  应用被删除后日志保留（app_id nullable + app_name 冗余快照）。
"""
from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.core.timezone import beijing_now
from app.database import Base


class OpenApiApp(Base):
    """开放 API 接入应用。"""

    __tablename__ = "open_api_apps"

    id = Column(Integer, primary_key=True, index=True)
    app_name = Column(String(64), unique=True, nullable=False, comment="应用名称")
    description = Column(String(255), default="", comment="应用描述/用途说明")
    # 公开标识：ak_ + 32位随机hex，请求头 X-API-Key: {access_key}:{secret}
    access_key = Column(String(64), unique=True, index=True, nullable=False)
    # secret 明文的 SHA-256 摘要，明文仅创建/重置时一次性返回，不落库
    secret_hash = Column(String(64), nullable=False)
    # active / disabled
    status = Column(String(16), default="active", index=True)
    # 该应用每分钟最大调用量（Redis 固定窗口限流）
    rate_limit_per_minute = Column(Integer, default=60)
    # IP 白名单 JSON 数组（空数组=不限制）
    allowed_ips = Column(Text, default="[]")
    # 可选过期时间
    expires_at = Column(DateTime, nullable=True)
    # 累计调用数 / 最近调用时间（调用日志中间件异步维护）
    total_calls = Column(Integer, default=0)
    last_call_at = Column(DateTime, nullable=True)
    # 创建管理员 user.id
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self):
        return f"<OpenApiApp id={self.id} name={self.app_name!r} status={self.status!r}>"


class OpenApiScope(Base):
    """应用被授权可访问的开放资源（可配置数据授权）。"""

    __tablename__ = "open_api_scopes"
    __table_args__ = (
        UniqueConstraint("app_id", "resource_code", name="uq_open_api_scope"),
    )

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(
        Integer,
        ForeignKey("open_api_apps.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # 开放资源编码（open_api_registry.OPEN_API_RESOURCES 的 key）
    resource_code = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self):
        return f"<OpenApiScope app_id={self.app_id} resource={self.resource_code!r}>"


class OpenApiCallLog(Base):
    """网关调用监控日志。

    记录所有命中 ``/api/v1/open/`` 的请求（含 401/403/429 拒绝），
    供调用监控看板与调用日志查询使用。应用删除后日志保留。
    """

    __tablename__ = "open_api_call_logs"
    __table_args__ = (
        Index("idx_open_api_call_logs_created", "created_at"),
        Index("idx_open_api_call_logs_app_created", "app_id", "created_at"),
        Index("idx_open_api_call_logs_resource_created", "resource_code", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    # 应用被删除后日志保留 → nullable
    app_id = Column(Integer, nullable=True, index=True)
    # 冗余快照：应用删除后日志仍可读
    app_name = Column(String(64), default="")
    # 资源编码；401（未识别出应用）时可能为空
    resource_code = Column(String(64), nullable=True, index=True)
    method = Column(String(8), default="GET")
    path = Column(String(255), default="")
    # 查询参数 JSON 摘要（不含密钥）
    query_params = Column(Text, default="")
    status_code = Column(Integer, default=0, index=True)
    response_ms = Column(Integer, default=0)
    client_ip = Column(String(64), default="")
    user_agent = Column(String(255), default="")
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self):
        return (
            f"<OpenApiCallLog id={self.id} app={self.app_name!r} "
            f"resource={self.resource_code!r} status={self.status_code}>"
        )
