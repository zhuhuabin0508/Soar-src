"""资产发现导入 CSV 支持的单元测试（解码 / 解析 / 端点分发）。"""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.v1.govcloud import _decode_csv_bytes, _parse_csv, import_govcloud_excel


def test_decode_utf8_plain():
    assert _decode_csv_bytes("实例名称,IP\nweb-01,1.2.3.4\n".encode("utf-8")) == "实例名称,IP\nweb-01,1.2.3.4\n"


def test_decode_utf8_bom():
    assert _decode_csv_bytes("实例名称,IP\nweb-01,1.2.3.4\n".encode("utf-8-sig")) == "实例名称,IP\nweb-01,1.2.3.4\n"


def test_decode_gbk_fallback():
    # Excel 中文另存 CSV 常见 GBK 编码
    assert _decode_csv_bytes("实例名称,所属部门\nweb-01,测试部门\n".encode("gbk")) == "实例名称,所属部门\nweb-01,测试部门\n"


def test_decode_utf16_rejected():
    with pytest.raises(HTTPException) as exc:
        _decode_csv_bytes("实例名称,IP\n".encode("utf-16"))
    assert exc.value.status_code == 400


def test_parse_csv_basic():
    csv_text = (
        "_id,实例名称,IP 地址,数据统计,所属部门\n"
        "cmdb-1,web-01,10.0.0.1,应跳过,部门A\n"
        "\n"
        "cmdb-2,web-02,10.0.0.2,,部门B\n"
    )
    rows = _parse_csv(csv_text.encode("utf-8"))
    assert len(rows) == 2
    # 中文表头被归一化为英文字段名（实例名称→instance_name、IP 地址/所属部门→别名）
    assert rows[0] == {"_id": "cmdb-1", "instance_name": "web-01", "ip_address": "10.0.0.1", "user_department": "部门A"}
    assert rows[1]["ip_address"] == "10.0.0.2"
    # 空行被跳过；统计类表头（数据统计）被跳过不出现在结果键中
    assert "数据统计" not in rows[0]


def test_parse_csv_short_row_pads_empty():
    rows = _parse_csv("a,b,c\nv1\n".encode("utf-8"))
    assert rows == [{"a": "v1", "b": "", "c": ""}]


def test_parse_csv_empty():
    assert _parse_csv(b"") == []
    assert _parse_csv(b"\n\n") == []


def test_parse_csv_quotes_and_commas():
    rows = _parse_csv('a,b\n"x,1","说""明"""\n'.encode("utf-8"))
    assert rows == [{"a": "x,1", "b": '说"明"'}]


def test_normalize_header():
    from app.api.v1.govcloud import _normalize_header

    assert _normalize_header("实例名称") == "instance_name"
    assert _normalize_header("实例 ID") == "instance_id"       # 带空格
    assert _normalize_header("实例ID") == "instance_id"        # 无空格
    assert _normalize_header(" IP ") == "ip_address"           # FIELD_LABELS 标签（导出表头）
    assert _normalize_header("IP地址") == "ip_address"         # 常见别名
    assert _normalize_header("使用部门") == "user_department"  # FIELD_LABELS 标签
    assert _normalize_header("所属部门") == "user_department"  # 常见别名
    assert _normalize_header("CMDB ID") == "_id"
    assert _normalize_header("operating_system") == "operating_system"  # 英文原样
    # 英文字段名变体：大小写 / 空格 / 驼峰均归一化到标准字段名
    assert _normalize_header("Instance Name") == "instance_name"
    assert _normalize_header("instancename") == "instance_name"
    assert _normalize_header("INSTANCE_NAME") == "instance_name"
    assert _normalize_header("ip address") == "ip_address"
    assert _normalize_header("IP Address") == "ip_address"
    assert _normalize_header("机柜") == "机柜"                  # 未知表头原样（进 extra）
    assert _normalize_header("数据统计") == "数据统计"          # 统计类表头不受影响
    assert _normalize_header("") == ""


def test_parse_csv_chinese_headers_normalized():
    # 导出功能的 CSV 表头是中文标签（FIELD_LABELS），再导入时应映射回英文字段名
    csv_text = (
        "CMDB ID,实例名称,IP,使用部门,操作系统,机柜\n"
        "cmdb-9,web-01,10.0.0.9,部门甲,CentOS 8,A09\n"
    )
    rows = _parse_csv(csv_text.encode("utf-8-sig"))
    assert rows == [{
        "_id": "cmdb-9", "instance_name": "web-01", "ip_address": "10.0.0.9",
        "user_department": "部门甲", "operating_system": "CentOS 8", "机柜": "A09",
    }]


def test_source_id_falls_back_to_source_id_column():
    # source_id 列（导出 CSV 尾部业务列）优先作为唯一标识：回导场景保持标识稳定
    from app.api.v1.govcloud import _source_id

    assert _source_id({"source_id": "sid-1", "ip_address": "10.0.0.1"}) == "sid-1"
    assert _source_id({"_id": "a", "source_id": "b"}) == "b"  # source_id 优先（回导稳定）
    assert _source_id({"_id": "a", "instance_id": "i"}) == "a"  # 正常爬虫文件 _id 优先
    assert _source_id({"ip_address": "10.0.0.1", "instance_name": "w"}) == "10.0.0.1|w"


class _FakeUpload:
    def __init__(self, filename, content=b""):
        self.filename = filename
        self._content = content

    async def read(self):
        return self._content


class _FakeDB:
    def query(self, *a, **k):
        raise AssertionError("不应触达数据库（解析层已提前返回）")


def _fake_user():
    import types

    return types.SimpleNamespace(id=1, username="tester")


def test_import_dispatches_csv_to_csv_parser(monkeypatch):
    called = {"csv": [], "excel": []}
    monkeypatch.setattr("app.api.v1.govcloud._parse_csv", lambda raw: called["csv"].append(1) or [])
    monkeypatch.setattr("app.api.v1.govcloud._parse_excel", lambda raw: called["excel"].append(1) or [])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_govcloud_excel(
            file=_FakeUpload("云主机资产.csv", "a,b\n".encode("utf-8")),
            resource_type="cloud_host", mode="full", request=None,
            db=_FakeDB(), user=_fake_user(),
        ))
    assert exc.value.status_code == 400  # 解析为空 → 400
    assert called["csv"] and not called["excel"]  # 走了 CSV 解析器


def test_import_xlsx_still_uses_excel_parser(monkeypatch):
    called = {"csv": [], "excel": []}
    monkeypatch.setattr("app.api.v1.govcloud._parse_csv", lambda raw: called["csv"].append(1) or [])
    monkeypatch.setattr("app.api.v1.govcloud._parse_excel", lambda raw: called["excel"].append(1) or [])
    with pytest.raises(HTTPException):
        asyncio.run(import_govcloud_excel(
            file=_FakeUpload("云主机资产.xlsx", b"xlsx-bytes"),
            resource_type="cloud_host", mode="full", request=None,
            db=_FakeDB(), user=_fake_user(),
        ))
    assert called["excel"] and not called["csv"]


def test_import_rejects_other_extensions():
    for name in ("云主机资产.xls", "云主机资产.txt", "云主机资产.xlsx.bak"):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(import_govcloud_excel(
                file=_FakeUpload(name), resource_type="cloud_host", mode="full",
                request=None, db=_FakeDB(), user=_fake_user(),
            ))
        assert exc.value.status_code == 400


def test_import_empty_file_rejected():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_govcloud_excel(
            file=_FakeUpload("云主机资产.csv"), resource_type="cloud_host",
            mode="full", request=None, db=_FakeDB(), user=_fake_user(),
        ))
    assert exc.value.status_code == 400


def test_import_all_rows_missing_source_id_rejected(monkeypatch):
    # 全部行识别不出唯一标识 → 400 拒绝（不建批次、不删数据）
    monkeypatch.setattr(
        "app.api.v1.govcloud._parse_csv",
        lambda raw: [{"foo": "1"}, {"foo": "2"}],
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(import_govcloud_excel(
            file=_FakeUpload("云主机资产.csv", b"x"), resource_type="cloud_host",
            mode="full", request=None, db=_FakeDB(), user=_fake_user(),
        ))
    assert exc.value.status_code == 400
    assert "均无法识别唯一标识" in exc.value.detail
