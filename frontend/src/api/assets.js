// 资产管理 API
import request from './client'

// 构造查询字符串（仅含非空参数）
function buildQuery(params = {}) {
  const qs = new URLSearchParams()
  if (params.type_code) qs.set('type_code', params.type_code)
  if (params.kb_id) qs.set('kb_id', params.kb_id)
  if (params.asset_type) qs.set('asset_type', params.asset_type)
  if (params.department) qs.set('department', params.department)
  if (params.criticality) qs.set('criticality', params.criticality)
  if (params.status) qs.set('status', params.status)
  if (params.source) qs.set('source', params.source)
  if (params.tag_id) qs.set('tag_id', params.tag_id)
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.sort_by) qs.set('sort_by', params.sort_by)
  if (params.order) qs.set('order', params.order)
  if (params.page) qs.set('page', params.page)
  if (params.page_size) qs.set('page_size', params.page_size)
  const query = qs.toString()
  return query ? `?${query}` : ''
}

// 从 localStorage 读取 auth token（与 client.js 一致）
function authHeader() {
  const token = localStorage.getItem('soar_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export const assetsApi = {
  // ===== 资产总览（可视化） =====
  // 返回 { total, templates, by_template, by_status, by_criticality, by_department, by_cloud, trend }
  overview: () => request('/assets/overview'),

  // ===== 资产清单（分页 + 筛选 + 关键词搜索 + 排序） =====
  list: (params = {}) => request(`/assets${buildQuery(params)}`),
  // 跨页全选：返回当前筛选条件下所有匹配资产 ID（不分页，上限 10000）
  listIds: (params = {}) => request(`/assets/ids${buildQuery(params)}`),
  // 部门/负责人/资产类型去重值（供 datalist 补全），可选 type_code 限定范围
  fieldOptions: (type_code) =>
    request(`/assets/field-options${type_code ? `?type_code=${encodeURIComponent(type_code)}` : ''}`),
  // 统计信息，可选 type_code 限定范围
  stats: (type_code) =>
    request(`/assets/stats${type_code ? `?type_code=${encodeURIComponent(type_code)}` : ''}`),
  // 单条详情
  get: (id) => request(`/assets/${id}`),
  // 资产变更历史（详情抽屉时间线用）
  listChanges: (id) => request(`/assets/${id}/changes`),
  // 手动新增（支持模板模式：{ type_code, fields } 或兼容模式：标准字段）
  create: (data) => request('/assets', { method: 'POST', body: data }),
  // 更新（支持模板模式：{ type_code?, fields } 或兼容模式）
  update: (id, data) => request(`/assets/${id}`, { method: 'PUT', body: data }),
  // 删除单条
  remove: (id) => request(`/assets/${id}`, { method: 'DELETE' }),
  // 批量删除（用 body 传 ID，避免全选所有匹配时 URL 超长）
  batchRemove: (ids) =>
    request('/assets', { method: 'DELETE', body: { ids } }),
  // 批量更新（fields: { criticality/department/owner/asset_type/location/status 子集 }）
  // 可选 add_tags/remove_tags: 标签 ID 数组（批量打标/取消标签）
  batchUpdate: (ids, fields, opts = {}) =>
    request('/assets/batch', {
      method: 'PATCH',
      body: {
        ids,
        fields,
        ...(opts.addTags ? { add_tags: opts.addTags } : {}),
        ...(opts.removeTags ? { remove_tags: opts.removeTags } : {}),
      },
    }),

  // ===== 资产类型模板 =====
  // 列出所有模板（按 sort_order 排序）
  listTemplates: () => request('/asset-templates'),
  // 获取单个模板详情
  getTemplate: (code) => request(`/asset-templates/${encodeURIComponent(code)}`),
  // 创建自定义模板
  createTemplate: (data) => request('/asset-templates', { method: 'POST', body: data }),
  // 更新模板
  updateTemplate: (code, data) =>
    request(`/asset-templates/${encodeURIComponent(code)}`, { method: 'PUT', body: data }),
  // 删除模板（预设模板不可删除）
  deleteTemplate: (code) =>
    request(`/asset-templates/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  // 导出类型模板为 JSON（codes 为空导出全部）
  exportTemplates: async (codes = []) => {
    const qs = new URLSearchParams()
    if (Array.isArray(codes) && codes.length > 0) qs.set('codes', codes.join(','))
    const query = qs.toString()
    const url = `/api/v1/asset-templates/export${query ? `?${query}` : ''}`
    const resp = await fetch(url, { headers: { ...authHeader() } })
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`
      try {
        const data = await resp.json()
        detail = data.detail || detail
      } catch { /* 非 JSON 错误响应 */ }
      throw new Error(`导出失败：${detail}`)
    }
    const blob = await resp.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = codes.length === 1
      ? `asset_template_${codes[0]}.json`
      : `asset_templates_${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  },
  // 导入类型模板：payload 为 { template } 或 { templates: [...] }
  importTemplates: (payload) =>
    request('/asset-templates/import', { method: 'POST', body: payload }),

  // ===== 资产自定义字段（全局共享）=====
  listCustomFields: () => request('/assets/custom-fields'),
  createCustomField: (data) => request('/assets/custom-fields', { method: 'POST', body: data }),
  deleteCustomField: (id) => request(`/assets/custom-fields/${id}`, { method: 'DELETE' }),

  // ===== 批量导入（CSV/Excel）=====
  // 上传文件导入资产，返回 {total, inserted, updated, skipped, errors}
  // type_code: 模板模式导入（按模板字段映射），不传则兼容模式
  importAssets: (file, strategy, type_code) => {
    const fd = new FormData()
    fd.append('file', file)
    const qs = new URLSearchParams()
    qs.set('conflict_strategy', strategy || 'skip')
    if (type_code) qs.set('type_code', type_code)
    return request(`/assets/import?${qs.toString()}`, { method: 'POST', body: fd })
  },
  // 带上传进度的导入（用 XMLHttpRequest 监听 upload progress）
  // onProgress 回调签名：({ phase, percent, loaded, total }) => void
  //   phase: 'uploading'（上传中，percent 真实） | 'processing'（服务器处理中） | 'done' | 'error'
  importAssetsWithProgress: (file, strategy, type_code, onProgress) => {
    return new Promise((resolve, reject) => {
      const fd = new FormData()
      fd.append('file', file)
      const qs = new URLSearchParams()
      qs.set('conflict_strategy', strategy || 'skip')
      if (type_code) qs.set('type_code', type_code)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/v1/assets/import?${qs.toString()}`)
      const token = localStorage.getItem('soar_token')
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      // 上传进度（文件字节传输）
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
      // 上传完成 → 进入服务器处理阶段
      xhr.upload.onload = () => {
        if (onProgress) onProgress({ phase: 'processing' })
      }
      xhr.onload = () => {
        let data = null
        try { data = JSON.parse(xhr.responseText) } catch { /* 非JSON响应 */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress({ phase: 'done' })
          resolve(data)
        } else {
          if (onProgress) onProgress({ phase: 'error' })
          // 401 未认证：清除凭证跳转登录（与 request 行为一致）
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
    })
  },
  // 下载导入模板（CSV），可选 type_code 按模板字段生成
  downloadImportTemplate: async (type_code) => {
    const qs = new URLSearchParams()
    if (type_code) qs.set('type_code', type_code)
    const query = qs.toString()
    const url = `/api/v1/assets/import-template${query ? `?${query}` : ''}`
    const resp = await fetch(url, { headers: { ...authHeader() } })
    if (!resp.ok) throw new Error(`下载模板失败: HTTP ${resp.status}`)
    const blob = await resp.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = type_code
      ? `asset_import_template_${type_code}.csv`
      : 'asset_import_template.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  },
  // 导出 CSV：直接触发浏览器下载
  // type_code: 按模板字段列导出该类型资产（可选）
  // ids: 仅导出指定资产（选中导出，可选数组）
  // fields: 指定导出的模板字段 key 数组（字段选择，可选）
  exportCsv: async (type_code, ids, fields) => {
    const qs = new URLSearchParams()
    if (type_code) qs.set('type_code', type_code)
    if (Array.isArray(ids) && ids.length > 0) qs.set('ids', ids.join(','))
    if (Array.isArray(fields) && fields.length > 0) qs.set('fields', fields.join(','))
    const query = qs.toString()
    const url = `/api/v1/assets/export${query ? `?${query}` : ''}`
    const resp = await fetch(url, { headers: { ...authHeader() } })
    if (!resp.ok) throw new Error(`导出失败: HTTP ${resp.status}`)
    const blob = await resp.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `${type_code ? `assets_${type_code}` : 'assets'}_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  },

  // ===== 资产标签（全局共享，多对多分组）=====
  // 列出所有标签（含使用计数）
  listTags: () => request('/assets/tags'),
  // 创建标签 { name, color, category? }
  createTag: (data) => request('/assets/tags', { method: 'POST', body: data }),
  // 删除标签
  deleteTag: (id) => request(`/assets/tags/${id}`, { method: 'DELETE' }),

  // ===== 去重检测 + 合并 =====
  // 检测疑似重复资产（按 (type_code, identifier) 分组），可选 type_code 限定
  // 返回 { groups, total_groups, total_assets }
  detectDuplicates: (type_code) =>
    request(`/assets/duplicates${type_code ? `?type_code=${encodeURIComponent(type_code)}` : ''}`),
  // 合并资产：把 source 合并到 target(target_id)，保留 target 删除 source
  // body: { source_id, field_strategy?, merge_extra_fields? }
  mergeAsset: (targetId, body) =>
    request(`/assets/${targetId}/merge`, { method: 'POST', body }),
}

export default assetsApi
