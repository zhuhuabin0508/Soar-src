"""平台默认种子数据初始化。

工具预置数据由 ``app.core.tools.seed_service`` 统一管理。
"""
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.tools.definitions import (
    HERMES_BUILTIN_TOOLS,
    HERMES_FRAMEWORK_TOOLS,
    SECURITY_TOOLS,
)
from app.core.tools.seed_service import (
    ensure_hermes_tools,
    ensure_preset_tools,
    ensure_security_tools,
)
from app.database import SessionLocal
from app.models.asset import AssetTypeTemplate
from app.models.workflow import Workflow
from app.models.skill import Skill

logger = logging.getLogger(__name__)

ASSET_AGENT_SYSTEM_PROMPT: str = """你是一个资产管理智能体，负责根据勾选的知识库梳理资产信息、维护资产表，并响应用户的资产录入/查询/更新需求。

## 核心工具

1. **discover_new_kbs** —— 发现已勾选但尚未梳理到资产表的新增知识库
2. **fetch_kb_content** —— 拉取指定知识库的全部分段内容
3. **query_asset** —— 查询资产表中是否已存在某资产（按 identifier/ip/name/keyword）
4. **add_asset** —— 新增资产记录（identifier 已存在时会被拒绝）
5. **update_asset** —— 更新已有资产记录（按 identifier 定位，extra_fields 合并）
6. **list_assets** —— 分页列出资产（支持筛选和关键词搜索）

## 资产梳理流程（知识库 → 资产表）

当被要求梳理资产、或主动发现新知识库时，按以下步骤操作：
1. 调用 discover_new_kbs 检查是否有尚未梳理的知识库
2. 对每个新知识库，调用 fetch_kb_content 拉取全部分段内容
3. 逐段分析内容，提取资产信息：
   - 判断每条资产的唯一标识（identifier）：优先用 IP/主机名/工号/资产编号
   - 判断 identifier_type：ip/hostname/asset_name/employee_id/mac/custom
   - 提取标准字段（name/asset_type/department/owner/location/ip/criticality）
   - 知识库中特有但标准字段未覆盖的属性，放入 extra_fields（JSON 对象）
4. 对每条提取到的资产，先调用 query_asset 检查是否已存在：
   - 不存在 → 调用 add_asset 新增（source=kb_ingest）
   - 已存在 → 调用 update_asset 更新（合并新信息到已有记录）

## 对话录入资产

当用户在对话中提供新的资产信息时：
1. 从用户消息中提取资产标识（IP/主机名/名称等）
2. 调用 query_asset 检查该资产是否已存在
3. 不存在 → add_asset 新增（source=agent_add）
4. 已存在 → 向用户确认后 update_asset 更新

## 字段灵活性

不同知识库的资产字段可能不同：
- 标准字段（name/asset_type/department/owner/location/ip/criticality）直接填入对应参数
- 非标准字段统一放入 extra_fields（如 {"序列号": "SN001", "购入日期": "2024-01-01"}）
- 你需要根据知识库内容灵活判断哪些字段是标准字段、哪些放入 extra_fields

## 重要约束

- 每条资产必须有 identifier（唯一标识），用于去重
- 不要重复录入同一资产：录入前务必先 query_asset 检查
- 资产梳理是增量操作：只处理新知识库，已梳理的不要重复处理
- 返回结果要简洁清晰，用表格/列表形式展示资产信息
"""


# ============================================================================
# Hermes 引擎框架级工具（tool_type='framework'）
#
# 仅存储 schema（name/description/parameters_schema），无 code 字段。
# 执行逻辑在 executor.py 的 _react_loop 中拦截，走专属处理方法：
#   - trigger_workflow_skill → _handle_skill_call → skill_engine.trigger_skill
#   - list_workflow_skills → 直接返回 skill_engine.list_workflow_skills()
#   - delegate_task → _handle_delegate_call → delegator.delegate()
#   - clarify → 需 callback 机制（待完善）
#
# parameters_schema 存储 OpenAI parameters 对象（非数组格式），
# executor 直接包装为 {"type":"function","function":{...}} 注入 extra_tool_defs。
# ============================================================================
HERMES_FRAMEWORK_TOOLS: list[dict[str, Any]] = [
    {
        "name": "trigger_workflow_skill",
        "description": (
            "触发一个已配置的工作流作为复杂技能。适用于需要多步骤编排、"
            "人工审批、设备操作的场景。先调用 list_workflow_skills 获取可用技能。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "workflow_id": {"type": "integer", "description": "工作流 ID"},
                "input": {"type": "object", "description": "技能输入参数", "additionalProperties": True},
                "resume_token": {"type": "string", "description": "恢复令牌（恢复被中断的技能时传入）"},
            },
            "required": ["workflow_id"],
        },
        "tool_type": "framework",
        "category": "task_delegation",
        "code": None,
        "enabled": True,
    },
    {
        "name": "list_workflow_skills",
        "description": "列出所有可作为技能触发的工作流（返回 id/name/description）。",
        "parameters_schema": {"type": "object", "properties": {}},
        "tool_type": "framework",
        "category": "task_delegation",
        "code": None,
        "enabled": True,
    },
    {
        "name": "delegate_task",
        "description": (
            "委派一个或多个子代理在隔离上下文中执行任务。"
            "子代理拥有独立的对话历史（看不到父代理历史）、继承的工具集（剥离部分工具）、"
            "独立的迭代预算。"
            "适用于：并行调研多个方向、把重复性子任务交给子代理、保持父上下文简洁。"
            "\n\n单任务：提供 goal（+可选 context）。"
            "批量：提供 tasks 数组 [{goal, context}, ...]（并行执行，汇总结果）。"
            "完成后返回汇总结果，父代理可继续推理。"
            "\n\n注意：子代理看不到你的对话历史，goal 必须 self-contained。"
            "子代理不能委派其他子代理（delegate_task 对子代理不可用）。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "子代理要完成的目标。必须具体且 self-contained——子代理对你的对话历史一无所知。",
                },
                "context": {
                    "type": "string",
                    "description": "子代理需要的背景信息：文件路径、错误消息、项目结构、约束。越具体，子代理表现越好。",
                },
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "goal": {"type": "string", "description": "任务目标"},
                            "context": {"type": "string", "description": "任务特定背景"},
                        },
                        "required": ["goal"],
                    },
                    "description": "批量任务数组。提供时忽略顶层 goal/context，每个任务独立执行后汇总。",
                },
            },
            "required": [],
        },
        "tool_type": "framework",
        "category": "task_delegation",
        "code": None,
        "enabled": True,
    },
    {
        "name": "clarify",
        "description": (
            "当你需要澄清、反馈或决策时向用户提问。支持两种模式：\n\n"
            "1. **多选** —— 提供最多 4 个选项，用户选一个或输入'其他'。\n"
            "2. **开放式** —— 不提供选项，用户自由文本回答。\n\n"
            "关键：提供选项时，每个选项只放 ``choices`` 数组，绝不把选项写进 ``question`` 文本。"
            "UI 会渲染 choices 为可选项；写进 question 的选项会变成死文本。\n\n"
            "正确: question='封禁多长时间？', choices=['1小时', '24小时', '永久']\n"
            "错误: question='封禁多长时间？1) 1小时 2) 24小时', choices=[]\n\n"
            "使用场景：\n"
            "- 告警信息不全（IP 为空、设备未指定）\n"
            "- 设备操作目标不明确（多台设备匹配）\n"
            "- 处置策略与告警严重程度不匹配\n"
            "- 决策有重大权衡，需用户参与\n\n"
            "不要用于危险命令的简单 yes/no 确认（写工具的 verification 机制处理）。"
            "低风险决策应自行做合理默认选择。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "问题本身，且只有问题（如 '封禁多长时间？'）。不要把答案选项嵌入这里。",
                },
                "choices": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 4,
                    "description": "提供可选项时必填：每个选项是数组的一个元素（最多 4 个）。",
                },
            },
            "required": ["question"],
        },
        "tool_type": "framework",
        "category": "clarifying_question",
        "code": None,
        "enabled": True,
    },
    {
        "name": "plan",
        "description": (
            "创建结构化的任务执行计划。当任务复杂、需要多步骤编排时调用此工具，"
            "将任务分解为有序步骤并明确每步的目标和依赖关系。"
            "计划生成后可作为后续执行的蓝图，也便于用户审阅和调整。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "任务的最终目标",
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "description": "步骤动作描述"},
                            "tool": {"type": "string", "description": "该步骤使用的工具名（可选）"},
                            "depends_on": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "依赖的前置步骤序号",
                            },
                        },
                        "required": ["action"],
                    },
                    "description": "有序步骤列表",
                },
            },
            "required": ["goal", "steps"],
        },
        "tool_type": "framework",
        "category": "task_planning",
        "code": None,
        "enabled": True,
    },
    {
        "name": "schedule_cron",
        "description": (
            "调度一个定时（cron）任务，按指定时间规则周期性执行工作流或动作。"
            "适用于定期巡检、定时报表、周期性扫描等场景。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "定时任务名称"},
                "cron_expr": {
                    "type": "string",
                    "description": "Cron 表达式（如 '0 2 * * *' 表示每天凌晨 2 点）",
                },
                "workflow_id": {"type": "integer", "description": "要触发的工作流 ID"},
                "input": {"type": "object", "description": "传给工作流的输入参数", "additionalProperties": True},
            },
            "required": ["name", "cron_expr", "workflow_id"],
        },
        "tool_type": "framework",
        "category": "cron_jobs",
        "code": None,
        "enabled": True,
    },
    {
        "name": "computer_use",
        "description": (
            "执行计算机操作（如运行命令、操作文件系统、打开浏览器等）。"
            "适用于需要与操作系统或桌面环境交互的自动化场景。"
            "注意：此工具在沙箱中执行，受安全策略限制。"
        ),
        "parameters_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "要执行的操作类型：run_command / read_file / write_file / list_dir / open_url",
                },
                "target": {
                    "type": "string",
                    "description": "操作目标（命令、文件路径、URL 等）",
                },
                "args": {
                    "type": "object",
                    "description": "附加参数",
                    "additionalProperties": True,
                },
            },
            "required": ["action", "target"],
        },
        "tool_type": "framework",
        "category": "computer_use",
        "code": None,
        "enabled": True,
    },
    # ===== 智能体创建助手：构建类框架工具（tool_type='framework'，executor 拦截处理）=====
    # 处理逻辑在 app/agent/hermes/builder.py；仅对显式启用的智能体可见。
    {
        "name": "list_tools",
        "description": "列出平台现有的全部工具（id/name/description/category/tool_type/enabled），用于创建前盘点与命名查重。",
        "parameters_schema": {"type": "object", "properties": {}},
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "list_skills",
        "description": "列出平台现有的全部技能（id/name/description/category/priority/enabled），用于创建前盘点与命名查重。",
        "parameters_schema": {"type": "object", "properties": {}},
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "list_agents",
        "description": "列出平台现有的全部智能体（id/name/description/engine/enabled_tools/enabled_skills），用于创建前盘点与命名查重。",
        "parameters_schema": {"type": "object", "properties": {}},
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "create_skill",
        "description": "创建一个技能（纯文本操作指引，注入智能体 system prompt）。参数：name 唯一、content 必填（Markdown 正文，支持 {{变量}} 占位）、description/category/tags/priority 可选。",
        "parameters_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "技能名称，唯一"},
                "description": {"type": "string", "description": "技能简介"},
                "content": {"type": "string", "description": "技能正文（Markdown 操作指引，支持 {{变量}} 占位）"},
                "category": {"type": "string", "description": "技能分类"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"},
                "priority": {"type": "integer", "description": "优先级，越大越靠前（默认 0）"},
            },
            "required": ["name", "content"],
        },
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "create_tool",
        "description": "创建一个代码工具（仅供管理员）。参数：name 唯一（小写英文下划线）、code 必填（Python 代码，须定义 async def run(**kwargs) 返回 dict）、description 必填（写给 LLM 何时调用）、parameters_schema 数组 [{name,type,required,description}]。创建前请先用 test_tool_code 自检代码。",
        "parameters_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "工具名，唯一，建议小写英文下划线"},
                "description": {"type": "string", "description": "工具描述（写给 LLM 看，说明何时调用）"},
                "parameters_schema": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "参数 schema 数组：[{name,type,required,description}]，type ∈ String/Integer/Boolean/List/Dict",
                },
                "code": {"type": "string", "description": "Python 代码，必须定义 async def run(**kwargs)，返回 dict"},
                "category": {"type": "string", "description": "工具分类（security/file_operations/asset 等）"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"},
            },
            "required": ["name", "description", "parameters_schema", "code"],
        },
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "create_agent",
        "description": "创建一个智能体。参数：name 必填；description/engine（默认 hermes）/system_prompt/enabled_tools（工具名数组）/enabled_skills（技能 id 数组）/greeting/suggested_questions/max_iterations/temperature 可选。创建前先用 list_tools/list_skills/list_agents 盘点可用的工具与技能。",
        "parameters_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "智能体名称，唯一"},
                "description": {"type": "string", "description": "智能体描述"},
                "engine": {"type": "string", "description": "执行引擎：hermes（推荐）| langgraph"},
                "system_prompt": {"type": "string", "description": "系统提示词"},
                "enabled_tools": {"type": "array", "items": {"type": "string"}, "description": "启用的工具名列表"},
                "enabled_skills": {"type": "array", "items": {"type": "integer"}, "description": "启用的技能 id 列表"},
                "greeting": {"type": "string", "description": "开场白"},
                "suggested_questions": {"type": "array", "items": {"type": "string"}, "description": "开场引导问题"},
                "max_iterations": {"type": "integer", "description": "最大迭代轮数（默认 5）"},
                "temperature": {"type": "number", "description": "采样温度（默认 0.7）"},
            },
            "required": ["name"],
        },
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
    {
        "name": "test_tool_code",
        "description": "对工具代码做静态安全审查与编译检查（创建工具前的自检）。参数：code 必填。返回 {ok, errors}。若未通过，根据错误信息修改代码后重试。",
        "parameters_schema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "待校验的工具代码"},
            },
            "required": ["code"],
        },
        "tool_type": "framework",
        "category": "agent_builder",
        "code": None,
        "enabled": True,
    },
]

# 示例工作流：暴力破解自动封禁（含人工审批分支）
SAMPLE_WORKFLOW: dict[str, Any] = {
    "name": "【示例】暴力破解自动处置（含人工审批）",
    "graph_config": {
        "nodes": [
            {
                "id": "webhook_1",
                "type": "webhook_trigger",
                "data": {
                    "method": "POST",
                    "content_type": "application/json",
                    "query_params": [],
                    "header_params": [],
                    "body_params": [
                        {"name": "src_ip", "type": "String", "required": True},
                        {"name": "dest_ip", "type": "String", "required": True},
                        {"name": "alert_type", "type": "String", "required": True},
                        {"name": "count", "type": "Number", "required": False},
                    ],
                    "response_status": 200,
                    "response_body": '{"status": "received"}',
                },
            },
            {
                "id": "agent_1",
                "type": "ai_agent",
                "data": {
                    "model": "claude-3-5-sonnet",
                    "temperature": 0.3,
                    "max_tokens": 1024,
                    "max_iterations": 5,
                    "system_prompt": "你是一名 SOC 高级安全专家。接收到告警后，请利用工具查询源 IP 的白名单状态、资产归属、网段和威胁情报，综合判断是否需要封禁。",
                    "user_prompt": "告警数据：{{alert_data}}，请分析并给出处置建议。",
                    "enabled_tools": ["check_whitelist", "get_asset_info", "get_threat_intel", "check_subnet"],
                },
            },
            {
                "id": "cond_1",
                "type": "condition_branch",
                "data": {
                    "mode": "if_else",
                    "conditions": [{"variable": "decision", "operator": "==", "value": "need_human_approval"}],
                    "logic": "AND",
                    "true_label": "true",
                    "false_label": "false",
                },
            },
            {
                "id": "hr_1",
                "type": "human_review",
                "data": {
                    "title": "暴力破解封禁审批",
                    "description": "Agent 无法确定是否封禁，需人工审核",
                    "instructions": "请基于告警信息与 Agent 推理结果，判断是否需要封禁源 IP。点击「同意封禁」将继续执行下游封禁节点；点击「忽略」将终止工作流。",
                },
            },
            {
                "id": "block_1",
                "type": "block_ip",
                "data": {"action": "block", "target_ip": "{{agent_decision.target_ip}}", "value": 24, "unit": "h"},
            },
            {
                "id": "notify_1",
                "type": "send_notification",
                "data": {
                    "channel": "email",
                    "severity": "critical",
                    "subject": "【SOAR】已封禁恶意 IP {{agent_decision.target_ip}}",
                    "body": "检测到来自 {{payload.src_ip}} 的攻击行为，已自动封禁。\n处置建议：{{agent_decision.reason}}",
                    "recipients": "安全运营团队邮箱",
                },
            },
            {
                "id": "end_1",
                "type": "end",
                "data": {"end_type": "success"},
            },
        ],
        "edges": [
            {"source": "webhook_1", "target": "agent_1"},
            {"source": "agent_1", "target": "cond_1"},
            {"source": "cond_1", "target": "hr_1", "sourceHandle": "true"},
            {"source": "cond_1", "target": "block_1", "sourceHandle": "false"},
            {"source": "hr_1", "target": "block_1"},
            {"source": "block_1", "target": "notify_1"},
            {"source": "notify_1", "target": "end_1"},
        ],
    },
}


# ============================================================================
# 资产类型模板种子数据
# 三种预设类型：网段信息、主机资产、出口地址
# ============================================================================

PRESET_ASSET_TEMPLATES = [
    {
        "code": "host_asset",
        "name": "主机资产",
        "description": "云主机、物理机、虚拟机等计算资产",
        "icon": "server",
        "color": "chart-1",
        "identifier_field": "ip",
        "is_preset": True,
        "sort_order": 1,
        "fields": [
            {"key": "system_name", "label": "系统名称", "type": "text", "mapped_to": "extra",
             "required": True, "width": "half", "sort_order": 1, "show_in_list": True, "show_in_detail": True},
            {"key": "name", "label": "资产名称", "type": "text", "mapped_to": "standard:name",
             "required": True, "width": "half", "sort_order": 2, "show_in_list": True, "show_in_detail": True},
            {"key": "ip", "label": "IP", "type": "ip", "mapped_to": "standard:ip",
             "required": True, "unique": True, "placeholder": "192.0.2.10",
             "width": "half", "sort_order": 3, "show_in_list": True, "show_in_detail": True},
            {"key": "eip", "label": "EIP", "type": "ip", "mapped_to": "extra",
             "placeholder": "弹性公网 IP", "width": "half", "sort_order": 4, "show_in_list": True, "show_in_detail": True},
            {"key": "primary_category", "label": "资产一级分类", "type": "select", "mapped_to": "extra",
             "options": ["服务器", "网络设备", "安全设备", "终端", "应用", "中间件", "数据库"],
             "required": True, "width": "half", "sort_order": 5, "show_in_list": True, "show_in_detail": True},
            {"key": "secondary_category", "label": "资产二级分类", "type": "select", "mapped_to": "extra",
             "options": ["物理机", "虚拟机", "容器", "路由器", "交换机", "防火墙", "WAF", "IDS/IPS"],
             "width": "half", "sort_order": 6, "show_in_list": False, "show_in_detail": True},
            {"key": "security_dept", "label": "资产安全责任单位/部门", "type": "text", "mapped_to": "standard:department",
             "required": True, "width": "half", "sort_order": 7, "show_in_list": True, "show_in_detail": True},
            {"key": "security_owner", "label": "安全责任人", "type": "text", "mapped_to": "standard:owner",
             "required": True, "width": "half", "sort_order": 8, "show_in_list": True, "show_in_detail": True},
            {"key": "cloud", "label": "所属云", "type": "select", "mapped_to": "extra",
             "options": ["私有云", "阿里云", "腾讯云", "华为云", "AWS", "Azure", "其他"],
             "width": "half", "sort_order": 9, "show_in_list": True, "show_in_detail": True},
            {"key": "criticality", "label": "重要性", "type": "select", "mapped_to": "standard:criticality",
             "options": ["low", "medium", "high", "critical"], "default": "medium",
             "width": "half", "sort_order": 10, "show_in_list": False, "show_in_detail": True},
            {"key": "status", "label": "状态", "type": "select", "mapped_to": "standard:status",
             "options": ["in_use", "idle", "repair", "retired", "lost"], "default": "in_use",
             "width": "half", "sort_order": 11, "show_in_list": False, "show_in_detail": True},
        ],
    },
    {
        "code": "network_segment",
        "name": "网段信息",
        "description": "内部网段、子网信息",
        "icon": "network",
        "color": "chart-2",
        "identifier_field": "cidr",
        "is_preset": True,
        # 网段信息允许标识聚合：同一网段下可存在多个不同使用单位的记录
        # 列表/详情按网段（identifier）分组展开，显示各使用单位子项
        "allow_aggregate": True,
        "sort_order": 2,
        "fields": [
            {"key": "cidr", "label": "网段", "type": "cidr", "mapped_to": "standard:ip",
             "required": True, "unique": True, "placeholder": "192.0.2.0/24",
             "width": "half", "sort_order": 1, "show_in_list": True, "show_in_detail": True},
            {"key": "usage_unit", "label": "使用单位", "type": "text", "mapped_to": "standard:department",
             "required": True, "width": "half", "sort_order": 2, "show_in_list": True, "show_in_detail": True},
            {"key": "name", "label": "网段名称", "type": "text", "mapped_to": "standard:name",
             "width": "half", "sort_order": 3, "show_in_list": True, "show_in_detail": True},
            {"key": "owner", "label": "责任人", "type": "text", "mapped_to": "standard:owner",
             "width": "half", "sort_order": 4, "show_in_list": False, "show_in_detail": True},
            {"key": "criticality", "label": "重要性", "type": "select", "mapped_to": "standard:criticality",
             "options": ["low", "medium", "high", "critical"], "default": "medium",
             "width": "half", "sort_order": 5, "show_in_list": False, "show_in_detail": True},
            {"key": "status", "label": "状态", "type": "select", "mapped_to": "standard:status",
             "options": ["in_use", "idle", "repair", "retired", "lost"], "default": "in_use",
             "width": "half", "sort_order": 6, "show_in_list": False, "show_in_detail": True},
        ],
    },
    {
        "code": "egress_ip",
        "name": "出口地址",
        "description": "NAT 出口、公网出口 IP 地址",
        "icon": "globe",
        "color": "chart-3",
        "identifier_field": "ip",
        "is_preset": True,
        "sort_order": 3,
        "fields": [
            {"key": "ip", "label": "IP 地址", "type": "ip", "mapped_to": "standard:ip",
             "required": True, "unique": True, "placeholder": "公网出口 IP",
             "width": "half", "sort_order": 1, "show_in_list": True, "show_in_detail": True},
            {"key": "usage_unit", "label": "使用单位", "type": "text", "mapped_to": "standard:department",
             "required": True, "width": "half", "sort_order": 2, "show_in_list": True, "show_in_detail": True},
            {"key": "name", "label": "地址名称", "type": "text", "mapped_to": "standard:name",
             "width": "half", "sort_order": 3, "show_in_list": True, "show_in_detail": True},
            {"key": "owner", "label": "责任人", "type": "text", "mapped_to": "standard:owner",
             "width": "half", "sort_order": 4, "show_in_list": False, "show_in_detail": True},
            {"key": "criticality", "label": "重要性", "type": "select", "mapped_to": "standard:criticality",
             "options": ["low", "medium", "high", "critical"], "default": "medium",
             "width": "half", "sort_order": 5, "show_in_list": False, "show_in_detail": True},
            {"key": "status", "label": "状态", "type": "select", "mapped_to": "standard:status",
             "options": ["in_use", "idle", "repair", "retired", "lost"], "default": "in_use",
             "width": "half", "sort_order": 6, "show_in_list": False, "show_in_detail": True},
        ],
    },
]


def ensure_preset_asset_templates() -> None:
    """幂等种入三个预设资产类型模板。按 code 查重，不存在才插入。

    已存在的模板不覆盖用户修改；``allow_aggregate`` 默认值的同步由
    ``run_lightweight_migrations`` 在首次升级时一次性处理。
    """
    db: Session = SessionLocal()
    try:
        for tpl_data in PRESET_ASSET_TEMPLATES:
            existing = db.query(AssetTypeTemplate).filter_by(code=tpl_data["code"]).first()
            if existing is None:
                db.add(AssetTypeTemplate(**tpl_data))
                logger.info("种入资产类型模板: %s (%s)", tpl_data["code"], tpl_data["name"])
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.exception("资产类型模板种子初始化失败: %s", e)
        db.rollback()
    finally:
        db.close()


def ensure_seed_data() -> None:
    """确保关键表有兜底数据；仅当表为空时种入，不覆盖用户数据。"""
    db: Session = SessionLocal()
    try:
        # 1. 工作流表为空 → 种入示例工作流
        wf_count = db.query(Workflow).count()
        if wf_count == 0:
            logger.info("Workflows 表为空，种入示例工作流")
            db.add(Workflow(**SAMPLE_WORKFLOW))
            db.commit()
            logger.info("示例工作流种入完成")
        else:
            logger.info("Workflows 表已有 %d 条数据，跳过 seed", wf_count)
    except Exception as e:  # noqa: BLE001
        logger.exception("Seed 数据初始化失败: %s", e)
        db.rollback()
    finally:
        db.close()

    # 2. 工具目录同步（内置 + 框架 + 安全，幂等）
    ensure_preset_tools()

    # 3. 内置技能种子（幂等：按 name 查询，不存在才插入）
    ensure_builtin_skills()

    # 3.5 智能体创建助手（幂等：按 name 查询，不存在才创建）
    ensure_builder_agent()
    ensure_platform_agent()

    # 4. 预设资产类型模板（幂等：按 code 查询，不存在才插入）
    ensure_preset_asset_templates()

    # 5. 内置知识库（幂等：按名称查重）
    try:
        from app.core.kb_seed import ensure_preset_knowledge_bases
        ensure_preset_knowledge_bases()
    except Exception as exc:  # noqa: BLE001
        logger.warning("内置知识库种子失败（忽略）: %s", exc)


# ============================================================================
# 智能体创建助手：内置技能 + 智能体种子
# 通过对话分析用户需求，主动创建工具/技能/智能体（框架级工具见
# app/agent/hermes/builder.py，处理逻辑与权限校验都在该模块）
# ============================================================================
BUILDER_SKILL_NAME = "智能体创建手册"
BUILDER_AGENT_NAME = "智能体创建助手"

BUILDER_SKILL_CONTENT = """你是平台的「智能体创建助手」，通过对话分析用户需求，然后主动创建**工具**、**技能**或**智能体**。

# 一、通用工作流程

1. **分析需求**：从对话中提取目标、输入输出、执行环境、权限要求。
2. **判断创建类型**：
   - 需要「可复用的数据处理 / API 调用 / 查询逻辑」→ 创建**工具**
   - 需要「指导智能体如何做某类事的操作手册 / 流程规范」→ 创建**技能**
   - 需要「一个面向特定场景的对话助手」→ 创建**智能体**（可组合工具 + 技能）
3. **必要时澄清**：信息不足（如工具输入输出不明确、智能体面向对象不清）时用 clarify 工具向用户提问，不要猜。
4. **盘点**：创建前先调用 list_tools / list_skills / list_agents 查重，避免重名；创建智能体时用盘点结果选择可用的工具名与技能 id。
5. **创建**：调用 create_skill / create_tool / create_agent。创建工具前必须先用 test_tool_code 自检代码。
6. **汇报**：向用户说明创建结果（名称、id、用途、如何开始使用）。

# 二、创建工具（create_tool）

## 参数
- `name`：唯一，小写英文+下划线（如 `query_alert_stats`）
- `description`：写给其他智能体看的说明——**何时调用**、**输入输出**，要具体
- `parameters_schema`：数组，元素 `{"name", "type", "required", "description"}`，type 取值 String/Integer/Boolean/List/Dict
- `code`：Python 代码，必须定义 `async def run(**kwargs)` 并返回 dict（成功 `{"result": ...}`，失败 `{"error": ...}`）
- `category`：建议 security / file_operations / asset / task_planning 等
- `tags`：标签数组

## 代码沙箱可用能力（无需 import，禁止 import）
工具代码在受限沙箱执行，`__import__`/文件系统/子进程被禁用。可直接使用以下注入对象：

- 基础：`json` / `asyncio` / `datetime` / `timedelta` / `re` / `ipaddress` / `httpx`（异步请求）
- 文件：`read_uploaded_file("文件名.xlsx")`（读上传文件库，自动解析 xlsx/docx/pdf/csv/txt）、
  `save_workbook_as_agent_file(workbook, "输出名.xlsx")`（把 openpyxl Workbook 写回上传库）、
  `save_json_as_agent_file(obj, "输出名.json")`、`load_excel_workbook("文件名.xlsx")`、`find_col(header, name)`
- 安全上下文：`get_asset_info(ip)` / `get_threat_intel(ip)` / `check_whitelist(ip)` / `check_subnet(ip)`
- 记忆：`save_agent_memory(key, value)` / `recall_agent_memory(key)`
- 数据库：`SessionLocal()` + 模型（`Asset` / `BanRecord` / `BannedIP` / `KnowledgeBase` / `KnowledgeSegment`），
  如 `s = SessionLocal(); rows = s.query(Asset).filter(Asset.type_code == "host_asset").all()`（记得 `s.close()`）
- 当前智能体 id：`current_agent_id`；知识库 id 列表：`enabled_kbs`；检索：`search_kb(kb_id, query)`

## 代码模板（在此基础上填充）
```python
async def run(**kwargs):
    # 1. 取参数（按 parameters_schema 定义）
    keyword = kwargs.get("keyword", "")
    limit = int(kwargs.get("limit", 10))
    # 2. 业务逻辑：可用 json/re/ipaddress/httpx/SessionLocal/read_uploaded_file 等
    # 3. 返回
    return {"result": {"keyword": keyword, "count": 0, "items": []}}
```

## 创建前自检（必须）
用 `test_tool_code` 校验 code：安全审查（import 白名单）+ 编译 + 必须定义 `async def run`。
未通过时根据返回的 errors 修改代码后重试，通过后再 create_tool。

## 注意
- 工具代码不能包含 import 语句、不能访问 __import__/open/eval/exec、不能操作文件系统与子进程
- 异常要捕获并返回 `{"error": "..."}`，不要抛到外层
- 中文文案要简洁

# 三、创建技能（create_skill）

- `name`：唯一，简短直观
- `content`：技能正文（Markdown），是注入智能体 system prompt 的操作指引。写清楚：适用场景、前置条件、处理步骤、输入输出格式、边界与异常处理。支持 `{{变量}}` 占位
- `description`：技能简介（供选择）
- `category`：如「安全运营」「数据处理」「角色设定」
- `priority`：越大越靠前（默认 0）

# 四、创建智能体（create_agent）

- `name`：唯一
- `engine`：默认 `hermes`（推荐，支持工具/技能/澄清/委派）
- `system_prompt`：明确角色定位、任务、边界；可引用已创建的技能
- `enabled_tools`：**先 list_tools 盘点**，填工具名数组（如 ["check_whitelist", "read_document"]）
- `enabled_skills`：**先 list_skills 盘点**，填技能 id 数组
- `greeting` / `suggested_questions`：开场白与引导问题，让用户知道它能做什么

# 五、命名与查重

- 所有 name 全局唯一；创建前先 list_* 确认不冲突
- 重名/权限不足会返回 {"ok": false, "error": "..."}，据此调整（重名→换名；权限不足→告知用户需管理员操作）

# 六、错误处理

- create_tool 返回权限不足 → 说明「创建工具需要管理员权限」，请用户找管理员
- 工具代码审查失败 → 根据 errors 修改重试（常见：误用 import / 未定义 run / 语法错误）
- 需求模糊 → 用 clarify 提问而不是猜测
"""

# 智能体创建助手的系统提示词（简短定位，详细手册在技能里）
BUILDER_AGENT_SYSTEM_PROMPT = """你是平台的「智能体创建助手」。你的职责是：通过对话分析用户的业务需求，判断应该创建**工具**（可复用函数）、**技能**（操作手册）还是**智能体**（对话助手），然后主动调用相应工具完成创建，并向用户清晰汇报结果。

工作原则：
1. 先分析需求，信息不足时用 clarify 向用户提问，不要凭空猜测。
2. 创建前先用 list_tools / list_skills / list_agents 盘点现有资源并查重。
3. 创建工具前必须用 test_tool_code 自检代码，确保通过安全审查。
4. 创建完成后向用户说明：创建了什么、叫什么、id 是多少、如何开始使用。
5. 创建工具需要管理员权限；权限不足时如实告知用户。"""


def ensure_builder_agent() -> None:
    """幂等创建「智能体创建助手」智能体（engine=hermes，启用构建类框架工具）。"""
    db: Session = SessionLocal()
    try:
        from app.models.agent import Agent as AgentModel
        from app.models.llm_config import LLMConfig
        from app.models.user import User

        existing = db.query(AgentModel).filter(AgentModel.name == BUILDER_AGENT_NAME).first()
        if existing is not None:
            logger.debug("智能体「%s」已存在，跳过 seed", BUILDER_AGENT_NAME)
            return
        skill = db.query(Skill).filter(Skill.name == BUILDER_SKILL_NAME).first()
        cfg = db.query(LLMConfig).order_by(LLMConfig.id.asc()).first()
        admin = db.query(User).filter(User.role == "admin").order_by(User.id.asc()).first()
        builder_tools = [
            "list_tools", "list_skills", "list_agents",
            "create_skill", "create_tool", "create_agent", "test_tool_code",
        ]
        agent = AgentModel(
            name=BUILDER_AGENT_NAME,
            description="通过对话分析你的需求，主动创建工具、技能与智能体。",
            model_config_id=cfg.id if cfg else None,
            system_prompt=BUILDER_AGENT_SYSTEM_PROMPT,
            temperature=0.5,
            max_tokens=2048,
            enabled_tools=builder_tools,
            enabled_skills=[skill.id] if skill else [],
            max_iterations=12,
            avatar=None,
            greeting="你好，我是智能体创建助手。告诉我你想实现什么功能，我会帮你分析需求，并创建对应的工具、技能或智能体。",
            suggested_questions=[
                "帮我创建一个查询告警统计的技能",
                "创建一个可以调用外部 API 查询天气的工具",
                "创建一个处理弱密码风险清单的智能体",
            ],
            context_turns=20,
            enable_memory=True,
            tone_style="professional",
            variables={},
            tool_configs={},
            engine="hermes",
            created_by=admin.id if admin else None,
        )
        db.add(agent)
        db.commit()
        logger.info("已创建智能体「%s」: id=%s, engine=hermes", BUILDER_AGENT_NAME, agent.id)
    except Exception as e:  # noqa: BLE001
        logger.exception("智能体创建助手 seed 失败: %s", e)
        db.rollback()
    finally:
        db.close()


PLATFORM_AGENT_NAME = "统一对话"
# 注意：只放真实可装配的工具名。query_asset / list_assets 已被
# REMOVED_BUILTIN_TOOLS 移除（目录过滤后永不装配），不再列入白名单。
_PLATFORM_QUERY_TOOLS = [
    "check_whitelist",
    "get_asset_info",
    "get_threat_intel",
    "check_subnet",
    "query_banned_ip",
]


_PLATFORM_DESCRIPTION = (
    "平台统一入口。查询工具和已勾选设备上的契约工具可用。"
    "设备范围由 enabled_devices 维护，不逐个登记动作名。写操作受角色权限和确认闸约束。"
)
_PLATFORM_PROMPT = (
    "你是平台统一对话入口。只能使用已经挂载的工具。"
    "设备能力只来自该智能体已勾选设备的契约工具：只读查询可直接调用；"
    "写操作和封禁必须等待平台确认后再执行。未挂载的设备不要猜测动作或参数。"
)
_PLATFORM_GREETING = "你好，我是统一对话。可以查资产、威胁情报、白名单，以及已挂载设备上的动作。"


def ensure_platform_agent() -> None:
    """幂等创建统一对话入口。已存在且仍是旧的拒绝设备提示词时，只更新提示词。"""
    db: Session = SessionLocal()
    try:
        from app.models.agent import Agent as AgentModel
        from app.models.llm_config import LLMConfig
        from app.models.user import User

        existing = db.query(AgentModel).filter(AgentModel.name == PLATFORM_AGENT_NAME).first()
        if existing is not None:
            if "不要调用封禁" in (existing.system_prompt or ""):
                existing.description = _PLATFORM_DESCRIPTION
                existing.system_prompt = _PLATFORM_PROMPT
                existing.greeting = _PLATFORM_GREETING
                db.commit()
            return
        cfg = db.query(LLMConfig).order_by(LLMConfig.id.asc()).first()
        admin = db.query(User).filter(User.role == "admin").order_by(User.id.asc()).first()
        agent = AgentModel(
            name=PLATFORM_AGENT_NAME,
            description=_PLATFORM_DESCRIPTION,
            model_config_id=cfg.id if cfg else None,
            system_prompt=_PLATFORM_PROMPT,
            temperature=0.3,
            max_tokens=2048,
            enabled_tools=list(_PLATFORM_QUERY_TOOLS),
            enabled_devices=[],
            enabled_workflows=[],
            max_iterations=8,
            greeting=_PLATFORM_GREETING,
            suggested_questions=[
                "查一下这个 IP 是否在白名单",
                "这个 IP 的威胁情报是什么",
                "帮我查这个 IP 对应的资产",
            ],
            context_turns=10,
            variables={"platform_entry": True, "_publish_status": "published"},
            tool_configs={},
            engine="hermes",
            publish_status="published",
            created_by=admin.id if admin else None,
        )
        db.add(agent)
        db.commit()
        logger.info("已创建智能体「%s」: id=%s", PLATFORM_AGENT_NAME, agent.id)
    except Exception as e:  # noqa: BLE001
        logger.exception("统一对话 seed 失败: %s", e)
        db.rollback()
    finally:
        db.close()


# ============================================================================
# 内置技能种子数据
# 将资产管理智能体提示词作为 Skill 注入，用户可在「技能」页面直接选用
# ============================================================================
BUILTIN_SKILLS: list[dict[str, Any]] = [
    {
        "name": "资产管理智能体提示词",
        "description": "资产管理智能体的系统提示词模板，定义资产梳理、录入、更新流程和字段灵活性规则",
        "content": ASSET_AGENT_SYSTEM_PROMPT,
        "category": "角色设定",
        "tags": ["资产管理", "智能体", "提示词模板"],
        "enabled": True,
        "priority": 10,
    },
    {
        "name": BUILDER_SKILL_NAME,
        "description": "智能体创建助手操作手册：分析用户需求并创建工具/技能/智能体的完整流程、代码模板与规范",
        "content": BUILDER_SKILL_CONTENT,
        "category": "智能体创建",
        "tags": ["智能体创建", "工具", "技能", "操作手册"],
        "enabled": True,
        "priority": 20,
    },
]


def ensure_builtin_skills() -> None:
    """幂等插入内置技能：按 name 查询，不存在才插入，不覆盖用户编辑。"""
    db: Session = SessionLocal()
    try:
        for sk_data in BUILTIN_SKILLS:
            existing = db.query(Skill).filter(Skill.name == sk_data["name"]).first()
            if existing:
                logger.debug("技能「%s」已存在，跳过 seed", sk_data["name"])
                continue
            db.add(Skill(**sk_data))
            logger.info("种入内置技能「%s」", sk_data["name"])
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.exception("内置技能 seed 失败: %s", e)
        db.rollback()
    finally:
        db.close()


# ============================================================================
