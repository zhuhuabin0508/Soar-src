"""报告中心 API：模板库、配置、运行、审核与下载。

权限：
- ``report:view`` 查看模板/配置/运行/下载；
- ``report:edit`` 新建与编辑模板、配置；
- ``report:execute`` 数据源试调用、预览、触发运行；
- ``report:publish`` 发布模板/配置、审核产物；
- ``report:delete`` 归档模板、停用配置。
"""
from __future__ import annotations

import io
import json
import os
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, File, Form, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.timezone import to_beijing_iso
from app.database import get_db
from app.dependencies import require_permission
from app.models.report import (
    ReportArtifact,
    ReportConfig,
    ReportConfigVersion,
    ReportRun,
    ReportRunSource,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.models.user import User
from app.report import service
from app.report.collector import collect_sources
from app.report.errors import CONFLICT, ReportError

router = APIRouter(prefix="/reports", tags=["reports"])

MAX_PREVIEW_CHARS = 200_000


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _template_dict(template: ReportTemplate) -> dict:
    return {
        "id": template.id,
        "code": template.code,
        "name": template.name,
        "category": template.category or "",
        "description": template.description or "",
        "status": template.status,
        "current_version_id": template.current_version_id,
        "owner_id": template.owner_id,
        "tags": template.tags or "",
        "created_by": template.created_by,
        "created_at": to_beijing_iso(template.created_at),
        "updated_at": to_beijing_iso(template.updated_at),
    }


def _template_version_dict(version: ReportTemplateVersion, *, manifest: bool = False) -> dict:
    data = {
        "id": version.id,
        "template_id": version.template_id,
        "version_no": version.version_no,
        "file_size": version.file_size,
        "file_hash": version.file_hash,
        "source": version.source,
        "status": version.status,
        "changelog": version.changelog or "",
        "published_by": version.published_by,
        "published_at": to_beijing_iso(version.published_at),
        "created_by": version.created_by,
        "created_at": to_beijing_iso(version.created_at),
    }
    if manifest:
        data["manifest"] = version.manifest_json or {}
    return data


def _config_dict(config: ReportConfig) -> dict:
    return {
        "id": config.id,
        "template_id": config.template_id,
        "name": config.name,
        "description": config.description or "",
        "status": config.status,
        "schedule_cron": config.schedule_cron or "",
        "timezone": config.timezone,
        "output_name_pattern": config.output_name_pattern,
        "notify_channels": config.notify_channels or [],
        "created_by": config.created_by,
        "created_at": to_beijing_iso(config.created_at),
        "updated_at": to_beijing_iso(config.updated_at),
    }


def _config_version_dict(version: ReportConfigVersion, *, detail: bool = False) -> dict:
    data = {
        "id": version.id,
        "config_id": version.config_id,
        "version_no": version.version_no,
        "template_version_id": version.template_version_id,
        "status": version.status,
        "changelog": version.changelog or "",
        "published_by": version.published_by,
        "published_at": to_beijing_iso(version.published_at),
        "created_by": version.created_by,
        "created_at": to_beijing_iso(version.created_at),
    }
    if detail:
        data.update(
            {
                "params_schema": version.params_schema_json or [],
                "data_sources": version.data_sources_json or [],
                "mapping": version.mapping_json or {},
                "transform": version.transform_json or {},
                "degradation_policy": version.degradation_policy_json or {},
            }
        )
    return data


def _run_dict(run: ReportRun, *, detail: bool = False) -> dict:
    data = {
        "id": run.id,
        "config_id": run.config_id,
        "config_version_no": run.config_version_no,
        "template_version_id": run.template_version_id,
        "trigger_type": run.trigger_type,
        "trigger_user_id": run.trigger_user_id,
        "params": run.params_json or {},
        "status": run.status,
        "started_at": to_beijing_iso(run.started_at),
        "finished_at": to_beijing_iso(run.finished_at),
        "duration_ms": run.duration_ms,
        "error_code": run.error_code,
        "error_message": run.error_message,
        "artifact_id": run.artifact_id,
        "created_at": to_beijing_iso(run.created_at),
    }
    if detail:
        data["validation"] = run.validation_json or {}
        data["stats"] = run.stats_json or {}
        data["snapshot"] = run.data_snapshot_json or {}
    return data


def _source_dict(source: ReportRunSource) -> dict:
    return {
        "id": source.id,
        "source_key": source.source_key,
        "source_type": source.source_type,
        "device_id": source.device_id,
        "action_id": source.action_id,
        "status": source.status,
        "status_code": source.status_code,
        "latency_ms": source.latency_ms,
        "retry_count": source.retry_count,
        "error_code": source.error_code,
        "error_message": source.error_message,
        "response_hash": source.response_hash,
        "fetched_at": source.fetched_at,
    }


def _artifact_dict(artifact: ReportArtifact) -> dict:
    return {
        "id": artifact.id,
        "run_id": artifact.run_id,
        "file_name": artifact.file_name,
        "file_size": artifact.file_size,
        "file_hash": artifact.file_hash,
        "has_pdf": bool(artifact.pdf_path),
        "status": artifact.status,
        "reviewer_id": artifact.reviewer_id,
        "review_comment": artifact.review_comment or "",
        "created_at": to_beijing_iso(artifact.created_at),
    }


def _docx_response(content: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


def _pdf_response(content: bytes, filename: str) -> StreamingResponse:
    """PDF 内联响应，供浏览器 iframe 预览（鉴权仍走 Authorization 头）。"""
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
        },
    )


# --------------------------------------------------------------------------- #
# 模板
# --------------------------------------------------------------------------- #
@router.get("/templates")
def list_templates(
    keyword: str = "",
    category: str = "",
    status: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    items, total = service.list_templates(
        db,
        keyword=keyword,
        category=category,
        status=status,
        page=page,
        page_size=page_size,
    )
    return {
        "items": [_template_dict(item) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/templates")
def create_template(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    return _template_dict(
        service.create_template(
            db,
            code=body.get("code") or "",
            name=body.get("name") or "",
            category=body.get("category") or "",
            description=body.get("description") or "",
            owner_id=body.get("owner_id"),
            created_by=current_user.id,
        )
    )


@router.get("/templates/{template_id}")
def get_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    template = service.get_template(db, template_id)
    versions = service.list_template_versions(db, template_id)
    current = next(
        (item for item in versions if item.id == (template.current_version_id or -1)),
        None,
    )
    return {
        "template": _template_dict(template),
        "versions": [_template_version_dict(item) for item in versions],
        "current_manifest": (current.manifest_json if current else {}) or {},
    }


@router.get("/templates/{template_id}/versions/{version_id}/manifest")
def get_template_manifest(
    template_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    version = service.get_template_version(db, version_id)
    if version.template_id != template_id:
        from app.report.errors import ReportError, TPL_NOT_FOUND

        raise ReportError(TPL_NOT_FOUND, "模板版本不属于该模板")
    return {"version": _template_version_dict(version), "manifest": version.manifest_json or {}}


@router.post("/templates/{template_id}/versions")
async def upload_template_version(
    template_id: int,
    file: UploadFile = File(...),
    changelog: str = Form(""),
    source: str = Form("upload"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    content = await file.read()
    version = service.add_template_version(
        db,
        template_id,
        filename=file.filename or "template.docx",
        content=content,
        source=source,
        changelog=changelog,
        created_by=current_user.id,
    )
    return _template_version_dict(version, manifest=True)


@router.post("/templates/ai-draft")
async def create_ai_template(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    """AI 生成模板草稿：返回新建模板与草稿版本（需人工确认后发布）。"""
    result = await service.create_ai_template(
        db,
        code=body.get("code") or "",
        name=body.get("name") or "",
        description=body.get("description") or "",
        category=body.get("category") or "",
        title=body.get("title") or "",
        created_by=current_user.id,
    )
    return {
        "template": _template_dict(result["template"]),
        "version": _template_version_dict(result["version"], manifest=True),
        "spec": result["spec"],
        "model": result["model"],
    }


@router.post("/templates/from-report")
async def create_template_from_report(
    file: UploadFile = File(...),
    code: str = Form(...),
    name: str = Form(...),
    category: str = Form(""),
    description: str = Form(""),
    hint: str = Form(""),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    """基于现有 docx 报告生成模板草稿：保留原版式，AI 只写入占位符。"""
    content = await file.read()
    result = await service.create_template_from_report(
        db,
        filename=file.filename or "report.docx",
        content=content,
        code=code,
        name=name,
        category=category,
        description=description,
        hint=hint,
        created_by=current_user.id,
    )
    return {
        "template": _template_dict(result["template"]),
        "version": _template_version_dict(result["version"], manifest=True),
        "plan": result["plan"],
        "manifest": result["manifest"],
        "warnings": result["warnings"],
        "model": result["model"],
    }


@router.post("/templates/{template_id}/versions/{version_id}/publish")
def publish_template_version(
    template_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "publish")),
):
    result = service.publish_template_version(
        db, template_id, version_id, published_by=current_user.id
    )
    return {"published": True, **result}


@router.get("/templates/{template_id}/versions/{base_id}/diff/{target_id}")
def diff_template_versions(
    template_id: int,
    base_id: int,
    target_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    return service.diff_template_versions(db, template_id, base_id, target_id)


@router.get("/templates/{template_id}/versions/{version_id}/file")
def download_template_version(
    template_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    version = service.get_template_version(db, version_id)
    if version.template_id != template_id:
        from app.report.errors import ReportError, TPL_NOT_FOUND

        raise ReportError(TPL_NOT_FOUND, "模板版本不属于该模板")
    content = service.load_template_bytes(version)
    return _docx_response(content, f"template_v{version.version_no}.docx")


@router.get("/templates/{template_id}/versions/{version_id}/pdf")
def preview_template_version_pdf(
    template_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    """模板样张预览：占位符以【token】显示，表格展示一行示例。"""
    version = service.get_template_version(db, version_id)
    if version.template_id != template_id:
        from app.report.errors import ReportError, TPL_NOT_FOUND

        raise ReportError(TPL_NOT_FOUND, "模板版本不属于该模板")
    pdf = service.template_preview_pdf_bytes(version)
    return _pdf_response(pdf, f"template_v{version.version_no}_preview.pdf")


@router.delete("/templates/{template_id}")
def archive_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "delete")),
):
    return _template_dict(service.archive_template(db, template_id))


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
@router.get("/configs")
def list_configs(
    template_id: int | None = None,
    keyword: str = "",
    status: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    items, total = service.list_configs(
        db,
        template_id=template_id,
        keyword=keyword,
        status=status,
        page=page,
        page_size=page_size,
    )
    template_ids = {item.template_id for item in items}
    template_names = {}
    if template_ids:
        rows = (
            db.query(ReportTemplate.id, ReportTemplate.name)
            .filter(ReportTemplate.id.in_(template_ids))
            .all()
        )
        template_names = {row[0]: row[1] for row in rows}
    return {
        "items": [
            {**_config_dict(item), "template_name": template_names.get(item.template_id, "")}
            for item in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/configs")
def create_config(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    return _config_dict(
        service.create_config(
            db,
            template_id=int(body.get("template_id") or 0),
            name=body.get("name") or "",
            description=body.get("description") or "",
            schedule_cron=body.get("schedule_cron") or "",
            output_name_pattern=body.get("output_name_pattern") or "",
            created_by=current_user.id,
        )
    )


@router.patch("/configs/{config_id}")
def update_config(
    config_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "edit")),
):
    return _config_dict(
        service.update_config(
            db,
            config_id,
            name=body.get("name"),
            description=body.get("description"),
            schedule_cron=body.get("schedule_cron"),
            output_name_pattern=body.get("output_name_pattern"),
            notify_channels=body.get("notify_channels"),
        )
    )


@router.get("/configs/{config_id}")
def get_config(
    config_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    config = service.get_config(db, config_id)
    versions = service.list_config_versions(db, config_id)
    return {
        "config": _config_dict(config),
        "versions": [_config_version_dict(item) for item in versions],
    }


@router.get("/configs/{config_id}/versions/{version_id}")
def get_config_version(
    config_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    version = service.get_config_version(db, config_id, version_id)
    return _config_version_dict(version, detail=True)


@router.get("/configs/{config_id}/migration/preview")
def preview_config_migration(
    config_id: int,
    target_template_version_id: int,
    base_version_id: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    """模板版本迁移预检：返回保留/移除/新增占位符与改名候选（只读）。"""
    return service.preview_config_migration(
        db,
        config_id,
        target_template_version_id,
        base_version_id=base_version_id,
    )


@router.post("/configs/{config_id}/migration")
def migrate_config(
    config_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    """按迁移预检结果创建新的配置草稿版本（不自动发布）。"""
    target_id = body.get("target_template_version_id")
    if not isinstance(target_id, int):
        raise ReportError(CONFLICT, "必须指定 target_template_version_id")
    version = service.migrate_config_version(
        db,
        config_id,
        target_template_version_id=target_id,
        renames=body.get("renames") or {},
        base_version_id=body.get("base_version_id"),
        changelog=body.get("changelog") or "",
        created_by=current_user.id,
    )
    return _config_version_dict(version, detail=True)


@router.post("/configs/{config_id}/versions")
def save_config_version(
    config_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "edit")),
):
    version = service.save_config_draft(
        db,
        config_id,
        body,
        created_by=current_user.id,
        require_complete=False,
    )
    return _config_version_dict(version, detail=True)


@router.post("/configs/{config_id}/versions/{version_id}/publish")
def publish_config_version(
    config_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "publish")),
):
    version = service.publish_config_version(
        db, config_id, version_id, published_by=current_user.id
    )
    return _config_version_dict(version, detail=True)


@router.post("/configs/{config_id}/test-source")
async def test_source(
    config_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "execute")),
):
    service.get_config(db, config_id)
    spec = body.get("spec") or {}
    params = body.get("params") or {}
    results = await collect_sources([spec], params)
    result = next(iter(results.values()), None)
    if result is None:
        return {"ok": False, "error": "数据源未执行"}
    payload = result.to_dict()
    serialized = json.dumps(result.data, ensure_ascii=False, default=str)
    if len(serialized) > MAX_PREVIEW_CHARS:
        payload["data"] = None
        payload["data_preview"] = serialized[:MAX_PREVIEW_CHARS]
        payload["truncated"] = True
    else:
        payload["data"] = result.data
    return payload


@router.post("/configs/{config_id}/ai-mapping-suggest")
async def suggest_config_mappings(
    config_id: int,
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "edit")),
):
    """AI 映射建议：采集样例（或使用传入 samples）后生成绑定建议，不落配置。"""
    return await service.suggest_config_mappings(
        db,
        config_id,
        version_id=body.get("version_id"),
        params=body.get("params") or {},
        samples=body.get("samples"),
    )


@router.post("/configs/{config_id}/preview")
async def preview_config(
    config_id: int,
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "execute")),
):
    return await service.preview_config(
        db,
        config_id,
        version_id=body.get("version_id"),
        params=body.get("params") or {},
    )


@router.get("/configs/{config_id}/previews/{preview_id}")
def download_preview(
    config_id: int,
    preview_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    service.get_config(db, config_id)
    return _docx_response(service.load_preview_bytes(preview_id, config_id), "preview.docx")


# --------------------------------------------------------------------------- #
# PDF 保真预览
# --------------------------------------------------------------------------- #
@router.get("/pdf/capability")
def get_pdf_capability(_: User = Depends(require_permission("report", "view"))):
    """探测服务端 PDF 转换能力（未安装 LibreOffice 时 available=false）。"""
    return service.pdf_export.capability()


@router.get("/configs/{config_id}/previews/{preview_id}/pdf")
def preview_config_pdf(
    config_id: int,
    preview_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    service.get_config(db, config_id)
    return _pdf_response(service.preview_pdf_bytes(preview_id, config_id), "preview.pdf")


# --------------------------------------------------------------------------- #
# 配置健康检查
# --------------------------------------------------------------------------- #
@router.get("/configs/{config_id}/health")
async def get_config_health(
    config_id: int,
    version_id: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    """只读健康检查：校验模板版本、绑定、数据源、cron、表格列与最近运行。"""
    return await service.config_health(db, config_id, version_id=version_id)


@router.post("/configs/{config_id}/health/probe")
async def probe_config_health(
    config_id: int,
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "execute")),
):
    """样例探针：实际采集一次并校验映射命中（不写运行记录）。"""
    return await service.config_health(
        db,
        config_id,
        version_id=body.get("version_id"),
        params=body.get("params") or {},
        probe=True,
    )


@router.delete("/configs/{config_id}")
def disable_config(
    config_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "delete")),
):
    return _config_dict(service.disable_config(db, config_id))


# --------------------------------------------------------------------------- #
# 运行
# --------------------------------------------------------------------------- #
@router.post("/runs")
def trigger_run(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "execute")),
):
    run = service.create_run(
        db,
        int(body.get("config_id") or 0),
        params=body.get("params") or {},
        trigger_type="manual",
        trigger_user_id=current_user.id,
        idempotency_key=body.get("idempotency_key"),
    )
    return _run_dict(run)


@router.get("/runs")
def list_runs(
    config_id: int | None = None,
    status: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    items, total = service.list_runs(
        db, config_id=config_id, status=status, page=page, page_size=page_size
    )
    config_ids = {item.config_id for item in items}
    config_names = {}
    if config_ids:
        rows = (
            db.query(ReportConfig.id, ReportConfig.name)
            .filter(ReportConfig.id.in_(config_ids))
            .all()
        )
        config_names = {row[0]: row[1] for row in rows}
    return {
        "items": [
            {**_run_dict(item), "config_name": config_names.get(item.config_id, "")}
            for item in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/runs/{run_id}")
def get_run(
    run_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    run = service.get_run(db, run_id)
    sources = service.get_run_sources(db, run_id)
    artifact = None
    if run.artifact_id:
        artifact = (
            db.query(ReportArtifact).filter(ReportArtifact.id == run.artifact_id).first()
        )
    return {
        "run": _run_dict(run, detail=True),
        "sources": [_source_dict(item) for item in sources],
        "artifact": _artifact_dict(artifact) if artifact else None,
    }


@router.post("/runs/{run_id}/retry")
def retry_run(
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "execute")),
):
    return _run_dict(service.retry_run(db, run_id, trigger_user_id=current_user.id))


@router.get("/runs/{run_id}/validation")
def get_run_validation(
    run_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    run = service.get_run(db, run_id)
    return {
        "run_id": run.id,
        "status": run.status,
        "validation": run.validation_json or {},
        "error_code": run.error_code,
        "error_message": run.error_message,
    }


@router.get("/runs/{run_id}/snapshot")
def get_run_snapshot(
    run_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    run = service.get_run(db, run_id)
    return {"run_id": run.id, "snapshot": run.data_snapshot_json or {}}


@router.get("/runs/{run_id}/download")
def download_run_report(
    run_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    run = service.get_run(db, run_id)
    if not run.artifact_id:
        from app.report.errors import ARTIFACT_NOT_FOUND, ReportError

        raise ReportError(ARTIFACT_NOT_FOUND, "该运行尚未生成报告")
    artifact = service.get_artifact(db, run.artifact_id)
    return _docx_response(
        service.load_artifact_bytes(artifact),
        artifact.file_name or f"report_{run.id}.docx",
    )


@router.get("/runs/{run_id}/pdf")
def preview_run_pdf(
    run_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    run = service.get_run(db, run_id)
    if not run.artifact_id:
        from app.report.errors import ARTIFACT_NOT_FOUND, ReportError

        raise ReportError(ARTIFACT_NOT_FOUND, "该运行尚未生成报告")
    artifact = service.get_artifact(db, run.artifact_id)
    filename = f"{os.path.splitext(artifact.file_name or f'report_{run.id}')[0]}.pdf"
    return _pdf_response(service.artifact_pdf_bytes(db, artifact), filename)


# --------------------------------------------------------------------------- #
# 产物审核
# --------------------------------------------------------------------------- #
@router.get("/artifacts")
def list_artifacts(
    status: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    query = db.query(ReportArtifact)
    if status:
        query = query.filter(ReportArtifact.status == status)
    total = query.count()
    items = (
        query.order_by(ReportArtifact.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [_artifact_dict(item) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/artifacts/{artifact_id}/review")
def review_artifact(
    artifact_id: int,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report", "publish")),
):
    artifact = service.review_artifact(
        db,
        artifact_id,
        action=body.get("action") or "",
        reviewer_id=current_user.id,
        comment=body.get("comment") or "",
    )
    return _artifact_dict(artifact)


@router.get("/artifacts/{artifact_id}/download")
def download_artifact(
    artifact_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    artifact = service.get_artifact(db, artifact_id)
    return _docx_response(
        service.load_artifact_bytes(artifact),
        artifact.file_name or f"report_{artifact.id}.docx",
    )


@router.get("/artifacts/{artifact_id}/pdf")
def preview_artifact_pdf(
    artifact_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("report", "view")),
):
    artifact = service.get_artifact(db, artifact_id)
    filename = f"{os.path.splitext(artifact.file_name or f'report_{artifact.id}')[0]}.pdf"
    return _pdf_response(service.artifact_pdf_bytes(db, artifact), filename)
