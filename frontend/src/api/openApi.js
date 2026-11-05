// API 开放平台管理 API（应用/密钥/授权 + 调用统计 + 调用日志）
import request from './client'

export const openAdminApi = {
  // 应用管理
  listApps: () => request('/open-admin/apps'),
  createApp: (data) => request('/open-admin/apps', { method: 'POST', body: data }),
  updateApp: (id, data) => request(`/open-admin/apps/${id}`, { method: 'PUT', body: data }),
  deleteApp: (id) => request(`/open-admin/apps/${id}`, { method: 'DELETE' }),
  // 重置密钥：响应中一次性返回新 access_key + secret
  rotateSecret: (id) => request(`/open-admin/apps/${id}/rotate-secret`, { method: 'POST' }),
  // 资源目录（可授权的开放资源）
  listResources: () => request('/open-admin/resources'),
  // 调用统计（period: 24h / 7d）
  stats: (period = '24h') => request(`/open-admin/stats?period=${encodeURIComponent(period)}`),
  // 调用日志
  callLogs: (params = {}) => {
    const qs = new URLSearchParams()
    if (params.app_id) qs.set('app_id', params.app_id)
    if (params.resource_code) qs.set('resource_code', params.resource_code)
    if (params.status_group && params.status_group !== 'all') qs.set('status_group', params.status_group)
    if (params.client_ip) qs.set('client_ip', params.client_ip)
    if (params.start_time) qs.set('start_time', params.start_time)
    if (params.end_time) qs.set('end_time', params.end_time)
    qs.set('page', params.page || 1)
    qs.set('page_size', params.page_size || 20)
    return request(`/open-admin/call-logs?${qs.toString()}`)
  },
}

export default openAdminApi
