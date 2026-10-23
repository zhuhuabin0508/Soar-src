"""设备动作执行器（可复用工具函数）。

从 devices.test_device_action 与 node_executors.execute_device_action 提取，
供 banned_ips API、设备测试、工作流 device_action 节点统一调用。

核心函数：
- ``execute_device_action``: 实际调用设备 API 执行指定动作，返回结构化结果。
- ``record_device_call``: 把一次动作调用写入 DeviceCallLog（供各链路统一记日志）。
- ``find_device_action_by_type``: 查找指定设备的指定类型动作（启用状态优先）。
"""
import hashlib
import json
import logging
import re
import time as _time
from typing import Any, Optional
from urllib.parse import quote as _quote
from urllib.parse import urlencode as _urlencode

import httpx

from app.core.security import decrypt_device_secret, validate_outbound_url
from app.models.device import Device, DeviceAction, DeviceCallLog

logger = logging.getLogger(__name__)


def record_device_call(
    db,
    *,
    device: Device,
    action: DeviceAction,
    source: str = "manual_test",
    workflow_id: Optional[int] = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
    request_summary: Optional[str] = None,
    response_summary: Optional[str] = None,
    status: str = "success",
    status_code: Optional[int] = None,
    latency_ms: Optional[int] = None,
    error_message: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> None:
    """把一次设备动作调用写入 DeviceCallLog（各调用链路统一入口）。"""
    try:
        log = DeviceCallLog(
            device_id=device.id,
            device_name=device.name,
            action_id=getattr(action, "id", None),
            action_name=getattr(action, "name", None) or "",
            source=source,
            workflow_id=workflow_id,
            agent_id=agent_id,
            request_summary=request_summary,
            response_summary=response_summary,
            status=status,
            status_code=status_code,
            latency_ms=latency_ms,
            error_message=error_message,
            user_id=user_id,
            source_ip=source_ip,
            idempotency_key=idempotency_key,
            correlation_id=correlation_id,
        )
        db.add(log)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入设备调用日志失败: %s", exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def _build_request(device: Device, action: DeviceAction, params: dict[str, Any]):
    """统一构造设备调用的 (method, url, headers, auth, body)，供各链路复用。"""
    # 1) 拼接 URL
    base_url = (device.api_url or "").rstrip("/")
    api_path = (action.api_path or "").lstrip("/")
    if "{" in api_path:
        for key in re.findall(r"\{(\w+)\}", api_path):
            value = params.pop(key, None)
            if value is not None and str(value) != "":
                api_path = api_path.replace("{" + key + "}", _quote(str(value), safe=""))
    url = f"{base_url}/{api_path}" if api_path else base_url
    if url:
        validate_outbound_url(url, field="设备 api_url")

    # 2) 请求头
    headers = {"Content-Type": "application/json"}
    try:
        extra = json.loads(action.headers or "{}")
        if isinstance(extra, dict):
            headers.update(extra)
    except Exception:  # noqa: BLE001
        logger.warning("解析动作 headers 失败，忽略: action_id=%s", action.id)

    # 3) 认证
    auth_type = action.auth_type or "api_key"
    auth = None
    if auth_type in ("api_key", "bearer"):
        key = decrypt_device_secret(device.api_key)
        if key:
            headers["Authorization"] = f"Bearer {key}"
    elif auth_type == "basic":
        auth = (
            decrypt_device_secret(device.username or ""),
            decrypt_device_secret(device.password or ""),
        )
    # none: 不添加认证

    # 4) 请求体
    if action.body_template:
        body_str = action.body_template
        for k, v in params.items():
            body_str = body_str.replace(f"{{{{{k}}}}}", str(v))
        try:
            req_body = json.loads(body_str)
        except Exception:  # noqa: BLE001
            req_body = body_str  # 保持字符串
    else:
        req_body = params

    method = (action.http_method or "POST").upper()
    return method, url, headers, auth, req_body


def _qingteng_login(device: Device, timeout: float, verify: bool):
    """青藤外部 API 登录：POST {base}/v1/api/auth，换取 comId/jwt/signKey。

    Returns:
        (comId, jwt, signKey) 三元组。
    """
    base_url = (device.api_url or "").rstrip("/")
    if not base_url:
        raise ValueError("设备未配置 api_url")
    validate_outbound_url(f"{base_url}/v1/api/auth", field="设备 api_url")
    username = decrypt_device_secret(device.username or "")
    password = decrypt_device_secret(device.password or "")
    with httpx.Client(timeout=timeout, verify=verify) as client:
        resp = client.post(
            f"{base_url}/v1/api/auth",
            json={"username": username, "password": password},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"青藤登录失败 HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"青藤登录返回非 JSON: {resp.text[:200]}") from None
    payload = (data or {}).get("data") or {}
    if not data.get("success") or not payload:
        raise RuntimeError(
            f"青藤登录失败: {data.get('errorDesc') or data.get('errorMessage') or data}"
        )
    comid = payload.get("comId")
    jwt = payload.get("jwt")
    signkey = payload.get("signKey")
    if not (comid and jwt and signkey):
        raise RuntimeError("青藤登录响应缺少 comId/jwt/signKey")
    return comid, jwt, signkey


def _qingteng_signheaders(
    comid: str,
    jwt: str,
    signkey: str,
    method: str,
    params: dict[str, Any],
    req_body: Any,
    url: str,
):
    """按青藤签名规范生成请求头并返回 (headers, sign_body, final_url)。

    - GET: 参数按参数名自然升序拼接为 {key1}{value1}{key2}{value2}，并附到 URL；
    - POST/PUT/DELETE: body 的 JSON 字符串直接参与签名；
    - 待签名字符串 {comId}{info}{timestamp}{signKey}，SHA1 后置于 sign 头。
    """
    ts = int(_time.time())
    if method == "GET":
        # 剔除空值参数：避免把 ip=、hostname=、groups= 之类空条件拼进 URL 与签名，
        # 否则青藤服务端可能因空参数过滤掉全部主机而返回 total=0。
        clean = {}
        for k, v in params.items():
            if v is None:
                continue
            s = v if isinstance(v, str) else str(v)
            if s == "":
                continue
            clean[k] = s
        keys = sorted(clean.keys())
        info = "".join(f"{k}{clean[k]}" for k in keys)
        if clean:
            qs = _urlencode(clean)
            url = f"{url}?{qs}" if "?" not in url else f"{url}&{qs}"
        req_body = None  # GET 参数走 URL，不再发 body
    elif req_body is not None:
        info = json.dumps(req_body)
    else:
        info = ""
    to_sign = f"{comid}{info}{ts}{signkey}"
    sign = hashlib.sha1(to_sign.encode("utf-8")).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "comId": comid,
        "timestamp": str(ts),
        "sign": sign,
        "Authorization": f"Bearer {jwt}",
    }
    return headers, req_body, url


def execute_device_action(
    device: Device,
    action: DeviceAction,
    params: dict[str, Any] | None = None,
    timeout: float | None = None,
    *,
    db=None,
    source: str = "manual_test",
    workflow_id: Optional[int] = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
    skip_log: bool = False,
    idempotency_key: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> dict[str, Any]:
    """实际调用设备 API 执行指定动作（统一执行引擎）。

    根据 device.api_url + action.api_path 拼接完整 URL，
    按 action.auth_type 选择认证方式，按 body_template 或 params 构造请求体，
    用 httpx 发起实际 HTTP 请求并返回结果。

    连接参数取自设备配置：超时 = device.timeout、TLS 校验 = device.verify_tls、
    失败自动重试 = device.max_retries。若传入 db 则自动写入 DeviceCallLog。

    Args:
        device: Device ORM 实例（含 api_url/api_key/username/password）。
        action: DeviceAction ORM 实例。
        params: 调用参数键值对，用于替换 body_template 中的 {{param}} 占位符；
            若 action 无 body_template，则 params 整体作为 JSON 请求体。
        timeout: HTTP 超时秒数（默认取 device.timeout 或 30）。
        db: 可选数据库会话；传入则记录 DeviceCallLog。
        source/source_ip/...: 调用链路上报信息（写日志用）。

    Returns:
        dict: {
            "success": bool,           # HTTP 状态码 < 400
            "status_code": int | None, # HTTP 状态码（请求异常时为 None）
            "response_body": Any,      # 解析后的 JSON 或原始文本
            "error": str | None,       # 失败原因（成功时为 None）
        }
    """
    params = params or {}
    start = _time.perf_counter()
    # 若调用方未显式传超时，则用设备配置，缺省 30
    timeout = timeout if timeout is not None else (device.timeout or 30)
    verify = bool(device.verify_tls)
    max_retries = device.max_retries if device.max_retries is not None else 0

    try:
        method, url, headers, auth, req_body = _build_request(device, action, params)
    except ValueError as exc:
        return {"success": False, "status_code": None, "response_body": None,
                "error": str(exc), "latency_ms": 0}
    if not url:
        return {"success": False, "status_code": None, "response_body": None,
                "error": "设备未配置 api_url 且动作未配置 api_path", "latency_ms": 0}

    request_summary = json.dumps({"url": url, "method": method}, ensure_ascii=False)

    # 青藤签名协议：登录换取 comId/jwt/signKey 并对本业务请求做 SHA1 签名。
    # 若动作指向登录接口本身，则直接携带账号密码发送，不再走签名流程。
    auth_type = action.auth_type or "api_key"
    if auth_type == "inherit":  # 动作继承设备的认证方式
        auth_type = device.auth_type or "api_key"
    if auth_type == "qingteng":
        if "/v1/api/auth" in url:
            req_body = {
                "username": decrypt_device_secret(device.username or ""),
                "password": decrypt_device_secret(device.password or ""),
            }
            headers["Content-Type"] = "application/json"
        else:
            try:
                comid, jwt, signkey = _qingteng_login(device, timeout, verify)
            except Exception as exc:  # noqa: BLE001
                msg = f"{type(exc).__name__}: {exc}"
                logger.warning("青藤登录失败: %s", msg)
                if db and not skip_log:
                    record_device_call(db, device=device, action=action, source=source,
                                       workflow_id=workflow_id, agent_id=agent_id,
                                       user_id=user_id, source_ip=source_ip,
                                       request_summary=request_summary, status="failed",
                                       latency_ms=0, error_message=msg,
                                       idempotency_key=idempotency_key,
                                       correlation_id=correlation_id)
                return {"success": False, "status_code": None, "response_body": None,
                        "error": msg, "latency_ms": 0}
            headers, req_body, url = _qingteng_signheaders(
                comid, jwt, signkey, method, params, req_body, url
            )
            request_summary = json.dumps({"url": url, "method": method}, ensure_ascii=False)

    def _do_request() -> httpx.Response:
        with httpx.Client(timeout=timeout, verify=verify) as client:
            return client.request(
                method=method,
                url=url,
                headers=headers,
                json=req_body if isinstance(req_body, (dict, list)) else None,
                data=req_body if isinstance(req_body, str) else None,
                auth=auth,
            )

    logger.info("调用设备 API: %s %s, auth=%s, device=%s, action=%s",
                method, url, action.auth_type or "api_key", device.id, action.id)

    # 失败自动重试（带简单退避）
    last_exc = None
    r = None
    for attempt in range(max_retries + 1):
        try:
            r = _do_request()
            # 仅对连接异常/5xx 重试；成功或 4xx 业务失败不重试
            if r.status_code < 500:
                break
            last_exc = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        if attempt < max_retries:
            _time.sleep(0.3 * (attempt + 1))
            logger.info("设备 API 请求失败，第 %s/%s 次重试: %s",
                        attempt + 1, max_retries, last_exc)

    latency_ms = int((_time.perf_counter() - start) * 1000)

    if r is None:
        msg = f"{type(last_exc).__name__}: {last_exc}"
        logger.warning("设备 API 请求异常: %s", msg)
        if db and not skip_log:
            record_device_call(db, device=device, action=action, source=source,
                               workflow_id=workflow_id, agent_id=agent_id,
                               user_id=user_id, source_ip=source_ip,
                               request_summary=request_summary, status="failed",
                               latency_ms=latency_ms, error_message=msg,
                               idempotency_key=idempotency_key,
                               correlation_id=correlation_id)
        return {"success": False, "status_code": None, "response_body": None,
                "error": msg, "latency_ms": latency_ms}

    try:
        resp_body = r.json()
    except Exception:  # noqa: BLE001
        resp_body = r.text

    success = r.status_code < 400
    error = None if success else f"HTTP {r.status_code}"
    logger.info("设备动作执行完成: status=%s, success=%s, device=%s, action=%s",
                r.status_code, success, device.id, action.id)

    if db and not skip_log:
        record_device_call(
            db, device=device, action=action, source=source,
            workflow_id=workflow_id, agent_id=agent_id, user_id=user_id,
            source_ip=source_ip, request_summary=request_summary,
            response_summary=json.dumps(resp_body, ensure_ascii=False)[:2000],
            status="success" if success else "failed",
            status_code=r.status_code, latency_ms=latency_ms,
            error_message=error,
            idempotency_key=idempotency_key,
            correlation_id=correlation_id,
        )

    return {
        "success": success,
        "status_code": r.status_code,
        "response_body": resp_body,
        "error": error,
        "latency_ms": latency_ms,
    }


def find_device_action_by_type(
    db, device_id: int, action_type: str
) -> tuple[Device | None, DeviceAction | None, str | None]:
    """查找指定设备的指定类型动作（启用状态优先）。

    Args:
        db: 数据库会话。
        device_id: 设备 ID。
        action_type: 动作类型（如 "block_ip" / "unblock_ip"）。

    Returns:
        (device, action, error) 三元组：
        - device 为 None: 设备不存在。
        - action 为 None: 设备无此类型的启用动作。
        - error 非 None: 描述失败原因（可用于 HTTP 错误信息）。
    """
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        return None, None, f"设备不存在: id={device_id}"
    if not device.enabled:
        return device, None, f"设备已禁用: {device.name}"

    action = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.device_id == device_id,
            DeviceAction.action_type == action_type,
            DeviceAction.enabled.is_(True),
        )
        .order_by(DeviceAction.id.asc())
        .first()
    )
    if action is None:
        return device, None, f"设备「{device.name}」未配置启用的 {action_type} 动作"

    return device, action, None


_TOOL_RESPONSE_MAX_CHARS = 30000


async def execute_device_action_by_id(
    action_id: int,
    params: dict[str, Any] | None = None,
    device_id: int | None = None,
    timeout: float | None = None,
    *,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """按动作 ID 执行。写动作经 DeviceGateway，并按动作风险核对设备权限。"""
    try:
        action_id = int(action_id)
    except (TypeError, ValueError):
        return {"error": "action_id 必须是数字（动作 ID）"}
    if device_id is not None:
        try:
            device_id = int(device_id)
        except (TypeError, ValueError):
            return {"error": "device_id 必须是数字（设备 ID）"}
    if params is not None and not isinstance(params, dict):
        return {"error": "params 必须是对象（动作参数 key-value）"}

    from app.core.tools.authz import user_may_call
    from app.database import SessionLocal
    from app.devices.as_tool import is_write_action
    from app.devices.gateway import DeviceGateway, build_idempotency_key
    from app.models.device import Device, DeviceAction
    from app.models.user import User

    db = SessionLocal()
    try:
        action = db.query(DeviceAction).filter(DeviceAction.id == action_id).first()
        if action is None:
            return {
                "error": f"动作不存在: action_id={action_id}",
                "hint": "先用 query_device_actions 查询设备支持的动作及其 action_id",
            }
        if device_id is not None and action.device_id != device_id:
            return {
                "error": (
                    f"动作归属校验失败: action_id={action_id} 属于设备 {action.device_id}，"
                    f"与传入 device_id={device_id} 不一致"
                )
            }
        if not action.enabled:
            return {"error": f"动作已禁用: {action.name} (action_id={action_id})"}
        device = db.query(Device).filter(Device.id == action.device_id).first()
        if device is None:
            return {"error": f"动作所属设备不存在: device_id={action.device_id}"}
        if not device.enabled:
            return {"error": f"设备已禁用: {device.name}"}

        write = is_write_action(action)
        if user_id is not None:
            user = db.query(User).filter(User.id == int(user_id)).first()
            need = ("device", "edit") if write else ("device", "view")
            if user is None or not user_may_call(user, db, need):
                return {"error": f"当前用户无权执行该设备动作，需要 {need[0]}:{need[1]}"}

        key = None
        if write:
            key = build_idempotency_key(
                source="agent",
                device_id=device.id,
                action_type=action.action_type,
                params=params or {},
                agent_id=agent_id,
            )
        result = await DeviceGateway.invoke(
            db,
            device.id,
            action_id=action.id,
            params=params or {},
            source="agent",
            agent_id=agent_id,
            user_id=user_id,
            idempotency_key=key,
            timeout=timeout,
        )
        result["device"] = {"id": device.id, "name": device.name, "type": device.type}
        result["action"] = {
            "id": action.id,
            "action_type": action.action_type,
            "name": action.name,
        }
        body = result.get("response_body")
        if body is not None:
            text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
            if len(text) > _TOOL_RESPONSE_MAX_CHARS:
                result["response_body"] = text[:_TOOL_RESPONSE_MAX_CHARS]
                result["response_truncated"] = True
        return result
    finally:
        db.close()
