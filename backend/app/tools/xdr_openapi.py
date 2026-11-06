"""XDR 开放性 OpenAPI 联动码签名执行器。

实现《XDR 开放性 Skill 能力标准文档》定义的认证机制：
authCode 联动码 -> AK/SK -> HMAC-SHA256 请求签名。

算法基准与 Skill 资产内三份参考实现逐函数对齐：
- ai-bigscreen/packages/ui/src/utils/openapi/authCode.ts
- ai-bigscreen/packages/ui/src/utils/openapi/signature.ts
- ai-bigscreen/packages/ui/scripts/aksk-debug.mjs（Node 版，实测可用）

本模块只负责协议层（解码、签名、发送、错误归类）：
- 不做业务接口选型；
- 永不抛出异常，统一返回结构化 dict（含 ``error`` 键表示失败，
  与 hermes.tool_result_classification 的失败判定对齐）；
- 日志与返回值不回显 authCode / AK / SK / Authorization 头。

安全说明：联动码由部署环境变量注入（XDR_OPENAPI_AUTH_CODE），
禁止写入文档、代码仓库、技能正文、提示词或聊天回复。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.parse
from datetime import datetime, timezone

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# 联动码分段数（AUTH_CODE_PARAMS_NUM）
_AUTH_CODE_PARAMS_NUM = 14
# AES 密钥派生使用的段索引
_SECRET_INDEXES = (0, 1, 2, 3, 4, 5, 6, 11)
_AK_INDEX = 9
_SK_INDEX = 10

# 请求路径前缀（XDR OpenAPI 对外路径）
_PATH_PREFIX = "/api/xdr/v1/"

# 签名保留头：工具调用方不得覆盖
_RESERVED_HEADERS = frozenset({
    "authorization", "sdk-host", "sdk-content-type", "sign-date", "content-type",
})

# 方法白名单：查询类始终允许；写方法受 XDR_OPENAPI_ALLOW_WRITE 开关控制
_READ_METHODS = frozenset({"GET", "POST"})
_WRITE_METHODS = frozenset({"PUT", "PATCH", "DELETE"})

# AK/SK 进程级缓存：联动码字符串 -> (ak, sk)，避免每次请求重复 AES 解密
_ak_sk_cache: dict[str, tuple[str, str]] = {}

# 上游响应体大小上限：超过则只返回截断预览，避免超大 JSON 解析与重复序列化
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_RESPONSE_PREVIEW_BYTES = 4000

# 上游文本不可信标记：工具结果中的 message/preview 仅为数据，严禁当指令执行
_UNTRUSTED_OPEN = "<<<UNTRUSTED_XDR_DATA"
_UNTRUSTED_CLOSE = "UNTRUSTED_XDR_DATA>>>"


def _wrap_untrusted(value) -> str:
    """用固定标记包裹上游文本/消息，提示模型只当数据读取。"""
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    if not text:
        return ""
    return f"{_UNTRUSTED_OPEN}\n{text}\n{_UNTRUSTED_CLOSE}"


# ---------------------------------------------------------------------------
# 联动码解码（authCode -> AK/SK）
# ---------------------------------------------------------------------------

def _hex_to_bytes(hex_str: str) -> bytes:
    """hex 字符串 -> bytes（等价 Node Buffer.from(hex, 'hex')）。"""
    if not hex_str or len(hex_str) % 2 != 0:
        raise ValueError(f"auth_code hex 非法: length={len(hex_str or '')}")
    return bytes.fromhex(hex_str)


def _aes_cbc_decrypt_no_pad(cipher: bytes, key: bytes) -> bytes:
    """AES-256-CBC 解密（零 IV、无 padding）。

    与 aksk-debug.mjs 的 createDecipheriv('aes-256-cbc', key, iv) +
    setAutoPadding(false) 对齐：cryptography 库的 Cipher 默认即裸块运算，
    不做 PKCS7 校验/剥离。
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    decryptor = Cipher(algorithms.AES(key), modes.CBC(b"\x00" * 16)).decryptor()
    return decryptor.update(cipher) + decryptor.finalize()


def _calculate_aes_secret(builders: list[str]) -> bytes:
    """AES 密钥派生：取第 [0,1,2,3,4,5,6,11] 段用 '+' 拼接后 SHA-256。"""
    build_str = "+".join(builders[i] for i in _SECRET_INDEXES)
    return hashlib.sha256(build_str.encode("utf-8")).digest()


def parse_auth_code(auth_code: str) -> tuple[str, str]:
    """解析联动码 -> (ak, sk)。

    步骤（与 authCode.ts parseAuthCode / aksk-debug.mjs parseAuthCode 对齐）：
    1. hex 解码；
    2. utf-8 解码后按 "|" 切分，必须 14 段；
    3. SHA-256 派生 32 字节 AES 密钥；
    4. AES-256-CBC（零 IV、无 padding）解密第 9 段得 AK、第 10 段得 SK。
    """
    raw = _hex_to_bytes(auth_code)
    builders = raw.decode("utf-8", errors="replace").split("|")
    if len(builders) != _AUTH_CODE_PARAMS_NUM:
        raise ValueError(f"auth_code 段数不足: {len(builders)}/{_AUTH_CODE_PARAMS_NUM}")
    aes_secret = _calculate_aes_secret(builders)
    ak = _aes_cbc_decrypt_no_pad(_hex_to_bytes(builders[_AK_INDEX]), aes_secret).decode(
        "utf-8", errors="replace"
    )
    sk = _aes_cbc_decrypt_no_pad(_hex_to_bytes(builders[_SK_INDEX]), aes_secret).decode(
        "utf-8", errors="replace"
    )
    return ak, sk


def _get_ak_sk(auth_code: str) -> tuple[str, str]:
    """带缓存的联动码解析（与 authCode.ts getAkSk 的模块级单例缓存对齐）。"""
    cached = _ak_sk_cache.get(auth_code)
    if cached is not None:
        return cached
    ak_sk = parse_auth_code(auth_code)
    if len(_ak_sk_cache) > 16:  # 防御：正常只有一个有效联动码
        _ak_sk_cache.clear()
    _ak_sk_cache[auth_code] = ak_sk
    return ak_sk


# ---------------------------------------------------------------------------
# 签名（canonical -> HMAC-SHA256）
# ---------------------------------------------------------------------------

def _sha256_hex_upper(data: str | bytes) -> str:
    """SHA-256 摘要 -> 大写 hex。"""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest().upper()


def _hmac_sha256_hex_upper(secret_key: str, data: str) -> str:
    """HMAC-SHA256 -> 大写 hex。"""
    return hmac.new(secret_key.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest().upper()


def _format_sign_date() -> str:
    """sign-date：YYYYMMDDTHHMMSSZ（UTC）。"""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y%m%dT%H%M%SZ")


def _url_transform(url_path: str) -> str:
    """路径变换（与 signature.ts urlTransform 对齐）：
    剥 query -> 末尾补 "/" -> URL 编码（utf-8，保留 "/"）。"""
    q_idx = url_path.find("?")
    path = url_path[:q_idx] if q_idx >= 0 else url_path
    if not path.endswith("/"):
        path += "/"
    return urllib.parse.quote(path, safe="/")


def _build_sorted_query_string(query: dict) -> str:
    """Query 串（与 signature.ts buildSortedQueryString 对齐）：
    按 key 字典序排序，key/value 均编码，"=" 连接，"&" 拼接。"""
    if not query:
        return ""
    # 值为 None 的参数直接丢弃，避免拼成字符串 "None" 发给上游
    items = [(str(k), v) for k, v in query.items() if v is not None]
    items.sort(key=lambda kv: kv[0])
    parts = [
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(str(v), safe='')}"
        for k, v in items
    ]
    return "&".join(parts)


def _sign_header_handler(headers: dict[str, str]) -> tuple[str, str]:
    """签名头串（与 signature.ts signHeaderHandler 对齐）：
    按 key.lower() 排序，逐行 "key:value\\n"，再 "key;key;..."。"""
    entries = sorted(headers.items(), key=lambda kv: kv[0].lower())
    header_str = "".join(f"{k}:{v}\n" for k, v in entries)
    sign_header_str = ";".join(k for k, _ in entries)
    return header_str, sign_header_str


def _payload_transform(payload: str) -> str:
    """payload 哈希（与 signature.ts payloadTransform 对齐）：
    utf-8 字节 -> 升序排序 -> 去空格(0x20) -> SHA-256 大写 hex。"""
    if not payload:
        return _sha256_hex_upper("")
    raw = payload.encode("utf-8")
    filtered = sorted(b for b in raw if b != 0x20)
    return _sha256_hex_upper(bytes(filtered))


def _serialize_body(body) -> tuple[bytes | None, str]:
    """body 只序列化一次：签名字节与发送字节必须是同一份。

    ensure_ascii=True：非 ASCII 字符转成 \\uXXXX 转义（紧凑格式）。
    实测 XDR 网关验签时对含中文的原始 UTF-8 body 返回 401
    （网关侧 cjson 规范化会转义非 ASCII），转义后签名与发送
    字节一致，且纯 ASCII body 序列化结果不变。
    """
    if body is None:
        return None, ""
    raw = json.dumps(body, ensure_ascii=True, separators=(",", ":"))
    return raw.encode("utf-8"), raw


# ---------------------------------------------------------------------------
# 配置规范化
# ---------------------------------------------------------------------------

def _resolve_host() -> tuple[str, str]:
    """返回 (base_url, sdk_host)。host 缺协议时默认 https。"""
    host = (settings.XDR_OPENAPI_HOST or "").strip().rstrip("/")
    if not host:
        raise ValueError("XDR_OPENAPI_HOST 未配置")
    if "://" not in host:
        host = f"https://{host}"
    parsed = urllib.parse.urlparse(host)
    return host, parsed.netloc


# ---------------------------------------------------------------------------
# 错误构造
# ---------------------------------------------------------------------------

def _fail(
    error_type: str,
    message: str,
    hint: str = "",
    retryable: bool = False,
    http_status: int | None = None,
    method: str = "",
    path: str = "",
) -> dict:
    """统一失败结构。``error`` 键供 hermes 失败判定使用。"""
    out = {
        "ok": False,
        "error_type": error_type,
        "http_status": http_status,
        "error": message,
        "retryable": retryable,
        "method": method,
        "path": path,
    }
    if hint:
        out["hint"] = hint
    return out


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------

async def call_xdr_openapi(
    method: str,
    path: str,
    query: dict | None = None,
    body: dict | list | None = None,
    headers: dict | None = None,
) -> dict:
    """签名并请求 XDR OpenAPI，永不抛出异常，统一返回结构化结果。

    Args:
        method: HTTP 方法（GET/POST/PUT/PATCH/DELETE）。
        path: 对外路径，必须以 /api/xdr/v1/ 开头，不含 host/协议/query。
        query: Query 参数（仅标量值）。
        body: JSON 业务参数（GET 不传）。
        headers: 自定义请求头（参与签名，但不得覆盖签名保留头）。

    Returns:
        成功: ``{"ok": True, "http_status", "code", "message", "data", "method", "path", "elapsed_ms"}``
        失败: ``{"ok": False, "error_type", "error", "hint", "retryable", ...}``
    """
    started = datetime.now(timezone.utc)
    method = str(method or "").upper()

    # ---- 入参校验（PARAM_ERROR / METHOD_FORBIDDEN / CONFIG_MISSING）----
    if method not in _READ_METHODS and method not in _WRITE_METHODS:
        return _fail("PARAM_ERROR", f"不支持的 HTTP 方法: {method}", "仅支持 GET/POST/PUT/PATCH/DELETE")
    if method in _WRITE_METHODS and not settings.XDR_OPENAPI_ALLOW_WRITE:
        return _fail(
            "METHOD_FORBIDDEN",
            f"方法 {method} 不在允许范围（平台当前仅允许查询类请求）",
            "如需写操作，请平台管理员开启 XDR_OPENAPI_ALLOW_WRITE 并确认联动码权限",
            method=method, path=str(path or ""),
        )

    raw_path = str(path or "")
    if not raw_path.startswith(_PATH_PREFIX):
        return _fail(
            "PARAM_ERROR",
            f"path 必须以 {_PATH_PREFIX} 开头: {raw_path[:80]}",
            "使用对外路径，不含 host、协议与 query；接口路径以接口文档为准",
            method=method, path=raw_path,
        )
    if any(tok in raw_path for tok in ("://", "?", "#", "..")):
        return _fail(
            "PARAM_ERROR",
            "path 不允许包含 ://、?、# 或 ..",
            "Query 参数请通过 query 参数传递",
            method=method, path=raw_path,
        )

    if query is not None and not isinstance(query, dict):
        return _fail("PARAM_ERROR", "query 必须是对象（键值对）", "数组/对象参数请放入 body", method=method, path=raw_path)
    for k, v in (query or {}).items():
        if isinstance(v, (dict, list)):
            return _fail(
                "PARAM_ERROR",
                f"query 参数 {k} 的值不允许是数组/对象",
                "数组/对象参数请放入 body",
                method=method, path=raw_path,
            )

    custom_headers: dict[str, str] = {}
    for k, v in (headers or {}).items():
        if str(k).lower() in _RESERVED_HEADERS:
            return _fail(
                "PARAM_ERROR",
                f"不允许覆盖签名保留头: {k}",
                "保留头: authorization / sdk-host / sdk-content-type / sign-date / content-type",
                method=method, path=raw_path,
            )
        custom_headers[str(k)] = str(v)

    if body is not None and not isinstance(body, (dict, list)):
        return _fail("PARAM_ERROR", "body 必须是 JSON 对象或数组", method=method, path=raw_path)
    if method == "GET" and body is not None:
        return _fail("PARAM_ERROR", "GET 请求不携带 body", "查询参数请通过 query 传递", method=method, path=raw_path)

    # ---- 配置与联动码（CONFIG_MISSING / CONFIG_INVALID）----
    try:
        base_url, sdk_host = _resolve_host()
    except ValueError as exc:
        return _fail("CONFIG_MISSING", str(exc), "请平台管理员在部署环境配置 XDR_OPENAPI_HOST", method=method, path=raw_path)

    auth_code = (settings.XDR_OPENAPI_AUTH_CODE or "").strip()
    if not auth_code:
        return _fail(
            "CONFIG_MISSING",
            "XDR_OPENAPI_AUTH_CODE 未配置",
            "请平台管理员在部署环境配置联动码；联动码来源：XDR「配置管理 → 系统设置 → 开放性 → 联动码管理」",
            method=method, path=raw_path,
        )
    try:
        ak, sk = _get_ak_sk(auth_code)
    except Exception as exc:
        return _fail(
            "CONFIG_INVALID",
            f"联动码解析失败: {exc}",
            "联动码可能已轮换或配置错误，请平台管理员重新生成并更新环境变量",
            method=method, path=raw_path,
        )

    # ---- 签名（与 signature.ts signature() 逐函数对齐）----
    # 签名头集合：sdk-host / sdk-content-type / sign-date + 自定义头。
    # Content-Type 在发送时设置但不参与签名（与 aksk-debug.mjs 实测行为一致）。
    sign_headers = dict(custom_headers)
    sign_headers["sdk-host"] = sdk_host
    sign_headers["sdk-content-type"] = "application/json"
    sign_date = _format_sign_date()
    sign_headers["sign-date"] = sign_date

    header_str, sign_header_str = _sign_header_handler(sign_headers)
    query_string = _build_sorted_query_string(query or {})
    raw_body_bytes, raw_body_str = _serialize_body(body)
    payload_hash = _payload_transform(raw_body_str)

    canonical = (
        method
        + "\n"
        + _url_transform(raw_path)
        + "\n"
        + query_string
        + "\n"
        + header_str
        + sign_header_str
        + "\n"
        + payload_hash
    )
    hashed_canonical = _sha256_hex_upper(canonical)
    total_str = f"HMAC-SHA256\n{sign_date}\n{hashed_canonical}"
    signature = _hmac_sha256_hex_upper(sk, total_str)
    authorization = (
        f"algorithm=HMAC-SHA256, Access={ak}, SignedHeaders={sign_header_str}, Signature={signature}"
    )

    # ---- 发送（签名后不得再修改任何请求要素）----
    url = base_url + raw_path
    if query_string:
        url = f"{url}?{query_string}"
    send_headers = dict(custom_headers)
    send_headers.update({
        "Authorization": authorization,
        "sdk-host": sdk_host,
        "sdk-content-type": "application/json",
        "sign-date": sign_date,
        "Content-Type": "application/json",
    })

    try:
        async with httpx.AsyncClient(
            timeout=settings.XDR_OPENAPI_TIMEOUT,
            verify=settings.XDR_OPENAPI_VERIFY_SSL,
        ) as client:
            resp = await client.request(method, url, headers=send_headers, content=raw_body_bytes)
    except httpx.ConnectTimeout:
        return _fail(
            "TIMEOUT",
            f"连接 XDR 超时（>{settings.XDR_OPENAPI_TIMEOUT}s）",
            "请检查网络连通性后重试 1 次",
            retryable=True, method=method, path=raw_path,
        )
    except httpx.TimeoutException:
        return _fail(
            "TIMEOUT",
            f"请求 XDR 超时（>{settings.XDR_OPENAPI_TIMEOUT}s）",
            "可缩小时间范围或降低 pageSize 后重试 1 次",
            retryable=True, method=method, path=raw_path,
        )
    except httpx.ConnectError:
        return _fail(
            "NETWORK_UNREACHABLE",
            f"无法连接 XDR 平台: {sdk_host}",
            "请检查平台到 XDR 的网络策略与主机地址",
            method=method, path=raw_path,
        )
    except Exception as exc:  # noqa: BLE001 —— 统一归类，模块承诺永不抛出
        if _is_tls_error(exc):
            return _fail(
                "TLS_ERROR",
                f"TLS 证书校验失败: {exc}",
                "自签证书环境请联系管理员确认 XDR_OPENAPI_VERIFY_SSL 配置",
                method=method, path=raw_path,
            )
        return _fail(
            "UPSTREAM_ERROR",
            f"请求异常: {exc}",
            "可重试 1 次；仍失败请联系平台管理员",
            retryable=True, method=method, path=raw_path,
        )

    elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    logger.info(
        "XDR OpenAPI 调用: method=%s path=%s status=%s elapsed_ms=%d",
        method, raw_path, resp.status_code, elapsed_ms,
    )

    # ---- 状态码映射 ----
    status = resp.status_code
    if status == 401:
        return _fail("AUTH_FAILED", "XDR 网关鉴权失败（401）", "联动码可能已失效或被删除，请管理员重新生成", http_status=status, method=method, path=raw_path)
    if status == 403:
        return _fail("PERMISSION_DENIED", "XDR 网关拒绝访问（403）", "联动码无权调用该接口，请在 XDR 联动码管理中开放对应接口权限", http_status=status, method=method, path=raw_path)
    if status == 404:
        return _fail("NOT_FOUND", "接口不存在（404）", "请回查接口文档校正 path，禁止猜测路径", http_status=status, method=method, path=raw_path)
    if status == 429:
        return _fail("RATE_LIMITED", "触发限流（429）", "退避后重试 1 次", retryable=True, http_status=status, method=method, path=raw_path)
    if 400 <= status < 500:
        return _fail(
            "PARAM_ERROR",
            f"参数不合法（{status}）: {_wrap_untrusted(resp.text[:200])}",
            "请回查接口文档的字段规则",
            http_status=status, method=method, path=raw_path,
        )
    if status >= 500:
        return _fail("UPSTREAM_ERROR", f"XDR 服务异常（{status}）", "可重试 1 次", retryable=True, http_status=status, method=method, path=raw_path)

    # ---- 响应大小上限（避免超大 JSON 解析/重复序列化）----
    if len(resp.content) > _MAX_RESPONSE_BYTES:
        preview = resp.content[:_RESPONSE_PREVIEW_BYTES].decode("utf-8", errors="replace")
        return {
            "ok": True,
            "http_status": status,
            "code": "RESPONSE_TOO_LARGE",
            "message": f"响应体超过 {_MAX_RESPONSE_BYTES} 字节上限，已截断",
            "data": None,
            "preview": _wrap_untrusted(preview),
            "truncated": True,
            "method": method,
            "path": raw_path,
            "elapsed_ms": elapsed_ms,
        }

    # ---- 响应外壳解析 ----
    text = resp.text
    if not text.strip() and 200 <= status < 300:
        # 2xx 空响应（如 204 No Content）属正常：写操作成功但无返回体
        return {
            "ok": True,
            "http_status": status,
            "code": "Success",
            "message": "",
            "data": None,
            "method": method,
            "path": raw_path,
            "elapsed_ms": elapsed_ms,
        }
    try:
        payload = json.loads(text) if text else None
    except Exception:
        payload = None
    if payload is None:
        return _fail(
            "UPSTREAM_ERROR",
            "XDR 响应不是有效 JSON",
            "可重试 1 次；仍失败请联系平台管理员",
            retryable=True, http_status=status, method=method, path=raw_path,
        )

    if isinstance(payload, dict):
        code = payload.get("code")
        message = payload.get("message", "")
        data = payload.get("data")
        # code 缺失视为成功（部分接口无外壳）；Success/0 视为成功
        if code is not None and str(code) not in ("Success", "0"):
            return _fail(
                "APP_ERROR",
                f"业务校验失败: code={code}, message={_wrap_untrusted(message)}",
                "请按接口文档核对业务约束（枚举值、时间范围、必填字段）",
                http_status=status, method=method, path=raw_path,
            )
    else:
        code, message, data = "Success", "", payload

    return {
        "ok": True,
        "http_status": status,
        "code": code if code is not None else "Success",
        "message": _wrap_untrusted(message) if isinstance(message, str) else "",
        "data": data,
        "method": method,
        "path": raw_path,
        "elapsed_ms": elapsed_ms,
    }


def _is_tls_error(exc: Exception) -> bool:
    """判断异常是否为 TLS/证书错误。"""
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    return "ssl" in name or "certificate" in text or "tls" in text


def summarize_xdr_data(data) -> dict:
    """按"不假设具体业务字段"的方式生成数据摘要。

    供工具返回给模型的轻量视图：顶层键、total/page/pageSize、列表长度、has_more。
    """
    summary: dict = {}
    if data is None:
        return {"empty": True}

    target = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else data
    if isinstance(target, dict):
        keys = list(target.keys())
        if keys:
            summary["top_level_keys"] = keys[:20]
        total = target.get("total")
        if isinstance(total, (int, float)):
            summary["total"] = total
        page = target.get("page")
        if isinstance(page, (int, float)):
            summary["page"] = page
        page_size = target.get("pageSize") or target.get("page_size")
        if isinstance(page_size, (int, float)):
            summary["page_size"] = page_size

        returned = None
        for list_key in ("item", "list", "records", "rows", "data"):
            val = target.get(list_key)
            if isinstance(val, list):
                returned = len(val)
                summary["list_field"] = list_key
                break
        if returned is None and isinstance(target, list):
            returned = len(target)
        if returned is not None:
            summary["returned"] = returned

        total_v = summary.get("total")
        page_v = summary.get("page")
        size_v = summary.get("page_size")
        if isinstance(total_v, (int, float)) and isinstance(page_v, (int, float)) and isinstance(size_v, (int, float)) and size_v > 0:
            summary["has_more"] = total_v > page_v * size_v
        elif isinstance(returned, int):
            summary["has_more"] = returned == summary.get("page_size")

        if total_v == 0 or returned == 0:
            summary["empty"] = True
    elif isinstance(data, list):
        summary["returned"] = len(data)
        summary["empty"] = len(data) == 0
    else:
        summary["value_type"] = type(data).__name__
    return summary
