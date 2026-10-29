import { useEffect, useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  FileText, Shield, ClipboardList, Clock, Brain, Monitor,
  HelpCircle, ListChecks, Send, Package,
  User, Settings, Wrench, Target, Puzzle, Search, TestTube, Bot,
  GitBranch, Rocket, MessageSquare, Check, Flag, XCircle,
  X, AlertTriangle, Loader2,
  ChevronDown, ChevronRight, Play,
  Copy, Download, History, AlertCircle, Zap, Timer, Code,
  Database, FolderKanban,
} from 'lucide-react'
import {
  agents as agentsApi,
  llmConfigs as llmApi,
  tools as toolsApi,
  knowledgeBases as kbApi,
  skills as skillsApi,
  workflows as workflowsApi,
  isAgentPublished,
} from '../api/client'
import {
  Section,
  TextInput,
  NumberInput,
  SelectInput,
  TextArea,
  CheckboxGroup,
} from '../components/property/FormControls'
import { inputCls, textareaCls } from '../components/property/FormControls'
import MiddlewareConfig from '../components/MiddlewareConfig'
import ToolSearchStatus from '../components/ToolSearchStatus'
import InfoTip from '../components/InfoTip'
import { CompactSelect } from '../components/ui'
import { CATEGORY_META, UNCATEGORIZED, groupToolsByCategory } from '../constants/toolCategories'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { toast } from '../store/toastStore'
import { canEditResource, guardNavPermission } from '../utils/permissions'
import {
  AGENT_TEMPLATES,
  loadStashedAgentTemplate,
  loadStashedAgentDsl,
  resolveAgentTemplate,
  getTemplateRecommendedTools,
} from '../constants/agentTemplates'
import AgentDslPanel from '../components/AgentDslPanel'

// 四步向导：基础 → 大脑与角色 → 挂能力 → 行为与记忆
const WIZARD_STEPS = [
  { id: 'basic', label: '基础信息', cards: ['基础信息与形象'] },
  { id: 'role', label: '大脑与角色', cards: ['核心人设与提示词', '模型与参数设置'] },
  { id: 'ability', label: '挂能力', cards: ['能力配置'] },
  { id: 'behavior', label: '行为与记忆', cards: ['记忆与高级机制', '高级选项'] },
]

// 工具分类 lucide 图标映射
const CATEGORY_ICON_MAP = {
  FileText, Shield, ClipboardList, Clock, Brain, Monitor,
  HelpCircle, ListChecks, Send, Package,
}

// 语气风格选项
const TONE_STYLES = [
  { value: 'professional', label: '专业严谨', example: '经核查，该 IP 存在恶意行为记录，建议立即封禁。' },
  { value: 'humorous', label: '幽默风趣', example: '哎呀，这个 IP 不太老实，已经偷偷搞事情了，建议封掉它！' },
  { value: 'casual', label: '轻松随意', example: '这个 IP 有问题，封了就行。' },
  { value: 'formal', label: '正式礼貌', example: '根据威胁情报分析，该 IP 存在风险，建议采取封禁措施。' },
  { value: 'concise', label: '简洁明了', example: '该 IP 为恶意，建议封禁。' },
]

// 快捷测试用例
const QUICK_TEST_CASES = [
  { label: '境外恶意 IP', value: '89.124.70.92', desc: '境外恶意 IP，触发威胁情报查询' },
  { label: '国内关键资产', value: '219.133.105.155', desc: '国内关键资产 IP，触发资产归属查询' },
  { label: '已封禁 IP', value: '45.227.255.206', desc: '已封禁 IP，触发封禁状态查询' },
  { label: '内网私网 IP', value: '192.0.2.100', desc: '私网 IP 示例（文档保留段），触发白名单/资产查询' },
]

// 可折叠卡片
function Card({ title, icon, children, defaultOpen = true, hint, extra, status, open: openCtrl, onToggle }) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen)
  const open = openCtrl !== undefined ? openCtrl : innerOpen
  const handleToggle = () => {
    if (onToggle) onToggle(!open)
    else setInnerOpen((o) => !o)
  }
  // 状态徽章颜色
  const badgeCls = {
    ok: 'bg-emerald-500',
    empty: 'bg-muted-foreground',
    required: 'bg-red-500',
  }[status] || ''
  return (
    <div className="rounded-lg border border-border bg-card" data-section-title={typeof title === 'string' ? title : ''}>
      <div className="flex w-full items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={handleToggle}
          className="flex flex-1 items-center gap-2 text-left transition hover:text-primary"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span>{icon}</span>
            {title}
            {hint && <InfoTip text={hint} />}
          </span>
          {/* 状态徽章 */}
          {status && (
            <span className={`h-2 w-2 shrink-0 rounded-full ${badgeCls}`} title={status === 'ok' ? '已配置' : status === 'required' ? '必填未填写' : '未配置'} />
          )}
          <span className="text-muted-foreground">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
        </button>
        {extra && <div className="shrink-0">{extra}</div>}
      </div>
      {open && <div className="flex flex-col gap-4 border-t border-border p-4">{children}</div>}
    </div>
  )
}

// 智能体编辑器：左侧6模块配置 + 右侧调试预览
function AgentEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isEdit = !!id

  const [form, setForm] = useState({
    name: '',
    description: '',
    avatar: '',
    greeting: '',
    suggested_questions: [],
    model_config_id: '',
    system_prompt: '',
    temperature: 0.7,
    max_tokens: 1024,
    context_turns: 10,
    enabled_tools: [],
    enabled_kbs: [],
    enabled_asset_types: [],
    enabled_skills: [],
    enabled_workflows: [],
    max_iterations: 5,
    enable_memory: false,
    tone_style: 'professional',
    variables: {},
    tool_configs: {},
    publish_status: 'draft',
  })
  const [llmOptions, setLlmOptions] = useState([])
  const [toolOptions, setToolOptions] = useState([])
  const [kbOptions, setKbOptions] = useState([])
  const [skillOptions, setSkillOptions] = useState([])
  const [workflowOptions, setWorkflowOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  // 资源级 owner 控制：已加载详情的 can_edit / created_by（新建时默认可编辑）
  const [agentMeta, setAgentMeta] = useState({ can_edit: true, created_by: null })

  // 变量编辑器
  const [varRows, setVarRows] = useState([{ key: '', value: '' }])
  // 标准模式 / 开发者模式
  const [devMode, setDevMode] = useState(false)
  // 展开的工具配置项
  const [expandedTool, setExpandedTool] = useState(null)
  // 能力配置 Tab：knowledge / tools / skills
  const [abilityTab, setAbilityTab] = useState('tools')
  // 能力配置全局搜索
  const [abilitySearch, setAbilitySearch] = useState('')
  const [skillDraftName, setSkillDraftName] = useState('')
  const [skillDraftContent, setSkillDraftContent] = useState('')
  const [skillDraftSaving, setSkillDraftSaving] = useState(false)
  const skillDraftFileRef = useRef(null)
  // 工具分组：只看已选（简单模式默认只看已选/推荐）
  const [onlySelectedTools, setOnlySelectedTools] = useState(false)
  const [browseAllTools, setBrowseAllTools] = useState(false)
  const [appliedTemplate, setAppliedTemplate] = useState(null)
  // 工具分组展开状态
  const [collapsedGroups, setCollapsedGroups] = useState({})

  // 简单 / 高级编辑模式（默认简单，借鉴 Dify 应用配置分层）
  const [editorMode, setEditorMode] = useState(() => {
    try { return localStorage.getItem('soar_agent_editor_mode') || 'simple' } catch { return 'simple' }
  })
  const setEditorModePersist = useCallback((mode) => {
    setEditorMode(mode)
    setBrowseAllTools(mode === 'advanced')
    if (mode === 'simple') setOnlySelectedTools(true)
    try { localStorage.setItem('soar_agent_editor_mode', mode) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (editorMode === 'simple') {
      setOnlySelectedTools(true)
      setBrowseAllTools(false)
    }
  }, [editorMode])

  const templateToolHints = useMemo(() => {
    if (appliedTemplate?.tool_hints) return appliedTemplate.tool_hints
    const match = AGENT_TEMPLATES.find((t) => {
      const names = getTemplateRecommendedTools(t)
      if (!names.length) return false
      return names.every((n) => form.enabled_tools.includes(n))
    })
    return match?.tool_hints || {}
  }, [appliedTemplate, form.enabled_tools])

  const simpleToolOptions = useMemo(() => {
    const rec = appliedTemplate
      ? new Set(getTemplateRecommendedTools(appliedTemplate))
      : new Set(form.enabled_tools)
    const pool = rec.size > 0
      ? toolOptions.filter((t) => rec.has(t.value) || form.enabled_tools.includes(t.value))
      : toolOptions.filter((t) => form.enabled_tools.includes(t.value))
    return pool.length > 0 ? pool : toolOptions.filter((t) => form.enabled_tools.includes(t.value))
  }, [appliedTemplate, toolOptions, form.enabled_tools])

  // 向导当前步骤（仅高级模式）
  const [wizardStep, setWizardStep] = useState('basic')
  const [showAllSections, setShowAllSections] = useState(false)

  // 各配置卡片展开状态（受控，避免 expandAll 与 innerOpen 不同步导致无法展开）
  const [cardOpens, setCardOpens] = useState({
    '基础信息与形象': true,
    '核心人设与提示词': false,
    '模型与参数设置': false,
    '能力配置': false,
    '记忆与高级机制': false,
    '高级选项': false,
  })
  const toggleCard = useCallback((title) => (nextOpen) => {
    setCardOpens((prev) => ({ ...prev, [title]: nextOpen }))
  }, [])
  const setAllCards = useCallback((open) => {
    setCardOpens((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, open])))
    setShowAllSections(open)
  }, [])
  // 配置项搜索关键词
  const [sectionSearch, setSectionSearch] = useState('')

  // 搜索匹配：输入关键词时自动展开匹配的 Card，忽略 cardOpens
  const searchKw = sectionSearch.trim().toLowerCase()
  const sectionOpen = (sectionTitle) => {
    if (searchKw) {
      // 搜索时：匹配的展开，不匹配的收起
      return sectionTitle.toLowerCase().includes(searchKw)
    }
    return cardOpens[sectionTitle] ?? false
  }

  const SIMPLE_CARDS = ['基础信息与形象', '模型与参数设置', '核心人设与提示词', '能力配置']

  const wizardShows = useCallback((sectionTitle) => {
    if (searchKw || showAllSections) return true
    if (editorMode === 'simple') {
      return SIMPLE_CARDS.includes(sectionTitle)
    }
    const step = WIZARD_STEPS.find((s) => s.id === wizardStep)
    return step ? step.cards.includes(sectionTitle) : true
  }, [searchKw, wizardStep, showAllSections, editorMode])

  const goWizardStep = useCallback((stepId) => {
    setShowAllSections(false)
    setWizardStep(stepId)
    const step = WIZARD_STEPS.find((s) => s.id === stepId)
    if (!step) return
    setCardOpens((prev) => {
      const next = { ...prev }
      step.cards.forEach((c) => { next[c] = true })
      return next
    })
  }, [])

  // 各模块配置状态计算
  const sectionStatus = useMemo(() => {
    const s = {}
    // 基础信息：name 必填，description/greeting 可选
    if (!form.name.trim()) s.basic = 'required'
    else if (form.description || form.greeting) s.basic = 'ok'
    else s.basic = 'ok'  // 有名称就算 ok
    // 人设提示词
    s.prompt = form.system_prompt.trim() ? 'ok' : 'empty'
    // 模型参数
    s.model = form.model_config_id ? 'ok' : 'empty'
    // 工具与知识
    const hasTools = form.enabled_tools.length > 0
    const hasKbs = form.enabled_kbs.length > 0
    const hasWorkflows = form.enabled_workflows.length > 0
    s.tools = (hasTools || hasKbs || hasWorkflows) ? 'ok' : 'empty'
    // 技能注入
    s.skills = form.enabled_skills.length > 0 ? 'ok' : 'empty'
    // 记忆与高级
    s.memory = form.enable_memory || form.tone_style !== 'professional' ? 'ok' : 'empty'
    // 安全配置
    s.security = Object.keys(form.tool_configs).length > 0 ? 'ok' : 'empty'
    // 工具搜索状态
    s.toolSearch = 'empty'
    return s
  }, [form])

  // 配置摘要：已挂载数量 + 可调试状态
  const configSummary = useMemo(() => {
    const kbs = form.enabled_kbs.length
    const tools = form.enabled_tools.length
    const skills = form.enabled_skills.length
    const workflows = form.enabled_workflows.length
    const canDebug = !!form.name.trim() && !!form.model_config_id
    const issues = []
    if (!form.name.trim()) issues.push('名称未填')
    if (!form.model_config_id) issues.push('模型未选')
    if (tools + kbs + skills + workflows === 0) issues.push('未挂载任何能力')
    return { kbs, tools, skills, workflows, canDebug, issues }
  }, [form])

  // JSON 语法高亮（简易版：key/string/number/boolean/null 着色）
  const highlightJson = useCallback((obj) => {
    if (!obj || Object.keys(obj).length === 0) return '<span class="text-muted-foreground">{}</span>'
    try {
      const json = JSON.stringify(obj, null, 2)
      return json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
          (match) => {
            let cls = 'text-amber-400' // number
            if (/^"/.test(match)) {
              if (/:$/.test(match)) cls = 'text-sky-400' // key
              else cls = 'text-emerald-400' // string
            } else if (/true|false/.test(match)) cls = 'text-purple-400'
            else if (/null/.test(match)) cls = 'text-muted-foreground'
            return `<span class="${cls}">${match}</span>`
          })
    } catch { return '{}' }
  }, [])

  // 按分类分组的工具列表（标准模式 + 开发者模式共用）
  const groupedTools = useMemo(() => groupToolsByCategory(toolOptions), [toolOptions])

  // 能力配置全局搜索结果（跨知识库/工具/技能/工作流）
  const abilitySearchResults = useMemo(() => {
    if (!abilitySearch.trim()) return null
    const kw = abilitySearch.trim().toLowerCase()
    return {
      tools: toolOptions.filter((t) => t.label.toLowerCase().includes(kw) || (t.value || '').toLowerCase().includes(kw) || (t.description || '').toLowerCase().includes(kw)),
      kbs: kbOptions.filter((k) => k.label.toLowerCase().includes(kw) || (k.description || '').toLowerCase().includes(kw)),
      skills: skillOptions.filter((s) => s.label.toLowerCase().includes(kw) || (s.description || '').toLowerCase().includes(kw)),
      workflows: workflowOptions.filter((w) => w.label.toLowerCase().includes(kw) || (w.description || '').toLowerCase().includes(kw)),
    }
  }, [abilitySearch, toolOptions, kbOptions, skillOptions, workflowOptions])

  // 工具搜索 + 已选过滤后的分组列表
  const filteredGroupedTools = useMemo(() => {
    const kw = abilitySearch.trim().toLowerCase()
    return groupedTools.map((grp) => {
      let tools = grp.tools
      if (kw) tools = tools.filter((t) => t.label.toLowerCase().includes(kw) || (t.value || '').toLowerCase().includes(kw) || (t.description || '').toLowerCase().includes(kw))
      if (onlySelectedTools) tools = tools.filter((t) => form.enabled_tools.includes(t.value))
      return { ...grp, tools }
    }).filter((grp) => grp.tools.length > 0)
  }, [groupedTools, abilitySearch, onlySelectedTools, form.enabled_tools])

  // ===== 调试预览状态 =====
  const [testInput, setTestInput] = useState('')
  const [testing, setTesting] = useState(false)
  // testResult 结构：
  //   hermes: { mode:'hermes', streaming, reply, toolCalls:[], delegateGroups:[], logs, statusMsgs:[] }
  //   delegateGroups 项: { subagent_id, task_index, status:'running'|'completed'|'failed', goal, events:[], expanded }
  const [testResult, setTestResult] = useState(null)
  const [testError, setTestError] = useState('')
  const [showMessages, setShowMessages] = useState(true)
  const [showLogs, setShowLogs] = useState(false)
  const [showToolCalls, setShowToolCalls] = useState(true)
  const [showDelegates, setShowDelegates] = useState(true)
  // 调试区 Tab / 历史 / Token / 耗时
  const [activeTab, setActiveTab] = useState('output')
  const [runHistory, setRunHistory] = useState([])
  const [tokenUsage, setTokenUsage] = useState(null)
  const [testStartTime, setTestStartTime] = useState(null)
  const [testDuration, setTestDuration] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [copied, setCopied] = useState(false)
  const streamReplyRef = useRef(null)
  const streamThinkingRef = useRef(null)
  const rafRef = useRef(null)
  const thinkingRafRef = useRef(null)
  const pendingTextRef = useRef('')
  const pendingThinkingRef = useRef('')
  const paintText = useCallback((elRef, textRef, slotRef) => {
    if (slotRef.current) return
    slotRef.current = requestAnimationFrame(() => {
      const el = elRef.current
      if (el) el.textContent = textRef.current
      slotRef.current = null
    })
  }, [])
  const scheduleStreamUpdate = useCallback((text) => {
    pendingTextRef.current = text
    paintText(streamReplyRef, pendingTextRef, rafRef)
  }, [paintText])
  const scheduleThinkingUpdate = useCallback((text) => {
    pendingThinkingRef.current = text
    paintText(streamThinkingRef, pendingThinkingRef, thinkingRafRef)
  }, [paintText])

  useLayoutEffect(() => {
    if (!testResult?.streaming) return
    if (streamReplyRef.current) streamReplyRef.current.textContent = pendingTextRef.current
    if (streamThinkingRef.current) streamThinkingRef.current.textContent = pendingThinkingRef.current
  }, [testResult])

  // JSON 语法校验（仅当输入以 { 或 [ 开头时检测）
  const jsonError = useMemo(() => {
    const trimmed = testInput.trim()
    if (!trimmed) return null
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try { JSON.parse(trimmed); return null } catch (e) { return e.message }
  }, [testInput])

  // 运行历史（localStorage 持久化最近 5 次）
  const historyKey = `agent_debug_history_${id || 'new'}`
  useEffect(() => {
    try { setRunHistory(JSON.parse(localStorage.getItem(historyKey) || '[]')) } catch { /* ignore */ }
  }, [historyKey])
  const saveToHistory = useCallback((input, result, tokens, duration) => {
    const entry = {
      id: Date.now(),
      input: input.slice(0, 300),
      timestamp: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      reply: (result?.reply || '').slice(0, 200),
      mode: result?.mode || '',
      tokens,
      duration,
    }
    setRunHistory((prev) => {
      const next = [entry, ...prev].slice(0, 5)
      try { localStorage.setItem(historyKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [historyKey])

  // 复制 Markdown / 导出 JSON
  const handleCopyMarkdown = useCallback(() => {
    const text = testResult?.reply || ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('已复制到剪贴板')
    }).catch(() => toast.error('复制失败'))
  }, [testResult])
  const handleExportJson = useCallback(() => {
    if (!testResult) return
    const blob = new Blob([JSON.stringify(testResult, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `agent_debug_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [testResult])

  const bypassGuard = useUnsavedChanges(dirty)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const [llms, tls, kbs, sks, wfs] = await Promise.all([
          llmApi.list(),
          toolsApi.list(),
          kbApi.list(),
          skillsApi.list({ enabled: true }),
          workflowsApi.list(),
        ])
        if (!alive) return
        setLlmOptions(Array.isArray(llms) ? llms : [])
        setToolOptions(
          (Array.isArray(tls) ? tls : []).map((t) => ({
            value: t.name || `工具 ${t.id}`,
            label: `${t.name || `工具 ${t.id}`}${t.enabled === false ? '（已禁用）' : ''}`,
            category: t.category || '',
            description: t.description || '',
            tool_type: t.tool_type || 'code',
          }))
        )
        setKbOptions(
          (Array.isArray(kbs) ? kbs : []).map((k) => ({
            value: String(k.id),
            label: k.name || `知识库 ${k.id}`,
            description: k.description || '',
            doc_count: k.doc_count ?? 0,
            updated_at: k.updated_at || k.created_at,
          }))
        )
        // 仅展示启用中的技能（禁用的技能不会注入 prompt，不应被勾选）
        setSkillOptions(
          (Array.isArray(sks) ? sks : []).map((s) => ({
            value: String(s.id),
            label: `${s.name || `技能 ${s.id}`}${s.category ? `（${s.category}）` : ''}`,
            description: s.description || '',
          }))
        )
        setWorkflowOptions(
          (Array.isArray(wfs) ? wfs : [])
            .filter((w) => w.enabled !== false)
            .map((w) => ({
              value: String(w.id),
              label: w.name || `工作流 ${w.id}`,
              description: w.description || '',
              status: w.status || 'published',
              category: w.category || '',
            }))
        )
        if (!isEdit) {
          const dsl = loadStashedAgentDsl()
          if (dsl && alive) {
            setForm((prev) => ({
              ...prev,
              name: dsl.name ?? prev.name,
              description: dsl.description ?? prev.description,
              model_config_id: dsl.model_config_id != null ? String(dsl.model_config_id) : prev.model_config_id,
              system_prompt: dsl.system_prompt ?? prev.system_prompt,
              temperature: dsl.temperature ?? prev.temperature,
              max_tokens: dsl.max_tokens ?? prev.max_tokens,
              enabled_tools: dsl.enabled_tools ?? prev.enabled_tools,
              enabled_kbs: (dsl.enabled_kbs || prev.enabled_kbs).map(String),
              enabled_asset_types: dsl.enabled_asset_types ?? prev.enabled_asset_types,
              enabled_skills: (dsl.enabled_skills || prev.enabled_skills).map(String),
              enabled_workflows: (dsl.enabled_workflows || prev.enabled_workflows).map(String),
              max_iterations: dsl.max_iterations ?? prev.max_iterations,
              avatar: dsl.avatar ?? prev.avatar,
              greeting: dsl.greeting ?? prev.greeting,
              suggested_questions: dsl.suggested_questions ?? prev.suggested_questions,
              context_turns: dsl.context_turns ?? prev.context_turns,
              enable_memory: dsl.enable_memory ?? prev.enable_memory,
              tone_style: dsl.tone_style ?? prev.tone_style,
              variables: dsl.variables ?? prev.variables,
              tool_configs: dsl.tool_configs ?? prev.tool_configs,
              engine: dsl.engine ?? prev.engine,
            }))
            setDirty(true)
            toast.success(`已从 DSL/团队模板载入「${dsl.name || '智能体'}」`)
          } else {
          const tpl = loadStashedAgentTemplate()
          if (tpl && alive) {
            setAppliedTemplate(tpl)
            const resolved = resolveAgentTemplate(tpl, {
              kbOptions: (Array.isArray(kbs) ? kbs : []).map((k) => ({
                value: String(k.id),
                label: k.name || `知识库 ${k.id}`,
              })),
              skillOptions: (Array.isArray(sks) ? sks : []).map((s) => ({
                value: String(s.id),
                label: s.name || `技能 ${s.id}`,
              })),
              toolOptions: (Array.isArray(tls) ? tls : []).map((t) => ({
                value: t.name || `工具 ${t.id}`,
              })),
            })
            if (resolved) {
              const { _wizardStep, _templateName, ...formPatch } = resolved
              setForm((prev) => ({ ...prev, ...formPatch }))
              setDirty(true)
              if (_wizardStep) {
                const step = WIZARD_STEPS.find((s) => s.id === _wizardStep)
                if (step) {
                  setWizardStep(_wizardStep)
                  setCardOpens((prev) => {
                    const next = { ...prev }
                    step.cards.forEach((c) => { next[c] = true })
                    return next
                  })
                }
              }
              if (_templateName) toast.success(`已应用模板「${_templateName}」`)
            }
          }
          }
        }
        if (isEdit) {
          const agent = await agentsApi.list().then((arr) =>
            (Array.isArray(arr) ? arr : []).find((x) => String(x.id) === String(id))
          )
          if (!alive) return
          if (agent) {
            setForm({
              id: agent.id,
              name: agent.name || '',
              description: agent.description || '',
              avatar: agent.avatar || '',
              greeting: agent.greeting || '',
              suggested_questions: agent.suggested_questions || [],
              model_config_id: agent.model_config_id ?? '',
              system_prompt: agent.system_prompt || '',
              temperature: agent.temperature ?? 0.7,
              max_tokens: agent.max_tokens ?? 1024,
              context_turns: agent.context_turns ?? 10,
              enabled_tools: (agent.enabled_tools || []).map(String),
              enabled_kbs: (agent.enabled_kbs || []).map(String),
              enabled_asset_types: agent.enabled_asset_types || [],
              enabled_skills: (agent.enabled_skills || []).map(String),
              enabled_workflows: (agent.enabled_workflows || []).map(String),
              max_iterations: agent.max_iterations ?? 5,
              enable_memory: agent.enable_memory ?? false,
              tone_style: agent.tone_style || 'professional',
              variables: agent.variables || {},
              tool_configs: agent.tool_configs || {},
              engine: agent.engine || 'hermes',
              publish_status: agent.publish_status || (isAgentPublished(agent) ? 'published' : 'draft'),
            })
            // 记录资源级权限标志（用于禁用保存按钮）
            setAgentMeta({
              can_edit: typeof agent.can_edit === 'boolean' ? agent.can_edit : true,
              created_by: agent.created_by ?? null,
            })
            // 同步变量编辑器行
            const varObj = agent.variables || {}
            const rows = Object.keys(varObj).length > 0
              ? Object.entries(varObj).map(([k, v]) => ({ key: k, value: String(v) }))
              : [{ key: '', value: '' }]
            setVarRows(rows)
          } else {
            setError('未找到该智能体')
          }
        }
      } catch (err) {
        if (!alive) return
        setError(err.message || '加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [id, isEdit])

  const setField = (field) => (value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
  }

  // 变量编辑器：更新某行
  const updateVarRow = (idx, key, value) => {
    const next = [...varRows]
    next[idx] = { key, value }
    setVarRows(next)
    // 同步到 form.variables
    const varObj = {}
    next.forEach((r) => { if (r.key.trim()) varObj[r.key.trim()] = r.value })
    setForm((prev) => ({ ...prev, variables: varObj }))
    setDirty(true)
  }

  const applyDslToForm = useCallback((dsl) => {
    setForm((prev) => ({
      ...prev,
      name: dsl.name ?? prev.name,
      description: dsl.description ?? prev.description,
      model_config_id: dsl.model_config_id != null ? String(dsl.model_config_id) : prev.model_config_id,
      system_prompt: dsl.system_prompt ?? prev.system_prompt,
      temperature: dsl.temperature ?? prev.temperature,
      max_tokens: dsl.max_tokens ?? prev.max_tokens,
      enabled_tools: dsl.enabled_tools ?? prev.enabled_tools,
      enabled_kbs: (dsl.enabled_kbs || prev.enabled_kbs).map(String),
      enabled_asset_types: dsl.enabled_asset_types ?? prev.enabled_asset_types,
      enabled_skills: (dsl.enabled_skills || prev.enabled_skills).map(String),
      enabled_workflows: (dsl.enabled_workflows || prev.enabled_workflows).map(String),
      max_iterations: dsl.max_iterations ?? prev.max_iterations,
      avatar: dsl.avatar ?? prev.avatar,
      greeting: dsl.greeting ?? prev.greeting,
      suggested_questions: dsl.suggested_questions ?? prev.suggested_questions,
      context_turns: dsl.context_turns ?? prev.context_turns,
      enable_memory: dsl.enable_memory ?? prev.enable_memory,
      tone_style: dsl.tone_style ?? prev.tone_style,
      variables: dsl.variables ?? prev.variables,
      tool_configs: dsl.tool_configs ?? prev.tool_configs,
      engine: dsl.engine ?? prev.engine,
    }))
    setDirty(true)
  }, [])

  const handlePublishTemplate = async () => {
    if (!isEdit || !id) {
      toast.warning('请先保存智能体后再发布为模板')
      return
    }
    if (dirty) {
      const saved = await handleSave(true)
      if (!saved) return
    }
    try {
      await agentsApi.publishTemplate(id, {
        scenario: form.description || '',
        tags: [],
      })
      toast.success('已发布为团队模板，新建时可被选用')
    } catch (err) {
      toast.error(err.message || '发布失败')
    }
  }

  // 保存
  const handleSave = async (silent = false) => {
    if (!form.name.trim()) {
      if (!silent) toast.warning('请填写智能体名称')
      return null
    }
    setSaving(true)
    try {
      const body = {
        name: form.name,
        description: form.description,
        avatar: form.avatar || null,
        greeting: form.greeting || null,
        suggested_questions: form.suggested_questions,
        model_config_id: form.model_config_id || null,
        system_prompt: form.system_prompt,
        temperature: Number(form.temperature),
        max_tokens: Number(form.max_tokens),
        context_turns: Number(form.context_turns),
        enabled_tools: form.enabled_tools,
        enabled_kbs: form.enabled_kbs.map((v) => Number(v)),
        enabled_asset_types: form.enabled_asset_types,
        enabled_skills: form.enabled_skills.map((v) => Number(v)),
        enabled_workflows: form.enabled_workflows.map((v) => Number(v)),
        max_iterations: Number(form.max_iterations),
        enable_memory: form.enable_memory,
        tone_style: form.tone_style,
        variables: form.variables,
        tool_configs: form.tool_configs,
        engine: form.engine || 'hermes',
      }
      let result
      if (isEdit) {
        result = await agentsApi.update(id, body)
      } else {
        result = await agentsApi.create(body)
      }
      setDirty(false)
      bypassGuard()
      if (!silent) navigate('/studio')
      return result
    } catch (err) {
      if (!silent) toast.error(`保存失败：${err.message || err}`)
      return null
    } finally {
      setSaving(false)
    }
  }

  // ===== 调试运行（流式） =====
  // 统一走 Hermes /chat（支持 delegate 嵌套事件）
  const handleTest = async () => {
    let agentId = id
    if (!agentId) {
      const saved = await handleSave(true)
      if (saved && saved.id) {
        agentId = saved.id
        navigate(`/agents/${saved.id}/edit`, { replace: true })
      } else {
        return
      }
    }
    if (dirty) {
      const saved = await handleSave(true)
      if (!saved) return
    }
    setTesting(true)
    setTestError('')
    setTestResult(null)
    pendingTextRef.current = ''
    pendingThinkingRef.current = ''
    if (streamReplyRef.current) streamReplyRef.current.textContent = ''
    if (streamThinkingRef.current) streamThinkingRef.current.textContent = ''
    setTokenUsage(null)
    setTestDuration(null)
    setTestStartTime(Date.now())
    setActiveTab('output')

    try {
      const resp = await agentsApi.chatStream(agentId, testInput || '你好', undefined, undefined, { channel: 'test' })
      if (!resp.ok) {
        const errText = await resp.text()
        throw new Error(errText || `HTTP ${resp.status}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

        // ===== Hermes 引擎：解析 start/token/tool_start/tool_end/delegate/log/done/error =====
        let fullText = ''
        let toolCalls = []
        let delegateGroups = []
        let logs = []
        let statusMsgs = []

        // 初始化 Hermes 结果结构
        setTestResult({
          mode: 'hermes',
          streaming: true,
          reply: '',
          thinking: '',
          toolCalls: [],
          delegateGroups: [],
          logs: [],
          statusMsgs: [],
        })
        const toolResultStore = new Map()
        let thinkingNoted = false

        const flush = (patch) => {
          setTestResult((prev) => prev ? { ...prev, ...patch } : prev)
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
              switch (data.type) {
                case 'start':
                  // 会话开始
                  break
                case 'thinking':
                  pendingThinkingRef.current += data.content || ''
                  scheduleThinkingUpdate(pendingThinkingRef.current)
                  if (!thinkingNoted) {
                    thinkingNoted = true
                    flush({ thinking: '\u200b' })
                  }
                  break
                case 'token':
                  fullText += data.content || ''
                  scheduleStreamUpdate(fullText)
                  break
                case 'status':
                  statusMsgs.push(data.message || '')
                  flush({ statusMsgs: [...statusMsgs] })
                  break
                case 'clarify': {
                  // 澄清提问：调试面板展示问题与选项（用户在测试输入框中回答）
                  const choices = Array.isArray(data.choices) ? data.choices : []
                  statusMsgs.push(
                    `[clarify] ${data.question || ''}${
                      choices.length ? ` 选项: ${choices.join(' / ')}` : ''
                    }`
                  )
                  flush({ statusMsgs: [...statusMsgs] })
                  break
                }
                case 'tool_start': {
                  // 工具开始执行：加入 toolCalls（状态 running）
                  toolCalls.push({
                    name: data.tool_name || '',
                    call_id: data.tool_call_id || '',
                    status: 'running',
                    message: data.message || '',
                    result: null,
                  })
                  flush({ toolCalls: [...toolCalls] })
                  break
                }
                case 'tool_end': {
                  // 工具执行结束：更新对应 toolCalls 项
                  const idx = toolCalls.findIndex(
                    (tc) => tc.call_id === data.tool_call_id && tc.status === 'running'
                  )
                  const tcId = data.tool_call_id || ''
                  if (data.result !== undefined) toolResultStore.set(tcId, data.result)
                  if (idx >= 0) {
                    toolCalls[idx] = {
                      ...toolCalls[idx],
                      status: 'done',
                      message: data.message || toolCalls[idx].message,
                    }
                  } else {
                    toolCalls.push({
                      name: data.tool_name || '',
                      call_id: tcId,
                      status: 'done',
                      message: data.message || '',
                    })
                  }
                  flush({
                    toolCalls: toolCalls.map((tc) => ({
                      ...tc,
                      result: null,
                    })),
                  })
                  break
                }
                case 'delegate': {
                  // 子代理委派嵌套事件：按 subagent_id 分组
                  // data.result = { subagent_id, task_index, event: { type, content, message, tool_name, ... } }
                  const info = data.result || {}
                  const sid = info.subagent_id || 'unknown'
                  const tidx = info.task_index ?? 0
                  const evt = info.event || {}
                  // 查找已有分组
                  let gIdx = delegateGroups.findIndex((g) => g.subagent_id === sid)
                  if (gIdx < 0) {
                    // 新建分组
                    delegateGroups.push({
                      subagent_id: sid,
                      task_index: tidx,
                      status: 'running',
                      goal: '',
                      events: [],
                      expanded: true,
                    })
                    gIdx = delegateGroups.length - 1
                  }
                  // 从 start 事件提取 goal
                  if (evt.type === 'start' && evt.message) {
                    delegateGroups[gIdx].goal = evt.message
                  }
                  // 更新分组状态
                  if (evt.type === 'done') {
                    delegateGroups[gIdx].status = 'completed'
                  } else if (evt.type === 'error') {
                    delegateGroups[gIdx].status = 'failed'
                  }
                  // 追加嵌套事件
                  delegateGroups[gIdx].events.push({
                    type: evt.type || 'unknown',
                    content: evt.content || '',
                    message: evt.message || '',
                    tool_name: evt.tool_name || '',
                    tool_call_id: evt.tool_call_id || '',
                    result: evt.result ?? null,
                  })
                  flush({ delegateGroups: [...delegateGroups] })
                  break
                }
                case 'log':
                  logs.push(data.log)
                  break
                case 'done':
                  if (data.content) {
                    fullText = data.content
                    scheduleStreamUpdate(fullText)
                  }
                  if (data.usage) {
                    setTokenUsage(data.usage)
                  }
                  flush({
                    reply: fullText,
                    thinking: pendingThinkingRef.current,
                    streaming: false,
                    tokenUsage: data.usage || null,
                    logs: [...logs],
                    toolCalls: toolCalls.map((tc) => ({
                      ...tc,
                      result: toolResultStore.get(tc.call_id) ?? null,
                    })),
                  })
                  break
                case 'error':
                  setTestError(data.message || '测试失败')
                  flush({ streaming: false, logs: [...logs] })
                  break
                default:
                  // 忽略未知事件类型（skill_interrupt 等暂不专门处理）
                  break
              }
            } catch {
              // 忽略 JSON 解析错误
            }
          }
        }
    } catch (err) {
      setTestError(err.message || '测试失败')
    } finally {
      setTesting(false)
    }
  }

  // 测试完成后自动保存历史 + 计算耗时
  useEffect(() => {
    if (testResult && testResult.streaming === false && testStartTime && !testing) {
      const dur = Date.now() - testStartTime
      setTestDuration(dur)
      saveToHistory(testInput, testResult, testResult.tokenUsage, dur)
      setTestStartTime(null)
    }
  }, [testResult, testStartTime, testing])

  // 切换 delegate 分组的展开/折叠状态（按 subagent_id 查找）
  const toggleDelegateGroup = (subagentId) => {
    setTestResult((prev) => {
      if (!prev || !prev.delegateGroups) return prev
      return {
        ...prev,
        delegateGroups: prev.delegateGroups.map((g) =>
          g.subagent_id === subagentId ? { ...g, expanded: !g.expanded } : g
        ),
      }
    })
  }

  // 全部展开/折叠 delegate 分组
  const toggleAllDelegates = (expanded) => {
    setTestResult((prev) => {
      if (!prev || !prev.delegateGroups) return prev
      return {
        ...prev,
        delegateGroups: prev.delegateGroups.map((g) => ({ ...g, expanded })),
      }
    })
  }

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
        加载中...
      </div>
    )
  }

  // 资源级 owner 控制：新建允许编辑；已存在资源按 can_edit 标志
  const canEdit = !isEdit || canEditResource(agentMeta)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => navigate('/studio')} className="btn-secondary btn-sm">
            ← 返回工作室
          </button>
          <h1 className="text-xl font-semibold">{isEdit ? '编辑智能体' : '新建智能体'}</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md border border-border bg-secondary p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setEditorModePersist('simple')}
              className={`rounded px-2.5 py-1 transition ${editorMode === 'simple' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              简单
            </button>
            <button
              type="button"
              onClick={() => setEditorModePersist('advanced')}
              className={`rounded px-2.5 py-1 transition ${editorMode === 'advanced' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              高级
            </button>
          </div>
          {isEdit && canEdit && editorMode === 'advanced' && (
            <button
              type="button"
              onClick={handlePublishTemplate}
              className="btn-secondary btn-sm inline-flex items-center gap-1"
              title="发布到团队模板库，供新建时选用"
            >
              <Rocket className="h-3.5 w-3.5" />
              发布为模板
            </button>
          )}
          {isEdit && canEdit && !isAgentPublished(form) && (
            <button
              type="button"
              onClick={async () => {
                const saved = await handleSave(true)
                const aid = saved?.id || id
                if (!aid) return
                try {
                  const res = await agentsApi.publish(aid)
                  setForm((prev) => ({
                    ...prev,
                    name: res.name || prev.name,
                    description: res.description || prev.description,
                    publish_status: 'published',
                    variables: res.variables || prev.variables,
                  }))
                  toast.success('已发布，可在对话中使用')
                } catch (err) {
                  toast.error(err.message || '发布失败')
                }
              }}
              className="btn-primary btn-sm"
            >
              发布
            </button>
          )}
          <button
            type="button"
            onClick={() => handleSave(false)}
            disabled={saving || !canEdit}
            title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}
            className={isAgentPublished(form) ? 'btn-primary' : 'btn-secondary'}
          >
            {saving ? '保存中…' : '保存草稿'}
          </button>
        </div>
      </header>

      {/* 左右分栏：左侧6模块配置 + 右侧调试预览 */}
      <div className="flex min-h-0 flex-1">
        {/* ===== 左侧：6模块配置 ===== */}
        <div className="w-1/2 min-w-0 overflow-y-auto border-r border-border p-6">
          {error && (
            <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* 配置摘要条：一眼看清当前配置 */}
          <div className={`mb-4 rounded-lg border px-4 py-2.5 text-xs ${
            configSummary.issues.length > 0
              ? 'border-warning/40 bg-warning/10'
              : 'border-emerald-500/30 bg-emerald-500/5'
          }`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Database className="h-3.5 w-3.5" /> 知识库 <span className="font-semibold text-foreground">{configSummary.kbs}</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Wrench className="h-3.5 w-3.5" /> 工具 <span className="font-semibold text-foreground">{configSummary.tools}</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <FolderKanban className="h-3.5 w-3.5" /> 工作流 <span className="font-semibold text-foreground">{configSummary.workflows}</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Zap className="h-3.5 w-3.5" /> 技能 <span className="font-semibold text-foreground">{configSummary.skills}</span>
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {configSummary.issues.length > 0 ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                    <span className="text-warning">{configSummary.issues.join('、')}</span>
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">配置完整，可调试</span>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {editorMode === 'simple' && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">简单模式</span>
                ：仅显示名称、模型、角色与能力四块。需要记忆/引擎/tool_configs 等请切换到
                <button type="button" onClick={() => setEditorModePersist('advanced')} className="mx-1 text-primary underline">高级</button>
                。
              </div>
            )}

            {/* 四步向导（高级模式） */}
            {editorMode === 'advanced' && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">配置向导</span>
                <span className="text-[10px] text-muted-foreground">每步可保存草稿，右侧随时调试</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WIZARD_STEPS.map((step, idx) => {
                  const active = wizardStep === step.id
                  const done = WIZARD_STEPS.findIndex((s) => s.id === wizardStep) > idx
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => goWizardStep(step.id)}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition ${
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : done
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15'
                            : 'bg-secondary text-muted-foreground hover:bg-secondary hover:text-foreground'
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                        active ? 'bg-primary-foreground' : 'bg-background'
                      }`}>
                        {idx + 1}
                      </span>
                      {step.label}
                    </button>
                  )
                })}
              </div>
            </div>
            )}

            {/* 工具栏：搜索 + 展开/收起 */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={sectionSearch}
                  onChange={(e) => setSectionSearch(e.target.value)}
                  placeholder="搜索配置项…"
                  className="h-8 w-full rounded-md border border-border bg-secondary pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
                {sectionSearch && (
                  <button
                    type="button"
                    onClick={() => setSectionSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setAllCards(true)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                展开全部
              </button>
              <button
                type="button"
                onClick={() => setAllCards(false)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                收起全部
              </button>
            </div>

            {/* 模块一：基础信息与形象 */}
            {wizardShows('基础信息与形象') && (
            <Card title="基础信息与形象" icon={<User className="h-4 w-4" />} status={sectionStatus.basic} open={sectionOpen('基础信息与形象')} onToggle={toggleCard('基础信息与形象')}>
              <TextInput label="智能体名称" value={form.name} onChange={setField('name')} placeholder="如：告警研判智能体" required maxLength={50} hint="2-50 字符" />
              <TextInput label="头像 URL" value={form.avatar} onChange={setField('avatar')} placeholder="https://example.com/avatar.png（可选）" hint="支持 PNG/JPG/SVG/WEBP，建议尺寸 128×128，留空则使用默认头像" />
              <TextInput label="简介" value={form.description} onChange={setField('description')} placeholder="对外展示的功能描述" maxLength={500} />
              <TextArea label="开场白" value={form.greeting} onChange={setField('greeting')} rows={3} maxLength={500} placeholder="用户与 Agent 开启对话时自动发送的第一条消息（支持 Markdown）" />
              {form.greeting && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary/70">
                    <MessageSquare className="h-3 w-3" /> 开场白预览
                  </div>
                  <div className="whitespace-pre-wrap break-words rounded-lg bg-background px-3 py-2 text-sm leading-relaxed text-foreground">
                    {form.greeting}
                  </div>
                </div>
              )}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">开场引导问题</div>
                <SuggestedQuestionsEditor
                  value={form.suggested_questions}
                  onChange={setField('suggested_questions')}
                />
              </div>
            </Card>
            )}

            {/* 模块二：核心人设与提示词 */}
            {wizardShows('核心人设与提示词') && (
            <Card title="核心人设与提示词" icon={<Brain className="h-4 w-4" />} defaultOpen={false} status={sectionStatus.prompt} open={sectionOpen('核心人设与提示词')} onToggle={toggleCard('核心人设与提示词')}>
              <TextArea
                label="System Prompt"
                value={form.system_prompt}
                onChange={setField('system_prompt')}
                rows={6}
                maxLength={4000}
                placeholder="你是一名 SOC 高级安全专家。接收到告警后，请利用工具查询源 IP 的白名单状态、资产归属、网段和威胁情报……"
                hint="定义智能体的角色、能力边界和行为规范。支持 {{变量名}} 引用下方变量配置的值"
              />
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  变量配置
                  <InfoTip text={<>在提示词中用 <code className="rounded bg-secondary px-1 text-primary">{'{{key}}'}</code> 引用变量值</>} />
                </div>
                {varRows.map((row, idx) => (
                  <div key={idx} className="mb-1 flex items-center gap-1.5">
                    <input
                      className={`${inputCls} flex-1`}
                      placeholder="变量名"
                      value={row.key}
                      onChange={(e) => updateVarRow(idx, e.target.value, row.value)}
                    />
                    <input
                      className={`${inputCls} flex-1`}
                      placeholder="变量值"
                      value={row.value}
                      onChange={(e) => updateVarRow(idx, row.key, e.target.value)}
                    />
                    {varRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = varRows.filter((_, i) => i !== idx)
                          setVarRows(next)
                          const varObj = {}
                          next.forEach((r) => { if (r.key.trim()) varObj[r.key.trim()] = r.value })
                          setForm((prev) => ({ ...prev, variables: varObj }))
                          setDirty(true)
                        }}
                        className="flex shrink-0 items-center rounded border border-border px-1.5 py-1 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setVarRows([...varRows, { key: '', value: '' }])}
                  className="text-[11px] text-primary hover:text-primary"
                >
                  + 添加变量
                </button>
              </div>
            </Card>
            )}

            {/* 模块三：模型与参数设置 */}
            {wizardShows('模型与参数设置') && (
            <Card title="模型与参数设置" icon={<Settings className="h-4 w-4" />} defaultOpen={false} status={sectionStatus.model} open={sectionOpen('模型与参数设置')} onToggle={toggleCard('模型与参数设置')}>
              <SelectInput
                label="大语言模型 LLM"
                value={form.model_config_id}
                onChange={setField('model_config_id')}
                options={[
                  { value: '', label: '请选择…' },
                  ...llmOptions.map((l) => ({
                    value: String(l.id),
                    label: `${l.name || `#${l.id}`}（${l.provider || '-'} / ${l.model_name || '-'}）`,
                  })),
                ]}
              />
              <div className="grid grid-cols-3 gap-2">
                <NumberInput label="温度" value={form.temperature} onChange={setField('temperature')} min={0} max={2} step={0.1} hint="0=确定，2=发散" />
                <NumberInput label="Max Tokens" value={form.max_tokens} onChange={setField('max_tokens')} min={1} max={8192} />
                <NumberInput label="上下文轮数" value={form.context_turns} onChange={setField('context_turns')} min={1} max={50} />
              </div>
            </Card>
            )}

            {/* 模块四：能力配置（合并知识库/工具/技能/资产，Tab 切换） */}
            {wizardShows('能力配置') && (
            <Card
              title="能力配置"
              icon={<Wrench className="h-4 w-4" />}
              defaultOpen={false}
              hint="工作流勾选后会作为独立工具供智能体调用。"
              status={sectionStatus.tools}
              open={sectionOpen('能力配置')}
              onToggle={toggleCard('能力配置')}
              extra={
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">标准</span>
                  <button
                    type="button"
                    onClick={() => setDevMode((d) => !d)}
                    className={`relative h-4 w-8 rounded-full transition ${devMode ? 'bg-primary' : 'bg-secondary'}`}
                  >
                    <span
                      className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${devMode ? 'left-4' : 'left-0.5'}`}
                    />
                  </button>
                  <span className="text-[10px] text-muted-foreground">开发者</span>
                </div>
              }
            >
              {/* 已选能力 chips（顶部展示，可一键移除） */}
              {(form.enabled_tools.length > 0 || form.enabled_kbs.length > 0 || form.enabled_skills.length > 0 || form.enabled_workflows.length > 0) && (
                <div className="mb-3 rounded-md border border-border bg-muted p-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">已选能力</div>
                  <div className="flex flex-wrap gap-1.5">
                    {form.enabled_tools.map((tv) => {
                      const t = toolOptions.find((x) => x.value === tv)
                      const isSensitive = /send|email|delete|block|ban|exec|shutdown|reboot/i.test(tv)
                      return (
                        <span key={`t-${tv}`} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${isSensitive ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/10 text-primary'}`}>
                          <Wrench className="h-2.5 w-2.5" />
                          {t?.label || tv}
                          <button type="button" onClick={() => setField('enabled_tools')(form.enabled_tools.filter((x) => x !== tv))} className="ml-0.5 hover:text-foreground">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      )
                    })}
                    {form.enabled_kbs.map((kv) => {
                      const k = kbOptions.find((x) => x.value === kv)
                      return (
                        <span key={`k-${kv}`} className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                          <Database className="h-2.5 w-2.5" />
                          {k?.label || `KB#${kv}`}
                          <button type="button" onClick={() => setField('enabled_kbs')(form.enabled_kbs.filter((x) => x !== kv))} className="ml-0.5 hover:text-foreground">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      )
                    })}
                    {form.enabled_skills.map((sv) => {
                      const s = skillOptions.find((x) => x.value === sv)
                      return (
                        <span key={`s-${sv}`} className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                          <Zap className="h-2.5 w-2.5" />
                          {s?.label || `技能#${sv}`}
                          <button type="button" onClick={() => setField('enabled_skills')(form.enabled_skills.filter((x) => x !== sv))} className="ml-0.5 hover:text-foreground">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      )
                    })}
                    {form.enabled_workflows.map((wv) => {
                      const w = workflowOptions.find((x) => x.value === wv)
                      return (
                        <span key={`w-${wv}`} className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-400">
                          <FolderKanban className="h-2.5 w-2.5" />
                          {w?.label || `工作流#${wv}`}
                          <button type="button" onClick={() => setField('enabled_workflows')(form.enabled_workflows.filter((x) => x !== wv))} className="ml-0.5 hover:text-foreground">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 全局搜索框 */}
              <div className="relative mb-3">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={abilitySearch}
                  onChange={(e) => setAbilitySearch(e.target.value)}
                  placeholder="搜索工具、工作流、技能、知识库…"
                  className="h-8 w-full rounded-md border border-border bg-secondary pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
                {abilitySearch && (
                  <button type="button" onClick={() => setAbilitySearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* 搜索结果模式：跨类型展示 */}
              {abilitySearchResults ? (
                <div className="flex flex-col gap-3">
                  {abilitySearchResults.tools.length === 0 && abilitySearchResults.kbs.length === 0 && abilitySearchResults.skills.length === 0 && abilitySearchResults.workflows.length === 0 ? (
                    <p className="py-4 text-center text-[11px] text-muted-foreground">未找到匹配项</p>
                  ) : (
                    <>
                      {abilitySearchResults.kbs.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">知识库 ({abilitySearchResults.kbs.length})</div>
                          <CheckboxGroup value={form.enabled_kbs} onChange={setField('enabled_kbs')} options={abilitySearchResults.kbs} columns={2} />
                        </div>
                      )}
                      {abilitySearchResults.tools.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold text-primary">工具 ({abilitySearchResults.tools.length})</div>
                          <CheckboxGroup value={form.enabled_tools} onChange={setField('enabled_tools')} options={abilitySearchResults.tools} columns={2} />
                        </div>
                      )}
                      {abilitySearchResults.skills.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">技能 ({abilitySearchResults.skills.length})</div>
                          <CheckboxGroup value={form.enabled_skills} onChange={setField('enabled_skills')} options={abilitySearchResults.skills} columns={2} />
                        </div>
                      )}
                      {abilitySearchResults.workflows.length > 0 && (
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold text-cyan-600 dark:text-cyan-400">工作流 ({abilitySearchResults.workflows.length})</div>
                          <CheckboxGroup value={form.enabled_workflows} onChange={setField('enabled_workflows')} options={abilitySearchResults.workflows} columns={2} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <>
                  {/* Tab 切换：知识库 / 工具 / 技能 */}
                  <div className="mb-3 flex items-center gap-1 border-b border-border pb-2">
                    {[
                      { v: 'tools', label: '工具', icon: Wrench, count: form.enabled_tools.length, total: toolOptions.length },
                      { v: 'workflows', label: '工作流', icon: FolderKanban, count: form.enabled_workflows.length, total: workflowOptions.length },
                      { v: 'skills', label: '技能', icon: Zap, count: form.enabled_skills.length, total: skillOptions.length },
                      { v: 'knowledge', label: '知识库', icon: Database, count: form.enabled_kbs.length, total: kbOptions.length },
                    ].map((t) => {
                      const Icon = t.icon
                      return (
                        <button
                          key={t.v}
                          type="button"
                          onClick={() => setAbilityTab(t.v)}
                          className={`flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition ${
                            abilityTab === t.v
                              ? 'border-primary text-primary'
                              : 'border-transparent text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {t.label}
                          <span className={`rounded px-1 text-[10px] ${t.count > 0 ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                            {t.count}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {/* ===== 工具 Tab ===== */}
                  {abilityTab === 'tools' && (
                    <div>
                      {editorMode === 'simple' && !browseAllTools && !abilitySearch && !devMode && (
                        <div className="mb-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                          <p className="mb-2 text-xs text-muted-foreground">
                            {appliedTemplate?.tool_guide || '以下为当前已挂载的工具。按模板创建时已自动选好，一般无需改动。'}
                          </p>
                          {simpleToolOptions.length === 0 ? (
                            <p className="text-xs text-muted-foreground">尚未挂载工具，请使用模板创建或展开全部工具添加。</p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {simpleToolOptions.map((tool) => {
                                const on = form.enabled_tools.includes(tool.value)
                                return (
                                  <label
                                    key={tool.value}
                                    className={`flex cursor-pointer gap-2 rounded-md border bg-background px-3 py-2 ${
                                      on ? 'border-primary/40' : 'border-border'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={() => {
                                        const next = on
                                          ? form.enabled_tools.filter((x) => x !== tool.value)
                                          : [...form.enabled_tools, tool.value]
                                        setField('enabled_tools')(next)
                                      }}
                                      className="mt-0.5 h-4 w-4 accent-primary"
                                    />
                                    <div>
                                      <div className="text-sm font-medium">{tool.label}</div>
                                      {(templateToolHints[tool.value] || tool.description) && (
                                        <div className="text-[11px] text-muted-foreground">
                                          {templateToolHints[tool.value] || (tool.description || '').slice(0, 100)}
                                        </div>
                                      )}
                                    </div>
                                  </label>
                                )
                              })}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => setBrowseAllTools(true)}
                            className="mt-3 text-[11px] text-primary underline"
                          >
                            需要其他工具？浏览全部（{toolOptions.length} 个）
                          </button>
                        </div>
                      )}

                      {(editorMode !== 'simple' || browseAllTools || abilitySearch || devMode) && (
                      <>
                      {/* 工具子工具栏：只看已选 + 展开/折叠全部 */}
                      <div className="mb-2 flex items-center gap-2">
                        {editorMode === 'simple' && browseAllTools && (
                          <button
                            type="button"
                            onClick={() => setBrowseAllTools(false)}
                            className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                          >
                            ← 返回推荐工具
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setOnlySelectedTools((v) => !v)}
                          className={`rounded border px-2 py-0.5 text-[10px] transition ${onlySelectedTools ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                        >
                          {onlySelectedTools ? '✓ ' : ''}只看已选
                        </button>
                        <button
                          type="button"
                          onClick={() => setCollapsedGroups({})}
                          className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          展开全部
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const all = {}
                            groupedTools.forEach((g) => { all[g.category] = true })
                            setCollapsedGroups(all)
                          }}
                          className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          折叠全部
                        </button>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          已选 {form.enabled_tools.length} / {toolOptions.length}
                        </span>
                      </div>

                      {toolOptions.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-muted-foreground">暂无可用工具</p>
                      ) : filteredGroupedTools.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-muted-foreground">
                          {onlySelectedTools ? '未选中任何工具' : '未匹配到工具'}
                        </p>
                      ) : !devMode ? (
                        /* 标准模式：卡片式工具项（含描述 + 危险标记） */
                        <div className="flex flex-col gap-2">
                          {filteredGroupedTools.map((grp) => {
                            const grpCollapsed = collapsedGroups[grp.category]
                            const selectedInGrp = grp.tools.filter((t) => form.enabled_tools.includes(t.value)).length
                            const GrpIcon = CATEGORY_ICON_MAP[grp.meta.icon] || Package
                            return (
                              <div key={grp.category} className="rounded-md border border-border">
                                <button
                                  type="button"
                                  onClick={() => setCollapsedGroups((c) => ({ ...c, [grp.category]: !c[grp.category] }))}
                                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
                                >
                                  {grpCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                                  <GrpIcon className="h-3.5 w-3.5 text-primary" />
                                  <span className="text-[11px] font-semibold text-muted-foreground">{grp.meta.label}</span>
                                  <span className={`rounded px-1 text-[10px] ${selectedInGrp > 0 ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                                    {selectedInGrp}/{grp.tools.length}
                                  </span>
                                </button>
                                {!grpCollapsed && (
                                  <div className="flex flex-col gap-1.5 border-t border-border p-1.5">
                                    {grp.tools.map((tool) => {
                                      const enabled = form.enabled_tools.includes(tool.value)
                                      const isSensitive = /send|email|delete|block|ban|exec|shutdown|reboot/i.test(tool.value)
                                      const isHttp = tool.tool_type === 'http'
                                      const isFramework = tool.tool_type === 'framework'
                                      const tagColor = isFramework ? 'purple' : isHttp ? 'blue' : isSensitive ? 'red' : 'default'
                                      return (
                                        <div
                                          key={tool.value}
                                          className={`flex items-start gap-2 rounded-md border p-2 transition ${
                                            enabled
                                              ? isSensitive
                                                ? 'border-destructive/30 bg-destructive/5'
                                                : 'border-primary/30 bg-primary/5'
                                              : 'border-border bg-muted hover:border-primary/30'
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={enabled}
                                            onChange={(e) => {
                                              const next = e.target.checked
                                                ? [...form.enabled_tools, tool.value]
                                                : form.enabled_tools.filter((t) => t !== tool.value)
                                              setField('enabled_tools')(next)
                                            }}
                                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                                          />
                                          <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className="truncate text-xs font-medium text-foreground" title={tool.label}>{tool.label}</span>
                                              {isFramework && <span className="shrink-0 rounded bg-purple-500/15 px-1 py-0.5 text-[9px] text-purple-500">◈ 框架</span>}
                                              {isHttp && <span className="shrink-0 rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-500">⇄ HTTP</span>}
                                              {isSensitive && <span className="shrink-0 rounded bg-destructive/15 px-1 py-0.5 text-[9px] text-destructive">⚠ 危险</span>}
                                            </div>
                                            {tool.description && (
                                              <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={tool.description}>
                                                {tool.description}
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        /* 开发者模式：保留原有增强配置面板 */
                        <div className="flex flex-col gap-3">
                          {filteredGroupedTools.map((grp) => {
                            const grpCollapsed = collapsedGroups[grp.category]
                            const selectedInGrp = grp.tools.filter((t) => form.enabled_tools.includes(t.value)).length
                            const GrpIcon = CATEGORY_ICON_MAP[grp.meta.icon] || Package
                            return (
                              <div key={grp.category} className="rounded-md border border-border">
                                <button
                                  type="button"
                                  onClick={() => setCollapsedGroups((c) => ({ ...c, [grp.category]: !c[grp.category] }))}
                                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
                                >
                                  {grpCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                                  <GrpIcon className="h-3.5 w-3.5 text-primary" />
                                  <span className="text-[11px] font-semibold text-muted-foreground">{grp.meta.label}</span>
                                  <span className={`rounded px-1 text-[10px] ${selectedInGrp > 0 ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                                    {selectedInGrp}/{grp.tools.length}
                                  </span>
                                </button>
                                {!grpCollapsed && (
                                  <div className="flex flex-col gap-1.5 border-t border-border p-1.5">
                                    {grp.tools.map((tool) => {
                                      const enabled = form.enabled_tools.includes(tool.value)
                                      const cfg = form.tool_configs[tool.value] || {}
                                      const isExpanded = expandedTool === tool.value
                                      const isSensitive = /send|email|delete|block|ban|exec|shutdown|reboot/i.test(tool.value)
                                      return (
                                        <div key={tool.value} className={`rounded-md border ${enabled ? 'border-border' : 'border-border'} ${isSensitive && enabled ? 'bg-destructive/5' : 'bg-muted'}`}>
                                          <div className="flex items-center gap-2 px-2 py-1.5">
                                            <input
                                              type="checkbox"
                                              checked={enabled}
                                              onChange={(e) => {
                                                const next = e.target.checked
                                                  ? [...form.enabled_tools, tool.value]
                                                  : form.enabled_tools.filter((t) => t !== tool.value)
                                                setField('enabled_tools')(next)
                                                if (!next) setExpandedTool(null)
                                              }}
                                              className="h-4 w-4 accent-primary"
                                            />
                                            <span className="flex-1 truncate text-xs text-muted-foreground" title={tool.description}>{tool.label}</span>
                                            {isSensitive && enabled && (
                                              <span className="inline-flex items-center gap-1 rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                                                <AlertTriangle className="h-3 w-3" /> 敏感
                                              </span>
                                            )}
                                            {enabled && (
                                              <button
                                                type="button"
                                                onClick={() => setExpandedTool(isExpanded ? null : tool.value)}
                                                className="text-[10px] text-primary hover:text-primary"
                                              >
                                                {isExpanded ? '收起' : '配置'}
                                              </button>
                                            )}
                                          </div>
                                          {enabled && isExpanded && (
                                            <div className="grid grid-cols-3 gap-2 border-t border-border p-2">
                                              <label>
                                                <div className="mb-0.5 text-[10px] text-muted-foreground">超时（秒）</div>
                                                <input
                                                  type="number"
                                                  className={inputCls}
                                                  value={cfg.timeout ?? 10}
                                                  onChange={(e) => {
                                                    const next = { ...form.tool_configs }
                                                    next[tool.value] = { ...next[tool.value], timeout: Number(e.target.value) }
                                                    setField('tool_configs')(next)
                                                  }}
                                                  min={1}
                                                  max={120}
                                                />
                                              </label>
                                              <label>
                                                <div className="mb-0.5 text-[10px] text-muted-foreground">失败重试</div>
                                                <input
                                                  type="number"
                                                  className={inputCls}
                                                  value={cfg.retry ?? 0}
                                                  onChange={(e) => {
                                                    const next = { ...form.tool_configs }
                                                    next[tool.value] = { ...next[tool.value], retry: Number(e.target.value) }
                                                    setField('tool_configs')(next)
                                                  }}
                                                  min={0}
                                                  max={5}
                                                />
                                              </label>
                                              <label className="flex flex-col">
                                                <div className="mb-0.5 text-[10px] text-muted-foreground">执行模式</div>
                                                <CompactSelect
                                                  size="lg"
                                                  block
                                                  value={cfg.require_confirm ? 'confirm' : 'auto'}
                                                  onChange={(e) => {
                                                    const next = { ...form.tool_configs }
                                                    next[tool.value] = { ...next[tool.value], require_confirm: e.target.value === 'confirm' }
                                                    setField('tool_configs')(next)
                                                  }}
                                                >
                                                  <option value="auto">自动调用</option>
                                                  <option value="confirm">需用户确认</option>
                                                </CompactSelect>
                                              </label>
                                              {cfg.require_confirm && (
                                                <div className="col-span-3 flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1 text-[10px] text-warning">
                                                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                                  <span>此工具标记为"需用户确认"，Agent 调用前会暂停等待确认</span>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                      </>
                      )}
                    </div>
                  )}

                  {abilityTab === 'workflows' && (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">
                          勾选后，该工作流会作为独立工具挂到智能体上，模型按需调用
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          已选 {form.enabled_workflows.length} / {workflowOptions.length}
                        </span>
                      </div>
                      {workflowOptions.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-muted-foreground">暂无可用工作流，请先到「工作流」页面创建并启用</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-1.5">
                          {workflowOptions.map((wf) => {
                            const enabled = form.enabled_workflows.includes(wf.value)
                            return (
                              <label
                                key={wf.value}
                                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                                  enabled ? 'border-cyan-500/30 bg-cyan-500/5' : 'border-border bg-muted hover:border-cyan-500/30'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...form.enabled_workflows, wf.value]
                                      : form.enabled_workflows.filter((w) => w !== wf.value)
                                    setField('enabled_workflows')(next)
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                    <FolderKanban className="h-3.5 w-3.5 text-cyan-600 dark:text-cyan-400" />
                                    {wf.label}
                                    {wf.status && wf.status !== 'published' && (
                                      <span className="rounded bg-secondary px-1 text-[10px] text-muted-foreground">{wf.status}</span>
                                    )}
                                  </div>
                                  {wf.description ? (
                                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{wf.description}</p>
                                  ) : (
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">运行此工作流并返回结果</p>
                                  )}
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ===== 知识库 Tab ===== */}
                  {abilityTab === 'knowledge' && (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">
                          勾选后，智能体可检索该知识库中的文档分段
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          已选 {form.enabled_kbs.length} / {kbOptions.length}
                        </span>
                      </div>
                      {kbOptions.length === 0 ? (
                        <div className="rounded-md border border-dashed border-emerald-500/30 bg-emerald-500/5 p-4 text-center">
                          <p className="text-xs font-medium text-foreground">还没有知识库</p>
                          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                            ① 上传文档 → ② 自动分段/向量化 → ③ 在此勾选启用
                          </p>
                          <button
                            type="button"
                            onClick={() => { if (!guardNavPermission('knowledge_base', 'view', '知识库')) return; navigate('/knowledge-base') }}
                            className="mt-3 text-[11px] text-primary hover:underline"
                          >
                            前往知识库页面创建 →
                          </button>
                        </div>
                      ) : (
                        <>
                          {form.enabled_kbs.length === 0 && (
                            <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-muted-foreground">
                              未勾选知识库时，智能体无法检索文档。
                              <button type="button" onClick={() => { if (!guardNavPermission('knowledge_base', 'view', '知识库')) return; navigate('/knowledge-base') }} className="ml-1 text-primary hover:underline">
                                管理知识库
                              </button>
                            </div>
                          )}
                          <div className="grid grid-cols-1 gap-1.5">
                            {kbOptions.map((kb) => {
                              const enabled = form.enabled_kbs.includes(kb.value)
                              const updatedLabel = kb.updated_at
                                ? new Date(kb.updated_at).toLocaleString('zh-CN', { hour12: false })
                                : ''
                              return (
                                <label
                                  key={kb.value}
                                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                                    enabled ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-muted hover:border-emerald-500/30'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) => {
                                      const next = e.target.checked
                                        ? [...form.enabled_kbs, kb.value]
                                        : form.enabled_kbs.filter((k) => k !== kb.value)
                                      setField('enabled_kbs')(next)
                                    }}
                                    className="mt-0.5 h-4 w-4 accent-primary"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <Database className="h-3 w-3 shrink-0 text-emerald-500" />
                                      <span className="truncate text-xs font-medium text-foreground">{kb.label}</span>
                                    </div>
                                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                                      {kb.doc_count ?? 0} 篇文档
                                      {updatedLabel ? ` · 更新于 ${updatedLabel}` : ''}
                                    </div>
                                    {kb.description && (
                                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={kb.description}>
                                        {kb.description}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              )
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ===== 技能 Tab ===== */}
                  {abilityTab === 'skills' && (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">
                          选中的技能正文会拼接到 system prompt 末尾。Skill 只收说明文字，脚本请到工具库添加。
                          <InfoTip text={<>技能正文支持 <code className="rounded bg-secondary px-1 text-primary">{'{{key}}'}</code> 引用变量</>} />
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          已选 {form.enabled_skills.length} / {skillOptions.length}
                        </span>
                      </div>
                      <div className="mb-3 rounded-md border border-border bg-card p-2.5">
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-foreground">导入文本新建技能</span>
                          <div className="flex items-center gap-2 text-[11px]">
                            <button type="button" className="text-primary hover:underline" onClick={() => navigate('/skills')}>
                              技能库
                            </button>
                            <button type="button" className="text-primary hover:underline" onClick={() => navigate('/tools')}>
                              前往工具
                            </button>
                          </div>
                        </div>
                        <input
                          className={`${inputCls} mb-1.5`}
                          placeholder="技能名称"
                          value={skillDraftName}
                          onChange={(e) => setSkillDraftName(e.target.value)}
                        />
                        <textarea
                          className={`${textareaCls} mb-1.5 min-h-[88px]`}
                          placeholder="粘贴 SOP / 角色设定等纯文本"
                          value={skillDraftContent}
                          onChange={(e) => setSkillDraftContent(e.target.value)}
                        />
                        <input
                          ref={skillDraftFileRef}
                          type="file"
                          accept=".md,.txt,.json,.markdown"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            e.target.value = ''
                            if (!file) return
                            const ext = (file.name.split('.').pop() || '').toLowerCase()
                            if (['py', 'js', 'zip', 'skill', 'sh'].includes(ext)) {
                              toast.warning('脚本请到「工具」添加，Skill 只保存说明文字')
                              return
                            }
                            const text = await file.text()
                            if (!skillDraftName) setSkillDraftName(file.name.replace(/\.[^.]+$/, ''))
                            setSkillDraftContent(text)
                          }}
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="text-[11px] text-primary hover:underline"
                            onClick={() => skillDraftFileRef.current?.click()}
                          >
                            从文件导入正文
                          </button>
                          <button
                            type="button"
                            className="btn-primary btn-sm ml-auto"
                            disabled={skillDraftSaving}
                            onClick={async () => {
                              if (!skillDraftContent.trim()) {
                                toast.warning('请填写技能正文')
                                return
                              }
                              setSkillDraftSaving(true)
                              try {
                                const created = await skillsApi.create({
                                  name: (skillDraftName || '未命名技能').trim(),
                                  description: '',
                                  content: skillDraftContent.trim(),
                                  enabled: true,
                                })
                                const opt = {
                                  value: String(created.id),
                                  label: created.name,
                                  description: created.description || '',
                                }
                                setSkillOptions((prev) => [opt, ...prev.filter((s) => s.value !== opt.value)])
                                setField('enabled_skills')(
                                  form.enabled_skills.includes(opt.value)
                                    ? form.enabled_skills
                                    : [...form.enabled_skills, opt.value]
                                )
                                setSkillDraftName('')
                                setSkillDraftContent('')
                                toast.success(`已新增技能「${created.name}」并挂到当前智能体`)
                              } catch (err) {
                                toast.error(err.message || '新增技能失败')
                              } finally {
                                setSkillDraftSaving(false)
                              }
                            }}
                          >
                            {skillDraftSaving ? '创建中…' : '创建并勾选'}
                          </button>
                        </div>
                      </div>
                      {skillOptions.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-muted-foreground">暂无可用技能，可在上方导入文本，或到「技能」页面创建</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-1.5">
                          {skillOptions.map((sk) => {
                            const enabled = form.enabled_skills.includes(sk.value)
                            return (
                              <label
                                key={sk.value}
                                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                                  enabled ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-muted hover:border-amber-500/30'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...form.enabled_skills, sk.value]
                                      : form.enabled_skills.filter((s) => s !== sk.value)
                                    setField('enabled_skills')(next)
                                  }}
                                  className="mt-0.5 h-4 w-4 accent-primary"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <Zap className="h-3 w-3 shrink-0 text-amber-500" />
                                    <span className="truncate text-xs font-medium text-foreground">{sk.label}</span>
                                  </div>
                                  {sk.description && (
                                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={sk.description}>
                                      {sk.description}
                                    </div>
                                  )}
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </Card>
            )}

            {/* 模块五：记忆与高级机制 */}
            {wizardShows('记忆与高级机制') && (
            <Card title="记忆与高级机制" icon={<Puzzle className="h-4 w-4" />} defaultOpen={false} status={sectionStatus.memory} open={sectionOpen('记忆与高级机制')} onToggle={toggleCard('记忆与高级机制')}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enable_memory}
                  onChange={(e) => setField('enable_memory')(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="text-sm text-foreground">自动记住对话关键信息</span>
              </label>
              <p className="mt-0.5 pl-6 text-[11px] text-muted-foreground">
                开启后，智能体会自动提取并记住对话中的关键信息（如用户偏好、历史结论），便于多轮上下文理解
              </p>
              <SelectInput
                label="语气风格"
                value={form.tone_style}
                onChange={setField('tone_style')}
                options={TONE_STYLES}
              />
              {/* 语气风格示例预览 */}
              {(() => {
                const style = TONE_STYLES.find((s) => s.value === form.tone_style)
                if (!style || !style.example) return null
                return (
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary/70">示例预览</div>
                    <div className="text-sm text-foreground">{style.example}</div>
                  </div>
                )
              })()}
              <NumberInput
                label="最大迭代次数"
                value={form.max_iterations}
                onChange={setField('max_iterations')}
                min={1}
                max={20}
                hint="控制 Agent 最多思考/调用工具的轮次，防止无限循环。建议 3-10 轮"
              />
            </Card>
            )}

            {/* 高级选项：工具行为 / 中间件 / tool_search（默认折叠） */}
            {wizardShows('高级选项') && (
            <Card
              title="高级选项"
              icon={<Shield className="h-4 w-4" />}
              defaultOpen={false}
              hint="工具超时重试、守卫、渐进式披露等进阶配置，日常使用可保持默认"
              status={sectionStatus.security}
              open={sectionOpen('高级选项')}
              onToggle={toggleCard('高级选项')}
            >
              <p className="mb-3 text-[11px] text-muted-foreground">
                默认配置已覆盖大多数场景。仅在需要自定义工具行为、写操作验证或 tool_search 策略时再修改。
              </p>
              <MiddlewareConfig
                value={form.tool_configs}
                onChange={setField('tool_configs')}
              />
              <div className="mt-3 rounded-md border border-border bg-card p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">tool_configs 预览</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(form.tool_configs, null, 2))
                        toast.success('已复制配置 JSON')
                      }}
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      <Copy className="h-2.5 w-2.5" /> 复制
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(form.tool_configs, null, 2)], { type: 'application/json' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = `tool_configs_${form.name || 'agent'}.json`
                        a.click()
                        URL.revokeObjectURL(url)
                      }}
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      <Download className="h-2.5 w-2.5" /> 导出
                    </button>
                  </div>
                </div>
                <pre
                  className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[10px] leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: highlightJson(form.tool_configs) }}
                />
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">工具搜索（tool_search）</div>
                <ToolSearchStatus
                  agentId={form.id}
                  value={form.tool_configs}
                  onChange={setField('tool_configs')}
                />
              </div>
            </Card>
            )}

            {editorMode === 'advanced' && (
              <AgentDslPanel
                agentId={isEdit ? id : null}
                form={form}
                onApplyDsl={applyDslToForm}
                canEdit={canEdit}
              />
            )}
          </div>
        </div>

        {/* ===== 右侧：调试预览面板 ===== */}
        <div className="flex w-1/2 min-w-0 flex-col overflow-hidden">
          {/* 头部：标题 + 运行历史 */}
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <TestTube className="h-4 w-4" />
              <span>调试与预览</span>
            </div>
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              className={`flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] transition hover:bg-secondary hover:text-foreground ${showHistory ? 'text-primary' : 'text-muted-foreground'}`}
            >
              <History className="h-3 w-3" />
              运行历史{runHistory.length > 0 && ` (${runHistory.length})`}
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {/* 快捷测试用例 */}
            <div className="shrink-0">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">快捷测试用例</div>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_TEST_CASES.map((tc) => (
                  <button
                    key={tc.label}
                    type="button"
                    title={tc.desc}
                    onClick={() => setTestInput(tc.value)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                      testInput === tc.value
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border bg-secondary text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {tc.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 测试输入区 */}
            <div className="shrink-0">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">
                  测试输入（JSON 或纯文本）
                </label>
                {jsonError ? (
                  <span className="flex items-center gap-1 text-[11px] text-destructive">
                    <AlertCircle className="h-3 w-3" /> JSON 语法错误
                  </span>
                ) : (
                  (testInput.trim().startsWith('{') || testInput.trim().startsWith('[')) && (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-500">
                      <Code className="h-3 w-3" /> JSON 格式正确
                    </span>
                  )
                )}
              </div>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                rows={6}
                placeholder='输入测试 IP 或 JSON，例如 89.124.70.92 或 {"alert_type": "brute_force", ...}'
                className={`w-full resize-y rounded-md border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition hover:border-primary/50 ${
                  jsonError ? 'border-destructive/60' : 'border-border'
                }`}
              />
              {jsonError && (
                <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {jsonError}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {!isEdit && '新建模式：调试时将自动保存'}
                  {isEdit && dirty && '有未保存的修改，调试时将自动保存'}
                  {isEdit && !dirty && '可直接调试'}
                </span>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="rounded-md border border-primary bg-primary/20 px-4 py-1.5 text-sm font-medium text-primary transition hover:bg-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testing ? '运行中…' : <span className="inline-flex items-center gap-1"><Play className="inline h-3 w-3" /> 调试运行</span>}
                </button>
              </div>
            </div>

            {/* 运行历史（可折叠） */}
            {showHistory && (
              <div className="shrink-0 rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>最近 {runHistory.length} 次运行</span>
                  {runHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setRunHistory([])
                        try { localStorage.removeItem(historyKey) } catch { /* ignore */ }
                      }}
                      className="text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      清空
                    </button>
                  )}
                </div>
                {runHistory.length === 0 ? (
                  <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">暂无运行记录</div>
                ) : (
                  <div className="max-h-[200px] overflow-y-auto border-t border-border">
                    {runHistory.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setTestInput(h.input)
                          setShowHistory(false)
                        }}
                        className="block w-full border-b border-border px-3 py-2 text-left transition hover:bg-muted last:border-0"
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate font-mono text-[11px] text-foreground">{h.input.slice(0, 60)}</span>
                          <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{h.timestamp}</span>
                        </div>
                        {h.reply && (
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{h.reply.slice(0, 80)}…</div>
                        )}
                        <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                          {h.mode && <span>{h.mode}</span>}
                          {h.tokens && (
                            <span>入 {h.tokens.input_tokens ?? 0} · 出 {h.tokens.output_tokens ?? 0}</span>
                          )}
                          {h.duration != null && <span>{(h.duration / 1000).toFixed(2)}s</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {testError && (
              <div className="flex shrink-0 items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{testError}</span>
              </div>
            )}

            {testing && !testResult && (
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                智能体推理中，请稍候…
              </div>
            )}

            {/* ===== 结果展示（Tab 分区） ===== */}
            {testResult && (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Tab 栏 */}
                <div className="flex shrink-0 items-center gap-1 border-b border-border">
                  {[
                    { id: 'output', label: '输出结果', icon: <MessageSquare className="h-3.5 w-3.5" /> },
                    { id: 'logs', label: '执行日志', icon: <ClipboardList className="h-3.5 w-3.5" />, badge: (testResult.toolCalls?.length || 0) + (testResult.logs?.length || 0) + (testResult.messages?.length || 0) },
                    { id: 'token', label: 'Token', icon: <Zap className="h-3.5 w-3.5" />, show: !!(testResult.tokenUsage || tokenUsage) },
                    { id: 'time', label: '耗时', icon: <Timer className="h-3.5 w-3.5" />, show: !!(testDuration != null || testResult.duration != null) },
                  ].filter((t) => t.show !== false).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
                        activeTab === tab.id
                          ? 'border-primary text-primary'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                      {tab.badge > 0 && (
                        <span className="ml-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{tab.badge}</span>
                      )}
                    </button>
                  ))}
                  {/* 复制 / 导出按钮 */}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleCopyMarkdown}
                      disabled={!testResult.reply}
                      title="复制 Markdown"
                      className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                      {copied ? '已复制' : '复制'}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportJson}
                      title="导出 JSON"
                      className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                    >
                      <Download className="h-3 w-3" /> 导出
                    </button>
                  </div>
                </div>

                {/* Tab 内容 */}
                <div className="min-h-0 flex-1 overflow-y-auto py-3">
                  {/* ===== 输出结果 Tab ===== */}
                  {activeTab === 'output' && (
                    <div className="flex flex-col gap-3">
                      {/* 流式文本输出 */}
                      {testResult.reply !== undefined && (
                        <div className="rounded-lg border border-border bg-card p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              {testResult.mode === 'chat'
                                ? '对话回复'
                                : testResult.mode === 'hermes'
                                ? 'Hermes 回答'
                                : 'AI 回答'}
                            </span>
                            {testResult.streaming && (
                              <span className="flex items-center gap-1 text-[11px] text-primary">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                                生成中
                              </span>
                            )}
                          </div>
                          <div className="max-h-[400px] overflow-y-auto text-sm leading-relaxed text-foreground">
                            {testResult.streaming ? (
                              <div ref={streamReplyRef} className="whitespace-pre-wrap break-words" />
                            ) : (
                              <div className="whitespace-pre-wrap break-words">{testResult.reply || ''}</div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 思考过程 */}
                      {(testResult.thinking || testResult.streaming) && (
                        <details className="rounded-lg border border-border bg-card" open={!!testResult.streaming}>
                          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-muted-foreground">
                            <Brain className="h-4 w-4" />
                            思考过程
                          </summary>
                          <div className="max-h-[300px] overflow-y-auto border-t border-border p-3 text-[12px] leading-relaxed text-muted-foreground">
                            {testResult.streaming ? (
                              <div ref={streamThinkingRef} className="whitespace-pre-wrap break-words" />
                            ) : (
                              <div className="whitespace-pre-wrap break-words">{testResult.thinking || ''}</div>
                            )}
                          </div>
                        </details>
                      )}

                      {/* 决策结果 */}
                      {testResult.decision !== undefined && (
                        <div className="rounded-lg border border-border bg-card p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">决策结果</span>
                          </div>
                          <div className="flex flex-col gap-2">
                            {testResult.decision && (
                              <div className="flex items-center gap-2">
                                <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-semibold text-primary">
                                  {testResult.decision}
                                </span>
                                {testResult.target_ip && (
                                  <span className="font-mono text-xs text-muted-foreground">→ {testResult.target_ip}</span>
                                )}
                              </div>
                            )}
                            {testResult.reason && (
                              <div className="rounded border border-border bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
                                {testResult.reason}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ===== 执行日志 Tab ===== */}
                  {activeTab === 'logs' && (
                    <div className="flex flex-col gap-3">
                      {/* 工具调用 */}
                      {testResult.toolCalls && testResult.toolCalls.length > 0 && (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          <button
                            type="button"
                            onClick={() => setShowToolCalls((s) => !s)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:bg-muted"
                          >
                            <span className="flex items-center gap-1.5">
                              <Wrench className="h-4 w-4" />
                              工具调用（{testResult.toolCalls.length} 次）
                            </span>
                            <span className="text-muted-foreground">{showToolCalls ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                          </button>
                          {showToolCalls && (
                            <div className="max-h-[300px] overflow-y-auto border-t border-border p-2">
                              <ToolCallList toolCalls={testResult.toolCalls} />
                            </div>
                          )}
                        </div>
                      )}

                      {/* 子代理委派 */}
                      {testResult.delegateGroups && testResult.delegateGroups.length > 0 && (
                        <div className="overflow-hidden rounded-lg border border-primary/40 bg-primary/5">
                          <button
                            type="button"
                            onClick={() => setShowDelegates((s) => !s)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-primary transition hover:bg-primary/10"
                          >
                            <span className="flex items-center gap-1.5">
                              <GitBranch className="h-4 w-4" />
                              子代理委派（{testResult.delegateGroups.length} 个子代理）
                            </span>
                            <span className="text-muted-foreground">{showDelegates ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                          </button>
                          {showDelegates && (
                            <div className="max-h-[400px] overflow-y-auto border-t border-primary/30 p-2">
                              <DelegateEventTree
                                groups={testResult.delegateGroups}
                                onToggle={toggleDelegateGroup}
                                onToggleAll={toggleAllDelegates}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* 推理过程 */}
                      {testResult.messages && testResult.messages.length > 0 && (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          <button
                            type="button"
                            onClick={() => setShowMessages((s) => !s)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:bg-muted"
                          >
                            <span>推理过程（{testResult.messages.length} 条消息）</span>
                            <span className="text-muted-foreground">{showMessages ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                          </button>
                          {showMessages && (
                            <div className="max-h-[300px] overflow-y-auto border-t border-border p-2">
                              {testResult.messages.map((msg, idx) => <MessageItem key={idx} msg={msg} idx={idx} />)}
                            </div>
                          )}
                        </div>
                      )}

                      {/* 执行日志 */}
                      {testResult.logs && testResult.logs.length > 0 ? (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          <button
                            type="button"
                            onClick={() => setShowLogs((s) => !s)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:bg-muted"
                          >
                            <span>执行日志（{testResult.logs.length} 条）</span>
                            <span className="text-muted-foreground">{showLogs ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
                          </button>
                          {showLogs && (
                            <div className="max-h-[200px] overflow-y-auto border-t border-border p-2 font-mono text-[11px]">
                              {testResult.logs.map((log, idx) => (
                                <div key={idx} className="border-b border-border py-1 last:border-0">
                                  <span className="text-muted-foreground">[{log.level || log.type || 'INFO'}]</span>{' '}
                                  <span className="text-muted-foreground">{log.message || log.msg || JSON.stringify(log)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        (!testResult.toolCalls || testResult.toolCalls.length === 0) &&
                        (!testResult.delegateGroups || testResult.delegateGroups.length === 0) &&
                        (!testResult.messages || testResult.messages.length === 0) && (
                          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                            暂无执行日志
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {/* ===== Token 消耗 Tab ===== */}
                  {activeTab === 'token' && (
                    <div className="flex flex-col gap-3">
                      {(() => {
                        const usage = testResult.tokenUsage || tokenUsage
                        if (!usage) {
                          return (
                            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                              暂无 Token 消耗数据
                            </div>
                          )
                        }
                        const total = usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
                        const inputPct = total > 0 ? Math.round((usage.input_tokens / total) * 100) : 0
                        const outputPct = total > 0 ? 100 - inputPct : 0
                        return (
                          <div className="flex flex-col gap-3">
                            <div className="grid grid-cols-3 gap-2">
                              <div className="rounded-lg border border-border bg-card p-3 text-center">
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">输入</div>
                                <div className="mt-1 text-xl font-bold text-info">{usage.input_tokens ?? 0}</div>
                                <div className="text-[10px] text-muted-foreground">tokens</div>
                              </div>
                              <div className="rounded-lg border border-border bg-card p-3 text-center">
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">输出</div>
                                <div className="mt-1 text-xl font-bold text-success">{usage.output_tokens ?? 0}</div>
                                <div className="text-[10px] text-muted-foreground">tokens</div>
                              </div>
                              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-center">
                                <div className="text-[10px] uppercase tracking-wider text-primary/70">总计</div>
                                <div className="mt-1 text-xl font-bold text-primary">{total}</div>
                                <div className="text-[10px] text-muted-foreground">tokens</div>
                              </div>
                            </div>
                            <div className="rounded-lg border border-border bg-card p-3">
                              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                                <span className="text-info">输入 {inputPct}%</span>
                                <span className="text-success">输出 {outputPct}%</span>
                              </div>
                              <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
                                <div className="bg-info/60" style={{ width: `${inputPct}%` }} />
                                <div className="bg-success/60" style={{ width: `${outputPct}%` }} />
                              </div>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  )}

                  {/* ===== 耗时 Tab ===== */}
                  {activeTab === 'time' && (
                    <div className="flex flex-col gap-3">
                      {(() => {
                        const dur = testDuration ?? testResult.duration
                        if (dur == null) {
                          return (
                            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                              暂无耗时数据
                            </div>
                          )
                        }
                        return (
                          <div className="flex flex-col gap-3">
                            <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-center">
                              <div className="text-[10px] uppercase tracking-wider text-primary/70">总耗时</div>
                              <div className="mt-1 text-3xl font-bold text-primary">
                                {(dur / 1000).toFixed(2)}<span className="text-lg">s</span>
                              </div>
                              <div className="mt-1 text-[11px] text-muted-foreground">{dur} ms</div>
                            </div>
                            {testResult.toolCalls && (
                              <div className="grid grid-cols-2 gap-2">
                                <div className="rounded-lg border border-border bg-card p-3 text-center">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">工具调用</div>
                                  <div className="mt-1 text-lg font-bold text-foreground">{testResult.toolCalls.length}</div>
                                  <div className="text-[10px] text-muted-foreground">次</div>
                                </div>
                                <div className="rounded-lg border border-border bg-card p-3 text-center">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">推理轮次</div>
                                  <div className="mt-1 text-lg font-bold text-foreground">{testResult.messages?.length || 0}</div>
                                  <div className="text-[10px] text-muted-foreground">条消息</div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 空状态 */}
            {!testResult && !testing && !testError && (
              <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground">
                <Bot className="mb-3 h-16 w-16 opacity-40" />
                <div className="text-sm font-medium">输入测试 IP 或 JSON，点击调试运行查看报告</div>
                <div className="mt-1 text-xs text-muted-foreground">智能体将使用当前配置进行推理，结果在此实时展示</div>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                  {QUICK_TEST_CASES.slice(0, 2).map((tc) => (
                    <button
                      key={tc.label}
                      type="button"
                      onClick={() => setTestInput(tc.value)}
                      className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
                    >
                      {tc.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// 开场引导问题编辑器（chip 列表：支持拖拽排序、内联编辑、删除）
function SuggestedQuestionsEditor({ value, onChange }) {
  const questions = Array.isArray(value) ? value.filter((q) => q) : []
  const [editingIdx, setEditingIdx] = useState(null)
  const [editText, setEditText] = useState('')
  const [newText, setNewText] = useState('')
  const [dragIdx, setDragIdx] = useState(null)

  const startEdit = (idx) => {
    setEditingIdx(idx)
    setEditText(questions[idx] || '')
  }
  const commitEdit = () => {
    if (editingIdx === null) return
    const trimmed = editText.trim()
    const next = [...questions]
    if (trimmed) {
      next[editingIdx] = trimmed
    } else {
      next.splice(editingIdx, 1)
    }
    onChange(next)
    setEditingIdx(null)
    setEditText('')
  }
  const addQuestion = () => {
    const trimmed = newText.trim()
    if (!trimmed) return
    onChange([...questions, trimmed])
    setNewText('')
  }
  const removeQuestion = (idx) => {
    onChange(questions.filter((_, i) => i !== idx))
  }
  const handleDragStart = (idx) => setDragIdx(idx)
  const handleDragOver = (e, idx) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const next = [...questions]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(idx, 0, moved)
    onChange(next)
    setDragIdx(idx)
  }
  const handleDragEnd = () => setDragIdx(null)

  return (
    <div className="flex flex-col gap-2">
      {questions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {questions.map((q, idx) => (
            <div
              key={idx}
              draggable={editingIdx !== idx}
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragEnd={handleDragEnd}
              className={`group flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition cursor-grab active:cursor-grabbing ${
                dragIdx === idx
                  ? 'border-primary bg-primary/20 text-primary opacity-50'
                  : 'border-border bg-secondary text-foreground hover:border-primary/50'
              }`}
            >
              {editingIdx === idx ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') { setEditingIdx(null); setEditText('') }
                  }}
                  className="w-32 bg-transparent text-xs outline-none"
                  maxLength={100}
                />
              ) : (
                <>
                  <span onClick={() => startEdit(idx)} className="cursor-text select-none">
                    {q}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeQuestion(idx)}
                    className="text-muted-foreground transition hover:text-destructive"
                    title="删除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {questions.length < 6 && (
        <div className="flex items-center gap-1.5">
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addQuestion() }}
            placeholder="输入引导问题，回车添加…"
            maxLength={100}
            className={`${inputCls} flex-1`}
          />
          <button
            type="button"
            onClick={addQuestion}
            disabled={!newText.trim()}
            className="shrink-0 rounded-md border border-primary/40 px-2.5 py-1.5 text-xs text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加
          </button>
        </div>
      )}
      {questions.length === 0 && (
        <p className="text-[11px] text-muted-foreground">输入问题后回车添加，拖拽 chip 可调整顺序，点击文字可编辑</p>
      )}
    </div>
  )
}

// 推理过程消息项
function MessageItem({ msg, idx }) {
  const [expanded, setExpanded] = useState(false)
  const role = msg.role || msg.type || 'unknown'
  const content = msg.content || msg.text || ''
  const isLong = content.length > 200

  const roleColors = {
    system: 'text-primary bg-primary/10',
    user: 'text-info bg-info/10',
    assistant: 'text-success bg-success/10',
    tool: 'text-warning bg-warning/10',
    function: 'text-warning bg-warning/10',
  }

  return (
    <div className="mb-2 rounded-md border border-border bg-muted">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${roleColors[role] || 'text-muted-foreground bg-secondary'}`}>
          {role}
        </span>
        {msg.name && <span className="font-mono text-[10px] text-muted-foreground">{msg.name}</span>}
        {isLong && (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="ml-auto text-[10px] text-primary hover:text-primary">
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      <div className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        {isLong && !expanded ? content.slice(0, 200) + '…' : content}
      </div>
    </div>
  )
}

// ============================================================================
// Hermes 引擎专属：工具调用列表
// 渲染 tool_start / tool_end 事件为时间线
// ============================================================================
function ToolCallList({ toolCalls }) {
  if (!toolCalls || toolCalls.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {toolCalls.map((tc, idx) => (
        <div
          key={tc.call_id || idx}
          className={`rounded-md border bg-muted px-2 py-1.5 ${
            tc.status === 'running'
              ? 'border-primary/40'
              : 'border-border'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="flex items-center">
              {tc.status === 'running'
                ? <Loader2 className="h-3 w-3 animate-spin text-warning" />
                : <Check className="h-3 w-3 text-success" />}
            </span>
            <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
              {tc.name}
            </span>
            {tc.status === 'running' && (
              <span className="flex items-center gap-1 text-[10px] text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                执行中
              </span>
            )}
          </div>
          {tc.message && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">{tc.message}</div>
          )}
          {tc.result !== null && tc.result !== undefined && (
            <ToolCallResult name={tc.name} result={tc.result} />
          )}
        </div>
      ))}
    </div>
  )
}

// 知识库检索命中摘要（调试可观测）
function KbHitSummary({ result }) {
  const hits = Array.isArray(result) ? result : (result?.matches || result?.segments || [])
  if (!hits.length) {
    return <p className="text-[10px] text-muted-foreground">未命中知识库片段</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] text-emerald-500">命中 {hits.length} 条片段</p>
      {hits.slice(0, 5).map((hit, i) => (
        <div key={i} className="rounded border border-emerald-500/20 bg-emerald-500/5 p-1.5">
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            {hit.kb_name && <span className="text-emerald-600 dark:text-emerald-400">[{hit.kb_name}]</span>}
            {hit.title && <span>{hit.title}</span>}
            {hit.score != null && <span>score={Number(hit.score).toFixed(3)}</span>}
            {hit.doc_id != null && <span>doc#{hit.doc_id}</span>}
          </div>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[10px] text-muted-foreground">
            {(hit.content || hit.text || '').slice(0, 200)}
          </p>
        </div>
      ))}
      {hits.length > 5 && (
        <p className="text-[10px] text-muted-foreground">另有 {hits.length - 5} 条未展示</p>
      )}
    </div>
  )
}

// 工具调用结果展示（长结果可折叠）
function ToolCallResult({ name, result }) {
  const [expanded, setExpanded] = useState(false)
  const isKbTool = name === 'search_knowledge_base' || name === 'query_kb_file'
  const text =
    typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2)
  const isLong = text.length > 300

  return (
    <div className="mt-1 rounded border border-border bg-card p-1.5">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">结果</span>
        {!isKbTool && isLong && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] text-primary hover:text-primary"
          >
            {expanded ? '收起' : `展开（${text.length} 字符）`}
          </button>
        )}
      </div>
      {isKbTool ? (
        <KbHitSummary result={result} />
      ) : (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
          {isLong && !expanded ? text.slice(0, 300) + '…' : text}
        </pre>
      )}
    </div>
  )
}

// ============================================================================
// Hermes 引擎专属：子代理委派事件树
// 按 subagent_id 分组，每个分组可折叠展开，展示嵌套事件流
// ============================================================================
// 子代理分组状态徽章
function DelegateStatusBadge({ status }) {
  const meta = {
    running: { label: '运行中', cls: 'bg-primary/15 text-primary' },
    completed: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-300' },
    failed: { label: '失败', cls: 'bg-destructive/15 text-destructive' },
  }
  const m = meta[status] || meta.running
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  )
}

// 单个嵌套事件渲染
function DelegateEventItem({ evt, idx }) {
  const [expanded, setExpanded] = useState(false)
  const iconMap = {
    start: <Rocket className="h-3.5 w-3.5" />,
    token: <MessageSquare className="h-3.5 w-3.5" />,
    tool_start: <Wrench className="h-3.5 w-3.5" />,
    tool_end: <Check className="h-3.5 w-3.5" />,
    done: <Flag className="h-3.5 w-3.5" />,
    error: <XCircle className="h-3.5 w-3.5" />,
    status: <ClipboardList className="h-3.5 w-3.5" />,
    log: <FileText className="h-3.5 w-3.5" />,
  }
  const icon = iconMap[evt.type] || <span className="text-muted-foreground">•</span>

  // token 事件合并展示（避免过多 token 行）
  if (evt.type === 'token') {
    return (
      <div className="flex items-start gap-1.5 py-0.5 text-[11px]">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-muted-foreground">{evt.content}</span>
      </div>
    )
  }

  // tool_start/tool_end 展示工具名 + 结果
  if (evt.type === 'tool_start' || evt.type === 'tool_end') {
    const hasResult = evt.result !== null && evt.result !== undefined
    const resultText = hasResult
      ? typeof evt.result === 'string'
        ? evt.result
        : JSON.stringify(evt.result, null, 2)
      : ''
    const isLong = resultText.length > 200
    return (
      <div className="flex items-start gap-1.5 py-0.5 text-[11px]">
        <span className="text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <span className="font-mono text-primary">{evt.tool_name || 'tool'}</span>
          {evt.message && <span className="ml-1 text-muted-foreground">{evt.message}</span>}
          {hasResult && (
            <div className="mt-0.5">
              {isLong ? (
                <>
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => !e)}
                    className="text-[10px] text-primary hover:text-primary"
                  >
                    {expanded ? '收起结果' : `展开结果（${resultText.length} 字符）`}
                  </button>
                  {expanded && (
                    <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-card p-1 font-mono text-[10px] text-muted-foreground">
                      {resultText}
                    </pre>
                  )}
                </>
              ) : (
                <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                  {resultText}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // done / error / start / status 通用渲染
  const text = evt.content || evt.message || ''
  const colorMap = {
    start: 'text-info',
    done: 'text-emerald-300',
    error: 'text-destructive',
    status: 'text-muted-foreground',
  }
  return (
    <div className="flex items-start gap-1.5 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{icon}</span>
      <span className={colorMap[evt.type] || 'text-muted-foreground'}>
        {text || evt.type}
      </span>
    </div>
  )
}

// 单个子代理分组（可折叠卡片）
function DelegateGroupCard({ group, onToggle }) {
  const eventCount = group.events.length
  // 统计子代理内部工具调用数
  const toolCount = group.events.filter(
    (e) => e.type === 'tool_start' || e.type === 'tool_end'
  ).length / 2 | 0

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5">
      {/* 分组头部（点击折叠/展开） */}
      <button
        type="button"
        onClick={() => onToggle(group.subagent_id)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-primary/10"
      >
        <span className="text-[10px] text-muted-foreground">
          {group.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <span className="font-mono text-[11px] font-semibold text-primary">
          {group.subagent_id}
        </span>
        <span className="text-[10px] text-muted-foreground">
          task#{group.task_index}
        </span>
        <DelegateStatusBadge status={group.status} />
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {toolCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench className="h-3 w-3" />
              {toolCount}
            </span>
          )}
          <span className="flex items-center gap-0.5">
            <FileText className="h-3 w-3" />
            {eventCount}
          </span>
        </span>
      </button>

      {/* 分组目标 */}
      {group.goal && (
        <div className="border-t border-primary/30 px-3 py-1 text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">目标：</span>
          {group.goal}
        </div>
      )}

      {/* 嵌套事件列表 */}
      {group.expanded && eventCount > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-primary/30 px-3 py-2">
          <div className="border-l border-primary/40 pl-2">
            {group.events.map((evt, idx) => (
              <DelegateEventItem key={idx} evt={evt} idx={idx} />
            ))}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {group.expanded && eventCount === 0 && (
        <div className="border-t border-primary/30 px-3 py-3 text-center text-[11px] text-muted-foreground">
          暂无事件
        </div>
      )}
    </div>
  )
}

// 子代理委派事件树（主组件）
function DelegateEventTree({ groups, onToggle, onToggleAll }) {
  if (!groups || groups.length === 0) return null
  const running = groups.filter((g) => g.status === 'running').length
  const completed = groups.filter((g) => g.status === 'completed').length
  const failed = groups.filter((g) => g.status === 'failed').length

  return (
    <div className="flex flex-col gap-2">
      {/* 统计栏 + 全部展开/折叠 */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>共 {groups.length} 个子代理</span>
        {running > 0 && <span className="text-primary">运行中 {running}</span>}
        {completed > 0 && <span className="text-emerald-300">完成 {completed}</span>}
        {failed > 0 && <span className="text-destructive">失败 {failed}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleAll(true)}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary"
          >
            全部展开
          </button>
          <button
            type="button"
            onClick={() => onToggleAll(false)}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary"
          >
            全部折叠
          </button>
        </div>
      </div>

      {/* 分组列表 */}
      {groups.map((g) => (
        <DelegateGroupCard key={g.subagent_id} group={g} onToggle={onToggle} />
      ))}
    </div>
  )
}

export default AgentEditor
