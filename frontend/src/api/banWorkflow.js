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
  // 批量删除封禁记录（仅 admin；生效中且已下发设备的记录先联动设备解封，失败记录保留）
  batchDeleteBannedIps: (ids) => request('/ban-workflow/banned-ips/batch-delete', {
    method: 'POST', body: { ids },
  }),
  // 删除审批工单（仅 admin）
  deleteApproval: (id) => request(`/ban-workflow/approvals/${id}`, { method: 'DELETE' }),
  // 安博通阻断器黑名单列表（仅 admin）：设备侧实时黑名单，分页拉取
  anbotongBlacklist: (page = 1, count = 50) =>
    request(`/ban-workflow/anbotong/blacklist?page=${page}&count=${count}`),
  // 安博通黑名单单个 IP 精确查询（仅 admin）：404=未封禁属业务结果，异常按 502 报错
  anbotongBlacklistQuery: (ip) =>
    request(`/ban-workflow/anbotong/blacklist/query?ip=${encodeURIComponent(ip)}`),
  // 安博通黑名单行内解封：从设备移除条目；设备 404 按幂等成功处理
  unbanAnbotongBlacklist: (ip, reason) =>
    request(`/ban-workflow/anbotong/blacklist/unban?ip=${encodeURIComponent(ip)}`, {
      method: 'POST', body: { reason },
    }),
  // 资产匹配预检（手动封禁弹窗）：双数据源并行（资产发现 + 资产清单），
  // 匹配规则与工单安全上下文完全同口径（发现优先、按来源去重）
  assetMatch: (ips) =>
    request(`/ban-workflow/asset-match?ips=${encodeURIComponent(ips.join(','))}`),
  // 同步安博通封禁：下发前的资产匹配预览（不产生设备调用）
  syncPreview: (ids, deviceId = null) => request('/ban-workflow/banned-ips/sync-preview', {
    method: 'POST', body: { ids, device_id: deviceId },
  }),
  // 确认同步安博通封禁（仅 pending_sync 记录会真正下发）
  syncBans: (ids, deviceId = null) => request('/ban-workflow/banned-ips/sync', {
    method: 'POST', body: { ids, device_id: deviceId },
  }),
  // 导出封禁记录 CSV（支持全部/筛选/选中 + 字段选择；时长按天）
  exportBannedIpsCsv: async ({ ids, status, ip, fields } = {}) => {
    const params = new URLSearchParams()
    if (Array.isArray(ids) && ids.length) params.set('ids', ids.join(','))
    else {
      if (status) params.set('status', status)
      if (ip) params.set('ip', ip)
    }
    if (Array.isArray(fields) && fields.length) params.set('fields', fields.join(','))
    const query = params.toString()
    const resp = await fetch(`/api/v1/ban-workflow/banned-ips/export/csv${query ? `?${query}` : ''}`, {
      headers: { ...authHeader() },
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.detail || `导出失败: HTTP ${resp.status}`)
    }
    await downloadCsv(resp, `ban_workbench_banned_ips_${new Date().toISOString().slice(0, 10)}.csv`)
  },
  // 导入 CSV/Excel 封禁记录（仅入库待同步，不自动下发）
  // onProgress: ({ phase, percent, loaded, total }) => void
  importBannedIpsWithProgress: (file, onProgress) => {
    return new Promise((resolve, reject) => {
      const formData = new FormData()
      formData.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/v1/ban-workflow/banned-ips/import/csv')
      const token = localStorage.getItem('soar_token')
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress({
            phase: 'uploading',
            percent: Math.round((e.loaded / e.total) * 100),
            loaded: e.loaded,
            total: e.total,
          })
        }
      }
      xhr.upload.onload = () => onProgress?.({ phase: 'processing' })
      xhr.onload = () => {
        let data = null
        try { data = JSON.parse(xhr.responseText) } catch { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.({ phase: 'done' })
          resolve(data)
        } else {
          onProgress?.({ phase: 'error' })
          if (xhr.status === 401 && !window.location.pathname.startsWith('/login')) {
            localStorage.removeItem('soar_token')
            localStorage.removeItem('soar_user')
            setTimeout(() => { window.location.href = '/login' }, 100)
          }
          const detail = (data && (data.detail || data.message)) || `HTTP ${xhr.status}`
          reject(new Error(`导入失败：${detail}`))
        }
      }
      xhr.onerror = () => {
        onProgress?.({ phase: 'error' })
        reject(new Error('网络错误，导入失败'))
      }
      xhr.send(formData)
    })
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
