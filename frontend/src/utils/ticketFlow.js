// 工单流程前端工具：字段渲染类型、条件路由建议、字段值格式化展示

export const FIELD_TYPE_LABELS = {
  text: '单行文本',
  textarea: '富文本',
  number: '数字',
  datetime: '日期时间',
  select: '下拉选择',
  switch: '是否开关',
  ip: 'IP 地址',
  url: 'URL',
  file: '附件',
  reference: '引用联动',
  duration: '时长',
}

// ===== 时长字段（与后端 parse_duration 格式一致："永久" / "30天" / "12小时" / "45分钟"） =====
export const DURATION_UNITS = ['分钟', '小时', '天']

// 存储值 → 表单部件 { permanent, num, unit }
export function durationToParts(value) {
  const s = String(value ?? '').trim()
  if (s === '永久') return { permanent: true, num: '', unit: '天' }
  const m = s.match(/^(\d+(?:\.\d+)?)(分钟|小时|天)$/)
  if (!m) return { permanent: false, num: '', unit: '天' }
  return { permanent: false, num: m[1], unit: m[2] }
}

// 表单部件 → 存储值（未填/数值非法返回空串，必填校验由后端兜底）
export function durationFromParts({ permanent, num, unit }) {
  if (permanent) return '永久'
  // 数值需为有效数字，防止输入框非法字符拼出如 "abc天" 的存储值
  if (!num || Number.isNaN(Number(num))) return ''
  return `${num}${unit || '天'}`
}

// ===== 引用联动字段选项收集（与后端 collect_ref_options 一致） =====
// 从已提交记录（TicketNodeRecord 或 {field_values} 对象）按顺序去重收集被引用字段的值；
// nodes 接受快照对象 {nodes:[...]} 或节点数组
export function collectRefOptions(nodes, records) {
  const ns = Array.isArray(nodes) ? nodes : (nodes?.nodes || [])
  const defs = []
  ns.forEach((n) => {
    ;(n.fields || []).forEach((f) => {
      if (f.type === 'reference') defs.push(f)
      ;(f.rules || []).forEach((r) => (r.fields || []).forEach((rf) => {
        if (rf.type === 'reference') defs.push(rf)
      }))
    })
  })
  const opts = {}
  defs.forEach((d) => { opts[d.key] = [] })
  ;(records || []).forEach((rec) => {
    const fv = rec?.field_values || {}
    defs.forEach((d) => {
      ;(d.ref_fields || []).forEach((rk) => {
        const v = fv[rk]
        if (v === null || v === undefined || typeof v === 'boolean') return
        const s = String(v).trim()
        if (s && !opts[d.key].includes(s)) opts[d.key].push(s)
      })
    })
  })
  return opts
}

// 字段定义（key → label）映射，用于详情只读展示；含匹配规则下的扩展字段
export function fieldDefMap(fields) {
  const m = {}
  ;(fields || []).forEach((f) => {
    m[f.key] = f
    ;(f.rules || []).forEach((r) => (r.fields || []).forEach((rf) => { m[rf.key] = rf }))
  })
  return m
}

// 条件操作符（与后端 COND_OPS 一致）
export const COND_OP_OPTIONS = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'lt', label: '小于' },
  { value: 'in', label: '属于' },
  { value: 'contains', label: '包含' },
]
const COND_OP_SET = new Set(COND_OP_OPTIONS.map((o) => o.value))
export const isCondOp = (op) => COND_OP_SET.has(op)

// 条件路由 when 归一化：旧单条件 {field,op,value} → {logic:'and', conds:[该条件]}；
// 新多条件 {logic:'and'|'or', conds:[{field,op,value},...]}。编辑器与评估共用
export function normWhen(when) {
  if (!when || typeof when !== 'object') return { logic: 'and', conds: [] }
  if (Array.isArray(when.conds) && when.conds.length) {
    return { logic: when.logic === 'or' ? 'or' : 'and', conds: when.conds.filter(Boolean) }
  }
  if (when.field) return { logic: 'and', conds: [when] }
  return { logic: 'and', conds: [] }
}

// 条件摘要（画布连线 label 等展示用）：「风险等级 ∈ 高危,严重 且 次数 > 10」
export function condText(when, { max = 2 } = {}) {
  const { logic, conds } = normWhen(when)
  const OP = { eq: '=', ne: '≠', gt: '>', lt: '<', in: '∈', contains: '包含' }
  const parts = conds.map((c) => `${c.field || '?'} ${OP[c.op || 'eq'] || '='} ${c.value ?? '?'}`)
  if (!parts.length) return '未配置条件'
  const sep = logic === 'or' ? ' 或 ' : ' 且 '
  return parts.length > max ? `${parts.slice(0, max).join(sep)} …` : parts.join(sep)
}

// 条件路由评估（与后端 suggest_route 保持一致：布尔值归一化为 是/否；
// gt/lt 优先数值比较、非数值退化为字符串比较；in 按中英文逗号分隔多值任一命中）
function _norm(v) {
  if (typeof v === 'boolean') return v ? '是' : '否'
  return v
}

function evalCond(cond, fieldValues) {
  const actual = _norm(fieldValues?.[cond.field])
  if (actual === undefined || actual === null || String(actual).trim() === '') return false
  const expected = _norm(cond.value)
  const op = cond.op || 'eq'
  const sa = String(actual)
  const se = expected === undefined || expected === null ? '' : String(expected)
  if (op === 'eq') return sa === se
  if (op === 'ne') return sa !== se
  if (op === 'contains') return se.trim() !== '' && sa.includes(se)
  if (op === 'in') return se.split(/[,，]/).map((s) => s.trim()).filter(Boolean).includes(sa)
  if (op === 'gt' || op === 'lt') {
    if (se.trim() === '') return false
    const fa = Number(sa)
    const fb = Number(se)
    if (!Number.isNaN(fa) && !Number.isNaN(fb)) return op === 'gt' ? fa > fb : fa < fb
    return op === 'gt' ? sa > se : sa < se
  }
  return false
}

// 返回 { options: [{to, label, when}], suggested: 命中条件的建议去向 key }
export function evalRoutes(routes, fieldValues) {
  const options = (routes || []).filter((r) => r && r.to).map((r) => ({ ...r }))
  let suggested = null
  for (const r of options) {
    if (!r.when) continue
    const { logic, conds } = normWhen(r.when)
    if (!conds.length) continue
    const matched = logic === 'or'
      ? conds.some((c) => evalCond(c, fieldValues))
      : conds.every((c) => evalCond(c, fieldValues))
    if (matched) { suggested = r.to; break }
  }
  return { options, suggested }
}

// 字段值展示格式化：布尔 → 是/否；空 → '--'；附件 → 文件名
export function fieldValueText(field, value) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

// 展开节点字段定义：顶层字段 + 全部匹配规则下的扩展字段
//（扩展字段的值与普通字段平铺同层，default 初始化 / key 唯一性按平铺集合处理）
export function flatFieldDefs(fields) {
  const out = []
  ;(fields || []).forEach((f) => {
    out.push(f)
    ;(f.rules || []).forEach((r) => (r.fields || []).forEach((rf) => out.push(rf)))
  })
  return out
}

// 匹配规则命中（与后端 matched_rule_fields 保持一致）：
// 返回下拉/开关字段当前值命中规则的扩展字段列表；值未填写或未命中返回 []
export function matchedRuleFields(field, value) {
  const rules = field?.rules
  if (!Array.isArray(rules) || !rules.length) return []
  const actual = _norm(value)
  if (actual === undefined || actual === null || actual === '') return []
  for (const r of rules) {
    if (!r || r.value === undefined || r.value === null || r.value === '') continue
    if (String(_norm(r.value)) === String(actual)) {
      return (r.fields || []).filter((x) => x && x.key)
    }
  }
  return []
}

// ===== 版本 diff（节点级摘要，纯前端计算） =====
// 对比「版本存档 → 当前内容」，用于版本历史抽屉：按节点 key 对齐，
// 输出新增/移除节点与同 key 节点的变更明细（名称/分组/字段数/路由数），
// 避免引入文本 diff 库；流程级（发起分组/抄送）只报数量变化。
// a/b 均为 {name, description, nodes: {start_groups, cc_targets, nodes: [...]}}
export function diffFlow(a, b) {
  const an = a?.nodes?.nodes || []
  const bn = b?.nodes?.nodes || []
  const am = new Map(an.map((n) => [n.key, n]))
  const bm = new Map(bn.map((n) => [n.key, n]))
  const added = bn.filter((n) => !am.has(n.key)).map((n) => ({ key: n.key, name: n.name || n.key }))
  const removed = an.filter((n) => !bm.has(n.key)).map((n) => ({ key: n.key, name: n.name || n.key }))
  const changed = []
  for (const n of an) {
    const m = bm.get(n.key)
    if (!m) continue
    const diffs = []
    if ((n.name || '') !== (m.name || '')) diffs.push(`名称「${n.name || '空'}」→「${m.name || '空'}」`)
    if ((n.group_id ?? '') !== (m.group_id ?? '')) diffs.push('处理分组变更')
    const af = (n.fields || []).length
    const bf = (m.fields || []).length
    if (af !== bf) diffs.push(`字段 ${af} → ${bf}`)
    if ((n.routes || []).length !== (m.routes || []).length) {
      diffs.push(`路由 ${(n.routes || []).length} → ${(m.routes || []).length}`)
    }
    if (diffs.length) changed.push({ key: n.key, name: m.name || n.key, diffs })
  }
  // 流程级：发起分组 / 抄送 数量变化
  const sgA = (a?.nodes?.start_groups || []).length
  const sgB = (b?.nodes?.start_groups || []).length
  const ccA = (a?.nodes?.cc_targets || []).length
  const ccB = (b?.nodes?.cc_targets || []).length
  const general = []
  if (sgA !== sgB) general.push(`发起分组 ${sgA} → ${sgB}`)
  if (ccA !== ccB) general.push(`固定抄送 ${ccA} → ${ccB}`)
  if ((a?.name || '') !== (b?.name || '')) general.push(`模板名称「${a?.name || '空'}」→「${b?.name || '空'}」`)
  if ((a?.description || '') !== (b?.description || '')) general.push('模板描述变更')
  const identical = !added.length && !removed.length && !changed.length && !general.length
  return { added, removed, changed, general, identical }
}
