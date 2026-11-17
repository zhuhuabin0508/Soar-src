"""报告中心核心库单测（M0/M1）。

覆盖：
- 模板规格与映射校验；
- docx 占位符/表格循环/章节解析；
- docxtpl 沙箱渲染、必填缺失阻断、产物残留校验；
- JSONPath 抽取、白名单转换、上下文组装、交叉核对；
- 并行采集、超时/鉴权错误分类、可重试策略。

说明：不依赖数据库与真实设备，使用静态数据源与假 fetcher。
"""
from __future__ import annotations

import asyncio
import io

import pytest
from docx import Document

from app.report.collector import (
    SourceResult,
    collect_sources,
)
from app.report.errors import (
    SRC_AUTH,
    SRC_TIMEOUT,
    VAL_REQUIRED_MISSING,
    ReportError,
)
from app.report.manifest import (
    diff_manifests,
    extract_manifest,
    validate_docx_upload,
)
from app.report.renderer import (
    check_rendered_docx,
    render_report,
)
from app.report.spec import (
    validate_data_sources,
    validate_mapping,
    validate_template_spec,
)
from app.report.transform import (
    apply_transforms,
    build_data_context,
    extract_jsonpath,
    run_cross_checks,
)


# --------------------------------------------------------------------------- #
# 测试夹具：内存中构造 Word 模板
# --------------------------------------------------------------------------- #
def _make_template() -> bytes:
    document = Document()
    document.add_heading("一、总体情况", level=1)
    document.add_paragraph("本期告警总数：{{ summary.total_alert }} 起")
    document.add_paragraph("高危漏洞数：{{ vuln.high_count }} 个")

    table = document.add_table(rows=4, cols=2)
    table.cell(0, 0).text = "资产"
    table.cell(0, 1).text = "等级"
    table.cell(1, 0).text = "{%tr for r in table.vuln %}"
    table.cell(2, 0).text = "{{ r.asset }}"
    table.cell(2, 1).text = "{{ r.level }}"
    table.cell(3, 0).text = "{%tr endfor %}"

    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


def _context() -> dict:
    return {
        "summary": {"total_alert": 37},
        "vuln": {"high_count": 5},
        "table": {
            "vuln": [
                {"asset": "10.0.0.1", "level": "高"},
                {"asset": "10.0.0.2", "level": "中"},
            ]
        },
    }


# --------------------------------------------------------------------------- #
# 模板解析
# --------------------------------------------------------------------------- #
def test_extract_manifest_scalar_and_table_loop():
    manifest = extract_manifest(_make_template())

    tokens = {item["token"]: item for item in manifest["placeholders"]}
    assert set(tokens) == {"summary.total_alert", "vuln.high_count", "table.vuln"}

    table = tokens["table.vuln"]
    assert table["type"] == "table"
    assert table["required"] is True
    assert [column["key"] for column in table["columns"]] == ["asset", "level"]
    assert [column["label"] for column in table["columns"]] == ["资产", "等级"]
    assert table["locations"][0]["kind"] == "table_loop"

    assert manifest["format_version"] == 1
    assert manifest["sections"][0]["title"] == "一、总体情况"
    assert manifest["warnings"] == []


def test_validate_docx_upload_rejects_bad_files():
    good = _make_template()
    info = validate_docx_upload("template.docx", good)
    assert info["size"] == len(good)

    with pytest.raises(ReportError):
        validate_docx_upload("template.docm", good)
    with pytest.raises(ReportError):
        validate_docx_upload("template.docx", b"not-a-zip")


def test_diff_manifests_detects_breaking_change():
    old = extract_manifest(_make_template())
    new = extract_manifest(_make_template())
    new["placeholders"] = [
        item for item in new["placeholders"] if item["token"] != "vuln.high_count"
    ]
    diff = diff_manifests(old, new)
    assert "vuln.high_count" in diff["removed"]
    assert diff["breaking"] is True


# --------------------------------------------------------------------------- #
# 规格与映射校验
# --------------------------------------------------------------------------- #
def test_validate_template_spec():
    manifest = extract_manifest(_make_template())
    assert validate_template_spec(manifest) == []

    bad = {
        "format_version": 1,
        "sections": [],
        "placeholders": [
            {"id": "p1", "token": "Total", "type": "text"},
            {"id": "p1", "token": "a.b", "type": "table", "columns": []},
            {"id": "p2", "token": "a.b.c", "type": "unknown"},
        ],
    }
    issues = validate_template_spec(bad)
    messages = " ".join(issue["message"] for issue in issues)
    assert "命名不规范" in messages
    assert "重复" in messages
    assert "前缀冲突" in messages


def test_validate_mapping_and_sources():
    manifest = extract_manifest(_make_template())
    placeholders = manifest["placeholders"]

    mapping = {
        "bindings": [
            {
                "placeholder_id": "p_summary_total_alert",
                "token": "summary.total_alert",
                "source_key": "fw",
                "path": "$.total",
                "transforms": [{"op": "to_int"}],
            }
        ]
    }
    issues = validate_mapping(mapping, placeholders)
    # 两个必填占位符未绑定
    assert any("未绑定" in issue["message"] for issue in issues)

    source_issues = validate_data_sources(
        [{"source_key": "fw", "source_type": "device_action", "action_id": 0}]
    )
    assert source_issues


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #
def test_render_report_with_table_loop():
    manifest = extract_manifest(_make_template())
    result = render_report(_make_template(), _context(), manifest=manifest)

    assert result["checks"]["ok"] is True
    assert result["checks"]["issues"] == []

    rendered = Document(io.BytesIO(result["docx"]))
    text = "\n".join(paragraph.text for paragraph in rendered.paragraphs)
    assert "37" in text
    assert "5" in text
    # 表头 + 两行数据
    assert len(rendered.tables[0].rows) == 3
    assert rendered.tables[0].cell(1, 0).text == "10.0.0.1"


def test_render_report_blocks_missing_required():
    manifest = extract_manifest(_make_template())
    context = _context()
    del context["summary"]

    with pytest.raises(ReportError) as excinfo:
        render_report(_make_template(), context, manifest=manifest)
    assert excinfo.value.code == VAL_REQUIRED_MISSING


def test_render_report_detects_residue():
    # 用一个不在上下文中的变量模拟未替换占位符：StrictUndefined 会直接报错，
    # 这里改为手工构造残留文档验证 L3 校验逻辑。
    document = Document()
    document.add_paragraph("残留：{{ not_resolved }}")
    buffer = io.BytesIO()
    document.save(buffer)

    checks = check_rendered_docx(buffer.getvalue(), {"placeholders": [], "sections": []})
    assert checks["ok"] is False
    assert checks["issues"][0]["code"] == "TPL_RESIDUE"


# --------------------------------------------------------------------------- #
# 抽取与转换
# --------------------------------------------------------------------------- #
def test_extract_and_transforms():
    payload = {"data": {"items": [{"a": "1"}, {"a": "2"}]}}
    assert extract_jsonpath(payload, "data.items[*]") == [{"a": "1"}, {"a": "2"}]

    assert apply_transforms("1,024", [{"op": "to_int"}]) == 1024
    assert apply_transforms(
        "1", [{"op": "map_values", "mapping": {"1": "低", "2": "高"}}]
    ) == "低"
    assert apply_transforms("abcdefgh", [{"op": "mask", "keep_start": 2, "keep_end": 2}]) == "ab****gh"
    assert apply_transforms([1, 2, 3], [{"op": "sum"}]) == 6
    assert apply_transforms(2048, [{"op": "unit_convert", "from_unit": "b", "to_unit": "kb"}]) == 2.0

    with pytest.raises(ReportError):
        apply_transforms(1, [{"op": "exec_shell"}])


def test_build_data_context_with_table_and_lineage():
    bindings = [
        {
            "token": "summary.total_alert",
            "source_key": "fw",
            "path": "$.total",
            "transforms": [{"op": "to_int"}],
            "required": True,
        },
        {
            "token": "table.vuln",
            "source_key": "xdr",
            "path": "$.items[*]",
            "type": "table",
            "columns": {
                "asset": {"path": "host"},
                "level": {
                    "path": "severity",
                    "transforms": [{"op": "map_values", "mapping": {"4": "严重"}}],
                },
            },
            "sort": [{"by": "level", "order": "desc"}],
            "limit": 10,
        },
    ]
    sources = {
        "fw": SourceResult(source_key="fw", ok=True, data={"total": "37"}, response_hash="h1"),
        "xdr": SourceResult(
            source_key="xdr",
            ok=True,
            data={"items": [{"host": "10.0.0.1", "severity": "4"}]},
            response_hash="h2",
        ),
    }
    built = build_data_context(bindings, sources, fetched_at="2026-11-16T10:00:00+08:00")

    assert built["ok"] is True
    assert built["context"]["summary"]["total_alert"] == 37
    assert built["context"]["table"]["vuln"][0] == {"asset": "10.0.0.1", "level": "严重"}
    assert len(built["lineage"]) == 2
    assert built["lineage"][1]["response_hash"] == "h2"


def test_build_data_context_missing_required_fails_without_zero():
    bindings = [
        {
            "token": "summary.total_alert",
            "source_key": "fw",
            "path": "$.total",
            "required": True,
            "on_missing": "fail",
        }
    ]
    sources = {"fw": SourceResult(source_key="fw", ok=True, data={"other": 1})}
    built = build_data_context(bindings, sources)

    assert built["ok"] is False
    assert built["context"]["summary"]["total_alert"] == "—"
    assert built["issues"][0]["severity"] == "error"


def test_cross_checks():
    context = {
        "table": {"vuln": [{"count": 2}, {"count": 3}]},
        "summary": {"total": 5, "percent": 120},
    }
    checks = [
        {
            "type": "sum_equals",
            "detail": "table.vuln",
            "item_field": "count",
            "summary": "summary.total",
        },
        {"type": "range", "field": "summary.percent", "min": 0, "max": 100},
        {"type": "non_negative", "field": "summary.total"},
    ]
    issues = run_cross_checks(context, checks)
    assert [issue["message"] for issue in issues] == ["字段 summary.percent=120.0 超过上限 100"]


# --------------------------------------------------------------------------- #
# 采集
# --------------------------------------------------------------------------- #
def test_collect_sources_static_and_parallel():
    specs = [
        {"source_key": "a", "source_type": "static", "payload": {"total": "{{run.total}}"}},
        {"source_key": "b", "source_type": "static", "payload": {"ok": True}},
        {"source_key": "c", "source_type": "nope"},
    ]
    results = asyncio.run(collect_sources(specs, {"total": 12}))

    assert results["a"].ok is True
    assert results["a"].data == {"total": 12}
    assert results["b"].ok is True
    assert results["c"].ok is False
    assert results["c"].error_code == "SRC_INVALID"


class _FlakyFetcher:
    def __init__(self, error_code: str, succeed_after: int = 99):
        self.error_code = error_code
        self.succeed_after = succeed_after
        self.calls = 0

    async def fetch(self, spec, params):
        self.calls += 1
        if self.calls < self.succeed_after:
            raise ReportError(self.error_code, "mock failure")
        return {"ok": True}, 200


def test_collect_sources_retries_only_retryable():
    flaky = _FlakyFetcher(SRC_TIMEOUT, succeed_after=2)
    specs = [
        {
            "source_key": "a",
            "source_type": "static",
            "retry": {"max_attempts": 2},
        }
    ]
    results = asyncio.run(collect_sources(specs, fetchers={"static": flaky}))
    assert results["a"].ok is True
    assert results["a"].attempts == 2
    assert flaky.calls == 2

    denied = _FlakyFetcher(SRC_AUTH, succeed_after=99)
    results = asyncio.run(
        collect_sources(
            [{"source_key": "b", "source_type": "static", "retry": {"max_attempts": 3}}],
            fetchers={"static": denied},
        )
    )
    assert results["b"].ok is False
    assert results["b"].error_code == SRC_AUTH
    assert results["b"].attempts == 1
    assert denied.calls == 1


def test_collect_sources_timeout():
    class _SlowFetcher:
        async def fetch(self, spec, params):
            await asyncio.sleep(0.05)
            return {}, 200

    results = asyncio.run(
        collect_sources(
            [{"source_key": "slow", "source_type": "static", "timeout_seconds": 0.01}],
            fetchers={"static": _SlowFetcher()},
        )
    )
    assert results["slow"].ok is False
    assert results["slow"].error_code == SRC_TIMEOUT
