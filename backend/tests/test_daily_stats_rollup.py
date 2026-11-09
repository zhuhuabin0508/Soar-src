"""日汇总 rollup / 读路径测试。"""
from datetime import date, datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.daily_stats_rollup import (
    rollup_execution_day,
    try_compute_dashboard_from_rollups,
)
from app.database import Base
from app.models import Execution
from app.models.stats_daily import StatsDailyExecution


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        engine,
        tables=[
            Execution.__table__,
            StatsDailyExecution.__table__,
            __import__("app.models.stats_daily", fromlist=["StatsDailyExecutionDim"]).StatsDailyExecutionDim.__table__,
        ],
    )
    return sessionmaker(bind=engine)()


def test_rollup_execution_day_empty(monkeypatch):
    db = _session()
    d = date(2026, 1, 15)
    rollup_execution_day(db, d)
    row = db.query(StatsDailyExecution).filter(StatsDailyExecution.stat_date == d).first()
    assert row is not None
    assert row.total_count == 0


def test_try_dashboard_from_rollups_insufficient(monkeypatch):
    db = _session()
    assert try_compute_dashboard_from_rollups(db) is None
