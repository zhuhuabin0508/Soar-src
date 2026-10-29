"""FastAPI 应用入口。

创建 ``SOAR Platform API`` 应用，配置 CORS、挂载 ``/api/v1`` 路由，
并在启动时建表、运行轻量迁移与同步工具目录。

安全说明（P0-1/P0-2 升级）：
- CORS 不再使用 ``allow_origins=["*"]``，改为从 ``settings.CORS_ORIGINS`` 读取白名单。
- 引入 slowapi 限流器，供 webhook 等高风险端点使用。
- 启动时运行轻量迁移（补齐 workflows 表的 webhook_secret/enabled 列）。
- 启动时种子默认 admin 用户（首次启动）。
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.api.v1 import api_router
from app.config import settings
from app.core.validation_errors import translate_validation_errors

# 统一日志格式（便于调试）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _init_db() -> None:
    """建表、运行轻量迁移、同步工具目录与种子默认 admin 用户（幂等）。

    使用 ``Base.metadata.create_all`` 自动建表；
    随后运行 ``run_lightweight_migrations`` 补齐新增列（如 webhook_secret）；
    预置工具由 ``ensure_preset_tools`` 统一同步，不再单独种子 TOOL_TEMPLATES。
    """
    from app.core.security import run_lightweight_migrations
    from app.database import Base, SessionLocal, engine
    import app.models  # noqa: F401  触发 ORM 注册到 Base.metadata

    Base.metadata.create_all(bind=engine)
    logger.info("DB tables ensured via Base.metadata.create_all")

    # 轻量迁移：补齐新增列（不引入 Alembic 的过渡方案）
    run_lightweight_migrations(engine)
    # 迁移可能 DROP 重建政务云分表，补一次建表
    Base.metadata.create_all(bind=engine)

    # 迁移完成后重新同步 Hermes 内置工具（确保 is_preset 等新增字段被正确标记）。
    # entrypoint.sh 中的 ensure_seed_data() 在迁移前运行，此时 is_preset 列可能尚不存在，
    # 导致标记失败。此处补调一次，幂等无副作用。
    try:
        from app.core.tools.seed_service import ensure_preset_tools, backfill_tool_sources
        from app.database import SessionLocal

        ensure_preset_tools()
        db = SessionLocal()
        try:
            updated = backfill_tool_sources(db)
            if updated:
                db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("迁移后 Hermes 工具同步失败（忽略）: %s", exc)

    try:
        from app.core.kb_seed import ensure_preset_knowledge_bases
        ensure_preset_knowledge_bases()
    except Exception as exc:  # noqa: BLE001
        logger.warning("内置知识库种子失败（忽略）: %s", exc)

    db = SessionLocal()
    try:
        # 种子默认 admin 用户（仅当 users 表为空时）
        _seed_admin_user(db)

        # 种子默认角色（独立调用，确保 roles 表在老库升级时也能补齐）
        _seed_default_roles(db)

        # 已有角色补齐新增权限模块（如 asset_discovery），admin 始终展开全量矩阵
        _sync_role_permission_modules(db)

        # 注册内置解析策略（Sangfor XDR 等，幂等；见 app/engine/strategies/）
        try:
            from app.engine.strategy_seed import seed_builtin_strategies
            seed_builtin_strategies(db)
        except Exception as exc:  # noqa: BLE001
            logger.warning("内置解析策略注册失败（忽略）: %s", exc)
    finally:
        db.close()


def _seed_admin_user(db) -> None:
    """首次启动时种子默认 admin 账号。

    账号密码由 ``settings.SEED_ADMIN_USERNAME`` / ``SEED_ADMIN_PASSWORD`` 控制。
    若 users 表已有数据则跳过。
    """
    from app.core.security import hash_password
    from app.models.user import User

    if db.query(User).count() > 0:
        logger.info("Users 表已有数据，跳过 admin 种子")
        return

    admin = User(
        username=settings.SEED_ADMIN_USERNAME,
        password_hash=hash_password(settings.SEED_ADMIN_PASSWORD),
        display_name="系统管理员",
        role="admin",
        is_active=True,
        # 默认弱口令种子时强制首登改密（与新建用户逻辑一致）
        must_change_password=settings.SEED_ADMIN_PASSWORD == _DEFAULT_ADMIN_PASSWORD,
    )
    db.add(admin)
    db.commit()
    logger.warning(
        "已种子默认管理员账号: username=%s, password=%s（请立即登录修改密码！）",
        settings.SEED_ADMIN_USERNAME,
        settings.SEED_ADMIN_PASSWORD,
    )

    # 种子默认角色（admin 用户种子后执行）
    _seed_default_roles(db)


def _seed_default_roles(db) -> None:
    """首次启动时种子默认角色（admin/analyst/viewer）。

    仅当 roles 表为空时执行，不覆盖用户自定义角色。
    种子后自动为 admin 用户关联 admin 角色 ID。
    """
    from app.core.permissions import DEFAULT_ROLES
    from app.models.role import Role
    from app.models.user import User

    if db.query(Role).count() > 0:
        logger.info("Roles 表已有数据，跳过角色种子")
        return

    for role_data in DEFAULT_ROLES:
        role = Role(
            name=role_data["name"],
            description=role_data.get("description"),
            permissions=role_data.get("permissions", {}),
            is_system=role_data.get("is_system", False),
        )
        db.add(role)
    db.commit()
    logger.info("已种子 %d 个默认角色", len(DEFAULT_ROLES))

    # 为已存在的 admin 用户关联 admin 角色 ID
    admin_user = db.query(User).filter(User.role == "admin").first()
    admin_role = db.query(Role).filter(Role.name == "admin").first()
    if admin_user and admin_role:
        admin_user.role_id = admin_role.id
        db.commit()
        logger.info("已为 admin 用户关联 admin 角色ID: %s", admin_role.id)


def _sync_role_permission_modules(db) -> None:
    """启动时把新增权限模块写入已有角色，避免角色管理页和侧栏看不到新模块。

    - 系统 admin：权限矩阵与 ``PERMISSION_MODULES`` 对齐（全开）
    - 其它角色：``migrate_permissions``（含 asset_list → asset_discovery 继承）
    """
    from app.core.permissions import PERMISSION_MODULES, migrate_permissions
    from app.models.role import Role

    roles = db.query(Role).all()
    changed = 0
    full = {mod: list(actions) for mod, actions in PERMISSION_MODULES.items()}
    for role in roles:
        if role.name == "admin":
            if role.permissions != full:
                role.permissions = full
                db.add(role)
                changed += 1
            continue
        perms = role.permissions if isinstance(role.permissions, dict) else {}
        migrated = migrate_permissions(perms)
        if migrated != perms:
            role.permissions = migrated
            db.add(role)
            changed += 1
    if changed:
        db.commit()
        logger.info("已同步 %d 个角色的权限模块（含资产发现）", changed)
    else:
        logger.info("角色权限模块已是最新，无需同步")


_DEFAULT_JWT_SECRET = "soar-dev-secret-change-me-in-production-please"
_DEFAULT_ADMIN_PASSWORD = "admin123"


def _check_security_config() -> None:
    """启动安全基线校验：生产环境禁止使用默认 JWT 密钥/管理员口令。

    - JWT_SECRET 为公开默认值时，攻击者可离线伪造 admin JWT 接管平台；
    - SEED_ADMIN_PASSWORD 为默认值时，部署即可用 admin/admin123 登录。
    APP_ENV=production 下任一命中即拒绝启动；dev 环境仅输出醒目警告。
    """
    is_prod = settings.APP_ENV.strip().lower() == "production"
    problems: list[str] = []
    if settings.JWT_SECRET == _DEFAULT_JWT_SECRET or len(settings.JWT_SECRET) < 32:
        problems.append(
            "JWT_SECRET 使用默认值或长度不足 32 字节，攻击者可伪造任意用户 token"
        )
    if settings.SEED_ADMIN_PASSWORD == _DEFAULT_ADMIN_PASSWORD:
        problems.append("SEED_ADMIN_PASSWORD 为默认弱口令 admin123")
    if not problems:
        return
    for p in problems:
        msg = f"安全基线校验失败: {p}"
        if is_prod:
            logger.critical(msg)
        else:
            logger.warning(msg + "（dev 环境放行，生产环境将拒绝启动）")
    if is_prod:
        raise RuntimeError(
            "生产环境安全基线不达标（默认 JWT_SECRET/管理员口令），"
            "请在 .env 配置强随机 JWT_SECRET（>=32 字节）与自定义 SEED_ADMIN_PASSWORD"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时建表并种子数据。"""
    logger.info("SOAR API starting...")
    _check_security_config()
    try:
        _init_db()
    except Exception as exc:  # noqa: BLE001
        # 建表失败不应阻断 API 启动（例如 DB 暂未就绪时仍允许健康检查）
        logger.warning("启动初始化失败（忽略，继续启动）: %s", exc)
    # 推送系统更新通知（版本变化时广播到通知中心）
    try:
        from app.core.changelog import notify_system_update
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            notify_system_update(db)
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("更新通知推送失败（忽略）: %s", exc)
    # 启动备份调度器（按策略自动备份）
    try:
        from app.api.v1.backup import start_backup_scheduler

        start_backup_scheduler()
    except Exception as exc:  # noqa: BLE001
        logger.warning("备份调度器启动失败（忽略）: %s", exc)
    # 启动模型健康检查调度器（每 5 分钟探测所有启用的配置）
    try:
        from app.core.model_health_scheduler import start_health_scheduler

        start_health_scheduler()
    except Exception as exc:  # noqa: BLE001
        logger.warning("模型健康检查调度器启动失败（忽略）: %s", exc)
    # 启动系统资源告警调度器（每 60 秒检查 CPU/内存/磁盘）
    try:
        from app.core.system_alert_scheduler import start_system_alert_scheduler

        start_system_alert_scheduler()
    except Exception as exc:  # noqa: BLE001
        logger.warning("系统资源告警调度器启动失败（忽略）: %s", exc)
    # 启动解析模板成功率告警调度器（每 10 分钟检查，持续 24h 低于阈值生成告警+通知）
    try:
        from app.core.parse_rate_alert_scheduler import start_parse_rate_alert_scheduler

        start_parse_rate_alert_scheduler()
    except Exception as exc:  # noqa: BLE001
        logger.warning("解析模板成功率告警调度器启动失败（忽略）: %s", exc)
    # 启动封禁工作流：事件触发 worker（告警入库 → 规则匹配 → 实例执行）
    try:
        from app.workflow.trigger import start_trigger_worker

        start_trigger_worker()
    except Exception as exc:  # noqa: BLE001
        logger.warning("封禁工作流触发 worker 启动失败（忽略）: %s", exc)
    # 启动封禁工作流定时任务（到期自动解封 / 审批超时自动驳回，每分钟扫描）
    try:
        from app.workflow.unban_scheduler import start_unban_scheduler

        start_unban_scheduler()
    except Exception as exc:  # noqa: BLE001
        logger.warning("到期解封/审批超时调度器启动失败（忽略）: %s", exc)
    # 启动设备日志接收管理器（被动接入：启动 syslog/kafka 监听 + 接收健康检查）
    try:
        from app.core.log_receiver_manager import start_log_receiver_manager

        start_log_receiver_manager()
    except Exception as exc:  # noqa: BLE001
        logger.warning("日志接收管理器启动失败（忽略）: %s", exc)
    # 启动设备后台健康检查心跳（周期探测启用设备并刷新连接状态）
    try:
        from app.devices.heartbeat import start_device_heartbeat

        start_device_heartbeat()
    except Exception as exc:  # noqa: BLE001
        logger.warning("设备心跳健康检查启动失败（忽略）: %s", exc)
    # 启动通知 WebSocket 实时推送（Redis Pub/Sub 订阅 → 在线用户 WS 连接；
    # 失败不影响通知入库，前端保留轮询兜底）
    try:
        from app.core.notification_ws import start_notification_ws_listener

        start_notification_ws_listener()
    except Exception as exc:  # noqa: BLE001
        logger.warning("通知 WebSocket 订阅启动失败（忽略，轮询兜底）: %s", exc)
    yield
    # 停止通知 WebSocket 订阅协程
    try:
        from app.core.notification_ws import stop_notification_ws_listener

        stop_notification_ws_listener()
    except Exception as exc:  # noqa: BLE001
        logger.warning("通知 WebSocket 订阅停止失败（忽略）: %s", exc)


from app.core.changelog import CURRENT_VERSION  # noqa: E402

app = FastAPI(title="SOAR Platform API", version=CURRENT_VERSION, lifespan=lifespan)


# ============ 请求体校验异常中文化 ============
# FastAPI 在 Pydantic 校验失败时默认返回英文 422（如 "body.title: String should have at least 5 characters"）。
# 此处统一翻译为中文摘要，避免前端再展示给用户看技术性英文。
@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request, exc: RequestValidationError):  # noqa: ARG001
    detail = translate_validation_errors(exc.errors())
    return JSONResponse(status_code=422, content={"detail": detail, "code": "validation_error"})


# ============ 限流器（slowapi）============
# 限流器实例在 app.core.limiter 中定义（独立模块避免循环导入），
# 此处挂到 app.state 并注册异常处理器与中间件。
from app.core.limiter import limiter  # noqa: E402

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# ============ CORS（P0-1 修复：白名单 + 关闭通配）============
# 解析 settings.CORS_ORIGINS（逗号分隔）为列表
_cors_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
logger.info("CORS 允许源: %s", _cors_origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ 全局审计中间件（记录用户所有写操作：模块+IP+结果）============
from app.core.audit import audit_middleware  # noqa: E402


@app.middleware("http")
async def _audit_middleware(request, call_next):
    """记录用户写操作到审计日志（操作者/模块/资源ID/IP/结果）。"""
    return await audit_middleware(request, call_next)

# 所有业务路由统一前缀 /api/v1
app.include_router(api_router, prefix="/api/v1")


# ============ 公开端点：版本号（供前端左下角显示，无需认证）============
@app.get("/api/v1/version")
def get_version():
    """返回当前系统版本号与平台名称（供前端左下角与页签显示）。"""
    from app.database import SessionLocal
    from app.models.system_config import SystemConfig
    db = SessionLocal()
    try:
        cfg = db.query(SystemConfig).filter(SystemConfig.key == "platform_name").first()
        platform_name = cfg.value if cfg else "SOAR 平台"
    finally:
        db.close()
    return {"version": CURRENT_VERSION, "platform_name": platform_name}

# ============ WebSocket 端点：执行进度实时推送 ============
from fastapi import WebSocket as _WS  # noqa: E402
from app.core.ws_manager import ws_manager  # noqa: E402


@app.websocket("/ws/executions/{execution_id}")
async def ws_execution_progress(websocket: _WS, execution_id: int) -> None:
    """WebSocket 端点：客户端连接后订阅指定 execution_id 的执行进度。

    推送的消息类型：
    - ``{"type": "log", "node_id": "...", "level": "info", "message": "..."}``
    - ``{"type": "trace", "node_id": "...", "node_type": "...", "status": "success", ...}``
    - ``{"type": "status", "execution_id": N, "status": "success"/"failed"}``
    """
    await ws_manager.connect(execution_id, websocket)
    try:
        # 保持连接，等待服务端推送；客户端也可发送心跳
        while True:
            await websocket.receive_text()
    except Exception:
        ws_manager.disconnect(execution_id, websocket)
