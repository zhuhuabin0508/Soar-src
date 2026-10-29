/**
 * 对话会话的浏览器本地缓存（localStorage）读写。
 *
 * 关键设计：
 * - key 按「登录用户 + 智能体」双维度隔离，同一浏览器切换账号不会串对话；
 * - 所有读写都做异常兜底：无痕/禁用存储时返回空、写入静默失败，页面仍可正常使用；
 * - 不读取旧版未按用户隔离的 key，避免把上一位账号的本地缓存带进新账号。
 *
 * 说明：本地缓存只是「展示层加速」。会话列表与消息的服务端来源是
 * GET /agents/{id}/chat/sessions 与 .../messages，换浏览器/无痕模式可由服务端补齐。
 */

const CONVERSATIONS_PREFIX = 'soar_chat_v2_conversations'
const ACTIVE_PREFIX = 'soar_chat_v2_active'

function scope(userId) {
  return userId === null || userId === undefined || userId === '' ? 'anonymous' : String(userId)
}

/** 会话列表缓存 key */
export function conversationsKey(userId, agentId) {
  return `${CONVERSATIONS_PREFIX}_u${scope(userId)}_a${agentId}`
}

/** 当前活动会话缓存 key */
export function activeSidKey(userId, agentId) {
  return `${ACTIVE_PREFIX}_u${scope(userId)}_a${agentId}`
}

function safeGet(storage, key) {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(storage, key, value) {
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    // 配额超限 / 隐私模式禁用存储：静默失败，不影响页面使用
    return false
  }
}

/** 读取会话列表原始数组（未做规范化，调用方自行 normalize） */
export function loadConversations(storage, userId, agentId) {
  const raw = safeGet(storage, conversationsKey(userId, agentId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    // 脏数据（字符串/对象/数字）一律降级为空列表
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 保存会话列表；返回是否写入成功（序列化失败也按失败处理，不抛异常） */
export function saveConversations(storage, userId, agentId, list) {
  const payload = Array.isArray(list) ? list : []
  let raw
  try {
    raw = JSON.stringify(payload)
  } catch {
    // 循环引用/不可序列化内容：降级为不写缓存，页面继续可用
    return false
  }
  return safeSet(storage, conversationsKey(userId, agentId), raw)
}

/** 读取当前活动会话 ID */
export function loadActiveSid(storage, userId, agentId) {
  return safeGet(storage, activeSidKey(userId, agentId)) || ''
}

/** 保存当前活动会话 ID */
export function saveActiveSid(storage, userId, agentId, sid) {
  return safeSet(storage, activeSidKey(userId, agentId), sid || '')
}

/**
 * 清空**所有用户**的对话缓存（登出 / 凭证失效时调用）。
 *
 * 本地缓存包含对话正文，属于登录用户的私有数据；登出或 token 失效后
 * 必须一并清除，避免同一浏览器上的后续使用者（访客）看到残留对话记录。
 * 缓存只是展示层加速，下次登录后由服务端完整重建，不损失数据。
 *
 * @returns {number} 实际清除的 key 数量（存储不可用时返回 0，不抛异常）
 */
export function purgeChatCaches(storage) {
  if (!storage) return 0
  let removed = 0
  try {
    const keys = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (
        key &&
        (key.startsWith(`${CONVERSATIONS_PREFIX}_`) || key.startsWith(`${ACTIVE_PREFIX}_`))
      ) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      try {
        storage.removeItem(key)
        removed++
      } catch {
        // 单个 key 删除失败不影响其余清理
      }
    }
  } catch {
    // 存储被禁用（无痕模式等）：静默失败
  }
  return removed
}
