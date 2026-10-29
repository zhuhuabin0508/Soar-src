/**
 * 对话会话（conversation）纯函数工具。
 *
 * 背景：对话页原先每个智能体只保存「一份消息数组 + 一个 session_id」，
 * 「新建会话」与「清空对话」复用同一个函数，导致新建会话时把历史记录一并删除。
 * 现在每个智能体维护一个会话列表（每个会话对应一个后端 session_id），
 * 关键语义：
 * - 新建会话：只追加一个空白会话并切换上下文，**不删除**任何已有会话；
 * - 清空历史：显式地把列表整体替换为一个空白会话（需要用户二次确认）。
 *
 * 本模块不依赖 React / localStorage，便于用 node:test 做边界情况回归测试。
 */

/** 每个智能体最多保留的会话条目数（服务端支持分页，前端合并完整快照后仍做本地保护上限） */
export const MAX_CONVERSATIONS = 500
/** 单个会话最多保留的消息条数（按游标分页拉取完整历史后，本地保留上限） */
export const MAX_MESSAGES_PER_CONVERSATION = 2000

/** 「仅附件」消息的文件注入前缀：`[用户上传了以下文件…]\n\n<原始输入>` */
const FILE_WRAP_RE = /^\[用户上传了以下文件[^\]]*\]\s*\n\n([\s\S]*)$/

/** 生成会话 ID（后端按 agent_id + session_id 持久化多轮上下文） */
export function genConversationSid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 去掉仅附件消息的文件注入前缀，还原用户原始输入 */
export function stripFileWrapper(text) {
  if (typeof text !== 'string') return ''
  const matched = text.match(FILE_WRAP_RE)
  return matched ? matched[1] : text
}

/** 从消息列表推导会话标题（取首条用户消息，去掉文件注入前缀并截断） */
export function deriveConversationTitle(messages, max = 30) {
  if (!Array.isArray(messages)) return ''
  const firstUser = messages.find(
    (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()
  )
  if (!firstUser) return ''
  const text = stripFileWrapper(firstUser.content).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 创建一条空白会话 */
export function createConversation({ sid, now = Date.now() } = {}) {
  return {
    sid: sid || genConversationSid(),
    title: '',
    createdAt: now,
    updatedAt: now,
    // 新会话尚未在服务端落库；服务端列表确认后由合并逻辑置为 true
    synced: false,
    messages: [],
  }
}

/** 会话是否为空（没有任何消息） */
export function isBlankConversation(conv) {
  return !!conv && Array.isArray(conv.messages) && conv.messages.length === 0
}

/** 按 sid 查找会话；找不到返回 undefined */
export function findConversation(list, sid) {
  if (!Array.isArray(list) || !sid) return undefined
  return list.find((c) => c && c.sid === sid)
}

/** 消息数组清洗：丢弃非法条目，并只保留最新 N 条 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && typeof m === 'object' && typeof m.role === 'string')
    .slice(-MAX_MESSAGES_PER_CONVERSATION)
}

/**
 * 规范化从 localStorage 读出的会话列表。
 * 脏数据（非数组 / 缺 sid / sid 重复 / messages 非数组）一律修正或丢弃，不抛异常。
 */
export function normalizeConversations(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const sid = typeof item.sid === 'string' ? item.sid.trim() : ''
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    const messages = sanitizeMessages(item.messages)
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
    out.push({
      sid,
      title: typeof item.title === 'string' ? item.title : deriveConversationTitle(messages),
      createdAt,
      updatedAt,
      // 是否已在服务端确认存在：用于跨浏览器删除同步（曾同步过但服务端消失 -> 移除）。
      // 旧版本缓存没有该字段：有消息的会话说明曾成功发送过，按已同步处理；
      // 全新空白会话（无消息）保持未同步，避免误删草稿。
      synced: item.synced === true || (item.synced === undefined && messages.length > 0),
      messages,
    })
    if (out.length >= MAX_CONVERSATIONS) break
  }
  return out
}

/**
 * 新建会话：**只追加**空白会话，绝不删除已有会话。
 *
 * 边界：当前会话仍为空白时直接复用（created=false），避免连续点击堆积空会话。
 *
 * @returns {{list: Array, sid: string, created: boolean}}
 */
export function startNewConversation(list, activeSid, { now = Date.now(), sid } = {}) {
  const conversations = Array.isArray(list) ? list : []
  const active = findConversation(conversations, activeSid)
  if (isBlankConversation(active)) {
    return { list: conversations, sid: active.sid, created: false }
  }
  const conv = createConversation({ sid, now })
  const next = [conv, ...conversations]
  // 超出上限仅丢弃最旧（尾部）条目；新会话在头部，不会被丢弃
  if (next.length > MAX_CONVERSATIONS) next.length = MAX_CONVERSATIONS
  return { list: next, sid: conv.sid, created: true }
}

/**
 * 用服务端历史填充本地空会话（只读恢复，不改变会话活跃时间）。
 *
 * 与 ``updateConversationMessages`` 的区别：
 * - 仅在本地消息为空时填充，绝不覆盖本地已有内容（避免冲掉正在流式的结果）；
 * - **不修改 updatedAt**，否则「切换查看历史」会把旧会话错误地顶到列表最前面。
 *
 * 找不到目标 / 本地已有消息 / 服务端无消息时返回原数组引用。
 */
export function fillConversationMessages(list, sid, messages) {
  const next = Array.isArray(list) ? list.slice() : []
  const index = next.findIndex((conv) => conv && conv.sid === sid)
  if (index < 0) return list
  const target = next[index]
  if (Array.isArray(target.messages) && target.messages.length > 0) return list
  const safe = sanitizeMessages(messages)
  if (safe.length === 0) return list
  next[index] = {
    ...target,
    messages: safe,
    title: target.title || deriveConversationTitle(safe),
    // 服务端有历史说明该会话已落库，用于跨端删除识别
    synced: true,
  }
  return next
}

/**
 * 更新指定会话的消息列表（只影响该 sid，其余会话原样保留）。
 * 会话不存在时返回原数组（同一引用），由调用方判断是否需要落库。
 *
 * @param {Array} list 会话列表
 * @param {string} sid 目标会话 ID
 * @param {Function|Array} updater 消息更新函数或新数组
 * @param {number} now 更新时间戳
 */
export function updateConversationMessages(list, sid, updater, now = Date.now()) {
  const conversations = Array.isArray(list) ? list : []
  const idx = conversations.findIndex((c) => c && c.sid === sid)
  if (idx < 0) return conversations
  const target = conversations[idx]
  const prevMessages = Array.isArray(target.messages) ? target.messages : []
  const rawNext = typeof updater === 'function' ? updater(prevMessages) : updater
  if (!Array.isArray(rawNext)) return conversations
  const messages = sanitizeMessages(rawNext)
  const next = conversations.slice()
  next[idx] = {
    ...target,
    messages,
    title: target.title || deriveConversationTitle(messages),
    updatedAt: now,
  }
  return next
}

/** 清空全部历史：显式替换为一条空白会话（仅由「清空历史」入口调用） */
export function clearAllConversations({ now = Date.now(), sid } = {}) {
  return [createConversation({ sid, now })]
}
