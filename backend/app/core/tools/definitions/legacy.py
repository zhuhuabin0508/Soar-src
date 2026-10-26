# 退役预置工具名单：启动时由 seed_service._cleanup_removed_and_legacy
# 从 tools 表物理删除，且各定义源按此名单过滤、不再播种。
REMOVED_BUILTIN_TOOLS: set[str] = {
    "discover_new_kbs",
    "fetch_kb_content",
    "query_asset",
    "add_asset",
    "update_asset",
    "list_assets",
    # ---- 渗透测试类安全工具（2026-10 按用户要求退役，定义已从 security.py 移除）----
    # 渗透侦察 pentest_recon
    "nmap_scan",
    "subfinder_enum",
    "httpx_probe",
    "dnsx_resolve",
    # 漏洞扫描 pentest_scan
    "nuclei_scan",
    "sqlmap_scan",
    "nikto_scan",
    "zap_baseline_scan",
    # 利用与报告 pentest_exploit
    "msf_run_module",
    "msf_rpc_status",
    "searchsploit_search",
    "defectdojo_request",
    # 内网渗透 pentest_lateral
    "bloodhound_collect",
    "bloodhound_query",
    "hydra_attack",
    "crackmapexec_run",
    # ---- 计算机操作（2026-10 按用户要求退役，定义已从 framework.py 移除）----
    "computer_use",
    # ---- 旧版青藤万相 HTTP 工具（2026-09 播种，代码已无定义的孤儿记录；
    #      功能已被设备动作体系 + query_device_actions 工具覆盖，2026-10 退役）----
    "qingteng_login",
    "qingteng_query",
    "qingteng_post",
    "qingteng_assets",
    "qingteng_detect",
    "qingteng_risk",
    "qingteng_vul_check",
    "qingteng_baseline",
    "qingteng_system_audit",
    "qingteng_microseg",
    "qingteng_export_all",
    # ---- 智能体主动封禁工具（2026-10 按用户要求退役，定义已从 builtin.py 移除）----
    # 智能体只做研判并给出建议，不主动写封禁记录；封禁一律由人工在工作台/
    # 工单流转中执行（工单同步 ban_sync 与工作台手动封禁不受影响）
    "record_ban",
}

LEGACY_DEPRECATED_TOOL_NAMES: set[str] = {
    "query_asset_info",
    "query_threat_intel",
    "query_ip_geo",
    "check_port_scan",
    "send_alert_to_siem",
}
