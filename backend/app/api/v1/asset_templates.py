"""资产类型模板 API。

提供资产类型模板的 CRUD 端点，支持：
- 列出所有模板（按 sort_order 排序）
- 获取单个模板详情
- 创建自定义模板
- 更新模板（预设模板可改 name/fields/icon/color/identifier_field/description，不可改 code）
- 删除模板（预设模板不可删除）

模板定义了某一类资产的数据模型（字段 schema + 元信息），
资产管理页面的表单、列表列、导入/导出均按模板动态适配。
"""
import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.dependencies import get_current_user, require_role
from app.database import get_db
from app.models.asset import AssetTypeTemplate
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/asset-templates", tags=["asset-templates"])

# 导出文件格式标识：导入时接受该信封、模板数组或单个模板对象
EXPORT_FORMAT = "soar.asset-type-template"
EXPORT_VERSION = 1

# 模板字段允许的映射目标（与 Asset 标准列保持一致）
_STANDARD_COLUMNS = {
    "name", "asset_type", "department", "owner", "location",
    "ip", "criticality", "status",
}
_FIELD_TYPES = {"text", "number", "date", "select", "textarea", "ip", "cidr"}


# ============================================================================
# 请求/响应模型
# ============================================================================

class TemplateFieldDef(BaseModel):
    """模板字段定义。"""
    key: str = Field(..., description="字段键名（英文）")
    label: str = Field(..., description="显示标签（中文）")
    type: str = Field("text", description="字段类型：text/number/date/select/textarea/ip/cidr")
    mapped_to: str = Field("extra", description="映射目标：extra 或 standard:<col>")
    required: bool = Field(False, description="是否必填")
    unique: bool = Field(False, description="是否参与唯一性校验（标识字段为 true）")
    options: list[str] | None = Field(None, description="select 类型的选项列表")
    placeholder: str = Field("", description="输入框占位提示")
    default: str = Field("", description="默认值")
    width: str = Field("half", description="表单布局宽度：half/full")
    sort_order: int = Field(0, description="排序权重")
    show_in_list: bool = Field(True, description="是否在列表中显示为列")
    show_in_detail: bool = Field(True, description="是否在详情中显示")


class TemplateCreateRequest(BaseModel):
    """创建模板请求体。"""
    code: str = Field(..., min_length=2, max_length=64, description="模板代码（唯一）")
    name: str = Field(..., min_length=1, max_length=64, description="模板名称")
    description: str = Field("", description="模板描述")
    icon: str = Field("server", description="lucide 图标名")
    color: str = Field("chart-1", description="主题色令牌")
    identifier_field: str = Field("ip", description="用作唯一标识的字段 key")
    fields: list[TemplateFieldDef] = Field(..., description="字段定义列表")
    allow_aggregate: bool = Field(
        False,
        description="是否允许标识聚合：开启后同一标识（如网段）允许不同使用单位共存，"
        "列表中按标识分组展开显示；关闭时标识全局唯一",
    )


class TemplateUpdateRequest(BaseModel):
    """更新模板请求体。所有字段可选。"""
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    identifier_field: str | None = None
    fields: list[TemplateFieldDef] | None = None
    allow_aggregate: bool | None = None


class TemplateImportRequest(BaseModel):
    """导入类型模板请求体。

    支持单模板 ``template`` 或批量 ``templates``，兼容导出文件的信封结构
    （导出文件中的 ``templates`` 数组可直接作为请求体）；也兼容直接提交
    单个模板对象（顶层含 ``code``/``name``/``fields``）。
    """
    model_config = ConfigDict(extra="allow")

    template: dict | None = Field(None, description="单个模板定义")
    templates: list[dict] | None = Field(None, description="模板定义数组")


# ============================================================================
# 辅助函数
# ============================================================================

def _template_to_dict(tpl: AssetTypeTemplate) -> dict:
    """序列化模板为字典。"""
    return {
        "id": tpl.id,
        "code": tpl.code,
        "name": tpl.name,
        "description": tpl.description or "",
        "icon": tpl.icon,
        "color": tpl.color,
        "identifier_field": tpl.identifier_field,
        "fields": tpl.fields or [],
        "is_preset": tpl.is_preset,
        "allow_aggregate": bool(tpl.allow_aggregate) if tpl.allow_aggregate is not None else False,
        "sort_order": tpl.sort_order,
        "created_at": tpl.created_at.isoformat() if tpl.created_at else None,
        "updated_at": tpl.updated_at.isoformat() if tpl.updated_at else None,
    }


def _template_to_export_dict(tpl: AssetTypeTemplate) -> dict:
    """导出用模板定义：剔除服务端字段，避免导入后沿用 ID/预设标记。"""
    return {
        "code": tpl.code,
        "name": tpl.name,
        "description": tpl.description or "",
        "icon": tpl.icon,
        "color": tpl.color,
        "identifier_field": tpl.identifier_field,
        "fields": tpl.fields or [],
        "allow_aggregate": bool(tpl.allow_aggregate),
    }


def _normalize_import_item(raw: dict, index: int) -> dict:
    """校验并规整单个导入模板；非法结构抛 422（整批拒绝）。"""
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板不是 JSON 对象")

    item = dict(raw)
    # 服务端字段不允许通过导入指定
    for key in ("id", "is_preset", "sort_order", "created_at", "updated_at",
                "format", "version", "exported_at"):
        item.pop(key, None)
    for key in ("code", "name", "description", "icon", "color", "identifier_field"):
        if isinstance(item.get(key), str):
            item[key] = item[key].strip()
    if item.get("description") is None:
        item["description"] = ""

    try:
        payload = TemplateCreateRequest.model_validate(item)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"第 {index} 个模板结构非法: {exc.errors()}",
        ) from exc

    if not payload.fields:
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板至少需要一个字段")
    if len(payload.code.strip()) < 2:
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板 code 至少 2 个字符")
    if not payload.name.strip():
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板名称不能为空")

    field_keys = [f.key.strip() for f in payload.fields]
    if any(not key for key in field_keys):
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板存在空字段 key")
    if len(set(field_keys)) != len(field_keys):
        raise HTTPException(status_code=422, detail=f"第 {index} 个模板字段 key 重复")
    if payload.identifier_field not in field_keys:
        raise HTTPException(
            status_code=422,
            detail=f"第 {index} 个模板的标识字段 '{payload.identifier_field}' 不在字段列表中",
        )

    fields: list[dict] = []
    for field_index, f in enumerate(payload.fields, 1):
        key = f.key.strip()
        ftype = f.type.strip()
        mapped_to = f.mapped_to.strip()
        if ftype not in _FIELD_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"第 {index} 个模板字段 {key} 的类型 '{ftype}' 不受支持",
            )
        if mapped_to.startswith("standard:"):
            col = mapped_to.split(":", 1)[1].strip()
            if col not in _STANDARD_COLUMNS:
                raise HTTPException(
                    status_code=422,
                    detail=f"第 {index} 个模板字段 {key} 映射到未知标准列 '{col}'",
                )
            mapped_to = f"standard:{col}"
        field_dict = f.model_dump()
        field_dict.update({
            "key": key,
            "label": f.label.strip() or key,
            "type": ftype,
            "mapped_to": mapped_to,
            "sort_order": f.sort_order or field_index,
            "options": (f.options or []) if ftype == "select" else [],
        })
        fields.append(field_dict)

    return {
        "code": payload.code.strip(),
        "name": payload.name.strip(),
        "description": payload.description.strip() if payload.description else "",
        "icon": payload.icon.strip() or "server",
        "color": payload.color.strip() or "chart-1",
        "identifier_field": payload.identifier_field,
        "fields": fields,
        "allow_aggregate": bool(payload.allow_aggregate),
    }


def _unique_template_code(
    db: Session,
    base_code: str,
    reserved: set[str],
) -> tuple[str, int]:
    """生成不冲突的模板 code。

    与现有模板或同批导入模板冲突时，追加 ``_importN`` 后缀
    （首个冲突 N=1，依次递增，避免「第一个副本却是 导入2」的观感），
    返回 ``(最终 code, 后缀序号 N)``；无冲突时 N=1。
    """
    candidate = base_code
    n = 1
    while candidate in reserved or db.query(AssetTypeTemplate.id).filter_by(code=candidate).first():
        suffix = f"_import{n}"
        candidate = f"{base_code[: max(1, 64 - len(suffix))]}{suffix}"
        n += 1
    return candidate, max(n - 1, 1)


# ============================================================================
# 端点
# ============================================================================

@router.get("")
def list_templates(
    db: Session = Depends(get_db),
) -> list[dict]:
    """列出所有资产类型模板（按 sort_order 排序）。"""
    templates = db.query(AssetTypeTemplate).order_by(
        AssetTypeTemplate.sort_order.asc(),
        AssetTypeTemplate.id.asc(),
    ).all()
    return [_template_to_dict(t) for t in templates]


@router.get("/export")
def export_templates(
    codes: str = Query("", description="要导出的模板 code，逗号分隔；为空则导出全部"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """导出类型模板为 JSON 文件（支持单个/批量，用于环境迁移与分享）。

    导出内容仅包含模板定义，不含 ID/预设标记等环境相关数据；
    可直接通过 ``POST /asset-templates/import`` 导入。
    需登录（导出一次性给出全部模板定义，不应匿名可读）。
    """
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    query = db.query(AssetTypeTemplate).order_by(
        AssetTypeTemplate.sort_order.asc(),
        AssetTypeTemplate.id.asc(),
    )
    if code_list:
        templates = query.filter(AssetTypeTemplate.code.in_(code_list)).all()
        missing = set(code_list) - {t.code for t in templates}
        if missing:
            raise HTTPException(status_code=404, detail=f"模板不存在: {', '.join(sorted(missing))}")
    else:
        templates = query.all()
    if not templates:
        raise HTTPException(status_code=404, detail="暂无可导出的类型模板")

    logger.info(
        "导出资产类型模板 %d 个: user=%s, codes=%s",
        len(templates), user.username, [t.code for t in templates],
    )
    payload = {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": beijing_now().isoformat(),
        "templates": [_template_to_export_dict(t) for t in templates],
    }
    filename = (
        f"asset_template_{templates[0].code}.json"
        if len(templates) == 1
        else "asset_templates.json"
    )
    return Response(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": (
                f"attachment; filename={filename}; "
                f"filename*=UTF-8''{quote(filename)}"
            ),
        },
    )


@router.post("/import", status_code=201)
def import_templates(
    body: TemplateImportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "analyst")),
) -> dict:
    """从 JSON 导入类型模板（单模板或批量）。

    - 支持导出文件的信封结构、模板数组或单个模板对象；
    - 导入前整批校验，任一非法则整批拒绝，避免部分导入；
    - 与现有模板 code 冲突时自动追加 ``_importN`` 后缀，名称追加 ``(导入N)``；
    - 导入模板一律作为自定义模板（``is_preset=False``），不会覆盖预设模板。
    """
    items = list(body.templates or [])
    if body.template is not None:
        items.append(body.template)
    if not items and body.model_extra:
        # 直接提交单个模板对象（如 {code, name, fields, ...}）
        if body.model_extra.get("code") or body.model_extra.get("fields"):
            items.append(dict(body.model_extra))
    if not items:
        raise HTTPException(status_code=422, detail="导入内容为空（template/templates 至少提供一项）")

    normalized = [_normalize_import_item(item, i) for i, item in enumerate(items, 1)]

    max_sort = db.query(func.max(AssetTypeTemplate.sort_order)).scalar() or 0
    reserved: set[str] = set()
    results: list[dict] = []
    try:
        for offset, item in enumerate(normalized):
            base_code = item["code"]
            final_code, conflict_no = _unique_template_code(db, base_code, reserved)
            reserved.add(final_code)
            final_name = item["name"]
            renamed_from = None
            if final_code != base_code:
                renamed_from = base_code
                suffix = f"(导入{conflict_no})"
                final_name = f"{item['name'][: max(1, 64 - len(suffix))]}{suffix}"
            tpl = AssetTypeTemplate(
                code=final_code,
                name=final_name,
                description=item["description"],
                icon=item["icon"],
                color=item["color"],
                identifier_field=item["identifier_field"],
                fields=item["fields"],
                is_preset=False,
                allow_aggregate=item["allow_aggregate"],
                sort_order=max_sort + (offset + 1) * 10,
            )
            db.add(tpl)
            db.flush()
            results.append({
                "code": tpl.code,
                "name": tpl.name,
                "renamed_from": renamed_from,
            })
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("导入资产类型模板失败: %s", exc)
        raise HTTPException(status_code=500, detail="导入失败，已回滚") from exc

    logger.info(
        "导入资产类型模板 %d 个: user=%s, codes=%s",
        len(results), user.username, [r["code"] for r in results],
    )
    return {"imported": len(results), "items": results}


@router.get("/{code}")
def get_template(
    code: str,
    db: Session = Depends(get_db),
) -> dict:
    """获取单个模板详情。"""
    tpl = db.query(AssetTypeTemplate).filter_by(code=code).first()
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"模板不存在: {code}")
    return _template_to_dict(tpl)


@router.post("", status_code=201)
def create_template(
    body: TemplateCreateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "analyst")),
) -> dict:
    """创建自定义资产类型模板。

    - code 必须唯一，且不能与预设模板冲突
    - fields 中必须有至少一个字段
    - identifier_field 必须在 fields 中存在
    """
    # 查重
    existing = db.query(AssetTypeTemplate).filter_by(code=body.code).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"模板代码已存在: {body.code}")

    # 校验 identifier_field 在 fields 中
    field_keys = {f.key for f in body.fields}
    if body.identifier_field not in field_keys:
        raise HTTPException(
            status_code=422,
            detail=f"identifier_field '{body.identifier_field}' 不在 fields 中",
        )

    tpl = AssetTypeTemplate(
        code=body.code,
        name=body.name,
        description=body.description,
        icon=body.icon,
        color=body.color,
        identifier_field=body.identifier_field,
        fields=[f.model_dump() for f in body.fields],
        is_preset=False,
        allow_aggregate=bool(body.allow_aggregate),
        sort_order=db.query(AssetTypeTemplate).count() + 10,  # 自定义排预设后面
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    logger.info("创建资产类型模板: code=%s, name=%s, user=%s", tpl.code, tpl.name, user.username)
    return _template_to_dict(tpl)


@router.put("/{code}")
def update_template(
    code: str,
    body: TemplateUpdateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "analyst")),
) -> dict:
    """更新模板。

    预设模板（is_preset=True）：
    - 可修改 name/fields/icon/color/identifier_field/description
    - 不可修改 code
    自定义模板：所有字段均可修改（除 code）。
    """
    tpl = db.query(AssetTypeTemplate).filter_by(code=code).first()
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"模板不存在: {code}")

    if tpl.is_preset:
        # 预设模板：code 不可改，其余字段均可改
        if body.name is not None:
            tpl.name = body.name
        if body.description is not None:
            tpl.description = body.description
        if body.icon is not None:
            tpl.icon = body.icon
        if body.color is not None:
            tpl.color = body.color
        if body.identifier_field is not None:
            # 校验 identifier_field 在 fields 中
            if body.fields is not None:
                field_keys = {f.key for f in body.fields}
            else:
                field_keys = {f["key"] for f in (tpl.fields or [])}
            if body.identifier_field not in field_keys:
                raise HTTPException(
                    status_code=422,
                    detail=f"identifier_field '{body.identifier_field}' 不在 fields 中",
                )
            tpl.identifier_field = body.identifier_field
        if body.fields is not None:
            tpl.fields = [f.model_dump() for f in body.fields]
    else:
        # 自定义模板：可修改除 code 外的所有字段
        if body.name is not None:
            tpl.name = body.name
        if body.description is not None:
            tpl.description = body.description
        if body.icon is not None:
            tpl.icon = body.icon
        if body.color is not None:
            tpl.color = body.color
        if body.identifier_field is not None:
            if body.fields is not None:
                field_keys = {f.key for f in body.fields}
            else:
                field_keys = {f["key"] for f in (tpl.fields or [])}
            if body.identifier_field not in field_keys:
                raise HTTPException(
                    status_code=422,
                    detail=f"identifier_field '{body.identifier_field}' 不在 fields 中",
                )
            tpl.identifier_field = body.identifier_field
        if body.fields is not None:
            tpl.fields = [f.model_dump() for f in body.fields]

    # allow_aggregate 开关：预设和自定义模板均可修改
    if body.allow_aggregate is not None:
        new_val = bool(body.allow_aggregate)
        if tpl.allow_aggregate != new_val:
            tpl.allow_aggregate = new_val
            logger.info(
                "模板 %s allow_aggregate 切换为 %s（注意：从聚合切回唯一时，"
                "已有同标识不同部门的记录不会被自动合并，需手动处理）",
                code, new_val,
            )

    db.commit()
    db.refresh(tpl)
    logger.info("更新资产类型模板: code=%s, user=%s", code, user.username)
    return _template_to_dict(tpl)


@router.delete("/{code}")
def delete_template(
    code: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "analyst")),
) -> dict:
    """删除模板。

    预设模板（is_preset=True）不可删除，返回 403。
    删除模板不影响已关联的资产数据（资产的 type_code 保留，只是不再有模板定义）。
    """
    tpl = db.query(AssetTypeTemplate).filter_by(code=code).first()
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"模板不存在: {code}")
    if tpl.is_preset:
        raise HTTPException(status_code=403, detail="预设模板不可删除")

    db.delete(tpl)
    db.commit()
    logger.info("删除资产类型模板: code=%s, user=%s", code, user.username)
    return {"ok": True, "deleted": code}
