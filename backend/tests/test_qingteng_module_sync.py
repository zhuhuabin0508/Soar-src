"""青藤资产明细同步（账号/用户组/Web应用/Web站点）的单元测试。

覆盖：
- 资源类型解析与列定义
- 四类模块字段映射（account/accountgroup/webapp/website）
- source_id 稳定性
- sync_device_modules：批次进度、full 删除成功模块、失败模块保留

运行：python -m pytest tests/test_qingteng_module_sync.py -v
"""
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app.core.qingteng_module_sync as msync  # noqa: E402
from app.api.v1.govcloud import _asset_module_tabs, _columns, _resolve_type  # noqa: E402
from app.core.qingteng_module_sync import _row_to_values, sync_device_modules  # noqa: E402
from app.models.govcloud_asset import GovCloudImportBatch  # noqa: E402
from app.models.qingteng_asset_item import QingtengAssetItem  # noqa: E402


def _device():
    return types.SimpleNamespace(
        id=7, name="青藤万相(安管五部)", api_url="https://10.0.0.1",
        timeout=5, verify_tls=False,
    )


# ============ 资源类型 / 列 / tab ============

def test_resolve_asset_type_with_device():
    base, meta, dev = _resolve_type("qingteng_asset:7")
    assert base == "qingteng_asset" and dev == 7
    assert meta["source_group"] == "qingteng_asset"


def test_resolve_asset_type_rejects_malformed():
    for bad in ("qingteng_asset:abc", "qingteng_asset:"):
        with pytest.raises(HTTPException) as exc:
            _resolve_type(bad)
        assert exc.value.status_code == 400


def test_asset_columns_and_tabs():
    keys = [c["key"] for c in _columns("qingteng_asset:7")]
    assert keys[:4] == ["hostname", "display_ip", "os_type", "module_label"]
    assert "name" in keys and "status" in keys

    tabs = _asset_module_tabs()
    assert [t["value"] for t in tabs] == ["account", "accountgroup", "webapp", "website"]
    assert tabs[0]["label"] == "系统账号"


def test_asset_module_specific_columns():
    account_keys = [c["key"] for c in _columns("qingteng_asset:7", "account")]
    assert "uid" in account_keys and "lastLoginTime" in account_keys
    assert "version" not in account_keys

    website_keys = [c["key"] for c in _columns("qingteng_asset:7", "website")]
    assert "port" in website_keys and "proto" in website_keys


# ============ 字段映射 ============

def test_account_mapping():
    row = {
        "agentId": "a1", "hostname": "h1", "displayIp": "10.0.0.1",
        "name": "root", "status": 1, "home": "/root", "uid": 0, "gid": 0,
    }
    v = _row_to_values(_device(), row, "account", "linux", 99, "now")
    assert v["module"] == "account"
    assert v["name"] == "root"
    assert v["path"] == "/root"
    assert v["status"] == "1"
    assert v["payload"]["uid"] == 0 and v["payload"]["gid"] == 0
    assert v["source_id"].startswith("7:account:a1:")


def test_accountgroup_mapping():
    row = {"agentId": "a1", "name": "sudo", "gid": 27}
    v = _row_to_values(_device(), row, "accountgroup", "linux", 1, "now")
    assert v["name"] == "sudo"
    assert v["payload"]["gid"] == 27


def test_webapp_mapping():
    row = {
        "agentId": "a2", "hostname": "h2", "displayIp": "10.0.0.2",
        "appName": "Tomcat", "version": "9.0.85", "webRoot": "/opt/tomcat/webapps",
        "rootPath": "/", "serverName": "tomcat", "domainName": "app.example.com",
    }
    v = _row_to_values(_device(), row, "webapp", "linux", 1, "now")
    assert v["name"] == "Tomcat"
    assert v["version"] == "9.0.85"
    assert v["path"] == "/opt/tomcat/webapps"
    assert v["payload"]["domainName"] == "app.example.com"


def test_website_synthesizes_name_and_port():
    row = {
        "agentId": "a3", "hostname": "h3", "displayIp": "10.0.0.3",
        "port": 443, "proto": "https", "type": "nginx", "rootPath": "/var/www",
    }
    v = _row_to_values(_device(), row, "website", "linux", 1, "now")
    assert v["name"] == "https:443"
    assert v["port"] == 443
    assert v["path"] == "/var/www"
    assert v["status"] == "nginx"


def test_module_row_requires_agent_and_name():
    assert _row_to_values(_device(), {"agentId": "", "name": "root"}, "account", "linux", 1, "now") is None
    assert _row_to_values(_device(), {"agentId": "a1", "name": ""}, "account", "linux", 1, "now") is None


def test_source_id_stable_for_same_account():
    row = {"agentId": "a1", "name": "root", "home": "/root"}
    a = _row_to_values(_device(), row, "account", "linux", 1, "now")["source_id"]
    b = _row_to_values(_device(), row, "account", "linux", 2, "later")["source_id"]
    assert a == b


# ============ sync_device_modules ============

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
            id=97, resource_type="qingteng_asset:7", status="pending",
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

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _patch_sync(monkeypatch, fail_modules=frozenset()):
    monkeypatch.setattr(msync, "_qingteng_login", lambda *a, **kw: ("c", "j", "s"))
    monkeypatch.setattr(msync, "record_device_call", lambda *a, **kw: None)

    def fake_iter(client, base_url, comid, jwt, signkey, path, limit, stats):
        if any(f"/{m}/" in path for m in fail_modules):
            raise RuntimeError("boom")
        rows = []
        if path.endswith("/account/linux"):
            rows = [
                {"agentId": "a1", "name": "root", "home": "/root", "status": 1},
                {"agentId": "a1", "name": "redis", "home": "/var/lib/redis", "status": 1},
            ]
        elif path.endswith("/webapp/linux"):
            rows = [{"agentId": "a2", "appName": "Tomcat", "version": "9.0.85"}]
        for row in rows:
            stats["rows"] = stats.get("rows", 0) + 1
            yield row

    monkeypatch.setattr(msync, "iter_paged_rows", fake_iter)


def test_sync_device_modules_success(monkeypatch):
    _patch_sync(monkeypatch)
    db = _FakeDB(scalars=[3, 3])
    result = sync_device_modules(db, _device(), 97, mode="full")

    assert result["status"] == "success"
    assert db.batch.status == "success"
    assert db.batch.percent == 100
    assert db.batch.excel_rows == 3
    assert db.batch.unique_source_ids == 3
    # 四个模块全部成功 → 各删除一次旧批次行
    assert len(db.deleted_models) == 4
    assert all(m is QingtengAssetItem for m in db.deleted_models)


def test_sync_device_modules_partial_keeps_failed_module(monkeypatch):
    _patch_sync(monkeypatch, fail_modules=frozenset({"webapp"}))
    db = _FakeDB(scalars=[2, 2])
    result = sync_device_modules(db, _device(), 97, mode="full")

    assert result["status"] == "partial"
    assert result["stats"]["failed_modules"] == ["webapp"]
    assert db.batch.excel_rows == 2  # 只有 account 的 2 行
    assert len(db.deleted_models) == 3  # 失败模块不删除
    assert db.rollbacks >= 1
    assert result["consistent"] is False
