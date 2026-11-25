"""奇安信天擎终端资产同步的单元测试。

覆盖：
- _resolve_type：tianqing_endpoint:<设备ID> 维度解析与非法后缀拒绝
- _columns：天擎列表列使用中文标签
- _sign_headers：ZEUS-HMAC-SHA256 签名头可被复算校验
- _fmt_ts：ODP UTC 时间转北京时间
- _row_to_values：ODP terminal row → 入库 values 映射

运行：python -m pytest tests/test_tianqing_asset_sync.py -v
"""
import hashlib
import hmac
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.api.v1.govcloud import _columns, _resolve_type  # noqa: E402
from app.core.tianqing_asset_sync import (  # noqa: E402
    _fmt_ts,
    _row_to_values,
    _sign_headers,
)
from app.models.device import Device  # noqa: E402


def _device() -> Device:
    dev = Device(name="天擎测试", auth_type="tianqing", api_key="test-app-key", password="test-app-secret")
    dev.id = 7
    return dev


def test_resolve_type_tianqing_with_device():
    base, meta, dev = _resolve_type("tianqing_endpoint:3")
    assert base == "tianqing_endpoint" and dev == 3
    assert meta["source_group"] == "tianqing_endpoint"


def test_resolve_type_tianqing_rejects_bad_suffix():
    for bad in ("tianqing_endpoint:abc", "tianqing_endpoint:", "tianqing_endpoint:-1"):
        with pytest.raises(HTTPException) as exc:
            _resolve_type(bad)
        assert exc.value.status_code == 400


def test_resolve_type_tianqing_plain():
    base, _, dev = _resolve_type("tianqing_endpoint")
    assert base == "tianqing_endpoint" and dev is None


def test_columns_tianqing_labels():
    cols = _columns("tianqing_endpoint:1")
    keys = [c["key"] for c in cols]
    labels = {c["label"] for c in cols}
    assert keys[0] == "computer_name"
    assert "online_status" in keys and "main_program_version" in keys
    assert "计算机名" in labels and "在线状态" in labels


def test_sign_headers_hmac_sha256():
    auth = _sign_headers(_device())["Authorization"]
    assert auth.startswith("ZEUS-HMAC-SHA256 ")
    fields = dict(
        item.split("=", 1) for item in auth[len("ZEUS-HMAC-SHA256 "):].split(",")
    )
    assert fields["appKey"] == "test-app-key"
    assert fields["version"] == "1.0.0"
    to_sign = (
        f"appKey:{fields['appKey']}&nonce:{fields['nonce']}"
        f"&timestamp:{fields['timestamp']}"
    )
    expected = hmac.new(
        b"test-app-secret", to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    assert fields["signature"] == expected


def test_fmt_ts_utc_to_beijing():
    assert _fmt_ts("2026-11-25T12:18:16.000604820Z") == "2026-11-25 20:18:16"
    assert _fmt_ts("2025-11-21T05:35:47Z") == "2025-11-21 13:35:47"
    assert _fmt_ts("") == ""


def test_row_to_values_mapping():
    row = {
        "key": {"id": "client-1"},
        "meta": {
            "name": "PC-001", "ip": "10.0.0.1", "report_ip": "10.0.0.2",
            "mac": "AA-BB-CC-DD-EE-FF",
            "tos": {
                "os": 2, "arch": 4, "dist": "银河麒麟 V10",
                "version": {"kernel_version": "4.19.71", "version": "V10SP1"},
            },
            "client_type": "xc", "login_account": "root", "domain": "",
            "computer_working_group": "", "system_language": "zh-CN",
            "activation": True, "vendor_field": "keep-me",
        },
        "normal_node": {"relation_entity": {"meta": {"name": "市应急局", "path": ",1,2"}}},
        "online_info": {"is_online": True, "last_time": "2026-11-25T12:18:16Z"},
        "asset_version": {
            "main_program_version": "10.8.0.7006", "virus_version": "6.0.2.6918",
        },
    }
    values = _row_to_values(_device(), row, 0, None)
    assert values["source_id"] == "7:client-1"
    assert values["computer_name"] == "PC-001"
    assert values["os_type"] == "Linux" and values["arch"] == "AArch64"
    assert values["online_status"] is True
    assert values["last_online_time"] == "2026-11-25 20:18:16"
    assert values["group_name"] == "市应急局" and values["group_path"] == ",1,2"
    assert values["main_program_version"] == "10.8.0.7006"
    assert values["extra"] == {"vendor_field": "keep-me"}
