// 工单价值评分 API 客户端
//
// 规则配置：/ticket-scores/rule（GET 读取当前 / PUT 保存新版本 / versions 历史）
// 工单评分：/ticket-scores/tickets/{ticketId}（GET 状态 / POST 提交，每单仅一次）
import request from './client'

export const ticketScoreApi = {
  // ===== 评分规则 =====
  getRule: () => request('/ticket-scores/rule'),
  getDefaultRule: () => request('/ticket-scores/rule/default'),
  saveRule: (config, note = '') =>
    request('/ticket-scores/rule', { method: 'PUT', body: { config, note } }),
  listVersions: (limit = 50) =>
    request(`/ticket-scores/rule/versions?limit=${limit}`),
  getVersion: (version) => request(`/ticket-scores/rule/versions/${version}`),
  // 评分筛选项（当前规则版本 + 分级列表，ticket:view 可读）
  getOptions: () => request('/ticket-scores/options'),

  // ===== 工单评分 =====
  getTicketScore: (ticketId) => request(`/ticket-scores/tickets/${ticketId}`),
  submitScore: (ticketId, body) =>
    request(`/ticket-scores/tickets/${ticketId}`, { method: 'POST', body }),
}

export default ticketScoreApi
