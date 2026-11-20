"""报告中心服务层集成测试（M2）。

用 SQLite 临时库跑通「模板上传 → 发布 → 配置 → 运行 → 产物」全链路，
验证版本固化、幂等、快照与审核状态，不依赖 Postgres / Redis / 真实设备。
"""
from __future__ import annotations

import asyncio
import io

import pytest
from docx import Document
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import database
from app.database import Base
from app.models.report import (
    ReportArtifact,
    ReportConfig,
    ReportConfigVersion,
    ReportRun,
    ReportRunSource,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.report import service
from app.report.ai import (
    build_docx_from_spec,
    sanitize_mapping_suggestions,
    sanitize_template_spec,
)
from app.report.errors import AI_BAD_OUTPUT, CONFLICT, PDF_UNAVAILABLE, ReportError
from app.report.manifest import extract_manifest
from app.report.renderer import render_report
from app.report.spec import validate_template_spec
from app.report.template_from_docx import apply_plan, inspect_docx, sanitize_plan

REPORT_TABLES = [
    ReportTemplate.__table__,
    ReportTemplateVersion.__table__,
    ReportConfig.__table__,
    ReportConfigVersion.__table__,
    ReportRun.__table__,
    ReportRunSource.__table__,
    ReportArtifact.__table__,
]


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


def _make_template_v2() -> bytes:
    """模板升级：vuln.high_count 改名为 vuln.high_count_total，并新增必填占位符。"""
    document = Document()
    document.add_heading("一、总体情况", level=1)
    document.add_paragraph("本期告警总数：{{ summary.total_alert }} 起")
    document.add_paragraph("高危漏洞数：{{ vuln.high_count_total }} 个")
    document.add_paragraph("严重告警数：{{ summary.critical_count }} 起")

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


@pytest.fixture()
def env(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'report.db'}")
    Base.metadata.create_all(engine, tables=REPORT_TABLES)
    session_factory = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", session_factory)
    monkeypatch.setattr(service, "_uploads_root", lambda: str(tmp_path / "uploads"))
    db = session_factory()
    try:
        yield db
    finally:
        db.close()


def _published_template(db) -> ReportTemplate:
    template = service.create_template(
        db, code="monthly_sec", name="月度安全报告", created_by=1
    )
    version = service.add_template_version(
        db,
        template.id,
        filename="monthly.docx",
        content=_make_template(),
        created_by=1,
    )
    service.publish_template_version(db, template.id, version.id, published_by=1)
    return template


def _published_config(db, template: ReportTemplate):
    config = service.create_config(
        db, template_id=template.id, name="月度安全报告-生产", created_by=1
    )
    version = service.save_config_draft(
        db,
        config.id,
        {
            "template_version_id": template.current_version_id,
            "params_schema": [{"name": "period", "required": True, "type": "text"}],
            "data_sources": [
                {
                    "source_key": "static",
                    "source_type": "static",
                    "payload": {
                        "total": 37,
                        "high": 5,
                        "items": [
                            {"host": "10.0.0.1", "level": "高"},
                            {"host": "10.0.0.2", "level": "中"},
                        ],
                    },
                }
            ],
            "mapping": {
                "bindings": [
                    {
                        "token": "summary.total_alert",
                        "source_key": "static",
                        "path": "$.total",
                        "transforms": [{"op": "to_int"}],
                    },
                    {
                        "token": "vuln.high_count",
                        "source_key": "static",
                        "path": "$.high",
                        "transforms": [{"op": "to_int"}],
                    },
                    {
                        "token": "table.vuln",
                        "source_key": "static",
                        "path": "$.items[*]",
                        "type": "table",
                        "columns": {
                            "asset": {"path": "host"},
                            "level": {"path": "level"},
                        },
                    },
                ]
            },
        },
        created_by=1,
    )
    service.publish_config_version(db, config.id, version.id, published_by=1)
    return config


def test_full_run_pipeline(env):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)

    run = service.create_run(
        db,
        config.id,
        params={"period": "2026-11"},
        trigger_type="manual",
        trigger_user_id=1,
        dispatch=False,
    )
    assert run.status == "pending"

    # 幂等：同周期再次触发返回同一条记录
    again = service.create_run(
        db,
        config.id,
        params={"period": "2026-11"},
        trigger_type="schedule",
        dispatch=False,
    )
    assert again.id == run.id

    result = service.execute_run(run.id)
    assert result["status"] == "succeeded", result

    db.expire_all()
    finished = service.get_run(db, run.id)
    assert finished.status == "succeeded"
    assert finished.validation_json["ok"] is True
    assert finished.data_snapshot_json["context"]["summary"]["total_alert"] == 37
    assert finished.data_snapshot_json["lineage"]

    artifact = service.get_artifact(db, finished.artifact_id)
    assert artifact.status == "pending_review"
    content = service.load_artifact_bytes(artifact)
    rendered = Document(io.BytesIO(content))
    text = "\n".join(paragraph.text for paragraph in rendered.paragraphs)
    assert "37" in text and "5" in text
    assert len(rendered.tables[0].rows) == 3

    sources = service.get_run_sources(db, run.id)
    assert len(sources) == 1 and sources[0].source_key == "static"

    approved = service.review_artifact(
        db, artifact.id, action="approve", reviewer_id=1, comment="核对无误"
    )
    assert approved.status == "approved"


def test_incomplete_draft_cannot_publish(env):
    db = env
    template = _published_template(db)
    config = service.create_config(
        db, template_id=template.id, name="未完成配置", created_by=1
    )
    version = service.save_config_draft(
        db,
        config.id,
        {
            "template_version_id": template.current_version_id,
            "data_sources": [],
            "mapping": {"bindings": []},
        },
        created_by=1,
        require_complete=False,
    )
    assert version.status == "draft"

    with pytest.raises(ReportError) as excinfo:
        service.publish_config_version(db, config.id, version.id)
    assert excinfo.value.code == CONFLICT


def test_publish_new_template_reports_impact(env):
    db = env
    template = _published_template(db)
    _published_config(db, template)

    # 新版本移除一个占位符，应识别出存量配置受影响
    document = Document()
    document.add_heading("一、总体情况", level=1)
    document.add_paragraph("本期告警总数：{{ summary.total_alert }} 起")
    output = io.BytesIO()
    document.save(output)
    new_version = service.add_template_version(
        db,
        template.id,
        filename="monthly_v2.docx",
        content=output.getvalue(),
        created_by=1,
    )
    result = service.publish_template_version(
        db, template.id, new_version.id, published_by=1
    )
    assert result["impact"]
    assert any(
        "vuln.high_count" in item["diff"]["removed"] for item in result["impact"]
    )


def test_config_migration_preview_and_apply(env):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)
    base_version = service.list_config_versions(db, config.id)[0]

    new_version = service.add_template_version(
        db,
        template.id,
        filename="monthly_v2.docx",
        content=_make_template_v2(),
        created_by=1,
    )
    service.publish_template_version(db, template.id, new_version.id, published_by=1)

    preview = service.preview_config_migration(db, config.id, new_version.id)
    assert preview["from_template_version_no"] == 1
    assert preview["to_template_version_no"] == 2
    assert {item["token"] for item in preview["kept"]} == {
        "summary.total_alert",
        "table.vuln",
    }
    removed = {item["token"]: item for item in preview["removed"]}
    assert "vuln.high_count" in removed
    assert removed["vuln.high_count"]["candidates"][0]["token"] == "vuln.high_count_total"
    added_tokens = {item["token"] for item in preview["added"]}
    assert {"vuln.high_count_total", "summary.critical_count"} <= added_tokens
    # 新模板新增必填占位符未绑定，发布前应被拦截
    assert "summary.critical_count" in preview["unbound_required"]

    migrated = service.migrate_config_version(
        db,
        config.id,
        target_template_version_id=new_version.id,
        renames={"vuln.high_count": "vuln.high_count_total"},
        created_by=1,
    )
    assert migrated.status == "draft"
    assert migrated.template_version_id == new_version.id
    bindings = {item["token"]: item for item in migrated.mapping_json["bindings"]}
    assert set(bindings) == {"summary.total_alert", "table.vuln", "vuln.high_count_total"}
    assert bindings["table.vuln"]["columns"]["asset"]["path"] == "host"
    # 数据源与参数原样保留
    assert migrated.data_sources_json == base_version.data_sources_json
    assert migrated.params_schema_json == base_version.params_schema_json

    with pytest.raises(ReportError) as excinfo:
        service.publish_config_version(db, config.id, migrated.id)
    assert excinfo.value.code == CONFLICT


def test_config_migration_rejects_same_version(env):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)
    version_id = template.current_version_id

    with pytest.raises(ReportError) as excinfo:
        service.migrate_config_version(
            db, config.id, target_template_version_id=version_id, created_by=1
        )
    assert excinfo.value.code == CONFLICT


# --------------------------------------------------------------------------- #
# AI 辅助（纯函数）
# --------------------------------------------------------------------------- #
def test_ai_template_spec_builds_valid_docx():
    raw = {
        "title": "安全运营周报",
        "sections": [
            {
                "heading": "一、概述",
                "paragraphs": ["本期告警 {{ summary.total_alert }} 起。"],
            },
            {
                "heading": "二、漏洞清单",
                "paragraphs": [],
                "table": {
                    "token": "table.vuln",
                    "columns": [
                        {"key": "asset", "label": "资产", "type": "text"},
                        {"key": "level", "label": "等级", "type": "text"},
                    ],
                },
            },
        ],
    }
    spec = sanitize_template_spec(raw, description="周报")
    content = build_docx_from_spec(spec)
    manifest = extract_manifest(content)

    assert validate_template_spec(manifest) == []
    tokens = {item["token"] for item in manifest["placeholders"]}
    assert tokens == {"summary.total_alert", "table.vuln"}
    table = next(
        item for item in manifest["placeholders"] if item["token"] == "table.vuln"
    )
    assert [column["key"] for column in table["columns"]] == ["asset", "level"]


def test_ai_template_spec_rejects_invalid_token():
    raw = {
        "sections": [
            {"heading": "一、概述", "paragraphs": ["坏占位符 {{ Summary Total }}"]}
        ]
    }
    with pytest.raises(ReportError) as excinfo:
        sanitize_template_spec(raw, description="测试")
    assert excinfo.value.code == AI_BAD_OUTPUT


def test_ai_mapping_suggestions_filtered():
    manifest = {
        "placeholders": [
            {
                "id": "p_summary_total_alert",
                "token": "summary.total_alert",
                "type": "number",
            },
            {
                "id": "p_table_vuln",
                "token": "table.vuln",
                "type": "table",
                "columns": [{"key": "asset"}, {"key": "level"}],
            },
        ]
    }
    raw = {
        "bindings": [
            {
                "token": "summary.total_alert",
                "source_key": "xdr",
                "path": "$.data.total",
                "transforms": [{"op": "to_int"}],
            },
            {
                "token": "table.vuln",
                "source_key": "xdr",
                "path": "$.data.list",
                "columns": {
                    "asset": {"path": "asset"},
                    "unknown": {"path": "x"},
                },
            },
            {"token": "missing.token", "source_key": "xdr", "path": "$.x"},
            {"token": "summary.total_alert", "source_key": "nope", "path": "$.y"},
            {
                "token": "summary.total_alert",
                "source_key": "xdr",
                "path": "data.z",
                "transforms": [{"op": "eval"}],
            },
        ],
        "warnings": ["补充说明"],
    }
    result = sanitize_mapping_suggestions(raw, manifest, {"xdr"})
    by_token = {item["token"]: item for item in result["suggestions"]}

    assert set(by_token) == {"summary.total_alert", "table.vuln"}
    assert by_token["table.vuln"]["columns"] == {
        "asset": {"path": "asset", "transforms": []}
    }
    assert result["stats"] == {"total": 2, "covered": 2, "uncovered": []}
    assert any("unknown" in warning for warning in result["warnings"])
    assert "补充说明" in result["warnings"]


def _static_source() -> dict:
    return {
        "source_key": "static",
        "source_type": "static",
        "payload": {
            "total": 37,
            "high": 5,
            "items": [
                {"host": "10.0.0.1", "level": "高"},
                {"host": "10.0.0.2", "level": "中"},
            ],
        },
    }


def test_config_health_ok_and_missing_binding(env):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)

    health = asyncio.run(service.config_health(db, config.id))
    checks = {item["key"]: item for item in health["checks"]}
    assert health["ok"] is True
    assert health["level"] in {"ok", "warning"}
    assert health["summary"]["error"] == 0
    assert checks["required_bindings"]["status"] == "pass"
    assert checks["data_sources"]["status"] == "pass"
    assert checks["table_columns"]["status"] == "pass"
    assert checks["pdf_export"]["status"] in {"pass", "warning"}

    draft_config = service.create_config(
        db, template_id=template.id, name="不完整配置", created_by=1
    )
    draft = service.save_config_draft(
        db,
        draft_config.id,
        {
            "template_version_id": template.current_version_id,
            "data_sources": [_static_source()],
            "mapping": {
                "bindings": [
                    {
                        "token": "summary.total_alert",
                        "source_key": "static",
                        "path": "$.total",
                    }
                ]
            },
        },
        created_by=1,
    )
    draft_health = asyncio.run(
        service.config_health(db, draft_config.id, version_id=draft.id)
    )
    draft_checks = {item["key"]: item for item in draft_health["checks"]}
    assert draft_health["ok"] is False
    assert draft_checks["required_bindings"]["status"] == "error"
    assert "vuln.high_count" in draft_checks["required_bindings"]["details"]["tokens"]


def test_config_health_probe_static(env):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)

    health = asyncio.run(service.config_health(db, config.id, probe=True))
    checks = {item["key"]: item for item in health["checks"]}
    assert checks["sample_collection"]["status"] == "pass"
    assert checks["mapping_hits"]["status"] == "pass"
    assert health["probe"]["sources"]

    draft_config = service.create_config(
        db, template_id=template.id, name="错误路径配置", created_by=1
    )
    draft = service.save_config_draft(
        db,
        draft_config.id,
        {
            "template_version_id": template.current_version_id,
            "data_sources": [_static_source()],
            "mapping": {
                "bindings": [
                    {
                        "token": "summary.total_alert",
                        "source_key": "static",
                        "path": "$.missing",
                        "on_missing": "fail",
                    }
                ]
            },
        },
        created_by=1,
    )
    draft_health = asyncio.run(
        service.config_health(db, draft_config.id, version_id=draft.id, probe=True)
    )
    draft_checks = {item["key"]: item for item in draft_health["checks"]}
    assert draft_checks["sample_collection"]["status"] == "pass"
    assert draft_checks["mapping_hits"]["status"] == "error"


# --------------------------------------------------------------------------- #
# 从现有报告生成模板
# --------------------------------------------------------------------------- #
def _make_source_report() -> bytes:
    document = Document()
    document.add_heading("某单位 2026 年 10 月安全运营月报", level=0)
    document.add_heading("一、总体情况", level=1)
    document.add_paragraph("本周期共发现告警 37 起，其中高危 12 起，已处置 30 起。")
    document.add_paragraph("报告周期：2026-10-01 至 2026-10-31。")

    header = document.sections[0].header
    paragraph = header.paragraphs[0] if header.paragraphs else header.add_paragraph()
    paragraph.text = "报告编号：SOAR-2026-1024"

    table = document.add_table(rows=4, cols=3)
    for index, label in enumerate(["资产", "等级", "次数"]):
        table.cell(0, index).text = label
    for row_index, values in enumerate(
        [["10.0.0.1", "高", "5"], ["10.0.0.2", "中", "3"], ["10.0.0.3", "低", "1"]],
        start=1,
    ):
        for col_index, value in enumerate(values):
            table.cell(row_index, col_index).text = value

    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


_REPORT_PLAN = {
    "replacements": [
        {"kind": "paragraph", "index": 2, "find": "37", "token": "summary.total_alert"},
        {"kind": "paragraph", "index": 2, "find": "12", "token": "summary.high_alert"},
        {"kind": "paragraph", "index": 2, "find": "30", "token": "summary.handled_alert"},
        {
            "kind": "paragraph",
            "index": 3,
            "find": "2026-10-01 至 2026-10-31",
            "token": "period.range",
        },
        {
            "kind": "header",
            "section": 0,
            "index": 0,
            "find": "SOAR-2026-1024",
            "token": "meta.report_no",
        },
    ],
    "tables": [
        {
            "index": 0,
            "header_row": 0,
            "data_row": 1,
            "remove_rows": [2, 3],
            "loop_token": "table.asset_top",
            "columns": [
                {"label": "资产", "key": "asset"},
                {"label": "等级", "key": "level"},
                {"label": "次数", "key": "count"},
            ],
        }
    ],
    "warnings": ["页脚页码需人工确认"],
}


def test_create_template_from_report(env, monkeypatch):
    import app.report.ai as ai_module

    db = env
    monkeypatch.setattr(
        ai_module,
        "resolve_default_llm",
        lambda db, **kwargs: (object(), {"model": "mock-llm"}),
    )

    async def fake_chat_json(llm, prompt):
        assert "报告编号：SOAR-2026-1024" in prompt
        assert "10.0.0.2" in prompt
        return _REPORT_PLAN

    monkeypatch.setattr(ai_module, "_chat_json", fake_chat_json)

    result = asyncio.run(
        service.create_template_from_report(
            db,
            filename="monthly.docx",
            content=_make_source_report(),
            code="monthly_from_report",
            name="月报（现有报告生成）",
            hint="告警数与资产表格需要动态替换",
            created_by=1,
        )
    )

    assert result["template"].code == "monthly_from_report"
    assert result["version"].source == "ai_from_report"
    assert result["version"].status == "draft"
    assert result["version"].ai_draft_json["mode"] == "from_report"
    assert result["model"] == "mock-llm"
    assert "页脚页码需人工确认" in result["warnings"]

    manifest = result["manifest"]
    tokens = {item["token"] for item in manifest["placeholders"]}
    assert tokens == {
        "summary.total_alert",
        "summary.high_alert",
        "summary.handled_alert",
        "period.range",
        "meta.report_no",
        "table.asset_top",
    }
    table = next(
        item for item in manifest["placeholders"] if item["token"] == "table.asset_top"
    )
    assert [column["key"] for column in table["columns"]] == [
        "asset",
        "level",
        "count",
    ]

    rendered = render_report(
        service.load_template_bytes(result["version"]),
        {
            "summary": {"total_alert": 37, "high_alert": 12, "handled_alert": 30},
            "period": {"range": "2026-10-01 至 2026-10-31"},
            "meta": {"report_no": "SOAR-2026-1025"},
            "table": {
                "asset_top": [
                    {"asset": "10.0.0.9", "level": "高", "count": 8},
                    {"asset": "10.0.0.8", "level": "中", "count": 2},
                ]
            },
        },
        manifest=manifest,
    )
    assert rendered["checks"]["ok"] is True


def test_from_report_plan_auto_assigns_repeated_text():
    document = Document()
    document.add_paragraph("高危事件 12 起，高危告警 12 起。")
    output = io.BytesIO()
    document.save(output)
    content = output.getvalue()

    plan = sanitize_plan(
        {
            "replacements": [
                {
                    "kind": "paragraph",
                    "index": 0,
                    "find": "12",
                    "token": "endpoint.high_event_count",
                },
                {
                    "kind": "paragraph",
                    "index": 0,
                    "find": "12",
                    "token": "endpoint.high_alert_count",
                },
            ]
        },
        inspect_docx(content),
    )

    assert [item["occurrence"] for item in plan["replacements"]] == [1, 2]
    assert any("自动分配" in warning for warning in plan["warnings"])

    manifest = extract_manifest(apply_plan(content, plan))
    tokens = {item["token"] for item in manifest["placeholders"]}
    assert tokens == {"endpoint.high_event_count", "endpoint.high_alert_count"}


def test_from_report_plan_keeps_first_token_on_conflict():
    structure = inspect_docx(_make_source_report())
    plan = sanitize_plan(
        {
            "replacements": [
                {
                    "kind": "paragraph",
                    "index": 2,
                    "find": "37",
                    "token": "summary.total_alert",
                },
                {
                    "kind": "paragraph",
                    "index": 2,
                    "find": "37",
                    "token": "summary.alert_total",
                },
            ]
        },
        structure,
    )

    assert [item["token"] for item in plan["replacements"]] == ["summary.total_alert"]
    assert any("忽略 summary.alert_total" in warning for warning in plan["warnings"])


def test_from_report_plan_rejects_unknown_header():
    structure = inspect_docx(_make_source_report())
    raw = {
        "tables": [
            {
                "index": 0,
                "header_row": 0,
                "data_row": 1,
                "loop_token": "table.asset_top",
                "columns": [{"label": "资产X", "key": "asset"}],
            }
        ]
    }
    with pytest.raises(ReportError) as excinfo:
        sanitize_plan(raw, structure)
    assert excinfo.value.code == AI_BAD_OUTPUT
    assert "资产X" in excinfo.value.message


def test_template_preview_pdf_renders_sample_and_caches(env, monkeypatch):
    db = env
    template = _published_template(db)
    version = service.get_template_version(db, template.current_version_id)

    calls = {"count": 0}

    def fake_convert(docx: bytes, *, timeout: int = 120) -> bytes:
        calls["count"] += 1
        document = Document(io.BytesIO(docx))
        text = "\n".join(p.text for p in document.paragraphs)
        assert "【summary.total_alert】" in text
        assert "{{" not in text
        table_text = "\n".join(
            cell.text
            for table in document.tables
            for row in table.rows
            for cell in row.cells
        )
        assert "【资产】" in table_text and "【等级】" in table_text
        return b"%PDF-1.4 template preview"

    monkeypatch.setattr(service.pdf_export, "docx_to_pdf", fake_convert)

    first = service.template_preview_pdf_bytes(version)
    second = service.template_preview_pdf_bytes(version)
    assert first == second == b"%PDF-1.4 template preview"
    assert calls["count"] == 1


def test_preview_pdf_cache_and_unavailable(env, monkeypatch):
    db = env
    template = _published_template(db)
    config = _published_config(db, template)

    calls = {"count": 0}

    def fake_convert(docx: bytes, *, timeout: int = 120) -> bytes:
        assert docx[:2] == b"PK"
        calls["count"] += 1
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(service.pdf_export, "docx_to_pdf", fake_convert)
    preview = asyncio.run(
        service.preview_config(db, config.id, params={"period": "2026-11"})
    )
    first = service.preview_pdf_bytes(preview["preview_id"], preview["config_id"])
    second = service.preview_pdf_bytes(preview["preview_id"], preview["config_id"])
    assert first == second == b"%PDF-1.4 fake"
    assert calls["count"] == 1

    another = asyncio.run(
        service.preview_config(db, config.id, params={"period": "2026-12"})
    )

    def unavailable(docx: bytes, *, timeout: int = 120) -> bytes:
        raise ReportError(PDF_UNAVAILABLE, "no soffice", {"hint": "install libreoffice"})

    monkeypatch.setattr(service.pdf_export, "docx_to_pdf", unavailable)
    with pytest.raises(ReportError) as excinfo:
        service.preview_pdf_bytes(another["preview_id"], another["config_id"])
    assert excinfo.value.code == PDF_UNAVAILABLE
