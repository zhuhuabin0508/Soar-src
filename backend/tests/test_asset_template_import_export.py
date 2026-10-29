"""资产类型模板导入导出测试。

覆盖：
- 导出单个/全部模板为 JSON 信封（不含 ID/预设标记）
- 导出不存在的模板 → 404
- 导入单模板 / 批量模板，均落为自定义模板
- code 冲突自动追加 _importN，名称追加 (导入N)
- 非法结构整批拒绝，不产生部分导入
"""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1 import asset_templates as templates_mod
from app.database import Base, get_db
from app.dependencies import get_current_user
from app.models.asset import AssetTypeTemplate
from app.models.user import User

_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

Base.metadata.create_all(_engine, tables=[
    AssetTypeTemplate.__table__,
    User.__table__,
])


@pytest.fixture(autouse=True)
def _clean_db():
    session = _TestSessionLocal()
    try:
        session.query(AssetTypeTemplate).delete()
        session.commit()
    finally:
        session.close()
    yield


def _build_client():
    app = FastAPI()
    app.include_router(templates_mod.router)

    def _override_db():
        db = _TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    fake_user = User(id=1, username="tester", role="admin", role_id=None)
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: fake_user
    return TestClient(app)


def _seed_template(db, code="demo", name="演示模板", identifier="ip"):
    tpl = AssetTypeTemplate(
        code=code,
        name=name,
        description="演示",
        icon="server",
        color="chart-1",
        identifier_field=identifier,
        is_preset=True,
        sort_order=1,
        fields=[
            {"key": "ip", "label": "IP", "type": "ip", "mapped_to": "standard:ip"},
            {"key": "name", "label": "名称", "type": "text", "mapped_to": "standard:name"},
        ],
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return tpl


def _export_template_item(code="demo", name="演示模板"):
    return {
        "code": code,
        "name": name,
        "description": "导入模板",
        "icon": "server",
        "color": "chart-2",
        "identifier_field": "system_name",
        "allow_aggregate": True,
        "fields": [
            {
                "key": "system_name", "label": "系统名称", "type": "text",
                "mapped_to": "standard:name", "required": True,
                "width": "full", "sort_order": 1, "show_in_list": True, "show_in_detail": True,
            },
            {
                "key": "ip", "label": "IP", "type": "ip",
                "mapped_to": "standard:ip", "width": "half",
                "sort_order": 2, "show_in_list": True, "show_in_detail": True,
            },
        ],
    }


class TestTemplateExport:
    def test_export_single_template_as_envelope(self):
        db = _TestSessionLocal()
        try:
            _seed_template(db)
        finally:
            db.close()

        client = _build_client()
        resp = client.get("/asset-templates/export?codes=demo")
        assert resp.status_code == 200, resp.text
        data = json.loads(resp.text)
        assert data["format"] == templates_mod.EXPORT_FORMAT
        assert data["version"] == templates_mod.EXPORT_VERSION
        assert len(data["templates"]) == 1
        item = data["templates"][0]
        assert item["code"] == "demo"
        assert item["identifier_field"] == "ip"
        assert "id" not in item
        assert "is_preset" not in item
        assert item["fields"][0]["key"] == "ip"

    def test_export_all_and_missing_code(self):
        db = _TestSessionLocal()
        try:
            _seed_template(db)
        finally:
            db.close()

        client = _build_client()
        all_resp = client.get("/asset-templates/export")
        assert all_resp.status_code == 200
        assert len(json.loads(all_resp.text)["templates"]) == 1

        missing_resp = client.get("/asset-templates/export?codes=not_exists")
        assert missing_resp.status_code == 404


class TestTemplateImport:
    def test_import_single_template_as_custom(self):
        client = _build_client()
        resp = client.post("/asset-templates/import", json={"template": _export_template_item()})
        assert resp.status_code == 201, resp.text
        result = resp.json()
        assert result["imported"] == 1
        assert result["items"][0]["code"] == "demo"
        assert result["items"][0]["renamed_from"] is None

        db = _TestSessionLocal()
        try:
            tpl = db.query(AssetTypeTemplate).filter_by(code="demo").first()
            assert tpl is not None
            assert tpl.is_preset is False
            assert tpl.name == "演示模板"
            assert tpl.allow_aggregate is True
            assert tpl.fields[0]["key"] == "system_name"
        finally:
            db.close()

    def test_import_accepts_export_envelope(self):
        payload = {
            "format": templates_mod.EXPORT_FORMAT,
            "version": templates_mod.EXPORT_VERSION,
            "templates": [_export_template_item("batch_a", "批量A"), _export_template_item("batch_b", "批量B")],
        }
        client = _build_client()
        resp = client.post("/asset-templates/import", json=payload)
        assert resp.status_code == 201, resp.text
        assert resp.json()["imported"] == 2

    def test_import_accepts_raw_single_template_object(self):
        client = _build_client()
        resp = client.post("/asset-templates/import", json=_export_template_item("raw_single", "裸对象"))
        assert resp.status_code == 201, resp.text
        assert resp.json()["items"][0]["code"] == "raw_single"

    def test_import_conflict_renames_code_and_name(self):
        db = _TestSessionLocal()
        try:
            _seed_template(db, code="demo", name="演示模板")
        finally:
            db.close()

        client = _build_client()
        resp = client.post("/asset-templates/import", json={"template": _export_template_item()})
        assert resp.status_code == 201, resp.text
        item = resp.json()["items"][0]
        # 首个冲突副本即 导入1（避免「第一个副本却是 导入2」的观感）
        assert item["code"] == "demo_import1"
        assert item["name"] == "演示模板(导入1)"
        assert item["renamed_from"] == "demo"

    def test_import_invalid_identifier_rejects_whole_batch(self):
        bad = _export_template_item("bad", "坏模板")
        bad["identifier_field"] = "not_exists"
        payload = {"templates": [_export_template_item("good", "好模板"), bad]}

        client = _build_client()
        resp = client.post("/asset-templates/import", json=payload)
        assert resp.status_code == 422, resp.text

        db = _TestSessionLocal()
        try:
            # 整批拒绝：合法的那条也不能落库
            assert db.query(AssetTypeTemplate).count() == 0
        finally:
            db.close()

    def test_import_empty_payload_rejected(self):
        client = _build_client()
        resp = client.post("/asset-templates/import", json={})
        assert resp.status_code == 422
