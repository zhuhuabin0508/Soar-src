// 通知中心 API：通知列表/未读计数/标记已读/全部已读/删除/创建（管理员公告）
// 通知规则 API：事件类型路由规则 CRUD（哪些内容/告警通知给谁）
import request from './client'

export const notificationsApi = {
  // 获取通知列表（分页）
  list: (limit = 50, offset = 0) => request(`/notifications?limit=${limit}&offset=${offset}`),
  // 获取未读计数
  unreadCount: () => request('/notifications/unread-count'),
  // 标记单条已读
  markRead: (id) => request(`/notifications/${id}/read`, { method: 'PUT' }),
  // 全部标记已读
  markAllRead: () => request('/notifications/read-all', { method: 'PUT' }),
  // 删除通知
  remove: (id) => request(`/notifications/${id}`, { method: 'DELETE' }),
  // 创建通知（管理员公告）
  create: (body) => request('/notifications', { method: 'POST', body }),
  // 个人提醒偏好：每类型右侧滑出(toast)/仅铃铛(silent)
  getPrefs: () => request('/notifications/prefs'),
  updatePref: (eventType, popupMode) =>
    request('/notifications/prefs', {
      method: 'PUT',
      body: { event_type: eventType, popup_mode: popupMode },
    }),
  resetPrefs: () => request('/notifications/prefs', { method: 'DELETE' }),
}

// 通知规则：配置哪些事件类型通知给哪些用户/角色
export const notificationRulesApi = {
  // 获取事件类型清单（供下拉选择）
  eventTypes: () => request('/notification-rules/event-types'),
  // 规则列表（可按 event_type / enabled 过滤）
  list: (params = {}) => {
    const qs = new URLSearchParams()
    if (params.event_type != null) qs.set('event_type', params.event_type)
    if (params.enabled != null) qs.set('enabled', params.enabled)
    const s = qs.toString()
    return request(`/notification-rules${s ? '?' + s : ''}`)
  },
  // 创建规则
  create: (body) => request('/notification-rules', { method: 'POST', body }),
  // 更新规则（部分字段）
  update: (id, body) => request(`/notification-rules/${id}`, { method: 'PUT', body }),
  // 删除规则
  remove: (id) => request(`/notification-rules/${id}`, { method: 'DELETE' }),
  // 快速启停
  toggle: (id) => request(`/notification-rules/${id}/toggle`, { method: 'PUT' }),
}

export default notificationsApi
