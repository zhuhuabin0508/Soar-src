"""资产发现导出（GET /govcloud/export）单元测试。

不依赖真实数据库：用 fake Session 驱动端点的查询链与 jsonb 额外列汇总，
验证 CSV 表头、行序列化、keyword 口径与非法资源类型拦截。
"""
import asyncio
import types
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.dialects import postgresql

from app.api.v1.govcloud import (
    EXPORT_TAIL_COLUMNS,
    _keyword_clauses,
    _row_cells,
    export_govcloud_assets,
)
from app.core.govcloud_schema import RESOURCE_EXCEL_FIELDS
from app.models.govcloud_asset import RESOURCE_MODELS
from app.api.v1.govcloud import RESOURCE_TYPES


class _FakeResult:
    def __init__(self, keys):
        self._keys = list(keys)

    def scalars(self):
        return self._keys


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows
        self.filter_calls = 0

    def filter(self, *args):  # noqa: ARG002
        self.filter_calls += 1
        return self

    def order_by(self, *args):  # noqa: ARG002
        return self

    def limit(self, n):  # noqa: ARG002
        return self

    def all(self):
        return self._rows


class _FakeDB:
    def __init__(self, rows, extra_keys):
        self._rows = rows
        self._extra_keys = extra_keys
        self.queries = []

    def query(self, model):  # noqa: ARG002
        q = _FakeQuery(self._rows)
        self.queries.append(q)
        return q

    def execute(self, stmt):  # noqa: ARG002
        return _FakeResult(self._extra_keys)


def _fake_user():
    return types.SimpleNamespace(id=1, username="tester")


def _drain(resp) -> str:
    """消费 StreamingResponse（兼容同步/异步 body_iterator 两种包装）。"""
    it = resp.body_iterator
    if hasattr(it, "__anext__"):
        async def _collect():
            out = []
            async for chunk in it:
                out.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
            return out
        return "".join(asyncio.run(_collect()))
    return "".join(c if isinstance(c, str) else c.decode("utf-8") for c in it)


def test_keyword_clauses_cover_search_fields():
    model = RESOURCE_MODELS["cloud_host"]
    meta = RESOURCE_TYPES["cloud_host"]
    sql = str(
        or_(*_keyword_clauses(model, meta, "10.0.0.1")).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    # 与列表搜索同口径：source_id / cmdb_id / 搜索字段 / extra_excel 键
    assert "source_id" in sql
    assert "cmdb_id" in sql
    assert "ip_address" in sql
    assert "instance_name" in sql
    assert "extra_excel" in sql
    assert "10.0.0.1" in sql


def test_row_cells_maps_fields_extras_and_tail_columns():
    row = types.SimpleNamespace(
        id=7,
        source_id="src-1",
        cmdb_id="6899c2",
        instance_name="web-01",
        ip_address="10.0.0.1",
        operating_system=None,
        extra_excel={"机柜": "A01"},
        created_at=datetime(2026, 10, 26, 10, 0, 0),
        updated_at=datetime(2026, 10, 26, 11, 30, 0),
    )
    fields = RESOURCE_EXCEL_FIELDS["cloud_host"]
    cells = _row_cells(row, fields, ["机柜"])
    # Excel 字段按定义顺序，_id 映射 cmdb_id；None → 空串
    assert cells[fields.index("_id")] == "6899c2"
    assert cells[fields.index("instance_name")] == "web-01"
    assert cells[fields.index("operating_system")] == ""
    # extra_excel 追加列
    assert cells[fields.index("create_time") + 1] == "A01"
    # 尾部业务列：source_id + datetime 格式化
    tail = cells[-len(EXPORT_TAIL_COLUMNS):]
    assert tail == ["src-1", "2026-10-26 10:00:00", "2026-10-26 11:30:00"]


def test_row_cells_handles_missing_extra_and_attrs():
    row = types.SimpleNamespace(id=1, extra_excel=None)
    cells = _row_cells(row, ["_id", "instance_name"], ["机柜"])
    assert cells == ["", "", "", "", "", ""]


def test_export_rejects_unknown_resource_type():
    with pytest.raises(HTTPException) as exc:
        export_govcloud_assets(
            resource_type="unknown", keyword="", db=None, user=_fake_user(), request=None
        )
    assert exc.value.status_code == 400


def test_export_streams_csv_with_headers_and_rows():
    row = types.SimpleNamespace(
        id=1,
        source_id="src-1",
        cmdb_id="cmdb-1",
        instance_name="web-01",
        ip_address="10.0.0.1",
        extra_excel={"机柜": "A01"},
        created_at=datetime(2026, 10, 26, 10, 0, 0),
        updated_at=datetime(2026, 10, 26, 10, 0, 0),
    )
    db = _FakeDB(rows=[row], extra_keys=["机柜"])
    resp = export_govcloud_assets(
        resource_type="cloud_host", keyword="", db=db, user=_fake_user(), request=None
    )
    assert resp.media_type == "text/csv; charset=utf-8"
    assert "attachment" in resp.headers["content-disposition"]
    body = _drain(resp)
    assert body.startswith("\ufeff")  # BOM
    lines = body.lstrip("\ufeff").splitlines()
    header = lines[0]
    # 表头：Excel 字段 label + 额外列 + 尾部业务列
    assert "CMDB ID" in header and "实例名称" in header and "机柜" in header
    assert header.endswith(",".join(EXPORT_TAIL_COLUMNS))
    assert len(lines) == 2  # 表头 + 1 行数据
    assert "web-01" in lines[1] and "A01" in lines[1] and "src-1" in lines[1]


def test_export_keyword_adds_filter_and_empty_table_only_header():
    db = _FakeDB(rows=[], extra_keys=[])
    resp = export_govcloud_assets(
        resource_type="elastic_ip", keyword="10.0", db=db, user=_fake_user(), request=None
    )
    body = _drain(resp)
    lines = body.lstrip("\ufeff").splitlines()
    assert len(lines) == 1  # 仅表头
    # keyword 非空时数据查询带两个 filter（id 分页 + 关键词）
    assert db.queries and db.queries[0].filter_calls == 2


def test_export_excludes_extra_keys_duplicating_tail_columns():
    # extra_excel 若有与尾部业务列同名的键（爬虫罕见同名列），应被排除避免重复表头
    row = types.SimpleNamespace(id=1, source_id="src-1", extra_excel={"source_id": "dup", "机柜": "A01"})
    db = _FakeDB(rows=[row], extra_keys=["source_id", "created_at", "机柜"])
    resp = export_govcloud_assets(
        resource_type="cloud_host", keyword="", db=db, user=_fake_user(), request=None
    )
    header = _drain(resp).lstrip("\ufeff").splitlines()[0]
    cols = header.split(",")
    assert cols.count("source_id") == 1
    assert "机柜" in cols
    assert "created_at" in cols


def test_export_no_keyword_single_filter():
    db = _FakeDB(rows=[], extra_keys=[])
    resp = export_govcloud_assets(
        resource_type="bare_metal", keyword="  ", db=db, user=_fake_user(), request=None
    )
    _drain(resp)  # 流式生成器是惰性的，需消费响应体驱动查询
    # keyword 空白：仅 id 分页 filter，不构造关键词条件
    assert db.queries and db.queries[0].filter_calls == 1
