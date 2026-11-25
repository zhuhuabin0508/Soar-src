"""奇安信天擎组件（终端软件）同步的单元测试。

覆盖：
- _resolve_type：tianqing_software:<设备ID> 维度解析
- _columns：天擎组件列表列使用中文标签
- _norm_text / _norm_version：名称与版本归一化
- build_source_id：软件身份稳定、升级原地更新
- _row_to_values：ODP 软件 row → 入库 values 映射
- fetch_client_software：分页拉取与 null 响应保护

运行：python -m pytest tests/test_tianqing_software_sync.py -v
"""
import os
import sys
import types

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.api.v1.govcloud import _columns, _resolve_type  # noqa: E402
from app.core import tianqing_software_sync as sync_mod  # noqa: E402
from app.core.tianqing_software_sync import (  # noqa: E402
    PAGE_SIZE,
    _fmt_install_time,
    _norm_text,
    _norm_version,
    _row_to_values,
    _software_query,
    build_source_id,
    fetch_client_software,
)
from app.models.device import Device  # noqa: E402


def _device() -> Device:
    dev = Device(name="天擎测试", auth_type="tianqing", api_key="test-app-key", password="test-app-secret")
    dev.id = 7
    return dev


def _endpoint():
    return types.SimpleNamespace(
        client_id="client-1",
        computer_name="PC-001",
        ip="10.0.0.1",
        os_type="Linux",
        group_name="市应急局",
    )


def test_resolve_type_tianqing_software_with_device():
    base, meta, dev = _resolve_type("tianqing_software:3")
    assert base == "tianqing_software" and dev == 3
    assert meta["source_group"] == "tianqing_software"


def test_resolve_type_tianqing_software_plain():
    base, _, dev = _resolve_type("tianqing_software")
    assert base == "tianqing_software" and dev is None


def test_columns_tianqing_software_labels():
    cols = _columns("tianqing_software:1")
    keys = [c["key"] for c in cols]
    labels = {c["label"] for c in cols}
    assert keys[0] == "computer_name"
    assert "soft_name" in keys and "version" in keys
    assert "计算机名" in labels and "软件名" in labels and "版本" in labels


def test_norm_text_and_version():
    assert _norm_text("  OpenSSL ") == "openssl"
    assert _norm_version("1:1.1.1k-1.el7") == "1.1.1k-1.el7"
    assert _norm_version("未知") == ""
    assert _norm_version("") == ""


def test_fmt_install_time_epoch_and_placeholder():
    # 天擎真实返回 Unix 秒级时间戳字符串
    assert _fmt_install_time("1630804084") == "2021-09-05 09:08:04"
    assert _fmt_install_time("0") == ""
    assert _fmt_install_time("") == ""
    assert _fmt_install_time("2025-11-21T05:35:47Z") == "2025-11-21 13:35:47"


def test_build_source_id_stable_and_version_upgrade_in_place():
    # soft_id 存在时：升级版本不改变身份（原地更新）
    a = build_source_id(7, "client-1", "100", "openssl", "1.1.1k")
    b = build_source_id(7, "client-1", "100", "openssl", "3.0.1")
    assert a == b
    # 无 soft_id 时：名称+版本区分多个版本
    c = build_source_id(7, "client-1", "", "openssl", "1.1.1k")
    d = build_source_id(7, "client-1", "", "openssl", "3.0.1")
    assert c != d
    # 不同终端身份不同
    assert a != build_source_id(7, "client-2", "100", "openssl", "1.1.1k")


def test_software_query_contains_client_and_paging():
    query = _software_query("client-1", "oid-1", "asset-1", 1000, 2000)
    assert 'id:"client-1"' in query
    assert 'oid:"oid-1"' in query and 'id:"asset-1"' in query
    assert "limit:1000" in query and "offset:2000" in query
    assert "soft_name" in query and "newest_ver" in query


def test_row_to_values_mapping():
    row = {
        "corp": "麒麟软件",
        "install_time": "2025-11-21T05:35:47Z",
        "soft_name": "ukui-about",
        "version": "1.0.0-20",
        "soft_id": {"id": "9001"},
        "install_source": "repo",
        "is_update": False,
        "license": "1",
        "newest_ver": "1.0.1",
        "size": "1024",
        "vendor_field": "keep-me",
    }
    values = _row_to_values(_device(), _endpoint(), row, 3, None)
    assert values["source_id"] == build_source_id(7, "client-1", "9001", "ukui-about", "1.0.0-20")
    assert values["tianqing_device_id"] == 7
    assert values["computer_name"] == "PC-001" and values["ip"] == "10.0.0.1"
    assert values["soft_name"] == "ukui-about" and values["version"] == "1.0.0-20"
    assert values["soft_id"] == "9001" and values["corp"] == "麒麟软件"
    assert values["install_time"] == "2025-11-21 13:35:47"
    assert values["is_update"] is False
    assert values["batch_id"] == 3
    assert values["extra"] == {"vendor_field": "keep-me"}


def test_row_to_values_skips_missing_name():
    assert _row_to_values(_device(), _endpoint(), {"version": "1.0"}, 1, None) is None


def test_fetch_client_software_paginates(monkeypatch):
    calls = []

    def fake_gql(device, query, **kwargs):
        calls.append(query)
        if len(calls) == 1:
            return {"softid_clientid": {"collects": [{"soft_name": f"s{i}"} for i in range(PAGE_SIZE)]}}
        return {"softid_clientid": {"collects": [{"soft_name": "tail"}]}}

    monkeypatch.setattr(sync_mod, "_gql", fake_gql)
    rows = fetch_client_software(_device(), "oid", "asset", "client-1")
    assert len(rows) == PAGE_SIZE + 1
    assert len(calls) == 2


def test_fetch_client_software_null_response_raises(monkeypatch):
    monkeypatch.setattr(
        sync_mod, "_gql", lambda device, query, **kwargs: {"softid_clientid": None}
    )
    with pytest.raises(RuntimeError):
        fetch_client_software(_device(), "oid", "asset", "client-1")
