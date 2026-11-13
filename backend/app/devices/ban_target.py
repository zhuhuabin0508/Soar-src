"""封禁设备（安博通阻断器）下发 / 解封的公共逻辑。

封禁工作台（导入同步、手动封禁、解封、删除）与到期自动解封等链路统一经本模块
定位设备与动作并执行，避免各链路各自拼装设备调用。

动作定位口径：
- 设备：默认按名称「安博通阻断器」精确匹配，未命中时按厂商名 ``%安博通%`` 兜底；
  记录上指定了「封堵设备」时按名称定位该设备；
- 动作：按 ``action_type``（``block_ip`` / ``unblock_ip``）匹配启用动作。

成功判定：
- 封禁：HTTP < 400 **且** 业务 ``code=1``（下发失败绝不能落「生效中」平台记录）；
- 解封：HTTP < 400，或设备返回 404（条目本就不在设备上，端态目标已达成，
  按幂等成功处理，不阻塞平台解封）。
"""
import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.devices.action_executor import execute_device_action
from app.models.device import Device, DeviceAction

logger = logging.getLogger(__name__)

# 默认封禁设备名（与设备管理播种脚本一致）
DEFAULT_BAN_DEVICE_NAME = "安博通阻断器"

BLOCK_ACTION_TYPE = "block_ip"
UNBLOCK_ACTION_TYPE = "unblock_ip"

# 安博通黑名单生命周期上限：文档约定 age 有效范围 -1~2592000 秒（-1 表示永久）。
# 超上限的时长设备不会报错，而是静默丢弃（返回 code=1 + 空 blist_entry），
# 平台必须在下发前拦截，避免落「生效中」记录但设备上无条目。
MAX_BAN_DURATION_SECONDS = 2592000


def _find_action(db: Session, device: Device, action_type: str):
    """在设备上查找启用的指定类型动作。"""
    action = (
        db.query(DeviceAction)
        .filter(
            DeviceAction.device_id == device.id,
            DeviceAction.action_type == action_type,
            DeviceAction.enabled.is_(True),
        )
        .order_by(DeviceAction.id.asc())
        .first()
    )
    if action is None:
        label = "封禁动作" if action_type == BLOCK_ACTION_TYPE else "解封动作"
        return None, f"设备「{device.name}」未配置启用的{label}（{action_type}）"
    return action, ""


def resolve_default_device(
    db: Session, device_id: Optional[int] = None
):
    """定位默认封禁设备与 block_ip 动作。

    Args:
        device_id: 指定设备 ID；不传时自动定位「安博通阻断器」。

    Returns:
        ``(device, action, error)``；error 非空时不可同步，消息可直接展示给用户。
    """
    q = db.query(Device).filter(Device.enabled.is_(True))
    if device_id:
        device = q.filter(Device.id == device_id).first()
        if device is None:
            return None, None, f"未找到启用的封禁设备（id={device_id}）"
    else:
        device = q.filter(Device.name == DEFAULT_BAN_DEVICE_NAME).order_by(Device.id.asc()).first()
        if device is None:
            device = q.filter(Device.vendor.like("%安博通%")).order_by(Device.id.asc()).first()
        if device is None:
            return None, None, "未找到「安博通阻断器」设备，请先在设备管理中接入并启用"
    action, err = _find_action(db, device, BLOCK_ACTION_TYPE)
    return device, action, err


def resolve_device_by_name(db: Session, name: str):
    """按设备名称定位启用设备及其 block_ip 动作（导入记录指定「封堵设备」）。

    Returns:
        ``(device, action, error)``。
    """
    name = (name or "").strip()
    device = (
        db.query(Device)
        .filter(Device.enabled.is_(True), Device.name == name)
        .order_by(Device.id.asc())
        .first()
    )
    if device is None:
        return None, None, f"未找到启用的封堵设备「{name}」，请检查设备管理中是否已接入并启用"
    action, err = _find_action(db, device, BLOCK_ACTION_TYPE)
    return device, action, err


def resolve_device_for_record(
    db: Session,
    record,
    default_device,
    default_action,
    default_error,
    cache: dict[str, tuple],
):
    """按记录上的「封堵设备」定位执行设备；未指定时用默认设备。

    同一请求内用 ``cache`` 复用同名设备的查询结果，避免逐条重复查库。
    注意：请求参数只决定「未指定设备的记录」走哪台设备，不会覆盖记录级配置。
    """
    name = (record.ban_device or "").strip()
    if not name:
        return default_device, default_action, default_error
    if default_device is not None and name == default_device.name:
        return default_device, default_action, default_error
    if name not in cache:
        cache[name] = resolve_device_by_name(db, name)
    return cache[name]


def resolve_unblock_device(db: Session, device_name: Optional[str]):
    """定位解封设备与 unblock_ip 动作。

    优先使用记录上的封禁设备名（与该封禁实际下发设备一致）；未记录设备名时
    回退默认「安博通阻断器」。

    Returns:
        ``(device, action, error)``；设备不存在 / 已禁用 / 未配置解封动作时 error 非空。
    """
    name = (device_name or "").strip()
    if name:
        device = (
            db.query(Device)
            .filter(Device.name == name)
            .order_by(Device.enabled.desc(), Device.id.asc())
            .first()
        )
        if device is None:
            return None, None, f"未找到封禁设备「{name}」，无法联动解封"
        if not device.enabled:
            return device, None, f"设备「{device.name}」已禁用，无法联动解封"
    else:
        device, _block_action, err = resolve_default_device(db)
        if err:
            return None, None, err
    action, err = _find_action(db, device, UNBLOCK_ACTION_TYPE)
    return device, action, err


def run_block(
    db: Session,
    device: Device,
    action: DeviceAction,
    *,
    ip: str,
    duration_seconds: int = 0,
    reason: str = "",
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """下发封禁（时长 0 表示永久，由动作 ``map_values`` 转换）。"""
    duration_seconds = int(duration_seconds or 0)
    # 时长超设备上限直接拦截：安博通对超限 age 静默丢弃（code=1 但不建条目），
    # 提前校验把问题暴露给调用方，而不是落一条设备上不存在的「生效中」记录。
    if 0 < duration_seconds > MAX_BAN_DURATION_SECONDS:
        days = MAX_BAN_DURATION_SECONDS // 86400
        over_days = -(-duration_seconds // 86400)  # 向上取整，避免 30 天+1 秒显示成 30 天
        return {
            "success": False,
            "error": (
                f"封禁时长 {over_days} 天超过设备上限 {days} 天"
                f"（安博通黑名单生命周期最长 {MAX_BAN_DURATION_SECONDS} 秒），请缩短时长或改为永久封禁"
            ),
        }
    params: dict[str, Any] = {
        "ip": str(ip or "").strip(),
        "duration": "0" if not duration_seconds else str(duration_seconds),
    }
    if reason:
        params["reason"] = str(reason)
    return execute_device_action(
        device, action, params, db=db, source=source,
        user_id=user_id, source_ip=source_ip,
    )


def run_unblock(
    db: Session,
    device: Device,
    action: DeviceAction,
    *,
    ip: str,
    source: str = "api",
    user_id: Optional[int] = None,
    source_ip: Optional[str] = None,
) -> dict[str, Any]:
    """下发解封。

    同时传 ``ip`` 与 ``blist``：不同厂商动作模板可能引用任一占位符
    （安博通删除黑名单使用路径参数 ``{blist}``），未引用的参数不会进入请求。
    """
    params: dict[str, Any] = {
        "ip": str(ip or "").strip(),
        "blist": str(ip or "").strip(),
    }
    return execute_device_action(
        device, action, params, db=db, source=source,
        user_id=user_id, source_ip=source_ip,
    )


def check_block_result(result: dict[str, Any]) -> tuple[bool, str]:
    """封禁结果判定：HTTP 成功且业务 code=1（安博通约定）。"""
    if not result.get("success"):
        err = str(result.get("error") or "设备调用失败")
        if result.get("status_code"):
            err = f"{err}（HTTP {result.get('status_code')}）"
        return False, err
    body = result.get("response_body")
    if isinstance(body, dict) and body.get("code") is not None:
        if str(body.get("code")) != "1":
            msg = body.get("msg")
            detail = f"设备业务失败: code={body.get('code')}"
            if msg:
                detail = f"{detail}，msg={msg}"
            return False, detail
        # 安博通对部分非法参数（如 age 超上限）不报错而是静默丢弃：
        # 返回 code=1 且 data.blist_entry 为空串，此时设备并未真正建条目，
        # 必须判定为失败，否则平台会落一条设备上不存在的「生效中」记录。
        data = body.get("data")
        if isinstance(data, dict) and "blist_entry" in data:
            if data.get("blist_entry") in ("", None):
                return False, "设备返回了空黑名单条目（未实际创建，请检查参数是否超出设备允许范围）"
    return True, ""


def check_unblock_result(result: dict[str, Any]) -> tuple[bool, str]:
    """解封结果判定：只看 HTTP 层（条目可能本就不在设备上）。

    设备对黑名单中不存在的条目返回 404（重复解封/到期已清理/控制台已删），
    端态目标已达成，按幂等成功处理；否则平台记录会永远卡在「生效中」，
    与设备侧实际状态不一致。与安博通黑名单行内解封的 404 口径保持一致。
    """
    if not result.get("success"):
        if result.get("status_code") == 404:
            return True, ""
        err = str(result.get("error") or "设备调用失败")
        if result.get("status_code"):
            err = f"{err}（HTTP {result.get('status_code')}）"
        return False, err
    return True, ""


def extract_record_id(body: Any) -> str:
    """从设备响应体提取可回查的记录标识（用于平台 ``record_id``）。

    兼容 ``data`` 为对象 / 标量 / 缺失，以及 ``record_id`` / ``id`` / ``blist`` 等键；
    无法识别时返回空串（不把整个字典 repr 写进 64 字符字段）。
    """
    if not isinstance(body, dict):
        return ""
    candidates: list[Any] = []
    data = body.get("data")
    if isinstance(data, dict):
        for key in ("record_id", "id", "blist_id", "blist"):
            value = data.get(key)
            if value not in (None, "", [], {}):
                candidates.append(value)
    elif isinstance(data, (str, int, float)) and not isinstance(data, bool):
        candidates.append(data)
    for key in ("record_id", "id"):
        value = body.get(key)
        if value not in (None, "", [], {}):
            candidates.append(value)
    if not candidates:
        return ""
    return str(candidates[0])[:64]


def summarize_response(result: dict[str, Any]) -> str:
    """设备响应体 → 审计/legacy 展示用文本（截断 4000 字符）。"""
    import json

    body = result.get("response_body")
    try:
        return json.dumps(body, ensure_ascii=False, default=str)[:4000]
    except Exception:  # noqa: BLE001
        return str(body)[:4000]
