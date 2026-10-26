/**
 * 根据用户自然语言描述推断智能体配置（Coze 式「描述 → 自动选配」）。
 * 当前为规则 + 模板匹配；后续可替换为 LLM 规划接口。
 */
import { AGENT_TEMPLATES, getTemplateRecommendedTools } from './agentTemplates'

const TOOL_KEYWORDS = [
  { name: 'check_whitelist', words: ['白名单', '误报', '可信', 'whitelist'] },
  { name: 'search_assets', words: ['资产', '归属', '主机', '网段', '出口', '台账', 'asset'] },
  { name: 'search_discovered_assets', words: ['资产发现', '云主机', '裸金属', '弹性ip', '弹性IP', '综合运管', '网络资源'] },
  { name: 'get_asset_info', words: ['资产信息', '查资产'] },
  { name: 'get_threat_intel', words: ['威胁情报', '恶意', '情报', 'threat', 'c2', '木马'] },
  { name: 'check_subnet', words: ['网段', '子网', 'subnet'] },
  { name: 'query_banned_ip', words: ['封禁记录', '已封禁', '历史违规', 'banned'] },
  { name: 'calculate_ban_duration', words: ['封禁时长', '封多久', 'duration'] },
  { name: 'query_asset', words: ['查询资产', '资产清单'] },
  { name: 'add_asset', words: ['录入资产', '新增资产', '添加资产'] },
  { name: 'update_asset', words: ['更新资产', '修改资产'] },
  { name: 'list_assets', words: ['列出资产', '资产列表'] },
  { name: 'discover_new_kbs', words: ['梳理知识库', '发现知识库'] },
  { name: 'fetch_kb_content', words: ['拉取知识库', '知识库内容'] },
]

const TEMPLATE_KEYWORDS = [
  { id: 'ban_decision', words: ['封禁', '封堵', 'ban', '拉黑', '处置决策'] },
  { id: 'asset_analyst', words: ['资产', '台账', '录入', '梳理', 'cmDB'] },
  { id: 'alert_analyst', words: ['告警', '研判', 'soc', '分析', '误报', '威胁'] },
]

const SCENARIO_TESTS = {
  alert_analyst: '请研判源 IP 89.124.70.92 是否存在风险',
  ban_decision: '请对 IP 45.227.255.206 给出封禁决策建议',
  asset_analyst: '请查询 IP 219.133.105.155 的资产归属',
}

function scoreTemplate(text, tplId) {
  const rule = TEMPLATE_KEYWORDS.find((r) => r.id === tplId)
  if (!rule) return 0
  const lower = text.toLowerCase()
  return rule.words.reduce((n, w) => (lower.includes(w.toLowerCase()) ? n + 1 : n), 0)
}

function inferToolsFromText(text, availableNames) {
  const lower = text.toLowerCase()
  const picked = new Set()
  const reasons = {}
  for (const rule of TOOL_KEYWORDS) {
    if (!availableNames.has(rule.name)) continue
    const hit = rule.words.some((w) => lower.includes(w.toLowerCase()))
    if (hit) {
      picked.add(rule.name)
      reasons[rule.name] = `描述中提到「${rule.words.find((w) => lower.includes(w.toLowerCase()))}」相关能力`
    }
  }
  return { tools: [...picked], reasons }
}

/**
 * @param {string} description 用户描述
 * @param {{ toolOptions: Array, kbOptions: Array }} ctx
 */
export function planAgentFromDescription(description, ctx = {}) {
  const text = (description || '').trim()
  const toolOptions = ctx.toolOptions || []
  const kbOptions = ctx.kbOptions || []
  const availableNames = new Set(toolOptions.map((t) => t.value))

  let bestTpl = AGENT_TEMPLATES[0]
  let bestScore = -1
  for (const tpl of AGENT_TEMPLATES) {
    const s = scoreTemplate(text, tpl.id)
    if (s > bestScore) {
      bestScore = s
      bestTpl = tpl
    }
  }
  if (bestScore === 0 && text.length > 0) {
    bestTpl = AGENT_TEMPLATES.find((t) => t.id === 'alert_analyst') || AGENT_TEMPLATES[0]
  }

  const fromText = inferToolsFromText(text, availableNames)
  const fromTemplate = getTemplateRecommendedTools(bestTpl).filter((n) => availableNames.has(n))
  const enabledTools = [...new Set([...fromTemplate, ...fromText.tools])]

  const missingTools = getTemplateRecommendedTools(bestTpl).filter((n) => !availableNames.has(n))

  const enabledKbs = (bestTpl.kb_names || [])
    .map((name) => kbOptions.find((k) => k.label.replace(/（\d+ 篇）$/, '') === name || k.label.startsWith(name)))
    .filter(Boolean)
    .map((k) => k.value)

  const needsAssets = /资产|主机|网段|出口|ip|归属/.test(text.toLowerCase())
  const enabledAssetTypes = needsAssets || fromTemplate.some((t) => t.includes('asset') || t === 'search_assets')
    ? (bestTpl.form?.enabled_asset_types || [])
    : []

  const nameGuess = bestTpl.name
  const roleLine = text.split('\n')[0].slice(0, 300) || bestTpl.form?.description || ''

  const toolReasons = { ...bestTpl.tool_hints }
  Object.assign(toolReasons, fromText.reasons)

  return {
    templateId: bestTpl.id,
    template: bestTpl,
    name: nameGuess,
    roleLine,
    greeting: bestTpl.form?.greeting || '',
    enabledTools,
    enabledKbs,
    enabledAssetTypes,
    toolReasons,
    missingTools,
    suggestedTest: SCENARIO_TESTS[bestTpl.id] || '你好，请介绍一下你能做什么',
    summary: enabledTools.length
      ? `已根据描述匹配「${bestTpl.name}」场景，自动选配 ${enabledTools.length} 个工具。`
      : `已匹配场景「${bestTpl.name}」，但平台暂无对应工具，请稍后添加或展开选手动挂载。`,
  }
}

export const DESCRIPTION_EXAMPLES = [
  '帮我做一个告警研判助手，能查白名单、资产和威胁情报',
  '我需要封禁决策智能体，能查历史封禁并自动计算封禁时长',
  '做一个资产分析助手，能查资产也能从知识库梳理入库',
]

export const AGENT_QUICK_DRAFT_KEY = 'soar:agent:quick-draft'

/**
 * 从 DSL / 团队模板载入快速创建计划
 * @param {object} dsl Agent DSL 文档
 * @param {{ toolOptions: Array, kbOptions: Array }} ctx
 */
export function planAgentFromDsl(dsl, ctx = {}) {
  const toolOptions = ctx.toolOptions || []
  const kbOptions = ctx.kbOptions || []
  const availableNames = new Set(toolOptions.map((t) => t.value))

  let bestTpl = AGENT_TEMPLATES[0]
  let bestOverlap = -1
  for (const tpl of AGENT_TEMPLATES) {
    const rec = getTemplateRecommendedTools(tpl)
    const overlap = rec.filter((n) => (dsl.enabled_tools || []).includes(n)).length
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestTpl = tpl
    }
  }

  const enabledTools = (dsl.enabled_tools || []).filter((n) => availableNames.has(n))
  const enabledKbs = (dsl.enabled_kbs || [])
    .map(String)
    .filter((id) => kbOptions.some((k) => k.value === id))

  const toolReasons = { ...bestTpl.tool_hints, _import: '来自团队模板 / DSL 导入' }

  return {
    templateId: bestTpl.id,
    template: bestTpl,
    name: dsl.name || bestTpl.name,
    roleLine: (dsl.system_prompt || '').split('\n')[0].slice(0, 300),
    greeting: dsl.greeting || bestTpl.form?.greeting || '',
    enabledTools,
    enabledKbs,
    enabledAssetTypes: dsl.enabled_asset_types || bestTpl.form?.enabled_asset_types || [],
    toolReasons,
    missingTools: (dsl.enabled_tools || []).filter((n) => !availableNames.has(n)),
    suggestedTest: SCENARIO_TESTS[bestTpl.id] || '你好，请介绍一下你能做什么',
    summary: `已从 DSL/团队模板载入「${dsl.name || bestTpl.name}」，选配 ${enabledTools.length} 个工具。`,
    modelConfigId: dsl.model_config_id != null ? String(dsl.model_config_id) : '',
    engine: dsl.engine || bestTpl.form?.engine || 'hermes',
    toolConfigs: dsl.tool_configs || bestTpl.form?.tool_configs || {},
  }
}
