"""封禁工具调用封装。

契约：``POST {BAN_BASE_URL}/ban/record-ban``
请求体 ``{"ip", "ban_level", "ban_duration", "is_permanent", "reason", "region"}``；
响应体 ``{"success": true, "record_id": "..."}``。

失败重试 3 次，仍失败抛 BanCallError（由引擎转入异常处理节点）。
"""
import json
import logging
import os
import time
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

# mock 封禁工具地址（默认指向本进程内置 mock）
BAN_BASE_URL = os.environ.get("BAN_TOOL_BASE_URL", "http://127.0.0.1:8000/api/v1/internal")
BAN_TIMEOUT_SECONDS = 30
BAN_MAX_ATTEMPTS = 4  # 1 次原始调用 + 3 次重试


class BanCallError(Exception):
    """封禁工具调用失败。"""


def record_ban(
    ip: str,
    ban_plan: dict[str, Any],
) -> str:
    """下发封禁并返回封禁工具记录 ID。

    Args:
        ip: 待封禁 IP。
        ban_plan: 智能体输出的封禁方案（ban_level/ban_duration/is_permanent/reason/region）。

    Returns:
        封禁工具返回的 record_id。

    Raises:
        BanCallError: 封禁目标不合法，或重试耗尽仍失败。
    """
    # 封禁目标硬拦截：单 IP / CIDR / 范围 / 多值（与人工封禁同一套规则），
    # 避免告警字段脏数据（如 "N/A"、主机名）被下发到封禁工具。
    from app.core.ip_validation import IPValidationError, validate_ban_target

    ip = str(ip or "").strip()
    if not ip:
        raise BanCallError("封禁目标为空")
    try:
        ip = validate_ban_target(ip, "封禁目标")
    except IPValidationError as exc:
        raise BanCallError(f"封禁目标不合法: {exc}") from exc
    request_body = {
        "ip": ip,
        "ban_level": ban_plan.get("ban_level") or "medium",
        "ban_duration": ban_plan.get("ban_duration") or 3600,
        "is_permanent": bool(ban_plan.get("is_permanent")),
        "reason": ban_plan.get("reason") or "",
        "region": ban_plan.get("region") or "",
    }
    last_error = ""
    for attempt in range(1, BAN_MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(
                f"{BAN_BASE_URL}/ban/record-ban",
                json=request_body,
                timeout=BAN_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            body = resp.json()
            if not body.get("success"):
                raise BanCallError(f"封禁工具返回失败: {json.dumps(body, ensure_ascii=False)[:300]}")
            record_id = str(body.get("record_id") or "")
            logger.info("封禁下发成功: ip=%s record_id=%s", ip, record_id)
            return record_id
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)[:500]
            logger.warning("封禁下发失败(第 %d/%d 次) ip=%s: %s", attempt, BAN_MAX_ATTEMPTS, ip, last_error)
            if attempt < BAN_MAX_ATTEMPTS:
                time.sleep(min(2 ** attempt, 5))
    raise BanCallError(f"封禁下发失败（已重试 {BAN_MAX_ATTEMPTS} 次）: {last_error}")
