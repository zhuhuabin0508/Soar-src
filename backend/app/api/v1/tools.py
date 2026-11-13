"""工具能力测试路由。

提供对安全上下文查询工具与防火墙封禁能力的 HTTP 调用入口，
既用于阶段二联调验证，也作为后续 Agent 调用工具的示例。
"""
import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import (
    FirewallDevice,
    ToolRegistry,
    get_current_user,
    get_firewall_device,
    get_tool_registry,
    require_permission,
)

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


@router.get(
    "/query/{ip}",
    dependencies=[Depends(require_permission("tool", "view"))],
)
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


@router.post(
    "/block_ip",
    dependencies=[Depends(require_permission("tool", "execute"))],
)
async def block_ip(
    body: BlockIPRequest,
    firewall: FirewallDevice = Depends(get_firewall_device),
) -> dict:
    """调用防火墙封禁指定 IP。

    封禁为幂等操作，重复调用同一 IP 不会产生副作用。

    Args:
        body: 封禁请求体，含 ip/duration/reason。
        firewall: 注入的防火墙设备单例。

    Returns:
        封禁结果字典。
    """
    logger.info(
        "收到封禁 IP 请求, ip=%s, duration=%s, reason=%s",
        body.ip,
        body.duration,
        body.reason,
    )
    result = await firewall.block_ip_on_firewall(
        ip=body.ip, duration=body.duration, reason=body.reason
    )
    logger.info("封禁 IP 处理完成, ip=%s", body.ip)
    return result
