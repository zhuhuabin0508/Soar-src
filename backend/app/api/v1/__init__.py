"""API v1 路由聚合。

所有业务路由统一前缀 ``/api/v1``，在此处聚合注册。
新增模块的 router 在此 include 即可。
"""
from fastapi import APIRouter

from app.api.v1 import (
    agents,
    agent_files,
    alert_rule_groups,
    alert_rules,
    alerts,
    approvals,
    asset_templates,
    assets,
    auth,
    ban_workflow,
    banned_ips,
    backup,
    bigscreen,
    dashboard,
    deliverables,
    devices,
    duty,
    executions,
    feedback,
    govcloud,
    ingest,
    internal_mock,
    knowledge_base,
    llm_config,
    log_center,
    log_receivers,
    monitor,
    notification_rules,
    notifications,
    resource_shares,
    roles,
    skills,
    system_config,
    system_monitor,
    ticket_groups,
    ticket_flows,
    ticket_sla,
    tickets,
    tools,
    tools_manage,
    users,
    webhook,
    workflows,
    workflow_versions,
    ws,
)

api_router = APIRouter()

# 认证（登录/当前用户/改密）
api_router.include_router(auth.router)
# 工作流与执行
api_router.include_router(workflows.router)
api_router.include_router(workflow_versions.router)
api_router.include_router(webhook.router)
api_router.include_router(executions.router)
# 审批与大屏
api_router.include_router(approvals.router)
api_router.include_router(dashboard.router)
api_router.include_router(bigscreen.router)
api_router.include_router(bigscreen.router2)
# 工具能力（IP 综合查询 / 封禁）
api_router.include_router(tools.router)
# 工具管理（可编辑 Python 工具）
api_router.include_router(tools_manage.router)
# LLM 配置
api_router.include_router(llm_config.router)
# 安全设备与设备动作管理
api_router.include_router(devices.router)
# 智能体
api_router.include_router(agents.router)
# 知识库
api_router.include_router(knowledge_base.router)
# 智能体文件（不做 RAG，原样存储供 read_document 工具读取）
api_router.include_router(agent_files.router)
# 技能（纯文本指令，注入 Agent system prompt）
api_router.include_router(skills.router)
# 用户与角色管理
api_router.include_router(users.router)
api_router.include_router(roles.router)
# 系统配置
api_router.include_router(system_config.router)
# 系统监控（健康检查/性能指标/审计日志）
api_router.include_router(system_monitor.router)
# 通知中心
api_router.include_router(notifications.router)
# 通知规则（事件类型路由 → 目标用户/角色）
api_router.include_router(notification_rules.router)
# WebSocket 实时推送（通知实时提醒通道，query token 鉴权）
api_router.include_router(ws.router)
# 数据备份与恢复
api_router.include_router(backup.router)
# 已封禁 IP 管理
api_router.include_router(banned_ips.router)
# 资产管理
api_router.include_router(assets.router)
# 资产类型模板
api_router.include_router(asset_templates.router)
# 资源共享授权管理（owner 把资源编辑权限共享给其他用户）
api_router.include_router(resource_shares.router)
# 系统 BUG 与优化建议反馈
api_router.include_router(feedback.download_router)  # 附件下载（支持 query token）
api_router.include_router(feedback.router)

api_router.include_router(deliverables.router)
# 政务云爬取资产（Excel 全量导入与展示）
api_router.include_router(govcloud.router)
# 日志中心（统一查看操作日志/执行日志/模型调用日志 + 保留策略）
api_router.include_router(log_center.router)
# 设备日志接收（被动接入：syslog/kafka 配置、接收情况查看、异常通知）
api_router.include_router(log_receivers.router)
# 值班管理（人员/排班/请假/调班）
api_router.include_router(duty.router)
# 告警解析入库引擎（策略驱动：接入/策略管理/错误队列/指标）
api_router.include_router(ingest.router)
# 标准告警列表（分页筛选/详情/统计/导出）
api_router.include_router(alerts.router)
# 告警规则（告警规则引擎：解析成功的日志匹配规则后才产生告警）
api_router.include_router(alert_rules.router)
# 告警规则分组（XDR 列表页左侧分组树面板）
api_router.include_router(alert_rule_groups.router)
# 解析入库监控（概览/策略统计/趋势/服务日志/健康/错误队列重试）
api_router.include_router(monitor.router)
# 告警自动封禁工作流（实例管理/触发规则/熔断/审批/封禁工作台/统计）
api_router.include_router(ban_workflow.router)
# 内置 mock 服务（IP 风险研判智能体 + 封禁工具，/internal 前缀免鉴权）
api_router.include_router(internal_mock.router)
# 工单中心（发起/流转/取消 + 附件）
api_router.include_router(tickets.router)
api_router.include_router(tickets.download_router)
# 工单配置（处理分组 / 流程模板 / SLA 目标）
api_router.include_router(ticket_groups.router)
api_router.include_router(ticket_flows.router)
api_router.include_router(ticket_sla.router)
