"""报告中心领域服务：模板、配置、运行与产物的全链路操作。

API 与 Celery 任务都通过本模块操作数据库，保证权限外的业务规则只有一处：
- 模板上传即解析 manifest 并校验；
- 配置发布前做完整映射校验；
- 运行固化模板版本 + 配置版本 + 数据快照；
- 渲染失败/校验不通过时绝不产出"看似正常"的报告。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime
from difflib import SequenceMatcher
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.models.report import (
    ReportArtifact,
    ReportConfig,
    ReportConfigVersion,
    ReportRun,
    ReportRunSource,
    ReportTemplate,
    ReportTemplateVersion,
)
from app.report.collector import collect_and_build, collect_sources
from app.report import pdf as pdf_export
from app.report.errors import (
    AI_BAD_OUTPUT,
    ARTIFACT_NOT_FOUND,
    CFG_NOT_FOUND,
    CONFLICT,
    INVALID_STATE,
    MAP_MISSING,
    RUN_NOT_FOUND,
    SRC_INVALID,
    TPL_NOT_FOUND,
    TPL_UPLOAD_INVALID,
    ReportError,
)
from app.report.manifest import diff_manifests, extract_manifest, validate_docx_upload
from app.report.renderer import render_report
from app.report.spec import (
    normalize_token,
    validate_data_sources,
    validate_mapping,
    validate_template_spec,
)

logger = logging.getLogger(__name__)

# 模板编码：小写字母开头，允许数字/下划线/短横线
_TEMPLATE_CODE_RE = re.compile(r"^[a-z][a-z0-9_-]{2,63}$")
_UNSAFE_FILENAME_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')
# 试运行预览文件保留时长：过期文件在下一次生成预览时顺带清理
_PREVIEW_TTL_SECONDS = 24 * 3600


def _uploads_root() -> str:
    """backend/uploads 绝对路径（本文件位于 backend/app/report/）。"""
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "uploads",
    )


def _abs_path(relative: str) -> str:
    root = _uploads_root()
    absolute = os.path.abspath(os.path.join(root, relative))
    if os.path.commonpath([root, absolute]) != os.path.abspath(root):
        raise ReportError(TPL_UPLOAD_INVALID, "非法文件路径")
    return absolute


def _write_file(relative: str, content: bytes) -> None:
    absolute = _abs_path(relative)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    temp = f"{absolute}.{uuid.uuid4().hex}.tmp"
    with open(temp, "wb") as handle:
        handle.write(content)
    os.replace(temp, absolute)


def load_template_bytes(version: ReportTemplateVersion) -> bytes:
    absolute = _abs_path(version.file_path)
    if not os.path.exists(absolute):
        raise ReportError(TPL_NOT_FOUND, f"模板文件缺失: {version.file_path}")
    with open(absolute, "rb") as handle:
        return handle.read()


def _cleanup_expired_previews() -> None:
    """清理超过保留时长的试运行预览（docx/pdf），避免磁盘无限增长。"""
    root = _abs_path("report_previews")
    if not os.path.isdir(root):
        return
    cutoff = time.time() - _PREVIEW_TTL_SECONDS
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.unlink(path)
                except OSError:
                    continue
    except OSError:
        logger.warning("过期预览文件清理失败（忽略）", exc_info=True)


def _json(value: Any, default: Any) -> Any:
    """兼容 JSON 列与历史 Text 存储。"""
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default
    return default


def _safe_filename(name: str, fallback: str = "report") -> str:
    cleaned = _UNSAFE_FILENAME_RE.sub("_", (name or "").strip()).strip("._ ")
    return (cleaned or fallback)[:120]


# --------------------------------------------------------------------------- #
# 模板
# --------------------------------------------------------------------------- #
def create_template(
    db: Session,
    *,
    code: str,
    name: str,
    category: str = "",
    description: str = "",
    owner_id: int | None = None,
    created_by: int | None = None,
) -> ReportTemplate:
    code = (code or "").strip().lower()
    if not _TEMPLATE_CODE_RE.match(code):
        raise ReportError(
            CONFLICT,
            "模板编码需为 3~64 位小写字母开头，仅含字母、数字、下划线、短横线",
        )
    if not (name or "").strip():
        raise ReportError(CONFLICT, "模板名称不能为空")
    if db.query(ReportTemplate).filter(ReportTemplate.code == code).first():
        raise ReportError(CONFLICT, f"模板编码已存在: {code}")

    template = ReportTemplate(
        code=code,
        name=name.strip(),
        category=(category or "").strip(),
        description=description or "",
        owner_id=owner_id or created_by,
        created_by=created_by,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template


def list_templates(
    db: Session,
    *,
    keyword: str = "",
    category: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ReportTemplate], int]:
    query = db.query(ReportTemplate)
    if keyword:
        like = f"%{keyword.strip()}%"
        query = query.filter(
            (ReportTemplate.name.like(like)) | (ReportTemplate.code.like(like))
        )
    if category:
        query = query.filter(ReportTemplate.category == category)
    if status:
        query = query.filter(ReportTemplate.status == status)
    total = query.count()
    items = (
        query.order_by(ReportTemplate.updated_at.desc(), ReportTemplate.id.desc())
        .offset(max(page - 1, 0) * page_size)
        .limit(page_size)
        .all()
    )
    return items, total


def get_template(db: Session, template_id: int) -> ReportTemplate:
    template = db.query(ReportTemplate).filter(ReportTemplate.id == template_id).first()
    if template is None:
        raise ReportError(TPL_NOT_FOUND, "模板不存在")
    return template


def list_template_versions(db: Session, template_id: int) -> list[ReportTemplateVersion]:
    return (
        db.query(ReportTemplateVersion)
        .filter(ReportTemplateVersion.template_id == template_id)
        .order_by(ReportTemplateVersion.version_no.desc())
        .all()
    )


def get_template_version(db: Session, version_id: int) -> ReportTemplateVersion:
    version = (
        db.query(ReportTemplateVersion)
        .filter(ReportTemplateVersion.id == version_id)
        .first()
    )
    if version is None:
        raise ReportError(TPL_NOT_FOUND, "模板版本不存在")
    return version


def add_template_version(
    db: Session,
    template_id: int,
    *,
    filename: str,
    content: bytes,
    source: str = "upload",
    changelog: str = "",
    ai_draft: dict | None = None,
    created_by: int | None = None,
) -> ReportTemplateVersion:
    """上传并解析模板，创建草稿版本（不自动发布）。"""
    template = get_template(db, template_id)
    validate_docx_upload(filename, content)
    manifest = extract_manifest(content)
    spec_issues = validate_template_spec(manifest)
    if spec_issues:
        raise ReportError(
            "TPL_INVALID", "模板占位符校验未通过", {"issues": spec_issues}
        )

    file_hash = hashlib.sha256(content).hexdigest()
    next_no = (
        db.query(func.max(ReportTemplateVersion.version_no))
        .filter(ReportTemplateVersion.template_id == template_id)
        .scalar()
        or 0
    ) + 1
    relative = f"report_templates/{template_id}/v{next_no}_{file_hash[:8]}.docx"
    _write_file(relative, content)

    version = ReportTemplateVersion(
        template_id=template_id,
        version_no=next_no,
        file_path=relative,
        file_hash=file_hash,
        file_size=len(content),
        manifest_json=manifest,
        source=source,
        ai_draft_json=ai_draft,
        changelog=changelog or f"上传模板 {filename}",
        status="draft",
        created_by=created_by,
    )
    db.add(version)
    template.updated_at = beijing_now()
    db.commit()
    db.refresh(version)
    return version


def publish_template_version(
    db: Session,
    template_id: int,
    version_id: int,
    *,
    published_by: int | None = None,
) -> dict:
    """发布模板版本，并返回存量配置的兼容性影响。"""
    template = get_template(db, template_id)
    version = get_template_version(db, version_id)
    if version.template_id != template.id:
        raise ReportError(TPL_NOT_FOUND, "模板版本不属于该模板")
    if version.status == "published":
        raise ReportError(INVALID_STATE, "该版本已发布")

    impact = _check_template_impact(db, template_id, version)
    now = beijing_now()
    db.query(ReportTemplateVersion).filter(
        ReportTemplateVersion.template_id == template_id,
        ReportTemplateVersion.status == "published",
    ).update({"status": "deprecated"}, synchronize_session=False)
    version.status = "published"
    version.published_by = published_by
    version.published_at = now
    template.current_version_id = version.id
    template.status = "published"
    template.updated_at = now
    db.commit()
    return {"version_id": version.id, "impact": impact}


def _check_template_impact(
    db: Session, template_id: int, new_version: ReportTemplateVersion
) -> list[dict]:
    """对比新版本与各配置当前使用的模板版本，列出受影响配置。"""
    impact: list[dict] = []
    configs = db.query(ReportConfig).filter(ReportConfig.template_id == template_id).all()
    for config in configs:
        published = _published_config_version(db, config.id)
        if published is None:
            continue
        old_version = (
            db.query(ReportTemplateVersion)
            .filter(ReportTemplateVersion.id == published.template_version_id)
            .first()
        )
        if old_version is None:
            continue
        diff = diff_manifests(old_version.manifest_json, new_version.manifest_json)
        if diff["breaking"]:
            impact.append(
                {
                    "config_id": config.id,
                    "config_name": config.name,
                    "config_version_no": published.version_no,
                    "diff": diff,
                }
            )
    return impact


def diff_template_versions(
    db: Session, template_id: int, version_a: int, version_b: int
) -> dict:
    before = get_template_version(db, version_a)
    after = get_template_version(db, version_b)
    if before.template_id != template_id or after.template_id != template_id:
        raise ReportError(TPL_NOT_FOUND, "模板版本不属于该模板")
    return diff_manifests(before.manifest_json, after.manifest_json)


# --------------------------------------------------------------------------- #
# 配置迁移（模板版本升级）
# --------------------------------------------------------------------------- #
def _placeholder_map(manifest: dict | None) -> dict[str, dict]:
    return {
        str(p.get("token")): p
        for p in (manifest or {}).get("placeholders", [])
        if isinstance(p, dict) and p.get("token")
    }


def _similarity(left: str, right: str) -> float:
    """token/label 相似度：忽略分隔符与大小写，返回 0~1。"""
    def norm(value: str) -> str:
        return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", str(value or "").lower())

    a, b = norm(left), norm(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def _migration_candidates(old: dict, added: list[dict], limit: int = 3) -> list[dict]:
    """为被移除的占位符推荐最可能的新占位符（按 label/token 相似度）。"""
    old_label = old.get("label") or old.get("token")
    scored: list[dict] = []
    for placeholder in added:
        score = max(
            _similarity(old_label, placeholder.get("label") or ""),
            _similarity(old.get("token") or "", placeholder.get("token") or ""),
        )
        if score >= 0.5:
            scored.append(
                {
                    "token": placeholder.get("token"),
                    "label": placeholder.get("label") or placeholder.get("token"),
                    "type": placeholder.get("type"),
                    "score": round(score, 3),
                }
            )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def _rebind_binding(binding: dict, placeholder: dict) -> dict:
    """把旧绑定裁剪到新占位符结构（token/id/type，表格列取交集）。"""
    rebound = {
        **binding,
        "token": placeholder.get("token"),
        "placeholder_id": placeholder.get("id"),
        "type": placeholder.get("type"),
    }
    if placeholder.get("type") == "table":
        allowed = {str(col.get("key")) for col in placeholder.get("columns") or []}
        columns = {
            key: value
            for key, value in (binding.get("columns") or {}).items()
            if key in allowed
        }
        rebound["columns"] = columns
    else:
        rebound.pop("columns", None)
        rebound.pop("limit", None)
    return rebound


def _base_config_version(
    db: Session, config_id: int, base_version_id: int | None = None
) -> ReportConfigVersion:
    if base_version_id is not None:
        version = (
            db.query(ReportConfigVersion)
            .filter(
                ReportConfigVersion.id == base_version_id,
                ReportConfigVersion.config_id == config_id,
            )
            .first()
        )
        if version is None:
            raise ReportError(CFG_NOT_FOUND, "配置版本不存在")
        return version
    versions = list_config_versions(db, config_id)
    if not versions:
        raise ReportError(INVALID_STATE, "配置尚无版本，无需迁移")
    return versions[0]


def preview_config_migration(
    db: Session,
    config_id: int,
    target_template_version_id: int,
    *,
    base_version_id: int | None = None,
) -> dict:
    """迁移预检：对比配置当前版本与目标模板版本，输出保留/移除/新增与推荐映射。

    只读操作，不落库，供前端迁移向导展示与用户确认。
    """
    config = get_config(db, config_id)
    base = _base_config_version(db, config_id, base_version_id)
    target = get_template_version(db, target_template_version_id)
    if target.template_id != config.template_id:
        raise ReportError(TPL_NOT_FOUND, "目标模板版本不属于该配置的模板")
    source = get_template_version(db, base.template_version_id)

    old_manifest = _json(source.manifest_json, {})
    new_manifest = _json(target.manifest_json, {})
    old_map = _placeholder_map(old_manifest)
    new_map = _placeholder_map(new_manifest)
    # 仅用「新增占位符」作为改名候选，避免推荐到已保留的旧占位符造成重复绑定
    candidates_pool = [
        placeholder for token, placeholder in new_map.items() if token not in old_map
    ]
    mapping = _json(base.mapping_json, {})
    bindings = [
        binding for binding in (mapping.get("bindings") or []) if isinstance(binding, dict)
    ]

    kept: list[dict] = []
    removed: list[dict] = []
    bound_tokens: set[str] = set()
    for binding in bindings:
        token = str(binding.get("token") or "")
        placeholder = new_map.get(token)
        if placeholder is not None:
            kept.append(_rebind_binding(binding, placeholder))
            bound_tokens.add(token)
            continue
        old_placeholder = old_map.get(token) or {"token": token, "label": token}
        removed.append(
            {
                "token": token,
                "label": old_placeholder.get("label") or token,
                "type": old_placeholder.get("type"),
                "binding": binding,
                "candidates": _migration_candidates(old_placeholder, candidates_pool),
            }
        )

    added = [
        {
            "token": token,
            "label": placeholder.get("label") or token,
            "type": placeholder.get("type"),
            "required": bool(placeholder.get("required")),
        }
        for token, placeholder in new_map.items()
        if token not in old_map
    ]
    unbound_required = [
        item["token"]
        for item in added
        if item["required"] and item["token"] not in bound_tokens
    ]
    # 原有必填占位符也可能因 token 改名而变成未绑定
    for token, placeholder in new_map.items():
        if placeholder.get("required") and token not in bound_tokens:
            if token not in unbound_required:
                unbound_required.append(token)

    return {
        "config_id": config.id,
        "config_name": config.name,
        "base_config_version_id": base.id,
        "base_config_version_no": base.version_no,
        "from_template_version_id": source.id,
        "from_template_version_no": source.version_no,
        "to_template_version_id": target.id,
        "to_template_version_no": target.version_no,
        "to_template_version_status": target.status,
        "diff": diff_manifests(old_manifest, new_manifest),
        "kept": kept,
        "kept_count": len(kept),
        "removed": removed,
        "added": added,
        "unbound_required": unbound_required,
        "data_source_count": len(_json(base.data_sources_json, [])),
    }


def migrate_config_version(
    db: Session,
    config_id: int,
    *,
    target_template_version_id: int,
    renames: dict[str, str] | None = None,
    base_version_id: int | None = None,
    changelog: str = "",
    created_by: int | None = None,
) -> ReportConfigVersion:
    """按预检结果生成新的配置草稿版本（数据源/参数/版式原样保留）。

    renames: {旧 token: 新 token}，用于把被重命名的占位符绑定迁移到新 token。
    新模板中新增的必填占位符若未绑定，草稿允许保存，但发布前会被拦截。
    """
    config = get_config(db, config_id)
    preview = preview_config_migration(
        db, config_id, target_template_version_id, base_version_id=base_version_id,
    )
    base = _base_config_version(db, config_id, base_version_id)
    if base.template_version_id == target_template_version_id:
        raise ReportError(CONFLICT, "目标模板版本与当前配置版本一致，无需迁移")

    target = get_template_version(db, target_template_version_id)
    new_map = _placeholder_map(_json(target.manifest_json, {}))
    bindings = list(preview["kept"])
    bound_tokens = {str(item.get("token")) for item in bindings}
    removed_map = {item["token"]: item for item in preview["removed"]}

    for old_token, new_token in (renames or {}).items():
        new_token = str(new_token or "").strip()
        if not new_token:
            continue
        item = removed_map.get(str(old_token))
        placeholder = new_map.get(new_token)
        if item is None or placeholder is None:
            continue
        if new_token in bound_tokens:
            continue
        bindings.append(_rebind_binding(item["binding"], placeholder))
        bound_tokens.add(new_token)

    base_mapping = _json(base.mapping_json, {})
    payload = {
        "template_version_id": target_template_version_id,
        "params_schema": _json(base.params_schema_json, []),
        "data_sources": _json(base.data_sources_json, []),
        "mapping": {**base_mapping, "bindings": bindings},
        "transform": _json(base.transform_json, {}),
        "degradation_policy": _json(base.degradation_policy_json, {}),
        "changelog": changelog
        or f"模板迁移：v{preview['from_template_version_no']} → v{preview['to_template_version_no']}",
    }
    return save_config_draft(
        db, config.id, payload, created_by=created_by, require_complete=False,
    )


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
def _validate_cron(expr: str) -> None:
    """校验 5 段 cron 表达式；空字符串表示仅手动触发。"""
    expr = (expr or "").strip()
    if not expr:
        return
    try:
        from croniter import croniter
        if not croniter.is_valid(expr):
            raise ValueError
    except Exception as exc:  # noqa: BLE001
        raise ReportError(CONFLICT, f"cron 表达式不合法: {expr}") from exc


def create_config(
    db: Session,
    *,
    template_id: int,
    name: str,
    description: str = "",
    schedule_cron: str = "",
    output_name_pattern: str = "",
    created_by: int | None = None,
) -> ReportConfig:
    template = get_template(db, template_id)
    if not (name or "").strip():
        raise ReportError(CONFLICT, "配置名称不能为空")
    _validate_cron(schedule_cron)
    config = ReportConfig(
        template_id=template.id,
        name=name.strip(),
        description=description or "",
        schedule_cron=(schedule_cron or "").strip() or None,
        output_name_pattern=(output_name_pattern or "").strip() or None,
        created_by=created_by,
    )
    db.add(config)
    db.commit()
    db.refresh(config)
    return config


def update_config(
    db: Session,
    config_id: int,
    *,
    name: str | None = None,
    description: str | None = None,
    schedule_cron: str | None = None,
    output_name_pattern: str | None = None,
    notify_channels: list | None = None,
) -> ReportConfig:
    """更新配置元数据（名称/描述/定时/输出文件名/通知渠道）。"""
    config = get_config(db, config_id)
    if name is not None:
        if not name.strip():
            raise ReportError(CONFLICT, "配置名称不能为空")
        config.name = name.strip()
    if description is not None:
        config.description = description
    if schedule_cron is not None:
        _validate_cron(schedule_cron)
        config.schedule_cron = schedule_cron.strip() or None
    if output_name_pattern is not None:
        config.output_name_pattern = output_name_pattern.strip() or None
    if notify_channels is not None:
        config.notify_channels = notify_channels
    config.updated_at = beijing_now()
    db.commit()
    db.refresh(config)
    return config


def list_configs(
    db: Session,
    *,
    template_id: int | None = None,
    keyword: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ReportConfig], int]:
    query = db.query(ReportConfig)
    if template_id:
        query = query.filter(ReportConfig.template_id == template_id)
    if keyword:
        query = query.filter(ReportConfig.name.like(f"%{keyword.strip()}%"))
    if status:
        query = query.filter(ReportConfig.status == status)
    total = query.count()
    items = (
        query.order_by(ReportConfig.updated_at.desc(), ReportConfig.id.desc())
        .offset(max(page - 1, 0) * page_size)
        .limit(page_size)
        .all()
    )
    return items, total


def get_config(db: Session, config_id: int) -> ReportConfig:
    config = db.query(ReportConfig).filter(ReportConfig.id == config_id).first()
    if config is None:
        raise ReportError(CFG_NOT_FOUND, "报告配置不存在")
    return config


def list_config_versions(db: Session, config_id: int) -> list[ReportConfigVersion]:
    return (
        db.query(ReportConfigVersion)
        .filter(ReportConfigVersion.config_id == config_id)
        .order_by(ReportConfigVersion.version_no.desc())
        .all()
    )


def _published_config_version(db: Session, config_id: int) -> ReportConfigVersion | None:
    return (
        db.query(ReportConfigVersion)
        .filter(
            ReportConfigVersion.config_id == config_id,
            ReportConfigVersion.status == "published",
        )
        .order_by(ReportConfigVersion.version_no.desc())
        .first()
    )


def save_config_draft(
    db: Session,
    config_id: int,
    payload: dict,
    *,
    created_by: int | None = None,
    require_complete: bool = False,
) -> ReportConfigVersion:
    """保存配置草稿（新版本）。"""
    config = get_config(db, config_id)
    template_version_id = payload.get("template_version_id")
    if not isinstance(template_version_id, int):
        raise ReportError(CONFLICT, "必须指定 template_version_id")
    template_version = get_template_version(db, template_version_id)
    if template_version.template_id != config.template_id:
        raise ReportError(TPL_NOT_FOUND, "模板版本不属于当前配置的模板")

    manifest = _json(template_version.manifest_json, {})
    placeholders = manifest.get("placeholders", [])
    data_sources = payload.get("data_sources") or []
    mapping = payload.get("mapping") or {}

    issues = validate_data_sources(data_sources)
    issues.extend(
        validate_mapping(mapping, placeholders, require_complete=require_complete)
    )
    if issues:
        raise ReportError(CONFLICT, "配置校验未通过", {"issues": issues})

    next_no = (
        db.query(func.max(ReportConfigVersion.version_no))
        .filter(ReportConfigVersion.config_id == config_id)
        .scalar()
        or 0
    ) + 1
    version = ReportConfigVersion(
        config_id=config_id,
        version_no=next_no,
        template_version_id=template_version_id,
        params_schema_json=payload.get("params_schema") or [],
        data_sources_json=data_sources,
        mapping_json=mapping,
        transform_json=payload.get("transform") or {},
        degradation_policy_json=payload.get("degradation_policy") or {},
        changelog=payload.get("changelog") or "",
        status="draft",
        created_by=created_by,
    )
    db.add(version)
    config.updated_at = beijing_now()
    db.commit()
    db.refresh(version)
    return version


def publish_config_version(
    db: Session,
    config_id: int,
    version_id: int,
    *,
    published_by: int | None = None,
) -> ReportConfigVersion:
    config = get_config(db, config_id)
    version = (
        db.query(ReportConfigVersion)
        .filter(
            ReportConfigVersion.id == version_id,
            ReportConfigVersion.config_id == config_id,
        )
        .first()
    )
    if version is None:
        raise ReportError(CFG_NOT_FOUND, "配置版本不存在")
    if version.status == "published":
        raise ReportError(INVALID_STATE, "该配置版本已发布")

    template_version = get_template_version(db, version.template_version_id)
    if template_version.status != "published":
        raise ReportError(INVALID_STATE, "请先发布所选模板版本")

    manifest = _json(template_version.manifest_json, {})
    issues = validate_data_sources(_json(version.data_sources_json, []))
    issues.extend(
        validate_mapping(
            _json(version.mapping_json, {}),
            manifest.get("placeholders", []),
            require_complete=True,
        )
    )
    if issues:
        raise ReportError(CONFLICT, "配置校验未通过，无法发布", {"issues": issues})

    now = beijing_now()
    db.query(ReportConfigVersion).filter(
        ReportConfigVersion.config_id == config_id,
        ReportConfigVersion.status == "published",
    ).update({"status": "deprecated"}, synchronize_session=False)
    version.status = "published"
    version.published_by = published_by
    version.published_at = now
    config.status = "published"
    config.updated_at = now
    db.commit()
    db.refresh(version)
    return version


# --------------------------------------------------------------------------- #
# 运行
# --------------------------------------------------------------------------- #
def validate_run_params(schema: list[dict] | None, params: dict) -> list[dict]:
    issues: list[dict] = []
    for item in schema or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not name:
            continue
        if item.get("required") and params.get(name) in (None, ""):
            issues.append({"code": "PARAM_MISSING", "message": f"缺少必填参数: {name}"})
    return issues


def create_run(
    db: Session,
    config_id: int,
    *,
    params: dict | None = None,
    trigger_type: str = "manual",
    trigger_user_id: int | None = None,
    idempotency_key: str | None = None,
    dispatch: bool = True,
) -> ReportRun:
    config = get_config(db, config_id)
    if config.status != "published":
        raise ReportError(INVALID_STATE, "报告配置未发布，无法运行")
    version = _published_config_version(db, config_id)
    if version is None:
        raise ReportError(INVALID_STATE, "报告配置没有已发布版本")

    params = params or {}
    issues = validate_run_params(_json(version.params_schema_json, []), params)
    if issues:
        raise ReportError(CONFLICT, "运行参数校验未通过", {"issues": issues})

    if not idempotency_key:
        period = params.get("period") or params.get("date") or params.get("month")
        if period:
            idempotency_key = f"cfg{config_id}:v{version.version_no}:{period}"
    if idempotency_key:
        existing = (
            db.query(ReportRun)
            .filter(ReportRun.idempotency_key == idempotency_key)
            .first()
        )
        if existing is not None:
            return existing

    run = ReportRun(
        config_id=config_id,
        config_version_no=version.version_no,
        template_version_id=version.template_version_id,
        trigger_type=trigger_type,
        trigger_user_id=trigger_user_id,
        params_json=params,
        idempotency_key=idempotency_key,
        status="pending",
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    if dispatch:
        _dispatch_run(run.id)
    return run


def _dispatch_run(run_id: int) -> None:
    """投递 Celery 任务；投递失败不阻塞 API，运行记录保留为 pending 可重试。"""
    try:
        from app.tasks.report_tasks import execute_report_run

        execute_report_run.delay(run_id)
    except Exception:  # noqa: BLE001
        logger.exception("报告任务投递失败，run=%s 保持 pending", run_id)


def _fill_missing_placeholders(context: dict, manifest: dict) -> None:
    """非严格模式下为未绑定占位符补占位符，避免 Jinja StrictUndefined 阻断预览。"""
    for item in manifest.get("placeholders", []):
        if not isinstance(item, dict):
            continue
        token = str(item.get("token") or "")
        if not token:
            continue
        parts = token.split(".")
        current: Any = context
        missing = False
        for part in parts[:-1]:
            value = current.get(part) if isinstance(current, dict) else None
            if not isinstance(value, dict):
                if value is None:
                    value = {}
                    current[part] = value
                else:
                    missing = True
                    break
            current = value
        if missing or not isinstance(current, dict):
            continue
        if parts[-1] not in current:
            current[parts[-1]] = [] if item.get("type") == "table" else "—"


def _record_sources(db: Session, run_id: int, sources: dict[str, Any]) -> None:
    for source_key, info in (sources or {}).items():
        if not isinstance(info, dict):
            continue
        db.add(
            ReportRunSource(
                run_id=run_id,
                source_key=source_key,
                source_type=info.get("source_type") or "",
                device_id=info.get("device_id"),
                action_id=info.get("action_id"),
                status="ok" if info.get("ok") else "failed",
                status_code=info.get("status_code"),
                latency_ms=info.get("latency_ms") or 0,
                retry_count=max((info.get("attempts") or 1) - 1, 0),
                error_code=info.get("error_code"),
                error_message=info.get("error_message"),
                response_hash=info.get("response_hash"),
                fetched_at=info.get("fetched_at"),
            )
        )


def _fail_run(db: Session, run: ReportRun, exc: Exception) -> None:
    run.status = "failed"
    run.finished_at = beijing_now()
    if run.started_at:
        run.duration_ms = int((beijing_now() - run.started_at).total_seconds() * 1000)
    if isinstance(exc, ReportError):
        run.error_code = exc.code
        run.error_message = exc.message
    else:
        run.error_code = "RUN_FAILED"
        run.error_message = str(exc)
    db.commit()


def execute_run(run_id: int) -> dict:
    """执行一次报告运行（Celery 任务入口，也可在测试中直接调用）。"""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        run = db.query(ReportRun).filter(ReportRun.id == run_id).first()
        if run is None:
            return {"ok": False, "error": "run not found"}

        config = db.query(ReportConfig).filter(ReportConfig.id == run.config_id).first()
        version = (
            db.query(ReportConfigVersion)
            .filter(
                ReportConfigVersion.config_id == run.config_id,
                ReportConfigVersion.version_no == run.config_version_no,
            )
            .first()
        )
        template_version = (
            db.query(ReportTemplateVersion)
            .filter(ReportTemplateVersion.id == run.template_version_id)
            .first()
        )
        template = (
            db.query(ReportTemplate)
            .filter(ReportTemplate.id == config.template_id)
            .first()
        ) if config is not None else None
        if config is None or version is None or template_version is None or template is None:
            _fail_run(db, run, ReportError(INVALID_STATE, "运行引用的配置或模板版本不存在"))
            return {"ok": False, "error": "missing config/template"}

        manifest = _json(template_version.manifest_json, {})
        data_sources = _json(version.data_sources_json, [])
        mapping = _json(version.mapping_json, {})
        bindings = mapping.get("bindings", []) if isinstance(mapping, dict) else []
        cross_checks = mapping.get("cross_checks", []) if isinstance(mapping, dict) else []

        # 原子抢占执行权：重复投递/多 worker 并发时，只有一个能把 pending/failed
        # 切换到 collecting，其余任务直接退出，避免同一 run 产出重复产物。
        claimed = (
            db.query(ReportRun)
            .filter(
                ReportRun.id == run_id,
                ReportRun.status.in_(("pending", "failed")),
            )
            .update(
                {"status": "collecting", "started_at": beijing_now()},
                synchronize_session=False,
            )
        )
        db.commit()
        if not claimed:
            return {"ok": False, "error": "run already claimed"}
        db.refresh(run)
        started = time.perf_counter()

        try:
            built = asyncio.run(
                collect_and_build(
                    data_sources,
                    bindings,
                    run.params_json or {},
                    cross_checks=cross_checks,
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("报告采集失败 run=%s", run_id)
            _fail_run(db, run, exc)
            return {"ok": False, "error": str(exc)}

        run.status = "extracting"
        for source_key, info in (built.get("sources") or {}).items():
            spec = next(
                (
                    item
                    for item in data_sources
                    if isinstance(item, dict) and item.get("source_key") == source_key
                ),
                {},
            )
            info["source_type"] = spec.get("source_type") if isinstance(spec, dict) else None
        _record_sources(db, run.id, built.get("sources") or {})
        run.data_snapshot_json = {
            "context": built.get("context"),
            "lineage": built.get("lineage"),
            "issues": built.get("issues"),
        }
        run.status = "rendering"
        db.commit()

        try:
            context = dict(built.get("context") or {})
            _fill_missing_placeholders(context, manifest)
            rendered = render_report(
                load_template_bytes(template_version),
                context,
                manifest=manifest,
                style_profile=_json(version.transform_json, {}).get("style_profile", "keep"),
                strict_required=False,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("报告渲染失败 run=%s", run_id)
            _fail_run(db, run, exc)
            return {"ok": False, "error": str(exc)}

        run.status = "validating"
        db.commit()

        checks = rendered["checks"]
        error_issues = [
            issue
            for issue in (built.get("issues") or [])
            if issue.get("severity") == "error"
        ]
        status = "succeeded" if built.get("ok") and checks.get("ok") else "partial"

        file_name = _build_output_name(
            config, run.params_json or {}, template_name=template.name
        )
        relative = f"report_artifacts/{run.id}/{uuid.uuid4().hex[:8]}_{file_name}"
        _write_file(relative, rendered["docx"])
        artifact = ReportArtifact(
            run_id=run.id,
            file_path=relative,
            file_name=file_name,
            file_hash=hashlib.sha256(rendered["docx"]).hexdigest(),
            file_size=len(rendered["docx"]),
            status="pending_review",
        )
        db.add(artifact)
        db.flush()

        run.artifact_id = artifact.id
        run.status = status
        run.finished_at = beijing_now()
        run.duration_ms = int((time.perf_counter() - started) * 1000)
        run.validation_json = {
            "ok": built.get("ok") and checks.get("ok"),
            "issues": (built.get("issues") or []) + (checks.get("issues") or []),
            "checks": checks,
            "source_count": len(built.get("sources") or {}),
            "error_count": len(error_issues),
            "stats": rendered.get("checks", {}).get("stats", {}),
        }
        run.stats_json = {
            "duration_ms": run.duration_ms,
            "sources": {
                key: {
                    "latency_ms": info.get("latency_ms"),
                    "attempts": info.get("attempts"),
                    "ok": info.get("ok"),
                }
                for key, info in (built.get("sources") or {}).items()
            },
        }
        db.commit()
        return {
            "ok": status == "succeeded",
            "run_id": run.id,
            "artifact_id": artifact.id,
            "status": status,
        }
    finally:
        db.close()


def _build_output_name(
    config: ReportConfig, params: dict, *, template_name: str
) -> str:
    pattern = config.output_name_pattern or "{template_name}_{period}"
    try:
        rendered = pattern.format(
            template_name=_safe_filename(template_name, "template"),
            config_name=_safe_filename(config.name),
            period=params.get("period") or params.get("date") or params.get("month") or "",
            date=beijing_now().strftime("%Y%m%d"),
        )
    except (KeyError, ValueError):
        rendered = f"{config.name}_{beijing_now().strftime('%Y%m%d')}"
    return f"{_safe_filename(rendered, 'report')}.docx"


def list_runs(
    db: Session,
    *,
    config_id: int | None = None,
    status: str = "",
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ReportRun], int]:
    query = db.query(ReportRun)
    if config_id:
        query = query.filter(ReportRun.config_id == config_id)
    if status:
        query = query.filter(ReportRun.status == status)
    total = query.count()
    items = (
        query.order_by(ReportRun.id.desc())
        .offset(max(page - 1, 0) * page_size)
        .limit(page_size)
        .all()
    )
    return items, total


def get_run(db: Session, run_id: int) -> ReportRun:
    run = db.query(ReportRun).filter(ReportRun.id == run_id).first()
    if run is None:
        raise ReportError(RUN_NOT_FOUND, "运行记录不存在")
    return run


def get_run_sources(db: Session, run_id: int) -> list[ReportRunSource]:
    return (
        db.query(ReportRunSource)
        .filter(ReportRunSource.run_id == run_id)
        .order_by(ReportRunSource.id.asc())
        .all()
    )


def get_artifact(db: Session, artifact_id: int) -> ReportArtifact:
    artifact = db.query(ReportArtifact).filter(ReportArtifact.id == artifact_id).first()
    if artifact is None:
        raise ReportError(ARTIFACT_NOT_FOUND, "报告产物不存在")
    return artifact


def load_artifact_bytes(artifact: ReportArtifact) -> bytes:
    absolute = _abs_path(artifact.file_path)
    if not os.path.exists(absolute):
        raise ReportError(ARTIFACT_NOT_FOUND, "报告文件缺失")
    with open(absolute, "rb") as handle:
        return handle.read()


def review_artifact(
    db: Session,
    artifact_id: int,
    *,
    action: str,
    reviewer_id: int,
    comment: str = "",
) -> ReportArtifact:
    artifact = get_artifact(db, artifact_id)
    if artifact.status not in {"draft", "pending_review"}:
        raise ReportError(INVALID_STATE, f"产物当前状态不可审核: {artifact.status}")
    if action == "approve":
        artifact.status = "approved"
    elif action == "reject":
        artifact.status = "rejected"
    else:
        raise ReportError(CONFLICT, "审核动作只能是 approve / reject")
    artifact.reviewer_id = reviewer_id
    artifact.review_comment = comment or ""
    db.commit()
    db.refresh(artifact)
    return artifact


def get_config_version(db: Session, config_id: int, version_id: int) -> ReportConfigVersion:
    version = (
        db.query(ReportConfigVersion)
        .filter(
            ReportConfigVersion.id == version_id,
            ReportConfigVersion.config_id == config_id,
        )
        .first()
    )
    if version is None:
        raise ReportError(CFG_NOT_FOUND, "配置版本不存在")
    return version


async def preview_config(
    db: Session,
    config_id: int,
    *,
    version_id: int | None = None,
    params: dict | None = None,
) -> dict:
    """用真实数据试运行一次配置，返回预览文件与校验结论（不落运行记录）。"""
    config = get_config(db, config_id)
    version = (
        get_config_version(db, config_id, version_id)
        if version_id
        else _published_config_version(db, config_id)
    )
    if version is None:
        raise ReportError(INVALID_STATE, "配置没有可预览的版本")
    template_version = get_template_version(db, version.template_version_id)
    manifest = _json(template_version.manifest_json, {})
    mapping = _json(version.mapping_json, {})
    bindings = mapping.get("bindings", []) if isinstance(mapping, dict) else []
    cross_checks = mapping.get("cross_checks", []) if isinstance(mapping, dict) else []

    built = await collect_and_build(
        _json(version.data_sources_json, []),
        bindings,
        params or {},
        cross_checks=cross_checks,
    )
    context = dict(built.get("context") or {})
    _fill_missing_placeholders(context, manifest)
    rendered = render_report(
        load_template_bytes(template_version),
        context,
        manifest=manifest,
        style_profile=_json(version.transform_json, {}).get("style_profile", "keep"),
        strict_required=False,
    )

    preview_id = uuid.uuid4().hex
    # 预览文件按 config 分目录：下载时校验 preview_id 与 config_id 的归属
    relative = f"report_previews/{config.id}/{preview_id}.docx"
    _write_file(relative, rendered["docx"])
    _cleanup_expired_previews()
    return {
        "preview_id": preview_id,
        "config_id": config.id,
        "config_version_no": version.version_no,
        "template_version_id": template_version.id,
        "issues": (built.get("issues") or []) + (rendered["checks"].get("issues") or []),
        "checks": rendered["checks"],
        "context": context,
        "lineage": built.get("lineage"),
        "sources": built.get("sources"),
    }


def load_preview_bytes(preview_id: str, config_id: int) -> bytes:
    if not re.fullmatch(r"[0-9a-f]{32}", preview_id or ""):
        raise ReportError(ARTIFACT_NOT_FOUND, "预览不存在")
    absolute = _abs_path(f"report_previews/{config_id}/{preview_id}.docx")
    if not os.path.exists(absolute):
        raise ReportError(ARTIFACT_NOT_FOUND, "预览文件不存在或已过期")
    with open(absolute, "rb") as handle:
        return handle.read()


def preview_pdf_bytes(preview_id: str, config_id: int) -> bytes:
    """将预览 docx 转为 PDF（首次转换后缓存，后续直接读缓存）。"""
    if not re.fullmatch(r"[0-9a-f]{32}", preview_id or ""):
        raise ReportError(ARTIFACT_NOT_FOUND, "预览不存在")
    pdf_relative = f"report_previews/{config_id}/{preview_id}.pdf"
    pdf_absolute = _abs_path(pdf_relative)
    if os.path.exists(pdf_absolute):
        with open(pdf_absolute, "rb") as handle:
            return handle.read()
    docx_bytes = load_preview_bytes(preview_id, config_id)
    pdf_bytes = pdf_export.docx_to_pdf(docx_bytes)
    _write_file(pdf_relative, pdf_bytes)
    return pdf_bytes


def _sample_context(manifest: dict) -> dict:
    """构造模板样张上下文：标量显示【token】，表格展示一行【列名】。"""
    context: dict = {}

    def set_value(token: str, value: Any) -> None:
        parts = token.split(".")
        node = context
        for part in parts[:-1]:
            child = node.get(part)
            if not isinstance(child, dict):
                child = {}
                node[part] = child
            node = child
        node[parts[-1]] = value

    for item in manifest.get("placeholders") or []:
        if not isinstance(item, dict):
            continue
        token = normalize_token(item.get("token"))
        if not token:
            continue
        if item.get("type") == "table":
            row = {
                str(column.get("key")): f"【{column.get('label') or column.get('key')}】"
                for column in item.get("columns") or []
                if isinstance(column, dict) and column.get("key")
            }
            set_value(token, [row] if row else [])
        else:
            set_value(token, f"【{token}】")
    return context


def template_preview_pdf_bytes(version: ReportTemplateVersion) -> bytes:
    """模板样张预览：按 manifest 渲染一行样例后转 PDF，并缓存到模板文件旁。

    占位符显示为 ``【token】``，便于在模板库直接确认占位符落在哪些位置。
    """
    pdf_relative = os.path.splitext(version.file_path)[0] + ".preview.pdf"
    pdf_absolute = _abs_path(pdf_relative)
    if os.path.exists(pdf_absolute):
        with open(pdf_absolute, "rb") as handle:
            return handle.read()

    manifest = _json(version.manifest_json, {})
    rendered = render_report(
        load_template_bytes(version),
        _sample_context(manifest),
        manifest=manifest,
        style_profile="keep",
        strict_required=False,
    )
    pdf_bytes = pdf_export.docx_to_pdf(rendered["docx"])
    _write_file(pdf_relative, pdf_bytes)
    return pdf_bytes


def artifact_pdf_bytes(db: Session, artifact: ReportArtifact) -> bytes:
    """将产物 docx 转为 PDF 并回写 ``pdf_path``，避免重复转换。"""
    if artifact.pdf_path:
        absolute = _abs_path(artifact.pdf_path)
        if os.path.exists(absolute):
            with open(absolute, "rb") as handle:
                return handle.read()
    pdf_bytes = pdf_export.docx_to_pdf(load_artifact_bytes(artifact))
    relative = f"{os.path.splitext(artifact.file_path)[0]}.pdf"
    _write_file(relative, pdf_bytes)
    artifact.pdf_path = relative
    db.commit()
    db.refresh(artifact)
    return pdf_bytes



def retry_run(
    db: Session,
    run_id: int,
    *,
    trigger_user_id: int | None = None,
) -> ReportRun:
    """基于失败运行重新创建一次运行（不复用幂等键）。"""
    source = get_run(db, run_id)
    if source.status not in {"failed", "partial"}:
        raise ReportError(INVALID_STATE, "仅失败或部分成功的运行可重试")
    return create_run(
        db,
        source.config_id,
        params=_json(source.params_json, {}),
        trigger_type="manual",
        trigger_user_id=trigger_user_id,
        idempotency_key=None,
    )


def archive_template(db: Session, template_id: int) -> ReportTemplate:
    template = get_template(db, template_id)
    active_configs = (
        db.query(ReportConfig)
        .filter(
            ReportConfig.template_id == template_id,
            ReportConfig.status == "published",
        )
        .count()
    )
    if active_configs:
        raise ReportError(CONFLICT, f"仍有 {active_configs} 个已发布配置在使用该模板")
    template.status = "archived"
    template.updated_at = beijing_now()
    db.commit()
    db.refresh(template)
    return template


def disable_config(db: Session, config_id: int) -> ReportConfig:
    config = get_config(db, config_id)
    config.status = "disabled"
    config.updated_at = beijing_now()
    db.commit()
    db.refresh(config)
    return config


# --------------------------------------------------------------------------- #
# AI 辅助
# --------------------------------------------------------------------------- #
async def create_ai_template(
    db: Session,
    *,
    code: str,
    name: str,
    description: str,
    category: str = "",
    title: str = "",
    created_by: int | None = None,
) -> dict:
    """AI 生成模板草稿：规格 → docx → manifest 校验 → 建模板 + 草稿版本。

    返回 ``{"template", "version", "spec", "model"}``；生成内容不自动发布。
    """
    from app.report.ai import (
        build_docx_from_spec,
        generate_template_spec,
        resolve_default_llm,
    )

    if not (description or "").strip():
        raise ReportError(CONFLICT, "请提供报告需求描述")
    llm, info = resolve_default_llm(db)
    spec = await generate_template_spec(llm, description, title=title or name)
    content = build_docx_from_spec(spec)

    # 先校验再落库，避免生成了无法解析的模板留下孤儿记录
    manifest = extract_manifest(content)
    issues = validate_template_spec(manifest)
    if issues:
        raise ReportError(
            AI_BAD_OUTPUT, "AI 生成的模板占位符校验未通过", {"issues": issues}
        )

    template = create_template(
        db,
        code=code,
        name=name,
        category=category,
        description=description,
        created_by=created_by,
    )
    version = add_template_version(
        db,
        template.id,
        filename=f"{template.code}.docx",
        content=content,
        source="ai",
        changelog=f"AI 生成模板草稿（{info.get('model') or '默认模型'}）",
        ai_draft=spec,
        created_by=created_by,
    )
    return {
        "template": template,
        "version": version,
        "spec": spec,
        "model": info.get("model") or "",
    }


async def create_template_from_report(
    db: Session,
    *,
    filename: str,
    content: bytes,
    code: str,
    name: str,
    category: str = "",
    description: str = "",
    hint: str = "",
    created_by: int | None = None,
) -> dict:
    """从现有 docx 报告生成模板草稿：结构识别 → AI 计划 → 原位套用占位符。

    返回 ``{"template", "version", "plan", "manifest", "warnings", "model"}``；
    生成结果不自动发布，需人工确认占位符后再发布。
    """
    from app.report.ai import resolve_default_llm
    from app.report.template_from_docx import (
        apply_plan,
        generate_plan,
        inspect_docx,
        plan_tokens,
    )

    validate_docx_upload(filename, content)
    code = (code or "").strip().lower()
    if not code or not (name or "").strip():
        raise ReportError(CONFLICT, "模板编码与名称不能为空")
    if db.query(ReportTemplate).filter(ReportTemplate.code == code).first():
        raise ReportError(CONFLICT, f"模板编码已存在: {code}")

    llm, info = resolve_default_llm(db)
    structure = inspect_docx(content)
    plan = await generate_plan(llm, structure, hint=hint)
    generated = apply_plan(content, plan)

    # 先校验再落库，避免生成无法解析的模板留下孤儿记录
    manifest = extract_manifest(generated)
    issues = validate_template_spec(manifest)
    if issues:
        raise ReportError(
            AI_BAD_OUTPUT, "生成模板的占位符校验未通过", {"issues": issues}
        )
    manifest_tokens = {
        normalize_token(item.get("token"))
        for item in manifest.get("placeholders", [])
        if isinstance(item, dict)
    }
    missing = sorted(set(plan_tokens(plan)) - manifest_tokens)
    if missing:
        raise ReportError(
            AI_BAD_OUTPUT, "部分占位符未写入模板", {"missing": missing}
        )

    warnings = list(plan.get("warnings") or [])
    for warning in manifest.get("warnings") or []:
        if warning not in warnings:
            warnings.append(warning)

    template = create_template(
        db,
        code=code,
        name=name,
        category=category,
        description=description,
        created_by=created_by,
    )
    version = add_template_version(
        db,
        template.id,
        filename=filename or f"{template.code}.docx",
        content=generated,
        source="ai_from_report",
        changelog=(
            f"基于现有报告「{filename}」生成模板草稿"
            f"（{info.get('model') or '默认模型'}）"
        ),
        ai_draft={
            "mode": "from_report",
            "source_filename": filename,
            "plan": plan,
        },
        created_by=created_by,
    )
    return {
        "template": template,
        "version": version,
        "plan": plan,
        "manifest": manifest,
        "warnings": warnings[:50],
        "model": info.get("model") or "",
    }


async def suggest_config_mappings(
    db: Session,
    config_id: int,
    *,
    version_id: int | None = None,
    params: dict | None = None,
    samples: dict | None = None,
) -> dict:
    """基于配置版本的占位符与数据源样例生成映射建议（不改动配置）。"""
    from app.report.ai import resolve_default_llm, suggest_mappings

    config = get_config(db, config_id)
    version = (
        get_config_version(db, config_id, version_id)
        if version_id
        else _published_config_version(db, config_id)
    )
    if version is None:
        raise ReportError(INVALID_STATE, "配置没有可用的版本")
    template_version = get_template_version(db, version.template_version_id)
    manifest = _json(template_version.manifest_json, {})
    specs = _json(version.data_sources_json, [])

    source_statuses = None
    if samples is None:
        results = await collect_sources(specs, params or {})
        source_statuses = {key: value.to_dict() for key, value in results.items()}
        samples = {
            key: (
                value.data
                if value.ok
                else {"_error_code": value.error_code, "_error": value.error_message}
            )
            for key, value in results.items()
        }

    source_types = {
        str(spec.get("source_key")): spec.get("source_type")
        for spec in specs
        if isinstance(spec, dict)
    }
    sources = [
        {
            "source_key": key,
            "source_type": source_types.get(key, ""),
            "sample": value,
        }
        for key, value in (samples or {}).items()
    ]
    if not sources:
        raise ReportError(SRC_INVALID, "没有可用于映射建议的数据源")

    llm, info = resolve_default_llm(db)
    result = await suggest_mappings(
        llm, manifest, sources, model=info.get("model") or ""
    )
    result.update(
        {
            "config_id": config.id,
            "config_version_no": version.version_no,
            "template_version_id": template_version.id,
        }
    )
    if source_statuses is not None:
        result["sources"] = source_statuses
    return result


# --------------------------------------------------------------------------- #
# 配置健康检查
# --------------------------------------------------------------------------- #
def _health_check(
    key: str,
    title: str,
    status: str,
    message: str,
    details: dict | None = None,
) -> dict:
    return {
        "key": key,
        "title": title,
        "status": status,
        "message": message,
        "details": details or {},
    }


def _health_payload(
    config: ReportConfig,
    version: ReportConfigVersion | None,
    checks: list[dict],
    *,
    probe: dict | None = None,
) -> dict:
    counts = {"pass": 0, "info": 0, "warning": 0, "error": 0}
    for check in checks:
        counts[check["status"]] = counts.get(check["status"], 0) + 1
    level = "error" if counts["error"] else ("warning" if counts["warning"] else "ok")
    payload = {
        "config_id": config.id,
        "config_name": config.name,
        "config_status": config.status,
        "version_id": version.id if version is not None else None,
        "version_no": version.version_no if version is not None else None,
        "version_status": version.status if version is not None else None,
        "checked_at": beijing_now().isoformat(),
        "level": level,
        "ok": counts["error"] == 0,
        "summary": counts,
        "checks": checks,
    }
    if probe is not None:
        payload["probe"] = probe
    return payload


def _check_cron(expr: str) -> bool:
    try:
        from croniter import croniter

        return bool(croniter.is_valid(expr))
    except Exception:  # noqa: BLE001
        return False


async def config_health(
    db: Session,
    config_id: int,
    *,
    version_id: int | None = None,
    params: dict | None = None,
    probe: bool = False,
) -> dict:
    """配置健康检查：静态校验 + （可选）样例采集探针。"""
    config = get_config(db, config_id)
    checks: list[dict] = []

    if config.status == "published":
        checks.append(_health_check("config_status", "配置状态", "pass", "配置已发布"))
    elif config.status == "disabled":
        checks.append(
            _health_check("config_status", "配置状态", "warning", "配置已停用，不会参与运行")
        )
    else:
        checks.append(
            _health_check("config_status", "配置状态", "warning", "配置尚未发布，仅支持预览")
        )

    cron_expr = (config.schedule_cron or "").strip()
    if not cron_expr:
        checks.append(
            _health_check("schedule_cron", "定时任务", "info", "未配置定时，仅支持手动/API 触发")
        )
    elif _check_cron(cron_expr):
        checks.append(_health_check("schedule_cron", "定时任务", "pass", f"cron 合法：{cron_expr}"))
    else:
        checks.append(
            _health_check("schedule_cron", "定时任务", "error", f"cron 表达式不合法：{cron_expr}")
        )

    version = (
        get_config_version(db, config_id, version_id)
        if version_id
        else _published_config_version(db, config_id)
    )
    if version is None:
        checks.append(
            _health_check("config_version", "配置版本", "error", "配置还没有可用版本，请先保存并发布")
        )
        return _health_payload(config, None, checks)

    if version.status == "published":
        checks.append(
            _health_check("config_version", "配置版本", "pass", f"使用已发布版本 v{version.version_no}")
        )
    else:
        checks.append(
            _health_check(
                "config_version",
                "配置版本",
                "warning",
                f"版本 v{version.version_no} 为草稿，发布前不可运行",
            )
        )

    template_version = (
        db.query(ReportTemplateVersion)
        .filter(ReportTemplateVersion.id == version.template_version_id)
        .first()
    )
    if template_version is None:
        checks.append(_health_check("template_version", "模板版本", "error", "引用的模板版本不存在"))
        manifest: dict = {}
    else:
        manifest = _json(template_version.manifest_json, {})
        if template_version.status == "published":
            checks.append(
                _health_check(
                    "template_version",
                    "模板版本",
                    "pass",
                    f"模板版本 v{template_version.version_no} 已发布",
                )
            )
        else:
            checks.append(
                _health_check(
                    "template_version",
                    "模板版本",
                    "error",
                    f"模板版本 v{template_version.version_no} 未发布",
                )
            )

    placeholders = manifest.get("placeholders", []) if isinstance(manifest, dict) else []
    data_sources = _json(version.data_sources_json, [])
    mapping = _json(version.mapping_json, {})
    bindings = mapping.get("bindings", []) if isinstance(mapping, dict) else []

    source_issues = validate_data_sources(data_sources)
    if not data_sources:
        checks.append(_health_check("data_sources", "数据源", "error", "至少需要配置一个数据源"))
    elif source_issues:
        checks.append(
            _health_check(
                "data_sources",
                "数据源",
                "error",
                f"{len(source_issues)} 项数据源配置问题",
                {"issues": source_issues},
            )
        )
    else:
        checks.append(
            _health_check("data_sources", "数据源", "pass", f"已配置 {len(data_sources)} 个数据源")
        )

    mapping_issues = validate_mapping(mapping, placeholders, require_complete=False)
    if mapping_issues:
        checks.append(
            _health_check(
                "mapping_schema",
                "映射结构",
                "error",
                f"{len(mapping_issues)} 项映射配置问题",
                {"issues": mapping_issues},
            )
        )
    else:
        checks.append(
            _health_check("mapping_schema", "映射结构", "pass", f"已配置 {len(bindings)} 条映射绑定")
        )

    bound_tokens = {
        normalize_token(item.get("token"))
        for item in bindings
        if isinstance(item, dict) and item.get("token")
    }
    bound_ids = {
        str(item.get("placeholder_id"))
        for item in bindings
        if isinstance(item, dict) and item.get("placeholder_id")
    }
    required_placeholders = [
        item
        for item in placeholders
        if isinstance(item, dict) and item.get("required")
    ]
    missing_required = [
        item.get("token") or str(item.get("id"))
        for item in required_placeholders
        if str(item.get("id")) not in bound_ids
        and normalize_token(item.get("token")) not in bound_tokens
    ]
    if missing_required:
        checks.append(
            _health_check(
                "required_bindings",
                "必填占位符绑定",
                "error",
                f"{len(missing_required)} 个必填占位符未绑定",
                {"tokens": missing_required},
            )
        )
    elif required_placeholders:
        checks.append(
            _health_check(
                "required_bindings",
                "必填占位符绑定",
                "pass",
                f"必填占位符已全部绑定（{len(required_placeholders)} 个）",
            )
        )
    else:
        checks.append(
            _health_check("required_bindings", "必填占位符绑定", "pass", "模板没有必填占位符")
        )

    source_keys = {
        str(item.get("source_key"))
        for item in data_sources
        if isinstance(item, dict) and item.get("source_key")
    }
    orphan_bindings = [
        {"token": item.get("token"), "source_key": item.get("source_key")}
        for item in bindings
        if isinstance(item, dict)
        and str(item.get("source_key") or "").strip()
        and str(item.get("source_key")).strip() not in source_keys
    ]
    if orphan_bindings:
        checks.append(
            _health_check(
                "binding_sources",
                "绑定数据源引用",
                "warning",
                f"{len(orphan_bindings)} 条绑定引用了不存在的数据源",
                {"items": orphan_bindings},
            )
        )
    else:
        checks.append(
            _health_check("binding_sources", "绑定数据源引用", "pass", "所有绑定均指向已配置的数据源")
        )

    table_total = 0
    table_missing: list[dict] = []
    table_extra: list[dict] = []
    for placeholder in placeholders:
        if not isinstance(placeholder, dict) or placeholder.get("type") != "table":
            continue
        table_total += 1
        token = normalize_token(placeholder.get("token"))
        binding = next(
            (
                item
                for item in bindings
                if isinstance(item, dict) and normalize_token(item.get("token")) == token
            ),
            None,
        )
        if binding is None:
            continue
        expected = {
            str(column.get("key"))
            for column in (placeholder.get("columns") or [])
            if isinstance(column, dict)
        }
        actual = {str(key) for key in (binding.get("columns") or {}).keys()}
        for key in sorted(expected - actual):
            table_missing.append({"token": token, "column": key})
        for key in sorted(actual - expected):
            table_extra.append({"token": token, "column": key})
    if table_missing:
        checks.append(
            _health_check(
                "table_columns",
                "表格列映射",
                "warning",
                f"{len(table_missing)} 个表格列未映射",
                {"missing": table_missing, "extra": table_extra},
            )
        )
    elif table_extra:
        checks.append(
            _health_check(
                "table_columns",
                "表格列映射",
                "info",
                f"{len(table_extra)} 个多余列映射（模板中不存在）",
                {"extra": table_extra},
            )
        )
    elif table_total:
        checks.append(
            _health_check("table_columns", "表格列映射", "pass", f"{table_total} 个表格列映射完整")
        )
    else:
        checks.append(
            _health_check("table_columns", "表格列映射", "info", "模板没有表格循环")
        )

    latest_run = (
        db.query(ReportRun)
        .filter(ReportRun.config_id == config_id)
        .order_by(ReportRun.id.desc())
        .first()
    )
    if latest_run is None:
        checks.append(_health_check("last_run", "最近运行", "info", "还没有运行记录"))
    elif latest_run.status == "succeeded":
        checks.append(
            _health_check(
                "last_run",
                "最近运行",
                "pass",
                f"运行 #{latest_run.id} 成功",
                {"run_id": latest_run.id, "status": latest_run.status},
            )
        )
    elif latest_run.status in {"failed", "partial"}:
        checks.append(
            _health_check(
                "last_run",
                "最近运行",
                "warning",
                f"运行 #{latest_run.id} {latest_run.status}: "
                f"{latest_run.error_code or ''} {latest_run.error_message or ''}".strip(),
                {
                    "run_id": latest_run.id,
                    "status": latest_run.status,
                    "error_code": latest_run.error_code,
                    "error_message": latest_run.error_message,
                },
            )
        )
    else:
        checks.append(
            _health_check(
                "last_run",
                "最近运行",
                "info",
                f"运行 #{latest_run.id} 状态：{latest_run.status}",
                {"run_id": latest_run.id, "status": latest_run.status},
            )
        )

    pdf_capability = pdf_export.capability()
    if pdf_capability["available"]:
        checks.append(
            _health_check(
                "pdf_export",
                "PDF 预览",
                "pass",
                "PDF 保真预览可用",
                {"binary": pdf_capability["binary"]},
            )
        )
    else:
        checks.append(
            _health_check(
                "pdf_export",
                "PDF 预览",
                "warning",
                "服务端未安装 LibreOffice，PDF 预览不可用",
                {"hint": pdf_capability["hint"]},
            )
        )

    probe_payload = None
    if probe:
        cross_checks = mapping.get("cross_checks", []) if isinstance(mapping, dict) else []
        try:
            built = await collect_and_build(
                data_sources,
                bindings,
                params or {},
                cross_checks=cross_checks,
            )
        except ReportError as exc:
            checks.append(
                _health_check(
                    "sample_collection",
                    "样例采集",
                    "error",
                    exc.message,
                    {"code": exc.code, **exc.detail},
                )
            )
            checks.append(
                _health_check("mapping_hits", "映射命中", "error", "采集失败，无法校验映射")
            )
            probe_payload = {"sources": {}, "issues": [], "context_keys": [], "lineage": []}
        except Exception as exc:  # noqa: BLE001
            logger.exception("健康检查探针采集失败 config=%s", config_id)
            checks.append(
                _health_check("sample_collection", "样例采集", "error", f"采集异常: {exc}")
            )
            checks.append(
                _health_check("mapping_hits", "映射命中", "error", "采集失败，无法校验映射")
            )
            probe_payload = {"sources": {}, "issues": [], "context_keys": [], "lineage": []}
        else:
            sources = built.get("sources") or {}
            failed_sources = {
                key: value for key, value in sources.items() if not value.get("ok")
            }
            if failed_sources:
                checks.append(
                    _health_check(
                        "sample_collection",
                        "样例采集",
                        "error",
                        f"{len(failed_sources)} 个数据源采集失败",
                        {"sources": failed_sources},
                    )
                )
            else:
                checks.append(
                    _health_check(
                        "sample_collection",
                        "样例采集",
                        "pass",
                        f"{len(sources)} 个数据源采集成功",
                        {"sources": {key: {"latency_ms": value.get("latency_ms")} for key, value in sources.items()}},
                    )
                )

            issues = built.get("issues") or []
            error_issues = [
                item for item in issues if (item.get("severity") or "error") == "error"
            ]
            missing_issues = [
                item
                for item in issues
                if (item.get("severity") or "error") != "error"
                and item.get("code") == MAP_MISSING
            ]
            if error_issues:
                checks.append(
                    _health_check(
                        "mapping_hits",
                        "映射命中",
                        "error",
                        f"{len(error_issues)} 条映射未命中数据",
                        {"issues": error_issues},
                    )
                )
            elif missing_issues:
                checks.append(
                    _health_check(
                        "mapping_hits",
                        "映射命中",
                        "warning",
                        f"{len(missing_issues)} 条映射未命中数据（已按缺失策略降级）",
                        {"issues": missing_issues},
                    )
                )
            else:
                checks.append(
                    _health_check(
                        "mapping_hits",
                        "映射命中",
                        "pass",
                        "所有映射均命中样例数据",
                        {"binding_count": len(bindings)},
                    )
                )
            probe_payload = {
                "sources": sources,
                "issues": issues,
                "context_keys": sorted((built.get("context") or {}).keys()),
                "lineage": built.get("lineage") or [],
            }

    return _health_payload(config, version, checks, probe=probe_payload)
