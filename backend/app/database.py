"""SQLAlchemy 数据库引擎、会话工厂与声明式基类。"""
import logging
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

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


@contextmanager
def linkage_db() -> Iterator[Session]:
    """联动池短会话：commit/rollback 后 close，归还连接。"""
    db = LinkageSessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def main_db() -> Iterator[Session]:
    """主池短会话。"""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def close_db_session(db: Session | None) -> None:
    """结束会话并归还连接（长 I/O 前调用）。

    会话本身可继续复用（下次查询自动重建连接），但调用方不应再依赖其中有
    未提交的变更。关闭前先 ``expunge_all()`` 把实例带已加载属性摘出：
    直接 ``rollback()+close()`` 会使会话内实例属性过期并被逐出，此后调用方
    读取任何属性（如 device.name / action.auth_type）都会抛
    DetachedInstanceError（手动封禁 500 即由此引发）。
    """
    if db is None:
        return
    try:
        # 未提交的变更（new/dirty/deleted）随会话结束一并丢弃：expunge 使
        # 待插入对象退回 transient、未 flush 的修改不再落库，与 rollback 同效
        try:
            db.expunge_all()
        except Exception:  # noqa: BLE001
            logger.debug("摘出会话实例失败", exc_info=True)
        if db.in_transaction():
            db.rollback()
        db.close()
    except Exception:  # noqa: BLE001
        logger.debug("关闭数据库会话失败", exc_info=True)


# 兼容旧调用点，语义等同 close_db_session
def release_db_connection(db: Session | None) -> None:
    close_db_session(db)


def get_db():
    """FastAPI 依赖：提供数据库会话，并在请求结束后自动关闭。"""
    db = SessionLocal()
    try:
        logger.debug("Opening DB session")
        yield db
    finally:
        logger.debug("Closing DB session")
        db.close()
