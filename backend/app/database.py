"""SQLAlchemy 数据库引擎、会话工厂与声明式基类。"""
import logging

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

logger.info("Initializing database engine: %s", settings.DATABASE_URL)

engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    # 告警联动链路存在长耗时操作（LLM 研判/设备 HTTP 调用），期间会持有连接，
    # 洪峰时默认 5+10 会耗尽导致全站请求超时，这里调大并加回收兜底；
    # worker/beat 通过环境变量调小（见 app/config.py DB_POOL_SIZE）
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_recycle=1800,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# 联动链路（告警触发的封禁工作流、LLM 研判、设备 HTTP 调用）专用引擎：
# 这些链路单次执行可达分钟级，若与主池共享会长时间占用连接，
# 洪峰时导致 API 请求排队超时（全站不可用），因此独立成池互不影响。
linkage_engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=settings.DB_LINKAGE_POOL_SIZE,
    max_overflow=settings.DB_LINKAGE_MAX_OVERFLOW,
    pool_recycle=1800,
)

LinkageSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=linkage_engine)

# 所有 ORM 模型的共同基类
Base = declarative_base()


def get_db():
    """FastAPI 依赖：提供数据库会话，并在请求结束后自动关闭。"""
    db = SessionLocal()
    try:
        logger.debug("Opening DB session")
        yield db
    finally:
        logger.debug("Closing DB session")
        db.close()
