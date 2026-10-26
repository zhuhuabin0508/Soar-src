// 用户管理 API：列表/新建/更新/删除/重置密码/启停/批量导入导出
import request from './client'

// 通用 blob 下载（接口要求 Authorization 头，<a> 直链不可用）
async function _downloadBlob(path, fallbackName) {
  const token = localStorage.getItem('soar_token')
  const res = await fetch(`/api/v1${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let detail = '下载失败'
    try { const d = await res.json(); detail = d.detail || d.message || detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // 从响应头取文件名，兜底用传入名
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/)
  a.download = m ? decodeURIComponent(m[1]) : fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const usersApi = {
  // 用户列表
  list: () => request('/users'),
  // 新建用户
  create: (body) => request('/users', { method: 'POST', body }),
  // 更新用户资料（不含密码）
  update: (id, body) => request(`/users/${id}`, { method: 'PUT', body }),
  // 删除用户
  remove: (id) => request(`/users/${id}`, { method: 'DELETE' }),
  // 管理员重置用户密码
  resetPassword: (id, newPassword) =>
    request(`/users/${id}/reset-password`, {
      method: 'POST',
      body: { new_password: newPassword },
    }),
  // 启用/禁用用户
  toggleActive: (id) =>
    request(`/users/${id}/toggle-active`, { method: 'POST' }),
  // 强制下线指定用户的所有会话
  forceLogout: (id) =>
    request(`/users/${id}/force-logout`, { method: 'POST' }),
  // 导出用户为 xlsx（ids 为空导出全部，传数组导出选中）
  export: (ids) => {
    const q = Array.isArray(ids) && ids.length ? `?ids=${ids.join(',')}` : ''
    return _downloadBlob(`/users/export${q}`, `users_${Date.now()}.xlsx`)
  },
  // 下载批量导入 Excel 模板
  importTemplate: () => _downloadBlob('/users/import-template', 'users_import_template.xlsx'),
  // 批量导入用户（xlsx/csv）；conflictStrategy: skip 跳过已存在 / overwrite 覆盖更新
  import: (file, conflictStrategy = 'skip') => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/users/import?conflict_strategy=${conflictStrategy}`, {
      method: 'POST',
      body: fd,
    })
  },
}

export default usersApi
