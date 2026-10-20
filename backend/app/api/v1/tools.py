"""工具能力测试路由。

提供对安全上下文查询工具与防火墙封禁能力的 HTTP 调用入口，
既用于阶段二联调验证，也作为后续 Agent 调用工具的示例。
"""
import asyncio
import logging
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import (
    ToolRegistry,
    get_current_user,
    get_tool_registry,
    require_permission,
)
from app.devices.as_tool import resolve_default_block_device
from app.devices.gateway import DeviceGateway, build_idempotency_key

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/tools",
    tags=["tools"],
    dependencies=[Depends(get_current_user)],
)


class BlockIPRequest(BaseModel):
    """封禁 IP 请求体。"""

    ip: str
    duration: str
    reason: str
    device_id: int


@router.get("/query/{ip}")
async def query_ip(
    ip: str,
    registry: ToolRegistry = Depends(get_tool_registry),
) -> dict:
    """并发调用 4 个查询工具，返回聚合结果。

    使用 asyncio.gather 并发执行白名单、资产、威胁情报、子网查询，
    显著降低端到端延迟（受限于最慢的单次调用）。

    Args:
        ip: 路径参数，待查询的 IP 地址。
        registry: 注入的工具注册表单例。

    Returns:
        聚合后的查询结果字典。
    """
    logger.info("收到 IP 综合查询请求, ip=%s", ip)
    whitelist_hit, asset_info, threat_intel, subnet_info = await asyncio.gather(
        registry.check_whitelist(ip),
        registry.get_asset_info(ip),
        registry.get_threat_intel(ip),
        registry.check_subnet(ip),
    )
    result = {
        "ip": ip,
        "whitelist": whitelist_hit,
        "asset": asset_info,
        "threat_intel": threat_intel,
        "subnet": subnet_info,
    }
    logger.info("IP 综合查询完成, ip=%s", ip)
    logger.debug("综合查询结果, ip=%s, result=%s", ip, result)
    return result


@router.post("/block_ip")
async def block_ip(
    body: BlockIPRequest,
    db: Session = Depends(get_db),
    user=Depends(require_permission("device", "edit")),
) -> dict:
    """经设备网关封禁指定设备上的 IP。未指定设备或设备不可用时拒绝。"""
    logger.info(
        "收到封禁 IP 请求, ip=%s, device_id=%s, duration=%s, reason=%s",
        body.ip,
        body.device_id,
        body.duration,
        body.reason,
    )
    res = resolve_default_block_device(
        db,
        SimpleNamespace(variables={"default_device_id": body.device_id}),
        {body.device_id},
    )
    if not res.ok:
        raise HTTPException(status_code=400, detail={"error": res.error, "hint": res.hint})
    params = {"ip": body.ip, "duration": body.duration, "reason": body.reason}
    key = build_idempotency_key(
        source="api",
        device_id=res.device.id,
        action_type="block_ip",
        params=params,
    )
    result = await DeviceGateway.invoke(
        db,
        res.device.id,
        action_id=res.action.id,
        params=params,
        source="api",
        user_id=getattr(user, "id", None),
        idempotency_key=key,
    )
    if isinstance(result, dict) and result.get("error"):
        raise HTTPException(status_code=400, detail=result)
    logger.info("封禁 IP 处理完成, ip=%s", body.ip)
    return result
