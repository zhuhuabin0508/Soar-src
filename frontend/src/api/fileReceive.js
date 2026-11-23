// 跨系统文件接收 API
import { request } from './client'

const BASE = '/api/v1/file-receive'

function qs(params = {}) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  })
  const text = search.toString()
  return text ? `?${text}` : ''
}

async function downloadFile(id, filename) {
  const token = localStorage.getItem('soar_token')
  const res = await fetch(`${BASE}/records/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let detail = '下载失败'
    try {
      const d = await res.json()
      detail = d.detail || d.message || detail
    } catch { /* ignore */ }
    throw new Error(detail)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const fileReceiveApi = {
  list: (params) => request(`/file-receive/records${qs(params)}`),
  detail: (id) => request(`/file-receive/records/${id}`),
  stats: () => request('/file-receive/stats'),
  meta: () => request('/file-receive/meta'),
  retry: (id) => request(`/file-receive/records/${id}/retry`, { method: 'POST' }),
  remove: (id) => request(`/file-receive/records/${id}`, { method: 'DELETE' }),
  download: downloadFile,

  sources: () => request('/file-receive/sources'),
  createSource: (body) => request('/file-receive/sources', { method: 'POST', body }),
  updateSource: (id, body) => request(`/file-receive/sources/${id}`, { method: 'PUT', body }),
  deleteSource: (id) => request(`/file-receive/sources/${id}`, { method: 'DELETE' }),
  rotateSecret: (id) => request(`/file-receive/sources/${id}/rotate-secret`, { method: 'POST' }),
}
