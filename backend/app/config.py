"""应用配置模块。

使用 pydantic-settings 从环境变量与 ``.env`` 文件加载配置，
便于在不同环境（开发 / 测试 / 生产）间切换。
"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend 目录绝对路径，用于稳定定位 .env 文件
BASE_DIR: Path = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """应用配置项。

    所有字段均提供开发环境默认值，可被同名环境变量或 ``.env`` 文件覆盖。
    """

    DATABASE_URL: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/soar"
    # 拆分的数据库连接参数（供 pg_dump / psql 等命令行工具使用）
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "postgres"
    DB_HOST: str = "localhost"
    DB_PORT: int = 5432
    DB_NAME: str = "soar"
    # 连接池参数：backend 用默认值（大池）；worker/beat 通过环境变量调小，
    # 避免多进程叠加后超出 Postgres max_connections
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 40
    DB_LINKAGE_POOL_SIZE: int = 10
    DB_LINKAGE_MAX_OVERFLOW: int = 20
    # 封禁触发：并行消费线程数（进程内）；联动在途全局上限见 WORKFLOW_INFLIGHT_LIMIT
    # 在途上限 0 表示不限制（低频封禁场景推荐，避免「实例建了却不跑完封禁」）
    WORKFLOW_TRIGGER_CONCURRENCY: int = 2
    WORKFLOW_INFLIGHT_LIMIT: int = 0
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/0"
    # 大屏/监控聚合：Redis 快照 + Beat 刷新，降低主池只读压力
    DASHBOARD_CACHE_ENABLED: bool = True
    DASHBOARD_CACHE_TTL_SEC: int = 60
    # 资产清单匹配索引：Redis 版本号 + 快照，减少多 worker 各自全表 SELECT
    ASSET_INDEX_REDIS_ENABLED: bool = True

    # Anthropic API Key：留空表示未配置，Agent 决策将走 Mock 降级路径
    ANTHROPIC_API_KEY: str = ""

    # ===== 鉴权与安全配置 =====
    # 运行环境标识：dev 跳过安全基线校验（仅日志警告）；production 强校验，
    # 使用默认 JWT_SECRET/管理员口令将拒绝启动。生产部署必须在 .env 中显式设置。
    APP_ENV: str = "dev"
    # JWT 签名密钥；生产环境必须通过 .env 注入强随机值（>=32 字节）
    JWT_SECRET: str = "soar-dev-secret-change-me-in-production-please"
    # JWT 访问令牌有效期（分钟）
    JWT_EXPIRE_MINUTES: int = 1440
    # JWT 算法
    JWT_ALGORITHM: str = "HS256"
    # 初始管理员账号（首次启动 seed 时创建）
    SEED_ADMIN_USERNAME: str = "admin"
    SEED_ADMIN_PASSWORD: str = "admin123"
    # CORS 允许的源；逗号分隔。默认仅允许本地前端
    CORS_ORIGINS: str = "http://localhost:8080,http://localhost:5173,http://127.0.0.1:8080"
    # Webhook 请求体最大字节数（默认 1MB）
    WEBHOOK_MAX_BODY_BYTES: int = 1024 * 1024
    # Webhook 限流：每个 workflow 每分钟最大请求数
    WEBHOOK_RATE_LIMIT_PER_MINUTE: int = 30
    # 开发调试开关：OTP 登录验证码是否明文回显在响应中（dev_code）。
    # 生产必须保持 false。未配置 SMTP 且此开关为 false 时，
    # /auth/otp/send 返回 503 业务错误且响应中绝不含验证码。
    ENABLE_DEV_CODE: bool = False

    BAN_ANALYST_AGENT_ID: int = 0
    WORKFLOW_SYSTEM_USER_ID: int = 0
    WORKFLOW_SOC_AGENT_ID: int = 0

    # ===== XDR 开放性 OpenAPI（联动码签名调用）=====
    # XDR 平台地址，建议带协议（https://host[:port]）；不带协议时默认 https
    XDR_OPENAPI_HOST: str = ""
    # 联动码（等同访问凭证），仅允许通过部署环境变量注入，禁止入库/入提示词/入日志
    XDR_OPENAPI_AUTH_CODE: str = ""
    # 单次请求超时（秒）；须小于 Hermes 工具总超时 30s
    XDR_OPENAPI_TIMEOUT: float = 20.0
    # 默认校验 TLS 证书；自签证书环境需显式设为 false
    XDR_OPENAPI_VERIFY_SSL: bool = True
    # 是否允许非查询类方法（PUT/PATCH/DELETE），默认禁止
    XDR_OPENAPI_ALLOW_WRITE: bool = False
    # XDR 接口文档目录（search_xdr_api_docs / query_xdr_api_doc 工具读取）
    XDR_DOCS_DIR: str = str(BASE_DIR / "app" / "data" / "xdr_skill_reference")

    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


# 全局配置单例
settings: Settings = Settings()
