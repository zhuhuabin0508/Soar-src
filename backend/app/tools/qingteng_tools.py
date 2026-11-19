"""青藤云安全平台直连客户端（供工具沙箱命名空间注入）。

沙箱禁止工具代码使用 ``import``（无法直接 import 本模块、也无法用
``hashlib``/``ssl``/``http.client``），故本模块在**框架层**实现完整青藤
直连协议（内部正常 import 标准库），并把异步封装函数注入到
``tool_runner.py`` 的 namespace，工具代码只需直接调用 ``qingteng_*(...)``。

协议（源自 qingteng_skill 完整包 / qingteng_client.py，已在本平台容器验证）:
  1. 登录 POST {base}/v1/api/auth {username,password} -> {signKey, jwt, comId}
  2. GET 签名 = sha1(comId + 按key排序的 key+value 拼接 + timestamp + signKey)
  3. POST签名 = sha1(comId + body_json + timestamp + signKey)
  4. 请求头: comId, timestamp, sign, Authorization: Bearer jwt

凭据来源（平台原生风格——环境变量，避免依赖宿主机文件）:
  通过 env 或应用 .env 提供 JSON 字符串 QINGTENG_DEVICES, 例如:
    QINGTENG_DEVICES='[
      {"name":"政务云","device_id":"gongwuyun","base_url":"https://10.132.0.9",
       "username":"...","password":"...","verify_ssl":false,"note":"..."},
      {"name":"裸金属","device_id":"baremetal","base_url":"http://10.223.132.25/","username":"...","password":"..."},
      {"name":"应用推进处","device_id":"apptjd","base_url":"https://szh-qhsds.sz.gov.cn","username":"...","password":"..."}
    ]'
  亦兼容遗留文件 /root/.hermes/data/qingteng_devices.json（若设了
  QINGTENG_DEVICES_FILE 指向它则优先读取该文件，结构 {"devices":[...]}）。
"""
import asyncio
import hashlib
import http.client as httplib
import json
import logging
import os
import ssl
import time
import urllib.parse
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 默认环境变量名（也可通过 settings.QINGTENG_DEVICES 传入）
_QINGTENG_DEVICES_ENV = "QINGTENG_DEVICES"
_QINGTENG_DEVICES_FILE_ENV = "QINGTENG_DEVICES_FILE"
_LEGACY_FILE = "/root/.hermes/data/qingteng_devices.json"


def _load_devices_json() -> Optional[list]:
    """从环境变量（首选）或遗留文件读取设备列表 JSON 字符串。"""
    raw = os.environ.get(_QINGTENG_DEVICES_ENV)
    if raw and raw.strip():
        try:
            return json.loads(raw)
        except Exception as e:  # pragma: no cover
            logger.error("解析 %s 失败: %s", _QINGTENG_DEVICES_ENV, e)
    fpath = os.environ.get(_QINGTENG_DEVICES_FILE_ENV) or _LEGACY_FILE
    try:
        with open(fpath, encoding="utf-8") as f:
            data = json.load(f)
            return data.get("devices") if isinstance(data, dict) else data
    except FileNotFoundError:
        return None
    except Exception as e:  # pragma: no cover
        logger.error("读取青藤凭据文件失败 %s: %s", fpath, e)
        return None


def set_devices_from_settings(json_str: str = "") -> None:
    """允许平台启动时用 settings 注入凭据（避免依赖进程环境变量）。"""
    if json_str and json_str.strip():
        os.environ[_QINGTENG_DEVICES_ENV] = json_str


def load_devices() -> list:
    devs = _load_devices_json()
    if not devs:
        raise RuntimeError(
            "青藤凭据未配置。请在环境变量或应用 .env 设置 QINGTENG_DEVICES "
            "(JSON 数组)，或提供 /root/.hermes/data/qingteng_devices.json。"
        )
    return devs


def find_device(name: str) -> dict:
    name = (name or "").strip().lower()
    if not name:
        raise ValueError("device 参数不能为空（gongwuyun / baremetal / apptjd）")
    for d in load_devices():
        if name in d.get("name", "").lower():
            return d
        if d.get("device_id", "").lower() == name:
            return d
    raise ValueError(
        f"未找到设备 '{name}'。可用: {[d.get('name') for d in load_devices()]}"
    )


def _open_conn(dev: dict):
    u = urllib.parse.urlparse(dev["base_url"])
    is_https = u.scheme == "https"
    host = u.hostname
    port = u.port or (443 if is_https else 80)
    verify = dev.get("verify_ssl", False)
    base_path = u.path.rstrip("/") or ""
    if is_https and not verify:
        ctx = ssl._create_unverified_context()
        return httplib.HTTPSConnection(host, port, context=ctx, timeout=30), base_path
    cls = httplib.HTTPSConnection if is_https else httplib.HTTPConnection
    return cls(host, port, timeout=30), base_path


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def login(dev: dict):
    """同步登录，返回 (auth, err)。auth = {signKey, jwt, comId}。"""
    conn, base_path = _open_conn(dev)
    try:
        body = json.dumps({"username": dev["username"], "password": dev["password"]})
        url = f"{base_path}/v1/api/auth"
        conn.request("POST", url, body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode() or "{}")
        if resp.status != 200:
            return None, f"HTTP {resp.status}: {payload.get('message', payload)}"
        data = payload.get("data") or {}
        sign_key, jwt, com_id = data.get("signKey"), data.get("jwt"), data.get("comId")
        if not sign_key or not jwt or com_id is None:
            return None, f"登录响应缺字段: {json.dumps(payload, ensure_ascii=False)[:200]}"
        return {"signKey": sign_key, "jwt": jwt, "comId": str(com_id)}, None
    except Exception as e:  # noqa: BLE001
        return None, str(e)
    finally:
        conn.close()


async def qingteng_login(device: str = "gongwuyun"):
    """登录指定设备，返回认证信息。供工具直接调用（异步包装）。"""
    dev = find_device(device)
    return await asyncio.to_thread(login, dev)


def _norm_qval(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (list, tuple)):
        return ",".join(_norm_qval(x) for x in v)
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return str(v)


def _norm_query(q):
    return {k: _norm_qval(v) for k, v in (q or {}).items() if v is not None}


def _get_sign(com_id, query, ts, sign_key):
    pieces = [f"{k}{query[k]}" for k in sorted(query.keys())]
    return _sha1(f"{com_id}{''.join(pieces)}{ts}{sign_key}")


def _body_sign(com_id, body_json, ts, sign_key):
    return _sha1(f"{com_id}{body_json}{ts}{sign_key}")


def request(dev, method: str, path: str, auth: dict, query=None, body=None):
    """同步发起签名请求。返回 {"ok":..,"status":..,"data":..} 或 {"ok":False,"status":..,"error":..}。"""
    conn, base_path = _open_conn(dev)
    try:
        method = method.upper()
        ts = int(time.time())
        q = _norm_query(query)
        if method == "GET":
            sign = _get_sign(auth["comId"], q, ts, auth["signKey"])
            body_json = None
        else:
            body_json = json.dumps(body or {}, ensure_ascii=False, separators=(",", ":"))
            sign = _body_sign(auth["comId"], body_json, ts, auth["signKey"])
        url = f"{base_path}{path}"
        if q:
            url += "?" + urllib.parse.urlencode(q)
        headers = {
            "Content-Type": "application/json",
            "comId": auth["comId"],
            "timestamp": str(ts),
            "sign": sign,
            "Authorization": f"Bearer {auth['jwt']}",
        }
        conn.request(method, url, body=body_json, headers=headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace") or "{}"
        try:
            payload = json.loads(raw)
        except Exception:  # noqa: BLE001
            payload = raw
        if resp.status != 200:
            msg = payload.get("message", payload) if isinstance(payload, dict) else payload
            return {"ok": False, "status": resp.status, "error": msg}
        if isinstance(payload, dict):
            if payload.get("success") is False:
                return {"ok": False, "status": resp.status, "error": payload.get("message", "请求失败")}
            if payload.get("code") not in (None, 0, 200):
                return {"ok": False, "status": resp.status, "error": payload.get("message", "请求失败")}
        return {"ok": True, "status": resp.status, "data": payload.get("data", payload)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "status": "err", "error": str(e)}
    finally:
        conn.close()


async def qingteng_query(device: str, path: str, params: Optional[dict] = None,
                         method: str = "GET", body: Optional[dict] = None):
    """Generic 签名请求（异步）。供工具直接调用。"""
    dev = find_device(device)
    auth, err = await asyncio.to_thread(login, dev)
    if err:
        return {"ok": False, "error": err}
    return await asyncio.to_thread(request, dev, method, path, auth, params, body)


async def qingteng_post(device: str, path: str, body: Optional[dict] = None,
                        params: Optional[dict] = None):
    return await qingteng_query(device, path, params, method="POST", body=body)


# ---------- 各模块高层封装（与 SKILL.md 语义路由一一对应） ----------

async def qingteng_assets(device: str = "gongwuyun", resource: str = "host",
                          os_type: Optional[str] = None, filters: Optional[dict] = None,
                          page: int = 0, size: int = 20):
    """资产查询。resource ∈ host/container/vm；filters 为额外 key=value。"""
    path = f"/external/api/assets/{resource}/{os_type}" if os_type else f"/external/api/assets/{resource}"
    q = {"page": page, "size": size, **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_detect(device: str = "gongwuyun", resource: str = "host",
                          os_type: Optional[str] = None, param: Optional[dict] = None,
                          filters: Optional[dict] = None, page: int = 0, size: int = 20):
    """入侵检测查询。resource ∈ process/weakpwd/webshell/...（按 api-reference 映射参数）。"""
    # 示例：resource 作为动作子路径，param 可带 action 等
    action = (param or {}).get("action", "list")
    base = f"/external/api/detect/{resource}/{os_type}" if os_type else f"/external/api/detect/{resource}"
    path = f"{base}/{action}" if action and action != "list" else base
    q = {"page": page, "size": size, **((param or {}).get("extra") or {}), **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_risk(device: str = "gongwuyun", action: str = "weakpwd_list",
                        os_type: str = "linux", filters: Optional[dict] = None,
                        page: int = 0, size: int = 20):
    """风险查询。action ∈ weakpwd_list/risk_list/patch_list/weakfile_list/poc_list。"""
    extra = dict(filters or {})
    if action == "weakpwd_list":
        path = f"/external/api/vul/weakpwd/{os_type}/list"
    elif action == "risk_list":
        risk_type = extra.pop("risk_type", "vul")
        path = f"/external/api/vul/{risk_type}/{os_type}/list"
    elif action == "patch_list":
        path = f"/external/api/vul/patch/{os_type}/list"
    elif action == "weakfile_list":
        path = f"/external/api/websecurity/weakfile/{os_type}"
    elif action == "poc_list":
        path = f"/external/api/vul/poc/{os_type}/list"
    else:
        path = f"/external/api/{action}"
    q = {"page": page, "size": size, **extra}
    return await qingteng_query(device, path, q)


async def qingteng_baseline(device: str = "gongwuyun", os_type: str = "linux",
                            filters: Optional[dict] = None, page: int = 0, size: int = 20):
    """基线核查。"""
    path = f"/external/api/baseline/{os_type}/list"
    q = {"page": page, "size": size, **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_system_audit(device: str = "gongwuyun", os_type: str = "linux",
                                filters: Optional[dict] = None, page: int = 0, size: int = 20):
    """系统审核日志。"""
    path = f"/external/api/sysaudit/{os_type}/list"
    q = {"page": page, "size": size, **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_vul_check(device: str = "gongwuyun", os_type: str = "linux",
                             filters: Optional[dict] = None, page: int = 0, size: int = 20):
    """漏洞核查。"""
    path = f"/external/api/vul/check/{os_type}/list"
    q = {"page": page, "size": size, **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_microseg(device: str = "gongwuyun", action: str = "list",
                            filters: Optional[dict] = None, page: int = 0, size: int = 20):
    """微隔离策略查询。"""
    path = f"/external/api/microseg/{action}"
    q = {"page": page, "size": size, **(filters or {})}
    return await qingteng_query(device, path, q)


async def qingteng_export_all(device: str = "gongwuyun", resource: str = "host",
                              os_type: Optional[str] = None, page_size: int = 500,
                              max_pages: int = 100):
    """批量导出资产（分页拉全量，返回汇总统计）。"""
    results = []
    page = 0
    while page < max_pages:
        res = await qingteng_assets(device, resource, os_type, page=page, size=page_size)
        if not res.get("ok"):
            return {"ok": False, "error": res.get("error")}
        data = res.get("data") or {}
        rows = data.get("rows") or data.get("data") or []
        if not isinstance(rows, list):
            rows = [data]
        results.extend(rows)
        total = data.get("total") if isinstance(data, dict) else None
        if len(rows) < page_size:
            break
        page += 1
        if total is not None and len(results) >= int(total):
            break
    return {"ok": True, "count": len(results), "device": find_device(device).get("name"),
            "resource": resource, "data": results}


async def qingteng_search_component(device: str = "gongwuyun", keyword: str = "",
                                    port: Optional[int] = None, limit: int = 20):
    """按组件关键字检索主机清单（如 redis），返回主机、命中证据与版本摘要。

    返回结构：summary / hosts（含 evidence/version/confidence）/ warnings / has_more。
    结果已按词边界与排除词清洗，不会命中 redisson、redis-cli 等干扰项。
    """
    from types import SimpleNamespace

    from app.core.qingteng_component_search import search_components

    try:
        dev = find_device(device)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    device_obj = SimpleNamespace(
        id=f"env:{dev.get('device_id') or dev.get('name')}",
        name=dev.get("name") or "",
        api_url=dev.get("base_url") or "",
        username=dev.get("username") or "",
        password=dev.get("password") or "",
        timeout=dev.get("timeout") or 30,
        verify_tls=bool(dev.get("verify_ssl", False)),
    )
    try:
        return await asyncio.to_thread(
            search_components, device_obj, keyword, port, limit,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}
