import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileText, Shield, ClipboardList, Clock, Brain, Monitor,
  HelpCircle, ListChecks, Send, Package, Trash2,
  Code as CodeIcon, Globe, Puzzle,
  Power, Play, Pencil, Eye, Copy, Check, Share2, Loader2,
  Radar, Bug, Zap, Network, Plus, RefreshCw,
} from 'lucide-react'
import { tools as toolsApi } from '../api/client'
import { Modal } from '../components/Dialog'
import { HoverTip } from '../components/InfoTip'
import { inputCls } from '../components/property/FormControls'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { TOOL_TUTORIAL } from '../components/tutorialContent'
import { CATEGORY_META, UNCATEGORIZED } from '../constants/toolCategories'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import {DataTable, Pagination, CompactSelect, AutoGrowTextarea } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import { hasPermission, canEditResource, canManageShare } from '../utils/permissions'
import ShareDialog from '../components/ShareDialog'
import BatchShareDialog from '../components/BatchShareDialog'

// 工具分类 lucide 图标映射
const CATEGORY_ICON_MAP = {
  FileText, Shield, ClipboardList, Clock, Brain, Monitor,
  HelpCircle, ListChecks, Send, Package,
  Radar, Bug, Zap, Network,
}

// 分类筛选下拉选项（供 FilterBar 使用）
const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  ...Object.entries(CATEGORY_META).map(([k, v]) => ({ value: k, label: v.label })),
  { value: '_uncategorized', label: UNCATEGORIZED.label },
]

// 工具类型元数据：图标 + 中文标签 + 样式 + 悬停说明
// 三种类型用差异化的语义色，避免 framework 与 http 同色看不出来
const TOOL_TYPE_META = {
  code: {
    icon: CodeIcon,
    label: 'Code',
    cls: 'border-border bg-secondary text-muted-foreground',
    title: 'Python 代码工具（用户可编辑 run 函数）',
  },
  http: {
    icon: Globe,
    label: 'HTTP',
    cls: 'border-primary/40 bg-primary/10 text-primary',
    title: 'HTTP 接口工具（声明式配置，无需编码）',
  },
  framework: {
    icon: Puzzle,
    label: '框架内置',
    cls: 'border-purple-500/40 bg-purple-500/10 text-purple-500',
    title: 'Hermes 框架内置工具（schema 入库，执行走引擎拦截）',
  },
}

// 类型筛选下拉选项
const TOOL_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'code', label: 'Code（Python 代码）' },
  { value: 'http', label: 'HTTP（接口工具）' },
  { value: 'framework', label: '框架内置' },
]

// 工具来源：内置种子 / 框架内置 / 用户自建
function resolveToolSource(row) {
  if (row?.tool_type === 'framework') return 'framework'
  if (row?.is_preset) return 'builtin'
  return 'custom'
}

const SOURCE_META = {
  builtin: {
    label: '内置',
    cls: 'border-amber-500/40 bg-warning/10 text-warning',
    title: '系统种子工具，不可删除',
  },
  framework: {
    label: '框架',
    cls: 'border-purple-500/40 bg-purple-500/10 text-purple-500',
    title: 'Hermes 框架工具，由引擎拦截执行',
  },
  custom: {
    label: '自建',
    cls: 'border-border bg-secondary text-muted-foreground',
    title: '用户创建或导入的工具',
  },
}

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'builtin', label: '内置' },
  { value: 'custom', label: '自建' },
  { value: 'framework', label: '框架' },
]

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 根据参数 schema 字段类型生成合适的默认值
function defaultValueForType(type) {
  switch ((type || 'String').toLowerCase()) {
    case 'number':
      return ''
    case 'boolean':
      return false
    case 'object':
    case 'array':
      return ''
    default:
      return ''
  }
}

// 工具测试参数输入弹窗：根据 parameters_schema 自动生成输入控件
function ToolTestModal({ open, tool, onClose, onSubmit, running }) {
  const [params, setParams] = useState({})

  useEffect(() => {
    if (open && tool) {
      const init = {}
      ;(tool.parameters_schema || []).forEach((p) => {
        init[p.name] = defaultValueForType(p.type)
      })
      setParams(init)
    }
  }, [open, tool])

  if (!open || !tool) return null

  const handleSubmit = () => {
    // 将参数按 schema 类型转换为合适的 JS 值
    const parsed = {}
    ;(tool.parameters_schema || []).forEach((p) => {
      const raw = params[p.name]
      if (raw === '' || raw === undefined || raw === null) {
        // 不传
        return
      }
      switch ((p.type || 'String').toLowerCase()) {
        case 'number': {
          const n = Number(raw)
          parsed[p.name] = isNaN(n) ? raw : n
          break
        }
        case 'boolean':
          parsed[p.name] = raw === true || raw === 'true'
          break
        case 'object':
        case 'array':
          try {
            parsed[p.name] = JSON.parse(raw)
          } catch {
            parsed[p.name] = raw
          }
          break
        default:
          parsed[p.name] = raw
      }
    })
    onSubmit(parsed)
  }

  return (
    <Modal
      open={open}
      title={`测试工具：${tool.name || ''}`}
      onClose={running ? undefined : onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={running}
            className="btn-primary inline-flex items-center gap-1.5 disabled:cursor-not-allowed"
          >
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            {running ? '运行中…' : '开始测试'}
          </button>
        </>
      }
    >
      {running && (
        <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          正在调用工具，请稍候…
        </div>
      )}
      {(tool.parameters_schema || []).length === 0 ? (
        <p className="text-sm text-muted-foreground">该工具没有参数，可直接点击「开始测试」。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {(tool.parameters_schema || []).map((p) => (
            <div key={p.name}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {p.name}
                <span className="ml-1 text-[10px] text-muted-foreground">({p.type})</span>
                {p.required && <span className="ml-1 text-destructive">*</span>}
              </label>
              {p.type === 'Boolean' ? (
                <CompactSelect
                  size="lg"
                  block
                  value={params[p.name] === true ? 'true' : 'false'}
                  onChange={(e) =>
                    setParams((prev) => ({ ...prev, [p.name]: e.target.value === 'true' }))
                  }
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </CompactSelect>
              ) : p.type === 'Object' || p.type === 'Array' ? (
                <AutoGrowTextarea
                  className={`${inputCls} resize-y font-mono`}
                  rows={3}
                  value={params[p.name] ?? ''}
                  onChange={(e) =>
                    setParams((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  placeholder={p.type === 'Array' ? '["a","b"]' : '{"key":"value"}'}
                />
              ) : (
                <input
                  className={inputCls}
                  value={params[p.name] ?? ''}
                  onChange={(e) =>
                    setParams((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  placeholder={p.description || ''}
                />
              )}
              {p.description && (
                <p className="mt-1 text-[11px] text-muted-foreground">{p.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// 工具列表：列出 GET /tools，支持新建/编辑跳转、测试、删除、从模板新建
function ToolList() {
  const navigate = useNavigate()
  const canCreate = hasPermission('tool', 'edit')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tutorialOpen, setTutorialOpen] = useState(false)

  // 测试相关
  const [testOpen, setTestOpen] = useState(false)
  const [testTool, setTestTool] = useState(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [resultErr, setResultErr] = useState('')
  const [resultOpen, setResultOpen] = useState(false)

  // 模板相关
  const [tplOpen, setTplOpen] = useState(false)
  const [templates, setTemplates] = useState([])
  const [tplLoading, setTplLoading] = useState(false)

  // 资源共享设置弹窗
  const [shareOpen, setShareOpen] = useState(false)
  const [shareResource, setShareResource] = useState(null)
  // 批量授权：选中多个工具后一次性授权给某位用户
  const [batchShareOpen, setBatchShareOpen] = useState(false)

  // 筛选 / 分页 / 批量选择
  const [{ search }, setFilters] = usePersistedFilters('tool_list', { search: '' })
  const setSearch = (v) => setFilters({ search: v })
  const [categoryFilter, setCategoryFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [agentFilter, setAgentFilter] = useState('') // 按关联智能体筛选（显示该智能体在用的工具）
  const [tabFilter, setTabFilter] = useState('all') // all | custom | framework
  const [statusFilter, setStatusFilter] = useState('') // '' | enabled | disabled
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const [deleting, setDeleting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [togglingId, setTogglingId] = useState(null)
  // 关联智能体筛选选项：从所有工具的 referenced_by 聚合去重
  const agentOptions = useMemo(() => {
    const names = new Set()
    rows.forEach((r) => (r.referenced_by || []).forEach((n) => names.add(n)))
    return [
      { value: '', label: '全部智能体' },
      ...Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN')).map((n) => ({ value: n, label: n })),
    ]
  }, [rows])
  const filteredRows = rows.filter((r) => {
    // Tab 筛选：custom 排除 framework，framework 只看 framework
    if (tabFilter === 'custom' && r.tool_type === 'framework') return false
    if (tabFilter === 'framework' && r.tool_type !== 'framework') return false
    if (categoryFilter && (r.category || '_uncategorized') !== categoryFilter) return false
    if (typeFilter && r.tool_type !== typeFilter) return false
    if (sourceFilter && resolveToolSource(r) !== sourceFilter) return false
    if (agentFilter && !(r.referenced_by || []).includes(agentFilter)) return false
    if (statusFilter === 'enabled' && !r.enabled) return false
    if (statusFilter === 'disabled' && r.enabled) return false
    if (search) {
      const q = search.toLowerCase()
      const name = (r.name || '').toLowerCase()
      const desc = (r.description || '').toLowerCase()
      if (!name.includes(q) && !desc.includes(q)) return false
    }
    return true
  })
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  // 状态/类型指标统计（指标条用：启用分布 + 类型分布 + 引用汇总）
  const listStats = useMemo(() => {
    const s = { enabled: 0, disabled: 0, code: 0, http: 0, framework: 0, totalRefs: 0 }
    const cats = new Set()
    rows.forEach((r) => {
      if (r.enabled) s.enabled += 1
      else s.disabled += 1
      if (r.tool_type && s[r.tool_type] != null) s[r.tool_type] += 1
      s.totalRefs += r.reference_count || 0
      if (r.category) cats.add(r.category)
    })
    return { ...s, categories: cats.size }
  }, [rows])

  // 清除全部筛选（空态 CTA 用）
  const clearAllFilters = () => {
    setSearch('')
    setCategoryFilter('')
    setTypeFilter('')
    setSourceFilter('')
    setAgentFilter('')
    setStatusFilter('')
    setTabFilter('all')
    setPage(1)
  }

  const load = useCallback(async () => {
    try {
      const data = await toolsApi.list()
      setRows(Array.isArray(data) ? data : [])
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleDelete = async (id, name) => {
    const _ok = await confirm({ message: `确定删除工具「${name || id}」吗？`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await toolsApi.remove(id)
      setRows((prev) => prev.filter((r) => r.id !== id))
      setSelectedKeys((prev) => prev.filter((k) => k !== id))
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || String(err)
      toast.error(`删除失败：${msg}`)
    }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个工具吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await toolsApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个工具`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 切换单个工具启用状态（内联 toggle）
  const handleToggleEnabled = async (tool) => {
    setTogglingId(tool.id)
    try {
      const next = !tool.enabled
      await toolsApi.update(tool.id, { ...tool, enabled: next })
      setRows((prev) => prev.map((r) => (r.id === tool.id ? { ...r, enabled: next } : r)))
      toast.success(`${tool.name} 已${next ? '启用' : '禁用'}`)
    } catch (err) {
      toast.error(`切换失败：${err.message || err}`)
    } finally {
      setTogglingId(null)
    }
  }

  // 批量启用/禁用
  const handleBatchToggle = async (enable) => {
    if (selectedKeys.length === 0) return
    setToggling(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      const tool = rows.find((r) => r.id === id)
      if (!tool) continue
      try {
        await toolsApi.update(id, { ...tool, enabled: enable })
        ok++
      } catch { fail++ }
    }
    clear()
    await load()
    setToggling(false)
    if (fail === 0) toast.success(`已${enable ? '启用' : '禁用'} ${ok} 个工具`)
    else toast.warning(`操作完成：成功 ${ok}，失败 ${fail}`)
  }

  const openTest = (tool) => {
    setTestTool(tool)
    setTestOpen(true)
  }

  // 执行测试：POST /tools/{id}/test body={parameters}
  // 测试期间保持参数弹窗打开：让按钮显示「运行中…」+ 加载图标，避免用户以为"点了没反应"
  const handleTest = async (params) => {
    if (!testTool) return
    setRunning(true)
    setResultErr('')
    try {
      const res = await toolsApi.test(testTool.id, params)
      setResult(res)
    } catch (err) {
      setResultErr(err.message || String(err))
    } finally {
      // 测试结束：关闭参数弹窗，打开结果弹窗
      setRunning(false)
      setTestOpen(false)
      setResultOpen(true)
    }
  }

  // 从模板新建：拉取 GET /tools/templates，选中后跳转到编辑器并携带模板信息
  const openTemplates = async () => {
    setTplOpen(true)
    setTplLoading(true)
    try {
      const data = await toolsApi.templates()
      setTemplates(Array.isArray(data) ? data : [])
    } catch (err) {
      toast.error(`加载模板失败：${err.message || err}`)
    } finally {
      setTplLoading(false)
    }
  }

  // 选中模板 -> 通过 sessionStorage 传递 -> 跳到 /tools/new
  const pickTemplate = (tpl) => {
    sessionStorage.setItem('soar:tool:template', JSON.stringify(tpl))
    setTplOpen(false)
    navigate('/tools/new')
  }

  // 表格列定义
  const columns = [
    {
      key: 'name', header: '名称', width: '220px',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="inline-block max-w-[180px] align-bottom truncate text-sm font-medium text-foreground" title={r.name || ''}>{r.name || '-'}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{r.id}</span>
        </div>
      ),
    },
    {
      key: 'tool_type', header: '类型 / 来源', width: '160px',
      render: (r) => {
        const meta = TOOL_TYPE_META[r.tool_type] || TOOL_TYPE_META.code
        const Icon = meta.icon
        const src = SOURCE_META[resolveToolSource(r)] || SOURCE_META.custom
        return (
          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
              title={meta.title}
            >
              <Icon className="h-3 w-3 shrink-0" />
              {meta.label}
            </span>
            <span
              className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium ${src.cls}`}
              title={src.title}
            >
              {src.label}
            </span>
          </div>
        )
      },
    },
    {
      key: 'description', header: '描述', width: '280px',
      render: (r) => <span className="inline-block max-w-[280px] align-bottom truncate text-muted-foreground" title={r.description || ''}>{r.description || '-'}</span>,
    },
    {
      key: 'category', header: '分类', width: '150px',
      render: (r) => {
        const cat = r.category || '_uncategorized'
        const meta = cat === '_uncategorized' ? UNCATEGORIZED : (CATEGORY_META[cat] || UNCATEGORIZED)
        const IconComp = CATEGORY_ICON_MAP[meta.icon] || Package
        const tags = r.tags || []
        return (
          <div className="flex flex-wrap items-center gap-1">
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              <IconComp className="h-3 w-3 shrink-0 text-primary" />
              {meta.label}
            </span>
            {tags.slice(0, 2).map((tag) => (
              <span key={tag} className="inline-flex shrink-0 items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" title={tag}>
                {tag}
              </span>
            ))}
            {tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>}
          </div>
        )
      },
    },
    {
      key: 'reference_count', header: '引用', width: '90px',
      render: (r) => {
        const count = r.reference_count ?? 0
        const refs = r.referenced_by || []
        if (count === 0) return <span className="text-muted-foreground">-</span>
        const tip = refs.length > 0
          ? (
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">被 {count} 个智能体引用</span>
              {refs.map((name) => (
                <span key={name} className="text-muted-foreground">· {name}</span>
              ))}
            </div>
          )
          : '被引用，但未获取到具体对象'
        return (
          <HoverTip text={tip} placement="right">
            <span className="inline-flex cursor-help items-center gap-1 text-[11px] text-muted-foreground">
              <ListChecks className="h-3 w-3 text-primary" />
              <span className="font-medium tabular-nums text-primary">{count}</span>
              <span className="text-muted-foreground">个</span>
            </span>
          </HoverTip>
        )
      },
    },
    {
      key: 'enabled', header: '启用', width: '70px',
      render: (r) => (
        <button
          type="button"
          disabled={togglingId === r.id}
          onClick={(e) => { e.stopPropagation(); handleToggleEnabled(r) }}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            r.enabled ? 'bg-primary' : 'bg-input'
          }`}
          title={r.enabled ? '点击禁用' : '点击启用'}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${r.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
        </button>
      ),
    },
    { key: 'updated_at', header: '更新时间', width: '150px', render: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtTime(r.updated_at)}</span> },
    {
      key: '__actions', header: '操作', width: '205px',
      render: (r) => {
        const canEdit = canEditResource(r)
        const canShare = canManageShare(r)
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => navigate(`/tools/${r.id}/edit`)}
              className="btn-secondary btn-sm"
              title={canEdit ? '编辑' : '查看'}
            >
              {canEdit ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
            {canShare && (
              <button
                type="button"
                onClick={() => { setShareResource(r); setShareOpen(true) }}
                className="btn-secondary btn-sm"
                title="共享给其他用户"
              >
                <Share2 className="h-3 w-3" />
              </button>
            )}
            {r.tool_type !== 'framework' && (
              <button
                type="button"
                disabled={running && testTool?.id === r.id}
                onClick={() => openTest(r)}
                className="btn-secondary btn-sm hover:border-blue-500 hover:text-blue-500"
                title="测试"
              >
                <Play className="h-3 w-3" />
              </button>
            )}
            {canEdit && r.tool_type !== 'framework' && !r.is_preset && (
              <button
                type="button"
                onClick={() => handleDelete(r.id, r.name)}
                className="btn-danger btn-sm"
                title="删除"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">工具</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{filteredRows.length}</span> 个工具
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TutorialButton onClick={() => setTutorialOpen(true)} />
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新工具列表">
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </button>
          <button type="button" onClick={openTemplates} className="btn-secondary btn-sm" title="从模板快速创建工具">
            <Package className="mr-1 h-3.5 w-3.5" /> 从模板新建
          </button>
          {canCreate && (
            <button type="button" onClick={() => navigate('/tools/new')} className="btn-primary btn-sm">
              <Plus className="mr-1 h-3.5 w-3.5" /> 新建工具
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Tab：全部 / 自定义 / 系统内置（带计数） */}
        <div className="mb-4 flex items-center gap-1 border-b border-border pb-3">
          <div className="flex shrink-0 rounded-md border border-border bg-card p-0.5">
            {[
              { v: 'all', label: '全部工具', count: rows.length },
              { v: 'custom', label: '自定义工具', count: rows.filter((r) => r.tool_type !== 'framework').length },
              { v: 'framework', label: '系统内置', count: rows.filter((r) => r.tool_type === 'framework').length },
            ].map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => { setTabFilter(t.v); setPage(1) }}
                className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition ${
                  tabFilter === t.v
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                    tabFilter === t.v ? 'bg-primary-foreground' : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {t.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        <FilterBar
          search={{ value: search, onChange: (v) => { setSearch(v); setPage(1) }, placeholder: '搜索工具名称或描述...' }}
          filters={[
            { key: 'agent', label: '智能体', value: agentFilter, onChange: (v) => { setAgentFilter(v); setPage(1) }, options: agentOptions },
            { key: 'type', label: '类型', value: typeFilter, onChange: (v) => { setTypeFilter(v); setPage(1) }, options: TOOL_TYPE_OPTIONS },
            { key: 'source', label: '来源', value: sourceFilter, onChange: (v) => { setSourceFilter(v); setPage(1) }, options: SOURCE_OPTIONS },
            { key: 'category', label: '分类', value: categoryFilter, onChange: (v) => { setCategoryFilter(v); setPage(1) }, options: CATEGORY_OPTIONS },
            { key: 'status', label: '状态', value: statusFilter, onChange: (v) => { setStatusFilter(v); setPage(1) }, options: [
              { value: '', label: '全部状态' },
              { value: 'enabled', label: '已启用' },
              { value: 'disabled', label: '已禁用' },
            ] },
          ]}
        />

        {/* 状态指标条：启用分布 + 类型分布（点击快速筛选）+ 汇总指标 */}
        {!loading && rows.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {[
              { key: 'enabled', label: '已启用', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40', group: 'status' },
              { key: 'disabled', label: '已禁用', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40', group: 'status' },
            ].map((chip) => {
              const active = statusFilter === chip.key
              const count = chip.key === 'enabled' ? listStats.enabled : listStats.disabled
              return (
                <button
                  key={chip.key} type="button"
                  onClick={() => { setStatusFilter(active ? '' : chip.key); setPage(1) }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    active
                      ? `border-transparent ring-1 ${chip.active}`
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该筛选' : `点击筛选「${chip.label}」的工具`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                      chip.key === 'enabled' && count > 0 ? 'animate-pulse' : ''
                    }`}
                  />
                  {chip.label}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
            <span className="mx-1 h-4 w-px bg-border" />
            {[
              { key: 'code', label: 'Code', dot: 'bg-muted-foreground', active: 'bg-secondary text-foreground ring-border' },
              { key: 'http', label: 'HTTP', dot: 'bg-primary', active: 'bg-primary/15 text-primary ring-primary/40' },
              { key: 'framework', label: '框架内置', dot: 'bg-purple-500', active: 'bg-purple-500/15 text-purple-400 ring-purple-500/40' },
            ].map((chip) => {
              const active = typeFilter === chip.key
              const count = listStats[chip.key] || 0
              return (
                <button
                  key={chip.key} type="button"
                  onClick={() => { setTypeFilter(active ? '' : chip.key); setPage(1) }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    active
                      ? `border-transparent ring-1 ${chip.active}`
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该类型筛选' : `点击筛选「${chip.label}」类型工具`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
                  {chip.label}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
            <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="全部工具被智能体引用的总次数">
                <ListChecks className="h-3.5 w-3.5 text-primary/80" />
                总引用
                <span
                  className={`font-semibold tabular-nums ${
                    listStats.totalRefs > 0 ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {listStats.totalRefs > 0 ? listStats.totalRefs.toLocaleString() : '--'}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5" title="工具已覆盖的分类数量">
                <Package className="h-3.5 w-3.5 text-primary/80" />
                分类
                <span
                  className={`font-semibold tabular-nums ${
                    listStats.categories > 0 ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {listStats.categories > 0 ? listStats.categories : '--'}
                </span>
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <DataTable
            className="table-stagger"
            columns={columns}
            data={paged}
            loading={loading}
            selectable
            selectedKeys={selectedKeys}
            onSelectChange={setSelectedKeys}
            rowKey="id"
            onRowClick={(r) => navigate(`/tools/${r.id}/edit`)}
            rowClickHint="点击编辑"
            emptyIcon={Package}
            emptyText={rows.length === 0 ? '暂无工具' : '未找到匹配的工具'}
            emptyDescription={
              rows.length === 0
                ? '创建自定义工具或从模板快速新建，供智能体与工作流调用'
                : '调整关键词或清除筛选条件后再试'
            }
            emptyAction={
              rows.length === 0
                ? canCreate && (
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => navigate('/tools/new')} className="btn-primary btn-sm">
                        <Plus className="mr-1 h-3.5 w-3.5" /> 新建工具
                      </button>
                      <button type="button" onClick={openTemplates} className="btn-secondary btn-sm">
                        <Package className="mr-1 h-3.5 w-3.5" /> 从模板新建
                      </button>
                    </div>
                  )
                : (
                    <button type="button" onClick={clearAllFilters} className="btn-secondary btn-sm">
                      清除筛选
                    </button>
                  )
            }
          />
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filteredRows.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
        <BatchActions
          selectedCount={selectedKeys.length}
          onClear={clear}
          actions={[
            { key: 'enable', label: '批量启用', icon: Power, variant: 'default', onClick: () => handleBatchToggle(true), loading: toggling },
            { key: 'disable', label: '批量禁用', icon: Power, variant: 'default', onClick: () => handleBatchToggle(false), loading: toggling },
            { key: 'share', label: '批量授权', icon: Share2, variant: 'default', onClick: () => setBatchShareOpen(true) },
            { key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting },
          ]}
        />
      </div>

      {/* 测试参数弹窗 */}
      <ToolTestModal
        open={testOpen}
        tool={testTool}
        onClose={() => setTestOpen(false)}
        onSubmit={handleTest}
        running={running}
      />

      {/* 测试结果弹窗 */}
      <Modal
        open={resultOpen}
        title={`工具测试结果${testTool ? `：${testTool.name || ''}` : ''}`}
        onClose={() => setResultOpen(false)}
        maxWidth="max-w-3xl"
        footer={
          <button
            type="button"
            onClick={() => setResultOpen(false)}
            className="btn-primary"
          >
            关闭
          </button>
        }
      >
        {resultErr ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {resultErr}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Result</div>
              <pre className="max-h-72 w-full overflow-auto rounded-md bg-background p-4 font-mono text-xs text-foreground ring-1 ring-border">
                {result?.result == null
                  ? '(空)'
                  : typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result, null, 2)}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                日志（{(result?.logs || []).length} 条）
              </div>
              <div className="max-h-48 w-full overflow-auto rounded-md bg-background p-4 ring-1 ring-border">
                {(result?.logs || []).length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无日志</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {result.logs.map((log, idx) => (
                      <div key={idx} className="font-mono text-xs">
                        <span className="mr-2 text-muted-foreground">[{(log.level || 'info').toUpperCase()}]</span>
                        <span className="text-muted-foreground">{log.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* 模板选择弹窗 */}
      <Modal
        open={tplOpen}
        title="从模板新建工具"
        onClose={() => setTplOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <button
            type="button"
            onClick={() => setTplOpen(false)}
            className="btn-secondary"
          >
            取消
          </button>
        }
      >
        {tplLoading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : templates.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无模板</div>
        ) : (
          <div className="flex flex-col gap-2">
            {templates.map((tpl, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => pickTemplate(tpl)}
                className="w-full rounded-md border border-border bg-card p-4 text-left transition hover:border-primary hover:bg-card"
              >
                <div className="text-sm font-medium text-foreground">{tpl.name}</div>
                {tpl.description && (
                  <div className="mt-1 text-xs text-muted-foreground">{tpl.description}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* 使用教程 */}
      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="工具管理使用教程"
        subtitle="了解如何创建、配置和测试工具"
        sections={TOOL_TUTORIAL}
      />

      {/* 资源共享设置弹窗 */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="tool"
        resourceId={shareResource?.id}
        resourceName={shareResource?.name}
        ownerUserId={shareResource?.created_by}
      />

      {/* 批量授权弹窗：把选中的多个工具一次性授权给某位用户 */}
      <BatchShareDialog
        open={batchShareOpen}
        onClose={() => setBatchShareOpen(false)}
        resourceType="tool"
        resources={selectedKeys
          .map((id) => rows.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, name: r.name }))}
        onDone={() => clear()}
      />
    </div>
  )
}

export default ToolList
