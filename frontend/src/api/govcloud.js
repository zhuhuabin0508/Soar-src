import { request } from './client'

function authHeader() {
  const token = localStorage.getItem('soar_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export const govCloudApi = {
  meta: () => request('/govcloud/meta'),
  summary: () => request('/govcloud/summary'),
  list: (params = {}) => {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    })
    return request(`/govcloud/assets?${qs.toString()}`)
  },
  get: (resourceType, id) => request(`/govcloud/assets/${encodeURIComponent(resourceType)}/${id}`),
  consistency: (resource_type) => request(`/govcloud/consistency?resource_type=${encodeURIComponent(resource_type)}`),
  // 导出 CSV：直接触发浏览器下载（keyword/module 与列表搜索口径一致，name 用于文件名）
  exportCsv: async (resourceType, keyword = '', name = '', module = '') => {
    const qs = new URLSearchParams()
    qs.set('resource_type', resourceType)
    if (keyword) qs.set('keyword', keyword)
    if (module) qs.set('module', module)
    const resp = await fetch(`/api/v1/govcloud/export?${qs.toString()}`, { headers: { ...authHeader() } })
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
    a.download = `${name || resourceType}_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  },
  batches: (resource_type) => {
    const qs = resource_type ? `?resource_type=${encodeURIComponent(resource_type)}` : ''
    return request(`/govcloud/batches${qs}`)
  },
  // 青藤主机同步：device_ids 为空同步全部已启用的青藤设备
  // mode: full 全量对齐（删除青藤平台已不存在的主机）/ incremental 增量
  syncQingteng: (deviceIds = [], mode = 'full') => request('/govcloud/qingteng/sync', {
    method: 'POST',
    body: JSON.stringify({ device_ids: deviceIds, mode: mode === 'incremental' ? 'incremental' : 'full' }),
  }),
  // 天擎终端同步：device_ids 为空同步全部已启用的天擎设备
  syncTianqing: (deviceIds = [], mode = 'full') => request('/govcloud/tianqing/sync', {
    method: 'POST',
    body: JSON.stringify({ device_ids: deviceIds, mode: mode === 'incremental' ? 'incremental' : 'full' }),
  }),
  // 青藤组件异步同步：返回每台设备的批次 ID，随后轮询 componentSyncStatus
  syncQingtengComponents: ({ deviceIds = [], mode = 'full', sources = [] } = {}) => request(
    '/govcloud/qingteng/component-sync',
    {
      method: 'POST',
      body: JSON.stringify({
        device_ids: deviceIds,
        mode: mode === 'incremental' ? 'incremental' : 'full',
        sources,
      }),
    },
  ),
  componentSyncStatus: ({ batchId, deviceId } = {}) => {
    const qs = new URLSearchParams()
    if (batchId) qs.set('batch_id', String(batchId))
    if (deviceId) qs.set('device_id', String(deviceId))
    return request(`/govcloud/qingteng/component-sync/status?${qs.toString()}`)
  },
  // 青藤资产明细（账号/用户组/Web应用/Web站点）异步同步
  syncQingtengModules: ({ deviceIds = [], mode = 'full', modules = [] } = {}) => request(
    '/govcloud/qingteng/module-sync',
    {
      method: 'POST',
      body: JSON.stringify({
        device_ids: deviceIds,
        mode: mode === 'incremental' ? 'incremental' : 'full',
        modules,
      }),
    },
  ),
  moduleSyncStatus: ({ batchId, deviceId } = {}) => {
    const qs = new URLSearchParams()
    if (batchId) qs.set('batch_id', String(batchId))
    if (deviceId) qs.set('device_id', String(deviceId))
    return request(`/govcloud/qingteng/module-sync/status?${qs.toString()}`)
  },
  // 实时查询（不落库）：模块列表 + 按条件查询
  realtimeModules: (group = '') => {
    const qs = new URLSearchParams()
    if (group) qs.set('group', group)
    return request(`/govcloud/qingteng/realtime-modules?${qs.toString()}`)
  },
  realtimeQuery: ({
    deviceId, module, keyword = '', agentId = '', ip = '', hostname = '',
    port = '', osType = '', limit = 50,
  }) => {
    const qs = new URLSearchParams()
    qs.set('device_id', String(deviceId))
    qs.set('module', module)
    if (keyword) qs.set('keyword', keyword)
    if (agentId) qs.set('agent_id', agentId)
    if (ip) qs.set('ip', ip)
    if (hostname) qs.set('hostname', hostname)
    if (port) qs.set('port', String(port))
    if (osType) qs.set('os_type', osType)
    qs.set('limit', String(limit))
    return request(`/govcloud/qingteng/realtime-query?${qs.toString()}`)
  },
  // CVE 影响面：按 CVE 实时查询青藤命中的主机与命中证据
  cveHosts: ({ deviceId, cve, refresh = false }) => {
    const qs = new URLSearchParams()
    qs.set('device_id', String(deviceId))
    qs.set('cve', cve)
    if (refresh) qs.set('refresh', 'true')
    // 首次查询需要构建青藤风险索引（拉取漏洞/补丁详情），放宽超时
    return request(`/govcloud/qingteng/cve-hosts?${qs.toString()}`, { timeoutMs: 180000 })
  },
  importExcel: (file, resource_type, onProgress, mode = 'full') => new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file)
    const qs = new URLSearchParams()
    if (resource_type) qs.set('resource_type', resource_type)
    qs.set('mode', mode === 'incremental' ? 'incremental' : 'full')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/v1/govcloud/import?${qs.toString()}`)
    const headers = authHeader()
    if (headers.Authorization) xhr.setRequestHeader('Authorization', headers.Authorization)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({ phase: 'uploading', percent: Math.round((e.loaded / e.total) * 100) })
      }
    }
    xhr.upload.onload = () => {
      if (onProgress) onProgress({ phase: 'processing' })
    }
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress({ phase: 'done' })
        resolve(data)
      } else {
        if (onProgress) onProgress({ phase: 'error' })
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
      if (onProgress) onProgress({ phase: 'error' })
      reject(new Error('网络错误，导入失败'))
    }
    xhr.send(fd)
  }),
}
