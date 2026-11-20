// 报告中心 API（/api/v1/reports）
// 模板库（docx 上传/manifest/版本发布）、报告配置（采集+映射）、运行与产物审核。
import request from './client'

const BASE = '/api/v1'

const _qs = (params = {}) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

// 带鉴权拉取二进制：接口要求 Authorization 头，<a> 直链不可用
async function _fetchBlob(path) {
  const token = localStorage.getItem('soar_token')
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let detail = '加载失败'
    let code
    try {
      const d = await res.json()
      detail = d.detail || d.message || detail
      code = d.code
    } catch { /* ignore */ }
    const err = new Error(detail)
    err.code = code
    throw err
  }
  return res.blob()
}

// 带鉴权下载
async function _download(path, filename) {
  const blob = await _fetchBlob(path)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'report.docx'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const reportApi = {
  // ===== PDF 保真预览 =====
  pdf: {
    capability: () => request('/reports/pdf/capability'),
  },

  // ===== 模板 =====
  templates: {
    list: (params) => request(`/reports/templates${_qs(params)}`),
    create: (body) => request('/reports/templates', { method: 'POST', body }),
    detail: (id) => request(`/reports/templates/${id}`),
    manifest: (id, versionId) =>
      request(`/reports/templates/${id}/versions/${versionId}/manifest`),
    updateManifest: (id, versionId, body) =>
      request(`/reports/templates/${id}/versions/${versionId}/manifest`, { method: 'PUT', body }),
    uploadVersion: (id, file, changelog = '', source = 'upload') => {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('changelog', changelog)
      fd.append('source', source)
      return request(`/reports/templates/${id}/versions`, { method: 'POST', body: fd })
    },
    publishVersion: (id, versionId) =>
      request(`/reports/templates/${id}/versions/${versionId}/publish`, { method: 'POST' }),
    diff: (id, baseId, targetId) =>
      request(`/reports/templates/${id}/versions/${baseId}/diff/${targetId}`),
    download: (id, versionId, filename) =>
      _download(`/reports/templates/${id}/versions/${versionId}/file`, filename),
    // 模板样张 PDF：占位符以【token】显示，用于确认占位符位置
    previewPdf: (id, versionId) =>
      _fetchBlob(`/reports/templates/${id}/versions/${versionId}/pdf`),
    archive: (id) => request(`/reports/templates/${id}`, { method: 'DELETE' }),
    aiDraft: (body) => request('/reports/templates/ai-draft', { method: 'POST', body }),
    // 从现有 docx 报告生成模板草稿：保留原版式，AI 仅识别动态数据并写入占位符
    fromReport: (file, fields = {}) => {
      const fd = new FormData()
      fd.append('file', file)
      Object.entries(fields).forEach(([key, value]) => fd.append(key, value ?? ''))
      return request('/reports/templates/from-report', { method: 'POST', body: fd })
    },
  },

  // ===== 配置 =====
  configs: {
    list: (params) => request(`/reports/configs${_qs(params)}`),
    create: (body) => request('/reports/configs', { method: 'POST', body }),
    clone: (id, body) => request(`/reports/configs/${id}/clone`, { method: 'POST', body }),
    detail: (id) => request(`/reports/configs/${id}`),
    update: (id, body) => request(`/reports/configs/${id}`, { method: 'PATCH', body }),
    version: (id, versionId) => request(`/reports/configs/${id}/versions/${versionId}`),
    migrationPreview: (id, targetVersionId, baseVersionId) =>
      request(`/reports/configs/${id}/migration/preview${_qs({
        target_template_version_id: targetVersionId,
        base_version_id: baseVersionId,
      })}`),
    migrate: (id, body) => request(`/reports/configs/${id}/migration`, { method: 'POST', body }),
    saveDraft: (id, body) => request(`/reports/configs/${id}/versions`, { method: 'POST', body }),
    publishVersion: (id, versionId) =>
      request(`/reports/configs/${id}/versions/${versionId}/publish`, { method: 'POST' }),
    testSource: (id, spec, params) =>
      request(`/reports/configs/${id}/test-source`, { method: 'POST', body: { spec, params } }),
    preview: (id, versionId, params) =>
      request(`/reports/configs/${id}/preview`, {
        method: 'POST',
        body: { version_id: versionId, params },
      }),
    downloadPreview: (id, previewId) =>
      _download(`/reports/configs/${id}/previews/${previewId}`, 'preview.docx'),
    previewPdf: (id, previewId) =>
      _fetchBlob(`/reports/configs/${id}/previews/${previewId}/pdf`),
    health: (id, versionId) =>
      request(`/reports/configs/${id}/health${_qs({ version_id: versionId })}`),
    healthProbe: (id, versionId, params) =>
      request(`/reports/configs/${id}/health/probe`, {
        method: 'POST',
        body: { version_id: versionId, params },
      }),
    aiMappingSuggest: (id, body) =>
      request(`/reports/configs/${id}/ai-mapping-suggest`, { method: 'POST', body }),
    disable: (id) => request(`/reports/configs/${id}`, { method: 'DELETE' }),
  },

  // ===== 运行 =====
  runs: {
    list: (params) => request(`/reports/runs${_qs(params)}`),
    trigger: (body) => request('/reports/runs', { method: 'POST', body }),
    detail: (id) => request(`/reports/runs/${id}`),
    retry: (id) => request(`/reports/runs/${id}/retry`, { method: 'POST' }),
    validation: (id) => request(`/reports/runs/${id}/validation`),
    snapshot: (id) => request(`/reports/runs/${id}/snapshot`),
    download: (id, filename, format) => _download(`/reports/runs/${id}/download${_qs({ format })}`, filename),
    pdf: (id) => _fetchBlob(`/reports/runs/${id}/pdf`),
  },

  // ===== 产物审核 =====
  artifacts: {
    list: (params) => request(`/reports/artifacts${_qs(params)}`),
    review: (id, action, comment = '') =>
      request(`/reports/artifacts/${id}/review`, { method: 'POST', body: { action, comment } }),
    download: (id, filename, format) => _download(`/reports/artifacts/${id}/download${_qs({ format })}`, filename),
    pdf: (id) => _fetchBlob(`/reports/artifacts/${id}/pdf`),
  },
}

export default reportApi
