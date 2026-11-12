"""内置设备库服务。

职责：
- 将现有设备（含全部动作）固化为内置模板条目（快照，与源设备解耦）
- 复用模板创建新设备，并完整复制模板下的全部动作
- 幂等注册系统内置模板（当前为青藤万相主机安全管理）

模板只保存设备的基础元数据与动作定义，不保存任何账号、密码、API Key 等凭据。
"""
import json
import logging
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.qingteng_wanxiang_actions import QINGTENG_WANXIANG_ACTIONS
from app.core.sangfor_xdr_actions import SANGFOR_XDR_ACTIONS
from app.core.security import encrypt_device_secret, validate_outbound_url
from app.models.device import Device, DeviceAction
from app.models.device_template import DeviceTemplate, DeviceTemplateAction
from app.models.system_config import SystemConfig

logger = logging.getLogger(__name__)

# 内置设备库只需初始化一次；用户删除内置条目后不会在重启时被自动重建
_SEED_FLAG_KEY = "device_builtin_library_seeded"

# 青藤万相内置模板固定元数据（名称/厂商/类型/协议版本均固定，保证标准化）
QINGTENG_TEMPLATE_CODE = "qingteng_wanxiang"
QINGTENG_TEMPLATE_NAME = "青藤万相主机安全管理"
QINGTENG_TEMPLATE_VENDOR = "青藤"
QINGTENG_TEMPLATE_TYPE = "edr"
QINGTENG_TEMPLATE_VERSION = "v3.4.1.66"
QINGTENG_TEMPLATE_DESCRIPTION = (
    "青藤万相主机自适应保护平台（外部 API v3.4.1.66）内置模板：资产清点、风险发现、"
    "入侵检测、合规基线、系统审计、快速任务、主机发现、微隔离的只读查询动作集合。"
    "认证方式为青藤动态签名，由动作执行器自动处理。"
)
QINGTENG_TEMPLATE_TAGS = '["青藤", "qingteng", "主机安全"]'
QINGTENG_DEVICE_KEYWORD = "青藤万相"

# 深信服 XDR 内置模板固定元数据（安全告警 / 安全事件 OpenAPI 动作集合）
SANGFOR_XDR_TEMPLATE_CODE = "sangfor_xdr"
SANGFOR_XDR_TEMPLATE_NAME = "深信服XDR安全管理平台"
SANGFOR_XDR_TEMPLATE_VENDOR = "深信服"
SANGFOR_XDR_TEMPLATE_TYPE = "custom"
SANGFOR_XDR_TEMPLATE_VERSION = "OpenAPI v1"
SANGFOR_XDR_TEMPLATE_DESCRIPTION = (
    "深信服 XDR 开放性 OpenAPI 内置模板：覆盖安全告警（alerts）、安全事件（incidents）"
    "与资产（assets/riskassets/bigscreen branch）接口，含列表查询、聚合统计、趋势分析、"
    "详情查询、处置状态更新、事件驳回、资产组层级查询与资产明细查询等动作。"
    "认证方式为 AK/SK 联动码签名（联动码填入设备 API Key），由动作执行器自动完成签名。"
)
SANGFOR_XDR_TEMPLATE_TAGS = '["深信服", "sangfor", "XDR", "安全告警", "安全事件", "资产管理"]'

# 深信服 XDR 模板独立初始化标记：与青藤模板互不影响
_SANGFOR_XDR_SEED_FLAG_KEY = "sangfor_xdr_template_seeded_v1"


def _json_text(value: Any, default: str) -> str:
    """把 dict/list 序列化为 JSON 字符串；字符串原样返回（非法时回退默认值）。"""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            json.loads(value)
            return value
        except Exception:  # noqa: BLE001
            return default
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return default


def _field(src: Any, name: str, default: Any = None) -> Any:
    """兼容 ORM 对象与 dict 读取字段。"""
    if isinstance(src, dict):
        return src.get(name, default)
    return getattr(src, name, default)


def _build_template_action(template_id: int, src: Any, sort_order: int) -> DeviceTemplateAction:
    """按源动作（DeviceAction 或动作定义 dict）构造模板动作。"""
    example_response = _field(src, "example_response")
    if example_response is None:
        response_fields = _field(src, "response_fields")
        example_response = (
            json.dumps(response_fields, ensure_ascii=False) if response_fields is not None else None
        )
    elif not isinstance(example_response, str):
        example_response = json.dumps(example_response, ensure_ascii=False)

    return DeviceTemplateAction(
        template_id=template_id,
        name=_field(src, "name", "") or "",
        action_type=_field(src, "action_type", "custom") or "custom",
        http_method=_field(src, "http_method", "POST") or "POST",
        api_path=_field(src, "api_path", "") or "",
        params_schema=_json_text(_field(src, "params_schema"), "[]"),
        headers=_json_text(_field(src, "headers"), "{}"),
        body_template=_field(src, "body_template", "") or "",
        auth_type=_field(src, "auth_type", "api_key") or "api_key",
        enabled=bool(_field(src, "enabled", True)),
        description=_field(src, "description", "") or "",
        category=_field(src, "category", "other") or "other",
        risk_level=_field(src, "risk_level", "readonly") or "readonly",
        version=int(_field(src, "version", 1) or 1),
        example_payload=_field(src, "example_payload"),
        example_response=example_response,
        sort_order=sort_order,
    )


def create_template_from_device(
    db: Session,
    device: Device,
    *,
    name: str | None = None,
    code: str | None = None,
    source: str = "device",
    created_by: str = "",
    overrides: dict[str, Any] | None = None,
) -> tuple[DeviceTemplate, int]:
    """把现有设备（基础信息 + 全部动作）快照为内置模板条目。

    快照只复制可复用配置，不复制 api_key/username/password 等凭据。
    """
    template = DeviceTemplate(
        code=code,
        name=(name or device.name or "").strip(),
        type=device.type or "custom",
        vendor=device.vendor or "",
        version=device.version or "",
        description=device.description or "",
        api_url=device.api_url or "",
        auth_type=device.auth_type or "api_key",
        icon=device.icon or "",
        tags=device.tags or "[]",
        timeout=device.timeout,
        max_retries=device.max_retries,
        verify_tls=bool(device.verify_tls),
        source=source,
        source_device_id=device.id,
        source_device_name=device.name or "",
        created_by=created_by,
    )
    for field_name, value in (overrides or {}).items():
        if hasattr(template, field_name):
            setattr(template, field_name, value)
    db.add(template)
    db.flush()

    actions = (
        db.query(DeviceAction)
        .filter(DeviceAction.device_id == device.id)
        .order_by(DeviceAction.id.asc())
        .all()
    )
    for idx, action in enumerate(actions):
        db.add(_build_template_action(template.id, action, idx))
    logger.info(
        "设备已固化为内置模板: template_id=%s source_device=%s actions=%s",
        template.id, device.id, len(actions),
    )
    return template, len(actions)


def create_template_from_specs(
    db: Session,
    specs: list[dict[str, Any]],
    *,
    name: str,
    type: str,
    vendor: str,
    version: str = "",
    description: str = "",
    auth_type: str = "api_key",
    api_url: str = "",
    icon: str = "",
    tags: str = "[]",
    timeout: int | None = None,
    max_retries: int | None = None,
    verify_tls: bool = False,
    code: str | None = None,
    source: str = "manual",
    created_by: str = "",
) -> tuple[DeviceTemplate, int]:
    """按动作定义列表创建内置模板（用于系统预置且库中无源设备的场景）。"""
    template = DeviceTemplate(
        code=code,
        name=name,
        type=type,
        vendor=vendor,
        version=version,
        description=description,
        api_url=api_url,
        auth_type=auth_type,
        icon=icon,
        tags=tags,
        timeout=timeout,
        max_retries=max_retries,
        verify_tls=verify_tls,
        source=source,
        source_device_name="",
        created_by=created_by,
    )
    db.add(template)
    db.flush()

    for idx, spec in enumerate(specs):
        db.add(_build_template_action(template.id, spec, idx))
    logger.info("内置模板已创建: template_id=%s actions=%s", template.id, len(specs))
    return template, len(specs)


def instantiate_template(
    db: Session,
    template: DeviceTemplate,
    *,
    name: str,
    api_url: str = "",
    ip_address: str = "",
    username: str = "",
    password: str = "",
    api_key: str = "",
    enabled: bool = True,
) -> tuple[Device, int]:
    """复用内置模板创建新设备，完整复制模板下全部动作。"""
    final_url = (api_url or template.api_url or "").strip()
    if final_url:
        try:
            validate_outbound_url(final_url, field="设备 api_url")
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

    if template.auth_type == "sangfor_xdr" and api_key:
        try:
            from app.tools.xdr_openapi import parse_auth_code

            ak, sk = parse_auth_code(api_key.strip())
            api_key, password = ak, sk
        except Exception:  # noqa: BLE001
            # 非联动码格式时按 api_key=AK、password=SK 直接使用
            pass

    device = Device(
        name=name.strip(),
        type=template.type or "custom",
        vendor=template.vendor or "",
        version=template.version or "",
        ip_address=ip_address or "",
        api_url=final_url,
        api_key=encrypt_device_secret(api_key),
        username=encrypt_device_secret(username),
        password=encrypt_device_secret(password),
        enabled=enabled,
        description=template.description or "",
        auth_type=template.auth_type or "api_key",
        timeout=template.timeout,
        max_retries=template.max_retries,
        verify_tls=bool(template.verify_tls),
        tags=template.tags or "[]",
        icon=template.icon or "",
        status="unconfigured",
    )
    db.add(device)
    db.flush()

    template_actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .order_by(DeviceTemplateAction.sort_order.asc(), DeviceTemplateAction.id.asc())
        .all()
    )
    for item in template_actions:
        db.add(
            DeviceAction(
                device_id=device.id,
                name=item.name,
                action_type=item.action_type,
                http_method=item.http_method,
                api_path=item.api_path,
                params_schema=item.params_schema,
                headers=item.headers,
                body_template=item.body_template,
                auth_type=item.auth_type,
                enabled=bool(item.enabled),
                description=item.description,
                category=item.category,
                risk_level=item.risk_level,
                version=item.version or 1,
                example_payload=item.example_payload,
                example_response=item.example_response,
            )
        )
    logger.info(
        "已复用内置模板创建设备: template_id=%s device_id=%s actions=%s",
        template.id, device.id, len(template_actions),
    )
    return device, len(template_actions)


def seed_builtin_device_templates(db: Session) -> bool:
    """幂等注册系统内置模板（青藤万相主机安全管理）。

    - 初始化标记只写入一次，用户删除内置条目后不会在重启时自动重建；
    - 已存在同 code 模板时跳过，绝不覆盖用户对模板的修改；
    - 优先从库中已对接的青藤万相设备快照（含全部已配置动作）；
      库中无该设备时回退到内置动作定义，保证内置条目始终可用。

    Returns:
        是否新建了模板。
    """
    flag = db.query(SystemConfig).filter(SystemConfig.key == _SEED_FLAG_KEY).first()
    if flag is not None and (flag.value or "") == "1":
        return False

    def _mark_seeded() -> None:
        if flag is None:
            db.add(
                SystemConfig(
                    key=_SEED_FLAG_KEY,
                    value="1",
                    description="内置设备库已完成初始化（避免删除后重启自动重建）",
                )
            )
        else:
            flag.value = "1"

    exists = (
        db.query(DeviceTemplate.id)
        .filter(DeviceTemplate.code == QINGTENG_TEMPLATE_CODE)
        .first()
    )
    if exists:
        _mark_seeded()
        return False

    device = (
        db.query(Device)
        .filter(Device.auth_type == "qingteng")
        .order_by(Device.id.asc())
        .first()
    )
    if device is None:
        device = (
            db.query(Device)
            .filter(Device.name.like(f"%{QINGTENG_DEVICE_KEYWORD}%"))
            .order_by(Device.id.asc())
            .first()
        )

    override_meta = {
        "name": QINGTENG_TEMPLATE_NAME,
        "type": QINGTENG_TEMPLATE_TYPE,
        "vendor": QINGTENG_TEMPLATE_VENDOR,
        "version": QINGTENG_TEMPLATE_VERSION,
        "description": QINGTENG_TEMPLATE_DESCRIPTION,
        "auth_type": "qingteng",
        "tags": QINGTENG_TEMPLATE_TAGS,
    }

    if device is not None:
        override_meta["version"] = device.version or QINGTENG_TEMPLATE_VERSION
        create_template_from_device(
            db,
            device,
            name=QINGTENG_TEMPLATE_NAME,
            code=QINGTENG_TEMPLATE_CODE,
            source="builtin",
            created_by="system",
            overrides=override_meta,
        )
        logger.info("内置设备库：已从现有青藤万相设备识别入库（device_id=%s）", device.id)
    else:
        create_template_from_specs(
            db,
            QINGTENG_WANXIANG_ACTIONS,
            name=QINGTENG_TEMPLATE_NAME,
            type=QINGTENG_TEMPLATE_TYPE,
            vendor=QINGTENG_TEMPLATE_VENDOR,
            version=QINGTENG_TEMPLATE_VERSION,
            description=QINGTENG_TEMPLATE_DESCRIPTION,
            auth_type="qingteng",
            tags=QINGTENG_TEMPLATE_TAGS,
            icon="💻",
            timeout=30,
            max_retries=0,
            code=QINGTENG_TEMPLATE_CODE,
            source="builtin",
            created_by="system",
        )
        logger.info("内置设备库：库中无青藤万相设备，已按内置动作定义创建模板")
    _mark_seeded()
    return True


def _sync_sangfor_xdr_action_versions(db: Session, template: DeviceTemplate) -> int:
    """把内置清单中已升级的动作定义同步到模板动作与存量设备动作。

    仅当 DB 记录的 version 低于内置 spec 的 version 时，刷新
    description/params_schema/example_payload/example_response/version
    （用于修正动作描述/参数说明中的接口口径错误）；用户自改且
    version 不低于内置版本的动作不受影响。

    Returns:
        本次同步刷新的动作记录数（模板 + 设备）。
    """
    synced = 0
    for spec in SANGFOR_XDR_ACTIONS:
        spec_version = int(spec.get("version", 1) or 1)
        api_path = spec.get("api_path")
        if spec_version <= 1 or not api_path:
            continue
        updates = {
            "description": spec.get("description", "") or "",
            "params_schema": _json_text(spec.get("params_schema"), "[]"),
            "example_payload": spec.get("example_payload"),
            "example_response": spec.get("example_response"),
            "version": spec_version,
        }
        tpl_action = (
            db.query(DeviceTemplateAction)
            .filter(
                DeviceTemplateAction.template_id == template.id,
                DeviceTemplateAction.api_path == api_path,
            )
            .first()
        )
        if tpl_action is not None and int(tpl_action.version or 1) < spec_version:
            for field, value in updates.items():
                setattr(tpl_action, field, value)
            synced += 1
        device_actions = (
            db.query(DeviceAction)
            .join(Device, DeviceAction.device_id == Device.id)
            .filter(
                Device.auth_type == "sangfor_xdr",
                DeviceAction.api_path == api_path,
            )
            .all()
        )
        for action in device_actions:
            if int(action.version or 1) < spec_version:
                for field, value in updates.items():
                    setattr(action, field, value)
                synced += 1
    return synced


def _complement_sangfor_xdr_actions(db: Session) -> int:
    """为已初始化的深信服 XDR 模板与存量设备补齐内置清单中新增/升级的动作。

    - 按 ``api_path`` 去重补齐新增动作，不覆盖用户对既有动作的修改；
    - 内置动作 definition 升级（version 提高）时，把 description /
      params_schema / example 同步到 version 落后的模板动作与存量设备动作
      （``_sync_sangfor_xdr_action_versions``）；
    - 模板侧：向 code=sangfor_xdr 的模板追加缺失的 DeviceTemplateAction；
    - 设备侧：向 auth_type=sangfor_xdr 的存量设备追加缺失的 DeviceAction，
      保证升级后既有设备即可直接调用新增动作（如资产组查询）。

    Returns:
        本次补齐的动作总数（模板 + 设备）。
    """
    template = (
        db.query(DeviceTemplate)
        .filter(DeviceTemplate.code == SANGFOR_XDR_TEMPLATE_CODE)
        .first()
    )
    if template is None:
        return 0

    added = 0
    existing_paths = {
        row[0]
        for row in db.query(DeviceTemplateAction.api_path).filter(
            DeviceTemplateAction.template_id == template.id
        )
    }
    max_order = (
        db.query(func.max(DeviceTemplateAction.sort_order))
        .filter(DeviceTemplateAction.template_id == template.id)
        .scalar()
        or 0
    )
    for spec in SANGFOR_XDR_ACTIONS:
        if spec.get("api_path") in existing_paths:
            continue
        max_order += 1
        db.add(_build_template_action(template.id, spec, max_order))
        added += 1

    devices = db.query(Device).filter(Device.auth_type == "sangfor_xdr").all()
    for device in devices:
        device_paths = {
            row[0]
            for row in db.query(DeviceAction.api_path).filter(
                DeviceAction.device_id == device.id
            )
        }
        for spec in SANGFOR_XDR_ACTIONS:
            if spec.get("api_path") in device_paths:
                continue
            db.add(
                DeviceAction(
                    device_id=device.id,
                    name=spec.get("name", ""),
                    action_type=spec.get("action_type", "custom"),
                    http_method=spec.get("http_method", "POST"),
                    api_path=spec.get("api_path", ""),
                    params_schema=_json_text(spec.get("params_schema"), "[]"),
                    headers=_json_text(spec.get("headers"), "{}"),
                    body_template=spec.get("body_template", "") or "",
                    auth_type=spec.get("auth_type", "sangfor_xdr"),
                    enabled=bool(spec.get("enabled", True)),
                    description=spec.get("description", "") or "",
                    category=spec.get("category", "other") or "other",
                    risk_level=spec.get("risk_level", "low") or "low",
                    version=spec.get("version", 1) or 1,
                    example_payload=spec.get("example_payload"),
                    example_response=spec.get("example_response"),
                )
            )
            added += 1

    synced = _sync_sangfor_xdr_action_versions(db, template)

    if added:
        logger.info(
            "内置设备库：已为深信服 XDR 模板与存量设备补齐 %s 个新增动作", added
        )
    if synced:
        logger.info(
            "内置设备库：已同步深信服 XDR 升级动作定义 %s 条（version 落后的模板/设备动作）", synced
        )
    return added


def seed_sangfor_xdr_template(db: Session) -> bool:
    """幂等注册深信服 XDR 内置模板（安全告警 / 安全事件 / 资产全部 OpenAPI 动作）。

    - 使用独立的初始化标记，避免与青藤模板的初始化状态互相影响；
    - 已存在同 code 模板时跳过，不覆盖用户对模板/动作的修改；
    - 库中没有深信服 XDR 设备时也按内置动作定义直接创建（接口定义已固化）；
    - 已初始化环境下仍会按 api_path 补齐内置清单中后续新增的动作
      （模板动作 + 存量 sangfor_xdr 设备动作），并把内置定义升级
      （version 提高）的动作口径同步到 version 落后的记录，保证升级即生效。

    Returns:
        是否新建了模板。
    """
    flag = (
        db.query(SystemConfig)
        .filter(SystemConfig.key == _SANGFOR_XDR_SEED_FLAG_KEY)
        .first()
    )
    if flag is not None and (flag.value or "") == "1":
        _complement_sangfor_xdr_actions(db)
        return False

    def _mark_seeded() -> None:
        if flag is None:
            db.add(
                SystemConfig(
                    key=_SANGFOR_XDR_SEED_FLAG_KEY,
                    value="1",
                    description="深信服 XDR 内置模板已完成初始化",
                )
            )
        else:
            flag.value = "1"

    exists = (
        db.query(DeviceTemplate.id)
        .filter(DeviceTemplate.code == SANGFOR_XDR_TEMPLATE_CODE)
        .first()
    )
    if exists:
        _complement_sangfor_xdr_actions(db)
        _mark_seeded()
        return False

    # 若用户已手动创建深信服 XDR 模板，则复用它并补齐固定元数据与全部动作，
    # 避免内置初始化产生重复条目。
    adopt = (
        db.query(DeviceTemplate)
        .filter(
            DeviceTemplate.vendor == SANGFOR_XDR_TEMPLATE_VENDOR,
            DeviceTemplate.name.ilike("%XDR%"),
        )
        .order_by(DeviceTemplate.id.asc())
        .first()
    )
    if adopt is not None:
        adopt.code = SANGFOR_XDR_TEMPLATE_CODE
        adopt.type = SANGFOR_XDR_TEMPLATE_TYPE
        adopt.auth_type = "sangfor_xdr"
        adopt.version = SANGFOR_XDR_TEMPLATE_VERSION
        if not (adopt.description or "").strip():
            adopt.description = SANGFOR_XDR_TEMPLATE_DESCRIPTION
        if not (adopt.tags or "").strip() or adopt.tags == "[]":
            adopt.tags = SANGFOR_XDR_TEMPLATE_TAGS
        db.flush()
        # 按 api_path 去重补齐：被复用模板（含“从设备固化”来源）可能已带
        # 同路径动作，只追加缺失项，避免重复动作被实例化到新设备
        existing_paths = {
            row[0]
            for row in db.query(DeviceTemplateAction.api_path)
            .filter(DeviceTemplateAction.template_id == adopt.id)
            .all()
            if row[0]
        }
        next_order = (
            db.query(func.max(DeviceTemplateAction.sort_order))
            .filter(DeviceTemplateAction.template_id == adopt.id)
            .scalar()
        )
        created = 0
        sort_idx = int(next_order or 0)
        for spec in SANGFOR_XDR_ACTIONS:
            if spec.get("api_path") in existing_paths:
                continue
            sort_idx += 1
            db.add(_build_template_action(adopt.id, spec, sort_idx))
            created += 1
        # 已存在的同路径动作若版本落后，同步内置升级定义
        synced = _sync_sangfor_xdr_action_versions(db, adopt)
        _mark_seeded()
        logger.info(
            "内置设备库：已复用深信服 XDR 模板，补齐 %s 个新增动作、同步 %s 条升级定义",
            created,
            synced,
        )
        return True

    create_template_from_specs(
        db,
        SANGFOR_XDR_ACTIONS,
        name=SANGFOR_XDR_TEMPLATE_NAME,
        type=SANGFOR_XDR_TEMPLATE_TYPE,
        vendor=SANGFOR_XDR_TEMPLATE_VENDOR,
        version=SANGFOR_XDR_TEMPLATE_VERSION,
        description=SANGFOR_XDR_TEMPLATE_DESCRIPTION,
        auth_type="sangfor_xdr",
        tags=SANGFOR_XDR_TEMPLATE_TAGS,
        icon="🛡",
        timeout=30,
        max_retries=2,
        code=SANGFOR_XDR_TEMPLATE_CODE,
        source="builtin",
        created_by="system",
    )
    _mark_seeded()
    logger.info(
        "内置设备库：已创建深信服 XDR 模板（%s 个动作）", len(SANGFOR_XDR_ACTIONS)
    )
    return True
