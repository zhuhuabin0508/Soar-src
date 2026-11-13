// IP地址信息库 API client（查询/导入/批次）
import { request } from './client'

function authHeader() {
  const token = localStorage.getItem('soar_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function buildQuery(params = {}) {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  })
  return qs.toString()
}

export const ipLibraryApi = {
  // 4 库定义 + 概览统计（网段数/覆盖 IP 数/最近批次）
  meta: () => request('/ip-library/meta'),
  // 单 IP 跨 4 库点查（核心查询）
  lookup: (ip) => request(`/ip-library/lookup?ip=${encodeURIComponent(ip)}`),
  // 批量 IP 跨 4 库点查（工单安全上下文批量校验，单次最多 100 个）
  lookupBatch: (ips = []) => request(`/ip-library/lookup-batch?ips=${encodeURIComponent((ips || []).join(','))}`),
  // 条件查询结果分页（IP/网段/关键词自动识别 + 等值筛选）
  list: (params = {}) => {
    const qs = buildQuery(params)
    return request(`/ip-library/records${qs ? `?${qs}` : ''}`)
  },
  // 批次历史
  batches: (libraryType = '', limit = 20) => {
    const qs = buildQuery({ library_type: libraryType, limit })
    return request(`/ip-library/batches${qs ? `?${qs}` : ''}`)
  },
  // 单批次进度（导入轮询用）
  batch: (batchId) => request(`/ip-library/batches/${encodeURIComponent(batchId)}`),
  // 导出当前查询结果 CSV：浏览器直接下载
  exportCsv: async (params = {}, name = '') => {
    const qs = buildQuery(params)
    const resp = await fetch(`/api/v1/ip-library/export${qs ? `?${qs}` : ''}`, { headers: { ...authHeader() } })
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`
      try {
        const d = await resp.json()
        detail = d.detail || d.message || detail
      } catch { /* ignore */ }
      throw new Error(`导出失败：${detail}`)
    }
    const blob = await resp.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `${name || 'ip_library'}_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  },
  // 上传 CSV：立即返回 batch_id，进度由 batches/{id} 轮询（Celery 异步导入）
  importCsv: (file, libraryType, mode = 'full') => new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file)
    const qs = buildQuery({ library_type: libraryType, mode })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/v1/ip-library/import?${qs}`)
    const headers = authHeader()
    if (headers.Authorization) xhr.setRequestHeader('Authorization', headers.Authorization)
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
      } else {
        if (xhr.status === 401 && !window.location.pathname.startsWith('/login')) {
          localStorage.removeItem('soar_token')
          localStorage.removeItem('soar_user')
          setTimeout(() => { window.location.href = '/login' }, 100)
        }
        const detail = (data && (data.detail || data.message)) || `HTTP ${xhr.status}`
        reject(new Error(detail))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.send(fd)
  }),
}
