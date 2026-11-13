"""权限矩阵定义。

按模块划分权限，每个模块包含若干动作（view/edit/delete/execute 等）。
角色通过 permissions JSON 字段存储 ``{模块: [动作列表]}`` 结构。

用于 ``require_permission(module, action)`` 依赖校验。

模块粒度与侧边栏目录保持一致：
- 工作流拆分为「工作流列表」「工作流编排」两个子模块；
- 资产管理拆分为「资产总览」「资产清单」「类型模板」「资产发现」四个子模块；
- 对话、设备对接从 agent / llm_config 中独立为单独模块。
"""
from typing import Any

# 权限模块与可用动作
# 新增模块时在此注册，前端角色管理页面会动态读取
PERMISSION_MODULES: dict[str, list[str]] = {
    # 运营中心
    "dashboard": ["view"],
    "bigscreen": ["view"],
    "bigscreen2": ["view"],
    "approval": ["view", "approve", "delete"],
    "chat": ["view"],
    # 智能体编排
    "agent": ["view", "edit", "delete", "execute"],
    "workflow_list": ["view", "edit", "delete", "execute"],
    "workflow_editor": ["view", "edit"],
    "skill": ["view", "edit", "delete"],
    "tool": ["view", "edit", "delete", "execute"],
    "knowledge_base": ["view", "edit", "delete"],
    # 资源管理
    "asset_overview": ["view"],
    "asset_list": ["view", "edit", "delete"],
    "asset_templates": ["view", "edit", "delete"],
    "asset_discovery": ["view", "edit", "delete"],
    "deliverable": ["view", "edit", "delete"],
    # IP地址库（独立菜单项：4 库 IPv4 数据源查询/导入）
    "ip_library": ["view", "edit"],
    # 连接配置（设备对接下含：设备列表 / 解析策略 / 告警列表 / 入库监控）
    "llm_config": ["view", "edit", "delete"],
    "device": ["view", "edit"],
    "strategy": ["view", "edit", "delete"],
    "alert": ["view", "export", "handle"],
    "alert_rule": ["view", "edit"],
    "monitor": ["view", "edit"],
    # 运行监控
    "execution": ["view", "export"],
    "notification": ["view", "edit"],
    # 告警自动封禁工作流（实例管理 / 封禁审批 / 封禁工作台 / 安博通黑名单 / 触发规则）
    # view=查看（工作台/黑名单/详情）、edit=编辑（封禁/解封/同步/规则）、export=CSV 导出、delete=删除记录
    "ban_workflow": ["view", "edit", "export", "delete"],
    # 系统管理
    "user": ["view", "edit", "delete"],
    "role": ["view", "edit", "delete"],
    "feedback": ["view", "edit", "delete"],
    "system_config": ["view", "edit"],
    "system_monitor": ["view"],
    "audit_log": ["view"],
    # API 开放平台（应用/密钥/授权管理 + 调用监控）
    "open_api": ["view", "edit"],
    # 运营管理（值班管理拆分为二级权限：人员/值班表/请假/调班/大屏）
    "duty_member": ["view", "edit", "delete"],
    "duty_schedule": ["view", "edit", "delete"],
    "duty_leave": ["view", "edit", "delete"],
    "duty_log": ["view", "edit", "delete"],
    "duty_dashboard": ["view"],
    # 工单（工单中心 + 工单监控大屏 + 工单配置：分组/流程模板）
    # pause=暂停/恢复（临时挂起），独立于流转编辑权限
    "ticket": ["view", "edit", "delete", "execute", "pause"],
    "ticket_monitor": ["view"],
    "ticket_config": ["view", "edit"],
}

# 模块中文标签（前端展示用）
MODULE_LABELS: dict[str, str] = {
    # 运营中心
    "dashboard": "运营大屏",
    "bigscreen": "盾立方W",
    "bigscreen2": "盾立方指挥大屏",
    "approval": "工作台",
    "chat": "对话",
    # 智能体编排
    "agent": "智能体",
    "workflow_list": "工作流列表",
    "workflow_editor": "工作流编排",
    "skill": "技能",
    "tool": "工具",
    "knowledge_base": "知识库",
    # 资源管理
    "asset_overview": "资产总览",
    "asset_list": "资产清单",
    "asset_templates": "类型模板",
    "asset_discovery": "资产发现",
    "deliverable": "材料管理",
    "ip_library": "IP地址库",
    # 连接配置（设备对接下含：设备列表 / 解析策略 / 告警列表 / 入库监控）
    "llm_config": "模型设置",
    "device": "设备对接",
    "strategy": "解析策略",
    "alert": "告警列表",
    "alert_rule": "告警规则",
    "monitor": "入库监控",
    # 运行监控
    "execution": "日志中心",
    "notification": "通知中心",
    "ban_workflow": "封禁工作流",
    # 系统管理
    "user": "用户管理",
    "role": "角色管理",
    "feedback": "反馈管理",
    "system_config": "系统设置",
    "system_monitor": "系统监控",
    "audit_log": "审计日志",
    "open_api": "API开放平台",
    # 运营管理（值班管理二级权限）
    "duty_member": "值班人员",
    "duty_schedule": "值班表",
    "duty_leave": "请假管理",
    "duty_log": "调班记录",
    "duty_dashboard": "值班大屏",
    # 工单
    "ticket": "工单中心",
    "ticket_monitor": "工单监控大屏",
    "ticket_config": "工单配置",
}

# 动作中文标签
ACTION_LABELS: dict[str, str] = {
    "view": "查看",
    "edit": "编辑",
    "delete": "删除",
    "execute": "执行",
    "approve": "审批",
    "export": "导出",
    "handle": "处置",
    "pause": "暂停/恢复",
}

# 权限模块迁移映射（旧模块 → 新模块子项）
# 用于把旧角色 JSON 中的 workflow / asset 权限展开到细分模块
_LEGACY_MODULE_MIGRATION: dict[str, list[str]] = {
    "workflow": ["workflow_list", "workflow_editor"],
    "asset": ["asset_overview", "asset_list", "asset_templates", "asset_discovery"],
    "govcloud": ["asset_discovery"],
    "duty": ["duty_member", "duty_schedule", "duty_leave", "duty_log", "duty_dashboard"],
}


def _inherit_module_actions(
    result: dict[str, list[str]],
    new_mod: str,
    *source_mods: str,
) -> None:
    """若新模块尚未配置，从旧模块动作中取交集补齐（不覆盖已有显式配置）。"""
    if result.get(new_mod):
        return
    allowed = PERMISSION_MODULES.get(new_mod, [])
    if not allowed:
        return
    for src in source_mods:
        old_actions = result.get(src) or []
        inherited = [a for a in old_actions if a in allowed]
        if inherited:
            result[new_mod] = inherited
            return


def migrate_permissions(perms: dict[str, list[str]] | None) -> dict[str, list[str]]:
    """把旧版权限矩阵迁移到新结构（保留已有动作，去重）。

    - ``workflow`` 的动作 → 复制到 ``workflow_list``（全量）+ ``workflow_editor``（仅 view/edit）
    - ``asset`` 的动作 → 复制到 ``asset_overview`` / ``asset_list`` / ``asset_templates`` / ``asset_discovery``
    - ``govcloud`` 过渡键 → ``asset_discovery``（与侧栏「资产发现」对齐）
    - 旧键保留，便于回滚；新键已存在则不覆盖
    - 兼容性补齐：原 ``chat`` 由 ``agent`` 权限覆盖、原 ``device`` 由 ``llm_config`` 覆盖；
      已有 ``asset_list`` 的角色自动补 ``asset_discovery``（动作取交集），避免菜单可见但接口 403
    """
    if not perms:
        return {}
    result = {k: list(v) for k, v in perms.items()}

    for old_mod, new_mods in _LEGACY_MODULE_MIGRATION.items():
        old_actions = perms.get(old_mod)
        if not old_actions:
            continue
        for new_mod in new_mods:
            if new_mod in result and result[new_mod]:
                continue  # 已显式配置，不覆盖
            allowed = PERMISSION_MODULES.get(new_mod, [])
            inherited = [a for a in old_actions if a in allowed]
            if inherited:
                result[new_mod] = inherited

    # 兼容性补齐：chat / device 从原 agent / llm_config 中独立出来
    # 原有 agent 权限覆盖对话 → 自动补 chat:view
    if "chat" not in result and perms.get("agent"):
        result["chat"] = ["view"]
    # 原有 llm_config 权限覆盖设备对接 → 自动补 device:view（仅 view，edit 需手动分配）
    if "device" not in result and perms.get("llm_config"):
        result["device"] = ["view"]
    # 已有资产清单权限的角色补资产发现，保证侧栏与 API 同一套动作
    _inherit_module_actions(result, "asset_discovery", "govcloud", "asset", "asset_list")
    _inherit_module_actions(result, "bigscreen", "dashboard")
    _inherit_module_actions(result, "bigscreen2", "dashboard")
    # 已有工单中心查看权限的角色自动补工单监控大屏（未显式配置时）
    _inherit_module_actions(result, "ticket_monitor", "ticket")
    # 工单暂停为新增动作：已有编辑权限的角色自动补 pause，避免升级后无法暂停/恢复
    ticket_actions = result.get("ticket")
    if ticket_actions and "edit" in ticket_actions and "pause" not in ticket_actions:
        result["ticket"] = [*ticket_actions, "pause"]
    # 已有系统设置权限的角色自动补 API 开放平台（动作取交集：view→view，edit→view+edit）
    _inherit_module_actions(result, "open_api", "system_config")

    return result


# 默认角色权限（种子数据用）
DEFAULT_ROLES: list[dict[str, Any]] = [
    {
        "name": "admin",
        "description": "超级管理员，拥有所有权限",
        "is_system": True,
        "permissions": {mod: list(actions) for mod, actions in PERMISSION_MODULES.items()},
    },
    {
        "name": "analyst",
        "description": "安全运营人员，可编辑工作流/智能体/知识库、处理审批",
        "is_system": True,
        "permissions": {
            "dashboard": ["view"],
            "bigscreen": ["view"],
            "bigscreen2": ["view"],
            "approval": ["view", "approve"],
            "chat": ["view"],
            "agent": ["view", "edit", "execute"],
            "workflow_list": ["view", "edit", "delete", "execute"],
            "workflow_editor": ["view", "edit"],
            "skill": ["view", "edit"],
            "tool": ["view", "execute"],
            "knowledge_base": ["view", "edit"],
            "llm_config": ["view"],
            "device": ["view"],
            "asset_overview": ["view"],
            "asset_list": ["view", "edit", "delete"],
            "asset_templates": ["view", "edit", "delete"],
            "asset_discovery": ["view", "edit", "delete"],
            "deliverable": ["view", "edit"],
            "ip_library": ["view", "edit"],
            "duty_member": ["view", "edit", "delete"],
            "duty_schedule": ["view", "edit", "delete"],
            "duty_leave": ["view", "edit", "delete"],
            "duty_log": ["view", "edit", "delete"],
            "duty_dashboard": ["view"],
            "execution": ["view", "export"],
            "notification": ["view"],
            "alert": ["view", "export", "handle"],
            "alert_rule": ["view", "edit"],
            "monitor": ["view"],
            "feedback": ["view"],
            "system_monitor": ["view"],
            "audit_log": ["view"],
            "ticket": ["view", "edit", "pause"],
            "ticket_monitor": ["view"],
            "ticket_config": ["view", "edit"],
        },
    },
    {
        "name": "viewer",
        "description": "只读用户，仅可查看",
        "is_system": True,
        "permissions": {
            "dashboard": ["view"],
            "bigscreen": ["view"],
            "bigscreen2": ["view"],
            "approval": ["view"],
            "chat": ["view"],
            "agent": ["view"],
            "workflow_list": ["view"],
            "workflow_editor": ["view"],
            "skill": ["view"],
            "tool": ["view"],
            "knowledge_base": ["view"],
            "llm_config": ["view"],
            "device": ["view"],
            "asset_overview": ["view"],
            "asset_list": ["view"],
            "asset_templates": ["view"],
            "asset_discovery": ["view"],
            "deliverable": ["view"],
            "ip_library": ["view"],
            "duty_member": ["view"],
            "duty_schedule": ["view"],
            "duty_leave": ["view"],
            "duty_log": ["view"],
            "duty_dashboard": ["view"],
            "execution": ["view"],
            "notification": ["view"],
            "alert": ["view", "export"],
            "alert_rule": ["view"],
            "monitor": ["view"],
            "feedback": ["view"],
            "system_monitor": ["view"],
            "audit_log": ["view"],
        },
    },
]


def has_permission(permissions: dict[str, list[str]] | None, module: str, action: str) -> bool:
    """检查权限矩阵是否包含指定模块的动作。

    Args:
        permissions: 角色的 permissions 字典 ``{模块: [动作]}``
        module: 权限模块名
        action: 动作名

    Returns:
        是否有权限
    """
    if not permissions:
        return False
    actions = permissions.get(module, [])
    return action in actions
