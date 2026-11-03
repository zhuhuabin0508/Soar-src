import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Trash2, Pencil, Eye, ListChecks, LayoutGrid, Table as TableIcon,
  Download, Upload, Power, PowerOff, RefreshCw,
  FileUp, FileText, CheckCircle2, AlertTriangle, X, Loader2,
  ChevronDown, FileDown, Share2, Plus, Database,
} from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { skills as skillsApi } from '../api/client'
import { hasPermission, canEditResource, canManageShare } from '../utils/permissions'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { SKILL_TUTORIAL } from '../components/tutorialContent'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { DataTable, Pagination, CompactSelect } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { HoverTip } from '../components/InfoTip'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'
import SkillEditor from './SkillEditor'
import ShareDialog from '../components/ShareDialog'
import BatchShareDialog from '../components/BatchShareDialog'

// 预设分类（与文档约定一致）
const CATEGORIES = ['处置流程', '角色设定', '领域规则', 'SOP', '其他']

// 分类徽章配色
const CATEGORY_STYLES = {
  处置流程: 'border border-primary/40 bg-primary/10 text-primary',
  角色设定: 'border border-purple-500/40 bg-purple-500/10 text-purple-400',
  领域规则: 'border border-blue-500/40 bg-blue-500/10 text-blue-400',
  SOP: 'border border-amber-500/40 bg-amber-500/10 text-amber-400',
  其他: 'border border-border bg-secondary text-muted-foreground',
}

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 相对时间
function relTime(t) {
  if (!t) return '-'
  const diff = Date.now() - new Date(t).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return fmtTime(t)
}

// 视图模式：table / card
const VIEW_MODES = [
  { key: 'table', label: '表格', icon: TableIcon },
  { key: 'card', label: '卡片', icon: LayoutGrid },
]

// 排序选项
const SORT_OPTIONS = [
  { value: 'priority:desc', label: '优先级 高→低' },
  { value: 'priority:asc', label: '优先级 低→高' },
  { value: 'updated_at:desc', label: '更新时间 新→旧' },
  { value: 'updated_at:asc', label: '更新时间 旧→新' },
  { value: 'name:asc', label: '名称 A→Z' },
  { value: 'name:desc', label: '名称 Z→A' },
]

// 推荐技能区块已按需求移除（原为按分类优先展示处置流程 / SOP）

// 技能列表页
function SkillList() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 搜索、分类、排序、快捷筛选
  const [{ keyword }, setFilters] = usePersistedFilters('skill_list', { keyword: '' })
  const setKeyword = (v) => setFilters({ keyword: v })
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sortKey, setSortKey] = useState('priority:desc')
  const [quickFilter, setQuickFilter] = useState('') // 当前激活的快捷筛选 key
  const [viewMode, setViewMode] = useState('table') // table | card

  // 头部「数据」下拉菜单（ref + document 监听实现点击外部关闭，不用全屏遮罩避免拦截交互）
  const [dataMenuOpen, setDataMenuOpen] = useState(false)
  const dataMenuRef = useRef(null)
  useEffect(() => {
    if (!dataMenuOpen) return
    const onDocMouseDown = (e) => {
      if (dataMenuRef.current && !dataMenuRef.current.contains(e.target)) {
        setDataMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [dataMenuOpen])

  // 编辑抽屉
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新建, 对象=编辑
  const [saving, setSaving] = useState(false)
  const [togglingId, setTogglingId] = useState(null)
  const [tutorialOpen, setTutorialOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [batching, setBatching] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  // 资源共享设置弹窗
  const [shareOpen, setShareOpen] = useState(false)
  // 批量授权：选中多个技能后一次性授权给多位用户
  const [batchShareOpen, setBatchShareOpen] = useState(false)
  const [shareResource, setShareResource] = useState(null)

  const canEdit = hasPermission('skill', 'edit')
  const canCreate = hasPermission('skill', 'edit')
  const canDelete = hasPermission('skill', 'delete')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await skillsApi.list()
      setRows(Array.isArray(data) ? data : [])
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId || loading) return
    const skill = rows.find((r) => String(r.id) === String(editId))
    if (skill) {
      setEditing(skill)
      setDrawerOpen(true)
    }
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
  }, [searchParams, loading, rows, setSearchParams])

  // 前端搜索 + 分类 + 快捷筛选（数据量小，本地过滤即可；排序交后端语义更准，但本地也支持）
  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const [sField, sOrder] = sortKey.split(':')
    const out = rows.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false
      // 快捷筛选
      if (quickFilter === 'enabled' && !r.enabled) return false
      if (quickFilter === 'disabled' && r.enabled) return false
      if (quickFilter && CATEGORIES.includes(quickFilter) && r.category !== quickFilter) return false
      if (!kw) return true
      const hay = `${r.name || ''} ${r.description || ''} ${(r.tags || []).join(' ')} ${r.content || ''}`.toLowerCase()
      return hay.includes(kw)
    })
    // 本地排序（与后端一致，方便切换排序即时生效）
    out.sort((a, b) => {
      let av, bv
      if (sField === 'priority') { av = a.priority ?? 0; bv = b.priority ?? 0 }
      else if (sField === 'updated_at') { av = new Date(a.updated_at || 0).getTime(); bv = new Date(b.updated_at || 0).getTime() }
      else { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase() }
      if (av < bv) return sOrder === 'asc' ? -1 : 1
      if (av > bv) return sOrder === 'asc' ? 1 : -1
      return (a.id ?? 0) - (b.id ?? 0)
    })
    return out
  }, [rows, keyword, categoryFilter, sortKey, quickFilter])

  // 分页 / 批量选择
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  // 状态/分类指标统计（指标条用：启用分布 + 分类分布 + 引用汇总）
  const listStats = useMemo(() => {
    const s = { enabled: 0, disabled: 0, totalRefs: 0 }
    const cat = {}
    rows.forEach((r) => {
      if (r.enabled) s.enabled += 1
      else s.disabled += 1
      const c = r.category || '其他'
      cat[c] = (cat[c] || 0) + 1
      s.totalRefs += r.reference_count || 0
    })
    return { ...s, cat, categories: Object.keys(cat).length }
  }, [rows])

  // 清除全部筛选（空态 CTA 用）
  const clearAllFilters = () => {
    setKeyword('')
    setCategoryFilter('')
    setQuickFilter('')
    setPage(1)
  }

  const openCreate = () => { setEditing(null); setDrawerOpen(true) }
  const openEdit = (skill) => { setEditing(skill); setDrawerOpen(true) }

  const handleSubmit = async (body) => {
    setSaving(true)
    try {
      if (editing) {
        const updated = await skillsApi.update(editing.id, body)
        setRows((prev) => prev.map((r) => (r.id === editing.id ? updated : r)))
      } else {
        const created = await skillsApi.create(body)
        setRows((prev) => [created, ...prev])
      }
      setDrawerOpen(false)
      toast.success(editing ? '技能已更新' : '技能已创建')
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id, name) => {
    const _ok = await confirm({
      message: `确定删除技能「${name || id}」吗？\n引用该技能的智能体下次组装提示词时将自动移除该技能段。`,
      variant: 'danger', confirmText: '确定删除',
    })
    if (!_ok) return
    try {
      await skillsApi.remove(id)
      setRows((prev) => prev.filter((r) => r.id !== id))
      setSelectedKeys((prev) => prev.filter((k) => k !== id))
      toast.success('已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 切换启用状态（inline toggle）
  const handleToggleEnabled = async (skill) => {
    setTogglingId(skill.id)
    try {
      const updated = await skillsApi.update(skill.id, { ...skill, enabled: !skill.enabled })
      setRows((prev) => prev.map((r) => (r.id === skill.id ? updated : r)))
    } catch (err) {
      toast.error(`切换状态失败：${err.message || err}`)
    } finally {
      setTogglingId(null)
    }
  }

  // 批量启用/禁用
  const handleBatchToggle = async (enable) => {
    if (selectedKeys.length === 0) return
    setBatching(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      const skill = rows.find((r) => r.id === id)
      if (!skill) continue
      if (skill.enabled === enable) { ok++; continue }
      try {
        const updated = await skillsApi.update(id, { ...skill, enabled: enable })
        setRows((prev) => prev.map((r) => (r.id === id ? updated : r)))
        ok++
      } catch { fail++ }
    }
    setBatching(false)
    if (fail === 0) toast.success(`已${enable ? '启用' : '禁用'} ${ok} 个技能`)
    else toast.warning(`完成：成功 ${ok}，失败 ${fail}`)
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({
      message: `确定删除选中的 ${selectedKeys.length} 个技能吗？此操作不可撤销。`,
      variant: 'danger', confirmText: '确定删除',
    })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await skillsApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个技能`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 导出（全部或选中）
  const handleExport = async () => {
    try {
      const ids = selectedKeys.length > 0 ? selectedKeys : null
      const data = await skillsApi.exportAll(ids)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `skills_${ids ? 'selected' : 'all'}_${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${data.skills?.length || 0} 个技能`)
    } catch (err) {
      toast.error(`导出失败：${err.message || err}`)
    }
  }

  // 导入完成回调
  const handleImportDone = async (result) => {
    if (result) {
      await load()
    }
    setImportOpen(false)
  }

  // Inline Toggle 开关
  const InlineToggle = ({ skill }) => {
    if (!canEdit) {
      return (
        <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${skill.enabled ? 'bg-success/20 text-success' : 'bg-secondary text-muted-foreground'}`}>
          {skill.enabled ? '启用' : '禁用'}
        </span>
      )
    }
    return (
      <button
        type="button"
        disabled={togglingId === skill.id}
        onClick={(e) => { e.stopPropagation(); handleToggleEnabled(skill) }}
        className={`relative h-5 w-9 rounded-full transition disabled:opacity-50 ${skill.enabled ? 'bg-primary' : 'bg-input'}`}
        title={skill.enabled ? '点击禁用（即时从 Agent prompt 移除）' : '点击启用'}
        aria-label="切换启用状态"
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${skill.enabled ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    )
  }

  // 引用列
  const renderRef = (r) => {
    const count = r.reference_count ?? 0
    const refs = r.referenced_by || []
    if (count === 0) return <span className="text-muted-foreground">-</span>
    const tip = (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">被 {count} 个智能体引用</span>
        {refs.map((name) => <span key={name} className="text-muted-foreground">· {name}</span>)}
      </div>
    )
    return (
      <HoverTip text={tip} placement="right">
        <span className="inline-flex cursor-help items-center gap-1 text-[11px] text-muted-foreground">
          <ListChecks className="h-3 w-3 text-primary" />
          <span className="font-medium tabular-nums text-primary">{count}</span>
          <span className="text-muted-foreground">个</span>
        </span>
      </HoverTip>
    )
  }

  // 表格列定义
  const columns = [
    { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
    {
      key: 'name', header: '名称', width: '180px',
      render: (r) => <span className="truncate font-medium text-foreground" title={r.name}>{r.name || '-'}</span>,
    },
    {
      key: 'description', header: '摘要',
      render: (r) => <span className="truncate text-muted-foreground" title={r.description || ''}>{r.description || '-'}</span>,
    },
    {
      key: 'category', header: '分类/标签', width: '180px',
      render: (r) => {
        const cat = r.category || '未分类'
        const tags = r.tags || []
        return (
          <div className="flex flex-wrap items-center gap-1">
            <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${CATEGORY_STYLES[r.category] || CATEGORY_STYLES['其他']}`}>{cat}</span>
            {tags.slice(0, 2).map((t) => (
              <span key={t} className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" title={t}>{t}</span>
            ))}
            {tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>}
          </div>
        )
      },
    },
    {
      key: 'priority', header: '优先级', width: '70px', numeric: true,
      render: (r) => (
        <span
          className={`whitespace-nowrap font-mono tabular-nums ${r.priority ? 'text-foreground' : 'text-muted-foreground'}`}
          title={r.priority ? undefined : '未设置优先级'}
        >
          {r.priority ?? 0}
        </span>
      ),
    },
    { key: 'reference_count', header: '引用', width: '80px', render: renderRef },
    { key: 'enabled', header: '启用', width: '70px', render: (r) => <InlineToggle skill={r} /> },
    { key: 'updated_at', header: '更新时间', width: '140px', render: (r) => <HoverTip text={fmtTime(r.updated_at)} placement="left"><span className="cursor-help whitespace-nowrap text-muted-foreground">{relTime(r.updated_at)}</span></HoverTip> },
    {
      key: '__actions', header: '操作', width: '205px',
      render: (r) => {
        const editable = canEditResource(r)
        const shareable = canManageShare(r)
        return (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            {editable && <button type="button" onClick={() => openEdit(r)} className="btn-secondary btn-sm" title="编辑"><Pencil className="h-3 w-3" /></button>}
            {editable && <button type="button" onClick={() => openEdit(r)} className="btn-secondary btn-sm" title="预览"><Eye className="h-3 w-3" /></button>}
            {shareable && (
              <button type="button" onClick={() => { setShareResource(r); setShareOpen(true) }} className="btn-secondary btn-sm" title="共享给其他用户">
                <Share2 className="h-3 w-3" />
              </button>
            )}
            {editable && <button type="button" onClick={() => handleDelete(r.id, r.name)} className="btn-danger btn-sm" title="删除"><Trash2 className="h-3 w-3" /></button>}
          </div>
        )
      },
    },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={() => navigate('/studio')} className="btn-secondary btn-sm shrink-0 self-center" title="返回工作室">
            ← 工作室
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">技能库</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{filteredRows.length}</span> 个技能
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">纯文本指令，注入智能体 system prompt</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TutorialButton onClick={() => setTutorialOpen(true)} />
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新技能列表">
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </button>
          {/* 数据操作下拉：导出 / 导入（ref + document 监听点击外部关闭，不用全屏遮罩） */}
          <div className="relative" ref={dataMenuRef}>
            <button
              type="button"
              onClick={() => setDataMenuOpen((v) => !v)}
              className={`btn-secondary btn-sm ${dataMenuOpen ? 'ring-1 ring-ring' : ''}`}
              title="数据导入 / 导出"
            >
              <Database className="mr-1 h-3.5 w-3.5" /> 数据
              <ChevronDown className={`ml-1 h-3 w-3 transition-transform ${dataMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {dataMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl shadow-black/20">
                <button
                  type="button"
                  onClick={() => { handleExport(); setDataMenuOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5 text-muted-foreground" />
                  导出全部技能
                </button>
                <button
                  type="button"
                  disabled={selectedKeys.length === 0}
                  onClick={() => { handleExport(); setDataMenuOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                  导出所选{selectedKeys.length > 0 ? `（${selectedKeys.length} 个）` : ''}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => { setImportOpen(true); setDataMenuOpen(false) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                  >
                    <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                    导入技能
                  </button>
                )}
              </div>
            )}
          </div>
          {canCreate && (
            <button type="button" onClick={openCreate} className="btn-primary btn-sm">
              <Plus className="mr-1 h-3.5 w-3.5" /> 新建技能
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
        )}

        {/* 筛选 + 排序 + 视图切换 */}
        <FilterBar
          search={{ value: keyword, onChange: (v) => { setKeyword(v); setPage(1) }, placeholder: '搜索名称 / 摘要 / 标签 / 正文' }}
          filters={[
            {
              key: 'category', label: '分类', value: categoryFilter,
              onChange: (v) => { setCategoryFilter(v); setPage(1); setQuickFilter('') },
              options: [{ value: '', label: '全部分类' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))],
            },
            {
              key: 'sort', label: '排序', value: sortKey,
              onChange: (v) => { setSortKey(v); setPage(1) },
              options: SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
            },
          ]}
          actions={
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {VIEW_MODES.map((m) => {
                const Icon = m.icon
                return (
                  <button
                    key={m.key} type="button"
                    onClick={() => setViewMode(m.key)}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition ${viewMode === m.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    title={m.label}
                  >
                    <Icon className="h-3 w-3" />{m.label}
                  </button>
                )
              })}
            </div>
          }
        />

        {/* 状态指标条：启用分布 + 分类分布（点击快速筛选）+ 汇总指标 */}
        {!loading && rows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {[
              { key: 'enabled', label: '已启用', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
              { key: 'disabled', label: '已禁用', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40' },
            ].map((chip) => {
              const active = quickFilter === chip.key
              const count = chip.key === 'enabled' ? listStats.enabled : listStats.disabled
              return (
                <button
                  key={chip.key} type="button"
                  onClick={() => { setQuickFilter(active ? '' : chip.key); setCategoryFilter(''); setPage(1) }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    active
                      ? `border-transparent ring-1 ${chip.active}`
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该筛选' : `点击筛选「${chip.label}」的技能`}
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
            {CATEGORIES.map((c) => {
              const active = quickFilter === c || categoryFilter === c
              const count = listStats.cat[c] || 0
              return (
                <button
                  key={c} type="button"
                  onClick={() => {
                    if (active) { setQuickFilter(''); setCategoryFilter('') }
                    else { setQuickFilter(''); setCategoryFilter(c) }
                    setPage(1)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    active
                      ? 'border-transparent bg-primary/15 text-primary ring-1 ring-primary/40'
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该分类筛选' : `点击筛选「${c}」类技能`}
                >
                  {c}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
            <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="全部技能被智能体引用的总次数">
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
              <span className="inline-flex items-center gap-1.5" title="技能已覆盖的分类数量">
                <LayoutGrid className="h-3.5 w-3.5 text-primary/80" />
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

        {/* 列表：表格 / 卡片 */}
        {viewMode === 'table' ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <DataTable
              className="table-stagger"
              columns={columns}
              data={paged}
              loading={loading}
              selectable
              selectedKeys={selectedKeys}
              onSelectChange={setSelectedKeys}
              rowKey="id"
              onRowClick={(r) => { if (canEditResource(r)) openEdit(r) }}
              rowClickHint="点击编辑"
              emptyIcon={ListChecks}
              emptyText={rows.length === 0 ? '暂无技能' : '未找到匹配的技能'}
              emptyDescription={
                rows.length === 0
                  ? '创建第一个技能，让智能体获得处置流程与领域规则'
                  : '调整关键词或清除筛选条件后再试'
              }
              emptyAction={
                rows.length === 0
                  ? canCreate && (
                      <button type="button" onClick={openCreate} className="btn-primary btn-sm">
                        <Plus className="mr-1 h-3.5 w-3.5" /> 新建技能
                      </button>
                    )
                  : (
                      <button type="button" onClick={clearAllFilters} className="btn-secondary btn-sm">
                        清除筛选
                      </button>
                    )
              }
            />
          </div>
        ) : (
          <CardView
            rows={paged} loading={loading}
            selectable selectedKeys={selectedKeys} onSelectChange={setSelectedKeys}
            canEdit={canEdit} canDelete={canDelete}
            onEdit={openEdit} onDelete={handleDelete} onToggle={handleToggleEnabled}
            onShare={(r) => { setShareResource(r); setShareOpen(true) }}
            togglingId={togglingId}
            renderRef={renderRef}
            hasAny={rows.length > 0}
            onCreate={canCreate ? openCreate : undefined}
            onClearFilters={clearAllFilters}
          />
        )}
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
            { key: 'enable', label: '批量启用', icon: Power, variant: 'secondary', onClick: () => handleBatchToggle(true), loading: batching },
            { key: 'disable', label: '批量禁用', icon: PowerOff, variant: 'secondary', onClick: () => handleBatchToggle(false), loading: batching },
            { key: 'share', label: '批量授权', icon: Share2, variant: 'default', onClick: () => setBatchShareOpen(true) },
            { key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting },
          ]}
        />
      </div>

      <SkillEditor
        open={drawerOpen}
        initial={editing}
        onClose={() => setDrawerOpen(false)}
        onSubmit={handleSubmit}
        saving={saving}
      />

      {importOpen && (
        <SkillImportModal
          onClose={() => setImportOpen(false)}
          onCompleted={handleImportDone}
        />
      )}

      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="技能管理使用教程"
        subtitle="了解如何创建技能并关联工作流"
        sections={SKILL_TUTORIAL}
      />

      {/* 资源共享设置弹窗 */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="skill"
        resourceId={shareResource?.id}
        resourceName={shareResource?.name}
        ownerUserId={shareResource?.created_by}
      />

      {/* 批量授权弹窗：把选中的多个技能一次性授权给多位用户 */}
      <BatchShareDialog
        open={batchShareOpen}
        onClose={() => setBatchShareOpen(false)}
        resourceType="skill"
        resources={selectedKeys
          .map((id) => rows.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, name: r.name }))}
        onDone={() => clear()}
      />
    </div>
  )
}

// 卡片视图
function CardView({ rows, loading, selectable, selectedKeys, onSelectChange, canEdit, canDelete, onEdit, onDelete, onToggle, onShare, togglingId, renderRef, hasAny, onCreate, onClearFilters }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex h-[172px] flex-col rounded-lg border border-border bg-card px-5 py-4">
            <div className="flex items-start justify-between gap-2">
              <div className="h-4 w-1/3 rounded skeleton-shimmer" />
              <div className="h-5 w-16 rounded skeleton-shimmer" />
            </div>
            <div className="mt-3 h-3 w-full rounded skeleton-shimmer" />
            <div className="mt-2 h-3 w-2/3 rounded skeleton-shimmer" />
            <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5">
              <div className="h-3 w-16 rounded skeleton-shimmer" />
              <div className="h-7 w-24 rounded skeleton-shimmer" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ListChecks className="h-5 w-5" />
        </div>
        <div className="text-sm font-medium text-foreground">{hasAny ? '未找到匹配的技能' : '暂无技能'}</div>
        <div className="text-xs text-muted-foreground">
          {hasAny ? '调整关键词或清除筛选条件后再试' : '创建第一个技能，让智能体获得处置流程与领域规则'}
        </div>
        {hasAny
          ? onClearFilters && (
              <button type="button" onClick={onClearFilters} className="btn-secondary btn-sm">清除筛选</button>
            )
          : onCreate && (
              <button type="button" onClick={onCreate} className="btn-primary btn-sm">
                <Plus className="mr-1 h-3.5 w-3.5" /> 新建技能
              </button>
            )}
      </div>
    )
  }
  const toggle = (id) => {
    if (!selectable) return
    onSelectChange(selectedKeys.includes(id) ? selectedKeys.filter((k) => k !== id) : [...selectedKeys, id])
  }
  return (
    <div className="card-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const checked = selectedKeys.includes(r.id)
        return (
          <div
            key={r.id}
            className={`card-hover flex flex-col rounded-lg border backdrop-blur-sm transition-colors ${
              checked
                ? 'border-primary/60 bg-primary/5 shadow-[0_0_0_1px_color-mix(in_oklch,var(--ring)_15%,transparent)]'
                : 'border-border bg-card hover:border-primary/40'
            }`}
          >
            <div className="flex items-start justify-between gap-2 px-5 pt-4">
              <div className="flex min-w-0 items-center gap-2">
                {selectable && (
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(r.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                )}
                <span className="truncate text-sm font-semibold text-foreground" title={r.name}>{r.name || '-'}</span>
              </div>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${CATEGORY_STYLES[r.category] || CATEGORY_STYLES['其他']}`}>{r.category || '未分类'}</span>
            </div>
            {/* 摘要 + 正文前 2 行 */}
            <div className="flex-1 px-5">
              <p className="mt-1.5 line-clamp-1 text-[11px] text-muted-foreground">{r.description || '（无摘要）'}</p>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{r.content || '（无正文）'}</p>
              {/* 标签 */}
              {(r.tags || []).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {r.tags.slice(0, 3).map((t) => (
                    <span key={t} className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t}</span>
                  ))}
                </div>
              )}
            </div>
            {/* 底部信息 */}
            <div className="mt-2 flex items-center justify-between border-t border-border px-5 py-2.5 text-[10px] text-muted-foreground">
              <span className="tabular-nums">优先级 <span className="font-mono">{r.priority ?? 0}</span></span>
              <span>{renderRef(r)}</span>
              <span title={fmtTime(r.updated_at)}>{relTime(r.updated_at)}</span>
            </div>
            {/* 操作 */}
            <div className="flex items-center justify-between px-5 pb-4">
              {canEditResource(r) ? (
                <button
                  type="button"
                  disabled={togglingId === r.id}
                  onClick={(e) => { e.stopPropagation(); onToggle(r) }}
                  className={`relative h-5 w-9 rounded-full transition disabled:opacity-50 ${r.enabled ? 'bg-primary' : 'bg-input'}`}
                  title={r.enabled ? '点击禁用' : '点击启用'}
                  aria-label="切换启用状态"
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              ) : (
                <span className={`rounded px-2 py-0.5 text-[10px] ${r.enabled ? 'bg-success/20 text-success' : 'bg-secondary text-muted-foreground'}`}>{r.enabled ? '启用' : '禁用'}</span>
              )}
              <div className="flex gap-1">
                <button type="button" onClick={() => onEdit(r)} className="btn-secondary btn-sm" title={canEditResource(r) ? '编辑' : '查看'}>{canEditResource(r) ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</button>
                {canManageShare(r) && onShare && (
                  <button type="button" onClick={() => onShare(r)} className="btn-secondary btn-sm" title="共享给其他用户"><Share2 className="h-3 w-3" /></button>
                )}
                {canEditResource(r) && <button type="button" onClick={() => onDelete(r.id, r.name)} className="btn-danger btn-sm" title="删除"><Trash2 className="h-3 w-3" /></button>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ============ 技能导入弹窗（三步流程 + 模板下载 + 宽弹窗） ============
function SkillImportModal({ onClose, onCompleted }) {
  useLockBackgroundScroll(true)
  // 步骤：upload 选择文件 / preview 预览校验 / importing 导入中 / done 完成 / error 失败
  const [step, setStep] = useState('upload')
  const [file, setFile] = useState(null)
  const [parsedData, setParsedData] = useState(null)
  const [overwrite, setOverwrite] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showFormat, setShowFormat] = useState(false) // 格式示例折叠
  const fileInputRef = useRef(null)

  // 校验单条技能：返回 { name, category, priority, status, reason }
  const validateSkill = (item, idx) => {
    const name = (item?.name || '').toString().trim()
    if (!name) {
      return { idx, name: '(未命名)', category: item?.category || '', priority: item?.priority ?? 0, status: 'invalid', reason: '缺少名称' }
    }
    return {
      idx,
      name,
      category: item?.category || '',
      priority: item?.priority ?? 0,
      status: 'valid',
      reason: '',
    }
  }

  // 编辑预览中的技能字段：实时同步 parsedData.skills 并重新校验该条
  const updateSkillField = (idx, field, value) => {
    setParsedData((prev) => {
      if (!prev) return prev
      const skills = prev.skills.map((s, i) => (i === idx ? { ...s, [field]: value } : s))
      const validated = skills.map((s, i) => validateSkill(s, i))
      return { ...prev, skills, validated }
    })
  }

  // 解析 Markdown 技能文件：YAML frontmatter 存元数据，正文作为 content
  // 格式：
  //   ---
  //   name: 技能名称
  //   description: 技能描述
  //   category: 处置流程
  //   tags: [标签1, 标签2]
  //   priority: 10
  //   enabled: true
  //   ---
  //   技能正文（注入 Agent prompt）...
  const parseMarkdownSkill = (text, fallbackName) => {
    const skill = { name: '', description: '', content: '', category: '', tags: [], enabled: true, priority: 0 }
    // 规范化换行符（兼容 Windows CRLF）
    const src = text.replace(/\r\n/g, '\n')
    let body = src
    // 识别 frontmatter（--- 包裹的开头块）
    const fmMatch = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
    if (fmMatch) {
      const frontmatter = fmMatch[1]
      body = (fmMatch[2] || '').trim()
      // 简单行级解析 key: value（不引入 yaml 依赖）
      for (const line of frontmatter.split('\n')) {
        const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/)
        if (!m) continue
        const key = m[1].trim()
        let val = m[2].trim()
        // 行内数组：[a, b, c]
        if (val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        } else if (val === 'true') {
          val = true
        } else if (val === 'false') {
          val = false
        } else if (/^-?\d+$/.test(val)) {
          val = parseInt(val, 10)
        } else {
          // 去掉首尾引号
          val = val.replace(/^["']|["']$/g, '')
        }
        if (key in skill) skill[key] = val
      }
    } else {
      // 无 frontmatter：整篇作为正文
      body = text.trim()
    }
    skill.content = body
    // name 兜底：frontmatter 缺失则用文件名（去扩展名）
    if (!skill.name) {
      skill.name = (fallbackName || '').replace(/\.(md|markdown)$/i, '').trim()
    }
    return skill
  }

  // 解析文件：按扩展名分流 JSON / Markdown
  const parseFile = async (selectedFile) => {
    if (!selectedFile) return
    setFile(selectedFile)
    setParsing(true)
    setErrorMsg('')
    try {
      const text = await selectedFile.text()
      const lower = (selectedFile.name || '').toLowerCase()
      let skillsArr = []
      if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        // Markdown：单文件 = 单个技能（保持简单直观）
        const skill = parseMarkdownSkill(text, selectedFile.name)
        skillsArr = [skill]
      } else {
        // JSON：兼容 {skills:[...]} 与 [...] 两种结构
        const data = JSON.parse(text)
        skillsArr = Array.isArray(data) ? data : data.skills
        if (!Array.isArray(skillsArr)) {
          throw new Error('JSON 文件格式不正确：未找到 skills 数组')
        }
      }
      // 校验每条数据
      const validated = skillsArr.map((s, i) => validateSkill(s, i))
      setParsedData({ skills: skillsArr, _count: skillsArr.length, validated })
      setStep('preview')
      const invalidCount = validated.filter((v) => v.status === 'invalid').length
      toast.success(`已解析 ${skillsArr.length} 个技能${invalidCount > 0 ? `，其中 ${invalidCount} 条无效` : ''}`)
    } catch (err) {
      setErrorMsg(err.message || '文件解析失败')
      setStep('error')
      toast.error(`解析失败：${err.message || err}`)
    } finally {
      setParsing(false)
    }
  }

  const handleFileSelect = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) parseFile(f)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) parseFile(f)
  }

  // 下载导入模板
  const handleDownloadTemplate = () => {
    const template = {
      skills: [
        {
          name: '示例技能-处置流程',
          description: '这是一个示例技能，展示导入所需的字段结构',
          content: '当检测到安全事件时，按以下步骤处置：\n1. 确认事件真实性\n2. 评估影响范围\n3. 执行隔离措施\n4. 通知相关人员',
          category: '处置流程',
          tags: ['安全', '应急响应'],
          enabled: true,
          priority: 10,
        },
        {
          name: '示例技能-角色设定',
          description: '另一个示例技能',
          content: '你是一名专业的安全分析师，擅长威胁情报分析和事件响应。',
          category: '角色设定',
          tags: ['角色'],
          enabled: true,
          priority: 5,
        },
      ],
    }
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `skill_import_template_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('模板已下载')
  }

  // 执行导入
  const handleImport = async () => {
    setStep('importing')
    setImporting(true)
    setErrorMsg('')
    try {
      // 清理标签中的空字符串（用户逗号分隔输入可能残留）
      const cleanedSkills = parsedData.skills.map((s) => ({
        ...s,
        tags: Array.isArray(s.tags) ? s.tags.filter(Boolean) : [],
      }))
      const res = await skillsApi.import({ ...parsedData, skills: cleanedSkills }, overwrite)
      setImportResult(res)
      setStep('done')
      const msg = `导入完成：新增 ${res.created || 0}，更新 ${res.updated || 0}，跳过 ${res.skipped || 0}`
        + (res.errors?.length ? `，错误 ${res.errors.length}` : '')
      toast.success(msg)
    } catch (err) {
      setErrorMsg(err.message || String(err))
      setStep('error')
      toast.error(`导入失败：${err.message || err}`)
    } finally {
      setImporting(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setParsedData(null)
    setImportResult(null)
    setErrorMsg('')
    setStep('upload')
  }

  const handleClose = () => {
    if (step === 'importing') return
    if (step === 'done') {
      onCompleted(true)
    } else {
      onClose()
    }
  }

  const totalCount = parsedData?._count || 0
  const validatedItems = parsedData?.validated || []
  const validCount = validatedItems.filter((v) => v.status === 'valid').length
  const invalidCount = validatedItems.filter((v) => v.status === 'invalid').length
  // 预览列表：最多展示 50 条
  const previewItems = validatedItems.slice(0, 50)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={step === 'importing' ? undefined : handleClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-6 py-4">
          <div className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">导入技能</h3>
            {file && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                {file.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-secondary px-2.5 py-1 text-[11px] text-primary transition hover:bg-primary/10"
              title="下载 JSON 导入模板（Markdown 格式见下方示例）"
            >
              <FileDown className="h-3 w-3" />
              下载导入模板
            </button>
            <button
              onClick={handleClose}
              disabled={step === 'importing'}
              className="text-muted-foreground transition hover:text-foreground disabled:opacity-30"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 步骤指示器 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary px-6 py-2.5">
          {[
            { key: 'upload', label: '上传文件' },
            { key: 'preview', label: '预览校验' },
            { key: 'done', label: '导入结果' },
          ].map((s, i) => {
            const stepOrder = ['upload', 'preview', 'importing', 'done']
            const currentIdx = stepOrder.indexOf(step)
            const itemIdx = stepOrder.indexOf(s.key === 'done' ? 'done' : s.key)
            const isActive = step === s.key || (s.key === 'preview' && step === 'importing')
            const isPassed = currentIdx > itemIdx
            return (
              <div key={s.key} className="flex items-center gap-2">
                <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition ${
                  isActive ? 'bg-primary/15 text-primary' : isPassed ? 'bg-success/15 text-success' : 'text-muted-foreground'
                }`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    isActive ? 'bg-primary text-primary-foreground' : isPassed ? 'bg-success text-white' : 'bg-muted text-muted-foreground'
                  }`}>
                    {isPassed ? <CheckCircle2 className="h-2.5 w-2.5" /> : i + 1}
                  </span>
                  {s.label}
                </div>
                {i < 2 && <div className="h-px w-8 bg-border" />}
              </div>
            )
          })}
        </div>

        {/* 步骤内容（可滚动） */}
        <div data-allow-scroll className="flex-1 overflow-y-auto overscroll-contain p-6">
          {/* 步骤 1：上传区 */}
          {step === 'upload' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`flex h-40 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition ${
                  dragOver
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-secondary hover:border-primary/60 hover:bg-secondary'
                }`}
              >
                {parsing ? (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <span className="text-xs text-muted-foreground">正在解析文件...</span>
                  </>
                ) : (
                  <>
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="text-center">
                      <div className="text-xs font-medium text-muted-foreground">暂无文件</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        点击选择 JSON / Markdown 文件，或拖拽文件到此处
                      </div>
                    </div>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.md,.markdown"
                className="hidden"
                onChange={handleFileSelect}
              />
              {/* 格式示例（可折叠） */}
              <div className="w-full rounded-md border border-border bg-secondary">
                <button
                  type="button"
                  onClick={() => setShowFormat((p) => !p)}
                  className="flex w-full items-center justify-between px-3 py-2 text-[11px] text-muted-foreground transition hover:text-foreground"
                >
                  <span className="font-medium">查看格式示例</span>
                  <ChevronDown className={`h-3 w-3 transition-transform ${showFormat ? 'rotate-180' : ''}`} />
                </button>
                {showFormat && (
                  <div className="border-t border-border px-3 py-2">
                    <div className="mb-1 text-[10px] font-medium text-muted-foreground">JSON 格式（.json）</div>
                    <code className="block whitespace-pre-wrap text-[10px] text-primary">{`{
  "skills": [
    {
      "name": "技能名称（必填）",
      "description": "技能描述",
      "content": "技能正文（注入 Agent prompt）",
      "category": "处置流程|角色设定|领域规则|SOP|其他",
      "tags": ["标签1", "标签2"],
      "enabled": true,
      "priority": 10
    }
  ]
}`}</code>
                    <div className="mt-1.5 text-[10px] text-muted-foreground">
                      或直接为技能数组：[{`{ "name": "..." }`}]
                    </div>
                    <div className="mt-3 mb-1 text-[10px] font-medium text-muted-foreground">Markdown 格式（.md，单文件 = 单个技能）</div>
                    <code className="block whitespace-pre-wrap text-[10px] text-primary">{`---
name: 技能名称（必填，缺失则用文件名）
description: 技能描述
category: 处置流程
tags: [标签1, 标签2]
priority: 10
enabled: true
---

技能正文（注入 Agent prompt），支持完整 Markdown 语法。`}</code>
                    <div className="mt-1.5 text-[10px] text-muted-foreground">
                      无 frontmatter 时整篇作为正文，名称用文件名兜底
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 步骤 2：预览校验 */}
          {step === 'preview' && parsedData && (
            <div className="flex flex-col gap-4">
              {/* 统计摘要 */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border border-border bg-secondary p-3 text-center">
                  <div className="text-lg font-bold text-foreground">{totalCount}</div>
                  <div className="text-[10px] text-muted-foreground">总条数</div>
                </div>
                <div className="rounded-md border border-success/30 bg-success/10 p-3 text-center">
                  <div className="text-lg font-bold text-success">{validCount}</div>
                  <div className="text-[10px] text-muted-foreground">有效</div>
                </div>
                <div className={`rounded-md border p-3 text-center ${invalidCount > 0 ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-secondary'}`}>
                  <div className={`text-lg font-bold ${invalidCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{invalidCount}</div>
                  <div className="text-[10px] text-muted-foreground">无效/缺失</div>
                </div>
              </div>
              {/* 可编辑预览卡片列表 */}
              <div className="flex flex-col gap-2">
                {previewItems.map((v) => {
                  const skill = parsedData.skills[v.idx]
                  const tagsStr = Array.isArray(skill.tags) ? skill.tags.join(', ') : (skill.tags || '')
                  return (
                    <div key={v.idx} className="rounded-md border border-border bg-secondary p-3">
                      {/* 卡片头：序号 + 状态徽章 */}
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">#{v.idx + 1}</span>
                        {v.status === 'valid' ? (
                          <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">有效</span>
                        ) : (
                          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive" title={v.reason}>{v.reason}</span>
                        )}
                      </div>
                      {/* 名称 */}
                      <div className="mb-2">
                        <label className="mb-0.5 block text-[10px] text-muted-foreground">名称 <span className="text-destructive">*</span></label>
                        <input
                          type="text"
                          value={skill.name || ''}
                          onChange={(e) => updateSkillField(v.idx, 'name', e.target.value)}
                          placeholder="技能名称（必填）"
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </div>
                      {/* 分类 + 优先级 */}
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-[10px] text-muted-foreground">分类</label>
                          <CompactSelect
                            size="lg"
                            block
                            value={skill.category || ''}
                            onChange={(e) => updateSkillField(v.idx, 'category', e.target.value)}
                          >
                            <option value="">未分类</option>
                            {CATEGORIES.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </CompactSelect>
                        </div>
                        <div>
                          <label className="mb-0.5 block text-[10px] text-muted-foreground">优先级</label>
                          <input
                            type="number"
                            value={skill.priority ?? 0}
                            onChange={(e) => updateSkillField(v.idx, 'priority', parseInt(e.target.value, 10) || 0)}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                          />
                        </div>
                      </div>
                      {/* 摘要 */}
                      <div className="mb-2">
                        <label className="mb-0.5 block text-[10px] text-muted-foreground">摘要</label>
                        <input
                          type="text"
                          value={skill.description || ''}
                          onChange={(e) => updateSkillField(v.idx, 'description', e.target.value)}
                          placeholder="技能描述（选填）"
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </div>
                      {/* 标签 */}
                      <div className="mb-2">
                        <label className="mb-0.5 block text-[10px] text-muted-foreground">标签<span className="text-muted-foreground">（逗号分隔）</span></label>
                        <input
                          type="text"
                          value={tagsStr}
                          onChange={(e) => updateSkillField(v.idx, 'tags', e.target.value.split(',').map((s) => s.trim()))}
                          placeholder="标签1, 标签2"
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </div>
                      {/* 正文预览（折叠） */}
                      {skill.content && (
                        <details className="group">
                          <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
                            正文预览（{skill.content.length} 字符）
                          </summary>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-[10px] leading-relaxed text-muted-foreground">{skill.content}</pre>
                        </details>
                      )}
                    </div>
                  )
                })}
                {totalCount > 50 && (
                  <div className="rounded-md border border-border bg-secondary px-3 py-1.5 text-center text-[10px] text-muted-foreground">
                    仅显示前 50 条，共 {totalCount} 条
                  </div>
                )}
              </div>
              {/* 同名处理策略 */}
              <div className="flex items-center justify-between rounded-md border border-border bg-secondary p-3">
                <div>
                  <div className="text-xs font-medium text-foreground">覆盖同名技能</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {overwrite ? '同名的技能将被更新（覆盖原内容）' : '同名的技能将被跳过（仅新增）'}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={overwrite}
                  onClick={() => setOverwrite((p) => !p)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    overwrite ? 'bg-primary' : 'bg-input'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    overwrite ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
              {/* 操作按钮 */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
                >
                  重新选择
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-md border border-primary/40 bg-secondary px-3 py-1.5 text-xs text-primary transition hover:bg-primary/10"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={validCount === 0}
                    className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    确认导入 {validCount} 个有效技能
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 步骤 3：导入中 */}
          {step === 'importing' && (
            <div className="flex flex-col items-center gap-4 py-10">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <div className="text-sm font-medium text-foreground">正在导入技能...</div>
              <div className="text-[11px] text-muted-foreground">共 {totalCount} 个技能，请勿关闭窗口</div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
              </div>
            </div>
          )}

          {/* 步骤 4：完成（导入结果） */}
          {step === 'done' && importResult && (
            <div className="flex flex-col gap-4">
              {/* 结果图标 + 标题 */}
              <div className="flex flex-col items-center gap-2 pt-2">
                <div className={`flex h-14 w-14 items-center justify-center rounded-full ${(importResult.errors?.length || 0) > 0 ? 'bg-warning/20' : 'bg-success/20'}`}>
                  {(importResult.errors?.length || 0) > 0 ? (
                    <AlertTriangle className="h-7 w-7 text-warning" />
                  ) : (
                    <CheckCircle2 className="h-7 w-7 text-success" />
                  )}
                </div>
                <div className="text-sm font-medium text-foreground">
                  {(importResult.errors?.length || 0) > 0 ? '导入完成（部分失败）' : '导入成功'}
                </div>
              </div>
              {/* 统计卡片 */}
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: '新增', value: importResult.created || 0, color: 'text-success', bg: 'bg-success/10 border-success/30' },
                  { label: '更新', value: importResult.updated || 0, color: 'text-primary', bg: 'bg-primary/10 border-primary/30' },
                  { label: '跳过', value: importResult.skipped || 0, color: 'text-muted-foreground', bg: 'bg-secondary border-border' },
                  { label: '错误', value: importResult.errors?.length || 0, color: 'text-destructive', bg: 'bg-destructive/10 border-destructive/30' },
                ].map((s) => (
                  <div key={s.label} className={`rounded-md border p-3 text-center ${s.bg}`}>
                    <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                    <div className="text-[10px] text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>
              {/* 失败记录详情 */}
              {importResult.errors?.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10">
                  <div className="border-b border-warning/30 px-3 py-2 text-[11px] font-medium text-warning">
                    失败记录（{importResult.errors.length} 条）
                  </div>
                  <div className="max-h-40 overflow-y-auto px-3 py-2">
                    {importResult.errors.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 border-b border-warning/20 py-1.5 text-[11px] last:border-0">
                        <span className="mt-0.5 shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">{i + 1}</span>
                        <span className="text-warning/90">{e}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* 操作按钮 */}
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {/* 步骤 5：失败 */}
          {step === 'error' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/20">
                <AlertTriangle className="h-7 w-7 text-destructive" />
              </div>
              <div className="text-sm font-medium text-foreground">导入失败</div>
              {errorMsg && (
                <div className="max-h-32 w-full overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[11px] text-destructive">
                  {errorMsg}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
                >
                  重新选择文件
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md border border-primary/40 bg-secondary px-3 py-1.5 text-xs text-primary transition hover:bg-primary/10"
                >
                  关闭
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default SkillList
