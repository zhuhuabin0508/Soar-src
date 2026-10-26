/** 智能体创建模板：列表页「从模板创建」预填 AgentEditor 表单 */

export const AGENT_TEMPLATE_STORAGE_KEY = 'soar:agent:template'
export const AGENT_DSL_STORAGE_KEY = 'soar:agent:dsl-draft'

/** 将 DSL 转为快速创建可消费的描述（写入 sessionStorage） */
export function stashAgentDsl(dsl) {
  try {
    sessionStorage.setItem(AGENT_DSL_STORAGE_KEY, JSON.stringify(dsl))
  } catch {
    /* ignore */
  }
}

export function loadStashedAgentDsl() {
  try {
    const raw = sessionStorage.getItem(AGENT_DSL_STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(AGENT_DSL_STORAGE_KEY)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 后端团队模板 → 快速创建预填 */
export function teamAgentToPlanInput(agent) {
  return {
    description: agent.description || agent.template_scenario || agent.name,
    dsl: {
      api_version: 'soar/agent-dsl/1',
      name: agent.name,
      description: agent.description,
      model_config_id: agent.model_config_id,
      system_prompt: agent.system_prompt,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      enabled_tools: agent.enabled_tools || [],
      enabled_kbs: agent.enabled_kbs || [],
      enabled_asset_types: agent.enabled_asset_types || [],
      enabled_skills: agent.enabled_skills || [],
      max_iterations: agent.max_iterations,
      greeting: agent.greeting,
      tool_configs: agent.tool_configs || {},
      engine: agent.engine || 'hermes',
    },
  }
}

export const AGENT_TEMPLATES = [
  {
    id: 'alert_analyst',
    name: '告警研判员',
    description: '面向 SOC 告警研判：白名单 → 资产 → 威胁情报，输出处置建议',
    scenario: '日常告警分析、误报甄别',
    tags: ['告警研判', 'SOC', '威胁情报'],
    icon: 'shield',
    form: {
      name: '告警研判员',
      description: '接收告警上下文，按标准流程研判源 IP 风险并给出处置建议',
      greeting: '你好，我是告警研判助手。请发送告警信息或源 IP，我会按白名单→资产→威胁情报顺序分析。',
      suggested_questions: ['请研判源 IP 89.124.70.92', '这条告警是否需要封禁？'],
      system_prompt: `你是一名 SOC 高级安全分析师，负责告警研判。

## 研判顺序
1. 调用 check_whitelist 检查源 IP 是否在白名单/可信网段
2. 调用 search_assets 查询资产清单归属（主机、网段、出口地址）
3. 调用 search_discovered_assets 查询资产发现（云主机、裸金属、网络资源、弹性IP）
4. 对外网 IP 调用 get_threat_intel 查询威胁情报
5. 必要时调用 check_subnet 确认网段关系

## 输出要求
- 给出风险等级（高/中/低）与处置建议（封禁/观察/误报）
- 内网或关键业务 IP 禁止建议自动封禁
- 结论需引用工具返回的关键字段`,
      temperature: 0.3,
      max_iterations: 8,
      engine: 'hermes',
      enabled_tools: ['check_whitelist', 'search_assets', 'search_discovered_assets', 'get_threat_intel', 'check_subnet'],
      enabled_asset_types: ['host_asset', 'network_segment', 'egress_ip'],
      tool_configs: { tool_search: { enabled: 'off' } },
    },
    kb_names: ['安全响应规范', '常用研判口径'],
    skill_names: [],
    wizardStep: 'ability',
    tool_guide: '已按「告警研判」流程预选工具，覆盖白名单 → 资产 → 威胁情报链路，一般无需再选其他。',
    tool_hints: {
      check_whitelist: '先查白名单，排除可信 IP 与误报',
      search_assets: '查 IP 对应主机、网段或出口地址',
      search_discovered_assets: '查综合运管平台发现的云主机、裸金属、网络资源和弹性IP',
      get_threat_intel: '查外网 IP 恶意标签与置信度',
      check_subnet: '确认 IP 与网段归属关系',
    },
    kb_guide: '已预选内置研判规范库，可直接使用。',
  },
  {
    id: 'ban_decision',
    name: '封禁决策员',
    description: 'IP 风险研判 + 封禁时长建议，给出处置建议而不执行封禁',
    scenario: '封禁工作流、IP 风险处置',
    tags: ['封禁决策', 'IP 风险', '工作流'],
    icon: 'ban',
    form: {
      name: '封禁决策员',
      description: '综合白名单、资产、威胁情报与历史封禁记录，给出封禁等级与时长建议（不执行封禁）',
      greeting: '你好，我是封禁决策助手。提供待处置 IP 或告警上下文，我会给出封禁等级与时长建议。',
      suggested_questions: ['请对 45.227.255.206 做封禁决策', '该 IP 是否已有封禁记录？'],
      system_prompt: `你是 IP 风险研判与封禁决策专家。

## 决策流程
1. check_whitelist：白名单命中则终止，标记误报
2. search_assets：确认资产清单中的归属与业务重要性
3. search_discovered_assets：确认是否为已发现的云主机、裸金属、网络资源或弹性IP
4. get_threat_intel：查询恶意标签与置信度
5. query_banned_ip：查询历史封禁与违规次数
6. calculate_ban_duration：按地域、违规次数、威胁标签计算时长
7. 输出封禁建议（等级、时长、是否永久），由人工在工作台或工单流转中执行封禁

## 原则
- 内网 IP 不建议封禁
- 出口/NAT 地址建议封禁前说明影响范围
- 你只做研判与建议，不执行任何封禁动作
- 输出需包含：决策理由、ban_level、时长、是否永久`,
      temperature: 0.2,
      max_iterations: 10,
      engine: 'hermes',
      enabled_tools: [
        'check_whitelist',
        'search_assets',
        'search_discovered_assets',
        'get_threat_intel',
        'query_banned_ip',
        'calculate_ban_duration',
      ],
      enabled_asset_types: ['host_asset', 'network_segment', 'egress_ip'],
      tool_configs: { tool_search: { enabled: 'off' } },
    },
    kb_names: ['安全响应规范', '常用研判口径'],
    skill_names: [],
    wizardStep: 'ability',
    tool_guide: '已按「封禁决策」链路预选工具，从研判到计算建议时长；智能体只给建议，封禁由人工执行。',
    tool_hints: {
      check_whitelist: '白名单命中则终止，避免误封',
      search_assets: '确认是否为关键业务或出口地址',
      search_discovered_assets: '确认 IP 是否落在已发现的云主机或弹性IP上',
      get_threat_intel: '获取恶意标签，影响封禁等级',
      query_banned_ip: '查历史封禁与违规次数',
      calculate_ban_duration: '按规则计算建议封禁时长',
    },
    kb_guide: '已预选内置响应规范，辅助封禁决策口径。',
  },
  {
    id: 'asset_analyst',
    name: '资产分析员',
    description: '资产查询、录入与知识库梳理，维护资产清单',
    scenario: '资产台账维护、知识库梳理',
    tags: ['资产管理', '知识库'],
    icon: 'package',
    form: {
      name: '资产分析员',
      description: '根据知识库与对话录入维护资产表，支持查询与更新资产信息',
      greeting: '你好，我是资产分析助手。可以查询资产、录入新资产，或按知识库梳理资产清单。',
      suggested_questions: ['查询 IP 219.133.105.155 的资产信息', '帮我梳理知识库中的资产'],
      system_prompt: `你是资产管理智能体，负责资产查询、录入与知识库梳理。

## 核心工具
- search_assets / query_asset：查询资产清单
- search_discovered_assets：查询资产发现（云主机、裸金属、网络资源、弹性IP）
- discover_new_kbs + fetch_kb_content：从知识库梳理资产
- add_asset / update_asset / list_assets：维护资产表

## 原则
- 新增前先 query_asset 查重
- 标准字段填 name/department/owner/ip 等，扩展字段放 extra_fields
- 对不确定的 identifier 向用户确认`,
      temperature: 0.4,
      max_iterations: 8,
      engine: 'hermes',
      enabled_tools: [
        'search_assets',
        'search_discovered_assets',
        'query_asset',
        'add_asset',
        'update_asset',
        'list_assets',
        'discover_new_kbs',
        'fetch_kb_content',
      ],
      enabled_asset_types: ['host_asset', 'network_segment', 'egress_ip'],
      tool_configs: { tool_search: { enabled: 'auto' } },
    },
    kb_names: [],
    skill_names: [],
    wizardStep: 'ability',
    tool_guide: '已按「资产管理」场景预选查询与维护工具；仅做知识库梳理时可保持默认。',
    tool_hints: {
      search_assets: '按 IP/名称检索资产清单',
      search_discovered_assets: '按 IP、CMDB ID、实例名或部门检索资产发现',
      query_asset: '精确查询单条资产',
      add_asset: '录入新资产',
      update_asset: '更新已有资产',
      list_assets: '分页浏览资产清单',
      discover_new_kbs: '发现待梳理的知识库',
      fetch_kb_content: '拉取知识库分段做梳理',
    },
    kb_guide: '可选：勾选包含资产文档的知识库，用于自动梳理入库。',
  },
]

/** 模板推荐的工具名列表（与 form.enabled_tools 一致） */
export function getTemplateRecommendedTools(template) {
  return template?.form?.enabled_tools || []
}

/** 将模板解析为可写入 form 的字段（解析知识库/技能 ID） */
export function resolveAgentTemplate(template, { kbOptions = [], skillOptions = [], toolOptions = [] } = {}) {
  if (!template?.form) return null
  const availableTools = new Set(toolOptions.map((t) => t.value))
  const enabled_tools = (template.form.enabled_tools || []).filter((n) => availableTools.has(n))

  const kbMap = new Map(kbOptions.map((k) => [k.label, k.value]))
  const enabled_kbs = (template.kb_names || [])
    .map((name) => kbMap.get(name))
    .filter(Boolean)

  const skillMap = new Map(skillOptions.map((s) => [s.label.replace(/（.*?）$/, ''), s.value]))
  const enabled_skills = (template.skill_names || [])
    .map((name) => {
      for (const [label, id] of skillMap) {
        if (label.includes(name) || name.includes(label)) return id
      }
      return null
    })
    .filter(Boolean)

  return {
    ...template.form,
    enabled_tools,
    enabled_kbs,
    enabled_skills,
    _wizardStep: template.wizardStep || 'basic',
    _templateName: template.name,
  }
}

export function stashAgentTemplate(template) {
  try {
    sessionStorage.setItem(AGENT_TEMPLATE_STORAGE_KEY, JSON.stringify({ id: template.id }))
  } catch {
    /* ignore */
  }
}

export function loadStashedAgentTemplate() {
  try {
    const raw = sessionStorage.getItem(AGENT_TEMPLATE_STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(AGENT_TEMPLATE_STORAGE_KEY)
    const { id } = JSON.parse(raw)
    return AGENT_TEMPLATES.find((t) => t.id === id) || null
  } catch {
    return null
  }
}
