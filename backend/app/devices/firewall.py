"""旧防火墙内存封禁已停用。block_ip_on_firewall 只返回错误，不修改设备。"""
import logging

logger = logging.getLogger(__name__)

# 模拟防火墙已封禁 IP 列表（内存态）
_blocked_ips: set[str] = set()


async def block_ip_on_firewall(ip: str, duration: str, reason: str) -> dict:
    """旧内存封禁已停用。调用不会改变设备状态。"""
    logger.warning(
        "拒绝内存封禁, ip=%s, duration=%s, reason=%s", ip, duration, reason,
    )
    return {
        "error": "block_ip_on_firewall 已停用，不会在设备上封禁。请使用工具 block_ip。",
        "ip": ip,
    }


async def is_ip_blocked(ip: str) -> bool:
    """查询指定 IP 是否已被封禁。

    Args:
        ip: 待查询的 IP 地址。

    Returns:
        True 表示已封禁，False 表示未封禁。
    """
    blocked = ip in _blocked_ips
    logger.debug("查询封禁状态, ip=%s, blocked=%s", ip, blocked)
    return blocked
