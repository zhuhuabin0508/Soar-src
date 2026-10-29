// 统一 API 客户端：基于 fetch，base 前缀 /api/v1（相对路径，由 nginx 代理）
// 所有页面统一引用本模块，集中处理 JSON 与错误抛出
//
// 资源 API：
//   llmConfigs        GET/POST/PUT/DELETE 模型配置
//   tools             GET/POST/PUT/DELETE 工具，POST /{id}/test，GET /templates
//   agents            GET/POST/PUT/DELETE 智能体，POST /{id}/test
//   knowledgeBases    GET/POST/DELETE 知识库 + documents + search
//   workflows         GET/POST/PUT/DELETE 工作流，POST /{id}/test-run，POST /test-node
//   executions        GET 列表/详情
//   feedbackApi       系统反馈：提交/附件/我的反馈/详情/回复/状态/批量

import { toast } from '../store/toastStore'
import { purgeChatCaches } from '../utils/chatStorage'

const BASE_URL = '/api/v1'

/**
 * 发起 JSON 请求
 * @param {string} path 相对路径，例如 /llm-configs
 * @param {object} options fetch 配置（method/headers/body 等）
 * @returns {Promise<any>} 解析后的 JSON；空响应体返回 null
 */
export async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`
  const isFormData =
    typeof FormData !== 'undefined' && options.body instanceof FormData
  const token = localStorage.getItem('soar_token')
  const headers = {
    Accept: 'application/json',
    // JWT 鉴权：登录后所有请求携带 Bearer token
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    // FormData 由浏览器自动设置 Content-Type（含 boundary），不能手动覆盖
    ...(options.body && !isFormData
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(options.headers || {}),
  }
  // 自动序列化 body；FormData 直接透传
  const init = {
    ...options,
    headers,
    body:
      isFormData
        ? options.body
        : options.body !== undefined && options.body !== null && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body,
  }

  // 可选超时（options.timeoutMs 毫秒）：到点 abort 请求并抛 TimeoutError，
  // 避免上传等请求在极端环境（文件源读取卡住/连接池耗尽）下无限挂起、按钮永远"上传中"
  let timeoutTimer = null
  const hasTimeout = typeof AbortController !== 'undefined' && options.timeoutMs > 0
  const controller = hasTimeout ? new AbortController() : null
  if (controller) {
    timeoutTimer = setTimeout(
      () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
      options.timeoutMs,
    )
  }

  let res
  try {
    res = await fetch(url, controller ? { ...init, signal: controller.signal } : init)
  } catch (err) {
    // 超时/取消原样抛出，让调用方按 err.name 区分提示
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err
    throw new Error(`网络错误：${err.message || err}`)
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }

  if (!res.ok) {
    // 403 权限不足：全局 toast 提示（仅提示一次/请求，避免狂刷）
    if (res.status === 403) {
      let permDetail = ''
      try {
        const d = await res.json()
        permDetail = d.detail || d.message || ''
      } catch { /* ignore */ }
      toast.error(permDetail || '权限不足，无法执行此操作')
      throw new Error(permDetail || '权限不足，无法执行此操作')
    }
    // 401 未认证/token 过期：先尝试刷新令牌，刷新失败再跳转登录页
    // 使用全局标志避免并发请求触发多次刷新/跳转
    // 排除 /auth/login 本身：登录接口的 401 是密码错误，不是 token 过期
    if (res.status === 401 && !path.startsWith('/auth/login') && !window.location.pathname.startsWith('/login')) {
      // 避免对 /auth/refresh 本身的 401 再次触发刷新（无限循环）
      const isRefreshCall = path.startsWith('/auth/refresh') || path.startsWith('/auth/logout')
      if (!isRefreshCall && !window.__SOAR_REFRESHING__) {
        window.__SOAR_REFRESHING__ = true
        try {
          const refreshRes = await fetch(`${BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          })
          if (refreshRes.ok) {
            const data = await refreshRes.json()
            if (data.access_token) {
              // 更新本地凭证
              localStorage.setItem('soar_token', data.access_token)
              localStorage.setItem('soar_user', JSON.stringify(data.user))
              window.__SOAR_REFRESHING__ = false
              // 用新 token 重试原始请求
              headers.Authorization = `Bearer ${data.access_token}`
              return request(path, options)
            }
          }
        } catch {
          // 刷新失败，走登出流程
        }
        window.__SOAR_REFRESHING__ = false
      }
      // 刷新失败或已过期：清除凭证 + 跳转登录页
      if (!window.__SOAR_AUTH_EXPIRED__) {
        window.__SOAR_AUTH_EXPIRED__ = true
        localStorage.removeItem('soar_token')
        localStorage.removeItem('soar_user')
        // 对话缓存含登录用户的私有对话内容：凭证失效时一并清除，
        // 防止跳转登录页前后残留对话记录被后续使用者看到
        purgeChatCaches(localStorage)
        setTimeout(() => {
          // 用 toast 替代 window.alert，避免阻塞 + 统一视觉
          toast.warning('登录已过期或认证失效，请重新登录')
          setTimeout(() => {
            window.location.href = '/login'
          }, 600)
        }, 100)
      }
      throw new Error('登录已过期，请重新登录')
    }
    let detail = ''
    try {
      const data = await res.json()
      // FastAPI 422 的 detail 是数组（[{loc,msg,type}]），直接模板拼接会变成 [object Object]
      // 统一处理：字符串原样用，对象/数组则提取可读信息后 JSON 序列化
      const raw = data.detail ?? data.message ?? data
      if (typeof raw === 'string') {
        detail = raw
      } else if (Array.isArray(raw)) {
        // 422 校验错误：拼接每条的 msg（如 "limit: ensure this value is less than 500"）
        detail = raw
          .map((e) => e?.msg ? `${e.loc ? e.loc.join('.') + ': ' : ''}${e.msg}` : JSON.stringify(e))
          .join('; ')
      } else {
        detail = JSON.stringify(raw)
      }
    } catch {
      try {
        detail = await res.text()
      } catch {
        detail = ''
      }
    }
    // 优先展示后端返回的具体原因（如"密码必须包含大写字母"），无具体原因时才回退到状态码
    throw new Error(detail || `请求失败 ${res.status} ${res.statusText}`.trim())
  }

  // 允许空响应体
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export default request

// ============ LLM 配置 ============
export const llmConfigs = {
  list: () => request('/llm-configs'),
  create: (body) => request('/llm-configs', { method: 'POST', body }),
  update: (id, body) => request(`/llm-configs/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/llm-configs/${id}`, { method: 'DELETE' }),
  test: (id) => request(`/llm-configs/${id}/test`, { method: 'POST' }),
  // 复制配置
  copy: (id) => request(`/llm-configs/${id}/copy`, { method: 'POST' }),
  // Provider 模板（官方 Base URL、常用模型、图标）
  providers: () => request('/llm-configs/providers'),
  // 测试历史
  testHistory: (id, limit = 50) =>
    request(`/llm-configs/${id}/test-history?limit=${limit}`),
  // 模型监控：聚合统计（按模型配置汇总调用次数/成功率/耗时/Token）
  // trigger_type 可选：agent_test/manual_test/workflow/api/knowledge_vector
  monitorStats: (days = 7, triggerType = '') => {
    const q = `days=${days}${triggerType ? `&trigger_type=${triggerType}` : ''}`
    return request(`/llm-configs/monitor/stats?${q}`)
  },
  // 模型监控：单个配置的最近调用明细（支持按来源/状态筛选）
  monitorCalls: (id, limit = 50, offset = 0, triggerType = '', status = '') => {
    const params = new URLSearchParams({ limit, offset })
    if (triggerType) params.set('trigger_type', triggerType)
    if (status) params.set('status', status)
    return request(`/llm-configs/${id}/monitor/calls?${params.toString()}`)
  },
  // 手动触发健康检查（所有启用的配置）
  healthCheck: () => request('/llm-configs/health-check', { method: 'POST' }),
  // 查看完整 API Key（审计记录）
  revealApiKey: (id) => request(`/llm-configs/${id}/api-key`),
}

// ============ 工具 ============
export const tools = {
  list: () => request('/tools'),
  create: (body) => request('/tools', { method: 'POST', body }),
  update: (id, body) => request(`/tools/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/tools/${id}`, { method: 'DELETE' }),
  test: (id, parameters) =>
    request(`/tools/${id}/test`, { method: 'POST', body: { parameters } }),
  templates: () => request('/tools/templates'),
  // 推断工具的输入输出 schema
  inferredSchema: (id) => request(`/tools/${id}/inferred-schema`),
  // 解析 OpenAPI/Swagger JSON 或 URL，返回操作列表
  importOpenapi: (body) =>
    request('/tools/import-openapi', { method: 'POST', body }),
  // 根据选定的 OpenAPI 操作构造工具配置
  buildFromOperation: (body) =>
    request('/tools/build-from-operation', { method: 'POST', body }),
  // AI 优化工具描述（写给 LLM 看）
  optimizeDescription: (body) =>
    request('/tools/optimize-description', { method: 'POST', body }),
  // 从描述自动提取参数
  extractParameters: (body) =>
    request('/tools/extract-parameters', { method: 'POST', body }),
  // 模拟对话调试：把工具绑定到 LLM，展示运行链路
  debugChat: (id, message) =>
    request(`/tools/${id}/debug-chat`, { method: 'POST', body: { message } }),
}

// ============ 智能体 ============
export function isAgentPublished(agent) {
  if (!agent) return false
  if ((agent.variables || {})._publish_status === 'draft') return false
  const name = agent.name || ''
  const desc = agent.description || ''
  if (name.startsWith('（草稿）') || String(desc).startsWith('[草稿]')) return false
  if (agent.publish_status === 'draft') return false
  return true
}

export const agents = {
  list: (params) => {
    const qs = new URLSearchParams()
    if (params?.usable) qs.set('usable', 'true')
    const query = qs.toString()
    return request(`/agents${query ? `?${query}` : ''}`)
  },
  get: (id) => request(`/agents/${id}`),
  create: (body) => request('/agents', { method: 'POST', body }),
  update: (id, body) => request(`/agents/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/agents/${id}`, { method: 'DELETE' }),
  test: (id, input) =>
    request(`/agents/${id}/test`, { method: 'POST', body: { input } }),
  // 流式对话：返回 fetch Response，SSE 事件契约见后端 chat_agent 端点
  // 事件类型：start | status | token | tool_start | tool_end | skill_interrupt | delegate | log | done | error
  // signal 可选：传入 AbortSignal 以支持中途取消流式
  // sessionId 可选：会话 ID，按 (agentId, sessionId) 持久化多轮对话上下文
  // options 可选：会话级参数覆盖（Playground 调试用）
  chatStream: async (id, input, signal, sessionId, options = {}) => {
    const token = localStorage.getItem('soar_token')
    const { channel, ...override } = options || {}
    const body = { input, session_id: sessionId || 'default' }
    if (override && Object.keys(override).length > 0) body.override = override
    if (channel) body.channel = channel
    const resp = await fetch(`${BASE_URL}/agents/${id}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    return resp
  },
  // 清空单个会话的服务端记忆（「删除当前会话」场景；「新建会话」不使用此接口）
  clearChatSession: (id, sessionId) =>
    request(`/agents/${id}/chat/session?session_id=${encodeURIComponent(sessionId || 'default')}`, {
      method: 'DELETE',
    }),
  // 清空该智能体下当前用户的全部会话记忆（仅「清空历史」入口调用）
  clearChatSessions: (id) =>
    request(`/agents/${id}/chat/sessions`, { method: 'DELETE' }),
  // 列出该智能体下当前账号的服务端会话（跨浏览器/跨设备恢复会话列表）。
  // 分页契约：{ sessions, has_more }；调用方需按 offset 继续拉取直到 has_more=false。
  listChatSessions: (id, { limit = 500, offset = 0 } = {}) =>
    request(`/agents/${id}/chat/sessions?limit=${limit}&offset=${offset}`),
  // 拉取指定会话的服务端历史消息（跨浏览器恢复完整对话内容）。
  // 分页契约：{ session_id, messages, has_more, next_before_id }；
  // 需要更早消息时把 next_before_id 作为 beforeId 再次请求。
  getChatSessionMessages: (id, sessionId, { limit = 500, beforeId = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (beforeId) params.set('before_id', String(beforeId))
    return request(
      `/agents/${id}/chat/sessions/${encodeURIComponent(sessionId || 'default')}/messages?${params.toString()}`
    )
  },
  executions: (id, limit = 50) =>
    request(`/agents/${id}/executions?limit=${limit}`),
  monitor: (id) => request(`/agents/${id}/monitor`),
  // 工具搜索状态（tool_search 渐进式披露）：返回分类详情 + 装配预览
  toolSearchStatus: (id) => request(`/agents/${id}/tool-search-status`),
  templates: () => request('/agents/templates'),
  exportDsl: (id) => request(`/agents/${id}/dsl`),
  createFromDsl: (dsl) => request('/agents/from-dsl', { method: 'POST', body: { dsl } }),
  publish: (id) => request(`/agents/${id}/publish`, { method: 'POST' }),
  publishTemplate: (id, body = {}) =>
    request(`/agents/${id}/publish-template`, { method: 'POST', body }),
}

// ============ 知识库 ============
export const knowledgeBases = {
  list: () => request('/knowledge-bases'),
  get: (id) => request(`/knowledge-bases/${id}`),
  create: (body) => request('/knowledge-bases', { method: 'POST', body }),
  update: (id, body) => request(`/knowledge-bases/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/knowledge-bases/${id}`, { method: 'DELETE' }),
  documents: (kbId) => request(`/knowledge-bases/${kbId}/documents`),
  getDocument: (kbId, docId) => request(`/knowledge-bases/${kbId}/documents/${docId}`),
  addDocument: (kbId, body) =>
    request(`/knowledge-bases/${kbId}/documents`, { method: 'POST', body }),
  updateDocument: (kbId, docId, body) =>
    request(`/knowledge-bases/${kbId}/documents/${docId}`, { method: 'PUT', body }),
  removeDocument: (kbId, docId) =>
    request(`/knowledge-bases/${kbId}/documents/${docId}`, { method: 'DELETE' }),
  search: (kbId, query, topK = 5) =>
    request(`/knowledge-bases/${kbId}/search`, {
      method: 'POST',
      body: { query, top_k: topK },
    }),
  // 文件上传：使用 FormData，由浏览器自动设置 multipart boundary
  uploadDocument: (kbId, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/knowledge-bases/${kbId}/documents/upload`, {
      method: 'POST',
      body: fd,
    })
  },
  uploadDocuments: (kbId, files) => {
    const fd = new FormData()
    Array.from(files || []).forEach((file) => fd.append('files', file))
    return request(`/knowledge-bases/${kbId}/documents/upload-batch`, {
      method: 'POST',
      body: fd,
    })
  },
  downloadDocumentFile: async (kbId, docId, filename) => {
    const token = localStorage.getItem('soar_token')
    const res = await fetch(`${BASE_URL}/knowledge-bases/${kbId}/documents/${docId}/file`, {
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
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename || 'file'
    a.click()
    URL.revokeObjectURL(a.href)
  },
  // 网页抓取：从 URL 抓取内容存入知识库
  fetchUrlDocument: (kbId, body) =>
    request(`/knowledge-bases/${kbId}/documents/fetch-url`, { method: 'POST', body }),
  // 查看文档分段（解析与切片结果）
  segments: (kbId, docId) =>
    request(`/knowledge-bases/${kbId}/documents/${docId}/segments`),
  // 重新解析并分段单个文档
  reparseDocument: (kbId, docId) =>
    request(`/knowledge-bases/${kbId}/documents/${docId}/reparse`, { method: 'POST' }),
  // 批量重新解析知识库下所有文档
  reparseAll: (kbId) =>
    request(`/knowledge-bases/${kbId}/reparse-all`, { method: 'POST' }),
  // 文件查询（读取原始 Excel/CSV 按条件查询）
  fileQuery: (kbId, body) =>
    request(`/knowledge-bases/${kbId}/file-query`, { method: 'POST', body }),
  setDocumentEnabled: (kbId, docId, enabled) =>
    request(`/knowledge-bases/${kbId}/documents/${docId}/enabled`, {
      method: 'PATCH',
      body: { enabled },
    }),
  batchDocuments: (kbId, action, ids) =>
    request(`/knowledge-bases/${kbId}/documents/batch`, {
      method: 'POST',
      body: { action, ids },
    }),
  replaceDocumentFile: (kbId, docId, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/knowledge-bases/${kbId}/documents/${docId}/replace`, {
      method: 'POST',
      body: fd,
    })
  },
}

// ============ 技能（纯文本指令，注入 Agent system prompt） ============
export const skills = {
  list: (params) => {
    const qs = new URLSearchParams()
    if (params) {
      if (params.category != null) qs.set('category', params.category)
      if (params.enabled != null) qs.set('enabled', params.enabled)
      if (params.sort) qs.set('sort', params.sort)
      if (params.order) qs.set('order', params.order)
    }
    const query = qs.toString()
    return request(`/skills${query ? `?${query}` : ''}`)
  },
  get: (id) => request(`/skills/${id}`),
  create: (body) => request('/skills', { method: 'POST', body }),
  update: (id, body) => request(`/skills/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/skills/${id}`, { method: 'DELETE' }),
  // AI 辅助：优化技能正文
  optimize: (body) => request('/skills/optimize', { method: 'POST', body }),
  // AI 辅助：检测技能问题
  check: (body) => request('/skills/check', { method: 'POST', body }),
  // 测试运行：注入技能后让指定智能体回答
  test: (id, body) => request(`/skills/${id}/test`, { method: 'POST', body }),
  // 导出（ids 为空则导出全部）
  exportAll: (ids) => {
    const qs = new URLSearchParams()
    if (ids && ids.length) qs.set('ids', ids.join(','))
    const query = qs.toString()
    return request(`/skills/export/all${query ? `?${query}` : ''}`)
  },
  // 批量导入
  import: (data, overwrite = false) =>
    request('/skills/import', { method: 'POST', body: { data, overwrite } }),
}

// ============ 智能体文件（不做 RAG，原样存储供 read_document 工具读取） ============
export const agentFiles = {
  // 列表：默认显示公共文件 + 本人上传；传 agent_id 时进一步限定为该智能体的文件
  list: (agent_id) => request(`/agent-files${agent_id ? `?agent_id=${agent_id}` : ''}`),
  // 上传：可选归属智能体（agent_id），实现文件按智能体+用户双层隔离
  upload: (file, agent_id) => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/agent-files/upload${agent_id ? `?agent_id=${agent_id}` : ''}`, { method: 'POST', body: fd })
  },
  remove: (id) => request(`/agent-files/${id}`, { method: 'DELETE' }),
  // 下载文件（blob + 前端触发保存；接口要求 Authorization 头，<a> 直链不可用）
  download: (id, filename) => {
    const token = localStorage.getItem('soar_token')
    return fetch(`${BASE_URL}/agent-files/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (res) => {
      if (!res.ok) {
        let detail = '下载失败'
        try { const d = await res.json(); detail = d.detail || detail } catch { /* ignore */ }
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
    })
  },
}

// ============ 工作流 ============
export const workflows = {
  list: () => request('/workflows'),
  create: (body) => request('/workflows', { method: 'POST', body }),
  get: (id) => request(`/workflows/${id}`),
  update: (id, body) => request(`/workflows/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/workflows/${id}`, { method: 'DELETE' }),
  testRun: (id, payload) =>
    request(`/workflows/${id}/test-run`, { method: 'POST', body: { payload } }),
  testNode: (node, inputData) =>
    request('/workflows/test-node', {
      method: 'POST',
      body: { node, input_data: inputData },
    }),
  // 校验工作流图配置：返回 { valid, errors, warnings }
  validate: (graphConfig) =>
    request('/workflows/validate', {
      method: 'POST',
      body: { graph_config: graphConfig },
    }),
  // 重置 webhook 密钥：返回 { webhook_secret }
  resetSecret: (id) => request(`/workflows/${id}/reset-secret`, { method: 'POST' }),
  // 工作流版本管理
  versions: (id) => request(`/workflows/${id}/versions`),
  createVersion: (id, changeNote) =>
    request(`/workflows/${id}/versions`, { method: 'POST', body: { change_note: changeNote } }),
  getVersion: (workflowId, versionId) =>
    request(`/workflows/${workflowId}/versions/${versionId}`),
  rollbackVersion: (workflowId, versionId) =>
    request(`/workflows/${workflowId}/versions/${versionId}/rollback`, { method: 'POST' }),
  // 收藏切换
  toggleFavorite: (id) => request(`/workflows/${id}/favorite`, { method: 'PATCH' }),
  generateDraft: (description) =>
    request('/workflows/drafts/generate', { method: 'POST', body: { description } }),
  listDrafts: () => request('/workflows/drafts'),
  getDraft: (id) => request(`/workflows/drafts/${id}`),
  updateDraft: (id, body) => request(`/workflows/drafts/${id}`, { method: 'PUT', body }),
  publishDraft: (id) => request(`/workflows/drafts/${id}/publish`, { method: 'POST' }),
  // 状态变更（draft / published / disabled）
  updateStatus: (id, status) =>
    request(`/workflows/${id}/status`, { method: 'PATCH', body: { status } }),
  // 标签与分类更新
  updateTags: (id, tags, category) =>
    request(`/workflows/${id}/tags`, { method: 'PATCH', body: { tags, category } }),
  // 导入工作流
  import: (body) => request('/workflows/import', { method: 'POST', body }),
  // 环境变量（敏感信息加密存储在后端，前端只持有掩码视图）
  // GET  /workflows/{id}/env-vars        → {items: [{name, description, value:'******', has_value}]}
  // PUT  /workflows/{id}/env-vars        → 保存；value 传 '******' 表示保留原值
  // POST /workflows/{id}/env-vars/reveal → {name} → {name, value} 明文查看（敏感）
  getEnvVars: (id) => request(`/workflows/${id}/env-vars`),
  setEnvVars: (id, items) =>
    request(`/workflows/${id}/env-vars`, { method: 'PUT', body: { items } }),
  revealEnvVar: (id, name) =>
    request(`/workflows/${id}/env-vars/reveal`, { method: 'POST', body: { name } }),
}

// ============ 资源共享授权（owner 把资源编辑权限共享给其他用户） ============
// resource_type 取值：workflow / agent / tool / skill / knowledge_base
// 仅 admin 或资源 owner 可管理共享；被授权用户获得编辑权限但不改变 owner 归属
export const resourceShares = {
  // 查看资源的共享授权列表（仅 owner/admin）
  list: (resourceType, resourceId) =>
    request(`/resource-shares/${resourceType}/${resourceId}`),
  add: (resourceType, resourceId, userId, permission = 'edit') =>
    request(`/resource-shares/${resourceType}/${resourceId}`, {
      method: 'POST',
      body: { user_id: userId, permission },
    }),
  addRole: (resourceType, resourceId, roleId, permission = 'edit') =>
    request(`/resource-shares/${resourceType}/${resourceId}`, {
      method: 'POST',
      body: { role_id: roleId, permission },
    }),
  revoke: (resourceType, resourceId, userId) =>
    request(`/resource-shares/${resourceType}/${resourceId}/${userId}`, {
      method: 'DELETE',
    }),
  revokeRole: (resourceType, resourceId, roleId) =>
    request(`/resource-shares/${resourceType}/${resourceId}/role/${roleId}`, {
      method: 'DELETE',
    }),
}

// ============ 执行（保留与 executions.js 一致的入口） ============
export const executions = {
  list: () => request('/executions'),
  detail: (id) => request(`/executions/${id}`),
}

// ============ 安全设备 & 设备动作 ============
export const devices = {
  list: () => request('/devices'),
  create: (body) => request('/devices', { method: 'POST', body }),
  update: (id, body) => request(`/devices/${id}`, { method: 'PUT', body }),
  remove: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
  // 测试设备连接
  test: (id) => request(`/devices/${id}/test`, { method: 'POST' }),
  // 批量健康检查
  healthCheck: () => request('/devices/health-check', { method: 'POST' }),
  // 设备模板
  templates: () => request('/devices/templates'),
  // 从模板创建设备
  fromTemplate: (body) => request('/devices/from-template', { method: 'POST', body }),
  // 导入导出
  export: (ids) => {
    const q = Array.isArray(ids) && ids.length ? `?ids=${ids.join(',')}` : ''
    return request(`/devices/export${q}`)
  },
  import: (body) => request('/devices/import', { method: 'POST', body }),
  // 设备下动作 CRUD
  listActions: (deviceId) => request(`/devices/${deviceId}/actions`),
  createAction: (deviceId, body) =>
    request(`/devices/${deviceId}/actions`, { method: 'POST', body }),
  updateAction: (deviceId, actionId, body) =>
    request(`/devices/${deviceId}/actions/${actionId}`, { method: 'PUT', body }),
  removeAction: (deviceId, actionId) =>
    request(`/devices/${deviceId}/actions/${actionId}`, { method: 'DELETE' }),
  // 切换动作启用状态
  toggleAction: (deviceId, actionId) =>
    request(`/devices/${deviceId}/actions/${actionId}/toggle`, { method: 'PATCH' }),
  // 测试动作连通性（实际调用设备 API）
  testAction: (deviceId, actionId, params) =>
    request(`/devices/${deviceId}/actions/${actionId}/test`, {
      method: 'POST',
      body: { params },
    }),
  // 动作执行历史
  actionHistory: (deviceId, actionId, limit = 50) =>
    request(`/devices/${deviceId}/actions/${actionId}/history?limit=${limit}`),
  // 调用日志
  callLogs: (params = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
    return request(`/devices/call-logs?${q.toString()}`)
  },
  callLogDetail: (logId) => request(`/devices/call-logs/${logId}`),
  callLogStats: (days = 7) => request(`/devices/call-logs/stats?days=${days}`),
  // ---- 日志接收渠道（设备被动推送：syslog/kafka）----
  logReceivers: {
    list: () => request('/log-receivers'),
    summary: () => request('/log-receivers/summary'),
    create: (body) => request('/log-receivers', { method: 'POST', body }),
    detail: (id) => request(`/log-receivers/${id}`),
    update: (id, body) => request(`/log-receivers/${id}`, { method: 'PUT', body }),
    remove: (id) => request(`/log-receivers/${id}`, { method: 'DELETE' }),
    byDevice: (deviceId) => request(`/log-receivers/by-device/${deviceId}`),
    reload: (id) => request(`/log-receivers/${id}/reload`, { method: 'PATCH' }),
    metrics: (params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
      return request(`/log-receivers/metrics?${q.toString()}`)
    },
    receiveLogs: (params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
      return request(`/log-receivers/receive-logs?${q.toString()}`)
    },
    // ---- 来源条目（监听型渠道按来源 IP 自动发现）----
    entries: (receiverId, params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
      return request(`/log-receivers/${receiverId}/entries?${q.toString()}`)
    },
    // 全局数据源条目（跨接收器，含三态状态与今日统计）
    entriesGlobal: (params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
      return request(`/log-receivers/entries?${q.toString()}`)
    },
    entryDetail: (entryId) => request(`/log-receivers/entries/${entryId}`),
    entryUpdate: (entryId, body) => request(`/log-receivers/entries/${entryId}`, { method: 'PUT', body }),
    entryRemove: (entryId) => request(`/log-receivers/entries/${entryId}`, { method: 'DELETE' }),
    entryBatchRemove: (receiverId, ids) => request(`/log-receivers/${receiverId}/entries/batch-delete`, { method: 'POST', body: { ids } }),
    // 条目失败样本下钻（原因四分类统计 + 按原因筛选 + 分页）
    entryFailureSamples: (entryId, params = {}) => {
      const q = new URLSearchParams()
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v) })
      return request(`/log-receivers/entries/${entryId}/failure-samples${q.toString() ? `?${q.toString()}` : ''}`)
    },
  },
}

// ============ 系统反馈（BUG 与优化建议） ============
// 反馈状态机：pending 待处理 → processing 处理中 → replied 已回复 → resolved 已解决 / closed 已关闭
// 列表接口（mine / adminList）返回 { items, total, page, size }
const _feedbackQuery = (params = {}) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const feedbackApi = {
  // 提交反馈（BUG 类型后端强校验复现步骤/期望结果/实际结果）
  create: (body) => request('/feedbacks', { method: 'POST', body }),
  // 附件上传：multipart/form-data（字段名 file），由 request 自动透传 FormData
  uploadAttachment: (id, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request(`/feedbacks/${id}/attachments`, { method: 'POST', body: fd })
  },
  // 附件访问地址（path 可能是 "feedback/5/uuid.jpg" 格式，取末段文件名）
  // 附件接口支持 ?token= query 认证（<img> 标签无法携带 Authorization 头）
  attachmentUrl: (feedbackId, path) => {
    const token = localStorage.getItem('soar_token') || ''
    const filename = (path || '').split('/').pop() || path
    return `${BASE_URL}/feedbacks/${feedbackId}/attachments/${filename}?token=${encodeURIComponent(token)}`
  },
  // 我的反馈列表
  mine: (params) => request(`/feedbacks/mine${_feedbackQuery(params)}`),
  // 反馈详情（额外含 histories / user_name / assignee_name）
  detail: (id) => request(`/feedbacks/${id}`),
  update: (id, body) => request(`/feedbacks/${id}`, { method: 'PUT', body }),
  // 管理员回复
  reply: (id, body) => request(`/feedbacks/${id}/replies`, { method: 'POST', body }),
  // 状态变更（admin）
  setStatus: (id, status) =>
    request(`/feedbacks/${id}/status`, { method: 'PUT', body: { status } }),
  assignees: () => request('/feedbacks/assignees'),
  assign: (id, assignee_id) =>
    request(`/feedbacks/${id}/assignee`, { method: 'PUT', body: { assignee_id } }),
  // 重新打开（提交者本人或 admin）
  reopen: (id) => request(`/feedbacks/${id}/reopen`, { method: 'POST' }),
  // 管理端全量列表
  adminList: (params) => request(`/feedbacks${_feedbackQuery(params)}`),
  // 批量操作（action 如 close / processing）
  batch: (ids, action) =>
    request('/feedbacks/batch', { method: 'POST', body: { ids, action } }),
  // 反馈统计概览（admin）：状态/类型/优先级分布 + 今日新增 + 待处理数
  stats: () => request('/feedbacks/stats'),
  // 删除反馈（admin，硬删除）：级联清理附件/历史/通知
  remove: (id) => request(`/feedbacks/${id}`, { method: 'DELETE' }),
}

/**
 * 下载交付物：fetch blob + 前端触发保存（接口要求 Authorization 头，<a> 直链不可用）
 */
async function _downloadDeliverable(id, filename) {
  const token = localStorage.getItem('soar_token')
  const res = await fetch(`${BASE_URL}/deliverables/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let detail = '下载失败'
    try { const d = await res.json(); detail = d.detail || detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'deliverable'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function _fetchPreviewBlob(id) {
  const token = localStorage.getItem('soar_token')
  const res = await fetch(`${BASE_URL}/deliverables/${id}/preview`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let detail = '预览加载失败'
    try { const d = await res.json(); detail = d.detail || detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.blob()
}

export const deliverablesApi = {
  // ===== 服务类别（树形，最多 10 级）=====
  categories: () => request('/deliverables/categories'),
  createCategory: (name, description = '', parentId = 0) => {
    const fd = new FormData()
    fd.append('name', name)
    fd.append('description', description)
    if (parentId) fd.append('parent_id', parentId)
    return request('/deliverables/categories', { method: 'POST', body: fd })
  },
  updateCategory: (id, name, description = '', parentId = '') => {
    const fd = new FormData()
    fd.append('name', name)
    fd.append('description', description)
    if (parentId !== '') fd.append('parent_id', parentId)
    return request(`/deliverables/categories/${id}`, { method: 'PUT', body: fd })
  },
  deleteCategory: (id) => request(`/deliverables/categories/${id}`, { method: 'DELETE' }),
  // 导出目录：递归打包该目录及所有子目录为 zip，保留目录结构
  // onProgress(percent, phase) 回调：phase='packing' 打包中 | 'downloading' 下载中
  // 返回 { count }
  exportCategory: (id, onProgress) => {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem('soar_token')
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `${BASE_URL}/deliverables/categories/${id}/export`, true)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.responseType = 'blob'

      // 阶段1：服务器打包中（请求已发出，未收到首字节）
      let phaseStarted = false
      const packTimer = setTimeout(() => {
        if (!phaseStarted) onProgress?.(0, 'packing')
      }, 200)

      xhr.onloadstart = () => {
        clearTimeout(packTimer)
        phaseStarted = true
        onProgress?.(0, 'downloading')
      }

      xhr.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          const pct = Math.round((e.loaded / e.total) * 100)
          onProgress?.(pct, 'downloading')
        } else if (e.loaded > 0) {
          // 无 Content-Length 时显示已下载大小
          onProgress?.(-1, 'downloading', e.loaded)
        }
      }

      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let detail = '导出目录失败'
          try {
            const d = JSON.parse(xhr.response)
            detail = d.detail || detail
          } catch { /* ignore */ }
          reject(new Error(detail))
          return
        }
        const blob = xhr.response
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const cd = xhr.getResponseHeader('Content-Disposition') || ''
        const m = cd.match(/filename\*=UTF-8''([^;]+)/)
        a.download = m ? decodeURIComponent(m[1]) : `category_${id}_${Date.now()}.zip`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        resolve({
          count: parseInt(xhr.getResponseHeader('X-Export-Count') || '0', 10) || 0,
        })
      }

      xhr.onerror = () => reject(new Error('网络错误，导出失败'))
      xhr.ontimeout = () => reject(new Error('请求超时，导出失败'))
      xhr.timeout = 300000 // 5 分钟超时
      xhr.send()
    })
  },

  // ===== 交付物 =====
  list: (params) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, v)
    })
    const s = q.toString()
    return request(`/deliverables${s ? `?${s}` : ''}`)
  },
  // 上传交付物：multipart（file + category_id + 名称/版本/描述 + 可选相对路径）
  upload: (categoryId, file, meta = {}) => {
    const fd = new FormData()
    fd.append('category_id', categoryId)
    fd.append('file', file)
    if (meta.name) fd.append('name', meta.name)
    if (meta.version) fd.append('version', meta.version)
    if (meta.description) fd.append('description', meta.description)
    if (meta.relativePath) fd.append('relative_path', meta.relativePath)
    return request('/deliverables', { method: 'POST', body: fd })
  },
  // 更新元数据 / 替换文件（file 可选）
  update: (id, meta = {}, file = null) => {
    const fd = new FormData()
    if (meta.name) fd.append('name', meta.name)
    if (meta.version !== undefined) fd.append('version', meta.version)
    if (meta.description !== undefined) fd.append('description', meta.description)
    if (meta.category_id) fd.append('category_id', meta.category_id)
    if (file) fd.append('file', file)
    return request(`/deliverables/${id}`, { method: 'PUT', body: fd })
  },
  remove: (id) => request(`/deliverables/${id}`, { method: 'DELETE' }),
  // 获取当前条件下所有材料 ID（不分页，用于跨页全选）
  allIds: (params) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, v)
    })
    return request(`/deliverables/all-ids?${q.toString()}`)
  },
  download: _downloadDeliverable,
  // 批量下载：ids → zip 流式返回，前端用 Blob 触发下载
  batchDownload: async (ids) => {
    const token = localStorage.getItem('soar_token')
    const res = await fetch(`${BASE_URL}/deliverables/batch-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) {
      let detail = '批量下载失败'
      try { const d = await res.json(); detail = d.detail || detail } catch { /* ignore */ }
      throw new Error(detail)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 从响应头取文件名，兜底用时间戳
    const cd = res.headers.get('Content-Disposition') || ''
    const m = cd.match(/filename\*=UTF-8''([^;]+)/)
    a.download = m ? decodeURIComponent(m[1]) : `deliverables_${Date.now()}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
  // 批量删除：ids → 返回 { deleted, not_found }
  batchRemove: (ids) =>
    request('/deliverables/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  // 批量移动：ids → 目标目录，返回 { moved, not_found }
  batchMove: (ids, targetCategoryId) =>
    request('/deliverables/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, target_category_id: targetCategoryId }),
    }),
  // 批量移动目录（整棵子树跟着走）：ids → 目标父级（0=根级），返回 { moved, moved_ids, skipped }
  batchMoveCategories: (ids, targetParentId) =>
    request('/deliverables/categories/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, target_parent_id: targetParentId }),
    }),
  // 获取预览 Blob URL（带 auth fetch → blob → URL，用于 PDF iframe 内嵌预览）
  previewBlob: async (id) => {
    const blob = await _fetchPreviewBlob(id)
    return URL.createObjectURL(blob)
  },
  // 获取预览文件的 ArrayBuffer（Word / Excel 前端解析）
  previewArrayBuffer: async (id) => {
    const blob = await _fetchPreviewBlob(id)
    return blob.arrayBuffer()
  },
  // 获取文本类文件内容（txt/csv/md）
  getContent: (id) => request(`/deliverables/${id}/content`),
  // 保存文本类文件内容（在线编辑后保存）
  saveContent: (id, content) => request(`/deliverables/${id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }),
  // 材料管理大屏统计：类别/文件/扩展名分布/近 7 日趋势/今日新增
  stats: () => request('/deliverables/stats'),
}
