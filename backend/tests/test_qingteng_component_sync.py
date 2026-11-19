"""青藤组件清单同步的单元测试。

覆盖：
- 资源类型解析与组件列表列
- source_id 稳定性（升级原地更新 / 多版本共存）
- 五类组件字段映射（含 Windows pkg.productVersion）
- 分页终止与单源触顶
- sync_device_components：批次进度、full 删除成功源、失败源保留

运行：python -m pytest tests/test_qingteng_component_sync.py -v
"""
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app.core.qingteng_component_sync as qsync  # noqa: E402
from app.api.v1.govcloud import _columns, _resolve_type  # noqa: E402
from app.core.qingteng_component_sync import (  # noqa: E402
    _iter_source_rows,
    _norm_version,
    _row_to_values,
    build_source_id,
    sync_device_components,
)
from app.models.govcloud_asset import GovCloudImportBatch  # noqa: E402
from app.models.qingteng_component import QingtengComponentAsset  # noqa: E402


# ============ 资源类型 / 列 ============

def test_resolve_component_type_with_device():
    base, meta, dev = _resolve_type("qingteng_component:7")
    assert base == "qingteng_component" and dev == 7
    assert meta["source_group"] == "qingteng_component"


def test_resolve_component_type_rejects_malformed():
    for bad in ("qingteng_component:abc", "qingteng_component:"):
        with pytest.raises(HTTPException) as exc:
            _resolve_type(bad)
        assert exc.value.status_code == 400


def test_component_columns():
    cols = _columns("qingteng_component:7")
    keys = [c["key"] for c in cols]
    assert keys[:4] == ["hostname", "display_ip", "os_type", "source_type_label"]
    assert "name" in keys and "version" in keys
    assert any(c["label"] == "组件名" for c in cols)


# ============ source_id / 版本归一化 ============

def test_source_id_stable_on_version_upgrade_with_path():
    base = build_source_id(7, "pkg", "a1", "nginx", "1.20", "/usr/sbin/nginx", None)
    upgraded = build_source_id(7, "pkg", "a1", "nginx", "1.24", "/usr/sbin/nginx", None)
    assert base == upgraded  # 有路径：升级原地更新


def test_source_id_differs_by_path_and_version_without_path():
    a = build_source_id(7, "jar_pkg", "a1", "fastjson", "1.2.83", "/opt/a.jar", None)
    b = build_source_id(7, "jar_pkg", "a1", "fastjson", "1.2.83", "/opt/b.jar", None)
    assert a != b
    c = build_source_id(7, "pkg", "a1", "redis", "6.2.7", "", None)
    d = build_source_id(7, "pkg", "a1", "redis", "7.0.0", "", None)
    assert c != d  # 无路径：多版本共存


def test_normalize_version_placeholders_and_epoch():
    assert _norm_version("1:6.2.7-1") == "6.2.7-1"
    for placeholder in ("", "-", "unknown", "未知", "0.0.0", None):
        assert _norm_version(placeholder) == ""


# ============ 字段映射 ============

def _device():
    return types.SimpleNamespace(
        id=7, name="青藤万相(政务云)", api_url="https://10.0.0.1",
        timeout=5, verify_tls=False,
    )


def test_pkg_windows_prefers_product_version():
    row = {
        "agentId": "a1", "displayIp": "10.0.0.1", "hostname": "pc-01",
        "name": "Google Chrome", "version": "", "productVersion": "120.0.6099.130",
        "publisher": "Google", "path": "C:\\Program Files\\Chrome",
    }
    v = _row_to_values(_device(), row, "pkg", "win", 99, "now")
    assert v["version"] == "120.0.6099.130"
    assert v["version_norm"] == "120.0.6099.130"
    assert v["publisher"] == "Google"
    assert v["source_type"] == "pkg"


def test_app_and_dbinfo_mapping():
    app_row = {
        "agentId": "a1", "name": "redis-server", "version": "6.2.7",
        "binPath": "/usr/bin/redis-server", "uname": "redis",
        "processes": [{"pid": 1}],
    }
    v = _row_to_values(_device(), app_row, "app", "linux", 1, "now")
    assert v["path"] == "/usr/bin/redis-server"
    assert v["uname"] == "redis"
    assert "processes" not in v["extra"]  # 大字段不进 extra

    db_row = {"agentId": "a2", "name": "MySQL", "version": "8.0.36", "port": 3306, "protoType": "tcp"}
    dbv = _row_to_values(_device(), db_row, "dbinfo", "linux", 1, "now")
    assert dbv["port"] == 3306
    assert dbv["component_type"] == "tcp"


def test_row_to_values_requires_agent_and_name():
    assert _row_to_values(_device(), {"agentId": "", "name": "redis"}, "pkg", "linux", 1, "now") is None
    assert _row_to_values(_device(), {"agentId": "a1", "name": ""}, "pkg", "linux", 1, "now") is None


# ============ 分页 ============

class _FakeResp:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, rows, total):
        self.rows = rows
        self.total = total
        self.calls = 0

    def get(self, url, headers=None):
        self.calls += 1
        # 模拟接口忽略分页：每次都返回同一批数据
        return _FakeResp({"success": True, "rows": self.rows, "total": self.total})


def test_iter_source_rows_stops_when_api_ignores_paging():
    rows = [{"id": i, "agentId": "a1", "name": f"pkg{i}", "version": "1.0"} for i in range(500)]
    client = _FakeClient(rows, total=800)
    stats = {}
    result = list(_iter_source_rows(
        client, "https://qt", "c", "j", "s", "pkg", "linux", stats,
    ))
    assert len(result) == 500  # 第二页重复，去重后提前退出
    assert client.calls == 2
    assert stats["rows"] == 500
    assert stats.get("truncated") is not True


def test_iter_source_rows_marks_truncated(monkeypatch):
    monkeypatch.setitem(qsync.MAX_ROWS_PER_SOURCE, "pkg", 3)
    rows = [{"id": i, "agentId": "a1", "name": f"pkg{i}", "version": "1.0"} for i in range(10)]
    client = _FakeClient(rows, total=10)
    stats = {}
    result = list(_iter_source_rows(
        client, "https://qt", "c", "j", "s", "pkg", "linux", stats,
    ))
    assert len(result) == 3
    assert stats["truncated"] is True


# ============ sync_device_components：批次 / full 删除 / 失败降级 ============

class _FakeQuery:
    def __init__(self, db, model):
        self.db = db
        self.model = model

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def first(self):
        if self.model is GovCloudImportBatch:
            return self.db.batch
        return None

    def all(self):
        return []

    def delete(self, synchronize_session=False):
        self.db.deleted_models.append(self.model)
        return 0

    def scalar(self):
        return self.db.scalars.pop(0) if self.db.scalars else 0


class _FakeDB:
    def __init__(self, scalars=None):
        self.batch = GovCloudImportBatch(
            id=96, resource_type="qingteng_component:7", status="pending",
        )
        self.executed = []
        self.deleted_models = []
        self.scalars = list(scalars or [])
        self.commits = 0
        self.rollbacks = 0

    def query(self, model):
        return _FakeQuery(self, model)

    def execute(self, stmt):
        self.executed.append(stmt)

    def add(self, obj):  # pragma: no cover - sync_device_components 不新增批次
        pass

    def flush(self):
        pass

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _pkg_rows():
    return [
        {"agentId": "a1", "hostname": "h1", "name": "redis-server", "version": "6.2.7"},
        {"agentId": "a1", "hostname": "h1", "name": "nginx", "version": "1.20.1"},
    ]


def _app_rows():
    return [{"agentId": "a2", "hostname": "h2", "name": "redis", "version": "6.2.7"}]


def _patch_sync(monkeypatch, fail_sources=frozenset()):
    monkeypatch.setattr(qsync, "_qingteng_login", lambda *a, **kw: ("c", "j", "s"))
    monkeypatch.setattr(qsync, "record_device_call", lambda *a, **kw: None)

    def fake_iter(client, base_url, comid, jwt, signkey, source_type, os_type, stats):
        if source_type in fail_sources:
            raise RuntimeError("boom")
        rows = []
        if os_type == "linux" and source_type == "pkg":
            rows = _pkg_rows()
        elif os_type == "linux" and source_type == "app":
            rows = _app_rows()
        for row in rows:
            stats["rows"] = stats.get("rows", 0) + 1
            yield row

    monkeypatch.setattr(qsync, "_iter_source_rows", fake_iter)


def test_sync_device_components_success(monkeypatch):
    _patch_sync(monkeypatch)
    db = _FakeDB(scalars=[3, 3])
    result = sync_device_components(db, _device(), 96, mode="full")

    assert result["status"] == "success"
    assert db.batch.status == "success"
    assert db.batch.percent == 100
    assert db.batch.excel_rows == 3
    assert db.batch.unique_source_ids == 3
    assert db.batch.inserted == 3
    assert result["consistent"] is True
    # 五类来源全部成功 → 各删除一次旧批次行
    assert len(db.deleted_models) == 5
    assert all(m is QingtengComponentAsset for m in db.deleted_models)


def test_sync_device_components_partial_keeps_failed_source(monkeypatch):
    _patch_sync(monkeypatch, fail_sources=frozenset({"app"}))
    db = _FakeDB(scalars=[2, 2])
    result = sync_device_components(db, _device(), 96, mode="full")

    assert result["status"] == "partial"
    assert result["stats"]["failed_sources"] == ["app"]
    assert db.batch.excel_rows == 2  # 只有 pkg 的 2 行
    # 失败来源不执行删除（其余 4 类成功）
    assert len(db.deleted_models) == 4
    assert db.rollbacks >= 1
    assert result["consistent"] is False
