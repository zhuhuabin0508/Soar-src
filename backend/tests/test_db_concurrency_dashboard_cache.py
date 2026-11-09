"""数据库/并发与 Redis 大屏缓存自测（阶段一、二回归）。"""
from unittest.mock import MagicMock, patch

import pytest

from app.core import dashboard_cache as dc
from app.workflow import concurrency


class TestWorkflowInflightLimit:
    def test_zero_means_unlimited(self):
        with patch.object(concurrency, "settings") as st:
            st.WORKFLOW_INFLIGHT_LIMIT = 0
            with patch("app.core.redis_client.get_redis") as gr:
                assert concurrency.try_acquire_workflow_inflight() is True
                gr.assert_not_called()

    def test_over_limit_rejected(self):
        r = MagicMock()
        r.incr.return_value = 13
        with patch("app.core.redis_client.get_redis", return_value=r):
            with patch.object(concurrency, "settings") as st:
                st.WORKFLOW_INFLIGHT_LIMIT = 12
                assert concurrency.try_acquire_workflow_inflight() is False
                r.decr.assert_called_once()


class TestDashboardCacheResolve:
    def test_fresh_snapshot_attaches_meta(self):
        body = {"kpi": {"today_alerts": 1}}
        meta = {"built_at": "t", "version": 2, "stale": False}
        with patch.object(dc, "_load_json", side_effect=[body, meta]):
            out = dc.get_fresh_snapshot("k")
        assert out["kpi"]["today_alerts"] == 1
        assert out["cache"]["version"] == 2
        assert out["cache"]["stale"] is False

    def test_cold_miss_live_when_allowed(self, monkeypatch):
        monkeypatch.setattr(dc.settings, "DASHBOARD_CACHE_ENABLED", True)

        class _S:
            pass

        db = _S()
        with patch.object(dc, "get_fresh_snapshot", return_value=None):
            with patch.object(dc, "get_last_snapshot", return_value=None):
                out = dc.resolve_cached_payload(
                    "k",
                    db,
                    lambda _db: {"v": 1},
                    allow_live_cold_start=True,
                )
        assert out["v"] == 1
        assert out["cache"]["source"] == "live_cold_start"
