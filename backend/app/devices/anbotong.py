"""安博通阻断器（黑名单）统一对接层。

工单封禁同步、工单封禁状态查询、封禁工作台（黑名单拉取 / 手动封禁 / 解封）
等业务链路统一经本模块调用安博通阻断器的黑名单动作，避免各处自行拼设备调用。

动作定位（与 scripts/seed_anbotong_device.py 播种的动作一一对应）：
- 封禁 IP（加入黑名单）  block_ip    POST    /Objects/Blacklist
- 解封 IP（删除黑名单）  unblock_ip  DELETE  /Objects/Blacklist/blist/{blist}
- 查询黑名单列表         custom      GET     /Objects/Blacklist
- 查询指定黑名单         custom      GET     /Objects/Blacklist/blist/{blist}

优先按动作名称精确定位；动作被重命名时按 action_type / (http_method + api_path)
兜底，保证只要动作配置还在，链路仍然可用。

调用语义：
- 封禁：HTTP < 400 且业务 code=1 才算成功（下发失败绝不能落「生效中」记录）；
- 解封：HTTP < 400 即算成功（条目可能本就不在设备上，端态目标已达成）；
- 查询：HTTP < 400 时解析 data（列表 / 单条），data 为空视为未命中（code!=1
  时把设备 msg 放进 note，一并展示给用户）；设备对不存在的条目返回
  HTTP 404，视为业务结果「未查到该 IP（未封禁）」，不当作查询失败；
- 查询类调用不写 DeviceCallLog（工作台 30 秒轮询会产生大量日志），封禁 / 解封
  正常写调用日志（source 标记业务链路）。
"""
import ipaddress
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.devices.action_executor import execute_device_action
from app.devices.ban_target import MAX_BAN_DURATION_SECONDS
from app.models.device import Device, DeviceAction

logger = logging.getLogger(__name__)

# 安博通阻断器设备名（与播种脚本一致）；名称对不上时按厂商名兜底
ANBOTONG_DEVICE_NAME = "安博通阻断器"

# 批量黑名单查询的单次超时上限（秒）：工单封禁查询一次最多 20 个 IP 并发下发，
# 设备默认 30s 超时会让页面等待过久，这里收敛到 10s
QUERY_TIMEOUT_CAP_SECONDS = 10

# 黑名单列表单页条数：工作台面板要展示设备当前全部条目，分页动作默认拉一大页；
# 设备侧条数超出时会按自身上限返回，不会报错
LIST_PAGE_SIZE = 1000

# 动作规格：name 精确匹配优先；action_type / (http_method, api_path) 兜底
_ACTION_SPECS: dict[str, dict[str, Optional[str]]] = {
    "block": {
        "name": "封禁 IP（加入黑名单）",
        "action_type": "block_ip",
        "http_method": "POST",
        "api_path": "/Objects/Blacklist",
    },
    "unblock": {
        "name": "解封 IP（删除黑名单）",
        "action_type": "unblock_ip",
        "http_method": "DELETE",
        "api_path": "/Objects/Blacklist/blist/{blist}",
    },
    "list": {
        "name": "查询黑名单列表",
        "action_type": None,
        "http_method": "GET",
        "api_path": "/Objects/Blacklist",
    },
    "query": {
        "name": "查询指定黑名单",
        "action_type": None,
        "http_method": "GET",
        "api_path": "/Objects/Blacklist/blist/{blist}",
    },
    # ===== 全局白名单（GlobalWhitelist）=====
    "whitelist_list": {
        "name": "查询全局白名单列表",
        "action_type": None,
        "http_method": "GET",
        "api_path": "/Objects/GlobalWhitelist?page={page}&count={count}",
    },
    "whitelist_create": {
        "name": "新建全局白名单",
        "action_type": None,
        "http_method": "POST",
        "api_path": "/Objects/GlobalWhitelist",
    },
    "whitelist_batch_create": {
        "name": "批量新建全局白名单",
        "action_type": None,
        "http_method": "POST",
        "api_path": "/Objects/GlobalWhitelistBatch",
    },
    "whitelist_delete": {
        "name": "删除全局白名单",
        "action_type": None,
        "http_method": "DELETE",
        "api_path": "/Objects/GlobalWhitelist/wlist/{wlist}",
    },
}


def find_anbotong_device(db: Session) -> tuple[Optional[Device], Optional[str]]:
    """查找安博通阻断器设备（启用优先）。

    Returns:
        (device, error) 二元组：device 为 None 时 error 描述原因。
    """
    device = (
        db.query(Device)
        .filter(Device.name == ANBOTONG_DEVICE_NAME)
        .order_by(Device.enabled.desc(), Device.id.asc())
        .first()
    )
    if device is None:
        # 兜底：设备被重命名时按厂商名匹配
        device = (
            db.query(Device)
            .filter(Device.vendor.like(f"%安博通%"))
            .order_by(Device.enabled.desc(), Device.id.asc())
            .first()
        )
    if device is None:
        return None, f"未找到名为「{ANBOTONG_DEVICE_NAME}」的设备，请先在设备管理中接入"
    if not device.enabled:
        return None, f"设备「{device.name}」已禁用，请先在设备管理中启用"
    return device, None


def find_anbotong_action(
    db: Session, kind: str
) -> tuple[Optional[Device], Optional[DeviceAction], Optional[str]]:
    """查找安博通阻断器的指定动作。

    Args:
        db: 数据库会话。
        kind: block / unblock / list / query / whitelist_list /
            whitelist_create / whitelist_batch_create / whitelist_delete。

    Returns:
        (device, action, error) 三元组：action 为 None 时 error 描述原因。
    """
    device, err = find_anbotong_device(db)
    if err:
        return None, None, err
    spec = _ACTION_SPECS.get(kind)
    if spec is None:
        raise ValueError(f"未知的安博通动作类型: {kind}")
    base = db.query(DeviceAction).filter(
        DeviceAction.device_id == device.id, DeviceAction.enabled.is_(True)
    )
    action = base.filter(DeviceAction.name == spec["name"]).first()
    if action is None and spec.get("action_type"):
        action = base.filter(DeviceAction.action_type == spec["action_type"]).first()
    if action is None:
        action = base.filter(
            DeviceAction.http_method == spec["http_method"],
            DeviceAction.api_path == spec["api_path"],
        ).first()
    if action is None:
        return device, None, f"设备「{device.name}」未配置启用的「{spec['name']}」动作"
    return device, action, None


def _result(
    *,
    success: bool,
    error: Optional[str] = None,
    status_code: Optional[int] = None,
    response_body: Any = None,
    device: Optional[dict] = None,
    action: Optional[dict] = None,
    **extra,
) -> dict[str, Any]:
    """统一结果结构：success / error / status_code / response_body / device / action + 扩展字段。"""
    out = {
        "success": success,
        "error": error,
        "status_code": status_code,
        "response_body": response_body,
        "device": device,
        "action": action,
    }
    out.update(extra)
    return out


def _device_info(device: Optional[Device]) -> Optional[dict]:
    return {"id": device.id, "name": device.name} if device else None


def _run_action(
    db: Session,
    kind: str,
    params: dict[str, Any],
    *,
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
    timeout: Optional[float] = None,
    skip_log: bool = False,
    strict_code: bool = True,
    resolved: Optional[tuple[Device, DeviceAction]] = None,
) -> dict[str, Any]:
    """定位动作并执行，返回统一结果结构。

    strict_code=True 时响应体含 code 且 code!=1 视为业务失败（封禁 / 列表查询）；
    False 时只看 HTTP 层（解封 / 单条查询，业务码放 note 里提示）。
    resolved: 调用方已定位好的 (device, action)，跳过内部查找（避免重复查库）。
    """
    if resolved is not None:
        device, action = resolved
    else:
        device, action, err = find_anbotong_action(db, kind)
        if err:
            return _result(success=False, error=err)
    result = execute_device_action(
        device,
        action,
        params,
        timeout,
        db=None if skip_log else db,
        source=source,
        user_id=user_id,
        source_ip=source_ip,
        skip_log=skip_log,
    )
    body = result.get("response_body")
    note = None
    error = result.get("error")
    success = bool(result.get("success"))
    if success and isinstance(body, dict) and body.get("code") is not None:
        if str(body.get("code")) != "1":
            note = f"设备返回: code={body.get('code')}, msg={body.get('msg')}"
            if strict_code:
                success = False
                error = note
        elif strict_code:
            # 安博通对部分非法参数（如 age 超上限）静默丢弃：code=1 但
            # data.blist_entry 为空串，条目并未真正创建，必须判定失败
            data = body.get("data")
            if isinstance(data, dict) and data.get("blist_entry") in ("", None):
                success = False
                error = "设备返回了空黑名单条目（未实际创建，请检查参数是否超出设备允许范围）"
    out = _result(
        success=success,
        error=error,
        status_code=result.get("status_code"),
        response_body=body,
        device=_device_info(device),
        action={"id": action.id, "name": action.name},
    )
    if note is not None:
        out["note"] = note
    return out


def block_ip_on_anbotong(
    db: Session,
    ip: str,
    *,
    duration_seconds: int = 0,
    reason: str = "",
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
    skip_log: bool = False,
) -> dict[str, Any]:
    """通过「封禁 IP（加入黑名单）」动作把封禁下发到安博通阻断器。

    Args:
        db: 数据库会话（查设备/动作 + 写调用日志）。
        ip: 封禁目标（单 IP / CIDR / 范围 / 多值，业务层已校验）。
        duration_seconds: 封禁时长（秒）；0 表示永久（动作 map_values 自动转 -1）。
        reason: 封禁原因（可选，不传时用动作默认「API添加」）。
        source/user_id/source_ip: 审计归属。

    Returns:
        统一结果结构；success=False 时 error 描述失败原因。
    """
    duration_seconds = int(duration_seconds or 0)
    # 时长超设备上限直接拦截（安博通 age 上限 2592000 秒，超限静默丢弃不建条目）
    if 0 < duration_seconds > MAX_BAN_DURATION_SECONDS:
        days = MAX_BAN_DURATION_SECONDS // 86400
        over_days = -(-duration_seconds // 86400)  # 向上取整，避免 30 天+1 秒显示成 30 天
        return _result(
            success=False,
            error=(
                f"封禁时长 {over_days} 天超过设备上限 {days} 天"
                f"（安博通黑名单生命周期最长 {MAX_BAN_DURATION_SECONDS} 秒），请缩短时长或改为永久封禁"
            ),
        )
    params: dict[str, Any] = {
        "ip": str(ip or "").strip(),
        "duration": str(duration_seconds),
    }
    if reason:
        params["reason"] = str(reason)
    logger.info(
        "安博通封禁下发: ip=%s, duration=%ss, source=%s",
        ip, duration_seconds, source,
    )
    return _run_action(
        db, "block", params, source=source, user_id=user_id,
        source_ip=source_ip, skip_log=skip_log, strict_code=True,
    )


def unblock_ip_on_anbotong(
    db: Session,
    ip: str,
    *,
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
    skip_log: bool = False,
) -> dict[str, Any]:
    """通过「解封 IP（删除黑名单）」动作从安博通阻断器移除封禁。

    成功判定只看 HTTP 层：条目可能本就不在设备上（如历史记录 / 设备侧已手动
    删除），此时端态目标已达成，不应阻塞平台侧解封。
    """
    params = {"blist": str(ip or "").strip()}
    logger.info("安博通解封下发: ip=%s, source=%s", ip, source)
    return _run_action(
        db, "unblock", params, source=source, user_id=user_id,
        source_ip=source_ip, skip_log=skip_log, strict_code=False,
    )


def list_blacklist_on_anbotong(
    db: Session,
    *,
    page: int = 1,
    count: int = LIST_PAGE_SIZE,
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """通过「查询黑名单列表」动作分页拉取设备黑名单条目。

    动作 api_path 含分页占位符（{page}/{count}）时按传入页码/页大小请求设备；
    无占位符（不分页的设备接口）时忽略 page/count 一次拉全量。

    设备响应不含总条数字段，总页数不可知：page_full（本页是否满页）供调用方
    判定「还有下一页」；页码翻过末页时设备返回 HTTP 404，这里容错为空页
    （beyond_end=True），避免面板翻页越界时报错。

    Returns:
        统一结果结构 + items（本页条目，每条含设备返回的全部字段）/ page /
        count / page_full / paginated（动作是否分页）/ fetched_at。
    """
    device, action, err = find_anbotong_action(db, "list")
    if err:
        return _result(success=False, error=err)
    api_path = action.api_path or ""
    paginated = "{page}" in api_path or "{count}" in api_path
    params: dict[str, Any] = {}
    if paginated:
        params["page"] = str(max(1, int(page)))
        params["count"] = str(max(1, int(count)))
    result = _run_action(
        db, "list", params, source=source, user_id=user_id,
        source_ip=source_ip, skip_log=True, strict_code=True,
        resolved=(device, action),
    )
    # 页码超出范围：设备对翻过末页的请求返回 404，容错为空页（非分页动作不受影响）
    beyond_end = (
        paginated
        and not result["success"]
        and (result.get("status_code") == 404)
    )
    if beyond_end:
        result.update(success=True, error=None, note="页码超出设备黑名单范围")
    items: list[dict] = []
    body = result.get("response_body")
    if result["success"] and isinstance(body, dict):
        data = body.get("data")
        if isinstance(data, list):
            items = [x for x in data if isinstance(x, dict)]
        elif isinstance(data, dict) and data:
            items = [data]  # 容错：设备把单对象按对象返回
    result["items"] = items
    result["page"] = max(1, int(page))
    result["count"] = max(1, int(count))
    # 本页满页 → 可能还有下一页（设备无总数字段，无法精确判定总页数）
    result["page_full"] = paginated and len(items) >= max(1, int(count))
    result["paginated"] = paginated
    result["fetched_at"] = beijing_now().isoformat()
    return result


def query_blacklist_entry(
    device: Device,
    action: DeviceAction,
    ip: str,
    *,
    timeout: Optional[float] = None,
) -> dict[str, Any]:
    """对已定位的设备/动作执行单条黑名单查询（不查库、不写日志，可并发调用）。

    供工单封禁状态批量查询使用：设备/动作只定位一次，N 个 IP 并发执行。
    """
    params = {"blist": str(ip or "").strip()}
    result = execute_device_action(device, action, params, timeout, db=None, skip_log=True)
    body = result.get("response_body")
    entry: Optional[dict] = None
    note = None
    success = bool(result.get("success"))
    error = result.get("error")
    status_code = result.get("status_code")
    # 设备「查询指定黑名单」对不存在的条目返回 HTTP 404：这是业务结果
    # （IP 未封禁、黑名单中无此条目），并非网络不通等异常，不作为查询失败展示
    if not success and status_code == 404:
        success = True
        error = None
        note = "设备返回 404：黑名单中未找到该 IP"
    if success and isinstance(body, dict):
        if note is None and body.get("code") is not None and str(body.get("code")) != "1":
            note = f"设备返回: code={body.get('code')}, msg={body.get('msg')}"
        data = body.get("data")
        if isinstance(data, dict) and data:
            entry = data
        elif isinstance(data, list) and data and isinstance(data[0], dict):
            entry = data[0]
    # 设备单条查询接口不返回 leftTime（剩余时长）：按 生效时间 + 封禁时长 - 当前时间
    # 补算（设备与平台同时区，口径已用列表接口权威值验证）；永久条目（age<0）补 -1
    # 与列表口径一致；解析失败保持缺失，前端显示 --
    if isinstance(entry, dict) and entry.get("leftTime") in (None, ""):
        try:
            age_s = int(float(str(entry.get("age"))))
        except (TypeError, ValueError):
            age_s = None
        if age_s is not None and age_s < 0:
            entry["leftTime"] = -1
        elif age_s is not None and entry.get("effectTime"):
            try:
                eff = datetime.fromisoformat(str(entry["effectTime"]).replace("T", " ").strip())
                entry["leftTime"] = max(0, int((eff + timedelta(seconds=age_s) - beijing_now().replace(tzinfo=None)).total_seconds()))
            except ValueError:
                pass
    return _result(
        success=success,
        error=error,
        status_code=status_code,
        response_body=body,
        device=_device_info(device),
        action={"id": action.id, "name": action.name},
        found=entry is not None,
        entry=entry,
        note=note,
    )


def query_blacklist_on_anbotong(
    db: Session,
    ip: str,
    *,
    source: str = "api",
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    """通过「查询指定黑名单」动作查询单个 IP 的设备侧封禁信息（单条便捷入口）。"""
    device, action, err = find_anbotong_action(db, "query")
    if err:
        return _result(success=False, error=err)
    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    return query_blacklist_entry(device, action, ip, timeout=timeout)


# ======================================================================
# 全局白名单（GlobalWhitelist）
# ======================================================================
# 设备批量新建接口单次上限（文档：wlist_entry 1~100 项）
WHITELIST_BATCH_LIMIT = 100
# 白名单生命周期设备上限（秒），与黑名单一致
MAX_WHITELIST_AGE_SECONDS = MAX_BAN_DURATION_SECONDS


def fetch_whitelist_page(
    device: Device,
    action: DeviceAction,
    page: int,
    count: int,
    *,
    timeout: float,
    source: str = "sync",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> tuple[dict[str, Any], list[dict], bool]:
    """拉取单页设备白名单（不做 DB 操作，可安全在线程池中并发调用）。

    设备对「白名单为空 / 页码超出末页」返回 HTTP 404：统一容错为空页，
    beyond_end=True 表示已到末页。

    Returns:
        (统一结果结构, 条目列表, 是否已到末页)。
    """
    api_path = action.api_path or ""
    paginated = "{page}" in api_path or "{count}" in api_path
    params: dict[str, Any] = {}
    if paginated:
        params["page"] = str(max(1, int(page)))
        params["count"] = str(max(1, int(count)))
    result = execute_device_action(
        device, action, params, timeout=timeout, source=source,
        user_id=user_id, source_ip=source_ip, db=None, skip_log=True,
    )
    beyond_end = (
        paginated
        and not result["success"]
        and result.get("status_code") == 404
    )
    if beyond_end:
        result.update(success=True, error=None, note="白名单为空或页码超出范围")
    items: list[dict] = []
    body = result.get("response_body")
    if result["success"] and isinstance(body, dict):
        data = body.get("data")
        if isinstance(data, list):
            items = [x for x in data if isinstance(x, dict)]
        elif isinstance(data, dict) and data:
            items = [data]  # 容错：设备把单对象按对象返回
    return result, items, beyond_end


def list_whitelist_on_anbotong(
    db: Session,
    *,
    page: int = 1,
    count: int = LIST_PAGE_SIZE,
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """通过「查询全局白名单列表」动作分页拉取设备白名单。

    设备响应不含总条数：page_full（本页是否满页）用于判定是否还有下一页；
    白名单为空或页码翻过末页时设备返回 HTTP 404，这里统一容错为空页
    （beyond_end=True），不视为拉取失败。

    Returns:
        统一结果结构 + items / page / count / page_full / paginated / fetched_at。
    """
    device, action, err = find_anbotong_action(db, "whitelist_list")
    if err:
        return _result(success=False, error=err)
    page = max(1, int(page))
    count = max(1, int(count))
    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    result, items, beyond_end = fetch_whitelist_page(
        device, action, page, count, timeout=timeout,
        source=source, user_id=user_id, source_ip=source_ip,
    )
    result["items"] = items
    result["page"] = page
    result["count"] = count
    result["page_full"] = (not beyond_end) and len(items) >= count
    result["paginated"] = True
    result["fetched_at"] = beijing_now().isoformat()
    return result


def _normalize_whitelist_wlist(value: Any) -> str:
    """规范化白名单条目：IP 用压缩形式，域名去尾点并转小写。"""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return ipaddress.ip_address(text).compressed
    except ValueError:
        return text.rstrip(".").lower()


def _parse_batch_create_results(
    body: Any, entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """解析批量新建响应中的逐项结果（HTTP 207 部分失败时外层 code 仍为 1）。"""
    data = body.get("data") if isinstance(body, dict) else None
    raw_results = data.get("results") if isinstance(data, dict) else None
    results: list[dict[str, Any]] = []
    if isinstance(raw_results, list) and raw_results:
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            index = item.get("index")
            wlist = item.get("wlist")
            if not wlist and isinstance(index, int) and 0 <= index < len(entries):
                wlist = entries[index]["wlist"]
            status = item.get("status")
            ok = isinstance(status, int) and 200 <= status < 300
            results.append({
                "wlist": _normalize_whitelist_wlist(wlist),
                "success": ok,
                "status": status,
                "message": item.get("message") or ("Success" if ok else "失败"),
            })
    elif isinstance(body, dict) and str(body.get("code")) == "1":
        # 设备未返回逐项结果但整体成功：按全部成功处理
        results = [
            {"wlist": e["wlist"], "success": True, "status": 200, "message": "Success"}
            for e in entries
        ]
    # 未返回结果的尾部条目（total > processed 表示设备未处理完）视为未执行
    returned = {r["wlist"] for r in results}
    for entry in entries:
        if entry["wlist"] not in returned:
            results.append({
                "wlist": entry["wlist"],
                "success": False,
                "status": None,
                "message": "设备未返回该条目的执行结果（批量未处理）",
            })
    return results


def create_whitelist_entries_on_anbotong(
    db: Session,
    entries: list[dict[str, Any]],
    *,
    source: str = "workbench",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """向安博通阻断器新增全局白名单（1 条走单条接口，多条走批量接口）。

    Args:
        entries: 已校验的条目列表，每项含 wlist / age / enable / reason。
        source/user_id/source_ip: 审计归属。

    Returns:
        统一结果结构 + results（逐条成功/失败明细）/ created_count。
    """
    clean = [{
        "wlist": _normalize_whitelist_wlist(e.get("wlist")),
        "age": int(e.get("age")),
        "enable": int(e.get("enable")),
        "reason": str(e.get("reason") or ""),
    } for e in entries]
    if not clean:
        return _result(success=False, error="白名单条目不能为空")
    if len(clean) > WHITELIST_BATCH_LIMIT:
        return _result(
            success=False,
            error=f"单次最多新增 {WHITELIST_BATCH_LIMIT} 条（设备批量接口上限）",
        )

    if len(clean) == 1:
        entry = clean[0]
        result = _run_action(
            db, "whitelist_create", dict(entry), source=source,
            user_id=user_id, source_ip=source_ip, strict_code=True,
        )
        results = [{
            "wlist": entry["wlist"],
            "success": bool(result["success"]),
            "status": result.get("status_code"),
            "message": result.get("error") or "Success",
        }]
    else:
        result = _run_action(
            db, "whitelist_batch_create", {"wlist_entry": clean}, source=source,
            user_id=user_id, source_ip=source_ip, strict_code=False,
        )
        if result.get("status_code") in (200, 207):
            results = _parse_batch_create_results(result.get("response_body"), clean)
            # 外层业务码非 1 时设备未执行任何条目
            body = result.get("response_body")
            if isinstance(body, dict) and body.get("code") is not None and str(body.get("code")) != "1":
                msg = f"设备返回: code={body.get('code')}, msg={body.get('msg')}"
                results = [
                    {"wlist": e["wlist"], "success": False, "status": result.get("status_code"), "message": msg}
                    for e in clean
                ]
        else:
            error = result.get("error") or f"HTTP {result.get('status_code')}"
            results = [
                {"wlist": e["wlist"], "success": False, "status": result.get("status_code"), "message": error}
                for e in clean
            ]

    created = sum(1 for r in results if r["success"])
    failed = [r for r in results if not r["success"]]
    return _result(
        success=not failed,
        error=None if not failed else f"{len(failed)} 条新增失败",
        status_code=result.get("status_code"),
        response_body=result.get("response_body"),
        device=result.get("device"),
        action=result.get("action"),
        results=results,
        created_count=created,
        failed_count=len(failed),
    )


def delete_whitelist_entries_on_anbotong(
    db: Session,
    wlists: list[str],
    *,
    source: str = "workbench",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """从安博通阻断器删除全局白名单条目（设备无批量删除接口，逐条执行）。

    设备对不存在的条目返回 404：目标端态已达成，按幂等成功处理。
    单条失败不中断其余条目，逐条返回结果。

    Returns:
        统一结果结构 + results（逐条成功/失败明细）/ deleted_count。
    """
    targets = [_normalize_whitelist_wlist(w) for w in wlists if str(w or "").strip()]
    if not targets:
        return _result(success=False, error="白名单条目不能为空")
    if len(targets) > WHITELIST_BATCH_LIMIT:
        return _result(
            success=False,
            error=f"单次最多删除 {WHITELIST_BATCH_LIMIT} 条",
        )
    device, action, err = find_anbotong_action(db, "whitelist_delete")
    if err:
        return _result(success=False, error=err)
    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    results: list[dict[str, Any]] = []
    last_status = None
    for target in targets:
        result = _run_action(
            db, "whitelist_delete", {"wlist": target}, source=source,
            user_id=user_id, source_ip=source_ip, strict_code=False,
            resolved=(device, action), timeout=timeout,
        )
        last_status = result.get("status_code")
        already_absent = (not result["success"]) and last_status == 404
        ok = bool(result["success"]) or already_absent
        results.append({
            "wlist": target,
            "success": ok,
            "status": last_status,
            "message": (
                "条目已不存在（按删除成功处理）" if already_absent
                else (result.get("error") or "Success")
            ),
        })
    deleted = sum(1 for r in results if r["success"])
    failed = [r for r in results if not r["success"]]
    return _result(
        success=not failed,
        error=None if not failed else f"{len(failed)} 条删除失败",
        status_code=last_status,
        device=_device_info(device),
        action={"id": action.id, "name": action.name},
        results=results,
        deleted_count=deleted,
        failed_count=len(failed),
    )
