"""声明式 HTTP 工具执行器。

针对 ``tool_type == 'http'`` 的工具，按 ``http_config`` 配置发起 httpx 请求，
无需用户编写 Python 代码。流程：

1. 按 ``parameters_schema`` 的 ``location`` 把入参分发到 query / body / header / path。
2. 应用鉴权（Bearer / API Key / OAuth2 / 360 网关签名），合并自定义 headers。
3. 按 ``timeout`` / ``retry`` 发起请求（重试仅针对 5xx 与网络错误）。
4. 按 ``response_jsonpath`` 从响应 JSON 中提取字段，缩减返回给 LLM 的内容。
5. HTTP 状态码非 2xx 或业务错误时，按 ``error_handling`` 构造错误结构返回。

JSONPath 支持子集语法：``$.a.b.c``、``$.a[0].b``、``$.a[*]``，无第三方依赖。
"""
import hashlib
import json
import logging
import random
import re
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

# httpx 在工具沙箱外可用，HTTP 工具由本模块直接发起请求
try:
    import httpx  # noqa: F401
    _HAS_HTTPX = True
except ImportError:  # pragma: no cover
    _HAS_HTTPX = False


# ============ JSONPath 轻量解析 ============

_TOKEN_RE = re.compile(r"\.?([^\.\[\]]+)|\[(\d+)\]|\[\*\]")


def extract_jsonpath(data: Any, path: str) -> Any:
    """从 ``data`` 中按 ``path`` 提取字段（JSONPath 子集）。

    支持的语法：
    - ``$`` 根节点
    - ``.field`` 字段访问
    - ``[0]`` 索引访问
    - ``[*]`` 通配（返回列表）

    Args:
        data: 已解析的 JSON 数据（dict/list/标量）。
        path: JSONPath 表达式，如 ``$.data.weather_info`` 或 ``$.list[0].name``。

    Returns:
        提取到的值；路径不存在时返回 ``None``；通配时返回列表。
    """
    if not path:
        return data
    path = path.strip()
    if path == "$":
        return data
    # 去掉前导 $
    if path.startswith("$"):
        path = path[1:]
    if path.startswith("."):
        path = path[1:]

    current: Any = data
    for match in _TOKEN_RE.finditer(path):
        field, idx, _wild = match.group(1), match.group(2), None
        token = match.group(0)
        if token == "[*]":
            # 通配：对当前列表的每个元素应用剩余路径
            if not isinstance(current, list):
                return []
            rest = path[match.end():]
            return [extract_jsonpath(item, "$" + rest) for item in current]
        if idx is not None:
            if not isinstance(current, list):
                return None
            i = int(idx)
            if i < 0 or i >= len(current):
                return None
            current = current[i]
        elif field is not None and field != "":
            if isinstance(current, dict) and field in current:
                current = current[field]
            else:
                return None
    return current


# ============ 鉴权构造 ============

def _apply_auth(headers: dict, params: dict, auth_type: str, auth_config: dict) -> None:
    """按鉴权类型把凭证注入 headers / params（原地修改）。"""
    auth_type = (auth_type or "none").lower()
    auth_config = auth_config or {}
    if auth_type == "none":
        return
    if auth_type == "bearer":
        token = (auth_config.get("token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "api_key":
        key_name = auth_config.get("key_name") or "X-API-Key"
        key_value = (auth_config.get("key_value") or "").strip()
        loc = (auth_config.get("location") or "header").lower()
        if not key_value:
            return
        if loc == "query":
            params[key_name] = key_value
        else:
            headers[key_name] = key_value
    elif auth_type == "oauth2":
        # OAuth2：使用预配置的 access_token（简化实现，不在此处走授权码流程）
        token = (auth_config.get("access_token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"


# ============ 参数分发 ============

def _distribute_params(parameters: dict, schema: list) -> tuple[dict, dict, dict, dict]:
    """按 parameters_schema 的 location 把入参分发到 query/body/header/path。

    - 未在 schema 中声明的入参默认放入 body。
    - 值为 None 的入参视为未提供（跳过），改用 schema 的 default。
    - schema 中声明了 default 且入参未提供/为 None 时，使用 default。
    """
    schema_map = {p.get("name"): p for p in (schema or []) if p.get("name")}
    params = parameters or {}
    query, body, headers, path = {}, {}, {}, {}
    for name, value in params.items():
        if value is None:
            continue  # None 视为未提供，交给 default 填充逻辑处理
        spec = schema_map.get(name, {})
        location = (spec.get("location") or "body").lower()
        # 枚举值校验
        enum_vals = spec.get("enum")
        if enum_vals and value not in enum_vals and value != "":
            logger.warning("参数 %s 的值 %s 不在枚举 %s 中", name, value, enum_vals)
        if location == "query":
            query[name] = value
        elif location == "header":
            headers[name] = str(value)
        elif location == "path":
            path[name] = value
        else:
            body[name] = value
    # 填充 default：入参未提供或为 None 但有 default 的字段
    for name, spec in schema_map.items():
        provided = params.get(name)
        if provided is not None:
            continue
        default = spec.get("default")
        if default in (None, ""):
            continue
        location = (spec.get("location") or "body").lower()
        if location == "query":
            query[name] = default
        elif location == "header":
            headers[name] = str(default)
        elif location == "path":
            path[name] = default
        else:
            body[name] = default
    return query, body, headers, path


def _render_url(url: str, path_params: dict) -> str:
    """把 path 参数替换到 URL 的 {placeholder} 中。"""
    rendered = url
    for k, v in path_params.items():
        rendered = rendered.replace(f"{{{k}}}", str(v))
    return rendered


# ============ HTTP 工具执行 ============

# 日志回调类型：(level: str, message: str) -> None
LogHandler = Callable[[str, str], None]


async def run_http_tool(
    http_config: dict,
    parameters: dict,
    schema: list | None = None,
    log_handler: LogHandler | None = None,
) -> Any:
    """按 http_config 发起 HTTP 请求并返回（提取后的）结果。

    Args:
        http_config: HTTP 工具配置字典。
        parameters: 调用入参（LLM 提取或测试时手填）。
        schema: parameters_schema，用于参数 location 分发。
        log_handler: 可选日志回调，用于向调用方（如工具测试端点）推送执行链路日志。
            回调签名为 ``(level, message)``，level ∈ {"info", "warning", "error"}。
            为 None 时仅写入服务端 logger。

    Returns:
        提取后的响应数据（dict/list/标量）或错误结构 ``{"error": ...}``。
    """

    def _log(level: str, msg: str) -> None:
        """同时写入服务端 logger 与可选的调用方日志回调。"""
        getattr(logger, level if level in ("info", "warning", "error") else "info", logger.info)(msg)
        if log_handler is not None:
            try:
                log_handler(level, msg)
            except Exception:  # noqa: BLE001
                logger.debug("log_handler 回调异常", exc_info=True)

    if not _HAS_HTTPX:
        _log("error", "服务端未安装 httpx，无法执行 HTTP 工具")
        return {"error": "服务端未安装 httpx，无法执行 HTTP 工具"}

    cfg = http_config or {}
    method = (cfg.get("method") or "GET").upper()
    base_url = (cfg.get("url") or "").strip()
    if not base_url:
        return {"error": "HTTP 工具未配置 URL"}

    headers_cfg = cfg.get("headers") or []
    body_type = (cfg.get("body_type") or "none").lower()
    body_content = cfg.get("body_content") or ""
    auth_type = (cfg.get("auth_type") or "none").lower()
    auth_config = cfg.get("auth_config") or {}
    timeout = float(cfg.get("timeout") or 10)
    retry = int(cfg.get("retry") or 0)
    response_jsonpath = cfg.get("response_jsonpath") or ""

    # 1. 参数分发
    # 自动检测 URL 中的 {placeholder}，强制对应参数走 path（即使用户未设 location=path）
    url_placeholders = set(re.findall(r"\{(\w+)\}", base_url))
    if url_placeholders:
        schema = [dict(p) for p in (schema or [])]  # 浅拷贝，避免污染缓存
        existing_names = {p.get("name") for p in schema}
        for p in schema:
            if p.get("name") in url_placeholders:
                p["location"] = "path"
        # URL 含占位符但 schema 未声明的参数，自动补为 path
        for ph in url_placeholders:
            if ph not in existing_names:
                schema.append({"name": ph, "type": "String", "location": "path", "required": True})
        _log("info", f"URL 占位符自动检测: {sorted(url_placeholders)} → 强制 path 参数")

    query, body, header_params, path_params = _distribute_params(parameters, schema or [])
    _log(
        "info",
        "参数分发: path=%s, query=%s, body=%s, header=%s"
        % (
            path_params or {},
            {k: v for k, v in query.items() if k != "key" and "token" not in k.lower()} or {},
            body or {},
            {k: ("***" if "token" in k.lower() or "key" in k.lower() else v) for k, v in header_params.items()} or {},
        ),
    )

    # 2. 合并 headers：自定义 headers + 鉴权 + 参数 headers
    headers: dict = {}
    for h in headers_cfg:
        k = (h.get("key") or "").strip()
        v = h.get("value")
        if k:
            headers[k] = v
    _apply_auth(headers, query, auth_type, auth_config)
    headers.update(header_params)

    # 3. 构造请求体
    request_body = None
    # 签名类鉴权（x360_signature）要求签名输入与实际发送字节串完全一致，
    # 因此序列化为确定字符串后用 content= 原样发送
    request_content: str | None = None
    if method in ("POST", "PUT", "PATCH") and body_type != "none":
        if body_type == "json":
            request_body = dict(body)
            if body_content.strip():
                if re.search(r"\{\{\w+\}\}", body_content):
                    # 占位符模板：模板本身保持合法 JSON 骨架（{{param}} 位于字符串
                    # 值位置），替换时注入 JSON 编码后的内部值（转义安全、不带外层
                    # 引号）。渲染结果整体作为请求体，支持嵌套结构，如
                    # {"query":{"keywords":[{"field":"query","value":"{{query}}"}]}}
                    rendered = body_content
                    for k, v in body.items():
                        # 字符串按 JSON 编码后去掉外层引号再注入（转义安全）；
                        # 非字符串（数字/布尔/数组/对象）必须保留完整 JSON 字面量，
                        # 否则 json.dumps(10)[1:-1] 会得到空串导致请求体错误。
                        injected = (
                            json.dumps(v, ensure_ascii=False)[1:-1]
                            if isinstance(v, str)
                            else json.dumps(v, ensure_ascii=False)
                        )
                        rendered = rendered.replace("{{" + k + "}}", injected)
                    try:
                        parsed = json.loads(rendered)
                        if parsed is not None:
                            request_body = parsed
                    except json.JSONDecodeError:
                        request_body = dict(body)
                        request_body["__raw__"] = rendered
                        _log("warning", "body 模板占位符渲染后不是合法 JSON，已降级为原始入参")
                else:
                    # 无占位符：模板字段以 setdefault 合并（显式入参优先，保持既有语义）
                    try:
                        parsed = json.loads(body_content)
                        if isinstance(parsed, dict):
                            for k, v in parsed.items():
                                request_body.setdefault(k, v)
                    except json.JSONDecodeError:
                        request_body["__raw__"] = body_content
            headers.setdefault("Content-Type", "application/json")
            if auth_type == "x360_signature":
                # 签名与发送必须使用同一字符串：固定 separators 避免平台差异
                request_content = json.dumps(
                    request_body, ensure_ascii=False, separators=(",", ":")
                )
        elif body_type == "form":
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
            request_body = body
        elif body_type == "xml":
            headers.setdefault("Content-Type", "application/xml")
            request_body = body_content

    # 3.5 360 网关动态签名（全系 360 情报 API 通用，
    # 文档 https://sc.360.net/doc/api/gateway-auth/ ）：
    #   X-360-Signature = md5(md5(body) + apikey + nonce + timestamp + salt)[16:]
    #   nonce 为 8 位随机数字串，timestamp 为 unix 秒；headers 携带
    #   X-360-Key/X-360-Nonce/X-360-Timestamp/X-360-Signature。
    # 凭证（apikey/salt）存于工具 http_config.auth_config，不硬编码在代码中。
    if auth_type == "x360_signature":
        apikey = (auth_config.get("apikey") or "").strip()
        salt = (auth_config.get("salt") or "").strip()
        if not apikey or not salt:
            _log("error", "x360_signature 鉴权缺少 apikey/salt 配置")
            return {"error": "x360_signature 鉴权未配置 apikey/salt（工具管理中填写）"}
        content_str = request_content if request_content is not None else (
            json.dumps(request_body, ensure_ascii=False, separators=(",", ":"))
            if request_body is not None else ""
        )
        nonce = f"{random.randint(0, 99999999):08d}"
        timestamp = str(int(time.time()))
        body_md5 = hashlib.md5(content_str.encode("utf-8")).hexdigest()
        sign_src = f"{body_md5}{apikey}{nonce}{timestamp}{salt}"
        signature = hashlib.md5(sign_src.encode("utf-8")).hexdigest()[16:]
        headers.update({
            "X-360-Key": apikey,
            "X-360-Nonce": nonce,
            "X-360-Timestamp": timestamp,
            "X-360-Signature": signature,
        })
        request_content = content_str
        _log("info", f"已注入 360 网关签名头: key={apikey[:6]}***, nonce={nonce}, ts={timestamp}")

    # 4. 渲染 URL path 参数
    url = _render_url(base_url, path_params)
    # 构造完整请求 URL（含 query string）用于日志展示
    display_url = url
    if query:
        try:
            qs = httpx.QueryParams(query)
            display_url = f"{url}?{qs}"
        except Exception:  # noqa: BLE001
            display_url = f"{url}?{query}"
    _log("info", f"实际请求: {method} {display_url}")
    # 检查是否有未替换的占位符（参数未提供时会发生）
    unreplaced = re.findall(r"\{(\w+)\}", url)
    if unreplaced:
        _log("warning", f"URL 仍有未替换的路径参数: {unreplaced}（请检查参数是否已提供）")

    # 5. 发起请求（带重试）
    last_exc: Exception | None = None
    last_response: httpx.Response | None = None
    attempts = retry + 1
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(attempts):
            try:
                resp = await client.request(
                    method=method,
                    url=url,
                    params=query or None,
                    headers=headers,
                    # x360 签名场景必须原样发送签名时的字符串，改用 content=
                    json=(
                        request_body
                        if body_type == "json" and request_content is None
                        else None
                    ),
                    data=request_body if body_type in ("form", "xml") else None,
                    content=(
                        body_content if body_type == "xml"
                        else request_content.encode("utf-8") if request_content is not None
                        else None
                    ),
                )
                last_response = resp
                # 5xx 才重试
                if resp.status_code < 500:
                    break
                _log("warning", f"HTTP 工具请求返回 5xx，准备重试: {resp.status_code}")
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                _log("warning", f"HTTP 工具请求异常(第 {attempt + 1} 次): {exc}")

    if last_response is None:
        _log("error", f"HTTP 请求失败: {last_exc}")
        return {"error": f"HTTP 请求失败: {last_exc}"}

    resp = last_response
    # 6. 解析响应
    try:
        resp_data = resp.json()
    except Exception:  # noqa: BLE001
        resp_data = resp.text

    _log("info", f"响应状态: {resp.status_code}")

    # 7. 异常处理：HTTP 状态码非 2xx
    if resp.status_code < 200 or resp.status_code >= 300:
        _log("error", f"接口返回非 2xx: HTTP {resp.status_code} — {cfg.get('error_handling') or '接口返回非 2xx 状态码'}")
        return {
            "error": f"HTTP {resp.status_code}",
            "status_code": resp.status_code,
            "response": resp_data,
            "message": cfg.get("error_handling") or "接口返回非 2xx 状态码",
        }

    # 8. JSONPath 提取
    if response_jsonpath and isinstance(resp_data, (dict, list)):
        extracted = extract_jsonpath(resp_data, response_jsonpath)
        return extracted if extracted is not None else resp_data
    return resp_data
