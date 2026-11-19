/**
 * 工单智能体研判依据 → 五模块字段映射。
 *
 * 智能体 ``agent.reasons`` 约定按【处置建议】【监测要点】【情报现状与触发条件】
 * 【责任归属】【协同处置】五个模块组织。本模块只做「定位与切分」，不改写任何
 * 内容：模块正文原样保留（含换行、标点、层级），仅去除首尾空白。
 */

/** 固定模块名与展示顺序（与智能体输出模块名严格一致，不得增减或改名） */
export const AGENT_REASON_MODULES = [
  '处置建议',
  '监测要点',
  '情报现状与触发条件',
  '责任归属',
  '协同处置',
]

// 模块前缀定位：容忍括号内空白、序号（如「1. 【处置建议】」）与全角/半角差异
const MODULE_PATTERN = new RegExp(
  `【\\s*(${AGENT_REASON_MODULES.join('|')})\\s*】`,
  'g',
)

/**
 * 按模块前缀切分研判依据。
 *
 * @param {string[]|string|null|undefined} reasons 智能体输出（数组或纯文本）
 * @returns {{ modules: Record<string, string>, matched: boolean }}
 *   ``modules`` 键固定为五个模块名（缺失为空串）；``matched`` 表示是否识别到任一模块。
 */
export function parseAgentReasonModules(reasons) {
  const modules = {}
  AGENT_REASON_MODULES.forEach((name) => { modules[name] = '' })

  const text = Array.isArray(reasons)
    ? reasons.map((r) => (r == null ? '' : String(r))).join('\n')
    : (reasons == null ? '' : String(reasons))
  if (!text.trim()) return { modules, matched: false }

  // 收集所有模块前缀位置；无前缀（旧数据/异常输出）时原样返回空模块
  const hits = []
  MODULE_PATTERN.lastIndex = 0
  let m = MODULE_PATTERN.exec(text)
  while (m !== null) {
    hits.push({ name: m[1], bodyStart: m.index + m[0].length, index: m.index })
    m = MODULE_PATTERN.exec(text)
  }
  if (!hits.length) return { modules, matched: false }

  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length
    // 相邻模块之间的序号/项目符号（如「2）」「2.」「-」）不属于上一模块正文，先剥离
    const body = text
      .slice(hit.bodyStart, end)
      .replace(/\n?\s*(?:\d+\s*[.、)）]|[-*•])\s*$/, '')
      .trim()
    // 同一模块重复出现时按出现顺序拼接，保证不丢内容
    modules[hit.name] = modules[hit.name] ? `${modules[hit.name]}\n${body}` : body
  })

  return { modules, matched: true }
}
