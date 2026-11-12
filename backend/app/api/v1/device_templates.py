"""内置设备库 API。

提供内置设备模板条目的列表/筛选、详情、新增、修改、删除，
以及「从现有设备识别入库」「复用模板一键创建设备」和操作日志查询。

所有写操作除全局审计中间件外，均显式记录 device_template 资源审计日志。
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.device_template_library import (
    create_template_from_device,
    instantiate_template,
)
from app.core.security import validate_outbound_url
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.device_template import DeviceTemplate, DeviceTemplateAction
from app.models.user import User
from app.schemas.common import to_dict
from app.core.timezone import to_beijing_iso

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/devices/builtin-templates", tags=["device-templates"])

_TEMPLATE_AUDIT_RESOURCE = "device_template"


def _validate_ip_address(v: str) -> str:
    from app.core.ip_validation import validate_single_ip

    return validate_single_ip(v, "设备 IP 地址", allow_empty=True)


def _tags_to_json(tags: list[str]) -> str:
    try:
        return json.dumps(list(tags or []), ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return "[]"


def _require_json(value: str, field_name: str, expect: str) -> str:
    """校验动作 JSON 字段（expect: array/object）。"""
    raw = (value or "").strip()
    if not raw:
        return "[]" if expect == "array" else "{}"
    try:
        parsed = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"{field_name} 不是合法 JSON: {exc}") from exc
    if expect == "array" and not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail=f"{field_name} 必须是 JSON 数组")
    if expect == "object" and not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail=f"{field_name} 必须是 JSON 对象")
    return raw


# ============ 请求体 ============

class TemplateBase(BaseModel):
    """内置模板基础信息。"""

    name: str = Field(..., description="模板名称")
    type: str = Field("custom", description="设备类型")
    vendor: str = Field("", description="设备厂商")
    version: str = Field("", description="对接协议/固件版本")
    description: str = Field("", description="模板描述")
    api_url: str = Field("", description="默认 API 基地址")
    auth_type: str = Field("api_key", description="认证方式")
    icon: str = Field("", description="设备图标")
    tags: list[str] = Field(default_factory=list, description="标签列表")
    timeout: int | None = Field(None, description="默认请求超时(秒)")
    max_retries: int | None = Field(None, description="默认最大重试次数")
    verify_tls: bool = Field(False, description="默认是否校验 TLS")

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("模板名称不能为空")
        return v

    @field_validator("api_url")
    @classmethod
    def _check_api_url(cls, v: str) -> str:
        v = (v or "").strip()
        if v:
            try:
                validate_outbound_url(v, field="模板 api_url")
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
        return v


class TemplateActionBody(BaseModel):
    """模板动作定义（参数定义、执行逻辑脚本等全部字段）。"""

    name: str = Field(..., description="动作名称")
    action_type: str = Field("custom", description="动作类型")
    http_method: str = Field("POST", description="HTTP 方法")
    api_path: str = Field("", description="API 路径")
    params_schema: str = Field("[]", description="参数定义 JSON 数组")
    headers: str = Field("{}", description="额外请求头 JSON 对象")
    body_template: str = Field("", description="请求体模板")
    auth_type: str = Field("api_key", description="认证方式")
    enabled: bool = Field(True, description="是否启用")
    description: str = Field("", description="动作描述")
    category: str = Field("other", description="动作分类")
    risk_level: str = Field("readonly", description="风险等级")
    example_payload: str | None = Field(None, description="示例请求体")
    example_response: str | None = Field(None, description="示例响应体")

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("动作名称不能为空")
        return v

    @field_validator("params_schema")
    @classmethod
    def _check_params(cls, v: str) -> str:
        return _require_json(v, "参数定义", "array")

    @field_validator("headers")
    @classmethod
    def _check_headers(cls, v: str) -> str:
        return _require_json(v, "额外请求头", "object")


class FromDeviceRequest(BaseModel):
    """从现有设备识别入库请求体。"""

    device_id: int = Field(..., description="源设备 ID")
    name: str = Field("", description="模板名称（留空沿用设备名称）")


class InstantiateRequest(BaseModel):
    """复用模板创建设备请求体。"""

    name: str = Field(..., description="新设备名称")
    api_url: str = Field("", description="设备 API 基地址（留空沿用模板）")
    ip_address: str = Field("", description="设备 IP 地址")
    username: str = Field("", description="用户名")
    password: str = Field("", description="密码")
    api_key: str = Field("", description="API Key / Token")
    enabled: bool = Field(True, description="是否启用")

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("设备名称不能为空")
        return v

    @field_validator("ip_address")
    @classmethod
    def _check_ip(cls, v: str) -> str:
        return _validate_ip_address(v)

    @field_validator("api_url")
    @classmethod
    def _check_api_url(cls, v: str) -> str:
        v = (v or "").strip()
        if v:
            try:
                validate_outbound_url(v, field="设备 api_url")
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
        return v


# ============ 序列化 ============

def _action_count(db: Session, template_id: int) -> int:
    return (
        db.query(func.count(DeviceTemplateAction.id))
        .filter(DeviceTemplateAction.template_id == template_id)
        .scalar()
        or 0
    )


def _template_item(db: Session, template: DeviceTemplate) -> dict:
    item = to_dict(template)
    item["action_count"] = _action_count(db, template.id)
    item["enabled_action_count"] = (
        db.query(func.count(DeviceTemplateAction.id))
        .filter(
            DeviceTemplateAction.template_id == template.id,
            DeviceTemplateAction.enabled.is_(True),
        )
        .scalar()
        or 0
    )
    return item


def _get_template(db: Session, template_id: int) -> DeviceTemplate:
    template = db.query(DeviceTemplate).filter(DeviceTemplate.id == template_id).first()
    if template is None:
        raise HTTPException(status_code=404, detail="内置设备模板不存在")
    return template


def _audit(db: Session, user: User, request: Request, action: str, template_id, detail: dict) -> None:
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action=action,
        resource_type=_TEMPLATE_AUDIT_RESOURCE,
        resource_id=template_id,
        detail=detail,
        ip_address=get_client_ip(request),
        result="success",
    )


# ============ 模板条目 CRUD ============

@router.get("", dependencies=[Depends(get_current_user)])
def list_templates(
    search: str = Query("", description="按名称/厂商/描述/版本模糊搜索"),
    type: str = Query("", description="设备类型筛选"),
    vendor: str = Query("", description="厂商筛选"),
    source: str = Query("", description="来源筛选: builtin/device/manual"),
    db: Session = Depends(get_db),
) -> dict:
    """列出内置设备模板（按设备类型、厂商维度排序）。"""
    query = db.query(DeviceTemplate)
    keyword = (search or "").strip()
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            DeviceTemplate.name.like(like)
            | DeviceTemplate.vendor.like(like)
            | DeviceTemplate.description.like(like)
            | DeviceTemplate.version.like(like)
            | DeviceTemplate.source_device_name.like(like)
        )
    if type:
        query = query.filter(DeviceTemplate.type == type)
    if vendor:
        query = query.filter(DeviceTemplate.vendor == vendor)
    if source:
        query = query.filter(DeviceTemplate.source == source)

    templates = query.order_by(
        DeviceTemplate.type.asc(),
        DeviceTemplate.vendor.asc(),
        DeviceTemplate.name.asc(),
    ).all()
    items = [_template_item(db, t) for t in templates]

    type_rows = (
        db.query(DeviceTemplate.type, func.count(DeviceTemplate.id))
        .group_by(DeviceTemplate.type)
        .all()
    )
    vendor_rows = (
        db.query(DeviceTemplate.vendor, func.count(DeviceTemplate.id))
        .group_by(DeviceTemplate.vendor)
        .all()
    )
    return {
        "total": len(items),
        "items": items,
        "types": [{"value": t or "custom", "count": c} for t, c in type_rows],
        "vendors": [{"value": v or "", "count": c} for v, c in vendor_rows],
    }


@router.get("/{template_id}", dependencies=[Depends(get_current_user)])
def get_template(template_id: int, db: Session = Depends(get_db)) -> dict:
    """模板详情（含全部固化动作）。"""
    template = _get_template(db, template_id)
    actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template_id)
        .order_by(DeviceTemplateAction.sort_order.asc(), DeviceTemplateAction.id.asc())
        .all()
    )
    result = _template_item(db, template)
    result["actions"] = [to_dict(a) for a in actions]
    return result


@router.post("", status_code=201)
def create_template(
    body: TemplateBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """手动新增内置模板条目（不含动作）。"""
    template = DeviceTemplate(
        name=body.name,
        type=body.type or "custom",
        vendor=body.vendor,
        version=body.version,
        description=body.description,
        api_url=body.api_url,
        auth_type=body.auth_type,
        icon=body.icon,
        tags=_tags_to_json(body.tags),
        timeout=body.timeout,
        max_retries=body.max_retries,
        verify_tls=body.verify_tls,
        source="manual",
        created_by=user.username,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    _audit(
        db, user, request, "create", template.id,
        {"name": template.name, "type": template.type, "vendor": template.vendor},
    )
    return _template_item(db, template)


@router.put("/{template_id}")
def update_template(
    template_id: int,
    body: TemplateBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """修改模板基础信息（仅影响模板，不影响任何源设备）。"""
    template = _get_template(db, template_id)
    changes: dict = {}
    payload = body.model_dump()
    payload["tags"] = _tags_to_json(body.tags)
    for field_name, new_val in payload.items():
        old_val = getattr(template, field_name)
        if old_val != new_val:
            changes[field_name] = {"old": old_val, "new": new_val}
            setattr(template, field_name, new_val)
    db.commit()
    db.refresh(template)
    _audit(db, user, request, "update", template.id, {"name": template.name, "changes": changes})
    return _template_item(db, template)


@router.delete("/{template_id}")
def delete_template(
    template_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """删除内置模板条目及其下全部动作（前端需二次确认）。"""
    template = _get_template(db, template_id)
    action_count = _action_count(db, template_id)
    detail = {
        "name": template.name,
        "type": template.type,
        "vendor": template.vendor,
        "actions_deleted": action_count,
    }
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template_id
    ).delete(synchronize_session=False)
    db.delete(template)
    db.commit()
    _audit(db, user, request, "delete", template_id, detail)
    return {"ok": True, "deleted_actions": action_count}


# ============ 从现有设备识别入库 ============

@router.post("/from-device", status_code=201)
def import_from_device(
    body: FromDeviceRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """把现有设备（含全部动作）固化为内置模板条目。"""
    device = db.query(Device).filter(Device.id == body.device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="源设备不存在")
    template, action_count = create_template_from_device(
        db,
        device,
        name=(body.name or "").strip() or device.name,
        source="device",
        created_by=user.username,
    )
    db.commit()
    db.refresh(template)
    _audit(
        db, user, request, "import", template.id,
        {
            "name": template.name,
            "source_device_id": device.id,
            "source_device_name": device.name,
            "actions": action_count,
        },
    )
    return _template_item(db, template)


# ============ 复用模板创建设备 ============

@router.post("/{template_id}/instantiate", status_code=201)
def instantiate(
    template_id: int,
    body: InstantiateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """复用内置模板创建新设备，完整复制模板下全部动作。"""
    template = _get_template(db, template_id)
    try:
        device, action_count = instantiate_template(
            db,
            template,
            name=body.name,
            api_url=body.api_url,
            ip_address=body.ip_address,
            username=body.username,
            password=body.password,
            api_key=body.api_key,
            enabled=body.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(device)
    _audit(
        db, user, request, "instantiate", template.id,
        {
            "template_name": template.name,
            "device_id": device.id,
            "device_name": device.name,
            "actions": action_count,
        },
    )
    logger.info("复用内置模板创建设备成功: template=%s device=%s", template_id, device.id)
    return {
        "device": to_dict(device, exclude={"api_key", "username", "password"}),
        "actions_created": action_count,
    }


# ============ 模板动作 CRUD ============

def _get_template_action(db: Session, template_id: int, action_id: int) -> DeviceTemplateAction:
    action = (
        db.query(DeviceTemplateAction)
        .filter(
            DeviceTemplateAction.id == action_id,
            DeviceTemplateAction.template_id == template_id,
        )
        .first()
    )
    if action is None:
        raise HTTPException(status_code=404, detail="模板动作不存在")
    return action


def _apply_action_body(action: DeviceTemplateAction, body: TemplateActionBody) -> None:
    action.name = body.name
    action.action_type = body.action_type
    action.http_method = (body.http_method or "POST").upper()
    action.api_path = body.api_path
    action.params_schema = body.params_schema
    action.headers = body.headers
    action.body_template = body.body_template
    action.auth_type = body.auth_type
    action.enabled = body.enabled
    action.description = body.description
    action.category = body.category
    action.risk_level = body.risk_level
    action.example_payload = body.example_payload
    action.example_response = body.example_response


@router.get("/{template_id}/actions", dependencies=[Depends(get_current_user)])
def list_template_actions(template_id: int, db: Session = Depends(get_db)) -> list[dict]:
    """列出模板下全部固化动作。"""
    _get_template(db, template_id)
    actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template_id)
        .order_by(DeviceTemplateAction.sort_order.asc(), DeviceTemplateAction.id.asc())
        .all()
    )
    return [to_dict(a) for a in actions]


@router.post("/{template_id}/actions", status_code=201)
def create_template_action(
    template_id: int,
    body: TemplateActionBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """在模板下新增动作。"""
    _get_template(db, template_id)
    max_order = (
        db.query(func.max(DeviceTemplateAction.sort_order))
        .filter(DeviceTemplateAction.template_id == template_id)
        .scalar()
    )
    action = DeviceTemplateAction(template_id=template_id, sort_order=(max_order or 0) + 1)
    _apply_action_body(action, body)
    db.add(action)
    db.commit()
    db.refresh(action)
    _audit(db, user, request, "create_action", template_id, {"action": action.name})
    return to_dict(action)


@router.put("/{template_id}/actions/{action_id}")
def update_template_action(
    template_id: int,
    action_id: int,
    body: TemplateActionBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """修改模板动作（仅影响模板，不影响源设备动作）。"""
    _get_template(db, template_id)
    action = _get_template_action(db, template_id, action_id)
    before = {
        "name": action.name,
        "api_path": action.api_path,
        "http_method": action.http_method,
    }
    _apply_action_body(action, body)
    action.version = (action.version or 1) + 1
    db.commit()
    db.refresh(action)
    _audit(
        db, user, request, "update_action", template_id,
        {"action_id": action.id, "before": before, "after": {"name": action.name, "api_path": action.api_path}},
    )
    return to_dict(action)


@router.delete("/{template_id}/actions/{action_id}")
def delete_template_action(
    template_id: int,
    action_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """删除模板动作。"""
    _get_template(db, template_id)
    action = _get_template_action(db, template_id, action_id)
    detail = {"action_id": action.id, "action": action.name}
    db.delete(action)
    db.commit()
    _audit(db, user, request, "delete_action", template_id, detail)
    return {"ok": True}


# ============ 操作日志 ============

@router.get("/{template_id}/logs", dependencies=[Depends(get_current_user)])
def list_template_logs(
    template_id: int,
    limit: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """查询该模板的操作日志（审计日志）。"""
    _get_template(db, template_id)
    logs = (
        db.query(AuditLog)
        .filter(
            AuditLog.resource_type == _TEMPLATE_AUDIT_RESOURCE,
            AuditLog.resource_id == str(template_id),
        )
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
        .all()
    )
    return {
        "items": [
            {
                "id": lg.id,
                "username": lg.username or "",
                "action": lg.action,
                "detail": lg.detail,
                "ip_address": lg.ip_address or "",
                "result": lg.result,
                "created_at": to_beijing_iso(lg.created_at) if lg.created_at else None,
            }
            for lg in logs
        ]
    }
