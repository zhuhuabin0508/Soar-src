import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Bot,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Eraser,
  Plus,
  Save,
  Settings,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import {
  agentFiles as agentFilesApi,
  agents as agentsApi,
  knowledgeBases as kbApi,
  llmConfigs as llmApi,
  skills as skillsApi,
  tools as toolsApi,
  workflows as workflowsApi,
  isAgentPublished,
} from '../api/client'
import { planAgentFromDescription } from '../constants/agentIntentPlanner'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { toast } from '../store/toastStore'
import { canEditResource } from '../utils/permissions'
import MarkdownRenderer from '../components/MarkdownRenderer'
import {CompactSelect, AutoGrowTextarea } from '../components/ui'

const NAV_ITEMS = [
  { id: 'config', label: '配置', icon: Settings },
  { id: 'access', label: '访问点', icon: Globe },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'monitor', label: '监控', icon: MessageSquare },
]

function emptyForm() {
  return {
    name: '未命名智能体',
    description: '',
    avatar: '',
    greeting: '',
    suggested_questions: [],
    model_config_id: '',
    system_prompt: '',
    temperature: 0.7,
    max_tokens: 2048,
    reasoning_effort: '',
    context_turns: 10,
    enabled_tools: [],
    enabled_kbs: [],
    enabled_asset_types: [],
    enabled_skills: [],
    enabled_workflows: [],
    max_iterations: 8,
    enable_memory: false,
    tone_style: 'professional',
    variables: {},
    tool_configs: {},
    engine: 'hermes',
    output_mode: 'chat',
  }
}

function AddPicker({ title, options, value, onChange, onClose, kind, onCreateSkill }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('library')
  const [skillName, setSkillName] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [saving, setSaving] = useState(false)
  const textFileRef = useRef(null)
  const isSkill = kind === 'skill'
  const selected = new Set(value)
  const filtered = options.filter(
    (o) =>
      !q.trim() ||
      (o.label || '').toLowerCase().includes(q.toLowerCase()) ||
      (o.description || '').toLowerCase().includes(q.toLowerCase())
  )

  const readTextFile = async (file) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['py', 'js', 'ts', 'sh', 'bat', 'ps1', 'zip', 'skill', 'exe'].includes(ext)) {
      toast.warning('脚本和压缩包请到「工具」添加。Skill 只保存说明文字。')
      return
    }
    const text = await file.text()
    if (ext === 'json') {
      try {
        const data = JSON.parse(text)
        const first = Array.isArray(data.skills) ? data.skills[0] : data
        setSkillName((first?.name || file.name.replace(/\.[^.]+$/, '')).trim())
        setSkillContent(String(first?.content || text))
      } catch {
        setSkillContent(text)
        if (!skillName) setSkillName(file.name.replace(/\.[^.]+$/, ''))
      }
    } else {
      if (!skillName) setSkillName(file.name.replace(/\.[^.]+$/, ''))
      setSkillContent(text)
    }
    setTab('text')
  }

  const submitText = async () => {
    if (!skillContent.trim()) {
      toast.warning('请填写技能正文')
      return
    }
    if (!onCreateSkill) return
    setSaving(true)
    try {
      await onCreateSkill({
        name: (skillName || '未命名技能').trim(),
        description: '',
        content: skillContent.trim(),
        enabled: true,
      })
    } catch (err) {
      toast.error(err.message || '新增技能失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>
        {isSkill && (
          <>
            <div className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Skill 只保存说明文字，不会执行脚本。脚本请到工具库添加。
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => { onClose(); navigate('/skills') }}>
                技能库
              </button>
              <span className="mx-1 text-muted-foreground">·</span>
              <button type="button" className="text-primary hover:underline" onClick={() => { onClose(); navigate('/tools') }}>
                前往工具
              </button>
            </div>
            <div className="flex gap-1 border-b border-border px-4 pt-2">
              <button
                type="button"
                onClick={() => setTab('library')}
                className={`border-b-2 px-3 py-1.5 text-xs ${tab === 'library' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
              >
                选用技能
              </button>
              <button
                type="button"
                onClick={() => setTab('text')}
                className={`border-b-2 px-3 py-1.5 text-xs ${tab === 'text' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
              >
                导入文本
              </button>
            </div>
          </>
        )}
        {(!isSkill || tab === 'library') && (
          <>
            <div className="border-b border-border px-4 py-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索"
                className="h-8 w-full rounded-md border border-border bg-secondary px-2 text-xs focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex-1 overflow-auto p-2">
              {filtered.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">没有可选项</p>
              ) : (
                filtered.map((o) => {
                  const on = selected.has(o.value)
                  return (
                    <div
                      key={o.value}
                      className={`mb-1 flex items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-secondary ${
                        on ? 'bg-primary/10' : ''
                      }`}
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={on}
                          onChange={() => {
                            const next = on ? value.filter((v) => v !== o.value) : [...value, o.value]
                            onChange(next)
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{o.label}</span>
                          {o.description ? (
                            <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">{o.description}</span>
                          ) : null}
                        </span>
                      </label>
                      {isSkill ? (
                        <button
                          type="button"
                          className="mt-0.5 shrink-0 text-[11px] text-primary hover:underline"
                          onClick={() => {
                            onClose()
                            navigate(`/skills?edit=${o.value}`)
                          }}
                        >
                          编辑
                        </button>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
        {isSkill && tab === 'text' && (
          <div className="flex flex-1 flex-col gap-2 overflow-auto p-4">
            <input
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              placeholder="技能名称"
              className="h-8 w-full rounded-md border border-border bg-secondary px-2 text-xs focus:border-primary focus:outline-none"
            />
            <AutoGrowTextarea
              value={skillContent}
              onChange={(e) => setSkillContent(e.target.value)}
              placeholder="粘贴说明、SOP、角色设定等纯文本。不会作为脚本执行。"
              className="min-h-[160px] w-full rounded-md border border-border bg-secondary px-2 py-2 text-xs leading-5 focus:border-primary focus:outline-none"
            />
            <input
              ref={textFileRef}
              type="file"
              accept=".md,.txt,.json,.markdown"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) readTextFile(file)
              }}
            />
            <button
              type="button"
              onClick={() => textFileRef.current?.click()}
              className="self-start text-[11px] text-primary hover:underline"
            >
              从 md / txt / json 导入正文
            </button>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {isSkill && tab === 'text' ? (
            <button type="button" disabled={saving} onClick={submitText} className="btn-primary btn-sm">
              {saving ? '创建中…' : '创建并挂到智能体'}
            </button>
          ) : (
            <button type="button" onClick={onClose} className="btn-primary btn-sm">
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ChipList({ items, onRemove }) {
  if (!items.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.value}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px]"
        >
          {it.label}
          <button type="button" onClick={() => onRemove(it.value)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

async function readSse(resp, handlers) {
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
      try {
        const data = JSON.parse(line.slice(6))
        if (data.type === 'token' && data.content) handlers.onToken?.(data.content)
        else if (data.type === 'thinking' && data.content) handlers.onThinking?.(data.content)
        else if (data.type === 'status') handlers.onStatus?.(data)
        else if (data.type === 'log') handlers.onLog?.(data)
        else if (data.type === 'tool_start') handlers.onToolStart?.(data)
        else if (data.type === 'tool_end') handlers.onToolEnd?.(data)
        else if (data.type === 'file') handlers.onFile?.(data)
        else if (data.type === 'delegate') handlers.onDelegate?.(data)
        else if (data.type === 'done') handlers.onDone?.(data)
        else if (data.type === 'error') handlers.onError?.(data.message || '出错')
      } catch {
      }
    }
  }
}

function formatDebugValue(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function DebugTrace({ tools, statuses, logs, files, thinking, live }) {
  const hasTrace = (tools && tools.length) || (statuses && statuses.length) || (logs && logs.length) || (files && files.length) || thinking || live
  if (!hasTrace) return null
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-dashed border-primary/30 bg-primary/5 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-primary/80">调试明细</div>
      {(thinking || live) && (
        <details className="rounded border border-border bg-card">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground">思考过程</summary>
          {live ? (
            <div ref={live.thinkingEl} className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground" />
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">{thinking}</pre>
          )}
        </details>
      )}
      {statuses?.length > 0 && (
        <div className="rounded border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {statuses.map((s, i) => <div key={i}>[状态] {s}</div>)}
        </div>
      )}
      {logs?.length > 0 && (
        <div className="max-h-32 overflow-auto rounded border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {logs.map((s, i) => <div key={i}>{s}</div>)}
        </div>
      )}
      {tools?.map((t, i) => (
        <details key={t.call_id || i} className="rounded border border-border bg-card">
          <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[11px]">
            <Wrench className="h-3 w-3 text-primary" />
            <span className="font-mono text-primary">{t.name}</span>
            <span className={t.status === 'running' ? 'text-warning' : t.error ? 'text-destructive' : 'text-emerald-500'}>
              {t.status === 'running' ? '执行中' : t.error ? '失败' : '完成'}
            </span>
          </summary>
          <div className="space-y-1 border-t border-border px-2 py-1.5">
            {t.message && <div className="text-[11px] text-muted-foreground">{t.message}</div>}
            {t.argsText && (
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">参数</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground">{t.argsText}</pre>
              </div>
            )}
            {t.resultText && (
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">返回</div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground">{t.resultText}</pre>
              </div>
            )}
          </div>
        </details>
      ))}
      {files?.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {files.map((f, i) => <div key={i}>文件 {f.file_name || f.file_id}</div>)}
        </div>
      )}
    </div>
  )
}

function AgentPreviewPane({ agentId, engine, ensureSaved }) {
  const [previewMsgs, setPreviewMsgs] = useState([])
  const [previewInput, setPreviewInput] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const replyRef = useRef('')
  const thinkingRef = useRef('')
  const toolsRef = useRef([])
  const statusesRef = useRef([])
  const logsRef = useRef([])
  const filesRef = useRef([])
  const streamElRef = useRef(null)
  const thinkingElRef = useRef(null)
  const rafRef = useRef(0)
  const sessionRef = useRef('')
  const abortRef = useRef(null)
  const listRef = useRef(null)
  const thinkingNotedRef = useRef(false)

  if (!sessionRef.current) sessionRef.current = `preview-${agentId || 'new'}-${Date.now()}`

  useLayoutEffect(() => {
    if (!previewBusy) return
    if (streamElRef.current) streamElRef.current.textContent = replyRef.current
    if (thinkingElRef.current) thinkingElRef.current.textContent = thinkingRef.current
  }, [previewMsgs, previewBusy])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [previewMsgs, previewBusy])

  const paintStream = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (streamElRef.current) streamElRef.current.textContent = replyRef.current
      if (thinkingElRef.current) thinkingElRef.current.textContent = thinkingRef.current
    })
  }

  const snapshotAssistant = (extra = {}) => ({
    role: 'assistant',
    content: replyRef.current,
    thinking: thinkingRef.current,
    tools: toolsRef.current.map((t) => ({ ...t })),
    statuses: [...statusesRef.current],
    logs: [...logsRef.current],
    files: filesRef.current.map((f) => ({ ...f })),
    ...extra,
  })

  const patchLast = (extra) => {
    setPreviewMsgs((m) => {
      const next = [...m]
      next[next.length - 1] = snapshotAssistant(extra)
      return next
    })
  }

  const resetTurn = () => {
    replyRef.current = ''
    thinkingRef.current = ''
    toolsRef.current = []
    statusesRef.current = []
    logsRef.current = []
    filesRef.current = []
    thinkingNotedRef.current = false
  }

  const clearMemory = () => {
    abortRef.current?.abort()
    abortRef.current = null
    sessionRef.current = `preview-${agentId || 'new'}-${Date.now()}`
    resetTurn()
    setPreviewMsgs([])
    setPreviewBusy(false)
    toast.success('已清空预览记忆，下次发送将作为新会话')
  }

  const stopPreview = () => {
    abortRef.current?.abort()
  }

  const runPreview = async () => {
    const text = previewInput.trim()
    if (!text || previewBusy) return
    const saved = await ensureSaved()
    const id = saved?.id || agentId
    if (!id) return
    resetTurn()
    const controller = new AbortController()
    abortRef.current = controller
    setPreviewBusy(true)
    setPreviewMsgs((m) => [...m, { role: 'user', content: text }, snapshotAssistant()])
    setPreviewInput('')
    try {
      const resp = await agentsApi.chatStream(id, text, controller.signal, sessionRef.current, { channel: 'test' })
      if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`)
      await readSse(resp, {
        onToken: (c) => {
          replyRef.current += c
          paintStream()
        },
        onThinking: (c) => {
          thinkingRef.current += c
          paintStream()
          if (!thinkingNotedRef.current) {
            thinkingNotedRef.current = true
            patchLast()
          }
        },
        onStatus: (d) => {
          if (d.message) {
            statusesRef.current.push(d.message)
            patchLast()
          }
        },
        onLog: (d) => {
          const line = d.log?.message || d.message || formatDebugValue(d.log || d)
          if (line) {
            logsRef.current.push(line)
            patchLast()
          }
        },
        onToolStart: (d) => {
          toolsRef.current.push({
            name: d.tool_name || 'tool',
            call_id: d.tool_call_id || '',
            status: 'running',
            message: d.message || '',
            argsText: formatDebugValue(d.args),
            resultText: '',
            error: false,
          })
          patchLast()
        },
        onToolEnd: (d) => {
          let hit = toolsRef.current.findIndex((t) => t.call_id && t.call_id === d.tool_call_id && t.status === 'running')
          if (hit < 0) {
            for (let i = toolsRef.current.length - 1; i >= 0; i--) {
              const t = toolsRef.current[i]
              if (t.status === 'running' && t.name === (d.tool_name || t.name)) {
                hit = i
                break
              }
            }
          }
          const resultText = formatDebugValue(d.result)
          const error = /错误|失败/.test(d.message || '')
          if (hit >= 0) {
            toolsRef.current[hit] = {
              ...toolsRef.current[hit],
              status: 'done',
              message: d.message || toolsRef.current[hit].message,
              resultText,
              error,
            }
          } else {
            toolsRef.current.push({
              name: d.tool_name || 'tool',
              call_id: d.tool_call_id || '',
              status: 'done',
              message: d.message || '',
              argsText: '',
              resultText,
              error,
            })
          }
          patchLast()
        },
        onFile: (d) => {
          filesRef.current.push({ file_id: d.file_id, file_name: d.file_name })
          patchLast()
        },
        onDelegate: (d) => {
          const info = d.result || {}
          const evt = info.event || {}
          logsRef.current.push(`委派 ${info.subagent_id || ''} ${evt.type || ''} ${evt.tool_name || evt.message || ''}`.trim())
          patchLast()
        },
        onDone: (d) => {
          if (!replyRef.current && (d.reply || d.content)) replyRef.current = d.reply || d.content
          patchLast({ usage: d.usage || null })
        },
        onError: (msg) => toast.error(msg),
      })
    } catch (err) {
      if (err.name !== 'AbortError') toast.error(err.message || '预览失败')
      else patchLast()
    } finally {
      abortRef.current = null
      setPreviewBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <span className="text-xs font-medium text-foreground">调试预览</span>
        <button
          type="button"
          onClick={clearMemory}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Eraser className="h-3 w-3" />
          清空记忆
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {previewMsgs.length === 0 ? (
          <p className="pt-16 text-center text-xs text-muted-foreground">发送一条消息开始调试。工具参数、返回、思考和状态会显示在回复上方。</p>
        ) : (
          <div className="flex flex-col gap-3">
            {previewMsgs.map((m, i) => {
              const live = previewBusy && i === previewMsgs.length - 1 && m.role === 'assistant'
              if (m.role === 'user') {
                return (
                  <div key={i} className="ml-10 rounded-lg bg-secondary px-3 py-2 text-sm">{m.content}</div>
                )
              }
              const statuses = m.statuses || []
              return (
                <div key={i} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <DebugTrace
                    tools={m.tools}
                    statuses={statuses}
                    logs={m.logs}
                    files={m.files}
                    thinking={live ? '' : m.thinking}
                    live={live && (thinkingNotedRef.current || m.thinking) ? { thinkingEl: thinkingElRef } : null}
                  />
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">回复</div>
                  {live ? (
                    <div ref={streamElRef} className="mt-1 whitespace-pre-wrap break-words" />
                  ) : (
                    <div className="mt-1"><MarkdownRenderer content={m.content || ''} /></div>
                  )}
                  {m.usage && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      入 {m.usage.input_tokens ?? 0} · 出 {m.usage.output_tokens ?? 0}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-secondary px-3 py-2">
          <AutoGrowTextarea
            value={previewInput}
            onChange={(e) => setPreviewInput(e.target.value)}
            placeholder="输入调试内容，Enter 发送"
            rows={2}
            disabled={previewBusy}
            className="max-h-28 flex-1 resize-none bg-transparent text-sm outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                runPreview()
              }
            }}
          />
          {previewBusy ? (
            <button type="button" onClick={stopPreview} className="btn-secondary btn-sm inline-flex shrink-0 items-center gap-1">
              <Square className="h-3 w-3" />
              停止
            </button>
          ) : (
            <button type="button" onClick={runPreview} className="btn-primary btn-sm shrink-0">发送</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AgentWorkspace() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const [agentId, setAgentId] = useState(routeId || null)
  const [nav, setNav] = useState('config')
  const [rightTab, setRightTab] = useState('build')
  const [form, setForm] = useState(emptyForm)
  const [llmOptions, setLlmOptions] = useState([])
  const [toolOptions, setToolOptions] = useState([])
  const [skillOptions, setSkillOptions] = useState([])
  const [kbOptions, setKbOptions] = useState([])
  const [workflowOptions, setWorkflowOptions] = useState([])
  const [files, setFiles] = useState([])
  const [picker, setPicker] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!!routeId)
  const [meta, setMeta] = useState({ can_edit: true, publish_status: 'draft' })
  const [buildInput, setBuildInput] = useState('')
  const [buildLog, setBuildLog] = useState([])
  const [logs, setLogs] = useState([])
  const [monitor, setMonitor] = useState(null)
  const fileRef = useRef(null)
  const bypassGuard = useUnsavedChanges(dirty)
  const canEdit = canEditResource(meta)
  const published = isAgentPublished({ ...form, publish_status: meta.publish_status, name: form.name, description: form.description, variables: form.variables })

  const setField = (key) => (value) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const createSkillFromPicker = async (body) => {
    const created = await skillsApi.create(body)
    const opt = {
      value: String(created.id),
      label: created.name,
      description: created.description || '',
    }
    setSkillOptions((prev) => [opt, ...prev.filter((s) => s.value !== opt.value)])
    setForm((prev) => {
      const next = prev.enabled_skills.includes(opt.value)
        ? prev.enabled_skills
        : [...prev.enabled_skills, opt.value]
      return { ...prev, enabled_skills: next }
    })
    setDirty(true)
    setPicker(null)
    toast.success(`已新增技能「${created.name}」并挂到当前智能体`)
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [llms, tls, sks, kbs, wfs] = await Promise.all([
          llmApi.list(),
          toolsApi.list(),
          skillsApi.list({ enabled: true }),
          kbApi.list(),
          workflowsApi.list(),
        ])
        if (!alive) return
        const models = (Array.isArray(llms) ? llms : []).map((m) => ({
          value: String(m.id),
          label: m.name || m.model_name || `模型 ${m.id}`,
        }))
        setLlmOptions(models)
        setToolOptions(
          (Array.isArray(tls) ? tls : [])
            .filter((t) => t.enabled !== false)
            .map((t) => ({
              value: t.name,
              label: t.name,
              description: t.description || '',
            }))
        )
        setSkillOptions(
          (Array.isArray(sks) ? sks : []).map((s) => ({
            value: String(s.id),
            label: s.name,
            description: s.description || '',
          }))
        )
        setKbOptions(
          (Array.isArray(kbs) ? kbs : []).map((k) => ({
            value: String(k.id),
            label: k.name,
            description: k.description || '',
          }))
        )
        setWorkflowOptions(
          (Array.isArray(wfs) ? wfs : [])
            .filter((w) => w.enabled !== false)
            .map((w) => ({
              value: String(w.id),
              label: w.name,
              description: w.description || '',
            }))
        )
        setForm((prev) => {
          if (prev.model_config_id || !models.length) return prev
          return { ...prev, model_config_id: models[0].value }
        })
      } catch (err) {
        toast.error(err.message || '加载配置失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!routeId) return
    let alive = true
    setLoading(true)
    agentsApi
      .get(routeId)
      .then((agent) => {
        if (!alive || !agent) return
        setAgentId(String(agent.id))
        setForm({
          ...emptyForm(),
          name: agent.name || '未命名智能体',
          description: agent.description || '',
          avatar: agent.avatar || '',
          greeting: agent.greeting || '',
          suggested_questions: agent.suggested_questions || [],
          model_config_id: agent.model_config_id != null ? String(agent.model_config_id) : '',
          system_prompt: agent.system_prompt || '',
          temperature: agent.temperature ?? 0.7,
          max_tokens: agent.max_tokens ?? 2048,
          reasoning_effort: agent.reasoning_effort || '',
          context_turns: agent.context_turns ?? 10,
          enabled_tools: (agent.enabled_tools || []).map(String),
          enabled_kbs: (agent.enabled_kbs || []).map(String),
          enabled_asset_types: agent.enabled_asset_types || [],
          enabled_skills: (agent.enabled_skills || []).map(String),
          enabled_workflows: (agent.enabled_workflows || []).map(String),
          max_iterations: agent.max_iterations ?? 8,
          enable_memory: agent.enable_memory ?? false,
          tone_style: agent.tone_style || 'professional',
          variables: agent.variables || {},
          tool_configs: agent.tool_configs || {},
          engine: agent.engine || 'hermes',
          output_mode: agent.output_mode || 'chat',
        })
        setMeta({
          can_edit: typeof agent.can_edit === 'boolean' ? agent.can_edit : true,
          created_by: agent.created_by,
          publish_status: agent.publish_status || (isAgentPublished(agent) ? 'published' : 'draft'),
        })
        setDirty(false)
      })
      .catch((err) => toast.error(err.message || '加载智能体失败'))
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [routeId])

  useEffect(() => {
    if (!agentId) return
    agentFilesApi.list(agentId).then((rows) => setFiles(Array.isArray(rows) ? rows : [])).catch(() => {})
  }, [agentId])

  useEffect(() => {
    if (nav !== 'logs' || !agentId) return
    agentsApi.executions(agentId, 40).then((rows) => setLogs(Array.isArray(rows) ? rows : [])).catch(() => setLogs([]))
  }, [nav, agentId])

  useEffect(() => {
    if (nav !== 'monitor' || !agentId) return
    agentsApi.monitor(agentId).then(setMonitor).catch(() => setMonitor(null))
  }, [nav, agentId])

  const save = async (silent = false) => {
    if (!form.name.trim()) {
      if (!silent) toast.warning('请填写名称')
      return null
    }
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        description: form.description,
        avatar: form.avatar || null,
        greeting: form.greeting || null,
        suggested_questions: form.suggested_questions,
        model_config_id: form.model_config_id || null,
        system_prompt: form.system_prompt,
        temperature: Number(form.temperature),
        max_tokens: Number(form.max_tokens),
        reasoning_effort: form.reasoning_effort || null,
        context_turns: Number(form.context_turns),
        enabled_tools: form.enabled_tools,
        enabled_kbs: form.enabled_kbs.map(Number),
        enabled_asset_types: form.enabled_asset_types,
        enabled_skills: form.enabled_skills.map(Number),
        enabled_workflows: form.enabled_workflows.map(Number),
        max_iterations: Number(form.max_iterations),
        enable_memory: form.enable_memory,
        tone_style: form.tone_style,
        variables: form.variables,
        tool_configs: form.tool_configs,
        engine: form.engine || 'hermes',
        output_mode: form.output_mode || 'chat',
      }
      const result = agentId ? await agentsApi.update(agentId, body) : await agentsApi.create(body)
      setDirty(false)
      bypassGuard()
      if (!agentId && result?.id) {
        setAgentId(String(result.id))
        navigate(`/agents/${result.id}/edit`, { replace: true })
      }
      if (!silent) toast.success(published ? '已保存' : '已保存草稿')
      if (result?.publish_status) {
        setMeta((prev) => ({ ...prev, publish_status: result.publish_status }))
      }
      return result
    } catch (err) {
      if (!silent) toast.error(err.message || '保存失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  const selected = (opts, ids) => opts.filter((o) => ids.includes(o.value))

  const applyBuild = () => {
    const text = buildInput.trim()
    if (!text) return
    const plan = planAgentFromDescription(text, { toolOptions, kbOptions })
    setForm((prev) => ({
      ...prev,
      name: prev.name === '未命名智能体' || !prev.name ? plan.name : prev.name,
      description: text.slice(0, 200),
      system_prompt: prev.system_prompt?.trim()
        ? prev.system_prompt
        : `你是「${plan.name}」。\n${plan.roleLine}\n请按用户任务调用已挂载的工具、技能与知识库完成工作。`,
      greeting: prev.greeting || plan.greeting,
      enabled_tools: [...new Set([...(prev.enabled_tools || []), ...plan.enabledTools])],
      enabled_kbs: [...new Set([...(prev.enabled_kbs || []), ...plan.enabledKbs.map(String)])],
      enabled_asset_types: plan.enabledAssetTypes?.length ? plan.enabledAssetTypes : prev.enabled_asset_types,
    }))
    setDirty(true)
    setBuildLog((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: plan.summary + (plan.enabledTools.length ? `\n已挂载工具：${plan.enabledTools.join('、')}` : '') },
    ])
    setBuildInput('')
    toast.success('已写入左侧配置，请检查后保存')
  }

  const ensureSaved = async () => {
    if (!agentId || dirty) return save(true)
    return { id: agentId }
  }

  const onUpload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const saved = await ensureSaved()
    const id = saved?.id || agentId
    if (!id) return
    try {
      await agentFilesApi.upload(file, id)
      const rows = await agentFilesApi.list(id)
      setFiles(Array.isArray(rows) ? rows : [])
    } catch (err) {
      toast.error(err.message || '上传失败')
    }
  }

  const removeFile = async (fid) => {
    try {
      await agentFilesApi.remove(fid)
      setFiles((prev) => prev.filter((f) => f.id !== fid))
    } catch (err) {
      toast.error(err.message || '删除失败')
    }
  }

  const pickerProps = useMemo(() => {
    if (picker === 'skill')
      return { title: '添加 Skill', options: skillOptions, value: form.enabled_skills, field: 'enabled_skills' }
    if (picker === 'tool')
      return { title: '添加工具', options: toolOptions, value: form.enabled_tools, field: 'enabled_tools' }
    if (picker === 'kb')
      return { title: '添加知识库', options: kbOptions, value: form.enabled_kbs, field: 'enabled_kbs' }
    if (picker === 'workflow')
      return { title: '添加工作流', options: workflowOptions, value: form.enabled_workflows, field: 'enabled_workflows' }
    return null
  }, [picker, skillOptions, toolOptions, kbOptions, workflowOptions, form])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-border bg-card">
        <button
          type="button"
          onClick={() => navigate('/studio?tab=agent')}
          className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          AGENTS
        </button>
        <div className="flex items-center gap-2 px-4 pb-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/15 text-primary">
            {form.avatar ? <img src={form.avatar} alt="" className="h-full w-full object-cover" /> : <Bot className="h-4 w-4" />}
          </div>
          <input
            value={form.name}
            onChange={(e) => setField('name')(e.target.value)}
            disabled={!canEdit}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          />
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = nav === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setNav(item.id)}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                  active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto border-t border-border p-3">
          <div className="mb-2 text-center text-[11px] text-muted-foreground">
            {published ? '已发布，可在对话中使用' : '草稿，发布后才会出现在对话里'}
          </div>
          <button
            type="button"
            disabled={!canEdit || saving}
            onClick={() => save(false)}
            className="btn-secondary flex w-full items-center justify-center gap-1.5 text-sm"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存草稿
          </button>
          {canEdit && !published && (
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                const saved = await save(true)
                const id = saved?.id || agentId
                if (!id) return
                try {
                  const res = await agentsApi.publish(id)
                  setMeta((prev) => ({ ...prev, publish_status: 'published' }))
                  if (res?.name) setField('name')(res.name)
                  toast.success('已发布，可在对话中使用')
                } catch (err) {
                  toast.error(err.message || '发布失败')
                }
              }}
              className="btn-primary mt-2 flex w-full items-center justify-center gap-1.5 text-sm"
            >
              发布
            </button>
          )}
          {agentId && (
            <button
              type="button"
              onClick={() => navigate(`/agents/${agentId}/advanced`)}
              className="mt-2 w-full text-center text-[11px] text-muted-foreground hover:text-foreground"
            >
              高级选项
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1">
        {nav === 'config' && (
          <>
            <section className="min-w-0 flex-1 overflow-auto border-r border-border px-8 py-6">
              <h2 className="mb-5 text-base font-semibold">配置</h2>
              <div className="mb-6">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">模型</div>
                <CompactSelect
                  value={form.model_config_id}
                  onChange={(e) => setField('model_config_id')(e.target.value)}
                  disabled={!canEdit}
                  size="lg"
                  block
                  className="max-w-md"
                >
                  <option value="">选择模型</option>
                  {llmOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </CompactSelect>
              </div>
              <div className="mb-6">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">输出模式</div>
                <CompactSelect
                  value={form.output_mode || 'chat'}
                  onChange={(e) => setField('output_mode')(e.target.value)}
                  disabled={!canEdit}
                  size="lg"
                  block
                  className="max-w-md"
                >
                  <option value="chat">对话</option>
                  <option value="soc_decision">研判决策</option>
                  <option value="ban_risk_analyze">封禁研判</option>
                </CompactSelect>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  工作流和同步测试按这里取值。对话页始终返回对话流。
                </p>
              </div>
              <div className="mb-6">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">提示词</div>
                <AutoGrowTextarea
                  value={form.system_prompt}
                  onChange={(e) => setField('system_prompt')(e.target.value)}
                  disabled={!canEdit}
                  placeholder="在此编写指令，定义角色与工作方式"
                  className="min-h-[140px] w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                />
              </div>
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">SKILL</div>
                    <div className="text-[11px] text-muted-foreground">说明文字会注入提示词。脚本请到工具里添加。</div>
                  </div>
                  {canEdit && (
                    <button type="button" onClick={() => setPicker('skill')} className="inline-flex items-center gap-1 text-xs text-primary">
                      <Plus className="h-3.5 w-3.5" /> 添加
                    </button>
                  )}
                </div>
                {form.enabled_skills.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    暂无 Skill。点「添加」可选用库内技能，或导入文本新建。
                    <button type="button" className="ml-1 text-primary hover:underline" onClick={() => navigate('/tools')}>
                      脚本去工具库
                    </button>
                  </p>
                ) : (
                  <ChipList
                    items={selected(skillOptions, form.enabled_skills)}
                    onRemove={(v) => setField('enabled_skills')(form.enabled_skills.filter((x) => x !== v))}
                  />
                )}
              </div>
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">文件</div>
                    <div className="text-[11px] text-muted-foreground">上传智能体可读取的文档、规范或指南</div>
                  </div>
                  {canEdit && (
                    <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 text-xs text-primary">
                      <Plus className="h-3.5 w-3.5" /> 添加
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" className="hidden" onChange={onUpload} />
                {files.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无文件</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1">
                    {files.map((f) => (
                      <div key={f.id} className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-xs">
                        <span className="truncate">{f.file_name || f.name || `文件 ${f.id}`}</span>
                        {canEdit && (
                          <button type="button" onClick={() => removeFile(f.id)} className="text-muted-foreground hover:text-destructive">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">工具</div>
                    <div className="text-[11px] text-muted-foreground">HTTP / 代码 / 框架工具，供模型按需调用</div>
                  </div>
                  {canEdit && (
                    <button type="button" onClick={() => setPicker('tool')} className="inline-flex items-center gap-1 text-xs text-primary">
                      <Plus className="h-3.5 w-3.5" /> 添加
                    </button>
                  )}
                </div>
                {form.enabled_tools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无工具</p>
                ) : (
                  <ChipList
                    items={selected(toolOptions, form.enabled_tools)}
                    onRemove={(v) => setField('enabled_tools')(form.enabled_tools.filter((x) => x !== v))}
                  />
                )}
              </div>
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">工作流</div>
                    <div className="text-[11px] text-muted-foreground">已发布流程会作为独立工具挂到智能体上</div>
                  </div>
                  {canEdit && (
                    <button type="button" onClick={() => setPicker('workflow')} className="inline-flex items-center gap-1 text-xs text-primary">
                      <Plus className="h-3.5 w-3.5" /> 添加
                    </button>
                  )}
                </div>
                {form.enabled_workflows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无工作流</p>
                ) : (
                  <ChipList
                    items={selected(workflowOptions, form.enabled_workflows)}
                    onRemove={(v) => setField('enabled_workflows')(form.enabled_workflows.filter((x) => x !== v))}
                  />
                )}
              </div>
              <div className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">知识库</div>
                    <div className="text-[11px] text-muted-foreground">检索文档分段，补充领域知识</div>
                  </div>
                  {canEdit && (
                    <button type="button" onClick={() => setPicker('kb')} className="inline-flex items-center gap-1 text-xs text-primary">
                      <Plus className="h-3.5 w-3.5" /> 添加
                    </button>
                  )}
                </div>
                {form.enabled_kbs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无知识库</p>
                ) : (
                  <ChipList
                    items={selected(kbOptions, form.enabled_kbs)}
                    onRemove={(v) => setField('enabled_kbs')(form.enabled_kbs.filter((x) => x !== v))}
                  />
                )}
              </div>
            </section>

            <aside className="flex w-[420px] shrink-0 flex-col bg-card">
              <div className="flex items-center gap-4 border-b border-border px-5">
                {[
                  { id: 'build', label: '构建', icon: Sparkles },
                  { id: 'preview', label: '预览', icon: MessageSquare },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setRightTab(t.id)}
                    className={`relative flex items-center gap-1.5 py-3 text-sm ${
                      rightTab === t.id ? 'font-medium text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <t.icon className="h-3.5 w-3.5" />
                    {t.label}
                    {rightTab === t.id && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
                  </button>
                ))}
              </div>
              {rightTab === 'build' ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex-1 overflow-auto px-5 py-6">
                    {buildLog.length === 0 ? (
                      <div className="flex flex-col items-center pt-16 text-center">
                        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <p className="text-sm font-medium">通过对话构建 Agent</p>
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                          描述你的需求，会写入左侧配置。尚未保存时，预览会先自动保存。
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {buildLog.map((m, i) => (
                          <div key={i} className={`rounded-lg px-3 py-2 text-xs leading-5 ${m.role === 'user' ? 'bg-secondary' : 'border border-border'}`}>
                            {m.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border p-4">
                    <div className="flex items-end gap-2 rounded-xl border border-border bg-secondary px-3 py-2">
                      <AutoGrowTextarea
                        value={buildInput}
                        onChange={(e) => setBuildInput(e.target.value)}
                        placeholder="描述你的 Agent 应该做什么"
                        rows={2}
                        className="max-h-28 flex-1 resize-none bg-transparent text-sm outline-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            applyBuild()
                          }
                        }}
                      />
                      <button type="button" onClick={applyBuild} className="btn-primary btn-sm shrink-0">
                        开始构建
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">运行时为 Hermes 引擎，不会使用外部沙箱。</p>
                  </div>
                </div>
              ) : (
                <AgentPreviewPane agentId={agentId} engine={form.engine} ensureSaved={ensureSaved} />
              )}
            </aside>
          </>
        )}

        {nav === 'access' && (
          <section className="flex-1 overflow-auto px-8 py-6">
            <h2 className="mb-4 text-base font-semibold">访问点</h2>
            {!agentId ? (
              <p className="text-sm text-muted-foreground">请先保存智能体</p>
            ) : (
              <div className="max-w-lg space-y-3">
                <div className="rounded-lg border border-border p-4">
                  <div className="text-sm font-medium">对话</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {published ? '在运营中心对话页使用此智能体' : '发布成功后才会出现在对话列表中'}
                  </p>
                  <button
                    type="button"
                    className="btn-secondary btn-sm mt-3"
                    disabled={!published}
                    onClick={() => {
                    try { localStorage.setItem('soar_chat_selected_agent', String(agentId)) } catch {}
                    navigate('/chat')
                  }}>
                    打开对话
                  </button>
                </div>
                <div className="rounded-lg border border-border p-4">
                  <div className="text-sm font-medium">API</div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">POST /api/v1/agents/{agentId}/chat</p>
                </div>
              </div>
            )}
          </section>
        )}

        {nav === 'logs' && (
          <section className="flex-1 overflow-auto px-8 py-6">
            <h2 className="mb-4 text-base font-semibold">日志</h2>
            {!agentId ? (
              <p className="text-sm text-muted-foreground">请先保存智能体</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无执行记录</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {logs.map((row) => (
                  <div key={row.id} className="flex items-center justify-between border-b border-border px-4 py-2 text-xs last:border-b-0">
                    <span>#{row.id} · {row.trigger_type || '-'} · {row.status || '-'}</span>
                    <span className="text-muted-foreground">{row.created_at || ''}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {nav === 'monitor' && (
          <section className="flex-1 overflow-auto px-8 py-6">
            <h2 className="mb-4 text-base font-semibold">监控</h2>
            {!agentId ? (
              <p className="text-sm text-muted-foreground">请先保存智能体</p>
            ) : (
              <div>
                <div className="mb-4 grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-[11px] text-muted-foreground">总执行</div>
                    <div className="mt-1 text-lg font-semibold">{monitor?.stats?.total ?? 0}</div>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-[11px] text-muted-foreground">成功</div>
                    <div className="mt-1 text-lg font-semibold">{monitor?.stats?.success ?? 0}</div>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-[11px] text-muted-foreground">失败</div>
                    <div className="mt-1 text-lg font-semibold">{monitor?.stats?.failed ?? 0}</div>
                  </div>
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={() => navigate(`/agents/${agentId}/monitor`)}>
                  打开完整监控
                </button>
              </div>
            )}
          </section>
        )}
      </div>

      {pickerProps && (
        <AddPicker
          title={pickerProps.title}
          options={pickerProps.options}
          value={pickerProps.value}
          onChange={setField(pickerProps.field)}
          onClose={() => setPicker(null)}
          kind={picker}
          onCreateSkill={picker === 'skill' ? createSkillFromPicker : undefined}
        />
      )}
    </div>
  )
}
