/**
 * 对话页面 —— 左右分栏布局
 *
 * 左侧（~280px）：智能体导航区（搜索 / 分组 / 选中高亮 / 置顶）
 * 右侧（flex-1）：对话功能区（欢迎态 / 消息气泡 / 流式打字机 / 自适应输入）
 *
 * 会话历史使用 localStorage 持久化（按 agentId 隔离），切换智能体不串对话。
 * 流式输出复用 AgentEditor 的 SSE 解析逻辑（Hermes 引擎）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MessageSquare, Sparkles, Settings, Pin, MapPin, Brain, ScrollText, Paperclip, Check,
  X, Loader2, AlertTriangle, Sheet, FileText, File, Flag, Wrench, Download,
  ChevronDown, ChevronRight, HelpCircle, ArrowUp,
} from 'lucide-react'
import { agents as agentsApi, agentFiles as agentFilesApi, llmConfigs as llmConfigsApi } from '../api/client'
import MarkdownRenderer from '../components/MarkdownRenderer'
import { EmptyState, Skeleton } from '../components/ui'
import { toast } from '../store/toastStore'
import {
  defaultOverride, loadOverrides, saveOverrides, buildOverride,
  countEnabledParams, isSystemPromptModified, isModelOverridden,
} from '../hooks/useChatOverrides'
import ChatToolbar from '../components/chat/ChatToolbar'
import ModelSwitcher from '../components/chat/ModelSwitcher'
import SystemPromptEditor from '../components/chat/SystemPromptEditor'
import MessageEditor from '../components/chat/MessageEditor'
import ThinkingPanel from '../components/chat/ThinkingPanel'
import ToolTimeline from '../components/chat/ToolTimeline'

// ============================================================================
// 常量 & 工具
// ============================================================================
const SIDEBAR_WIDTH = 280
const SIDEBAR_MIN = 240
const INPUT_MAX_HEIGHT = 200

// localStorage 键
const LS_HISTORY_PREFIX = 'soar_chat_history_'
const LS_PINNED = 'soar_chat_pinned_agents'
const LS_SELECTED = 'soar_chat_selected_agent'

// 生成唯一消息 ID
const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// 读取智能体会话历史
function loadHistory(agentId) {
  try {
    const raw = localStorage.getItem(`${LS_HISTORY_PREFIX}${agentId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// 保存智能体会话历史
function saveHistory(agentId, messages) {
  try {
    // 限制存储条数，避免 localStorage 溢出
    const trimmed = messages.slice(-200)
    localStorage.setItem(`${LS_HISTORY_PREFIX}${agentId}`, JSON.stringify(trimmed))
  } catch {
    // localStorage 满了静默失败
  }
}

// 会话 ID（Hermes 引擎按 (agentId, sessionId) 持久化多轮对话上下文）
const LS_SESSION_PREFIX = 'soar_chat_session_'
const genSessionId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

function loadSessionId(agentId) {
  try {
    return localStorage.getItem(`${LS_SESSION_PREFIX}${agentId}`) || ''
  } catch {
    return ''
  }
}

function saveSessionId(agentId, sid) {
  try {
    localStorage.setItem(`${LS_SESSION_PREFIX}${agentId}`, sid)
  } catch {
    // ignore
  }
}

// 读取置顶列表
function loadPinned() {
  try {
    const raw = localStorage.getItem(LS_PINNED)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function savePinned(ids) {
  try {
    localStorage.setItem(LS_PINNED, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

// ============================================================================
// 主页面
// ============================================================================
export default function ChatPage() {
  // ----- 智能体列表 -----
  const [agentList, setAgentList] = useState([])
  const [loadingAgents, setLoadingAgents] = useState(true)

  // ----- 选中的智能体 -----
  const [selectedAgentId, setSelectedAgentId] = useState(() => {
    try {
      return localStorage.getItem(LS_SELECTED) || ''
    } catch {
      return ''
    }
  })

  // ----- 搜索 -----
  const [searchQuery, setSearchQuery] = useState('')

  // ----- 置顶 -----
  const [pinnedIds, setPinnedIds] = useState(() => loadPinned())

  // ----- 会话历史（按 agentId） -----
  const [histories, setHistories] = useState({})
  // 当前选中智能体的消息列表
  const currentMessages = selectedAgentId ? histories[selectedAgentId] || [] : []

  // 会话 ID（按 agentId 隔离）：Hermes 引擎多轮对话上下文持久化键
  const [sessionIds, setSessionIds] = useState({})

  // ----- 流式状态 -----
  const [streaming, setStreaming] = useState(false)
  const abortControllerRef = useRef(null)

  // ----- 输入文本 -----
  const [inputText, setInputText] = useState('')

  // ----- 上传文件（不做 RAG，供 read_document 工具读取） -----
  const [uploadedFiles, setUploadedFiles] = useState([])
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set())
  const [uploading, setUploading] = useState(false)

  // ----- 会话级参数覆盖（对标 new-api Playground）-----
  // 按 agentId 隔离持久化到 localStorage，切换智能体时参数独立
  const [overrides, setOverrides] = useState({})
  // LLM 配置列表（供模型切换下拉用）
  const [llmConfigs, setLlmConfigs] = useState([])

  // ----- 加载智能体列表 -----
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoadingAgents(true)
      try {
        const list = await agentsApi.list({ usable: true })
        if (!alive) return
        const arr = Array.isArray(list) ? list : []
        setAgentList(arr)
        const restored = localStorage.getItem(LS_SELECTED)
        const exists = restored && arr.find((a) => String(a.id) === String(restored))
        if (arr.length > 0) {
          setSelectedAgentId(exists ? String(exists.id) : String(arr[0].id))
        } else {
          setSelectedAgentId('')
        }
      } catch {
        // ignore
      } finally {
        if (alive) setLoadingAgents(false)
      }
    })()
    return () => { alive = false }
  }, [])

  // ----- 选中智能体变化时加载历史 -----
  useEffect(() => {
    if (!selectedAgentId) return
    try {
      localStorage.setItem(LS_SELECTED, selectedAgentId)
    } catch {
      // ignore
    }
    // 从 localStorage 加载历史到内存
    if (!histories[selectedAgentId]) {
      const msgs = loadHistory(selectedAgentId)
      setHistories((prev) => ({ ...prev, [selectedAgentId]: msgs }))
    }
    // 确保该智能体有会话 ID（无则生成并持久化）
    if (!sessionIds[selectedAgentId]) {
      const sid = loadSessionId(selectedAgentId) || genSessionId()
      saveSessionId(selectedAgentId, sid)
      setSessionIds((prev) => ({ ...prev, [selectedAgentId]: sid }))
    }
    // 从 localStorage 加载 overrides（参数覆盖配置），无则用默认
    if (!overrides[selectedAgentId]) {
      const saved = loadOverrides(selectedAgentId)
      setOverrides((prev) => ({ ...prev, [selectedAgentId]: saved || defaultOverride() }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId])

  // ----- 中止当前流式 -----
  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setStreaming(false)
  }, [])

  // ----- 切换智能体 -----
  const selectAgent = useCallback(
    (agentId) => {
      if (agentId === selectedAgentId) return
      // 中止当前流式
      if (streaming) abortStream()
      setSelectedAgentId(String(agentId))
    },
    [selectedAgentId, streaming, abortStream]
  )

  // ----- 置顶/取消置顶 -----
  const togglePin = useCallback((agentId) => {
    const id = String(agentId)
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id]
      savePinned(next)
      return next
    })
  }, [])

  // ----- 新建会话 / 清空对话（删除旧会话服务端记忆 + 清空本地历史 + 生成新会话 ID） -----
  const newConversation = useCallback(() => {
    if (!selectedAgentId) return
    if (streaming) abortStream()
    // 旧会话的服务端记忆一并删除（真的清空，而非只清聊天框）；
    // 删除失败不阻断——新 session_id 本身也不会加载旧历史
    const oldSid = sessionIds[selectedAgentId]
    if (oldSid) {
      agentsApi
        .clearChatSession(selectedAgentId, oldSid)
        .catch(() => {})
    }
    // 生成新 session_id，使后端加载空历史（与新对话匹配）
    const sid = genSessionId()
    saveSessionId(selectedAgentId, sid)
    setSessionIds((prev) => ({ ...prev, [selectedAgentId]: sid }))
    setHistories((prev) => ({ ...prev, [selectedAgentId]: [] }))
    saveHistory(selectedAgentId, [])
    toast.success('已清空对话记忆，下次发送为全新会话')
  }, [selectedAgentId, streaming, abortStream, sessionIds])

  // ----- 更新当前消息列表 -----
  const updateMessages = useCallback(
    (updater) => {
      if (!selectedAgentId) return
      setHistories((prev) => {
        const cur = prev[selectedAgentId] || []
        const next = typeof updater === 'function' ? updater(cur) : updater
        saveHistory(selectedAgentId, next)
        return { ...prev, [selectedAgentId]: next }
      })
    },
    [selectedAgentId]
  )

  // ----- 更新当前智能体的 overrides（参数覆盖配置）-----
  // 与 updateMessages 同款按 agentId 隔离 + localStorage 持久化
  const updateOverrides = useCallback(
    (updater) => {
      if (!selectedAgentId) return
      setOverrides((prev) => {
        const cur = prev[selectedAgentId] || defaultOverride()
        const next = typeof updater === 'function' ? updater(cur) : updater
        saveOverrides(selectedAgentId, next)
        return { ...prev, [selectedAgentId]: next }
      })
    },
    [selectedAgentId]
  )

  // ----- 构造请求体的 override 对象（仅含启用的字段）-----
  const currentOverride = selectedAgentId ? overrides[selectedAgentId] : null
  const overridePayload = useMemo(
    () => buildOverride(currentOverride),
    [currentOverride]
  )

  // ----- 加载已上传文件列表（按当前智能体隔离：公共文件 + 本人上传）-----
  const loadUploadedFiles = useCallback(async () => {
    try {
      const list = await agentFilesApi.list(selectedAgentId || undefined)
      setUploadedFiles(Array.isArray(list) ? list : [])
    } catch {
      // 静默失败
    }
  }, [selectedAgentId])

  // ----- 加载 LLM 配置列表（供模型切换用）-----
  const loadLlmConfigs = useCallback(async () => {
    try {
      const list = await llmConfigsApi.list()
      setLlmConfigs(Array.isArray(list) ? list : [])
    } catch {
      // 静默失败，模型切换下拉会显示空
    }
  }, [])

  useEffect(() => {
    loadUploadedFiles()
    loadLlmConfigs()
  }, [loadUploadedFiles, loadLlmConfigs])

  // ----- 上传文件 -----
  const handleFileUpload = useCallback(
    async (file) => {
      if (!file) return
      // 前端校验：文件大小和类型
      const MAX_SIZE = 50 * 1024 * 1024 // 50MB
      const ALLOWED_EXT = ['.xlsx', '.xls', '.docx', '.pdf', '.csv', '.txt', '.md', '.json']
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase()
      if (!ALLOWED_EXT.includes(ext)) {
        toast.warning(`不支持的文件类型：${ext}，仅支持 ${ALLOWED_EXT.join(' / ')}`)
        return
      }
      if (file.size > MAX_SIZE) {
        toast.warning(`文件超过 50MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩或拆分后上传`)
        return
      }
      setUploading(true)
      try {
        await agentFilesApi.upload(file, selectedAgentId || undefined)
        await loadUploadedFiles()
      } catch (err) {
        toast.error(`文件上传失败：${err.message || err}`)
      } finally {
        setUploading(false)
      }
    },
    [loadUploadedFiles, selectedAgentId]
  )

  // ----- 删除文件 -----
  const handleDeleteFile = useCallback(
    async (fileId) => {
      try {
        await agentFilesApi.remove(fileId)
        setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId))
        setSelectedFileIds((prev) => {
          const next = new Set(prev)
          next.delete(fileId)
          return next
        })
      } catch (err) {
        toast.error(`文件删除失败：${err.message || err}`)
      }
    },
    []
  )

  // ----- 下载文件 -----
  const handleDownloadFile = useCallback(async (file) => {
    try {
      await agentFilesApi.download(file.id, file.original_name)
    } catch (err) {
      toast.error(`文件下载失败：${err.message || err}`)
    }
  }, [])

  // ----- 切换文件勾选 -----
  const toggleFileSelect = useCallback((fileId) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  // ----- 确保 read_document 工具已启用 -----
  const ensureReadDocumentEnabled = useCallback(
    async (agent) => {
      const tools = agent.enabled_tools || []
      if (tools.includes('read_document')) return agent
      try {
        const updated = { ...agent, enabled_tools: [...tools, 'read_document'] }
        await agentsApi.update(agent.id, updated)
        // 同步本地列表
        setAgentList((prev) =>
          prev.map((a) => (String(a.id) === String(agent.id) ? { ...a, enabled_tools: updated.enabled_tools } : a))
        )
        return updated
      } catch {
        // 启用失败不阻断发送，智能体可能仍能回答（无文件读取能力）
        return agent
      }
    },
    []
  )

  // ----- 发送消息（核心实现，接收文本参数）-----
  // 抽取为独立函数，供 sendMessage（输入框发送）和 regenerateFromMsg（重新生成）复用，
  // 避免依赖 inputText state 更新时序（setInputText 是异步的，setTimeout 触发不可靠）
  const sendText = useCallback(async (text) => {
    // 勾选的文件：自动启用 read_document 工具 + 将文件名注入消息上下文
    const selectedFiles = uploadedFiles.filter((f) => selectedFileIds.has(f.id))
    // 允许"仅发送附件"：文本为空但勾选了文件时也可发送；两者皆空才拦截
    if ((!text && selectedFiles.length === 0) || !selectedAgentId || streaming) return

    const agent = agentList.find((a) => String(a.id) === String(selectedAgentId))
    if (!agent) return

    let messageText = text
    if (selectedFiles.length > 0) {
      // 自动启用 read_document（如果尚未启用）
      await ensureReadDocumentEnabled(agent)
      // 将文件名列表注入消息，让 LLM 知道可读取哪些文件
      const fileList = selectedFiles.map((f) => `- ${f.original_name}`).join('\n')
      messageText =
        `[用户上传了以下文件，可使用 read_document 工具按文件名读取完整内容：\n${fileList}\n]\n\n${text}`
    }

    // 1. 追加用户消息 + 空的 AI 消息
    const userMsg = {
      id: genId(),
      role: 'user',
      content: messageText,
      timestamp: Date.now(),
    }
    const aiMsg = {
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
      delegateGroups: [],
      statusMsgs: [],
      clarifies: [],
    }
    updateMessages((prev) => [...prev, userMsg, aiMsg])
    setInputText('')
    setStreaming(true)

    // 2. 发起 SSE 流式请求
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const resp = await agentsApi.chatStream(
        selectedAgentId,
        messageText,
        controller.signal,
        sessionIds[selectedAgentId] || 'default',
        overridePayload,
      )

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(errText || `HTTP ${resp.status}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''
      // 节流缓冲：累积 token/thinking 内容，每 60ms 批量更新 UI
      // 避免 240+184 个事件逐个触发 React 重渲染导致浏览器卡死
      let pendingContent = ''
      let pendingThinking = ''
      let flushTimer = null
      const flushPending = () => {
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
        if (!pendingContent && !pendingThinking) return
        const cDelta = pendingContent
        const tDelta = pendingThinking
        pendingContent = ''
        pendingThinking = ''
        updateMessages((prev) =>
          prev.map((m) => {
            if (m.id !== aiMsg.id) return m
            const next = { ...m }
            if (cDelta) next.content = (m.content || '') + cDelta
            if (tDelta) next.thinking = (m.thinking || '') + tDelta
            return next
          })
        )
      }
      const scheduleFlush = () => {
        if (flushTimer === null) {
          flushTimer = setTimeout(flushPending, 60)
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))

              // ===== Hermes 引擎事件 =====
              switch (data.type) {
                case 'thinking':
                  pendingThinking += data.content || ''
                  scheduleFlush()
                  break
                case 'status':
                  // 引擎状态消息（如「正在执行 N 个工具调用…」），加入执行过程日志
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            statusMsgs: [...(m.statusMsgs || []), data.message || ''],
                          }
                        : m
                    )
                  )
                  break
                case 'log':
                  // 引擎日志（level + message），加入执行过程日志
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            statusMsgs: [
                              ...(m.statusMsgs || []),
                              `[${data.level || 'info'}] ${data.message || ''}`,
                            ],
                          }
                        : m
                    )
                  )
                  break
                case 'token':
                  fullText += data.content || ''
                  pendingContent += data.content || ''
                  scheduleFlush()
                  break
                case 'tool_start':
                  flushPending()
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            toolCalls: [
                              ...(m.toolCalls || []),
                              {
                                name: data.tool_name || '',
                                call_id: data.tool_call_id || '',
                                status: 'running',
                                message: data.message || '',
                              },
                            ],
                          }
                        : m
                    )
                  )
                  break
                case 'tool_end':
                  updateMessages((prev) =>
                    prev.map((m) => {
                      if (m.id !== aiMsg.id) return m
                      const tcs = [...(m.toolCalls || [])]
                      const idx = tcs.findIndex(
                        (tc) => tc.call_id === data.tool_call_id && tc.status === 'running'
                      )
                      if (idx >= 0) {
                        tcs[idx] = {
                          ...tcs[idx],
                          status: 'done',
                          result: data.result,
                          message: data.message || tcs[idx].message,
                        }
                      }
                      return { ...m, toolCalls: tcs }
                    })
                  )
                  break
                case 'file':
                  // 工具生成的输出文件：附加到 AI 消息，气泡内提供下载卡片
                  flushPending()
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            files: [
                              ...(m.files || []).filter((x) => x.file_id !== data.file_id),
                              {
                                file_id: data.file_id,
                                file_name: data.file_name || '',
                                rows: data.rows ?? null,
                                columns: data.columns ?? null,
                              },
                            ],
                          }
                        : m
                    )
                  )
                  break
                case 'clarify':
                  // 澄清提问：智能体无法确定目标（如多台设备都可查主机信息）时
                  // 向用户提问，前端渲染选项卡片，用户点击选项进入下一轮
                  flushPending()
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            clarifies: [
                              ...(m.clarifies || []),
                              {
                                question: data.question || '',
                                choices: Array.isArray(data.choices)
                                  ? data.choices.filter((c) => c != null && String(c).trim() !== '')
                                  : [],
                                answered: null,
                              },
                            ],
                          }
                        : m
                    )
                  )
                  break
                case 'delegate': {
                  const info = data.result || {}
                  const sid = info.subagent_id || 'unknown'
                  const evt = info.event || {}
                  updateMessages((prev) =>
                    prev.map((m) => {
                      if (m.id !== aiMsg.id) return m
                      const groups = [...(m.delegateGroups || [])]
                      let gIdx = groups.findIndex((g) => g.subagent_id === sid)
                      if (gIdx < 0) {
                        groups.push({
                          subagent_id: sid,
                          task_index: info.task_index ?? 0,
                          status: 'running',
                          goal: '',
                          events: [],
                          expanded: false,
                        })
                        gIdx = groups.length - 1
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
                      return { ...m, delegateGroups: groups }
                    })
                  )
                  break
                }
                case 'done':
                  flushPending()
                  // 不用 data.content 覆盖已累积的流式内容
                  // data.content 只包含最后一轮 LLM 回复，会丢失前面轮次的分析过程
                  // 保留 m.content（包含所有轮次的 token 累积），仅无累积时用 data.content 回退
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            content: m.content || data.content || fullText || '',
                            status: 'done',
                            usage: data.usage || null,
                          }
                        : m
                    )
                  )
                  break
                case 'error':
                  flushPending()
                  updateMessages((prev) =>
                    prev.map((m) =>
                      m.id === aiMsg.id
                        ? {
                            ...m,
                            status: 'error',
                            content: m.content || `[错误] ${data.message || ''}`,
                          }
                        : m
                    )
                  )
                  break
                default:
                  break
              }
          } catch {
            // JSON 解析错误忽略
          }
        }
      }

      // 流结束但未收到 done 事件，标记为 done
      flushPending()
      updateMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsg.id && m.status === 'streaming'
            ? { ...m, content: m.content || fullText, status: 'done' }
            : m
        )
      )
    } catch (err) {
      flushPending()
      if (err.name === 'AbortError') {
        // 用户主动中止
        updateMessages((prev) =>
          prev.map((m) =>
            m.id === aiMsg.id && m.status === 'streaming'
              ? {
                  ...m,
                  status: 'done',
                  content: m.content + '\n\n_[已中止]_',
                }
              : m
          )
        )
      } else {
        updateMessages((prev) =>
          prev.map((m) =>
            m.id === aiMsg.id
              ? {
                  ...m,
                  status: 'error',
                  content: m.content || `[请求失败] ${err.message || err}`,
                }
              : m
          )
        )
      }
    } finally {
      setStreaming(false)
      abortControllerRef.current = null
      // 刷新文件列表：智能体可能通过工具生成了输出文件（如 expand_risk_detail 的展开表）
      loadUploadedFiles()
    }
    // 注意：sessionIds 必须在依赖里——点「清空」会生成新 session_id，
    // 缺失该依赖会让 sendText 闭包住旧值，下一句话仍带旧会话 ID 发出，
    // 后端按旧会话加载历史，表现为"清空了聊天框但记忆还在"。
  }, [selectedAgentId, streaming, agentList, updateMessages, uploadedFiles, selectedFileIds, ensureReadDocumentEnabled, overridePayload, loadUploadedFiles, sessionIds])

  // ----- 发送消息（输入框入口，读取 inputText）-----
  const sendMessage = useCallback(() => {
    return sendText(inputText.trim())
  }, [inputText, sendText])

  // ----- 回答 clarify 澄清选项：标记已选，并以选项文本作为用户消息发送下一轮 -----
  const answerClarify = useCallback(
    (msgId, clarifyIndex, choice) => {
      if (!selectedAgentId || streaming || !choice) return
      // 标记该澄清项已回答（卡片转为已选态，防止重复点击）
      updateMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msgId) return m
          const clarifies = [...(m.clarifies || [])]
          if (clarifies[clarifyIndex]) {
            clarifies[clarifyIndex] = { ...clarifies[clarifyIndex], answered: choice }
          }
          return { ...m, clarifies }
        })
      )
      // 选项文本即用户回答，进入下一轮对话
      sendText(choice)
    },
    [selectedAgentId, streaming, updateMessages, sendText]
  )

  // ----- 重新生成指定 AI 消息（支持任意位置，不再限制为最后一条）-----
  // 流程：定位 AI 消息 → 找其前一条用户消息 → 删除用户消息及之后所有消息 → 重发用户文本
  const regenerateFromMsg = useCallback(
    (msgId) => {
      if (!selectedAgentId || streaming) return
      const msgs = histories[selectedAgentId] || []
      const aiIdx = msgs.findIndex((m) => m.id === msgId && m.role === 'assistant')
      if (aiIdx < 0) return
      // 找前面的用户消息
      let userIdx = -1
      for (let i = aiIdx - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          userIdx = i
          break
        }
      }
      if (userIdx < 0) return
      const userText = msgs[userIdx].content
      // 去掉文件注入的包裹文本（如果原消息含 [用户上传了以下文件...] 前缀，还原为原始用户输入）
      // 匹配 [用户上传了以下文件...]\n\n<用户原始文本> 的格式
      const fileWrapMatch = userText.match(
        /^\[用户上传了以下文件[^\]]*\]\s*\n\n([\s\S]*)$/
      )
      const pureText = fileWrapMatch ? fileWrapMatch[1] : userText
      // 删除用户消息及之后所有消息（含目标 AI 消息）
      updateMessages((prev) => prev.slice(0, userIdx))
      // 直接调用 sendText，避免依赖 inputText state 时序
      sendText(pureText)
    },
    [selectedAgentId, streaming, histories, updateMessages, sendText]
  )

  // ----- 删除单条消息 -----
  const deleteMessage = useCallback(
    (msgId) => {
      updateMessages((prev) => prev.filter((m) => m.id !== msgId))
    },
    [updateMessages]
  )

  // ----- 编辑用户消息并重发 -----
  // 流程：找到该用户消息 → 删除该消息及之后所有消息 → 用新文本重新发送
  // 用于用户消息的"编辑重发"功能（对标 new-api Playground）
  const handleEditResend = useCallback(
    (msgId, newText) => {
      if (!selectedAgentId || streaming) return
      const msgs = histories[selectedAgentId] || []
      const userIdx = msgs.findIndex((m) => m.id === msgId && m.role === 'user')
      if (userIdx < 0) return
      // 删除该用户消息及之后所有消息
      updateMessages((prev) => prev.slice(0, userIdx))
      // 直接用新文本发送（不依赖 inputText state）
      sendText(newText)
    },
    [selectedAgentId, streaming, histories, updateMessages, sendText]
  )

  // ----- 切换 delegate 分组展开 -----
  const toggleDelegateGroup = useCallback(
    (msgId, subagentId) => {
      updateMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                delegateGroups: (m.delegateGroups || []).map((g) =>
                  g.subagent_id === subagentId
                    ? { ...g, expanded: !g.expanded }
                    : g
                ),
              }
            : m
        )
      )
    },
    [updateMessages]
  )

  // ----- 过滤后的智能体列表 -----
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agentList
    const q = searchQuery.toLowerCase()
    return agentList.filter(
      (a) =>
        (a.name || '').toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q)
    )
  }, [agentList, searchQuery])

  // ----- 分组 -----
  const pinnedAgents = filteredAgents
    .filter((a) => pinnedIds.includes(String(a.id)))
    .map((a) => ({ ...a, _pinned: true }))
  // 各智能体最近一次对话时间（优先用内存中的历史，未加载的从 localStorage 读取）
  const lastActiveMap = useMemo(() => {
    const map = {}
    for (const a of agentList) {
      const key = String(a.id)
      const inMem = histories[key]
      const msgs = Array.isArray(inMem) ? inMem : loadHistory(key)
      const last = msgs[msgs.length - 1]
      map[key] = last?.timestamp
        ? new Date(last.timestamp).getTime()
        : (last?.id ? parseInt(String(last.id).split('-')[0]) || 0 : 0)
    }
    return map
  }, [agentList, histories])
  // 全部智能体：按最近对话时间倒序（最新对话的智能体放最上面，无对话的保持原顺序）
  const otherAgents = filteredAgents
    .filter((a) => !pinnedIds.includes(String(a.id)))
    .slice()
    .sort((a, b) => (lastActiveMap[String(b.id)] || 0) - (lastActiveMap[String(a.id)] || 0))

  const selectedAgent = agentList.find(
    (a) => String(a.id) === String(selectedAgentId)
  )

  // ----- 页面卸载时中止流式 -----
  useEffect(() => {
    return () => abortStream()
  }, [abortStream])

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ===== 左侧边栏 ===== */}
      <ChatSidebar
        width={SIDEBAR_WIDTH}
        minWidth={SIDEBAR_MIN}
        agents={agentList}
        filteredAgents={filteredAgents}
        pinnedAgents={pinnedAgents}
        otherAgents={otherAgents}
        selectedAgentId={selectedAgentId}
        searchQuery={searchQuery}
        loading={loadingAgents}
        onSelect={selectAgent}
        onSearch={setSearchQuery}
        onTogglePin={togglePin}
        onNewConversation={newConversation}
      />

      {/* ===== 右侧主区域 ===== */}
      <ChatMain
        agent={selectedAgent}
        messages={currentMessages}
        streaming={streaming}
        inputText={inputText}
        onInputChange={setInputText}
        onSend={sendMessage}
        onStop={abortStream}
        onRegenerate={regenerateFromMsg}
        onDeleteMessage={deleteMessage}
        onEditResend={handleEditResend}
        onToggleDelegate={toggleDelegateGroup}
        onAnswerClarify={answerClarify}
        uploadedFiles={uploadedFiles}
        selectedFileIds={selectedFileIds}
        uploading={uploading}
        onFileUpload={handleFileUpload}
        onFileDelete={handleDeleteFile}
        onFileDownload={handleDownloadFile}
        onToggleFile={toggleFileSelect}
        overrides={currentOverride}
        updateOverrides={updateOverrides}
        llmConfigs={llmConfigs}
        onClear={newConversation}
      />
    </div>
  )
}

// ============================================================================
// 左侧边栏：智能体导航区
// ============================================================================
function ChatSidebar({
  width,
  minWidth,
  agents,
  filteredAgents,
  pinnedAgents,
  otherAgents,
  selectedAgentId,
  searchQuery,
  loading,
  onSelect,
  onSearch,
  onTogglePin,
  onNewConversation,
}) {
  return (
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width: `${width}px`, minWidth: `${minWidth}px` }}
    >
      {/* 顶部功能区 */}
      <div className="shrink-0 p-3">
        <button
          type="button"
          onClick={onNewConversation}
          className="mb-2 w-full inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/40 hover:bg-accent"
        >
          <Sparkles className="h-4 w-4" />
          新建会话
        </button>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索智能体…"
          className="w-full rounded-md border border-transparent bg-muted px-3 py-1.5 text-xs text-foreground outline-none transition placeholder:text-muted-foreground hover:border-border focus:border-primary/40 focus:bg-card focus:ring-1 focus:ring-primary/25"
        />
      </div>

      {/* 智能体列表区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* 加载态：骨架流光模拟智能体条目高度 */}
        {loading && (
          <div className="flex flex-col gap-2 px-1 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        )}

        {/* 空态：统一 EmptyState 风格（图标 + 标题 + 引导文案） */}
        {!loading && filteredAgents.length === 0 && (
          <EmptyState
            title={searchQuery ? '未找到匹配的智能体' : '暂无已发布的智能体'}
            description={searchQuery ? '尝试更换关键词搜索' : '请先在智能体工作室创建并发布'}
            className="py-8"
          />
        )}

        {/* 已置顶分组 */}
        {pinnedAgents.length > 0 && (
          <AgentGroup
            title="已置顶"
            agents={pinnedAgents}
            selectedAgentId={selectedAgentId}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            defaultExpanded
          />
        )}

        {/* 全部智能体分组：按最近对话时间排序，最新对话的智能体在最上面 */}
        {otherAgents.length > 0 && (
          <AgentGroup
            title="全部智能体"
            agents={otherAgents}
            selectedAgentId={selectedAgentId}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            defaultExpanded
          />
        )}
      </div>

      {/* 底部入口 */}
      <div className="shrink-0 border-t border-border p-2">
        <a
          href="/studio"
          className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
        >
          <Settings className="h-4 w-4" />
          <span>管理智能体</span>
        </a>
      </div>
    </aside>
  )
}

// 可折叠的智能体分组
function AgentGroup({
  title,
  agents,
  selectedAgentId,
  onSelect,
  onTogglePin,
  defaultExpanded = true,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-muted-foreground"
      >
        <span className="text-[9px]">{expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
        <span>{title}</span>
        <span className="ml-auto whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {agents.length}
        </span>
      </button>
      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {agents.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              selected={String(agent.id) === String(selectedAgentId)}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// 单个智能体条目（仅头像 + 名称，不展示描述）
function AgentItem({ agent, selected, onSelect, onTogglePin }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const name = agent.name || `智能体 ${agent.id}`
  const avatar = agent.avatar
  const isPinned = agent._pinned

  return (
    <div
      className={`group relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors ${
        selected
          ? 'nav-indicator bg-primary/10 font-medium text-primary ring-1 ring-primary/25'
          : 'text-foreground hover:bg-muted'
      }`}
      onClick={() => onSelect(agent.id)}
    >
      {/* 头像：选中态加主色描边，与激活底色呼应 */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-sm transition ${
          selected ? 'ring-1 ring-primary/25' : ''
        }`}
      >
        {avatar ? (
          <img src={avatar} alt={name} className="h-full w-full object-cover" />
        ) : (
          <span className={`font-semibold transition-colors ${selected ? 'text-primary' : 'text-muted-foreground'}`}>
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      {/* 名称 */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>{name}</div>
      </div>
      {/* 右键菜单触发 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((o) => !o)
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
        title="更多操作"
      >
        ⋯
      </button>
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
            }}
          />
          <div className="absolute right-2 top-8 z-50 w-28 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(agent.id)
                setMenuOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted"
            >
              {isPinned ? <Pin className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
              <span>{isPinned ? '取消置顶' : '置顶'}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================================
// 右侧主区域：对话功能区
// ============================================================================
function ChatMain({
  agent,
  messages,
  streaming,
  inputText,
  onInputChange,
  onSend,
  onStop,
  onRegenerate,
  onDeleteMessage,
  onEditResend,
  onToggleDelegate,
  onAnswerClarify,
  uploadedFiles,
  selectedFileIds,
  uploading,
  onFileUpload,
  onFileDelete,
  onFileDownload,
  onToggleFile,
  overrides,
  updateOverrides,
  llmConfigs,
  onClear,
}) {
  const messagesEndRef = useRef(null)
  const scrollContainerRef = useRef(null)
  // 首次进入 / 切换会话 / 历史加载完成时用瞬时滚动（直接定位到最新消息），
  // 新消息到达用平滑滚动。解决"从其他页面进入对话停在顶部要手动下拉"的问题。
  const instantScrollRef = useRef(true)
  const prevAgentIdRef = useRef(agent?.id)
  const prevMsgLenRef = useRef(0)
  // 记录"用户是否在底部附近"——用户上滑阅读历史时,新消息到达不强制拉回,
  // 仅在用户已在底部附近时自动跟随。底部阈值 80px,容许小波动不算"离开底部"。
  const isNearBottomRef = useRef(true)
  // System Prompt 编辑器显隐（本地状态，切换智能体时重置为 false）
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  // 空态（无消息）：输入卡片垂直居中展示；提早日计算供下方 effect 依赖
  const showWelcome = messages.length === 0

  const scrollToBottom = useCallback((instant = false) => {
    const container = scrollContainerRef.current
    if (!container) return
    // 直接操作滚动容器（比 scrollIntoView 更可靠，不依赖末尾元素渲染状态）
    container.scrollTo({
      top: container.scrollHeight,
      behavior: instant ? 'auto' : 'smooth',
    })
  }, [])

  // 监听滚动位置:更新 isNearBottomRef
  // 阈值 80px:用户在底部附近视为"跟随中",新消息自动滚;
  // 用户主动上滑超过 80px 视为"阅读历史",不强制打断
  // 依赖 showWelcome:空态与非空态切换时滚动容器重新挂载,需重新绑定监听
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const handler = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      const distanceToBottom = scrollHeight - scrollTop - clientHeight
      isNearBottomRef.current = distanceToBottom <= 80
    }
    container.addEventListener('scroll', handler, { passive: true })
    return () => container.removeEventListener('scroll', handler)
  }, [showWelcome])

  // 切换智能体时：标记瞬时滚动并主动触发（切换会话时 messages 引用可能不变，
  // 单靠 messages useEffect 不会触发，必须在此主动滚一次）
  // 同时收起 System Prompt 编辑器（避免上一位智能体的编辑器残留显示）
  useEffect(() => {
    if (agent?.id !== prevAgentIdRef.current) {
      prevAgentIdRef.current = agent?.id
      instantScrollRef.current = true
      isNearBottomRef.current = true  // 切换会话重置为跟随态
      setShowSystemPrompt(false)     // 收起 System Prompt 编辑器
      // 双 rAF 确保新会话消息渲染完成后再瞬时定位
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom(true)))
    }
  }, [agent?.id, scrollToBottom])

  // 组件挂载时：标记需要瞬时滚动
  // 解决"从其他页面切回对话页"场景：ChatPage 重新挂载时 histories 为空，
  // 历史消息异步从 localStorage 加载，messages 从 [] 变为非空时需要强制滚动到底部
  useEffect(() => {
    instantScrollRef.current = true
  }, [])

  // messages 变化时滚动到底部
  useEffect(() => {
    const curLen = messages.length
    const prevLen = prevMsgLenRef.current
    // 历史"空→非空"（首次加载历史 / 进入对话页历史加载完成）也视为瞬时滚动场景，
    // 避免首次进入时 messages 先为 [] 把 instantScrollRef 提前耗尽，历史加载完只能平滑滚动
    const loadedFromEmpty = prevLen === 0 && curLen > 0
    // 新消息到达(条数增加):用户发了新消息或助手开始回复,强制跟随
    const newMessageArrived = curLen > prevLen
    prevMsgLenRef.current = curLen

    // 强制滚动的场景:瞬时标记 / 首次加载 / 新消息到达(用户主动发消息应立即跟随)
    const forceScroll = instantScrollRef.current || loadedFromEmpty || newMessageArrived
    if (forceScroll) {
      // 瞬时定位：用双 rAF 等 DOM 完全渲染完成（含 markdown/代码高亮）后再滚动
      // 单 rAF 不足以等完大量历史消息的渲染，scrollHeight 可能还是旧值导致定位不准
      // 再加 120ms 兜底：markdown 代码高亮/图片加载可能比双 rAF 更晚完成
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scrollToBottom(true)
          // 兜底：部分场景（如代码高亮异步渲染）双 rAF 后高度仍变化，再滚一次确保到位
          setTimeout(() => scrollToBottom(true), 120)
          instantScrollRef.current = false
        })
      )
    } else if (isNearBottomRef.current) {
      // 流式 token 更新(条数不变,仅内容增长):仅在用户已在底部附近时跟随
      // 用瞬时滚动避免平滑滚动被 60ms 的频繁 token 打断导致卡顿
      requestAnimationFrame(() => scrollToBottom(true))
    }
    // 用户不在底部附近且无新消息:不打断阅读,不滚动
  }, [messages, scrollToBottom])

  // 没有选中智能体：EmptyState 风格空态 + 科技网格背景装饰（仅样式）
  if (!agent) {
    return (
      <div className="flex min-w-[400px] flex-1 items-center justify-center bg-card bg-tech-grid">
        <EmptyState
          icon={MessageSquare}
          title="请选择一个智能体"
          description="从左侧选择智能体开始对话"
        />
      </div>
    )
  }

  const name = agent.name || `智能体 ${agent.id}`
  const suggestedQuestions = agent.suggested_questions || []

  // 输入卡片（空态与非空态共用同一组件与交互，仅展示位置不同）：
  // 卡片底部右侧集成模型选择下拉（自 ChatToolbar 迁入，数据流不变）
  const inputEl = (
    <ChatInput
      value={inputText}
      onChange={onInputChange}
      onSend={onSend}
      onStop={onStop}
      streaming={streaming}
      agentName={name}
      uploadedFiles={uploadedFiles}
      selectedFileIds={selectedFileIds}
      uploading={uploading}
      onFileUpload={onFileUpload}
      onFileDelete={onFileDelete}
      onFileDownload={onFileDownload}
      onToggleFile={onToggleFile}
      modelValue={overrides?.model_config_id ?? null}
      onModelChange={(id) =>
        updateOverrides((prev) => ({ ...prev, model_config_id: id }))
      }
      llmConfigs={llmConfigs}
      agentDefaultModelId={agent.model_config_id ?? null}
    />
  )

  return (
    <div className="flex min-w-[400px] flex-1 flex-col bg-card">
      {/* 顶部工具栏：智能体信息 + 参数 + System Prompt + 清空 */}
      <ChatToolbar
        agent={agent}
        streaming={streaming}
        overrides={overrides}
        updateOverrides={updateOverrides}
        llmConfigs={llmConfigs}
        onClear={onClear}
        onToggleSystemPrompt={() => setShowSystemPrompt((v) => !v)}
        showSystemPrompt={showSystemPrompt}
      />

      {/* System Prompt 折叠编辑区（仅展开时显示） */}
      {(showSystemPrompt || (overrides?.system_prompt && overrides.system_prompt.trim())) && (
        <SystemPromptEditor
          value={overrides?.system_prompt || ''}
          onChange={(text) =>
            updateOverrides((prev) => ({ ...prev, system_prompt: text }))
          }
          agentDefaultPrompt={agent.system_prompt || ''}
        />
      )}

      {showWelcome ? (
        // 空态：品牌标题 + 垂直居中的输入卡片 + 快捷操作 chips（仅样式）
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto bg-tech-grid px-6 py-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-2xl ring-1 ring-primary/25">
              {agent.avatar ? (
                <img src={agent.avatar} alt={name} className="h-full w-full rounded-2xl object-cover" />
              ) : (
                <span className="font-bold text-foreground">
                  {name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <h2 className="text-gradient-primary mb-2 text-[22px] font-bold tracking-tight">{name}</h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              {agent.description ||
                `你可以向我提问相关问题，我会结合工具与上下文为你解答。`}
            </p>
          </div>
          <div className="w-full max-w-3xl">{inputEl}</div>
          {suggestedQuestions.length > 0 && (
            <div className="mt-4 flex max-w-3xl flex-wrap justify-center gap-2">
              {suggestedQuestions.slice(0, 6).map((q, i) => (
                <span
                  key={i}
                  className="cursor-default truncate rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
                  title={q}
                >
                  {q}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 对话内容区（限宽居中，与输入卡片同宽） */}
          <div
            ref={scrollContainerRef}
            className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  onRegenerate={onRegenerate}
                  onDelete={() => onDeleteMessage(msg.id)}
                  onEdit={(newText) => onEditResend(msg.id, newText)}
                  onToggleDelegate={(sid) => onToggleDelegate(msg.id, sid)}
                  onAnswerClarify={(clarifyIndex, choice) =>
                    onAnswerClarify(msg.id, clarifyIndex, choice)
                  }
                  isLast={msg.id === messages[messages.length - 1]?.id}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* 底部输入区 */}
          {inputEl}
        </>
      )}
    </div>
  )
}

// ============================================================================
// 消息气泡
// ============================================================================
function MessageBubble({ msg, onRegenerate, onDelete, onEdit, onToggleDelegate, onAnswerClarify, isLast }) {
  const isUser = msg.role === 'user'
  const [copied, setCopied] = useState(false)
  const [processOpen, setProcessOpen] = useState(false)
  // 用户消息编辑态
  const [editing, setEditing] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content || '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className={`group flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {/* 消息体（用户消息：右侧主色浅底气泡；AI 消息：左侧卡片式气泡，层次分明） */}
      <div
        className={`flex min-w-0 flex-col ${
          isUser ? 'max-w-[78%] items-end' : 'w-full items-start'
        }`}
      >
          {/* 气泡（用户消息编辑态时切换为 MessageEditor） */}
          {isUser && editing ? (
            <MessageEditor
              value={(() => {
                // 还原原始用户输入（去掉文件注入的前缀包裹）
                const m = (msg.content || '').match(
                  /^\[用户上传了以下文件[^\]]*\]\s*\n\n([\s\S]*)$/
                )
                return m ? m[1] : msg.content || ''
              })()}
              onSave={(newText) => {
                setEditing(false)
                onEdit?.(newText)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div
              className={`rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                isUser
                  ? 'border border-primary/15 bg-primary/10 text-foreground'
                  : msg.status === 'error'
                  ? 'border border-destructive/40 bg-destructive/10 text-destructive'
                  : 'w-full border border-border bg-card text-foreground'
              }`}
            >
              {/* 流式光标 */}
              {msg.status === 'streaming' && !msg.content ? (
                <span className="inline-flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60" />
                </span>
              ) : (
                <div className="break-words">
                  {isUser ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : msg.status === 'streaming' ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    <MarkdownRenderer content={msg.content} />
                  )}
                  {msg.status === 'streaming' && (
                    <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-primary align-middle" />
                  )}
                </div>
              )}
            </div>
          )}

          {/* 澄清选项卡片（clarify 提问：点击选项即作为用户回答发送下一轮） */}
          {!isUser && msg.clarifies && msg.clarifies.length > 0 && (
            <div className="mt-1.5 flex w-full flex-col gap-1.5">
              {msg.clarifies.map((c, i) => (
                <ClarifyCard
                  key={i}
                  clarify={c}
                  disabled={msg.status === 'streaming'}
                  onPick={(choice) => onAnswerClarify?.(i, choice)}
                />
              ))}
            </div>
          )}

          {/* 生成的文件（AI 消息，点击下载） */}
          {!isUser && msg.files && msg.files.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {msg.files.map((f) => (
                <button
                  key={f.file_id}
                  type="button"
                  onClick={async () => {
                    try {
                      await agentFilesApi.download(f.file_id, f.file_name)
                    } catch (err) {
                      toast.error(`下载失败：${err.message || err}`)
                    }
                  }}
                  className="flex w-fit max-w-full items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground transition hover:border-primary/40 hover:bg-accent"
                  title={`下载 ${f.file_name}`}
                >
                  <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{f.file_name}</span>
                  {f.rows != null && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{f.rows} 行</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* 思考过程折叠区（仅 AI 消息有 thinking 时显示）——左侧主色竖线 + 缩进，
              与正文/执行过程形成视觉分区 */}
          {!isUser && msg.thinking && (
            <div className="mt-1.5 w-full border-l-2 border-primary/30 pl-3">
              <ThinkingPanel thinking={msg.thinking} streaming={msg.status === 'streaming'} />
            </div>
          )}

          {/* 执行过程面板（工具链路 + 引擎状态日志合并为紧凑面板：默认折叠、
              折叠头横向展示步骤 chips 与状态圆点，展开显示每步详情，仅 AI 消息） */}
          {!isUser &&
            ((msg.toolCalls && msg.toolCalls.length > 0) ||
              (msg.statusMsgs && msg.statusMsgs.length > 0)) && (
              <div className="mt-2 w-full">
                {/* 折叠头：标题 + 横向步骤 chips */}
                <button
                  type="button"
                  onClick={() => setProcessOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:bg-muted"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${processOpen ? 'rotate-90' : ''}`}
                  />
                  <ScrollText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-[11px] text-muted-foreground">执行过程</span>
                  <span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                    ({(msg.toolCalls?.length || 0) + (msg.statusMsgs?.length || 0)})
                  </span>
                  {/* 横向步骤 chips：状态圆点（运行中/成功/失败）+ 工具名 */}
                  <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                    {(msg.toolCalls || []).map((tc, i) => (
                      <span
                        key={tc.call_id || `${tc.name}-${i}`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title={tc.name}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            tc.status === 'running'
                              ? 'dot-pulse bg-primary'
                              : tc.message &&
                                (tc.message.includes('错误') || tc.message.includes('error'))
                              ? 'bg-destructive'
                              : 'bg-success'
                          }`}
                        />
                        <span className="max-w-[10rem] truncate font-mono">{tc.name}</span>
                      </span>
                    ))}
                  </span>
                </button>
                {/* 展开内容：工具时间线（含每步「详情」）+ 状态/日志（圆角浅灰底） */}
                {processOpen && (
                  <div className="mt-1 rounded-lg bg-muted p-2.5">
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <ToolTimeline toolCalls={msg.toolCalls} embedded />
                    )}
                    {msg.statusMsgs && msg.statusMsgs.length > 0 && (
                      <div
                        className={`max-h-40 overflow-y-auto text-[12px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words ${
                          msg.toolCalls && msg.toolCalls.length > 0
                            ? 'mt-1.5 border-t border-border pt-1.5'
                            : ''
                        }`}
                      >
                        {msg.statusMsgs.map((s, i) => (
                          <div key={i} className="py-0.5">{s}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

          {/* 子代理委派事件折叠区 */}
          {!isUser && msg.delegateGroups && msg.delegateGroups.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {msg.delegateGroups.map((g) => (
                <DelegateGroupMini
                  key={g.subagent_id}
                  group={g}
                  onToggle={() => onToggleDelegate(g.subagent_id)}
                />
              ))}
            </div>
          )}

          {/* 操作按钮（用户消息：复制/编辑/删除；AI 消息：复制/重新生成/删除） */}
          {msg.status !== 'streaming' && !editing && (
            <div
              className={`mt-1 flex items-center gap-2 opacity-0 transition group-hover:opacity-100 ${
                isUser ? 'justify-end' : 'justify-start'
              }`}
            >
              <button
                type="button"
                onClick={handleCopy}
                className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-muted-foreground"
                title="复制"
              >
                {copied ? <span className="inline-flex items-center gap-1 whitespace-nowrap"><Check className="h-3 w-3" /> 已复制</span> : '复制'}
              </button>
              {isUser && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-muted-foreground"
                  title="编辑并重发（删除此消息及之后所有消息，用新文本重新发送）"
                >
                  编辑
                </button>
              )}
              {!isUser && msg.status === 'done' && (
                <button
                  type="button"
                  onClick={() => onRegenerate(msg.id)}
                  className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted hover:text-muted-foreground"
                  title="重新生成（删除此消息及之后所有消息，从对应用户消息重发）"
                >
                  重新生成
                </button>
              )}
              <button
                type="button"
                onClick={onDelete}
                className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                title="删除"
              >
                删除
              </button>
            </div>
          )}

          {/* 时间戳 + Token 用量 */}
          <div className={`mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground ${isUser ? 'justify-end' : 'justify-start'}`}>
            <span className="whitespace-nowrap tabular-nums">{new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}</span>
            {/* Token 用量（仅 AI 消息且 done 状态有 usage 时显示）——badge 徽章 + 等宽数字 */}
            {!isUser && msg.status === 'done' && msg.usage && (
              <span className="badge whitespace-nowrap bg-primary/10 tabular-nums text-primary" title="Token 用量">
                <span title="输入 Token">入 {msg.usage.input_tokens ?? 0}</span>
                <span title="输出 Token">出 {msg.usage.output_tokens ?? 0}</span>
                <span title="总 Token">共 {msg.usage.total_tokens ?? 0}</span>
              </span>
            )}
          </div>
        </div>
    </div>
  )
}


// ============================================================================
// clarify 澄清选项卡片：智能体向用户提问（如"要查询哪台设备的主机信息？"），
// 点击选项即以该选项文本作为用户回答发送进入下一轮；已回答后转为已选态
// ============================================================================
function ClarifyCard({ clarify, disabled, onPick }) {
  if (!clarify || (!clarify.choices || clarify.choices.length === 0)) {
    // 无选项的开放性提问：仅展示问题（用户在输入框回答）
    if (!clarify || !clarify.question) return null
    return (
      <div className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground">
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={clarify.question}>{clarify.question}</span>
      </div>
    )
  }
  return (
    <div className="mt-1.5 w-full rounded-lg border border-border bg-muted px-3 py-2.5">
      {/* 问题 */}
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={clarify.question}>{clarify.question}</span>
      </div>
      {clarify.answered ? (
        // 已回答：展示所选项
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground">
          <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="truncate" title={clarify.answered}>{clarify.answered}</span>
        </div>
      ) : (
        // 选项列表：点击即作为用户回答发送
        <div className="flex flex-col gap-1.5">
          {clarify.choices.map((choice, i) => (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onPick?.(choice)}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs text-foreground transition hover:border-primary/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-card"
              title={choice}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[9px] font-semibold text-muted-foreground">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="truncate">{choice}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 子代理委派事件迷你卡片（简化版）
function DelegateGroupMini({ group, onToggle }) {
  const statusIcon = {
    running: <Loader2 className="h-3 w-3 animate-spin" />,
    completed: <Check className="h-3 w-3" />,
    failed: <X className="h-3 w-3" />,
  }
  const statusColor = {
    running: 'text-primary',
    completed: 'text-emerald-500',
    failed: 'text-destructive',
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[10px] transition hover:bg-muted"
    >
      <span className="text-[8px] text-muted-foreground">{group.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
      <span className={statusColor[group.status] || 'text-muted-foreground'}>
        {statusIcon[group.status] || '•'}
      </span>
      <span className="font-mono text-foreground">{group.subagent_id}</span>
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
        ({group.events.length} 事件)
      </span>
      {group.expanded && (
        <span className="ml-1 flex max-w-md flex-col gap-0.5 text-left text-[10px] text-muted-foreground">
          {group.events
            .filter((e) => e.type !== 'token')
            .slice(-5)
            .map((e, i) => (
              <span key={i}>
                <span className="text-muted-foreground">
                  {e.type === 'tool_start' ? <Wrench className="inline h-3 w-3" /> : e.type === 'tool_end' ? <Check className="inline h-3 w-3 text-success" /> : e.type === 'done' ? <Flag className="inline h-3 w-3 text-primary" /> : '•'}
                </span>{' '}
                {e.tool_name || e.message || e.content || e.type}
              </span>
            ))}
        </span>
      )}
    </button>
  )
}

// ============================================================================
// 底部输入区
// ============================================================================
function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  agentName,
  uploadedFiles = [],
  selectedFileIds = new Set(),
  uploading = false,
  onFileUpload,
  onFileDelete,
  onFileDownload,
  onToggleFile,
  modelValue = null,
  onModelChange,
  llmConfigs = [],
  agentDefaultModelId = null,
}) {
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const [showFileList, setShowFileList] = useState(false)

  // 自适应高度
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, INPUT_MAX_HEIGHT)}px`
  }, [value])

  // 文件选择：实际上传到服务器
  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || [])
    files.forEach((f) => onFileUpload?.(f))
    e.target.value = ''
  }

  // 键盘事件：Enter 发送，Shift+Enter 换行
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // 文本为空但勾选了文件时同样允许发送（仅发附件）
      if (!streaming && (value.trim() || selectedFileIds.size > 0)) {
        onSend()
      }
    }
  }

  const handleSendClick = () => {
    onSend()
  }

  // 文件类型图标
  const fileIcon = (type) => {
    const icons = {
      xlsx: <Sheet className="h-3.5 w-3.5" />, xls: <Sheet className="h-3.5 w-3.5" />, csv: <Sheet className="h-3.5 w-3.5" />,
      docx: <FileText className="h-3.5 w-3.5" />, pdf: <FileText className="h-3.5 w-3.5" />,
      txt: <File className="h-3.5 w-3.5" />, md: <File className="h-3.5 w-3.5" />, json: <File className="h-3.5 w-3.5" />,
    }
    return icons[type] || <Paperclip className="h-3.5 w-3.5" />
  }

  // 文件大小格式化
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const selectedCount = selectedFileIds.size

  return (
    <div className="shrink-0 px-6 pb-3 pt-1">
      {/* 与消息区同宽居中（max-w-3xl） */}
      <div className="mx-auto w-full max-w-3xl">
        {/* 文件列表区（可折叠） */}
        {uploadedFiles.length > 0 && (
          <div className="mb-2 rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => setShowFileList((s) => !s)}
              className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[11px] text-muted-foreground transition hover:text-foreground"
            >
              <span className="text-[9px]">{showFileList ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
              <Paperclip className="h-4 w-4" />
              <span className="tabular-nums">已上传文件 ({uploadedFiles.length})</span>
              {selectedCount > 0 && (
                <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  已选 {selectedCount} 个
                </span>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                勾选后发送，智能体将自主读取
              </span>
            </button>
            {showFileList && (
              <div className="max-h-40 overflow-y-auto border-t border-border p-1.5">
                {uploadedFiles.map((f) => {
                  const checked = selectedFileIds.has(f.id)
                  return (
                    <div
                      key={f.id}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition ${
                        checked ? 'bg-muted' : 'hover:bg-muted'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleFile?.(f.id)}
                        className="h-3.5 w-3.5 rounded border-border bg-secondary text-primary focus:ring-primary"
                      />
                      <span className="shrink-0">{fileIcon(f.file_type)}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={f.original_name}>
                        {f.original_name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(f.file_size)}</span>
                      <button
                        type="button"
                        onClick={() => onFileDownload?.(f)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        title="下载文件"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onFileDelete?.(f.id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                        title="删除文件"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 上传中提示（呼吸点动画） */}
        {uploading && (
          <div className="mb-2 flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
            <span className="dot-pulse h-2 w-2 rounded-full bg-primary" />
            正在上传文件…
          </div>
        )}

        {/* 悬浮输入卡片：上方文本域，底部一行分左右两组
            （左：附件按钮；右：模型选择 + 发送按钮）。
            悬停/聚焦主色边框 + 光环反馈（对齐 .input-base 交互） */}
        <div className="rounded-xl border border-border bg-card p-2.5 shadow-sm transition hover:border-primary/45 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`和 ${agentName || '智能体'} 对话中…`}
            rows={1}
            className="w-full resize-none bg-transparent px-2 pb-2 pt-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            style={{ maxHeight: `${INPUT_MAX_HEIGHT}px`, minHeight: '44px' }}
            disabled={streaming}
          />
          <div className="flex items-center justify-between gap-2">
            {/* 左：附件按钮 + 隐藏的文件选择 input */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming || uploading}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                title="上传文件（Excel/Word/PDF 等，不做 RAG）"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept=".xlsx,.xls,.docx,.pdf,.csv,.txt,.json,.md"
                onChange={handleFileSelect}
              />
            </div>

            {/* 右：模型选择 + 发送/停止按钮 */}
            <div className="flex items-center gap-1.5">
              <ModelSwitcher
                value={modelValue}
                onChange={onModelChange}
                llmConfigs={llmConfigs}
                agentDefaultModelId={agentDefaultModelId}
              />
              {streaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                  title="停止"
                >
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSendClick}
                  // 文本为空但勾选了文件时同样可发送（仅发附件）
                  disabled={!(value.trim() || selectedFileIds.size > 0)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition hover:opacity-90 hover:shadow-[0_0_14px_oklch(var(--primary)/0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40 disabled:hover:shadow-none"
                  title="发送"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 快捷键提示与字数统计（卡片外右下角小字，数字等宽） */}
        <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
          <span className="whitespace-nowrap">Enter 发送 · Shift+Enter 换行</span>
          <span className="whitespace-nowrap tabular-nums">{value.length} 字</span>
        </div>
      </div>
    </div>
  )
}
