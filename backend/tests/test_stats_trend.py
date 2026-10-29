"""临时冒烟（阶段五 t5-5）：验证 stats 端点 trend_24h sparkline 数据源。

- /alerts/stats：近24小时告警按小时分组；trend_24h 固定 24 项、无数据小时补 0、升序
- /ingest/strategies/stats：IngestionMetric 按 stat_hour 聚合 total_count 到对应小时
"""
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.api.v1.alerts as alerts_mod
import app.api.v1.ingest as ingest_mod
from app.core.timezone import beijing_now
from app.database import Base, get_db
from app.dependencies import get_current_user
from app.models.alert_event import AlertEvent
from app.models.ingestion_metric import IngestionMetric
from app.models.log_receiver import DeviceReceiveLog, DeviceReceiveMetric, LogReceiver
from app.models.log_source_entry import LogSourceEntry
from app.models.parse_error import ParseErrorQueue
from app.models.parse_strategy import ParseStrategy, ParseStrategyVersion
from app.models.user import User

_engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

Base.metadata.create_all(_engine, tables=[
    AlertEvent.__table__, IngestionMetric.__table__,
    ParseStrategy.__table__, ParseStrategyVersion.__table__,
    ParseErrorQueue.__table__, LogReceiver.__table__,
    LogSourceEntry.__table__, DeviceReceiveLog.__table__,
    DeviceReceiveMetric.__table__, User.__table__,
])

_TABLES = (AlertEvent, IngestionMetric, ParseStrategy, ParseStrategyVersion,
          ParseErrorQueue, LogReceiver, LogSourceEntry, DeviceReceiveLog,
          DeviceReceiveMetric, User)


@pytest.fixture(autouse=True)
def _clean_db():
    db = _TestSessionLocal()
    try:
        for tbl in _TABLES:
            db.query(tbl).delete()
        db.commit()
    finally:
        db.close()
    yield
    db = _TestSessionLocal()
    try:
        for tbl in _TABLES:
            db.query(tbl).delete()
        db.commit()
    finally:
        db.close()


def _build_client():
    app = FastAPI()
    from app.api.v1.alerts import router as alerts_router
    from app.api.v1.ingest import router as ingest_router

    app.include_router(alerts_router)
    app.include_router(ingest_router)

    def _override_db():
        db = _TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    fake_user = User(id=1, username="auditor", role="admin", role_id=None)
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: fake_user
    return TestClient(app)


class TestAlertStatsTrend:
    def test_trend_24h_structure_and_counts(self, monkeypatch):
        """插入 3 条告警（2 条当前小时 + 1 条上一小时），trend_24h 共 24 项且对应小时计数正确。"""
        # 固定端点内的"当前时间"到整点后 30 分（测试数据与断言用同一基准）：
        # 原先直接用真实 beijing_now() 再减 5 分钟，在每小时前 5 分钟执行时
        # "当前小时"数据会落进上一小时，导致本用例每小时偶发失败一次。
        fixed_now = beijing_now().replace(minute=30, second=0, microsecond=0)
        monkeypatch.setattr(alerts_mod, "beijing_now", lambda: fixed_now)

        now = fixed_now
        db = _TestSessionLocal()
        try:
            for i, offset in enumerate((0, 0, 1)):  # 2 条当前小时 + 1 条上一小时
                db.add(AlertEvent(
                    uuid=f"trend-uuid-{i:03d}",
                    alert_name="趋势告警",
                    risk_level=2,
                    occur_timestamp=now - timedelta(hours=offset, minutes=5),
                ))
            db.commit()
        finally:
            db.close()

        res = _build_client().get("/alerts/stats")
        assert res.status_code == 200
        body = res.json()
        trend = body["trend_24h"]
        # 固定 24 项、升序（末项为当前整点）
        assert len(trend) == 24
        assert trend[-1]["hour"] == now.strftime("%Y-%m-%dT%H")
        # 当前小时 2 条、上一小时 1 条（occur_timestamp 为 now-5min / now-1h5min）
        assert trend[-1]["total"] == 2
        assert trend[-2]["total"] == 1
        # 其余小时为 0，总和 = 3
        assert sum(t["total"] for t in trend) == 3
        assert all(set(t.keys()) == {"hour", "total"} for t in trend)

    def test_trend_24h_empty(self):
        """无告警时 trend_24h 仍返回 24 项全 0（前端画平线）。"""
        res = _build_client().get("/alerts/stats")
        assert res.status_code == 200
        trend = res.json()["trend_24h"]
        assert len(trend) == 24
        assert all(t["total"] == 0 for t in trend)


class TestStrategyStatsTrend:
    def test_trend_24h_from_ingestion_metrics(self):
        """指标行 total_count 按小时聚合进 trend_24h 对应桶。"""
        now = beijing_now()
        cur_hour = now.strftime("%Y-%m-%dT%H")
        prev_hour = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H")
        db = _TestSessionLocal()
        try:
            db.add(ParseStrategy(strategy_name="s1", device_type="qingteng_wanxiang", config="{}", status="enabled"))
            db.add(IngestionMetric(strategy_id=1, stat_hour=f"{cur_hour}:00", total_count=10, success_count=10))
            db.add(IngestionMetric(strategy_id=1, stat_hour=f"{cur_hour}:30", total_count=5, success_count=5))
            db.add(IngestionMetric(strategy_id=None, stat_hour=f"{prev_hour}:00", total_count=3, success_count=3))
            db.commit()
        finally:
            db.close()

        res = _build_client().get("/ingest/strategies/stats")
        assert res.status_code == 200
        body = res.json()
        trend = body["trend_24h"]
        assert len(trend) == 24
        assert trend[-1]["hour"] == cur_hour
        # 当前小时两个指标桶合并 = 15；上一小时（无匹配策略）= 3
        assert trend[-1]["total"] == 15
        assert trend[-2]["total"] == 3
        assert body["today_no_match"] == 3
