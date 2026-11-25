"""奇安信椒图云锁资产同步的单元测试。

覆盖：
- _resolve_type / _columns：设备维度解析与模块列
- _normalize_base_url：/api 后缀与协议规范化
- _host_values：主机清单字段映射
- _asset_values：安装包 / 端口 / 账号 / 网络连接映射
- fetch_hosts：分页拉取
- fetch_host_detail：空响应保护

运行：python -m pytest tests/test_jiaotu_asset_sync.py -v
"""
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.api.v1.govcloud import _columns, _resolve_type  # noqa: E402
from app.core import jiaotu_asset_sync as sync_mod  # noqa: E402
from app.core.jiaotu_asset_sync import (  # noqa: E402
    _asset_values,
    _host_values,
    _normalize_base_url,
    _to_port,
    fetch_host_detail,
    fetch_hosts,
)
from app.models.device import Device  # noqa: E402


def _device() -> Device:
    dev = Device(name="椒图测试", auth_type="jiaotu", api_key="test-token")
    dev.id = 9
    dev.api_url = "https://10.132.0.1:443/api"
    return dev


def _host():
    return types.SimpleNamespace(
        machine_uuid="u1",
        machine_name="host-10-0-0-1",
        intranet_ip="10.0.0.1",
        extranet_ip="10.76.0.1",
        os_type="Linux",
    )


def test_resolve_type_jiaotu_with_device():
    base, meta, dev = _resolve_type("jiaotu_asset:3")
    assert base == "jiaotu_asset" and dev == 3
    assert meta["source_group"] == "jiaotu_asset"
    base, meta, dev = _resolve_type("jiaotu_host")
    assert base == "jiaotu_host" and dev is None


def test_columns_jiaotu_host_and_asset():
    cols = _columns("jiaotu_host:1")
    keys = [c["key"] for c in cols]
    assert keys[0] == "machine_name"
    assert "intranet_ip" in keys and "online_status" in keys
    asset_cols = _columns("jiaotu_asset:1", "install_package")
    asset_keys = [c["key"] for c in asset_cols]
    assert "name" in asset_keys and "version" in asset_keys and "releaseNo" in asset_keys


def test_normalize_base_url_strips_api_and_scheme():
    assert _normalize_base_url(_device()) == "https://10.132.0.1:443"
    dev = _device()
    dev.api_url = "10.132.0.1:443"
    assert _normalize_base_url(dev) == "https://10.132.0.1:443"


def test_host_values_mapping():
    row = {
        "uuid": "u1",
        "machineName": "host-1",
        "onlineStatus": 1,
        "osType": 1,
        "mac": "aa-bb",
        "ifDelete": 0,
        "intranetIp": "10.0.0.1",
        "extranetIp": "10.76.0.1",
        "advVersion": 1,
        "softwareVersion": "linux_8.0.3",
        "vendorField": "keep-me",
    }
    values = _host_values(_device(), row, 5, None)
    assert values["source_id"] == "9:u1"
    assert values["machine_name"] == "host-1"
    assert values["os_type"] == "Linux" and values["adv_version"] == "增强版"
    assert values["online_status"] is True and values["if_delete"] is False
    assert values["agent_version"] == "linux_8.0.3"
    assert values["extra"] == {"vendorField": "keep-me"}


def test_to_port_first_value():
    assert _to_port("9301/9401/9201") == 9301
    assert _to_port("6379") == 6379
    assert _to_port("0") is None
    assert _to_port("") is None


def test_asset_values_install_package():
    item = {
        "id": "pkg1",
        "installPackageName": "NetworkManager-libnm",
        "installPackageVersion": "1.10.2",
        "releaseNo": "13.el7",
        "installTime": "2018-07-23 17:23:07",
        "installPath": "/usr/lib64/girepository-1.0/",
        "company": "Red Hat",
        "packageSizeStr": "6.1MB",
    }
    values = _asset_values(_device(), _host(), "install_package", item, 5, None)
    assert values["module"] == "install_package"
    assert values["name"] == "NetworkManager-libnm" and values["version"] == "1.10.2"
    assert values["path"] == "/usr/lib64/girepository-1.0/"
    assert values["publisher"] == "Red Hat"
    assert values["install_time"] == "2018-07-23 17:23:07"
    assert values["machine_uuid"] == "u1" and values["machine_name"] == "host-10-0-0-1"
    assert values["payload"]["releaseNo"] == "13.el7"


def test_asset_values_port_account_and_connection():
    port_values = _asset_values(
        _device(), _host(), "port",
        {"id": "p1", "processName": "consul", "port": "8302", "protocal": "tcp", "portStatus": 0},
        1, None,
    )
    assert port_values["name"] == "consul" and port_values["port"] == 8302
    assert port_values["protocol"] == "tcp"

    account_values = _asset_values(
        _device(), _host(), "account",
        {"id": "a1", "userName": "root", "isAdmin": 1, "lastLoginTime": "2025-01-01"},
        1, None,
    )
    assert account_values["name"] == "root" and account_values["status"] == "管理员"

    conn_values = _asset_values(
        _device(), _host(), "network_connection",
        {
            "id": "c1", "processName": "consul", "protocal": "tcp", "ip": "127.0.0.1",
            "port": "8500", "dstIp": "127.0.0.1", "dstPort": "49304",
            "connectStatus": "ESTABLISHED",
        },
        1, None,
    )
    assert conn_values["path"] == "127.0.0.1:8500->127.0.0.1:49304"
    assert conn_values["status"] == "ESTABLISHED"


def test_fetch_hosts_paginates(monkeypatch):
    # 服务端可能限制单页条数（返回 2 条 < PAGE_SIZE），仍应按 total 继续翻页
    pages = {
        1: {"total": 3, "list": [{"uuid": "a"}, {"uuid": "b"}]},
        2: {"total": 3, "list": [{"uuid": "c"}]},
    }

    def fake_post(device, path, payload, **kwargs):
        return pages[payload["currentPage"]]

    monkeypatch.setattr(sync_mod, "_post", fake_post)
    rows, total = fetch_hosts(_device())
    assert total == 3
    assert [r["uuid"] for r in rows] == ["a", "b", "c"]


def test_fetch_host_detail_empty_raises(monkeypatch):
    monkeypatch.setattr(sync_mod, "_post", lambda device, path, payload, **kwargs: {})
    with pytest.raises(RuntimeError):
        fetch_host_detail(_device(), "10.0.0.1")
