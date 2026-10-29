"""安全设备与设备动作 CRUD 路由。

提供设备管理（防火墙/WAF/IPS/EDR等）与动作配置的 CRUD 接口，
并支持动作连通性测试：实际调用设备 API 返回结果。

v2 扩展：
- 设备连接状态/健康检查/心跳/标签/认证方式/超时重试/TLS 校验
- 设备模板创建、配置导入导出、动作快速启停
- 动作分类/风险等级/版本管理/调用统计
- DeviceCallLog 调用日志列表、详情、统计
"""
import json
import logging
import time
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.device_templates import get_device_template, get_device_templates
from app.core.security import decrypt_device_secret, encrypt_device_secret, validate_outbound_url
from app.core.timezone import beijing_now, beijing_now_iso
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.devices.action_executor import execute_device_action
from app.models.device import Device, DeviceAction, DeviceCallLog
from app.models.user import User
from app.schemas.common import paginate, to_dict, to_dict_list

logger = logging.getLogger(__name__)

# 读操作：仅需登录；写操作：要求 admin 角色
router = APIRouter(
    prefix="/devices",
    tags=["devices"],
)


# ============ Pydantic 请求体 ============

def _validate_ip_address(v: str) -> str:
    """校验设备 IP 地址：允许空串，或合法的单 IPv4 / IPv6 地址（统一规则）。

    规则见 ``app.core.ip_validation``：拒绝主机名/CIDR/范围/通配/多值文本。
    """
    from app.core.ip_validation import validate_single_ip

    return validate_single_ip(v, "设备 IP 地址", allow_empty=True)


class DeviceBase(BaseModel):
    """设备创建/更新请求体。"""

    name: str = Field(..., description="设备名称")
    type: str = Field("firewall", description="设备类型: firewall/waf/ips/ids/edr/soar/switch/cloud/custom")
    vendor: str = Field("", description="厂商")
    version: str = Field("", description="设备版本（固件/软件版本号）")
    ip_address: str = Field("", description="设备 IP 地址（管理地址，可选）")
    api_url: str = Field("", description="设备 API 基地址")
    api_key: str = Field("", description="API Key 或 Token")
    username: str = Field("", description="用户名（Basic Auth 时用）")
    password: str = Field("", description="密码（Basic Auth 时用，更新时留空表示不修改）")
    enabled: bool = Field(True, description="是否启用")
    description: str = Field("", description="设备描述")
    # v2 新增字段
    auth_type: str = Field("api_key", description="认证方式: none/api_key/basic/bearer/oauth2/mtls/qingteng")
    timeout: int | None = Field(None, description="请求超时(秒)")
    max_retries: int | None = Field(None, description="最大重试次数")
    verify_tls: bool = Field(False, description="是否校验 TLS 证书")
    tags: list[str] = Field(default_factory=list, description="标签列表")
    icon: str = Field("", description="设备图标")
    parser_strategy_id: int | None = Field(None, description="设备级解析策略 ID（parse_strategies.id，NULL=自动路由/渠道指定）")

    @field_validator("ip_address")
    @classmethod
    def _check_ip(cls, v: str) -> str:
        return _validate_ip_address(v)


class DeviceActionBase(BaseModel):
    """设备动作创建/更新请求体。"""

    name: str = Field(..., description="动作名称，如 封禁IP")
    action_type: str = Field("custom", description="动作类型: block_ip/unblock_ip/quarantine_host/isolate_endpoint/add_ioc/delete_ioc/custom")
    http_method: str = Field("POST", description="HTTP 方法: GET/POST/PUT/DELETE/PATCH")
    api_path: str = Field("", description="API 路径（拼在 api_url 后）")
    params_schema: str = Field("[]", description="参数定义 JSON 数组")
    headers: str = Field("{}", description="额外请求头 JSON 对象")
    body_template: str = Field("", description="请求体模板（含 {{param}} 占位符）")
    auth_type: str = Field("api_key", description="认证方式: api_key/basic/bearer/none/qingteng")
    enabled: bool = Field(True, description="是否启用")
    description: str = Field("", description="动作描述")
    # v2 新增字段
    category: str = Field("other", description="动作分类: block/query/dispose/notify/other")
    risk_level: str = Field("readonly", description="风险等级: readonly/high_risk")
    example_payload: str | None = Field(None, description="示例请求体")
    example_response: str | None = Field(None, description="示例响应体")


class ActionTestRequest(BaseModel):
    """动作测试请求体。"""

    params: dict = Field(default_factory=dict, description="测试参数键值对")


class FromTemplateRequest(BaseModel):
    """从模板创建设备请求体。"""

    template_key: str = Field(..., description="模板 key，如 firewall_paloalto")
    name: str = Field(..., description="设备名称")
    ip_address: str = Field("", description="设备 IP 地址（管理地址，可选）")
    api_url: str = Field("", description="设备 API 基地址（留空则使用模板格式）")
    host: str = Field("", description="设备主机地址（用于填充模板中的 {host} 占位符）")
    api_key: str = Field("", description="API Key 或 Token")
    username: str = Field("", description="用户名（Basic Auth 时用）")
    password: str = Field("", description="密码（Basic Auth 时用）")
    enabled: bool = Field(True, description="是否启用")
    description: str = Field("", description="设备描述")
    timeout: int | None = Field(None, description="请求超时(秒)")
    max_retries: int | None = Field(None, description="最大重试次数")
    verify_tls: bool = Field(False, description="是否校验 TLS 证书")
    tags: list[str] = Field(default_factory=list, description="标签列表")

    @field_validator("ip_address")
    @classmethod
    def _check_ip(cls, v: str) -> str:
        return _validate_ip_address(v)


class ImportDevicesRequest(BaseModel):
    """导入设备配置请求体。"""

    devices: list[dict] = Field(default_factory=list, description="设备配置列表，每个设备可含 actions 数组")


# ============ 内部工具函数 ============

def _tags_to_json(tags) -> str:
    """将标签列表序列化为 JSON 字符串（容错）。"""
    if isinstance(tags, str):
        # 已是字符串，校验是否合法 JSON
        try:
            json.loads(tags)
            return tags
        except Exception:  # noqa: BLE001
            return "[]"
    if isinstance(tags, (list, tuple)):
        try:
            return json.dumps(list(tags), ensure_ascii=False)
        except Exception:  # noqa: BLE001
            return "[]"
    return "[]"


def _test_device_connection(device: Device) -> tuple[bool, int | None, int | None, str | None, str]:
    """测试设备连接连通性。

    用 httpx GET 设备 api_url 的健康检查端点（先尝试 ``/health``，失败回退根路径），
    超时与 TLS 校验依据设备配置。

    Returns:
        (success, status_code, latency_ms, error_message, new_status)
        new_status ∈ online/offline/abnormal/unconfigured
    """
    base_url = (device.api_url or "").rstrip("/")
    if not base_url:
        return False, None, None, "设备未配置 api_url", "unconfigured"

    # SSRF 防护：读时兜底校验（防存量数据/导入旁路写入非法 URL）
    try:
        validate_outbound_url(base_url, field="设备 api_url")
    except ValueError as exc:
        return False, None, None, str(exc), "unconfigured"

    timeout = device.timeout or 10
    verify = bool(device.verify_tls)

    headers = {"Content-Type": "application/json"}
    auth_type = device.auth_type or "api_key"
    auth = None
    if auth_type in ("api_key", "bearer") and device.api_key:
        headers["Authorization"] = f"Bearer {decrypt_device_secret(device.api_key)}"
    elif auth_type == "basic":
        auth = (
            decrypt_device_secret(device.username or ""),
            decrypt_device_secret(device.password or ""),
        )

    # 青藤万相：通过登录接口 POST {base}/v1/api/auth 验证账号连通性
    if auth_type == "qingteng":
        try:
            from app.devices.action_executor import _qingteng_login

            start = time.perf_counter()
            _qingteng_login(device, timeout=timeout, verify=verify)
            latency = int((time.perf_counter() - start) * 1000)
            return True, 200, latency, None, "online"
        except Exception as exc:  # noqa: BLE001
            return False, None, None, f"{type(exc).__name__}: {exc}", "abnormal"
    # none/oauth2/mtls: 此处仅做基础连通性探测，不附加复杂认证

    candidates = [f"{base_url}/health", base_url]
    last_error = None
    for idx, url in enumerate(candidates):
        start = time.perf_counter()
        try:
            with httpx.Client(timeout=timeout, verify=verify) as client:
                r = client.get(url, headers=headers, auth=auth)
            latency = int((time.perf_counter() - start) * 1000)
            if r.status_code < 400:
                return True, r.status_code, latency, None, "online"
            # 非健康端点常见的不可用状态码 → 回退到根路径
            if idx == 0 and r.status_code in (400, 401, 403, 404, 405):
                last_error = f"HTTP {r.status_code}"
                continue
            # 可达但非 2xx → 状态异常
            return False, r.status_code, latency, f"HTTP {r.status_code}", "abnormal"
        except Exception as exc:  # noqa: BLE001
            latency = int((time.perf_counter() - start) * 1000)
            last_error = f"{type(exc).__name__}: {exc}"
            if idx == 0:
                continue
            return False, None, latency, last_error, "offline"
    return False, None, None, last_error or "连接失败", "abnormal"


def _apply_device_fields(device: Device, body: DeviceBase, *, is_create: bool) -> None:
    """将请求体字段写入设备对象。"""
    # SSRF 防护：写时校验 api_url（协议白名单 + 云元数据黑名单）
    if body.api_url:
        try:
            validate_outbound_url(body.api_url, field="设备 api_url")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    device.name = body.name
    device.type = body.type
    device.vendor = body.vendor
    device.version = body.version
    device.ip_address = body.ip_address
    device.api_url = body.api_url
    # 更新时凭据留空表示不修改（列表接口不下发凭据，编辑表单默认为空）
    if is_create or body.api_key:
        device.api_key = encrypt_device_secret(body.api_key)
    if is_create or body.username:
        device.username = encrypt_device_secret(body.username)
    if is_create or body.password:
        device.password = encrypt_device_secret(body.password)
    device.enabled = body.enabled
    device.description = body.description
    device.auth_type = body.auth_type
    device.timeout = body.timeout
    device.max_retries = body.max_retries
    device.verify_tls = body.verify_tls
    device.tags = _tags_to_json(body.tags)
    device.icon = body.icon
    device.parser_strategy_id = body.parser_strategy_id
    # 创建时状态默认 unconfigured
    if is_create and not device.status:
        device.status = "unconfigured"


def _apply_action_fields(action: DeviceAction, body: DeviceActionBase) -> None:
    """将请求体字段写入动作对象。"""
    action.name = body.name
    action.action_type = body.action_type
    action.http_method = body.http_method
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


def _recompute_action_stats(db: Session, action: DeviceAction) -> None:
    """根据最近 24 小时调用日志重算动作统计字段。"""
    cutoff = beijing_now() - timedelta(hours=24)
    logs = (
        db.query(DeviceCallLog)
        .filter(
            DeviceCallLog.action_id == action.id,
            DeviceCallLog.created_at >= cutoff,
        )
        .all()
    )
    action.call_count_24h = len(logs)
    action.success_count_24h = sum(1 for lg in logs if lg.status == "success")
    succ_lat = [
        lg.latency_ms
        for lg in logs
        if lg.status == "success" and lg.latency_ms is not None
    ]
    action.avg_latency_ms = int(sum(succ_lat) / len(succ_lat)) if succ_lat else None
    action.last_call_at = beijing_now()


# ============ 设备 CRUD ============

@router.get("", dependencies=[Depends(get_current_user)])
def list_devices(db: Session = Depends(get_db)) -> list[dict]:
    """列出所有安全设备（含动作数量与今日调用次数）。"""
    logger.info("查询设备列表")
    today_start = beijing_now().replace(hour=0, minute=0, second=0, microsecond=0)
    devices = db.query(Device).order_by(Device.created_at.desc()).all()
    result: list[dict] = []
    for d in devices:
        # 凭据字段（api_key/username/password）不随列表下发，编辑时留空表示不修改
        item = to_dict(d, exclude={"api_key", "username", "password"})
        item["action_count"] = (
            db.query(func.count(DeviceAction.id))
            .filter(DeviceAction.device_id == d.id)
            .scalar()
            or 0
        )
        item["today_call_count"] = (
            db.query(func.count(DeviceCallLog.id))
            .filter(
                DeviceCallLog.device_id == d.id,
                DeviceCallLog.created_at >= today_start,
            )
            .scalar()
            or 0
        )
        result.append(item)
    return result


@router.post("", status_code=201)
def create_device(
    body: DeviceBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """创建安全设备。"""
    logger.info("创建设备: name=%s, type=%s", body.name, body.type)
    device = Device()
    _apply_device_fields(device, body, is_create=True)
    db.add(device)
    db.commit()
    db.refresh(device)
    logger.info("设备已创建: id=%s", device.id)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="create",
        resource_type="device",
        resource_id=device.id,
        detail={"name": device.name, "type": device.type, "vendor": device.vendor},
        ip_address=get_client_ip(request),
        result="success",
    )
    return to_dict(device, exclude={"api_key", "password"})


@router.put("/{device_id}")
def update_device(
    device_id: int,
    body: DeviceBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """更新安全设备（字段级变更审计，密码留空不修改）。"""
    logger.info("更新设备: id=%s", device_id)
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    # 记录字段级变更
    changes: dict = {}
    field_map = {
        "name": body.name, "type": body.type, "vendor": body.vendor,
        "version": body.version, "ip_address": body.ip_address,
        "api_url": body.api_url, "api_key": body.api_key, "username": body.username,
        "enabled": body.enabled, "description": body.description,
        "auth_type": body.auth_type, "timeout": body.timeout,
        "max_retries": body.max_retries, "verify_tls": body.verify_tls,
        "icon": body.icon, "parser_strategy_id": body.parser_strategy_id,
    }
    for fname, new_val in field_map.items():
        old_val = getattr(device, fname)
        if old_val != new_val:
            changes[fname] = {"old": old_val, "new": new_val}
    # tags 单独比对（序列化后）
    new_tags_json = _tags_to_json(body.tags)
    if (device.tags or "[]") != new_tags_json:
        changes["tags"] = {"old": device.tags, "new": new_tags_json}
    # password 仅在非空时变更
    if body.password:
        changes["password"] = {"old": "***", "new": "***"}

    _apply_device_fields(device, body, is_create=False)
    db.commit()
    db.refresh(device)
    logger.info("设备已更新: id=%s", device.id)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        resource_type="device",
        resource_id=device.id,
        detail={"name": device.name, "changes": changes},
        ip_address=get_client_ip(request),
        result="success",
    )
    return to_dict(device, exclude={"api_key", "password"})


@router.delete("/{device_id}")
def delete_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """删除安全设备（同时级联清理动作、接收渠道及其关联数据，并停止监听线程）。"""
    logger.info("删除设备: id=%s", device_id)
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    device_name = device.name

    # 级联清理：该设备下的日志接收渠道（含明细/指标），并停止对应监听线程
    try:
        from app.models.log_receiver import LogReceiver, DeviceReceiveLog, DeviceReceiveMetric
        from app.core.log_receiver_manager import stop_receiver_thread

        receiver_ids = [
            r.id for r in db.query(LogReceiver.id).filter(LogReceiver.device_id == device_id).all()
        ]
        for rid in receiver_ids:
            try:
                stop_receiver_thread(rid)
            except Exception:  # noqa: BLE001
                logger.warning("停止接收渠道线程失败（忽略）: receiver=%s", rid)
        if receiver_ids:
            db.query(DeviceReceiveLog).filter(DeviceReceiveLog.device_id == device_id).delete()
            db.query(DeviceReceiveMetric).filter(DeviceReceiveMetric.device_id == device_id).delete()
            db.query(LogReceiver).filter(LogReceiver.device_id == device_id).delete()
    except Exception as exc:  # noqa: BLE001
        logger.warning("清理设备接收渠道失败（忽略）: %s", exc)

    # 清理该设备的调用日志（孤儿数据）
    try:
        db.query(DeviceCallLog).filter(DeviceCallLog.device_id == device_id).delete()
    except Exception as exc:  # noqa: BLE001
        logger.warning("清理设备调用日志失败（忽略）: %s", exc)

    # 级联删除该设备下所有动作
    db.query(DeviceAction).filter(DeviceAction.device_id == device_id).delete()
    db.delete(device)
    db.commit()
    logger.info("设备已删除: id=%s", device_id)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="delete",
        resource_type="device",
        resource_id=device_id,
        detail={"name": device_name},
        ip_address=get_client_ip(request),
        result="success",
    )
    return {"ok": True}


# ============ 设备模板 / 导入导出 / 健康检查 ============
# 注意：静态路径需在 /{device_id} 之前定义，避免被路径参数捕获

@router.get("/templates", dependencies=[Depends(get_current_user)])
def list_device_templates() -> dict:
    """返回所有设备模板列表。"""
    templates = get_device_templates()
    items = [
        {"key": key, **{k: v for k, v in tpl.items() if k != "actions"}}
        for key, tpl in templates.items()
    ]
    return {"total": len(items), "items": items}


@router.post("/from-template", status_code=201)
def create_device_from_template(
    body: FromTemplateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """从模板创建设备（含预置动作）。"""
    template = get_device_template(body.template_key)
    if template is None:
        raise HTTPException(status_code=404, detail=f"模板不存在: {body.template_key}")

    # 计算 api_url：优先使用请求体，其次用 host 填充模板格式，最后用模板格式原值
    api_url = body.api_url
    if not api_url:
        fmt = template.get("api_url_format", "")
        if body.host and "{host}" in fmt:
            api_url = fmt.replace("{host}", body.host)
        else:
            api_url = fmt
    # SSRF 防护：模板创建同样校验 api_url
    if api_url:
        try:
            validate_outbound_url(api_url, field="设备 api_url")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    device = Device(
        name=body.name,
        type=template.get("type", "firewall"),
        vendor=template.get("vendor", ""),
        ip_address=body.ip_address,
        api_url=api_url,
        api_key=encrypt_device_secret(body.api_key),
        username=encrypt_device_secret(body.username),
        password=encrypt_device_secret(body.password),
        enabled=body.enabled,
        description=body.description or template.get("label", ""),
        auth_type=template.get("auth_type", "api_key"),
        timeout=body.timeout,
        max_retries=body.max_retries,
        verify_tls=body.verify_tls,
        tags=_tags_to_json(body.tags),
        icon=template.get("icon", ""),
        status="unconfigured",
    )
    db.add(device)
    db.flush()

    created_actions = 0
    for act in template.get("actions", []):
        action = DeviceAction(
            device_id=device.id,
            name=act.get("name", ""),
            action_type=act.get("action_type", "custom"),
            http_method=act.get("http_method", "POST"),
            api_path=act.get("api_path", ""),
            params_schema=act.get("params_schema", "[]"),
            headers=act.get("headers", "{}"),
            body_template=act.get("body_template", ""),
            auth_type=template.get("auth_type", "api_key"),
            enabled=True,
            description=act.get("description", ""),
            category=act.get("category", "other"),
            risk_level=act.get("risk_level", "readonly"),
            version=1,
        )
        db.add(action)
        created_actions += 1

    db.commit()
    db.refresh(device)
    logger.info(
        "从模板创建设备: id=%s, template=%s, actions=%s",
        device.id, body.template_key, created_actions,
    )
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="create",
        resource_type="device",
        resource_id=device.id,
        detail={
            "name": device.name,
            "template_key": body.template_key,
            "actions_created": created_actions,
        },
        ip_address=get_client_ip(request),
        result="success",
    )
    return {"device": to_dict(device, exclude={"api_key", "username", "password"}), "actions_created": created_actions}


@router.get("/export", dependencies=[Depends(require_role("admin"))])
def export_devices(
    ids: str = Query("", description="逗号分隔的设备 ID，为空则导出全部"),
    db: Session = Depends(get_db),
) -> dict:
    """导出设备配置（含动作）为 JSON。

    支持用 ?ids=1,2,3 指定导出部分设备；不传时导出全部。
    """
    query = db.query(Device)
    if ids.strip():
        id_list = []
        for seg in ids.split(","):
            seg = seg.strip()
            if seg.isdigit():
                id_list.append(int(seg))
        if id_list:
            query = query.filter(Device.id.in_(id_list))
    devices = query.order_by(Device.created_at.desc()).all()
    items: list[dict] = []
    for d in devices:
        item = to_dict(d)
        actions = (
            db.query(DeviceAction)
            .filter(DeviceAction.device_id == d.id)
            .order_by(DeviceAction.id.asc())
            .all()
        )
        item["actions"] = to_dict_list(actions)
        items.append(item)
    return {"devices": items, "exported_at": beijing_now_iso(), "total": len(items)}


@router.post("/import")
def import_devices(
    body: ImportDevicesRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """导入设备配置（JSON，含动作）。"""
    created_devices = 0
    created_actions = 0
    skipped = 0

    for dev_data in body.devices:
        if not isinstance(dev_data, dict):
            skipped += 1
            continue
        try:
            # SSRF 防护：导入数据同样校验 api_url（ValueError 被下方 except 捕获，跳过该设备）
            if dev_data.get("api_url"):
                validate_outbound_url(dev_data["api_url"], field="设备 api_url")
            actions_data = dev_data.get("actions", []) or []
            # 导入数据同样硬拦截设备 IP（与表单创建同一套规则）
            ip_address = _validate_ip_address(dev_data.get("ip_address", "") or "")
            device = Device(
                name=dev_data.get("name", "") or "未命名设备",
                type=dev_data.get("type", "firewall"),
                vendor=dev_data.get("vendor", ""),
                ip_address=ip_address,
                api_url=dev_data.get("api_url", ""),
                api_key=encrypt_device_secret(dev_data.get("api_key", "")),
                username=encrypt_device_secret(dev_data.get("username", "")),
                password=encrypt_device_secret(dev_data.get("password", "")),
                enabled=bool(dev_data.get("enabled", True)),
                description=dev_data.get("description", ""),
                auth_type=dev_data.get("auth_type", "api_key"),
                timeout=dev_data.get("timeout"),
                max_retries=dev_data.get("max_retries"),
                verify_tls=bool(dev_data.get("verify_tls", False)),
                tags=_tags_to_json(dev_data.get("tags", "[]")),
                icon=dev_data.get("icon", ""),
                status=dev_data.get("status", "unconfigured"),
            )
            db.add(device)
            db.flush()
        except Exception as exc:  # noqa: BLE001
            logger.warning("导入设备失败，跳过设备 %s: %s", dev_data.get("name"), exc)
            skipped += 1
            continue
        created_devices += 1

        # 逐个创建动作；单个动作失败只跳过该动作，不影响设备与其它动作
        for act_data in actions_data:
            if not isinstance(act_data, dict):
                continue
            try:
                action = DeviceAction(
                    device_id=device.id,
                    name=act_data.get("name", "") or "未命名动作",
                    action_type=act_data.get("action_type", "custom"),
                    http_method=act_data.get("http_method", "POST"),
                    api_path=act_data.get("api_path", ""),
                    params_schema=act_data.get("params_schema", "[]"),
                    headers=act_data.get("headers", "{}"),
                    body_template=act_data.get("body_template", ""),
                    auth_type=act_data.get("auth_type", "api_key"),
                    enabled=bool(act_data.get("enabled", True)),
                    description=act_data.get("description", ""),
                    category=act_data.get("category", "other"),
                    risk_level=act_data.get("risk_level", "readonly"),
                    version=act_data.get("version", 1),
                    example_payload=act_data.get("example_payload"),
                    example_response=act_data.get("example_response"),
                )
                db.add(action)
                created_actions += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "导入设备 %s 的动作「%s」失败，已跳过该动作: %s",
                    device.name, act_data.get("name"), exc,
                )

    db.commit()
    logger.info(
        "导入设备完成: devices=%s, actions=%s, skipped=%s",
        created_devices, created_actions, skipped,
    )
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="import",
        resource_type="device",
        detail={"devices": created_devices, "actions": created_actions, "skipped": skipped},
        ip_address=get_client_ip(request),
        result="success",
    )
    return {
        "imported_devices": created_devices,
        "imported_actions": created_actions,
        "skipped": skipped,
    }


@router.post("/health-check")
def health_check_all(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """手动触发所有启用设备的健康检查。"""
    devices = db.query(Device).filter(Device.enabled.is_(True)).all()
    now = beijing_now()
    results: list[dict] = []
    for device in devices:
        success, status_code, latency, error, new_status = _test_device_connection(device)
        device.status = new_status
        device.last_heartbeat = now
        device.last_test_error = None if success else error
        device.last_test_latency_ms = latency
        results.append({
            "id": device.id,
            "name": device.name,
            "status": new_status,
            "latency_ms": latency,
            "status_code": status_code,
            "error": error,
        })
    db.commit()
    online = sum(1 for r in results if r["status"] == "online")
    logger.info("健康检查完成: total=%s, online=%s", len(results), online)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="execute",
        resource_type="device",
        detail={"total": len(results), "online": online},
        ip_address=get_client_ip(request),
        result="success",
    )
    return {
        "total": len(results),
        "online": online,
        "offline": sum(1 for r in results if r["status"] == "offline"),
        "abnormal": sum(1 for r in results if r["status"] == "abnormal"),
        "results": results,
    }


# ============ 设备连接测试 ============

@router.post(
    "/{device_id}/test",
    summary="测试设备连接连通性",
)
def test_device_connection(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """测试设备连接：GET 设备 api_url 健康检查端点，更新连接状态。"""
    logger.info("测试设备连接: id=%s", device_id)
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    success, status_code, latency, error, new_status = _test_device_connection(device)
    now = beijing_now()
    device.status = new_status
    device.last_heartbeat = now
    device.last_test_error = None if success else error
    device.last_test_latency_ms = latency
    db.commit()
    db.refresh(device)

    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="execute",
        resource_type="device",
        resource_id=device.id,
        detail={"name": device.name, "status": new_status, "latency_ms": latency},
        ip_address=get_client_ip(request),
        result="success" if success else "failed",
    )
    return {
        "success": success,
        "status": new_status,
        "status_code": status_code,
        "latency_ms": latency,
        "error": error,
        "device": to_dict(device, exclude={"api_key", "password"}),
    }


# ============ 设备信息及动作查询 ============

def _params_to_json_schema(params_schema: str) -> dict:
    """把动作的 params_schema（JSON 数组: name/type/required/description）
    转换为标准 JSON Schema（type=object + properties + required）。

    解析失败时返回空对象结构，保证接口不因脏数据报错。
    """
    try:
        items = json.loads(params_schema or "[]")
    except Exception:  # noqa: BLE001
        items = []
    if not isinstance(items, list):
        items = []
    properties: dict = {}
    required: list[str] = []
    for it in items:
        if not isinstance(it, dict) or not it.get("name"):
            continue
        properties[it["name"]] = {
            "type": it.get("type", "string"),
            "description": it.get("description", ""),
        }
        if it.get("required"):
            required.append(it["name"])
    return {"type": "object", "properties": properties, "required": required}


def _parse_response_fields(action: DeviceAction) -> list[str]:
    """解析动作 example_response 中存放的返回结果字段说明列表（容错）。"""
    try:
        data = json.loads(action.example_response or "{}")
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, dict) and isinstance(data.get("fields"), list):
        return data["fields"]
    if isinstance(data, list):
        return data
    return []


@router.get("/{device_id}/detail", dependencies=[Depends(get_current_user)])
def get_device_detail(
    device_id: int,
    enabled_only: bool = Query(False, description="true 时仅返回启用（可用）的动作"),
    db: Session = Depends(get_db),
) -> dict:
    """设备信息及其动作查询：返回设备基础信息 + 该设备当前可用动作的清单。

    出参结构：
    - device: 设备基础信息（不含 api_key/username/password 凭据字段）
    - actions: 动作清单，每个动作含 action_type/name/description/
      http_method/api_path/params_schema（参数定义数组）/
      parameters_json_schema（标准 JSON Schema）/response_fields（返回字段说明）
    - total: 动作总数

    智能体工具（query_device_actions）复用本逻辑，用于在执行动作前
    感知设备支持哪些动作及其参数定义。
    """
    logger.info("查询设备详情及动作清单: device_id=%s, enabled_only=%s", device_id, enabled_only)
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    query = db.query(DeviceAction).filter(DeviceAction.device_id == device_id)
    if enabled_only:
        query = query.filter(DeviceAction.enabled.is_(True))
    actions = query.order_by(DeviceAction.id.asc()).all()
    action_list = []
    for a in actions:
        action_list.append({
            "id": a.id,
            "action_type": a.action_type,
            "name": a.name,
            "description": a.description,
            "http_method": a.http_method,
            "api_path": a.api_path,
            "category": a.category,
            "risk_level": a.risk_level,
            "enabled": bool(a.enabled),
            "auth_type": a.auth_type,
            "params_schema": json.loads(a.params_schema or "[]"),
            "parameters_json_schema": _params_to_json_schema(a.params_schema),
            "response_fields": _parse_response_fields(a),
        })
    return {
        "device": to_dict(device, exclude={"api_key", "username", "password"}),
        "actions": action_list,
        "total": len(action_list),
    }


# ============ 设备动作 CRUD ============

@router.get("/{device_id}/actions", dependencies=[Depends(get_current_user)])
def list_device_actions(device_id: int, db: Session = Depends(get_db)) -> list[dict]:
    """列出指定设备的所有动作（含新字段）。"""
    logger.info("查询设备动作列表: device_id=%s", device_id)
    if db.query(Device).filter(Device.id == device_id).first() is None:
        raise HTTPException(status_code=404, detail="Device not found")
    actions = (
        db.query(DeviceAction)
        .filter(DeviceAction.device_id == device_id)
        .order_by(DeviceAction.created_at.desc())
        .all()
    )
    return to_dict_list(actions)


@router.post("/{device_id}/actions", status_code=201)
def create_device_action(
    device_id: int,
    body: DeviceActionBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """为指定设备创建动作。"""
    logger.info("创建设备动作: device_id=%s, name=%s", device_id, body.name)
    if db.query(Device).filter(Device.id == device_id).first() is None:
        raise HTTPException(status_code=404, detail="Device not found")
    action = DeviceAction(device_id=device_id, version=1)
    _apply_action_fields(action, body)
    db.add(action)
    db.commit()
    db.refresh(action)
    logger.info("设备动作已创建: id=%s", action.id)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="create",
        resource_type="device_action",
        resource_id=action.id,
        detail={"device_id": device_id, "name": action.name, "category": action.category},
        ip_address=get_client_ip(request),
        result="success",
    )
    return to_dict(action)


@router.put(
    "/{device_id}/actions/{action_id}",
)
def update_device_action(
    device_id: int,
    action_id: int,
    body: DeviceActionBase,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """更新设备动作（version+1 版本管理）。"""
    logger.info("更新设备动作: device_id=%s, action_id=%s", device_id, action_id)
    action = (
        db.query(DeviceAction)
        .filter(DeviceAction.id == action_id, DeviceAction.device_id == device_id)
        .first()
    )
    if action is None:
        raise HTTPException(status_code=404, detail="DeviceAction not found")

    # 记录变更
    changes: dict = {}
    field_map = {
        "name": body.name, "action_type": body.action_type,
        "http_method": body.http_method, "api_path": body.api_path,
        "params_schema": body.params_schema, "headers": body.headers,
        "body_template": body.body_template, "auth_type": body.auth_type,
        "enabled": body.enabled, "description": body.description,
        "category": body.category, "risk_level": body.risk_level,
        "example_payload": body.example_payload,
        "example_response": body.example_response,
    }
    for fname, new_val in field_map.items():
        old_val = getattr(action, fname)
        if old_val != new_val:
            changes[fname] = {"old": old_val, "new": new_val}

    _apply_action_fields(action, body)
    action.version = (action.version or 1) + 1
    db.commit()
    db.refresh(action)
    logger.info("设备动作已更新: id=%s, version=%s", action.id, action.version)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        resource_type="device_action",
        resource_id=action.id,
        detail={"device_id": device_id, "name": action.name, "version": action.version, "changes": changes},
        ip_address=get_client_ip(request),
        result="success",
    )
    return to_dict(action)


@router.delete(
    "/{device_id}/actions/{action_id}",
)
def delete_device_action(
    device_id: int,
    action_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """删除设备动作。"""
    logger.info("删除设备动作: device_id=%s, action_id=%s", device_id, action_id)
    action = (
        db.query(DeviceAction)
        .filter(DeviceAction.id == action_id, DeviceAction.device_id == device_id)
        .first()
    )
    if action is None:
        raise HTTPException(status_code=404, detail="DeviceAction not found")
    action_name = action.name
    db.delete(action)
    db.commit()
    logger.info("设备动作已删除: id=%s", action_id)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="delete",
        resource_type="device_action",
        resource_id=action_id,
        detail={"device_id": device_id, "name": action_name},
        ip_address=get_client_ip(request),
        result="success",
    )
    return {"ok": True}


@router.patch(
    "/{device_id}/actions/{action_id}/toggle",
)
def toggle_device_action(
    device_id: int,
    action_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """快速切换动作启用状态。"""
    action = (
        db.query(DeviceAction)
        .filter(DeviceAction.id == action_id, DeviceAction.device_id == device_id)
        .first()
    )
    if action is None:
        raise HTTPException(status_code=404, detail="DeviceAction not found")
    action.enabled = not action.enabled
    db.commit()
    db.refresh(action)
    logger.info("切换动作启用状态: id=%s, enabled=%s", action_id, action.enabled)
    log_audit(
        db,
        user_id=user.id,
        username=user.username,
        action="update",
        resource_type="device_action",
        resource_id=action.id,
        detail={"device_id": device_id, "name": action.name, "enabled": action.enabled},
        ip_address=get_client_ip(request),
        result="success",
    )
    return to_dict(action)


# ============ 动作测试与历史 ============

@router.post(
    "/{device_id}/actions/{action_id}/test",
    summary="测试设备动作连通性",
)
def test_device_action(
    device_id: int,
    action_id: int,
    body: ActionTestRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
) -> dict:
    """实际调用设备 API 测试动作是否可用。

    根据 device.api_url + action.api_path 拼接完整 URL，
    按 action.auth_type 选择认证方式，按 body_template 或 params 构造请求体，
    用 httpx 发起实际 HTTP 请求并返回结果。

    同时：
    - 记录一条 DeviceCallLog（source=manual_test）
    - 更新动作的 last_call_at / call_count_24h / success_count_24h / avg_latency_ms
    """
    logger.info("测试设备动作: device_id=%s, action_id=%s", device_id, action_id)
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    action = (
        db.query(DeviceAction)
        .filter(DeviceAction.id == action_id, DeviceAction.device_id == device_id)
        .first()
    )
    if action is None:
        raise HTTPException(status_code=404, detail="DeviceAction not found")

    params = body.params or {}

    # 统一执行引擎（复用 devices/action_executor：超时/TLS/重试 + 写 DeviceCallLog）
    result = execute_device_action(
        device,
        action,
        params,
        db=db,
        source="manual_test",
        user_id=user.id if user else None,
        source_ip=get_client_ip(request) if request else None,
    )

    latency_ms = result.get("latency_ms")
    success = result.get("success", False)

    # 更新动作统计（24h 调用/成功率/平均耗时），基于已写入的调用日志
    _recompute_action_stats(db, action)
    db.commit()

    logger.info("设备动作测试完成: status=%s, success=%s, latency=%sms",
                result.get("status_code"), success, latency_ms)
    return {
        "success": success,
        "status_code": result.get("status_code"),
        "response_body": result.get("response_body"),
        "error": result.get("error"),
        "latency_ms": latency_ms,
    }


@router.get(
    "/{device_id}/actions/{action_id}/history",
    dependencies=[Depends(get_current_user)],
)
def list_action_history(
    device_id: int,
    action_id: int,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """动作执行历史（从 DeviceCallLog 查询，分页）。"""
    q = (
        db.query(DeviceCallLog)
        .filter(
            DeviceCallLog.device_id == device_id,
            DeviceCallLog.action_id == action_id,
        )
        .order_by(DeviceCallLog.created_at.desc())
    )
    return paginate(q, page=page, size=size)


# ============ 调用日志 ============

@router.get("/call-logs/stats", dependencies=[Depends(get_current_user)])
def get_call_log_stats(db: Session = Depends(get_db)) -> dict:
    """调用日志统计：总调用/成功率/平均耗时/失败 Top3/来源分布/趋势。"""
    total = db.query(func.count(DeviceCallLog.id)).scalar() or 0
    success_count = (
        db.query(func.count(DeviceCallLog.id))
        .filter(DeviceCallLog.status == "success")
        .scalar()
        or 0
    )
    failed_count = (
        db.query(func.count(DeviceCallLog.id))
        .filter(DeviceCallLog.status == "failed")
        .scalar()
        or 0
    )
    avg_latency = (
        db.query(func.avg(DeviceCallLog.latency_ms))
        .filter(DeviceCallLog.latency_ms.isnot(None))
        .scalar()
    )
    avg_latency_ms = int(avg_latency) if avg_latency is not None else 0
    success_rate = round(success_count / total * 100, 2) if total > 0 else 0.0

    # 失败 Top3 错误
    top_err_rows = (
        db.query(
            DeviceCallLog.error_message,
            func.count(DeviceCallLog.id).label("cnt"),
        )
        .filter(
            DeviceCallLog.status == "failed",
            DeviceCallLog.error_message.isnot(None),
            DeviceCallLog.error_message != "",
        )
        .group_by(DeviceCallLog.error_message)
        .order_by(func.count(DeviceCallLog.id).desc())
        .limit(3)
        .all()
    )
    top_errors = [{"error": err or "", "count": cnt} for err, cnt in top_err_rows]

    # 来源分布
    src_rows = (
        db.query(
            DeviceCallLog.source,
            func.count(DeviceCallLog.id).label("cnt"),
        )
        .group_by(DeviceCallLog.source)
        .all()
    )
    source_distribution = {src or "unknown": cnt for src, cnt in src_rows}

    # 最近 7 天趋势
    cutoff = beijing_now() - timedelta(days=7)
    trend_logs = (
        db.query(DeviceCallLog.created_at, DeviceCallLog.status)
        .filter(DeviceCallLog.created_at >= cutoff)
        .all()
    )
    trend_map: dict[str, dict] = {}
    for created_at, st in trend_logs:
        if created_at is None:
            continue
        day_key = created_at.strftime("%Y-%m-%d")
        bucket = trend_map.setdefault(day_key, {"calls": 0, "success": 0})
        bucket["calls"] += 1
        if st == "success":
            bucket["success"] += 1
    daily_trend = [
        {"date": day, "calls": data["calls"], "success": data["success"]}
        for day, data in sorted(trend_map.items())
    ]

    return {
        "total_calls": total,
        "success_count": success_count,
        "failed_count": failed_count,
        "success_rate": success_rate,
        "avg_latency_ms": avg_latency_ms,
        "top_errors": top_errors,
        "source_distribution": source_distribution,
        "daily_trend": daily_trend,
    }


@router.get("/call-logs/{log_id}", dependencies=[Depends(get_current_user)])
def get_call_log_detail(log_id: int, db: Session = Depends(get_db)) -> dict:
    """调用日志详情。"""
    log = db.query(DeviceCallLog).filter(DeviceCallLog.id == log_id).first()
    if log is None:
        raise HTTPException(status_code=404, detail="Call log not found")
    return to_dict(log)


@router.get("/call-logs", dependencies=[Depends(get_current_user)])
def list_call_logs(
    device_id: int | None = Query(None, description="按设备 ID 筛选"),
    action_id: int | None = Query(None, description="按动作 ID 筛选"),
    source: str = Query("", description="按来源筛选: manual_test/workflow/agent/api"),
    status: str = Query("", description="按状态筛选: success/failed"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    """调用日志列表（支持筛选+分页）。"""
    q = db.query(DeviceCallLog)
    if device_id is not None:
        q = q.filter(DeviceCallLog.device_id == device_id)
    if action_id is not None:
        q = q.filter(DeviceCallLog.action_id == action_id)
    if source:
        q = q.filter(DeviceCallLog.source == source)
    if status:
        q = q.filter(DeviceCallLog.status == status)
    q = q.order_by(DeviceCallLog.created_at.desc())
    return paginate(q, page=page, size=size)
