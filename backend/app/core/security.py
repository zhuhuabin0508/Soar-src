"""安全模块：密码哈希、JWT 签发/校验、API Key 生成、轻量数据库迁移。

设计要点：
- 密码使用 passlib + bcrypt 哈希，永不存明文。
- JWT 使用 PyJWT（HS256），承载 user_id / username / role。
- Webhook secret 使用 secrets.token_hex 生成 32 字节十六进制串。
- 轻量迁移：由于未引入 Alembic（P1-5 待办），此处提供 ``ensure_columns``
  在启动时检查并 ALTER ADD 缺失列，保证新增字段在老库上可用。
- 工作流环境变量使用 XOR + base64 轻量对称加密（基于 JWT_SECRET 派生 key），
  避免明文落库；读取需经授权接口解密。
"""
import base64
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlsplit

import jwt
from passlib.context import CryptContext
from sqlalchemy import inspect, text

from app.config import settings

logger = logging.getLogger(__name__)

# passlib 上下文：bcrypt 哈希（自动处理 salt 与版本）
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ============ 密码哈希 ============

def hash_password(plain: str) -> str:
    """对明文密码做 bcrypt 哈希。"""
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """校验明文密码与哈希是否匹配。"""
    try:
        return _pwd_context.verify(plain, hashed)
    except Exception as exc:  # noqa: BLE001
        logger.warning("密码校验异常: %s", exc)
        return False


# ============ JWT ============

def create_access_token(
    user_id: int,
    username: str,
    role: str,
    session_id: Optional[str] = None,
    expires_minutes: Optional[int] = None,
) -> tuple[str, str, str]:
    """签发 JWT 访问令牌。

    payload 包含 ``sub``（user_id）、``username``、``role``、``jti``（唯一标识）、
    ``sid``（会话 ID）、``exp``、``iat``。

    会话管理设计：
    - ``jti`` 每次签发都不同，用于精确标识和吊销单个 token（登出/刷新时拉黑）。
    - ``sid`` 在同一会话刷新时保持不变，用于会话连续性追踪与「登录设备管理」。
    - 登录时 sid 默认 = jti（新会话）；刷新时传入旧 sid 保持会话连续性。

    Args:
        user_id: 用户 ID。
        username: 用户名。
        role: 角色名。
        session_id: 会话 ID（刷新时传入旧 sid；登录时不传则自动生成）。
        expires_minutes: 有效期（分钟），默认用 ``settings.JWT_EXPIRE_MINUTES``。

    Returns:
        ``(token, jti, sid)`` 三元组：JWT 字符串、唯一标识、会话 ID。
    """
    now = datetime.now(timezone.utc)
    jti = secrets.token_urlsafe(16)
    sid = session_id or jti
    exp_minutes = expires_minutes if expires_minutes is not None else settings.JWT_EXPIRE_MINUTES
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "jti": jti,
        "sid": sid,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=exp_minutes)).timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    logger.info("签发 JWT: user_id=%s, username=%s, role=%s, jti=%s", user_id, username, role, jti)
    return token, jti, sid


def decode_access_token(token: str) -> Optional[dict]:
    """解码并校验 JWT，返回 payload；失败返回 None。"""
    try:
        payload = jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        return payload
    except jwt.ExpiredSignatureError:
        logger.warning("JWT 已过期")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning("JWT 无效: %s", exc)
        return None


def create_otp_pending_token(user_id: int, username: str) -> str:
    """签发 OTP 待验证临时 token（5 分钟有效）。

    密码验证通过后、用户启用了 OTP 时签发此 token。
    前端携带此 token + OTP 动态码调用 ``/auth/login/otp`` 完成第二步验证。
    此 token **不能**用于 API 鉴权（payload 中 type="otp_pending"），
    ``get_current_user`` 会拒绝此类 token。
    """
    now = datetime.now(timezone.utc)
    jti = secrets.token_urlsafe(16)
    payload = {
        "sub": str(user_id),
        "username": username,
        "type": "otp_pending",
        "jti": jti,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    logger.info("签发 OTP 待验证 token: user_id=%s, username=%s", user_id, username)
    return token


def verify_otp_pending_token(token: str) -> Optional[dict]:
    """验证 OTP 待验证 token，返回 payload；失败返回 None。"""
    payload = decode_access_token(token)
    if not payload:
        return None
    if payload.get("type") != "otp_pending":
        return None
    return payload


def get_token_ttl_seconds(payload: dict) -> int:
    """从 JWT payload 计算剩余有效期（秒），用于黑名单 TTL。

    若 token 已过期或解析失败返回 0。
    """
    exp = payload.get("exp")
    if not exp:
        return 0
    try:
        remaining = int(exp) - int(datetime.now(timezone.utc).timestamp())
        return max(0, remaining)
    except (TypeError, ValueError):
        return 0


# ============ API Key / Webhook Secret ============

def generate_webhook_secret() -> str:
    """生成 32 字节十六进制 webhook 密钥（64 字符）。"""
    return secrets.token_hex(32)


def generate_api_key() -> str:
    """生成带前缀的 API Key（用于未来 per-user API Key 场景）。"""
    return f"soar_{secrets.token_urlsafe(32)}"


# ============ 工作流环境变量对称加密 ============

# 加密前缀，用于识别密文与历史明文兼容
_ENV_ENC_PREFIX = "enc:"


def _derive_env_key() -> bytes:
    """从 JWT_SECRET 派生 32 字节对称密钥（用于环境变量加解密）。

    使用 SHA-256 派生，与 JWT 签名密钥同源但用途隔离。
    """
    return hashlib.sha256(("env:" + settings.JWT_SECRET).encode("utf-8")).digest()


def encrypt_env_value(plaintext: Optional[str]) -> str:
    """加密单个环境变量值（XOR + base64）。

    None 或空字符串原样返回（不加密）。
    已加密的值（``enc:`` 前缀）不会重复加密。
    """
    if not plaintext:
        return ""
    if isinstance(plaintext, str) and plaintext.startswith(_ENV_ENC_PREFIX):
        return plaintext
    key = _derive_env_key()
    data = plaintext.encode("utf-8")
    encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return _ENV_ENC_PREFIX + base64.b64encode(encrypted).decode("ascii")


def decrypt_env_value(ciphertext: Optional[str]) -> str:
    """解密单个环境变量值。

    非密文（无 ``enc:`` 前缀，兼容历史明文）原样返回。
    解密失败返回空字符串，避免泄露异常信息。
    """
    if not ciphertext:
        return ""
    if not isinstance(ciphertext, str) or not ciphertext.startswith(_ENV_ENC_PREFIX):
        # 兼容历史明文
        return ciphertext
    try:
        key = _derive_env_key()
        encrypted = base64.b64decode(ciphertext[len(_ENV_ENC_PREFIX):])
        decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(encrypted))
        return decrypted.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("环境变量解密失败: %s", exc)
        return ""


# ============ 设备凭据加解密 ============
def _derive_device_key() -> bytes:
    """从 JWT_SECRET 派生设备凭据专用 32 字节对称密钥。

    前缀 ``device-secret:`` 与 ``env:`` 相隔离，凭证用途密钥与其它用途分离。
    """
    return hashlib.sha256(("device-secret:" + settings.JWT_SECRET).encode("utf-8")).digest()


def encrypt_device_secret(plaintext: Optional[str]) -> str:
    """加密设备凭据（api_key/password/username）。

    - ``None`` 或空原样返回；
    - 已加密（``enc:`` 前缀）不重复加密；
    - 其余明文加密为 ``enc:<base64>``。
    """
    if not plaintext:
        return ""
    if isinstance(plaintext, str) and plaintext.startswith(_ENV_ENC_PREFIX):
        # 已加密，避免重复加密
        return plaintext
    key = _derive_device_key()
    data = plaintext.encode("utf-8")
    encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return _ENV_ENC_PREFIX + base64.b64encode(encrypted).decode("ascii")


def decrypt_device_secret(ciphertext: Optional[str]) -> str:
    """解密设备凭据。

    - 无 ``enc:`` 前缀视为历史明文原样返回（兼容旧数据）；
    - 解密失败返回空字符串，避免泄露与异常。
    """
    if not ciphertext:
        return ""
    if not isinstance(ciphertext, str) or not ciphertext.startswith(_ENV_ENC_PREFIX):
        # 兼容历史明文
        return ciphertext
    try:
        key = _derive_device_key()
        encrypted = base64.b64decode(ciphertext[len(_ENV_ENC_PREFIX):])
        decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(encrypted))
        return decrypted.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("设备凭据解密失败: %s", exc)
        return ""


# ============ 出站 URL 安全校验（SSRF 防护基线） ============

# 云厂商元数据服务地址：绝不应作为服务端出站请求目标
_METADATA_HOSTS = {
    "169.254.169.254",           # AWS / GCE / OpenStack 元数据
    "100.100.100.200",           # 阿里云元数据
    "metadata.google.internal",  # GCE 元数据（域名形式）
    "metadata.goog",
}


def validate_outbound_url(url: str, *, field: str = "URL") -> str:
    """校验服务端出站请求目标 URL（SSRF 防护基线）。

    规则（不禁止内网地址——设备管理业务天然需要访问内网设备）：
    - 协议仅允许 http / https（阻断 file:// gopher:// ftp:// 等）；
    - 主机不得为云元数据地址（防云凭证窃取）。

    Args:
        url: 待校验的 URL。
        field: 字段名（用于错误提示，如 "设备 api_url"）。

    Returns:
        校验通过时返回 None（占位，便于调用方 ``if validate_outbound_url(...):`` 判断）。

    Raises:
        ValueError: URL 不合法时抛出，消息可直接用于 4xx 响应。
    """
    if not url or not url.strip():
        raise ValueError(f"{field} 不能为空")
    parsed = urlsplit(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"{field} 协议非法（仅允许 http/https）: {url[:80]}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError(f"{field} 缺少主机地址: {url[:80]}")
    if host in _METADATA_HOSTS:
        raise ValueError(f"{field} 指向云元数据地址，已被安全策略拦截")
    return None


# ============ 轻量数据库迁移 ============

def ensure_columns(engine, table_name: str, columns: dict[str, str]) -> None:
    """检查并补齐缺失列（轻量迁移，避免引入 Alembic）。

    Args:
        engine: SQLAlchemy 引擎。
        table_name: 表名。
        columns: ``{列名: "SQL 类型定义"}``，如 ``{"enabled": "BOOLEAN NOT NULL DEFAULT TRUE"}``。
            仅当列不存在时执行 ``ALTER TABLE ... ADD COLUMN ...``。
    """
    insp = inspect(engine)
    if not insp.has_table(table_name):
        # 表不存在（create_all 会创建），跳过
        return
    existing = {col["name"] for col in insp.get_columns(table_name)}
    with engine.begin() as conn:
        for col_name, col_def in columns.items():
            if col_name in existing:
                continue
            stmt = f'ALTER TABLE "{table_name}" ADD COLUMN "{col_name}" {col_def}'
            logger.info("轻量迁移: %s", stmt)
            conn.execute(text(stmt))
    logger.info("轻量迁移完成: table=%s, checked=%d", table_name, len(columns))


def _ensure_govcloud_search_indexes(engine) -> None:
    btree_indexes = (
        ("ix_gch_ip", "govcloud_cloud_hosts", "ip_address"),
        ("ix_gch_fip", "govcloud_cloud_hosts", "floatip_address"),
        ("ix_gch_inst", "govcloud_cloud_hosts", "instance_id"),
        ("ix_gch_cmdb", "govcloud_cloud_hosts", "cmdb_id"),
        ("ix_gbm_ip", "govcloud_bare_metals", "ip_address"),
        ("ix_gbm_fip", "govcloud_bare_metals", "floatip_address"),
        ("ix_gbm_inst", "govcloud_bare_metals", "instance_id"),
        ("ix_gbm_cmdb", "govcloud_bare_metals", "cmdb_id"),
        ("ix_gnet_ip", "govcloud_networks", "ip_address"),
        ("ix_gnet_cidr", "govcloud_networks", "cidr"),
        ("ix_gnet_inst", "govcloud_networks", "instance_id"),
        ("ix_gnet_cmdb", "govcloud_networks", "cmdb_id"),
        ("ix_geip_ip", "govcloud_elastic_ips", "ip_address"),
        ("ix_geip_fip", "govcloud_elastic_ips", "floatip_address"),
        ("ix_geip_inst", "govcloud_elastic_ips", "instance_id"),
        ("ix_geip_cmdb", "govcloud_elastic_ips", "cmdb_id"),
    )
    trgm_indexes = (
        ("ix_gch_name_trgm", "govcloud_cloud_hosts", "instance_name"),
        ("ix_gch_iname_trgm", "govcloud_cloud_hosts", "inst_name"),
        ("ix_gch_udept_trgm", "govcloud_cloud_hosts", "user_department"),
        ("ix_gch_adept_trgm", "govcloud_cloud_hosts", "applicant_department"),
        ("ix_gbm_name_trgm", "govcloud_bare_metals", "instance_name"),
        ("ix_gbm_iname_trgm", "govcloud_bare_metals", "inst_name"),
        ("ix_gbm_udept_trgm", "govcloud_bare_metals", "user_department"),
        ("ix_gbm_adept_trgm", "govcloud_bare_metals", "applicant_department"),
        ("ix_gnet_name_trgm", "govcloud_networks", "instance_name"),
        ("ix_gnet_iname_trgm", "govcloud_networks", "inst_name"),
        ("ix_gnet_label_trgm", "govcloud_networks", "name"),
        ("ix_gnet_udept_trgm", "govcloud_networks", "user_department"),
        ("ix_gnet_adept_trgm", "govcloud_networks", "applicant_department"),
        ("ix_geip_name_trgm", "govcloud_elastic_ips", "instance_name"),
        ("ix_geip_iname_trgm", "govcloud_elastic_ips", "inst_name"),
        ("ix_geip_udept_trgm", "govcloud_elastic_ips", "user_department"),
        ("ix_geip_adept_trgm", "govcloud_elastic_ips", "applicant_department"),
    )
    extra_ip_indexes = (
        ("ix_gch_extra_ip", "govcloud_cloud_hosts"),
        ("ix_gbm_extra_ip", "govcloud_bare_metals"),
        ("ix_gnet_extra_ip", "govcloud_networks"),
        ("ix_geip_extra_ip", "govcloud_elastic_ips"),
    )
    extra_name_indexes = (
        ("ix_gch_extra_name_trgm", "govcloud_cloud_hosts"),
        ("ix_gbm_extra_name_trgm", "govcloud_bare_metals"),
        ("ix_gnet_extra_name_trgm", "govcloud_networks"),
        ("ix_geip_extra_name_trgm", "govcloud_elastic_ips"),
    )
    insp = inspect(engine)

    def _ready(table: str, column: str) -> bool:
        if not insp.has_table(table):
            return False
        return column in {item["name"] for item in insp.get_columns(table)}

    for index_name, table, column in btree_indexes:
        if not _ready(table, column):
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"
                ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("资产发现索引 %s 创建失败: %s", index_name, exc)
    trgm_ok = False
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        trgm_ok = True
    except Exception as exc:  # noqa: BLE001
        try:
            with engine.connect() as conn:
                trgm_ok = conn.execute(
                    text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
                ).first() is not None
        except Exception:  # noqa: BLE001
            trgm_ok = False
        if not trgm_ok:
            logger.warning("pg_trgm 不可用，资产发现名称搜索无法走索引: %s", exc)
    for index_name, table in extra_ip_indexes:
        if not _ready(table, "extra_excel"):
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} "
                    f"ON {table} ((extra_excel->>'IP'))"
                ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("资产发现扩展 IP 索引 %s 创建失败: %s", index_name, exc)
    if not trgm_ok:
        return
    for index_name, table, column in trgm_indexes:
        if not _ready(table, column):
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} "
                    f"ON {table} USING gin ({column} gin_trgm_ops)"
                ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("资产发现模糊索引 %s 创建失败: %s", index_name, exc)
    for index_name, table in extra_name_indexes:
        if not _ready(table, "extra_excel"):
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} "
                    f"ON {table} USING gin ((extra_excel->>'实例名') gin_trgm_ops)"
                ))
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name}_ip "
                    f"ON {table} USING gin ((extra_excel->>'IP') gin_trgm_ops)"
                ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("资产发现扩展字段模糊索引 %s 创建失败: %s", index_name, exc)


def _reset_govcloud_split_schema(engine) -> None:
    """资产发现分表迁移：去掉旧 JSON 单表；纠正列名；清空与空新表脱节的旧批次。"""
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS govcloud_assets"))
        insp2 = inspect(engine)
        rebuild = False
        if insp2.has_table("govcloud_cloud_hosts"):
            cols = {c["name"] for c in insp2.get_columns("govcloud_cloud_hosts")}
            if "cmdb_id" not in cols:
                rebuild = True
        if rebuild:
            for tbl in (
                "govcloud_cloud_hosts",
                "govcloud_bare_metals",
                "govcloud_networks",
                "govcloud_elastic_ips",
            ):
                conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))
            if insp2.has_table("govcloud_import_batches"):
                conn.execute(text("TRUNCATE TABLE govcloud_import_batches RESTART IDENTITY"))
            logger.info("轻量迁移: 已按 cmdb_id 重建政务云分表并清空旧导入批次")
            return
        if not insp2.has_table("govcloud_import_batches"):
            return
        live = 0
        if insp2.has_table("govcloud_cloud_hosts"):
            live = conn.execute(text("SELECT count(*) FROM govcloud_cloud_hosts")).scalar() or 0
        stale = conn.execute(text(
            "SELECT count(*) FROM govcloud_import_batches WHERE resource_type='cloud_host'"
        )).scalar() or 0
        if live == 0 and stale > 0:
            conn.execute(text("TRUNCATE TABLE govcloud_import_batches RESTART IDENTITY"))
            logger.info("轻量迁移: 新表为空，已清空旧导入批次避免误报未对齐")


def _backfill_agent_output_mode(engine) -> None:
    insp = inspect(engine)
    if not insp.has_table("agents"):
        return
    cols = {c["name"] for c in insp.get_columns("agents")}
    if "output_mode" not in cols:
        return
    with engine.begin() as conn:
        if engine.dialect.name != "postgresql":
            conn.execute(text("UPDATE agents SET output_mode = 'chat' WHERE output_mode IS NULL"))
            return
        conn.execute(text(
            """
            UPDATE agents
            SET output_mode = 'soc_decision'
            WHERE output_mode IS NULL
              AND (
                COALESCE(enabled_tools::text, '[]') NOT IN ('[]', 'null', '')
                OR COALESCE(enabled_kbs::text, '[]') NOT IN ('[]', 'null', '')
                OR COALESCE(enabled_asset_types::text, '[]') NOT IN ('[]', 'null', '')
                OR COALESCE(enabled_workflows::text, '[]') NOT IN ('[]', 'null', '')
              )
            """
        ))
        conn.execute(text(
            "UPDATE agents SET output_mode = 'chat' WHERE output_mode IS NULL"
        ))


def run_lightweight_migrations(engine) -> None:
    """运行所有轻量迁移（启动时调用）。

    当前覆盖：
    - alert_events 表新增 rule_id / log_type 列（解析引擎输出的规则元数据）。
    - workflows 表新增 webhook_secret / enabled 列。
    - users 表新增 role_id / failed_login_count / locked_until 列。
    - executions 表新增 agent_id 列（智能体执行记录关联）。
    - knowledge_bases 表新增 Dify 风格配置列（分段/索引/检索）。
    - knowledge_documents 表新增 updated_at / segment_count 列。
    - agents 表新增 enabled_skills 列（启用的技能 id 列表，注入 system prompt）。
    - tools 表新增 tool_type / http_config / category 列。

    线程安全：使用 PostgreSQL advisory lock 防止多实例并发执行 DDL。
    锁 ID 77001 为本项目专用，避免与其他应用冲突。
    """
    # advisory lock：使用独立 raw connection 防止多实例并发 DDL
    # pg_try_advisory_lock 是 session 级锁，必须用同一连接解锁，所以不能用连接池
    lock_conn = engine.raw_connection()
    locked = False
    try:
        cursor = lock_conn.cursor()
        cursor.execute("SELECT pg_try_advisory_lock(77001)")
        locked = cursor.fetchone()[0]
        cursor.close()
        if not locked:
            logger.info("轻量迁移：另一实例正在执行，跳过")
            return
        # alert_events 表新增 rule_id / log_type 列
        # （parser_engine 命中规则后注入 fields；此前模型缺列导致 AlertEvent(**fields) 入库崩溃）
        ensure_columns(
            engine,
            "alert_events",
            {
                "rule_id": "VARCHAR(64)",
                "log_type": "VARCHAR(64)",
            },
        )
        # alert_events 表新增 alert_rule_id / alert_rule_name 列
        # （告警规则引擎命中后写入；alert_rules/alert_rule_hits 表由
        #  Base.metadata.create_all 建表）
        ensure_columns(
            engine,
            "alert_events",
            {
                "alert_rule_id": "INTEGER",
                "alert_rule_name": "VARCHAR(255) NOT NULL DEFAULT ''",
            },
        )
        # alert_events 表新增关联本地资产列
        # （AssetLibEnricher 按 host→src→dst IP 匹配 assets 资产库命中后写入）
        ensure_columns(
            engine,
            "alert_events",
            {
                "relate_asset_id": "INTEGER",
                "relate_asset_name": "VARCHAR(255) NOT NULL DEFAULT ''",
                "relate_asset_ip": "VARCHAR(64) NOT NULL DEFAULT ''",
            },
        )
        # alert_rules 表新增 created_by / updated_by 列（规则操作人，列表展示）
        ensure_columns(
            engine,
            "alert_rules",
            {
                "created_by": "VARCHAR(128) NOT NULL DEFAULT ''",
                "updated_by": "VARCHAR(128) NOT NULL DEFAULT ''",
            },
        )
        # alert_rules 表新增 XDR 风格扩展列（分组/统计配置/字段配置/告警聚合/草稿）
        ensure_columns(
            engine,
            "alert_rules",
            {
                "rule_group": "VARCHAR(64) NOT NULL DEFAULT '其他'",
                "stats_config": "TEXT",
                "field_mapping": "TEXT",
                "alert_aggregation": "TEXT",
                "draft": "INTEGER NOT NULL DEFAULT 0",
                "last_test_passed_at": "TIMESTAMP WITHOUT TIME ZONE",
            },
        )
        # alert_events 表新增告警聚合列（同键同窗合并：聚合计数 + 聚合键值串）
        ensure_columns(
            engine,
            "alert_events",
            {
                "aggregation_count": "INTEGER NOT NULL DEFAULT 1",
                "aggregation_key": "VARCHAR(255) NOT NULL DEFAULT ''",
            },
        )
        # ban_records 表新增工单同步来源列
        # （工单应急处置节点提交后同步封禁记录：来源工单 + 封禁设备信息）
        ensure_columns(
            engine,
            "ban_records",
            {
                "ticket_id": "INTEGER",
                "ticket_no": "VARCHAR(32)",
                "ticket_node": "VARCHAR(64)",
                "ban_device": "VARCHAR(255)",
            },
        )
        # alert_rule_groups 表种子预置分组（表由 create_all 建立后补种子，幂等）
        try:
            from sqlalchemy import text as sa_text

            with engine.connect() as conn:
                count = conn.execute(
                    sa_text("SELECT COUNT(*) FROM alert_rule_groups")
                ).scalar()
                if not count:
                    for idx, name in enumerate(
                        ["暴力破解", "异常登录", "Web攻击", "恶意软件", "数据泄露", "内部违规", "其他"]
                    ):
                        conn.execute(
                            sa_text(
                                "INSERT INTO alert_rule_groups (name, sort_order, created_at) "
                                "VALUES (:name, :sort_order, NOW())"
                            ),
                            {"name": name, "sort_order": (idx + 1) * 10},
                        )
                    conn.commit()
                    logger.info("轻量迁移: 已种子预置告警规则分组")
        except Exception:  # noqa: BLE001
            logger.exception("轻量迁移: 告警规则分组种子失败（不阻塞启动）")
        # device_receive_logs 表新增解析命中信息列
        # （数据源条目详情「解析结果」面板：命中的模板/规则 + 解析后字段内容）
        ensure_columns(
            engine,
            "device_receive_logs",
            {
                "strategy_id": "INTEGER",
                "strategy_name": "VARCHAR(255) NOT NULL DEFAULT ''",
                "rule_id": "VARCHAR(128) NOT NULL DEFAULT ''",
                "log_type": "VARCHAR(128) NOT NULL DEFAULT ''",
                "parsed_fields": "TEXT",
            },
        )
        ensure_columns(
            engine,
            "workflows",
            {
                "webhook_secret": "VARCHAR(64)",
                "enabled": "BOOLEAN NOT NULL DEFAULT TRUE",
            },
        )
        # workflows 表新增工作流管理增强字段：触发方式/分类/标签/收藏/状态/描述
        ensure_columns(
            engine,
            "workflows",
            {
                "trigger_type": "VARCHAR(32) NOT NULL DEFAULT 'webhook'",
                "category": "VARCHAR(64)",
                "tags": "JSON",
                "favorite": "BOOLEAN NOT NULL DEFAULT FALSE",
                "status": "VARCHAR(32) NOT NULL DEFAULT 'published'",
                "description": "TEXT",
            },
        )
        # workflows 表新增 env_vars 列（环境变量 JSON 数组，value 加密存储）
        ensure_columns(
            engine,
            "workflows",
            {"env_vars": "JSON"},
        )
        # users 表新增 role_id 列（关联 roles 表）
        ensure_columns(
            engine,
            "users",
            {"role_id": "INTEGER"},
        )
        # users 表新增等保安全字段：登录失败计数与锁定截止时间
        ensure_columns(
            engine,
            "users",
            {
                "failed_login_count": "INTEGER NOT NULL DEFAULT 0",
                "locked_until": "TIMESTAMP WITHOUT TIME ZONE",
            },
        )
        # users 表新增个人资料扩展字段：手机/部门/语言/时区/简介/头像
        ensure_columns(
            engine,
            "users",
            {
                "phone": "VARCHAR(32)",
                "department": "VARCHAR(128)",
                "language": "VARCHAR(16) NOT NULL DEFAULT 'zh-CN'",
                "timezone": "VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai'",
                "bio": "TEXT",
                "avatar": "TEXT",
            },
        )
        # users 表新增 OTP / SSO / 登录方式字段
        ensure_columns(
            engine,
            "users",
            {
                "otp_secret": "VARCHAR(255)",
                "otp_enabled": "BOOLEAN NOT NULL DEFAULT FALSE",
                "sso_subject": "VARCHAR(255)",
                "allowed_login_methods": "JSON",
            },
        )
        # users 表新增首次登录强制改密标记
        ensure_columns(
            engine,
            "users",
            {"must_change_password": "BOOLEAN NOT NULL DEFAULT FALSE"},
        )
        # resource_shares 表新增权限级别字段（view/edit）
        ensure_columns(
            engine,
            "resource_shares",
            {
                "permission": "VARCHAR(16) NOT NULL DEFAULT 'edit'",
                "shared_with_role": "INTEGER",
            },
        )
        # executions 表新增 agent_id 列（智能体测试执行记录关联）
        ensure_columns(
            engine,
            "executions",
            {"agent_id": "INTEGER"},
        )
        # alert_events 表新增 Sangfor XDR 策略覆盖列（账号/上报时间原始串/攻击状态/区域 ID）
        ensure_columns(
            engine,
            "alert_events",
            {
                "account_id": "VARCHAR(128) NOT NULL DEFAULT ''",
                "upload_timestamp": "TIMESTAMP WITHOUT TIME ZONE",
                "upload_time_raw": "VARCHAR(64) NOT NULL DEFAULT ''",
                "attack_state": "INTEGER NOT NULL DEFAULT -1",
                "attack_state_name": "VARCHAR(32) NOT NULL DEFAULT ''",
                "src_region_id": "VARCHAR(128) NOT NULL DEFAULT ''",
                "dst_region_id": "VARCHAR(128) NOT NULL DEFAULT ''",
                "relate_asset_type_name": "VARCHAR(16) NOT NULL DEFAULT ''",
                "src_ip_tag_name": "VARCHAR(16) NOT NULL DEFAULT ''",
                "direction_name": "VARCHAR(16) NOT NULL DEFAULT ''",
            },
        )
        # knowledge_bases 表新增 Dify 风格配置列
        ensure_columns(
            engine,
            "knowledge_bases",
            {
                "chunk_mode": "VARCHAR(32) NOT NULL DEFAULT 'auto'",
                "chunk_size": "INTEGER NOT NULL DEFAULT 500",
                "chunk_overlap": "INTEGER NOT NULL DEFAULT 50",
                "chunk_delimiter": "VARCHAR(256)",
                "ocr_enabled": "BOOLEAN NOT NULL DEFAULT FALSE",
                "index_mode": "VARCHAR(32) NOT NULL DEFAULT 'keyword'",
                "embedding_model": "VARCHAR(128) NOT NULL DEFAULT 'text-embedding-ada-002'",
                "embedding_dimension": "INTEGER NOT NULL DEFAULT 1536",
                "retrieval_top_k": "INTEGER NOT NULL DEFAULT 5",
                "score_threshold": "INTEGER NOT NULL DEFAULT 0",
                "rerank_enabled": "INTEGER NOT NULL DEFAULT 0",
                "rerank_model": "VARCHAR(128)",
                "hybrid_vector_weight": "INTEGER NOT NULL DEFAULT 70",
                "hybrid_keyword_weight": "INTEGER NOT NULL DEFAULT 30",
            },
        )
        # knowledge_documents 表新增 updated_at / segment_count 列 + 元数据/状态/权重
        ensure_columns(
            engine,
            "knowledge_documents",
            {
                "updated_at": "TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()",
                "segment_count": "INTEGER NOT NULL DEFAULT 1",
                "description": "TEXT",
                "category": "VARCHAR(255)",
                "tags": "JSON",
                "effective_from": "TIMESTAMP WITHOUT TIME ZONE",
                "effective_to": "TIMESTAMP WITHOUT TIME ZONE",
                "status": "VARCHAR(32) NOT NULL DEFAULT 'available'",
                "retrieval_weight": "INTEGER NOT NULL DEFAULT 1",
                "file_path": "VARCHAR(512)",
                "progress": "INTEGER NOT NULL DEFAULT 0",
                "enabled": "BOOLEAN NOT NULL DEFAULT TRUE",
                "error_message": "TEXT",
            },
        )
        # agents 表新增基础形象 / 模型参数扩展 / 记忆与高级机制字段
        ensure_columns(
            engine,
            "agents",
            {
                "avatar": "VARCHAR(512)",
                "greeting": "TEXT",
                "suggested_questions": "JSON",
                "context_turns": "INTEGER NOT NULL DEFAULT 10",
                "enable_memory": "BOOLEAN NOT NULL DEFAULT FALSE",
                "tone_style": "VARCHAR(32) NOT NULL DEFAULT 'professional'",
                "variables": "JSON",
                "tool_configs": "JSON",
                # 启用的技能 id 列表（注入到 system prompt，见 app/agent/prompt_assembler.py）
                "enabled_skills": "JSON",
                "enabled_workflows": "JSON",
                # 启用的资产类型 code 列表（关联 AssetTypeTemplate.code）
                "enabled_asset_types": "JSON",
                # 执行引擎：固定 hermes
                "engine": "VARCHAR(16) NOT NULL DEFAULT 'hermes'",
                "publish_status": "VARCHAR(16) NOT NULL DEFAULT 'published'",
                "output_mode": "VARCHAR(32)",
            },
        )
        ensure_columns(
            engine,
            "chat_messages",
            {"user_id": "INTEGER"},
        )
        _backfill_agent_output_mode(engine)
        # tools 表新增声明式 HTTP 工具支持：tool_type + http_config + category + is_preset + tags
        ensure_columns(
            engine,
            "tools",
            {
                "tool_type": "VARCHAR(32) NOT NULL DEFAULT 'code'",
                "http_config": "JSON",
                "category": "VARCHAR(64)",
                # 内置工具标记：is_preset=True 的工具不可硬删除（只能禁用），
                # 防止容器重启后种子逻辑重新插入已被用户删除的内置工具
                "is_preset": "BOOLEAN NOT NULL DEFAULT FALSE",
                # 多标签：JSON 数组，如 ["安全运营", "网络资产"]，支持自定义
                "tags": "JSON",
                # 工具来源：builtin | framework | security | custom
                "tool_source": "VARCHAR(32)",
            },
        )
        # llm_configs 表新增 model_type 列（chat / embedding），区分对话模型与向量化模型
        ensure_columns(
            engine,
            "llm_configs",
            {"model_type": "VARCHAR(32) NOT NULL DEFAULT 'chat'"},
        )
        # llm_configs 表新增健康状态 + 高级参数 + 启用开关（模型设置页面增强）
        ensure_columns(
            engine,
            "llm_configs",
            {
                "health_status": "VARCHAR(32) NOT NULL DEFAULT 'untested'",
                "last_test_at": "TIMESTAMP WITHOUT TIME ZONE",
                "last_test_error": "TEXT",
                "last_test_latency_ms": "INTEGER",
                "temperature": "FLOAT",
                "max_tokens": "INTEGER",
                "top_p": "FLOAT",
                "timeout": "INTEGER",
                "max_retries": "INTEGER",
                "org_id": "VARCHAR(128)",
                "project_id": "VARCHAR(128)",
                "enabled": "BOOLEAN NOT NULL DEFAULT TRUE",
            },
        )
        # model_call_logs 表新增明细增强字段（请求/响应摘要、错误堆栈、来源 IP、用户、会话）
        ensure_columns(
            engine,
            "model_call_logs",
            {
                "prompt_summary": "TEXT",
                "response_summary": "TEXT",
                "error_stack": "TEXT",
                "source_ip": "VARCHAR(64)",
                "user_id": "INTEGER",
                "session_id": "VARCHAR(64)",
            },
        )
        # skills 表新增 tags / priority 列（多标签 + 注入顺序，老库补齐）
        ensure_columns(
            engine,
            "skills",
            {
                "tags": "JSON",
                "priority": "INTEGER NOT NULL DEFAULT 0",
            },
        )
        # backup_records 表新增备份策略相关列（名称/范围/校验/耗时/版本/过期）
        ensure_columns(
            engine,
            "backup_records",
            {
                "completed_at": "TIMESTAMP",
                "name": "VARCHAR(200)",
                "note": "TEXT",
                "scope": "VARCHAR(500) NOT NULL DEFAULT 'full'",
                "storage_location": "VARCHAR(20) NOT NULL DEFAULT 'local'",
                "is_encrypted": "BOOLEAN NOT NULL DEFAULT FALSE",
                "checksum": "VARCHAR(128)",
                "checksum_algo": "VARCHAR(20)",
                "duration_seconds": "FLOAT",
                "version": "VARCHAR(50)",
                "expired": "BOOLEAN NOT NULL DEFAULT FALSE",
            },
        )
        # banned_ips 表新增 source 列（来源标识：manual=手动添加，agent=智能体添加）
        ensure_columns(
            engine,
            "banned_ips",
            {"source": "VARCHAR(20) NOT NULL DEFAULT 'agent'"},
        )
        # banned_ips 表新增 device_id / device_name / action_response 列
        # （手动新增/CSV 导入时调用设备 block_ip 动作，记录封禁设备与响应）
        ensure_columns(
            engine,
            "banned_ips",
            {
                "device_id": "INTEGER",
                "device_name": "VARCHAR(255)",
                "action_response": "TEXT",
            },
        )
        # log_receivers 表新增异常通知间隔列（>0 时异常持续期间按分钟重复提醒）
        ensure_columns(
            engine,
            "log_receivers",
            {"notify_interval_minutes": "INTEGER NOT NULL DEFAULT 0"},
        )
        # log_receivers 表新增手动解析策略列（NULL/0=自动匹配，>0 固定用该策略解析）
        ensure_columns(
            engine,
            "log_receivers",
            {"strategy_id": "INTEGER"},
        )
        # log_receivers 表新增适配器配置 JSON 列（NGSOC 式多源采集：新源类型参数 +
        # 流水线覆盖段 + 轮询水位，加适配器零 DDL）
        ensure_columns(
            engine,
            "log_receivers",
            {"adapter_config": "TEXT NOT NULL DEFAULT '{}'"},
        )
        # log_receivers 表放开 device_id 非空约束：监听型接收器不强制绑定设备，
        # 归属走来源条目（按来源 IP 匹配 devices.ip_address）；拉取型仍由 API 层校验必填
        insp_lr = inspect(engine)
        if insp_lr.has_table("log_receivers"):
            lr_cols = {c["name"]: c for c in insp_lr.get_columns("log_receivers")}
            if lr_cols.get("device_id") and not lr_cols["device_id"].get("nullable", True):
                with engine.begin() as conn:
                    conn.execute(text(
                        'ALTER TABLE "log_receivers" ALTER COLUMN "device_id" DROP NOT NULL'
                    ))
                logger.info("轻量迁移: log_receivers.device_id 已放开 NOT NULL（监听型接收器可按条目归属）")
        # assets 表（资产管理智能体）：首次由 create_all 建表，此处为老库补列
        ensure_columns(
            engine,
            "assets",
            {
                "agent_id": "INTEGER NOT NULL",
                "kb_id": "INTEGER NOT NULL DEFAULT 0",
                "kb_name": "VARCHAR(255)",
                "identifier": "VARCHAR(255) NOT NULL",
                "identifier_type": "VARCHAR(32)",
                "name": "VARCHAR(255)",
                "asset_type": "VARCHAR(64)",
                "department": "VARCHAR(128)",
                "owner": "VARCHAR(128)",
                "location": "VARCHAR(128)",
                "ip": "VARCHAR(128)",
                "criticality": "VARCHAR(16)",
                "status": "VARCHAR(32) NOT NULL DEFAULT 'in_use'",
                "extra_fields": "JSON",
                "source": "VARCHAR(20) NOT NULL DEFAULT 'agent_add'",
                "raw_content": "TEXT",
                "created_at": "TIMESTAMP WITHOUT TIME ZONE",
                "updated_at": "TIMESTAMP WITHOUT TIME ZONE",
            },
        )
        # assets 表新增 type_code 列（资产类型模板代码）
        ensure_columns(
            engine,
            "assets",
            {"type_code": "VARCHAR(64)"},
        )
        # asset_tags 表新增 category 列（标签分类）
        ensure_columns(
            engine,
            "asset_tags",
            {"category": "VARCHAR(64)"},
        )
        # assets 表索引变更：从唯一索引改为普通索引
        # 聚合模式（allow_aggregate=True）下同一标识可有多条不同部门记录，
        # 唯一性由应用层根据模板配置控制，不再用 DB 唯一约束。
        try:
            with engine.begin() as conn:
                # 删除旧索引（可能是唯一索引或普通索引）
                conn.execute(text("DROP INDEX IF EXISTS idx_assets_agent_identifier"))
                conn.execute(text("DROP INDEX IF EXISTS idx_assets_type_identifier"))
                # 创建普通索引（非唯一）
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_assets_type_identifier "
                    "ON assets (type_code, identifier)"
                ))
                logger.info("轻量迁移: assets 索引已变更为普通索引 (type_code, identifier)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("assets 索引变更失败: %s", exc)
        # asset_type_templates 表新增 allow_aggregate 列（标识聚合开关）
        ensure_columns(
            engine,
            "asset_type_templates",
            {"allow_aggregate": "BOOLEAN DEFAULT FALSE"},
        )
        # 一次性迁移：为 network_segment 预设模板设置 allow_aggregate=True
        # 用 system_configs 表的标记记录是否已迁移，避免覆盖用户后续在 UI 上的修改
        try:
            with engine.begin() as conn:
                row = conn.execute(
                    text("SELECT value FROM system_configs WHERE key = 'asset_agg_migrated'")
                ).first()
                if not row:
                    # 首次迁移：把 network_segment 模板的 allow_aggregate 设为 True
                    conn.execute(text(
                        "UPDATE asset_type_templates SET allow_aggregate = TRUE "
                        "WHERE code = 'network_segment'"
                    ))
                    conn.execute(text(
                        "INSERT INTO system_configs (key, value, description) "
                        "VALUES ('asset_agg_migrated', '1', "
                        "'资产标识聚合功能首次迁移标记：network_segment 默认开启聚合')"
                    ))
                    logger.info("轻量迁移: network_segment 模板 allow_aggregate 已设为 True (一次性)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("network_segment allow_aggregate 迁移失败: %s", exc)
        # 一次性迁移：解析模板 uuid 校验正则补大写 hex
        # （^[0-9a-f]{40}$ → ^[0-9a-fA-F]{40}$，避免大写 hex 的合法 UUID 被判校验失败；
        #   存量策略 config 为 TEXT，SQL replace 批量修复）
        try:
            with engine.begin() as conn:
                row = conn.execute(
                    text("SELECT value FROM system_configs WHERE key = 'parse_uuid_regex_migrated'")
                ).first()
                if not row:
                    result = conn.execute(text(
                        "UPDATE parse_strategies SET config = replace("
                        "config, '\"^[0-9a-f]{40}$\"', '\"^[0-9a-fA-F]{40}$\"') "
                        "WHERE config LIKE '%^[0-9a-f]{40}$%'"
                    ))
                    conn.execute(text(
                        "INSERT INTO system_configs (key, value, description) "
                        "VALUES ('parse_uuid_regex_migrated', '1', "
                        "'解析模板 uuid 校验正则补大写 hex 一次性迁移标记')"
                    ))
                    logger.info(
                        "轻量迁移: 解析模板 uuid 校验正则已补大写 hex，修复 %d 行 (一次性)",
                        result.rowcount,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning("解析模板 uuid 校验正则迁移失败: %s", exc)
        # parse_strategies 表新增草稿/发布机制列
        # （draft_config 草稿副本 + published_version_no 线上版本号；
        #   版本快照表 parse_strategy_versions 由 create_all 创建）
        ensure_columns(
            engine,
            "parse_strategies",
            {
                "draft_config": "TEXT",
                "published_version_no": "INTEGER",
            },
        )
        # knowledge_bases 表新增 embedding_config_id 列（关联 embedding 类型 LLMConfig）
        ensure_columns(
            engine,
            "knowledge_bases",
            {"embedding_config_id": "INTEGER"},
        )
        # knowledge_bases 表新增 asset_mapping_config 列（资产精准录入映射配置，JSON）
        # 启用后资产扫描走受控提取引擎从分段精准提取资产
        ensure_columns(
            engine,
            "knowledge_bases",
            {"asset_mapping_config": "JSON"},
        )
        # agent_memories 表 GIN 索引（中文全文检索）
        # 表本身由 Base.metadata.create_all 创建，但 GIN 索引需原生 SQL
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_agent_memories_tsv "
                    "ON agent_memories USING gin(to_tsvector('chinese', content))"
                ))
                logger.info("轻量迁移: agent_memories GIN 索引已确保存在")
        except Exception as exc:  # noqa: BLE001
            # 中文分词配置可能不存在（如 SQLite 测试环境），降级用 ILIKE
            logger.warning("agent_memories GIN 索引创建失败（降级为 ILIKE 检索）: %s", exc)
        # devices 表新增连接状态、心跳、标签、认证方式、连接参数等（设备对接页面增强）
        ensure_columns(
            engine,
            "devices",
            {
                "status": "VARCHAR(32) NOT NULL DEFAULT 'unconfigured'",
                "last_heartbeat": "TIMESTAMP WITHOUT TIME ZONE",
                "last_test_error": "TEXT",
                "last_test_latency_ms": "INTEGER",
                "tags": "TEXT NOT NULL DEFAULT '[]'",
                "auth_type": "VARCHAR(32) NOT NULL DEFAULT 'api_key'",
                "timeout": "INTEGER",
                "max_retries": "INTEGER",
                "verify_tls": "BOOLEAN NOT NULL DEFAULT FALSE",
                "icon": "VARCHAR(32) NOT NULL DEFAULT ''",
                "ip_address": "VARCHAR(64) NOT NULL DEFAULT ''",
                # 设备版本（固件/软件版本号，接入指引填写）
                "version": "VARCHAR(64) NOT NULL DEFAULT ''",
                # 设备级解析策略绑定（parse_strategies.id）
                "parser_strategy_id": "INTEGER",
            },
        )
        # device_actions 表新增分类、风险等级、版本、调用统计、示例数据
        ensure_columns(
            engine,
            "device_actions",
            {
                "category": "VARCHAR(32) NOT NULL DEFAULT 'other'",
                "risk_level": "VARCHAR(32) NOT NULL DEFAULT 'readonly'",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "last_call_at": "TIMESTAMP WITHOUT TIME ZONE",
                "call_count_24h": "INTEGER NOT NULL DEFAULT 0",
                "success_count_24h": "INTEGER NOT NULL DEFAULT 0",
                "avg_latency_ms": "INTEGER",
                "example_payload": "TEXT",
                "example_response": "TEXT",
            },
        )
        # 资源级 owner 权限控制：5 个资源表新增 created_by 列（创建者用户ID）
        # resource_shares 表由 Base.metadata.create_all 自动创建（新表）
        for _owner_tbl in ("workflows", "agents", "tools", "skills", "knowledge_bases"):
            ensure_columns(engine, _owner_tbl, {"created_by": "INTEGER"})
        # 历史数据迁移：created_by 为 NULL 的记录回填为 admin（id=1），
        # 保证老数据有明确 owner（默认归属 admin），避免历史资源无人可编辑。
        try:
            with engine.begin() as conn:
                for _owner_tbl in ("workflows", "agents", "tools", "skills", "knowledge_bases"):
                    conn.execute(text(
                        f"UPDATE {_owner_tbl} SET created_by = 1 WHERE created_by IS NULL"
                    ))
                logger.info("轻量迁移: 5 个资源表 created_by 历史数据已回填为 admin(id=1)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("资源表 created_by 历史数据回填失败: %s", exc)
        # service_categories 表新增 parent_id / level 列（树形目录，最多 10 级）
        ensure_columns(
            engine,
            "service_categories",
            {
                "parent_id": "INTEGER",
                "level": "INTEGER NOT NULL DEFAULT 1",
            },
        )
        # service_categories 表 name 唯一约束 → 同级唯一（parent_id + name 普通索引）
        # 旧表 name 列上有 unique 约束/唯一索引，需删除后改为普通索引。
        # 同级唯一性由应用层校验，避免不同父级下同名子目录被误拒。
        try:
            with engine.begin() as conn:
                # 删除 name 列上的唯一约束/索引（多种可能名称，逐一尝试）
                for _idx_drop in (
                    "DROP INDEX IF EXISTS ix_service_categories_name",
                    "ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS service_categories_name_key",
                ):
                    conn.execute(text(_idx_drop))
                # 创建 parent_id 普通索引（ensure_columns 已建列，此处补索引）
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_service_categories_parent_id "
                    "ON service_categories (parent_id)"
                ))
                logger.info("轻量迁移: service_categories 树形目录列/索引已就绪")
        except Exception as exc:  # noqa: BLE001
            logger.warning("service_categories 索引调整失败: %s", exc)
        # duty_leave_logs 表新增 approve_reason 列（审批意见，nullable）
        ensure_columns(
            engine,
            "duty_leave_logs",
            {"approve_reason": "TEXT"},
        )
        # alert_events 表新增处置闭环列（指派人 + 处置时间）
        ensure_columns(
            engine,
            "alert_events",
            {
                "assignee_id": "INTEGER",
                "assignee_name": "VARCHAR(128) NOT NULL DEFAULT ''",
                "handled_at": "TIMESTAMP WITHOUT TIME ZONE",
            },
        )
        # agent_files 表新增归属隔离列：agent_id（归属智能体，NULL=公共）、
        # created_by（上传用户 id，NULL=非用户上传）；旧文件保持 agent_id NULL 即公共
        ensure_columns(
            engine,
            "agent_files",
            {
                "agent_id": "INTEGER",
                "created_by": "INTEGER",
            },
        )
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_agent_files_agent_id "
                    "ON agent_files (agent_id)"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_agent_files_created_by "
                    "ON agent_files (created_by)"
                ))
                logger.info("轻量迁移: agent_files 归属隔离列/索引已就绪")
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent_files 索引调整失败: %s", exc)
        ensure_columns(
            engine,
            "govcloud_import_batches",
            {"import_mode": "VARCHAR(16) DEFAULT 'full'"},
        )
        # tickets 表新增阶段2 列：节点停留超时提醒（到达时间/提醒进度）+ 归档标记
        ensure_columns(
            engine,
            "tickets",
            {
                "arrived_at": "TIMESTAMP WITHOUT TIME ZONE",
                "first_reminded_at": "TIMESTAMP WITHOUT TIME ZONE",
                "last_reminded_at": "TIMESTAMP WITHOUT TIME ZONE",
                "remind_count": "INTEGER NOT NULL DEFAULT 0",
                "archived": "BOOLEAN NOT NULL DEFAULT FALSE",
                # 发起时自动研判结果（资产匹配 + 威胁情报，src_ip/dst_ip），随工单流转
                "enrichment_data": "JSON",
                # 认领锁定：组内成员认领后仅认领人（或 admin）可提交
                "claimed_by_id": "INTEGER",
                # 并行会签：当前待处理分组 CSV（",3,5,"），普通节点为单分组
                "current_group_ids": "VARCHAR(255)",
            },
        )
        # 存量工单回填 current_group_ids（幂等：仅补 NULL 行），
        # 使旧工单的"待我处理"筛选走 CSV 条件
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "UPDATE tickets SET current_group_ids = ',' || current_group_id || ',' "
                    "WHERE current_group_id IS NOT NULL AND current_group_ids IS NULL"
                ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("tickets.current_group_ids 回填失败（忽略）: %s", exc)
        try:
            _reset_govcloud_split_schema(engine)
        except Exception as extra_exc:  # noqa: BLE001
            logger.warning("重置政务云分表/批次失败（忽略）: %s", extra_exc)
        try:
            _ensure_govcloud_search_indexes(engine)
        except Exception as index_exc:  # noqa: BLE001
            logger.warning("资产发现查询索引创建失败（忽略）: %s", index_exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("轻量迁移失败（忽略继续）: %s", exc)
    finally:
        if locked:
            try:
                cursor = lock_conn.cursor()
                cursor.execute("SELECT pg_advisory_unlock(77001)")
                cursor.close()
                lock_conn.commit()
            except Exception:  # noqa: BLE001
                pass
        lock_conn.close()
