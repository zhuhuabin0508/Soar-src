/**
 * 对话流式任务（后台）管理器。
 *
 * 背景：原先「智能体思考 / 生成回复」的 SSE 读取循环写在 ChatPage 组件的
 * 回调里，并绑定了组件生命周期——切换智能体、切换会话、离开对话页都会
 * abort 请求，导致回复被截断。
 *
 * 这里把「一次生成」抽象成与 React 无关的后台任务：
 * - 任务按 (userId, agentId, sessionId) 独立存放，多个智能体 / 多个会话可并行生成；
 * - 生成过程中的消息状态（content / thinking / toolCalls / statusMsgs / ...）
 *   在模块级累积，页面重新挂载后通过 subscribeTaskUpdates 回放，内容不丢失、不断层；
 * - 任务结束时把最终助手消息写回 localStorage 会话缓存（页面未挂载也不丢内容）；
 * - 只有显式「停止生成 / 删除会话 / 清空历史 / 切换账号」才会中止对应任务。
 */
import { agents as agentsApi } from '../api/client'
import { toast } from './toastStore'
import { loadConversations, saveConversations } from '../utils/chatStorage'
import {
  findConversation,
  normalizeConversations,
  updateConversationMessages,
} from '../utils/chatConversations'

/** 已完成任务的结果保留时长：供页面在此时段内重新挂载时回放（之后由会话缓存兜底） */
const RESULT_TTL_MS = 10 * 60 * 1000

/** key -> task（模块级单例，跨页面路由存活） */
const tasks = new Map()
/** 订阅者：任何任务状态变化都会触发，用于把内容镜像到 React 状态 */
const listeners = new Set()

function normalizeUser(userId) {
  return userId === null || userId === undefined ? '' : String(userId)
}

function streamKey(userId, agentId, sid) {
  return `${normalizeUser(userId)}:${agentId}:${sid || 'default'}`
}

/** 对外暴露的任务快照（避免调用方直接拿到内部可变对象） */
function publicTask(task) {
  return {
    key: task.key,
    userId: task.userId,
    agentId: task.agentId,
    sid: task.sid,
    messageId: task.messageId,
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt || null,
    message: { ...task.message },
    userMessage: task.userMessage ? { ...task.userMessage } : null,
  }
}

function notify(task) {
  if (!task || task.discarded) return
  const payload = publicTask(task)
  for (const listener of listeners) {
    try {
      listener(payload)
    } catch {
      // 单个订阅者异常不影响流式本身与其它订阅者
    }
  }
}

function patchMessage(task, patch) {
  task.message = { ...task.message, ...patch }
}

// ============================================================================
// 对外查询
// ============================================================================

/** 订阅任务更新；订阅瞬间会回放当前所有任务（含已完成未过期任务），便于页面重新挂载后续接 */
export function subscribeTaskUpdates(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  for (const task of tasks.values()) {
    if (task.discarded) continue
    try {
      listener(publicTask(task))
    } catch {
      // 忽略订阅者异常
    }
  }
  return () => {
    listeners.delete(listener)
  }
}

/** 获取某个会话当前的后台任务（没有则返回 null） */
export function getChatTask(userId, agentId, sid) {
  const task = tasks.get(streamKey(userId, agentId, sid))
  if (!task || task.discarded) return null
  return publicTask(task)
}

/** 列出后台任务（可按用户 / 智能体过滤），用于侧栏生成中标识与重新挂载回放 */
export function listChatTasks({ userId, agentId } = {}) {
  const scope = userId === undefined || userId === null ? null : normalizeUser(userId)
  const aid = agentId === undefined || agentId === null ? null : String(agentId)
  const out = []
  for (const task of tasks.values()) {
    if (task.discarded) continue
    if (scope !== null && task.userId !== scope) continue
    if (aid !== null && task.agentId !== aid) continue
    out.push(publicTask(task))
  }
  return out
}

// ============================================================================
// 任务控制
// ============================================================================

/**
 * 启动一次后台生成任务。
 *
 * @param {object} params
 * @param {string|number} params.userId 当前登录用户
 * @param {string|number} params.agentId 智能体 ID
 * @param {string} params.sid 会话 ID
 * @param {string} params.text 用户输入
 * @param {object} params.override 会话级参数覆盖
 * @param {string} params.messageId 前端占位助手消息 ID（用于把流式结果合并回会话）
 * @param {object} params.userMessage 本轮用户消息快照（页面切换导致缓存未落盘时用于补齐）
 * @returns {object|null} 任务快照；同一会话已有任务在生成时返回 null
 */
export function startChatStream({ userId, agentId, sid, text, override, messageId, userMessage }) {
  const key = streamKey(userId, agentId, sid)
  const existing = tasks.get(key)
  if (existing && existing.status === 'streaming') return null

  const task = {
    key,
    userId: normalizeUser(userId),
    agentId: String(agentId),
    sid: sid || 'default',
    messageId,
    userMessage: userMessage ? { ...userMessage } : null,
    status: 'streaming',
    startedAt: Date.now(),
    controller: new AbortController(),
    message: {
      id: messageId,
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
      delegateGroups: [],
      statusMsgs: [],
      clarifies: [],
      files: [],
    },
    pendingContent: '',
    pendingThinking: '',
    flushTimer: null,
    fullText: '',
    discarded: false,
    cleanupTimer: null,
  }
  if (existing && existing.cleanupTimer) clearTimeout(existing.cleanupTimer)
  tasks.set(key, task)
  notify(task)
  void runTask(task, text, override)
  return publicTask(task)
}

/** 中止某个会话的生成（用户点击停止）；保留已生成内容并标记 [已中止] */
export function abortChatTask(userId, agentId, sid) {
  const task = tasks.get(streamKey(userId, agentId, sid))
  if (!task || task.discarded) return false
  if (task.controller) {
    try {
      task.controller.abort()
    } catch {
      // 已结束的请求 abort 会抛错，忽略
    }
  }
  return true
}

/**
 * 中止并丢弃某智能体下的任务（清空历史 / 删除会话时调用）。
 * 丢弃后不会再回放结果，也不会写回会话缓存，避免已删除的对话被“复活”。
 *
 * @param {string|number} agentId
 * @param {string[]|null} sids 仅中止这些会话；传 null 表示该智能体全部会话
 */
export function discardChatTasks(agentId, sids = null) {
  const targets = Array.isArray(sids) ? new Set(sids.map(String)) : null
  for (const task of [...tasks.values()]) {
    if (task.agentId !== String(agentId)) continue
    if (targets && !targets.has(String(task.sid))) continue
    task.discarded = true
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
    if (task.controller) {
      try {
        task.controller.abort()
      } catch {
        // 忽略
      }
      task.controller = null
    }
    tasks.delete(task.key)
  }
}

/** 丢弃某条助手消息对应的后台结果（消息被删除 / 重新生成时调用，避免旧结果被回放） */
export function discardTaskResult(messageId) {
  if (!messageId) return
  for (const task of [...tasks.values()]) {
    if (task.messageId !== messageId) continue
    task.discarded = true
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
    if (task.controller) {
      try {
        task.controller.abort()
      } catch {
        // 忽略
      }
      task.controller = null
    }
    tasks.delete(task.key)
  }
}

/** 中止不属于当前账号的残留任务（切换账号时调用，避免旧账号继续生成） */
export function abortTasksForOtherUser(userScope) {
  const scope = normalizeUser(userScope)
  for (const task of tasks.values()) {
    if (task.userId === scope) continue
    if (task.controller) {
      try {
        task.controller.abort()
      } catch {
        // 忽略
      }
    }
  }
}

// ============================================================================
// 内部实现：SSE 读取循环
// ============================================================================

function flush(task) {
  if (task.flushTimer !== null) {
    clearTimeout(task.flushTimer)
    task.flushTimer = null
  }
  if (!task.pendingContent && !task.pendingThinking) return
  const contentDelta = task.pendingContent
  const thinkingDelta = task.pendingThinking
  task.pendingContent = ''
  task.pendingThinking = ''
  patchMessage(task, {
    content: contentDelta ? (task.message.content || '') + contentDelta : task.message.content || '',
    thinking:
      thinkingDelta ? (task.message.thinking || '') + thinkingDelta : task.message.thinking || '',
  })
  notify(task)
}

function scheduleFlush(task) {
  if (task.flushTimer !== null) return
  task.flushTimer = setTimeout(() => {
    task.flushTimer = null
    flush(task)
  }, 60)
}

/** 解析单个 Hermes SSE 事件并更新任务内的消息状态（与后端 sse.py 契约一致） */
function applyEvent(task, data) {
  switch (data.type) {
    case 'thinking':
      task.pendingThinking += data.content || ''
      scheduleFlush(task)
      return
    case 'token':
      task.fullText += data.content || ''
      task.pendingContent += data.content || ''
      scheduleFlush(task)
      return
    case 'status':
      patchMessage(task, {
        statusMsgs: [...(task.message.statusMsgs || []), data.message || ''],
      })
      break
    case 'log':
      patchMessage(task, {
        statusMsgs: [
          ...(task.message.statusMsgs || []),
          `[${data.level || 'info'}] ${data.message || ''}`,
        ],
      })
      break
    case 'tool_start': {
      flush(task)
      // ReAct 每轮迭代先输出一段「我先查询…」的中间叙述：移入执行过程，
      // 回答气泡只保留最终回答，避免多轮重复拼接。
      const narration = (task.message.content || '').trim()
      patchMessage(task, {
        content: '',
        statusMsgs: narration
          ? [...(task.message.statusMsgs || []), `[分析] ${narration}`]
          : task.message.statusMsgs || [],
        toolCalls: [
          ...(task.message.toolCalls || []),
          {
            name: data.tool_name || '',
            call_id: data.tool_call_id || '',
            status: 'running',
            message: data.message || '',
          },
        ],
      })
      break
    }
    case 'tool_end': {
      const toolCalls = [...(task.message.toolCalls || [])]
      const idx = toolCalls.findIndex(
        (tc) => tc.call_id === data.tool_call_id && tc.status === 'running'
      )
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          status: 'done',
          result: data.result,
          message: data.message || toolCalls[idx].message,
        }
      }
      patchMessage(task, { toolCalls })
      break
    }
    case 'reset': {
      // 后端检测到退化输出（重复计划叙述）并重试：清空已流式的退化文本，
      // 最终回答以下一轮 token / done 为准
      flush(task)
      task.fullText = ''
      const narration = (task.message.content || '').trim()
      const brief = narration
        ? `[分析] ${narration.slice(0, 300)}${narration.length > 300 ? '…（已重置）' : ''}`
        : ''
      patchMessage(task, {
        content: '',
        statusMsgs: brief
          ? [...(task.message.statusMsgs || []), brief]
          : task.message.statusMsgs || [],
      })
      break
    }
    case 'file':
      flush(task)
      patchMessage(task, {
        files: [
          ...(task.message.files || []).filter((x) => x.file_id !== data.file_id),
          {
            file_id: data.file_id,
            file_name: data.file_name || '',
            rows: data.rows ?? null,
            columns: data.columns ?? null,
          },
        ],
      })
      break
    case 'clarify':
      flush(task)
      patchMessage(task, {
        clarifies: [
          ...(task.message.clarifies || []),
          {
            question: data.question || '',
            choices: Array.isArray(data.choices)
              ? data.choices.filter((c) => c != null && String(c).trim() !== '')
              : [],
            answered: null,
          },
        ],
      })
      break
    case 'delegate': {
      const info = data.result || {}
      const subagentId = info.subagent_id || 'unknown'
      const evt = info.event || {}
      const groups = [...(task.message.delegateGroups || [])]
      let gIdx = groups.findIndex((g) => g.subagent_id === subagentId)
      if (gIdx < 0) {
        groups.push({
          subagent_id: subagentId,
          task_index: info.task_index ?? 0,
          status: 'running',
          goal: '',
          events: [],
          expanded: false,
        })
        gIdx = groups.length - 1
      } else {
        groups[gIdx] = { ...groups[gIdx], events: [...groups[gIdx].events] }
      }
      if (evt.type === 'start' && evt.message) {
        groups[gIdx].goal = evt.message
      }
      if (evt.type === 'done') groups[gIdx].status = 'completed'
      else if (evt.type === 'error') groups[gIdx].status = 'failed'
      groups[gIdx].events.push({
        type: evt.type || 'unknown',
        content: evt.content || '',
        message: evt.message || '',
        tool_name: evt.tool_name || '',
        result: evt.result ?? null,
      })
      patchMessage(task, { delegateGroups: groups })
      break
    }
    case 'done':
      flush(task)
      // 回答气泡只保留最终一轮回复：中间轮次叙述已移入执行过程，
      // 不回退到 fullText，避免把每轮重复的分析拼成一段重复回复
      patchMessage(task, {
        content: task.message.content || data.content || '',
        status: 'done',
        usage: data.usage || null,
      })
      break
    case 'error':
      flush(task)
      patchMessage(task, {
        status: 'error',
        content: task.message.content || `[错误] ${data.message || ''}`,
      })
      break
    default:
      return
  }
  notify(task)
}

/** 任务结束：把最终助手消息写回 localStorage 会话缓存（页面未挂载时的兜底） */
function persistTaskResult(task) {
  if (task.discarded) return
  try {
    const list = normalizeConversations(
      loadConversations(localStorage, task.userId, task.agentId)
    )
    if (!list.length || !findConversation(list, task.sid)) return
    const snapshot = { ...task.message }
    const userSnapshot = task.userMessage ? { ...task.userMessage } : null
    const next = updateConversationMessages(list, task.sid, (msgs) => {
      let working = msgs
      // 用户消息可能因页面切换时缓存未及时落盘而缺失：补齐，避免只剩半条对话
      if (userSnapshot && !working.some((m) => m && m.id === userSnapshot.id)) {
        const aiAt = working.findIndex((m) => m && m.id === snapshot.id)
        const insertAt = aiAt < 0 ? working.length : aiAt
        working = [
          ...working.slice(0, insertAt),
          userSnapshot,
          ...working.slice(insertAt),
        ]
      }
      const idx = working.findIndex((m) => m && m.id === snapshot.id)
      if (idx < 0) return [...working, snapshot]
      const copy = working.slice()
      copy[idx] = { ...working[idx], ...snapshot }
      return copy
    })
    saveConversations(localStorage, task.userId, task.agentId, next)
  } catch {
    // 无痕模式 / 配额超限：静默失败，服务端仍是权威数据源
  }
}

function finalize(task) {
  if (task.flushTimer !== null) {
    clearTimeout(task.flushTimer)
    task.flushTimer = null
  }
  if (task.message.status === 'streaming') {
    patchMessage(task, {
      // 有工具调用时中间叙述已进入执行过程，不再用 fullText 回填
      content: task.message.content || ((task.message.toolCalls || []).length ? '' : task.fullText),
      status: 'done',
    })
  }
  task.status = task.message.status === 'streaming' ? 'done' : task.message.status
  task.finishedAt = Date.now()
  task.controller = null
  notify(task)
  persistTaskResult(task)

  if (task.discarded) return
  task.cleanupTimer = setTimeout(() => {
    if (tasks.get(task.key) === task) tasks.delete(task.key)
  }, RESULT_TTL_MS)
}

async function runTask(task, text, override) {
  const controller = task.controller
  try {
    const resp = await agentsApi.chatStream(task.agentId, text, controller.signal, task.sid, override)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      let detail = errText
      try {
        const parsed = JSON.parse(errText)
        detail = parsed?.detail || parsed?.message || errText
      } catch {
        // 非 JSON 响应体：沿用原文
      }
      // 会话已被软删除（墓碑）：提示新建会话，不再写回被删除的会话
      if (resp.status === 409) {
        toast.error(detail || '该对话已被删除，请新建会话后重试')
      }
      throw new Error(detail || `HTTP ${resp.status}`)
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let data
        try {
          data = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        applyEvent(task, data)
      }
    }
    // 末行可能没有换行符：补处理一条未以 \n 结尾的事件
    if (buffer.startsWith('data: ')) {
      try {
        applyEvent(task, JSON.parse(buffer.slice(6)))
      } catch {
        // 忽略不完整数据
      }
    }
  } catch (err) {
    flush(task)
    if (err && err.name === 'AbortError') {
      // 用户主动停止
      if (task.message.status === 'streaming') {
        patchMessage(task, {
          status: 'done',
          content: (task.message.content || '') + '\n\n_[已中止]_',
        })
      }
    } else if (task.message.status === 'streaming') {
      patchMessage(task, {
        status: 'error',
        content: task.message.content || `[请求失败] ${err?.message || err}`,
      })
    }
  } finally {
    finalize(task)
  }
}
