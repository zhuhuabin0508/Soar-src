REMOVED_BUILTIN_TOOLS: set[str] = {
    "discover_new_kbs",
    "fetch_kb_content",
    "query_asset",
    "add_asset",
    "update_asset",
    "list_assets",
    "search_assets",
    "block_ip_on_firewall",
}

LEGACY_DEPRECATED_TOOL_NAMES: set[str] = {
    "query_asset_info",
    "query_threat_intel",
    "query_ip_geo",
    "check_port_scan",
    "send_alert_to_siem",
}
