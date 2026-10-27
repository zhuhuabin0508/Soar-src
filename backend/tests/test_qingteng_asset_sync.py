"""青藤主机资产发现的单元测试。

覆盖：
- _resolve_type：qingteng_host:<设备ID> 维度解析与非法格式拒绝
- _row_to_values：青藤 API row → 入库 values 映射（agentId 唯一键/状态标签/extra 兜底）
- _fetch_all_hosts：linux + win 分页拉取与终止条件
- sync 接口：无设备 400 / 设备不存在 404 的前置校验

运行：python -m pytest tests/test_qingteng_asset_sync.py -v
"""
import json
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.api.v1.govcloud import (  # noqa: E402
    QingtengSyncRequest,
    _columns,
    _resolve_type,
    sync_qingteng_hosts,
)
from app.core.qingteng_asset_sync import (  # noqa: E402
    _agent_status_label,
    _fetch_all_hosts,
    _fmt_ts,
    _row_to_values,
    sync_device_hosts,
)


# ============ _resolve_type：资源类型维度解析 ============

def test_resolve_type_plain():
    base, meta, dev = _resolve_type("cloud_host")
    assert base == "cloud_host" and dev is None and meta["label"] == "云主机"


def test_resolve_type_qingteng_with_device():
    base, meta, dev = _resolve_type("qingteng_host:3")
    assert base == "qingteng_host" and dev == 3 and meta["source_group"] == "qingteng_host"


def test_resolve_type_qingteng_without_device():
    base, _, dev = _resolve_type("qingteng_host")
    assert base == "qingteng_host" and dev is None


def test_resolve_type_rejects_unknown():
    with pytest.raises(HTTPException) as exc:
        _resolve_type("nonexistent_type")
    assert exc.value.status_code == 400


def test_resolve_type_rejects_device_suffix_on_excel_types():
    with pytest.raises(HTTPException) as exc:
        _resolve_type("cloud_host:1")
    assert exc.value.status_code == 400


def test_resolve_type_rejects_malformed_device_suffix():
    for bad in ("qingteng_host:abc", "qingteng_host:-1", "qingteng_host:"):
        with pytest.raises(HTTPException) as exc:
            _resolve_type(bad)
        assert exc.value.status_code == 400


def test_columns_qingteng_uses_list_fields():
    cols = _columns("qingteng_host:1")
    keys = [c["key"] for c in cols]
    assert keys[0] == "hostname"
    assert "agent_status_label" in keys
    labels = {c["label"] for c in cols}
    assert "主机名" in labels and "Agent 状态" in labels


# ============ _row_to_values：API row → 入库 values ============

def _fake_device():
    return types.SimpleNamespace(id=7, name="青藤万相-政务云")


def _sample_row():
    # 字段口径取自 scripts/qingteng_api_manual.txt「主机信息查询结果」返回示例
    return {
        "agentId": "70db8ef89e9ae79a",
        "displayIp": "172.16.2.231",
        "connectionIp": "172.16.2.231",
        "externalIp": None,
        "internalIp": None,
        "bizGroupId": None,
        "bizGroup": "被删除分组",
        "remark": None,
        "hostTagList": ["test-test000", "tmp"],
        "hostname": "qingteng",
        "proxyIp": None,
        "platform": "Ubuntu 16.04.2 LTS",
        "kernelVersion": "4.13.0-26-generic",
        "cpu": {"core": 4, "brand": "Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"},
        "memorySize": 980,
        "onlineStatus": 1,
        "agentStatus": 0,
        "lastOnlineTime": "2018-04-01 11:00:00",
        "agentVersion": "3.0.7-3.34.0",
        "offlineDays": 0,
        "chargeName": "qingteng",
        "hostLocation": "wuhan",
        "systemLoad": 1,
        "memories": [{"size": 980}],
        "manufacturer": "",
        "productName": "",
        "serialNumber": "VMware-56 4d",
        "networkCards": [{"name": "eth0", "mac": "00:50:56:36:35:bb", "ipv4": "192.168.78.131"}],
        "diskSize": 51200,
        "diskUsage": 0.6096,
        "diskCount": 4,
    }


def test_row_to_values_full_mapping():
    v = _row_to_values(_fake_device(), _sample_row(), "linux", 99, "now")
    assert v["source_id"] == "7:70db8ef89e9ae79a"  # {device_id}:{agentId}
    assert v["qingteng_device_id"] == 7
    assert v["qingteng_device_name"] == "青藤万相-政务云"
    assert v["batch_id"] == 99
    assert v["agent_id"] == "70db8ef89e9ae79a"
    assert v["os_type"] == "linux"
    assert v["hostname"] == "qingteng"
    assert v["display_ip"] == "172.16.2.231"
    assert v["platform"] == "Ubuntu 16.04.2 LTS"
    assert v["agent_status"] == 0
    assert v["agent_status_label"] == "在线"
    assert v["last_online_time"] == "2018-04-01 11:00:00"
    assert v["host_tag_list"] == ["test-test000", "tmp"]
    assert v["cpu_core"] == 4
    assert v["memory_size"] == 980
    assert v["disk_usage"] == 0.6096
    assert v["serial_number"] == "VMware-56 4d"
    assert v["network_cards"] == [{"name": "eth0", "mac": "00:50:56:36:35:bb", "ipv4": "192.168.78.131"}]


def test_row_to_values_extra_keeps_unknown_fields():
    # 未映射字段（memories/systemLoad 等）进 extra，青藤升级新增字段不丢
    v = _row_to_values(_fake_device(), _sample_row(), "win", 1, "now")
    assert "memories" in v["extra"]
    assert "systemLoad" in v["extra"]
    # 已消费字段不进 extra
    for k in ("agentId", "hostname", "cpu", "networkCards", "diskSize"):
        assert k not in v["extra"]


def test_row_to_values_missing_agent_id_returns_none():
    row = _sample_row()
    row["agentId"] = ""
    assert _row_to_values(_fake_device(), row, "linux", 1, "now") is None
    row["agentId"] = None
    assert _row_to_values(_fake_device(), row, "linux", 1, "now") is None


def test_row_to_values_agent_status_labels():
    row = _sample_row()
    for status, label in ((0, "在线"), (1, "离线"), (2, "停用"), (9, ""), (None, "")):
        row["agentStatus"] = status
        v = _row_to_values(_fake_device(), row, "linux", 1, "now")
        assert v["agent_status_label"] == label


def test_row_to_values_source_id_unique_across_devices():
    # 同一 agentId 在不同青藤平台 → source_id 带设备前缀，互不冲突
    v1 = _row_to_values(types.SimpleNamespace(id=1, name="A"), _sample_row(), "linux", 1, "now")
    v2 = _row_to_values(types.SimpleNamespace(id=2, name="B"), _sample_row(), "linux", 1, "now")
    assert v1["source_id"] != v2["source_id"]
    assert v1["source_id"].startswith("1:") and v2["source_id"].startswith("2:")


def test_agent_status_label_direct():
    assert _agent_status_label(0) == "在线"
    assert _agent_status_label("1") == "离线"
    assert _agent_status_label(2) == "停用"
    assert _agent_status_label(None) == ""
    assert _agent_status_label("bad") == ""


def test_fmt_ts():
    assert _fmt_ts(None) == ""
    assert _fmt_ts("") == ""
    assert _fmt_ts("2018-04-01 11:00:00") == "2018-04-01 11:00:00"
    assert _fmt_ts("2018-04-01T11:00:00") == "2018-04-01 11:00:00"  # ISO T → 空格
    assert _fmt_ts("2018-04-01 11:00:00.123") == "2018-04-01 11:00:00"  # 截断毫秒


# ============ _fetch_all_hosts：分页拉取与终止条件 ============

class _FakeResp:
    def __init__(self, data):
        self.status_code = 200
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


class _FakeClient:
    """按调用顺序返回预置分页响应，记录请求 URL。"""

    def __init__(self, linux_pages, win_pages):
        self.pages = {"linux": list(linux_pages), "win": list(win_pages)}
        self.calls = []

    def get(self, url, headers=None):
        self.calls.append(url)
        os_type = "linux" if "/host/linux" in url else "win"
        # 不注入 success 字段：数据 API 成功响应就是 {total, rows}（真实契约）
        return _FakeResp(self.pages[os_type].pop(0))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _host_row(i):
    return {"agentId": f"agent-{i}", "hostname": f"host-{i}", "displayIp": f"10.0.0.{i}"}


def test_fetch_all_hosts_pagination(monkeypatch):
    # PAGE_SIZE 缩为 2：linux 3 行分 2 页（2+1），win 1 行 1 页
    import app.core.qingteng_asset_sync as sync_mod
    monkeypatch.setattr(sync_mod, "PAGE_SIZE", 2)
    monkeypatch.setattr(
        sync_mod, "_qingteng_signheaders",
        lambda comid, jwt, signkey, method, params, body, url: (None, None, url),
    )
    client = _FakeClient(
        linux_pages=[{"total": 3, "rows": [_host_row(1), _host_row(2)]}, {"total": 3, "rows": [_host_row(3)]}],
        win_pages=[{"total": 1, "rows": [_host_row(4)]}],
    )
    entries = _fetch_all_hosts(client, "http://qt", "c", "j", "s")
    assert len(entries) == 4
    assert [e[0] for e in entries] == ["linux", "linux", "linux", "win"]
    linux_urls = [u for u in client.calls if "linux" in u]
    win_urls = [u for u in client.calls if "linux" not in u]
    assert len(linux_urls) == 2 and len(win_urls) == 1  # 短页即终止，不多拉


def test_fetch_all_hosts_api_error_raises(monkeypatch):
    import app.core.qingteng_asset_sync as sync_mod
    monkeypatch.setattr(
        sync_mod, "_qingteng_signheaders",
        lambda comid, jwt, signkey, method, params, body, url: (None, None, url),
    )
    # 真实错误格式：{errorCode, errorMessage}（HTTP 200 时也按失败处理）
    client = _FakeClient(
        linux_pages=[{"errorCode": 401, "errorMessage": "sign error", "detail": None}],
        win_pages=[],
    )
    with pytest.raises(RuntimeError) as exc:
        _fetch_all_hosts(client, "http://qt", "c", "j", "s")
    assert "sign error" in str(exc.value)
    assert "401" in str(exc.value)


def test_fetch_all_hosts_accepts_response_without_success_flag(monkeypatch):
    """回归：成功响应是 {total, rows}，没有 success 字段（与登录接口契约不同）。

    历史 bug：照搬登录接口的 success 判断，把真实成功响应当错误
    （报"青藤主机查询失败: {'rows': ...}"）。
    """
    import app.core.qingteng_asset_sync as sync_mod
    monkeypatch.setattr(
        sync_mod, "_qingteng_signheaders",
        lambda comid, jwt, signkey, method, params, body, url: (None, None, url),
    )
    client = _FakeClient(
        linux_pages=[{"total": 1, "rows": [_host_row(1)]}],
        win_pages=[{"total": 0, "rows": []}],
    )
    entries = _fetch_all_hosts(client, "http://qt", "c", "j", "s")
    assert [(e[0], e[1]["agentId"]) for e in entries] == [("linux", "agent-1")]


def test_fetch_all_hosts_rejects_unknown_shape(monkeypatch):
    """防御：HTTP 200 但既无 rows/total 也无错误码 → 报格式异常而非静默当空。"""
    import app.core.qingteng_asset_sync as sync_mod
    monkeypatch.setattr(
        sync_mod, "_qingteng_signheaders",
        lambda comid, jwt, signkey, method, params, body, url: (None, None, url),
    )
    client = _FakeClient(linux_pages=[{"unexpected": True}], win_pages=[])
    with pytest.raises(RuntimeError) as exc:
        _fetch_all_hosts(client, "http://qt", "c", "j", "s")
    assert "格式异常" in str(exc.value)


def test_fetch_all_hosts_http_error_raises(monkeypatch):
    import app.core.qingteng_asset_sync as sync_mod
    monkeypatch.setattr(
        sync_mod, "_qingteng_signheaders",
        lambda comid, jwt, signkey, method, params, body, url: (None, None, url),
    )

    class _ErrResp:
        status_code = 500
        text = "server error"

    class _ErrClient:
        def get(self, url, headers=None):
            return _ErrResp()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    with pytest.raises(RuntimeError) as exc:
        _fetch_all_hosts(_ErrClient(), "http://qt", "c", "j", "s")
    assert "HTTP 500" in str(exc.value)


# ============ 同步接口前置校验 ============

class _EmptyQuery:
    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def all(self):
        return []


class _EmptyDB:
    def query(self, *a, **k):
        return _EmptyQuery()


def _fake_user():
    return types.SimpleNamespace(id=1, username="tester")


def test_sync_no_devices_rejected():
    with pytest.raises(HTTPException) as exc:
        sync_qingteng_hosts(
            payload=QingtengSyncRequest(device_ids=[], mode="full"),
            request=None, db=_EmptyDB(), user=_fake_user(),
        )
    assert exc.value.status_code == 400
    assert "设备管理" in exc.value.detail  # 提示到设备管理配置


def test_sync_unknown_device_rejected():
    with pytest.raises(HTTPException) as exc:
        sync_qingteng_hosts(
            payload=QingtengSyncRequest(device_ids=[99], mode="full"),
            request=None, db=_EmptyDB(), user=_fake_user(),
        )
    assert exc.value.status_code == 404
    assert "99" in exc.value.detail


# ============ sync_device_hosts：成功路径与 base_url 回归 ============

class _SyncQuery:
    """够用的 query 桩：all/scalar/delete 全空（空库）。"""

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def all(self):
        return []

    def scalar(self):
        return 0

    def delete(self, *a, **k):
        return 0


class _SyncDB:
    """sync_device_hosts 成功路径所需的最小 db 桩（add/flush/commit/rollback/query）。"""

    def __init__(self):
        self.added = []

    def query(self, *a, **k):
        return _SyncQuery()

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        if getattr(self.added[-1], "id", None) is None:
            self.added[-1].id = 1

    def commit(self):
        pass

    def rollback(self):
        pass


class _RecordingHttpx:
    """替代 sync 模块里的 httpx.Client：记录拉取 URL，返回空主机清单。"""

    calls = []

    def __init__(self, timeout=None, verify=None):
        _RecordingHttpx.calls = []

    def get(self, url, headers=None):
        _RecordingHttpx.calls.append(url)
        return _FakeResp({"success": True, "total": 0, "rows": []})

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_sync_device_hosts_passes_real_base_url(monkeypatch):
    """回归：validate_outbound_url 通过时返回 None，base_url 必须仍取 device.api_url。

    历史 bug：把校验函数返回值赋给 base_url → None/external/api/... → httpx 报
    "Request URL is missing an 'http://' or 'https://' protocol"。
    """
    import app.core.qingteng_asset_sync as sync_mod

    monkeypatch.setattr(sync_mod, "_qingteng_login", lambda dev, t, v: ("c", "j", "s"))
    monkeypatch.setattr(sync_mod, "httpx", types.SimpleNamespace(Client=_RecordingHttpx))

    device = types.SimpleNamespace(
        id=7, name="青藤万相", api_url="http://qt-base", timeout=30, verify_tls=False,
        status="unknown", last_test_error=None, last_heartbeat=None, last_test_latency_ms=None,
    )
    summary = sync_device_hosts(_SyncDB(), device, user_id=1, mode="full")
    # 请求 URL 必须带真实 base（linux + win 各拉一页空清单）
    assert len(_RecordingHttpx.calls) == 2
    assert all(
        u.startswith("http://qt-base/external/api/assets/host/") for u in _RecordingHttpx.calls
    )
    assert {"linux", "win"} == {
        "linux" if "/host/linux" in u else "win" for u in _RecordingHttpx.calls
    }
    assert summary["device_id"] == 7
    assert summary["consistent"] is True
    assert device.status == "online"  # 同步成功记一次心跳
