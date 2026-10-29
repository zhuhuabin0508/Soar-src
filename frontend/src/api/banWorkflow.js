// 告警自动封禁工作流 API：实例管理 / 审批中心 / 封禁工作台 / 触发规则 / 熔断 / 统计
import request from './request'

function qs(params = {}) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== '' && v != null && v !== 0 && !(Array.isArray(v) && v.length === 0)) search.set(k, v)
  })
  const s = search.toString()
  return s ? `?${s}` : ''
}

// 从 localStorage 读取 auth token（CSV 下载/上传需原生 fetch，与 client.js 同源）
function authHeader() {
  const token = localStorage.getItem('soar_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// 触发浏览器下载响应中的 CSV 文件
async function downloadCsv(resp, filename) {
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export const banWorkflowApi = {
  // ===== 实例管理 =====
  instances: (params = {}) => request(`/ban-workflow/instances${qs(params)}`),
  instance: (id) => request(`/ban-workflow/instances/${id}`),
  cancelInstance: (id, reason) => request(`/ban-workflow/instances/${id}/cancel`, {
    method: 'POST', body: { reason },
  }),

  // ===== 审批中心 =====
  approvals: (params = {}) => request(`/ban-workflow/approvals${qs(params)}`),
  approval: (id) => request(`/ban-workflow/approvals/${id}`),
  approveTicket: (id, comment) => request(`/ban-workflow/approvals/${id}/approve`, {
    method: 'POST', body: { comment },
  }),
  rejectTicket: (id, reason) => request(`/ban-workflow/approvals/${id}/reject`, {
    method: 'POST', body: { reason },
  }),
  escalateTicket: (id, comment) => request(`/ban-workflow/approvals/${id}/escalate`, {
    method: 'POST', body: { comment },
  }),

  // ===== 封禁工作台 =====
  bannedIps: (params = {}) => request(`/ban-workflow/banned-ips${qs(params)}`),
  bannedIp: (id) => request(`/ban-workflow/banned-ips/${id}`),
  unbanIp: (id, reason) => request(`/ban-workflow/banned-ips/${id}/unban`, {
    method: 'POST', body: { reason },
  }),
  // 手动发起封禁（来源标记 manual）
  createManualBan: (data) => request('/ban-workflow/banned-ips', { method: 'POST', body: data }),
  // 删除封禁记录（仅 admin）
  deleteBannedIp: (id) => request(`/ban-workflow/banned-ips/${id}`, { method: 'DELETE' }),
  // 删除审批工单（仅 admin）
  deleteApproval: (id) => request(`/ban-workflow/approvals/${id}`, { method: 'DELETE' }),
  // 导出封禁记录 CSV（触发浏览器下载；时长按天）
  exportBannedIpsCsv: async () => {
    const resp = await fetch('/api/v1/ban-workflow/banned-ips/export/csv', {
      headers: { ...authHeader() },
    })
    if (!resp.ok) throw new Error(`导出失败: HTTP ${resp.status}`)
    await downloadCsv(resp, `ban_workbench_banned_ips_${new Date().toISOString().slice(0, 10)}.csv`)
  },
  // 导入 CSV 封禁记录（逐行下发封禁；时长按天，支持小数如 0.5=12小时）
  importBannedIpsCsv: async (file) => {
    const formData = new FormData()
    formData.append('file', file)
    const resp = await fetch('/api/v1/ban-workflow/banned-ips/import/csv', {
      method: 'POST',
      headers: { ...authHeader() },
      body: formData,
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.detail || `导入失败: HTTP ${resp.status}`)
    }
    return resp.json()
  },
  // 下载 CSV 导入模板（含表头与示例行）
  downloadBannedIpTemplate: async () => {
    const resp = await fetch('/api/v1/ban-workflow/banned-ips/import/template', {
      headers: { ...authHeader() },
    })
    if (!resp.ok) throw new Error(`下载模板失败: HTTP ${resp.status}`)
    await downloadCsv(resp, 'ban_workbench_import_template.csv')
  },

  // ===== 触发规则 =====
  rules: () => request('/ban-workflow/rules'),
  createRule: (data) => request('/ban-workflow/rules', { method: 'POST', body: data }),
  updateRule: (id, data) => request(`/ban-workflow/rules/${id}`, { method: 'PUT', body: data }),
  deleteRule: (id) => request(`/ban-workflow/rules/${id}`, { method: 'DELETE' }),

  // ===== 熔断与统计 =====
  circuitBreaker: () => request('/ban-workflow/circuit-breaker'),
  resetCircuitBreaker: () => request('/ban-workflow/circuit-breaker/reset', { method: 'POST' }),
  stats: () => request('/ban-workflow/stats'),
}

export default banWorkflowApi
