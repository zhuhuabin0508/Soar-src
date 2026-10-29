/**
 * 对话会话的服务端同步纯函数。
 *
 * 服务端是会话列表与历史消息的权威来源（chat_sessions / chat_messages），
 * 本地 localStorage 只做展示层缓存。本模块负责：
 * - ``mergeServerSessions``：把服务端会话列表与本地列表合并（保留本地
 *   已存在但尚未/无法落库的会话，避免误删），并给出需要拉取消息的 sid；
 * - ``toDisplayMessages``：把服务端消息行转换为前端消息结构。
 */
import { MAX_CONVERSATIONS } from './chatConversations.js'

/** 时间值（数字毫秒 / ISO 字符串）-> 毫秒时间戳 */
export function toMillis(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value) return fallback
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? fallback : parsed
}

/** 服务端会话结构 [{session_id,title,created_at,updated_at}] -> 本地会话结构 */
export function serverSessionsToConversations(serverSessions, now = Date.now()) {
  if (!Array.isArray(serverSessions)) return []
  const out = []
  const seen = new Set()
  for (const item of serverSessions) {
    if (!item || typeof item !== 'object') continue
    const sid = typeof item.session_id === 'string' ? item.session_id.trim() : ''
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    const createdAt = toMillis(item.created_at, now)
    const updatedAt = toMillis(item.updated_at, createdAt)
    out.push({
      sid,
      title: typeof item.title === 'string' ? item.title : '',
      createdAt,
      updatedAt,
      // 服务端存在即视为已同步，用于识别其它浏览器上的删除操作
      synced: true,
      messages: [],
    })
  }
  return out
}

/**
 * 合并服务端会话列表与本地会话列表。
 *
 * - 本地已有会话（含本地消息）原样保留，只补充服务端的时间/标题；
 * - 服务端有、本地没有的会话追加进列表，并放入 missingSids 供调用方拉取消息；
 * - 本地有、服务端没有的会话：
 *   * 从未同步过（刚新建未发送 / 落库失败）**保留**，避免误删草稿；
 *   * 曾经同步过（``synced === true``）则说明已在其它浏览器被删除，**移除本地残留**，
 *     保证跨端删除一致；
 * - 按 updatedAt 倒序，最多保留 max 条。
 *
 * @returns {{list: Array, missingSids: string[]}}
 */
export function mergeServerSessions(localList, serverSessions, options = {}) {
  const now = options.now || Date.now()
  const max = Number.isFinite(options.max) ? options.max : MAX_CONVERSATIONS
  // 服务端分页未取完时不把「本页不存在」当成删除，避免误删仍存在于后续页的会话
  const allowRemoteDeletion = options.allowRemoteDeletion !== false
  const local = Array.isArray(localList) ? localList : []
  const server = serverSessionsToConversations(serverSessions, now)
  const serverMap = new Map(server.map((c) => [c.sid, c]))
  const localSids = new Set(local.map((c) => c && c.sid).filter(Boolean))

  const merged = []
  for (const conv of local.filter(Boolean)) {
    const remote = serverMap.get(conv.sid)
    if (!remote) {
      // 曾同步过但服务端已不存在：仅在拿到**完整快照**时判定为其它端的删除
      if (conv.synced === true && allowRemoteDeletion) continue
      merged.push({ ...conv })
      continue
    }
    // 时间以服务端为准：不同浏览器/设备的本地时钟可能偏差，用服务端时间排序才不会错乱
    merged.push({
      ...conv,
      title: conv.title || remote.title,
      createdAt: remote.createdAt || conv.createdAt,
      updatedAt: remote.updatedAt || conv.updatedAt,
      synced: true,
    })
  }

  const missingSids = []
  for (const remote of server) {
    if (localSids.has(remote.sid)) continue
    merged.push(remote)
    missingSids.push(remote.sid)
  }

  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const list = merged.slice(0, max)
  const kept = new Set(list.map((c) => c.sid))
  return { list, missingSids: missingSids.filter((sid) => kept.has(sid)) }
}

/**
 * 服务端消息行 -> 前端消息结构。
 * 仅接受 user/assistant；跳过空内容且无工具调用的行与非法数据。
 */
export function toDisplayMessages(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return []
  const out = []
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return
    const role = row.role
    if (role !== 'user' && role !== 'assistant') return
    const content = typeof row.content === 'string' ? row.content : ''
    const toolCalls = Array.isArray(row.toolCalls)
      ? row.toolCalls.filter((tc) => tc && typeof tc === 'object')
      : []
    if (!content && toolCalls.length === 0) return
    const message = {
      id:
        typeof row.id === 'string' && row.id
          ? row.id
          : `srv-${now}-${index}`,
      role,
      content,
      timestamp: toMillis(row.timestamp, now),
    }
    if (toolCalls.length > 0) {
      // 服务端用 id 标识工具调用，前端时间线用 call_id，统一补齐
      message.toolCalls = toolCalls.map((tc) => ({
        ...tc,
        call_id: tc.call_id || tc.id || '',
      }))
    }
    out.push(message)
  })
  return out
}
