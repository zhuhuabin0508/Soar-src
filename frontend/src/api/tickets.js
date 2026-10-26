// 工单 API 客户端
//
// 覆盖：工单处理分组管理、流程模板管理（含发布）、工单发起/列表/详情/流转/取消、附件上传。
// 后端路由前缀：/api/v1/ticket-config/*（配置）与 /api/v1/tickets（工单中心）。
import request from './client'

const _qs = (params = {}) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const ticketApi = {
  // ===== 处理分组 =====
  listGroups: () => request('/ticket-config/groups'),
  createGroup: (body) => request('/ticket-config/groups', { method: 'POST', body }),
  updateGroup: (id, body) => request(`/ticket-config/groups/${id}`, { method: 'PUT', body }),
  deleteGroup: (id) => request(`/ticket-config/groups/${id}`, { method: 'DELETE' }),
  updateGroupMembers: (id, userIds) =>
    request(`/ticket-config/groups/${id}/members`, { method: 'PUT', body: { user_ids: userIds } }),

  // ===== 流程模板 =====
  listFlows: () => request('/ticket-config/flows'),
  getFlow: (id) => request(`/ticket-config/flows/${id}`),
  createFlow: (body) => request('/ticket-config/flows', { method: 'POST', body }),
  updateFlow: (id, body) => request(`/ticket-config/flows/${id}`, { method: 'PUT', body }),
  publishFlow: (id) => request(`/ticket-config/flows/${id}/publish`, { method: 'POST' }),
  deleteFlow: (id) => request(`/ticket-config/flows/${id}`, { method: 'DELETE' }),
  // 版本管理：发布存档列表 / 详情（含 nodes，供 diff）/ 回滚（覆盖当前内容回草稿态）
  listFlowVersions: (id) => request(`/ticket-config/flows/${id}/versions`),
  getFlowVersion: (id, version) => request(`/ticket-config/flows/${id}/versions/${version}`),
  rollbackFlowVersion: (id, version) =>
    request(`/ticket-config/flows/${id}/versions/${version}/rollback`, { method: 'POST' }),

  // ===== SLA 目标配置 =====
  getSlaConfig: () => request('/ticket-config/sla'),
  updateSlaConfig: (config) => request('/ticket-config/sla', { method: 'PUT', body: { config } }),

  // ===== 工单中心 =====
  flowOptions: () => request('/tickets/flows/options'),
  // 抄送候选（启用用户 + 启用分组，ticket:view 即可调用，避免弹窗"权限不足"）
  ccOptions: () => request('/tickets/cc-options'),
  createTicket: (body) => request('/tickets', { method: 'POST', body }),
  listTickets: (params) => request(`/tickets${_qs(params)}`),
  getTicket: (id) => request(`/tickets/${id}`),
  // 监控大屏聚合（KPI/趋势/分布/SLA/分组/流转节点/最新工单，一次返回）
  // flowId：指定处置状态流转展示的流程模板；缺省自动选取（进行中工单最多）
  getMonitorStats: (flowId) => request(`/tickets/monitor${flowId ? `?flow_id=${flowId}` : ''}`),
  advanceTicket: (id, body) => request(`/tickets/${id}/advance`, { method: 'POST', body }),
  // 回退工单：当前节点退回上一节点，comment 必填（回退原因）
  rollbackTicket: (id, body) => request(`/tickets/${id}/rollback`, { method: 'POST', body }),
  cancelTicket: (id, body) => request(`/tickets/${id}/cancel`, { method: 'POST', body }),
  // 催办：发起人/抄送人/admin 对处理中工单一键催办（30 分钟限频），返回详情
  urgeTicket: (id) => request(`/tickets/${id}/urge`, { method: 'POST' }),
  // 转办/改派：group_id 转给其他分组接管；user_id 改派指定人（认领锁定），reason 必填
  transferTicket: (id, body) => request(`/tickets/${id}/transfer`, { method: 'POST', body }),
  // 认领：组内先到先得，认领后仅认领人/admin 可提交（流转/回退/转组自动释放）
  claimTicket: (id) => request(`/tickets/${id}/claim`, { method: 'POST' }),
  // 时间线内部评论（区别于处置意见，不产生流转副作用）
  addComment: (id, content) => request(`/tickets/${id}/comments`, { method: 'POST', body: { content } }),
  // 相似工单推荐：发起时按首节点关键字段值（ip/select）匹配同流程已完成工单
  similarTickets: (body) => request('/tickets/similar', { method: 'POST', body }),
  // 封禁状态查询：批量查 IP 是否处于封禁期间（安全上下文封禁查询，最多 20 个）
  banStatus: (ips) => request(`/tickets/ban-status${_qs({ ips: ips.join(',') })}`),
  // 导出 CSV：按当前筛选条件（UTF-8 BOM，Excel 直接打开），blob 触发下载
  exportTickets: (params) => {
    const token = localStorage.getItem('soar_token')
    return fetch(`/api/v1/tickets/export${_qs(params)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (res) => {
      if (!res.ok) {
        let detail = '导出失败'
        try { const d = await res.json(); detail = d.detail || detail } catch { /* ignore */ }
        throw new Error(detail)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `工单导出_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '')}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    })
  },
  archiveTicket: (id) => request(`/tickets/${id}/archive`, { method: 'POST' }),
  unarchiveTicket: (id) => request(`/tickets/${id}/unarchive`, { method: 'POST' }),
  // 抄送：追加（人员/分组混合勾选）与移除，均返回工单详情
  addCc: (id, targets) => request(`/tickets/${id}/cc`, { method: 'POST', body: { targets } }),
  removeCc: (id, ccId) => request(`/tickets/${id}/cc/${ccId}`, { method: 'DELETE' }),
  // 删除工单记录（物理删除，ticket:delete 权限）
  deleteTicket: (id) => request(`/tickets/${id}`, { method: 'DELETE' }),

  // ===== 附件 =====
  uploadAttachment: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    // 60 秒超时：防止极端环境下请求无限挂起、上传按钮一直停在"上传中"
    return request('/tickets/attachments', { method: 'POST', body: fd, timeoutMs: 60000 })
  },
}

// 附件直链（<img>/<a> 无法带 Authorization 头，追加 query token）
// 幂等：URL 已带 token 时原样返回，避免叠加多份 token
export function attachmentUrl(url) {
  if (!url) return ''
  if (url.includes('token=')) return url
  const token = localStorage.getItem('soar_token')
  if (!token) return url
  return url.includes('?') ? `${url}&token=${token}` : `${url}?token=${token}`
}

export default ticketApi
