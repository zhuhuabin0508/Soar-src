"""设备动作执行器（可复用工具函数）。

从 devices.test_device_action 与 node_executors.execute_device_action 提取，
供 banned_ips API、设备测试、工作流 device_action 节点统一调用。

核心函数：
- ``execute_device_action``: 实际调用设备 API 执行指定动作，返回结构化结果。
- ``record_device_call``: 把一次动作调用写入 DeviceCallLog（供各链路统一记日志）。
- ``find_device_action_by_type``: 查找指定设备的指定类型动作（启用状态优先）。
"""
import asyncio
import hashlib
import json
import logging
import re
import time as _time
from types import SimpleNamespace
from urllib.parse import quote as _quote
from urllib.parse import urlencode as _urlencode
from typing import Any, Optional

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
        )
        db.add(log)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入设备调用日志失败: %s", exc)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def _record_device_call_isolated(
    device: Device,
    action: DeviceAction,
    *,
    source: str = "manual_test",
    **kwargs,
) -> None:
    """HTTP 阶段不占连接：日志写入使用短会话。"""
    from app.database import LinkageSessionLocal, SessionLocal, close_db_session

    factory = LinkageSessionLocal if source == "workflow" else SessionLocal
    db = factory()
    try:
        record_device_call(db, device=device, action=action, source=source, **kwargs)
    finally:
        close_db_session(db)


def _build_request(
    device: Device,
    action: DeviceAction,
    params: dict[str, Any],
    *,
    skip_required_check: bool = False,
):
    """统一构造设备调用的 (method, url, headers, auth, body)，供各链路复用。"""
    # schema 默认值 / 取值映射：路径占位符与请求体模板共用
    # （调用方未传参时用默认值回填，避免占位符原样下发导致设备 4xx）
    defaults: dict[str, Any] = {}
    value_maps: dict[str, dict] = {}
    param_types: dict[str, str] = {}
    schema_items: list[dict] = []
    try:
        for _p in json.loads(action.params_schema or "[]"):
            if not isinstance(_p, dict):
                continue
            schema_items.append(_p)
            _name = _p.get("name")
            if not _name:
                continue
            # 显式声明的默认值都要回填（含空串），否则 {{param}} 占位符会
            # 原样残留在请求体中，被当作字面量下发给设备
            if "default" in _p:
                defaults[_name] = _p["default"]
            if isinstance(_p.get("map_values"), dict):
                value_maps[_name] = _p["map_values"]
            param_types[_name] = str(_p.get("type") or "").lower()
    except Exception:  # noqa: BLE001
        logger.warning("解析动作 params_schema 默认值失败，忽略: action_id=%s", action.id)
        schema_items = []

    # 必填参数校验：调用方未传且无默认值时直接失败，避免占位符原样下发。
    # 智能体工具层（如 XDR 工具包）已按纠正后的 schema 校验过，可跳过此处
    # 对原始 schema 的校验（原始 schema 可能把文档子结构字段误标为顶层必填）。
    for _p in ([] if skip_required_check else schema_items):
        _name = _p.get("name")
        if not _p.get("required") or not _name:
            continue
        _v = params.get(_name)
        if (_v is None or (isinstance(_v, str) and not _v.strip())) and \
                defaults.get(_name) in (None, ""):
            raise ValueError(f"参数「{_p.get('label') or _name}」不能为空")

    # 1) 拼接 URL（支持 {param} 路径参数占位符：从 params 取值替换并剔除，
    #    调用方未传时回填 schema 默认值；剩余参数继续按 GET query / POST body
    #    传递；无占位符的动作行为不变）
    base_url = (device.api_url or "").rstrip("/")
    api_path = (action.api_path or "").lstrip("/")
    path_values: dict[str, Any] = {}
    if "{" in api_path:
        for _k in re.findall(r"\{(\w+)\}", api_path):
            _v = params.pop(_k, None)
            if _v is None or str(_v) == "":
                _v = defaults.get(_k)
            if _v is not None and str(_v) != "":
                path_values[_k] = _v
                api_path = api_path.replace(f"{{{_k}}}", _quote(str(_v), safe=""))
    url = f"{base_url}/{api_path}" if api_path else base_url
    # SSRF 防护：动作执行出口兜底校验（协议白名单 + 云元数据黑名单）
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

    # 3) 认证（inherit：动作未单独指定时继承设备级认证方式）
    auth_type = action.auth_type or "api_key"
    if auth_type == "inherit":
        auth_type = device.auth_type or "api_key"
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
        # basic 认证凭据为空通常是解密失败（如 Worker 缺 JWT_SECRET）或未配置，
        # 提前报清晰错误，避免把空凭据发给设备换来难以定位的 401
        if not auth[0] or not auth[1]:
            raise ValueError("设备 basic 认证凭据为空（未配置或解密失败，请检查设备账号密码配置）")
    # none: 不添加认证

    # 4) 请求体
    if action.body_template:
        body_str = action.body_template
        # 先用 schema 中声明的默认值填充，再用调用方实际传入的参数覆盖：
        # 调用方只传必填参数时，可选参数占位符（如 {{duration}}）也能替换成默认值，
        # 避免残留字面量导致 JSON 解析失败、退化成字符串请求体。
        # map_values 用于设备语义与平台约定不一致时的取值映射，
        # 例如平台用 duration=0 表示永久，而安博通要求 -1，则声明 {"0": "-1"}。
        merged = dict(defaults)
        # 路径参数同时出现在请求体模板时（如 PUT /wlist/{wlist} 要求 body.wlist
        # 与 URL 一致），把已解析的路径值并入，避免占位符残留
        merged.update(path_values)
        for k, v in params.items():
            # 空值视为「未填写」：有默认值时保留默认值，避免把默认值覆盖成空串；
            # 无默认值时仍按空串替换，保持原有行为。
            if k in defaults and (v is None or (isinstance(v, str) and v.strip() == "")):
                continue
            merged[k] = v
        for k, mapping in value_maps.items():
            if k in merged:
                merged[k] = mapping.get(str(merged[k]).strip(), merged[k])
        for k, v in merged.items():
            _type = param_types.get(k, "")
            if _type in ("integer", "int"):
                # 设备要求 JSON 整数（不加引号），统一转成 int 后按裸值渲染
                try:
                    _raw = str(int(str(v).strip()))
                except (TypeError, ValueError):
                    raise ValueError(f"参数「{k}」必须是整数，当前值: {v!r}") from None
            elif _type == "number":
                # number 允许小数（如带宽 1.5），整数值仍按裸整数渲染
                try:
                    _num = float(str(v).strip())
                except (TypeError, ValueError):
                    raise ValueError(f"参数「{k}」必须是数字，当前值: {v!r}") from None
                _raw = str(int(_num)) if _num.is_integer() else str(_num)
            elif _type in ("array", "object", "json"):
                _val = v
                if isinstance(_val, str):
                    try:
                        _val = json.loads(_val)
                    except ValueError:
                        raise ValueError(
                            f"参数「{k}」必须是合法的 JSON 数组/对象"
                        ) from None
                if _type == "array" and not isinstance(_val, list):
                    raise ValueError(f"参数「{k}」必须是 JSON 数组")
                if _type == "object" and not isinstance(_val, dict):
                    raise ValueError(f"参数「{k}」必须是 JSON 对象")
                _raw = json.dumps(_val, ensure_ascii=False)
            else:
                _raw = str(v)
            body_str = body_str.replace(f"{{{{{k}}}}}", _raw)
        try:
            req_body = json.loads(body_str)
        except Exception:  # noqa: BLE001
            req_body = body_str  # 保持字符串
    else:
        req_body = params

    # 空参数不再拼成 `{}` 请求体：部分设备（如安博通）对带 body 的 GET/DELETE
    # 直接返回 400，去掉空 body 后请求行为与文档中的 GET/DELETE 一致
    if isinstance(req_body, dict) and not req_body:
        req_body = None

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
    username = decrypt_device_secret(device.username or "")
    password = decrypt_device_secret(device.password or "")
    # 设备对接走本机网络直连，忽略代理环境变量
    with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
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


def _sangfor_xdr_sign(
    device: Device,
    action: DeviceAction,
    method: str,
    url: str,
    headers: dict[str, str],
    params: dict[str, Any],
    req_body: Any,
):
    """深信服 XDR OpenAPI 签名（AK/SK 联动码，HMAC-SHA256）。

    联动码存放在设备的 api_key 字段（AES 加密存储），由执行器解密后解析出 AK/SK。
    GET 请求参数按 Query 下发；POST 请求体序列化后与签名使用同一份字节。
    返回 (headers, req_body, final_url)。
    """
    from urllib.parse import urlparse

    from app.tools.xdr_openapi import (
        _build_sorted_query_string,
        _format_sign_date,
        _hmac_sha256_hex_upper,
        _payload_transform,
        _serialize_body,
        _sha256_hex_upper,
        _sign_header_handler,
        _url_transform,
        parse_auth_code,
    )

    auth_code = decrypt_device_secret(device.api_key or "")
    secret = decrypt_device_secret(device.password or "")
    if auth_code and secret:
        # 内置模板复用设备时已将联动码拆分为 AK(api_key)/SK(password)
        ak, sk = auth_code, secret
    elif auth_code:
        try:
            ak, sk = parse_auth_code(auth_code)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"XDR 联动码解析失败: {exc}") from exc
    else:
        raise ValueError("设备未配置 XDR 联动码（请在 API Key 中填写联动码）")

    parsed = urlparse(url)
    path = parsed.path or "/"
    query: dict[str, Any] = {}
    if method == "GET":
        # GET 接口按文档要求使用 Query 参数：schema 默认值 + 调用参数，不下发请求体
        merged = {}
        try:
            for item in json.loads(action.params_schema or "[]"):
                if isinstance(item, dict) and item.get("name") and "default" in item:
                    merged[item["name"]] = item["default"]
        except Exception:  # noqa: BLE001
            logger.warning("解析 XDR 动作参数默认值失败，忽略: action_id=%s", action.id)
        for k, v in params.items():
            if k in merged and (v is None or (isinstance(v, str) and not v.strip())):
                continue
            merged[k] = v
        query = {
            k: v for k, v in merged.items()
            if v is not None and not (isinstance(v, str) and v.strip() == "")
        }
        query_string = _build_sorted_query_string(query)
        url = f"{parsed.scheme}://{parsed.netloc}{path}"
        if query_string:
            url = f"{url}?{query_string}"
        req_body = None

    raw_body_bytes, raw_body_str = _serialize_body(req_body)
    del raw_body_bytes  # 发送与签名共用 raw_body_str，避免二次序列化差异

    sign_headers = {
        k: v for k, v in headers.items() if str(k).lower() != "content-type"
    }
    sign_headers["sdk-host"] = parsed.netloc
    sign_headers["sdk-content-type"] = "application/json"
    sign_date = _format_sign_date()
    sign_headers["sign-date"] = sign_date

    header_str, sign_header_str = _sign_header_handler(sign_headers)
    canonical = (
        method
        + "\n"
        + _url_transform(path)
        + "\n"
        + (_build_sorted_query_string(query) if method == "GET" else "")
        + "\n"
        + header_str
        + sign_header_str
        + "\n"
        + _payload_transform(raw_body_str)
    )
    signature = _hmac_sha256_hex_upper(sk, f"HMAC-SHA256\n{sign_date}\n{_sha256_hex_upper(canonical)}")
    out_headers = dict(sign_headers)
    out_headers.update({
        "Authorization": (
            f"algorithm=HMAC-SHA256, Access={ak}, "
            f"SignedHeaders={sign_header_str}, Signature={signature}"
        ),
        "Content-Type": "application/json",
    })
    return out_headers, (raw_body_str or None), url


def _validate_action_params(action: DeviceAction, params: dict[str, Any]) -> None:
    """按 params_schema 校验 IP 类参数（type=ip/cidr），非法抛 ValueError。

    允许单 IP / CIDR / 范围 / 多值（封禁目标可能为网段），拒绝通配与文本，
    避免把 ``待定``/主机名/畸形 CIDR 原样下发给设备。
    """
    from app.core.ip_validation import validate_ip_expression

    try:
        schema = json.loads(action.params_schema or "[]")
    except (ValueError, TypeError):
        return
    if not isinstance(schema, list):
        return
    for p in schema:
        if not isinstance(p, dict):
            continue
        if str(p.get("type") or "").lower() not in ("ip", "cidr"):
            continue
        name = p.get("name")
        if not name or name not in params:
            continue
        value = params.get(name)
        label = p.get("label") or name
        if value is None or str(value).strip() == "":
            if p.get("required"):
                raise ValueError(f"参数「{label}」不能为空")
            continue
        validate_ip_expression(str(value), label, allow_wildcard=False)


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
    skip_required_check: bool = False,
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
    # 参数格式硬拦截：IP/CIDR 类参数非法时直接失败，不向设备下发
    try:
        _validate_action_params(action, params)
    except ValueError as exc:
        return {"success": False, "status_code": None, "response_body": None,
                "error": str(exc), "latency_ms": 0}
    start = _time.perf_counter()
    # 若调用方未显式传超时，则用设备配置，缺省 30
    timeout = timeout if timeout is not None else (device.timeout or 30)
    verify = bool(device.verify_tls)
    max_retries = device.max_retries if device.max_retries is not None else 0

    try:
        method, url, headers, auth, req_body = _build_request(
            device, action, params, skip_required_check=skip_required_check
        )
    except ValueError as exc:
        return {"success": False, "status_code": None, "response_body": None,
                "error": str(exc), "latency_ms": 0}
    if not url:
        return {"success": False, "status_code": None, "response_body": None,
                "error": "设备未配置 api_url 且动作未配置 api_path", "latency_ms": 0}

    # 审计摘要须在青藤登录前构造：登录失败路径的 record_device_call 也会引用
    request_summary = json.dumps({"url": url, "method": method}, ensure_ascii=False)

    # rollback 会使会话内全部实例属性过期，过期后任何一次属性访问（如下方
    # auth_type）都会触发惰性刷新、重新开启事务并占用连接池连接，贯穿整个
    # 设备 HTTP（含青藤登录与重试退避）。因此先把 HTTP 阶段需要的属性快照成
    # 纯值对象，rollback 后到 HTTP 结束一律使用快照，不再触碰 ORM 实例。
    dev_snap = SimpleNamespace(
        id=device.id, name=device.name, api_url=device.api_url,
        auth_type=device.auth_type, username=device.username,
        password=device.password, api_key=device.api_key,
    )
    act_snap = SimpleNamespace(
        id=action.id, name=action.name, auth_type=action.auth_type,
        params_schema=action.params_schema,
    )

    # 外部 HTTP 不占用调用方 Session 连接（工作流常传入联动会话）。
    # 注意：这里只能结束当前事务把连接还回连接池，绝不能 close()/expunge
    # 会话——调用方（工作台解封、到期自动解封、导入同步、联动回滚等）在设备
    # 调用返回后还要更新同一批 ORM 实例并落库；close/expunge 会使实例脱离
    # 会话，后续赋值静默丢失（表现为：接口返回成功、审计已记录，但封禁/
    # 解封状态永不更新）。rollback 后实例仍 attached（留在会话内），属性已
    # 过期但调用方可按需惰性刷新，后续读写均正常。
    if db is not None:
        try:
            if db.in_transaction():
                db.rollback()
        except Exception:  # noqa: BLE001
            pass

    # 青藤签名协议：登录换取 comId/jwt/signKey 并对本业务请求做 SHA1 签名。
    # 若动作指向登录接口本身，则直接携带账号密码发送，不再走签名流程。
    auth_type = act_snap.auth_type or "api_key"
    if auth_type == "inherit":  # 动作继承设备的认证方式
        auth_type = dev_snap.auth_type or "api_key"
    if auth_type == "qingteng":
        if "/v1/api/auth" in url:
            req_body = {
                "username": decrypt_device_secret(dev_snap.username or ""),
                "password": decrypt_device_secret(dev_snap.password or ""),
            }
            headers["Content-Type"] = "application/json"
        else:
            try:
                comid, jwt, signkey = _qingteng_login(dev_snap, timeout, verify)
            except Exception as exc:  # noqa: BLE001
                msg = f"{type(exc).__name__}: {exc}"
                logger.warning("青藤登录失败: %s", msg)
                if not skip_log:
                    _record_device_call_isolated(
                        dev_snap, act_snap, source=source,
                        workflow_id=workflow_id, agent_id=agent_id,
                        user_id=user_id, source_ip=source_ip,
                        request_summary=request_summary, status="failed",
                        latency_ms=0, error_message=msg,
                    )
                return {"success": False, "status_code": None, "response_body": None,
                        "error": msg, "latency_ms": 0}
            headers, req_body, url = _qingteng_signheaders(
                comid, jwt, signkey, method, params, req_body, url
            )
            # 签名可能为 GET 追加查询串，审计摘要更新为最终 URL
            request_summary = json.dumps({"url": url, "method": method}, ensure_ascii=False)

    # 深信服 XDR：AK/SK 联动码签名；GET 参数转 Query，其余走 JSON 请求体。
    if auth_type == "sangfor_xdr":
        try:
            headers, req_body, url = _sangfor_xdr_sign(
                dev_snap, act_snap, method, url, headers, params, req_body
            )
        except Exception as exc:  # noqa: BLE001
            msg = f"{type(exc).__name__}: {exc}"
            logger.warning("深信服 XDR 签名失败: %s", msg)
            if not skip_log:
                _record_device_call_isolated(
                    dev_snap, act_snap, source=source,
                    workflow_id=workflow_id, agent_id=agent_id,
                    user_id=user_id, source_ip=source_ip,
                    request_summary=request_summary, status="failed",
                    latency_ms=0, error_message=msg,
                )
            return {"success": False, "status_code": None, "response_body": None,
                    "error": msg, "latency_ms": 0}
        request_summary = json.dumps(
            {"url": url, "method": method, "auth": "sangfor_xdr"}, ensure_ascii=False
        )

    def _do_request() -> httpx.Response:
        # 设备对接走本机网络直连，忽略代理环境变量
        with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
            return client.request(
                method=method,
                url=url,
                headers=headers,
                json=req_body if isinstance(req_body, (dict, list)) else None,
                data=req_body if isinstance(req_body, str) else None,
                auth=auth,
            )

    logger.info("调用设备 API: %s %s, auth=%s, device=%s, action=%s",
                method, url, act_snap.auth_type or "api_key", dev_snap.id, act_snap.id)

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
        if not skip_log:
            _record_device_call_isolated(
                dev_snap, act_snap, source=source,
                workflow_id=workflow_id, agent_id=agent_id,
                user_id=user_id, source_ip=source_ip,
                request_summary=request_summary, status="failed",
                latency_ms=latency_ms, error_message=msg,
            )
        return {"success": False, "status_code": None, "response_body": None,
                "error": msg, "latency_ms": latency_ms}

    try:
        resp_body = r.json()
    except Exception:  # noqa: BLE001
        resp_body = r.text

    success = r.status_code < 400
    error = None if success else f"HTTP {r.status_code}"
    logger.info("设备动作执行完成: status=%s, success=%s, device=%s, action=%s",
                r.status_code, success, dev_snap.id, act_snap.id)

    if not skip_log:
        _record_device_call_isolated(
            dev_snap, act_snap, source=source,
            workflow_id=workflow_id, agent_id=agent_id, user_id=user_id,
            source_ip=source_ip, request_summary=request_summary,
            response_summary=json.dumps(resp_body, ensure_ascii=False)[:2000],
            status="success" if success else "failed",
            status_code=r.status_code, latency_ms=latency_ms,
            error_message=error,
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


# 智能体工具返回的响应体上限（字符数）：外部设备 API 可能返回超大列表，
# 超限时截断并标记 response_truncated，保护 LLM 上下文与 SSE 事件大小
_TOOL_RESPONSE_MAX_CHARS = 60000
# 单页被裁剪后建议模型使用的安全页大小（稳定落在上下文上限内）
_SAFE_PAGE_ROWS = 40


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _trim_body_to_page(
    body: Any, params: dict[str, Any], max_chars: int = _TOOL_RESPONSE_MAX_CHARS
) -> tuple[Any, dict[str, Any]] | tuple[None, dict[str, Any]]:
    """把超大的列表型响应体按「整行」裁剪成一页，并返回分页信息。

    直接按字符截断会切坏 JSON：模型只能看到半条记录、且看不到 ``total``，
    只能反复用不同 size 试探，表现为“输出被截断”+同一动作重复调用。
    这里保留 JSON 结构，只保留能完整放下的行，并显式给出
    ``page / page_size / total / has_more / next_page``，模型可据此逐页取数。

    Returns:
        ``(trimmed_body, pagination_meta)``；响应体不是带 ``rows`` 列表的
        JSON 对象时返回 ``(None, {})``，由调用方走文本兜底。
    """
    data = body
    if isinstance(body, str):
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            return None, {}
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        return None, {}
    rows = data["rows"]
    if not rows:
        return None, {}

    page = _as_int(params.get("page"), 0)
    size = _as_int(params.get("size"), len(rows)) or len(rows)
    # 预留非 rows 字段（total/charts 等）与分页元信息的长度
    others = {k: v for k, v in data.items() if k != "rows"}
    budget = max_chars - len(json.dumps(others, ensure_ascii=False)) - 512

    kept: list[Any] = []
    used = 0
    for row in rows:
        row_len = len(json.dumps(row, ensure_ascii=False)) + 2
        if kept and used + row_len > budget:
            break
        kept.append(row)
        used += row_len

    dropped = len(rows) - len(kept)
    total = data.get("total")
    trimmed = dict(data)
    trimmed["rows"] = kept

    # 保险：首行总是被保留，单行过大或非 rows 字段（total/charts 等）过大时，
    # 裁剪结果仍可能超过上限——此时放弃结构化分页，回退调用方的文本截断路径，
    # 保证响应体上限不被绕过
    if len(json.dumps(trimmed, ensure_ascii=False)) > max_chars:
        return None, {}

    if dropped > 0:
        # 本页被裁剪时不能直接翻到 page+1：设备按 page*size 计算偏移，
        # 若继续用原 size 翻页，被裁掉的尾部行会被整段跳过（漏数据）。
        # 这里要求模型改用安全页大小从第 0 页重新取数——可能重复已取行，
        # 但绝不会漏行，且后续每页都能完整放下。
        safe_size = max(1, min(len(kept), _SAFE_PAGE_ROWS))
        meta: dict[str, Any] = {
            "page": page,
            "page_size": safe_size,
            "offset": page * size,
            "returned": len(kept),
            "rows_in_response": len(rows),
            "rows_dropped": dropped,
            "total": total,
            "has_more": True,
            "next_page": None,
            "restart_page": 0,
            "restart_size": safe_size,
        }
        return trimmed, meta

    fetched = page * size + len(kept)
    if isinstance(total, int) and total >= 0:
        has_more = fetched < total
    else:
        has_more = len(rows) >= size

    meta = {
        "page": page,
        "page_size": size,
        "offset": page * size,
        "returned": len(kept),
        "rows_in_response": len(rows),
        "rows_dropped": 0,
        "total": total,
        "has_more": has_more,
        "next_page": (page + 1) if has_more else None,
    }
    return trimmed, meta


# 中高风险等级：处置类动作（封禁/解封/隔离/删数据/变更配置等）。
# 该类动作经智能体触发时必须在服务端校验发起用户权限（与手动封禁工作台
# ban_workflow:edit 口径一致），不能仅依赖工具 description 的提示词纪律。
_HIGH_RISK_LEVELS = {"medium", "high"}


async def execute_device_action_by_id(
    action_id: int,
    params: dict[str, Any] | None = None,
    device_id: int | None = None,
    timeout: float | None = None,
    agent_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """按动作 ID 执行设备动作（智能体工具入口，异步包装）。

    供 tool_runner 沙箱注入：智能体的 execute_device_action 工具代码直接
    ``await execute_device_action_by_id(...)``，无需 import（沙箱禁止 import）。

    与 ``execute_device_action`` 的分工：
    - ``execute_device_action``: 接收 Device/DeviceAction ORM 实例（API/工作流用）；
    - 本函数：接收 action_id（智能体从 query_device_actions 结果中获得），
      自行查库解析实体并校验启用状态，再委托执行引擎，审计 source='agent'。

    HTTP 调用（含重试/青藤登录）为同步阻塞代码，放入线程执行避免阻塞事件循环；
    DB 会话也在该线程内创建并使用，规避跨线程共享 Session 的隐患。

    Args:
        action_id: 设备动作 ID（DeviceAction.id）。
        params: 动作参数键值对。
        device_id: 可选设备 ID，用于校验动作归属（防止误用其他设备的动作）。
        timeout: HTTP 超时秒数（默认取设备配置）。
        agent_id / user_id: 审计归属（写入 DeviceCallLog）。

    Returns:
        dict: 成功执行时含 success / status_code / response_body / latency_ms /
        device / action；失败或校验不通过时含 error（附排查提示）。
    """
    # 入参规整：action_id / device_id 容忍字符串数字，params 必须是对象
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

    def _run() -> dict[str, Any]:
        from app.database import SessionLocal

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
                    ),
                    # action_id 已唯一确定动作归属，无需 device_id；给出可直接照做的重试方式
                    "hint": (
                        f"重试时省略 device_id（或改传 device_id={action.device_id}），"
                        "action_id 已足够定位设备动作"
                    ),
                }
            if not action.enabled:
                return {"error": f"动作已禁用: {action.name} (action_id={action_id})"}
            device = db.query(Device).filter(Device.id == action.device_id).first()
            if device is None:
                return {"error": f"动作所属设备不存在: device_id={action.device_id}"}
            if not device.enabled:
                return {"error": f"设备已禁用: {device.name}"}

            # 服务端门禁：中高风险处置动作校验发起用户权限，防止仅靠提示词
            # 约束被绕过（提示注入/模型误判即可触发封禁等破坏性操作）。
            if (getattr(action, "risk_level", "") or "").lower() in _HIGH_RISK_LEVELS:
                if user_id is None:
                    return {
                        "error": "中高风险设备动作需要在用户会话中执行（缺少发起用户上下文）",
                        "hint": "处置类动作仅允许有权限的登录用户在智能体对话中触发",
                    }
                from app.dependencies import _check_matrix_permission
                from app.models.user import User

                invoking_user = db.query(User).filter(User.id == user_id).first()
                if invoking_user is None or not _check_matrix_permission(
                    db, invoking_user, "ban_workflow", "edit"
                ):
                    return {
                        "error": "权限不足：中高风险处置动作需要「封禁工作台-编辑」权限",
                        "hint": "请联系管理员开通权限，或改由封禁工作台/工单设备动作流程执行",
                    }

            result = execute_device_action(
                device,
                action,
                params or {},
                timeout,
                db=db,
                source="agent",
                agent_id=agent_id,
                user_id=user_id,
            )
            # 附设备/动作上下文，便于智能体解读结果
            result["device"] = {"id": device.id, "name": device.name, "type": device.type}
            result["action"] = {
                "id": action.id,
                "action_type": action.action_type,
                "name": action.name,
            }
            # 响应体过大时按整行裁剪出一页，并返回分页元信息（不破坏 JSON 结构）
            body = result.get("response_body")
            if body is not None:
                text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
                if len(text) > _TOOL_RESPONSE_MAX_CHARS:
                    paged, page_meta = _trim_body_to_page(body, params or {})
                    if paged is not None:
                        result["response_body"] = paged
                        result["pagination"] = page_meta
                        if page_meta.get("rows_dropped"):
                            result["hint"] = (
                                f"本页返回 {page_meta['rows_in_response']} 行，超出上下文上限，"
                                f"已完整保留前 {page_meta['returned']} 行（偏移 {page_meta['offset']} 行起），"
                                f"total={page_meta['total']}。"
                                f"请立即改用 page=0、size={page_meta['restart_size']} 从头逐页取数"
                                "（已取过的行可能重复，跳过即可），之后每页都用同一 size；"
                                "不要沿用原 size 翻页（会漏行），也不要反复试探其它 size。"
                            )
                        else:
                            result["hint"] = (
                                f"响应按整行返回：本次 {page_meta['returned']} 行，"
                                f"total={page_meta['total']}，has_more={page_meta['has_more']}。"
                                + (
                                    f"下一页请使用 page={page_meta['next_page']}、"
                                    f"size={page_meta['page_size']}，直到 has_more=false；"
                                    "不要用其它 size 反复试探。"
                                    if page_meta["has_more"]
                                    else "已取完本查询的全部行。"
                                )
                            )
                    else:
                        # 非列表型响应：仅保留前部文本，明确提示缩小查询范围
                        result["response_body"] = (
                            text[:_TOOL_RESPONSE_MAX_CHARS]
                            + f"\n...[响应体过长（原始 {len(text)} 字符），仅保留前 {_TOOL_RESPONSE_MAX_CHARS} 字符；"
                            "请增加过滤条件或缩小查询范围]"
                        )
                        result["response_truncated"] = True
            return result
        finally:
            db.close()

    return await asyncio.to_thread(_run)
