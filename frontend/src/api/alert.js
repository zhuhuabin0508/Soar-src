// 告警列表 API：分页筛选 / 详情 / 统计 / CSV 导出
import { request } from './client'

function _qs(params = {}) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      search.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
  })
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const alertApi = {
  // 分页列表：筛选排序分页全部后端执行
  // filters: { start_time, end_time, risk_levels[], attack_states[], deal_statuses[],
  //            stages[], directions[], keyword, parse_status, device_type, sort, order }
  list: (page, pageSize, filters = {}) => request(`/alerts${_qs({ page, page_size: pageSize, ...filters })}`),

  // 详情：JSON 字段已反序列化（extensions/raw_data/attck_technique 等为对象）
  detail: (id) => request(`/alerts/${id}`),

  // 顶部统计卡片
  stats: () => request('/alerts/stats'),

  // CSV 导出（按当前筛选，POST body；返回 Blob）
  async export(filters = {}) {
    const token = localStorage.getItem('soar_token')
    const res = await fetch('/api/v1/alerts/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/csv',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(filters),
    })
    if (!res.ok) {
      let msg = '导出失败'
      try {
        const d = await res.json()
        msg = d.detail || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    return res.blob()
  },

  // 单条告警处置：变更状态 + 指派 + 备注
  handle: (id, body) => request(`/alerts/${id}/handle`, { method: 'POST', body }),

  // 批量处置
  batchHandle: (body) => request('/alerts/batch-handle', { method: 'POST', body }),

  // 处置时间线
  handleLogs: (id) => request(`/alerts/${id}/handle-logs`),
}

// 告警规则 API：规则 CRUD / 启停 / 拖拽排序 / 批量操作 / 命中记录 / 快速开始模板 / 样例测试
// 严格模式：解析成功的日志必须命中启用中的「产生告警 / 调整等级」规则（action=alert/adjust_level）才生成告警
// XDR 风格扩展：分组 / 草稿发布门禁 / 导入导出
export const alertRuleApi = {
  list: (params = {}) => request(`/alert-rules${_qs(params)}`),
  // 快速开始模板（空状态卡片，后端配置便于扩展）
  templates: () => request('/alert-rules/templates'),
  // 统计卡片：总数/启用数、今日生成、今日抑制、24h 无命中启用规则
  stats: () => request('/alert-rules/stats'),
  // 命中记录分页（命中日志抽屉；params: { rule_id, action, today, page, page_size }）
  hits: (params = {}) => request(`/alert-rules/hits${_qs(params)}`),
  create: (body) => request('/alert-rules', { method: 'POST', body }),
  update: (id, body) => request(`/alert-rules/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/alert-rules/${id}`, { method: 'DELETE' }),
  toggle: (id) => request(`/alert-rules/${id}/toggle`, { method: 'PUT' }),
  // 拖拽排序（全量规则 ID 顺序）
  reorder: (orderedIds) => request('/alert-rules/reorder', { method: 'PUT', body: { ordered_ids: orderedIds } }),
  // 批量操作（op: enable / disable / delete）
  batch: (ids, op) => request('/alert-rules/batch', { method: 'PUT', body: { ids, op } }),
  // 批量样例测试（最多 10 条；draft_rule 可携带未保存草稿按优先级参与匹配；只读不落库）
  test: (samples, draftRule = null) => request('/alert-rules/test', {
    method: 'POST',
    body: { samples, ...(draftRule ? { draft_rule: draftRule } : {}) },
  }),
  // 发布门禁：携带测试样例，服务端复验通过后 draft=0 上线
  publish: (id, testSamples) => request(`/alert-rules/${id}/publish`, {
    method: 'POST',
    body: { test_samples: testSamples },
  }),
  // JSON 导入（重名跳过）
  import: (rules) => request('/alert-rules/import', { method: 'POST', body: { rules } }),
  // JSON 导出（返回 Blob；传 ids 数组只导选中的规则，不传导全量）
  async export(ids = []) {
    const token = localStorage.getItem('soar_token')
    const qs = Array.isArray(ids) && ids.length
      ? `?ids=${ids.map((id) => encodeURIComponent(String(id))).join(',')}`
      : ''
    const res = await fetch(`/api/v1/alert-rules/export${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      let msg = '导出失败'
      try {
        const d = await res.json()
        msg = d.detail || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    return res.blob()
  },
}

// 告警规则分组 API：列表（含计数）/ 新建 / 重命名 / 删除（规则移入「其他」）
export const alertRuleGroupApi = {
  list: () => request('/alert-rule-groups'),
  create: (name) => request('/alert-rule-groups', { method: 'POST', body: { name } }),
  rename: (id, name) => request(`/alert-rule-groups/${id}`, { method: 'PUT', body: { name } }),
  remove: (id) => request(`/alert-rule-groups/${id}`, { method: 'DELETE' }),
}
