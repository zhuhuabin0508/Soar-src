// 工作流管理列表：列出 GET /workflows，支持新建、编辑、试运行、删除、
// 收藏、状态生命周期、标签/分类管理、触发方式与运行统计展示、JSON 导入。
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle, Trash2, Star, MoreHorizontal, Copy, Download, Key, FileText,
  Tag, Play, Edit, Eye, Upload, Plus, Rocket, Power, RotateCcw, Share2,
  Activity, MessageSquare, Pencil,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { workflows as workflowsApi } from '../api/client'
import { JsonInputDialog, Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import {DataTable, Pagination, CompactSelect, AutoGrowTextarea } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import { inputCls } from '../components/property/FormControls'
import { hasPermission, canEditResource, canManageShare } from '../utils/permissions'
import ShareDialog from '../components/ShareDialog'
import BatchShareDialog from '../components/BatchShareDialog'
import { WORKFLOW_TEMPLATES } from '../constants/workflowTemplates'

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 格式化平均耗时：<1s 显示 ms，否则显示 s（保留 1 位小数）
function fmtDuration(s) {
  if (s == null || s === '') return '-'
  const n = Number(s)
  if (!Number.isFinite(n)) return '-'
  if (n < 1) return Math.round(n * 1000) + 'ms'
  return n.toFixed(1) + 's'
}

// 触发方式元信息（按需求使用指定色值）
const TRIGGER_META = {
  webhook: { color: '#f59e0b', label: 'Webhook' },
  schedule: { color: '#f97316', label: '定时' },
  event: { color: '#eab308', label: '事件' },
  manual: { color: '#84cc16', label: '手动' },
}

// 状态生命周期徽章
const STATUS_META = {
  draft: { variant: 'neutral', label: '草稿' },
  published: { variant: 'success', label: '已发布' },
  disabled: { variant: 'danger', label: '已停用' },
}

// 业务分类预设
const CATEGORY_PRESETS = ['事件响应', '告警处置', '资产发现', '通知推送']

// 分类 → 徽章配色
function categoryVariant(cat) {
  switch (cat) {
    case '事件响应': return 'info'
    case '告警处置': return 'warning'
    case '资产发现': return 'success'
    case '通知推送': return 'primary'
    default: return 'neutral'
  }
}

// 触发方式徽章
function TriggerBadge({ type }) {
  const m = TRIGGER_META[(type || '').toLowerCase()] || { color: '#6b7280', label: type || '-' }
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: m.color, backgroundColor: m.color + '1a' }}
    >
      {m.label}
    </span>
  )
}

// 最近运行状态徽章：圆点 + 文字
function RunStatusBadge({ status }) {
  const map = {
    success: { dot: 'bg-success', cls: 'text-success', label: '成功' },
    failed: { dot: 'bg-destructive', cls: 'text-destructive', label: '失败' },
    running: { dot: 'bg-warning', cls: 'text-warning', label: '运行中' },
  }
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />未运行
      </span>
    )
  }
  const m = map[status] || { dot: 'bg-muted-foreground', cls: 'text-muted-foreground', label: status }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${m.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />{m.label}
    </span>
  )
}

// 7 天成功率：<80% 红，80-95% 黄，>95% 绿
function SuccessRate({ rate }) {
  if (rate == null || rate === '') return <span className="text-muted-foreground">-</span>
  const pct = Math.round(Number(rate) * 100)
  if (!Number.isFinite(pct)) return <span className="text-muted-foreground">-</span>
  const cls = pct < 80 ? 'text-destructive' : pct <= 95 ? 'text-warning' : 'text-success'
  return <span className={`tabular-nums ${cls}`}>{pct}%</span>
}

// 行操作下拉菜单：低频操作折叠，点击外部关闭
// 使用 React Portal 渲染到 body，避免被父容器 overflow-hidden 裁剪
function RowActions({ row, handlers, canEdit: canEditProp }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const menuRef = useRef(null)

  // 打开菜单时计算位置（按钮下方，右对齐）
  const openMenu = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      // 右对齐按钮，向下展开；若下方空间不足则向上展开
      const top = r.bottom + 4
      const left = r.right
      setMenuPos({ top, left })
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onMouse = (e) => {
      // 点击按钮自身不关闭（由 toggle 处理）；点击菜单外才关闭
      if (btnRef.current && btnRef.current.contains(e.target)) return
      if (menuRef.current && menuRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    // 滚动时关闭菜单（避免位置错位）
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const { onCopy, onExport, onViewSecret, onViewLogs, onMonitor, onEditTags, onChangeStatus, onDelete } = handlers
  // 资源级 owner 控制：非 owner/admin 不展示删除（canEdit 由调用方传入）
  const canEdit = canEditProp !== false

  const items = [
    { icon: Activity, label: '监控', onClick: () => onMonitor(row) },
    { icon: Copy, label: '复制', onClick: () => onCopy(row) },
    { icon: Download, label: '导出', onClick: () => onExport(row) },
    { icon: Key, label: '查看密钥', onClick: () => onViewSecret(row) },
    { icon: FileText, label: '查看日志', onClick: () => onViewLogs(row) },
    { icon: Tag, label: '更新标签', onClick: () => onEditTags(row) },
  ]
  // 状态切换：仅展示与当前状态不同的选项
  const statusItems = []
  if (row.status !== 'published') statusItems.push({ icon: Rocket, label: '发布', onClick: () => onChangeStatus(row, 'published') })
  if (row.status !== 'disabled') statusItems.push({ icon: Power, label: '停用', onClick: () => onChangeStatus(row, 'disabled') })
  if (row.status !== 'draft') statusItems.push({ icon: RotateCcw, label: '转为草稿', onClick: () => onChangeStatus(row, 'draft') })

  const renderItem = (it, danger = false) => (
    <button
      key={it.label}
      type="button"
      onClick={() => { setOpen(false); it.onClick() }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-secondary ${danger ? 'text-destructive' : 'text-foreground'}`}
    >
      <it.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{it.label}</span>
    </button>
  )

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="rounded p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        aria-label="更多操作"
        title="更多操作"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-36 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl"
          style={{ top: `${menuPos.top}px`, left: `${menuPos.left - 144}px` }}
        >
          {items.map((it) => renderItem(it))}
          {statusItems.length > 0 && <div className="my-1 border-t border-border" />}
          {statusItems.map((it) => renderItem(it))}
          {canEdit && (
            <>
              <div className="my-1 border-t border-border" />
              {renderItem({ icon: Trash2, label: '删除', onClick: () => onDelete(row.id, row.name) }, true)}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

// 工作流管理列表
function WorkflowList() {
  const navigate = useNavigate()
  const canCreate = hasPermission('workflow_list', 'edit')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 试运行相关
  const [testOpen, setTestOpen] = useState(false)
  const [testWf, setTestWf] = useState(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [runErr, setRunErr] = useState('')
  const [resultOpen, setResultOpen] = useState(false)

  // webhook 密钥查看/重置
  const [secretOpen, setSecretOpen] = useState(false)
  const [secretWf, setSecretWf] = useState(null)
  const [secretValue, setSecretValue] = useState('')
  const [secretLoading, setSecretLoading] = useState(false)
  const [resetting, setResetting] = useState(false)

  // 标签/分类编辑弹窗
  const [tagOpen, setTagOpen] = useState(false)
  const [tagWf, setTagWf] = useState(null)
  const [tagInput, setTagInput] = useState('')
  const [tagCategory, setTagCategory] = useState('')
  const [tagSaving, setTagSaving] = useState(false)

  // 导入工作流弹窗
  const [importOpen, setImportOpen] = useState(false)

  // 新建方式选择（模板 / 一句话 / 从零）
  const [createOpen, setCreateOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [generatingDraft, setGeneratingDraft] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMeta, setImportMeta] = useState({ name: '', trigger_type: 'manual', category: '', tags: '', description: '' })
  const [importErr, setImportErr] = useState('')
  const [importing, setImporting] = useState(false)

  // 复制中状态
  const [copying, setCopying] = useState(false)

  // 资源共享设置弹窗
  const [shareOpen, setShareOpen] = useState(false)
  // 批量授权：选中多个工作流后一次性授权给多位用户
  const [batchShareOpen, setBatchShareOpen] = useState(false)
  const [shareResource, setShareResource] = useState(null)

  // 筛选条件（持久化）：search + 分类 + 触发方式 + 状态 + 仅看收藏
  const [filters, setFilters] = usePersistedFilters('workflow_list', {
    search: '', category: '', trigger: '', status: '', favoriteOnly: false,
  })
  const { search, category: categoryFilter, trigger: triggerFilter, status: statusFilter, favoriteOnly } = filters

  // 拉取列表
  const load = useCallback(async () => {
    try {
      const data = await workflowsApi.list()
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

  // 删除单个
  const handleDelete = async (id, name) => {
    const _ok = await confirm({ message: `确定删除工作流「${name || id}」吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await workflowsApi.remove(id)
      setSelectedKeys((prev) => prev.filter((k) => k !== id))
      setRows((prev) => prev.filter((r) => r.id !== id))
      toast.success('已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 批量删除
  const [deleting, setDeleting] = useState(false)
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个工作流吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await workflowsApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个工作流`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 跳转编辑器
  const handleEdit = (id) => navigate(`/editor?id=${id}`)

  // 复制工作流
  const handleCopy = async (wf) => {
    if (copying) return
    const _ok = await confirm({ message: `确定复制工作流「${wf.name || wf.id}」吗？将创建一个副本。`, variant: 'info', confirmText: '确定' })
    if (!_ok) return
    setCopying(true)
    try {
      const detail = await workflowsApi.get(wf.id)
      const body = {
        name: `${detail.name || '未命名'}_副本`,
        graph_config: detail.graph_config || { nodes: [], edges: [] },
      }
      await workflowsApi.create(body)
      await load()
      toast.success('工作流已复制')
    } catch (err) {
      toast.error(`复制失败：${err.message || err}`)
    } finally {
      setCopying(false)
    }
  }

  // 导出工作流为 JSON 文件
  const handleExport = async (wf) => {
    try {
      const detail = await workflowsApi.get(wf.id)
      const exportData = {
        _type: 'soar_workflow_export',
        _version: '1.0',
        name: detail.name || '未命名工作流',
        exported_at: new Date().toISOString(),
        graph_config: detail.graph_config || { nodes: [], edges: [] },
      }
      const json = JSON.stringify(exportData, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safeName = (detail.name || 'workflow').replace(/[^\w\u4e00-\u9fa5-]/g, '_')
      a.href = url
      a.download = `${safeName}_${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(`导出失败：${err.message || err}`)
    }
  }

  // 试运行
  const handleTestRun = async (payload) => {
    setTestOpen(false)
    if (!testWf) return
    setRunning(true)
    setRunErr('')
    try {
      const res = await workflowsApi.testRun(testWf.id, payload)
      setRunResult(res)
      setResultOpen(true)
    } catch (err) {
      setRunErr(err.message || String(err))
      setResultOpen(true)
    } finally {
      setRunning(false)
    }
  }

  // 查看 webhook 密钥
  const handleViewSecret = async (wf) => {
    setSecretWf(wf)
    setSecretOpen(true)
    setSecretValue('')
    setSecretLoading(true)
    try {
      const detail = await workflowsApi.get(wf.id)
      setSecretValue(detail.webhook_secret || '(未配置)')
    } catch (err) {
      setSecretValue(`获取失败：${err.message || err}`)
    } finally {
      setSecretLoading(false)
    }
  }

  // 重置密钥
  const handleResetSecret = async () => {
    if (!secretWf) return
    const _ok = await confirm({ message: `确定重置工作流「${secretWf.name || secretWf.id}」的 Webhook 密钥吗？旧密钥将立即失效。`, variant: 'warning', confirmText: '确定' })
    if (!_ok) return
    setResetting(true)
    try {
      const res = await workflowsApi.resetSecret(secretWf.id)
      setSecretValue(res.webhook_secret || '(未返回)')
    } catch (err) {
      toast.error(`重置失败：${err.message || err}`)
    } finally {
      setResetting(false)
    }
  }

  // 复制密钥到剪贴板
  const handleCopySecret = async () => {
    if (!secretValue || secretValue.startsWith('(')) return
    try {
      await navigator.clipboard.writeText(secretValue)
      toast.success('密钥已复制到剪贴板')
    } catch {
      toast.error('复制失败，请手动选择复制')
    }
  }

  // 查看执行日志：跳转日志中心，并按工作流筛选
  const handleViewLogs = (wf) => {
    navigate(`/logs?workflow_id=${wf.id}`)
    toast.info(`已跳转日志中心，已按工作流「${wf.name || wf.id}」筛选`)
  }

  // 跳转工作流监控页
  const handleMonitor = (wf) => {
    navigate(`/workflows/${wf.id}/monitor`)
  }

  // 收藏切换（乐观更新）
  const handleToggleFavorite = async (wf) => {
    const prevFav = !!wf.favorite
    setRows((prev) => prev.map((r) => r.id === wf.id ? { ...r, favorite: !prevFav } : r))
    try {
      await workflowsApi.toggleFavorite(wf.id)
    } catch (err) {
      setRows((prev) => prev.map((r) => r.id === wf.id ? { ...r, favorite: prevFav } : r))
      toast.error(`收藏失败：${err.message || err}`)
    }
  }

  // 状态变更
  const handleUpdateStatus = async (wf, status) => {
    try {
      await workflowsApi.updateStatus(wf.id, status)
      setRows((prev) => prev.map((r) => r.id === wf.id ? { ...r, status } : r))
      toast.success('状态已更新')
    } catch (err) {
      toast.error(`更新失败：${err.message || err}`)
    }
  }

  // 打开标签编辑弹窗
  const handleOpenTagEditor = (wf) => {
    setTagWf(wf)
    setTagInput((Array.isArray(wf.tags) ? wf.tags : []).join(', '))
    setTagCategory(wf.category || '')
    setTagOpen(true)
  }

  // 保存标签与分类
  const handleSaveTags = async () => {
    if (!tagWf) return
    const tags = tagInput.split(',').map((t) => t.trim()).filter(Boolean)
    setTagSaving(true)
    try {
      await workflowsApi.updateTags(tagWf.id, tags, tagCategory)
      setRows((prev) => prev.map((r) => r.id === tagWf.id ? { ...r, tags, category: tagCategory } : r))
      toast.success('标签已更新')
      setTagOpen(false)
    } catch (err) {
      toast.error(`更新失败：${err.message || err}`)
    } finally {
      setTagSaving(false)
    }
  }

  // 选择导入文件：读取内容并尝试预填名称
  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setImportText(text)
      try {
        const obj = JSON.parse(text)
        const name = obj.name || file.name.replace(/\.json$/i, '')
        setImportMeta((m) => ({ ...m, name: m.name || name }))
      } catch { /* 忽略解析错误，用户可在文本框内修正 */ }
    }
    reader.readAsText(file)
    // 清空 value 以便重复选择同一文件
    e.target.value = ''
  }

  // 提交导入
  const handleImport = async () => {
    let graphConfig
    try {
      graphConfig = JSON.parse(importText)
    } catch (err) {
      setImportErr(`JSON 解析失败：${err.message}`)
      return
    }
    // 兼容导出文件信封
    if (graphConfig && graphConfig.graph_config) graphConfig = graphConfig.graph_config
    setImportErr('')
    setImporting(true)
    try {
      const tags = importMeta.tags.split(',').map((t) => t.trim()).filter(Boolean)
      await workflowsApi.import({
        name: importMeta.name || '导入的工作流',
        graph_config: graphConfig,
        trigger_type: importMeta.trigger_type || 'manual',
        category: importMeta.category || '',
        tags,
        description: importMeta.description || '',
      })
      toast.success('工作流已导入')
      setImportOpen(false)
      setImportText('')
      setImportMeta({ name: '', trigger_type: 'manual', category: '', tags: '', description: '' })
      await load()
    } catch (err) {
      toast.error(`导入失败：${err.message || err}`)
    } finally {
      setImporting(false)
    }
  }

  // 按筛选条件过滤 + 收藏置顶（稳定排序）
  const filteredRows = useMemo(() => {
    let arr = rows
    if (search) {
      const kw = search.toLowerCase()
      arr = arr.filter((r) => (r.name || '').toLowerCase().includes(kw))
    }
    if (categoryFilter) arr = arr.filter((r) => r.category === categoryFilter)
    if (triggerFilter) arr = arr.filter((r) => r.trigger_type === triggerFilter)
    if (statusFilter) arr = arr.filter((r) => r.status === statusFilter)
    if (favoriteOnly) arr = arr.filter((r) => r.favorite)
    return [...arr].sort((a, b) => (Number(!!b.favorite) - Number(!!a.favorite)))
  }, [rows, search, categoryFilter, triggerFilter, statusFilter, favoriteOnly])

  // 分类下拉选项：动态合并数据中出现的分类
  const categoryFilterOptions = useMemo(() => {
    const set = new Set(CATEGORY_PRESETS)
    rows.forEach((r) => { if (r.category) set.add(r.category) })
    return [{ value: '', label: '全部分类' }, ...[...set].map((c) => ({ value: c, label: c }))]
  }, [rows])

  // 标签编辑弹窗的分类选项：预设 + 当前值
  const tagCategoryOptions = useMemo(() => {
    const set = new Set(CATEGORY_PRESETS)
    if (tagWf && tagWf.category) set.add(tagWf.category)
    return [...set]
  }, [tagWf])

  // 分页 / 批量选择
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  // 修改筛选并回到第 1 页
  const applyFilter = (patch) => {
    setFilters(patch)
    setPage(1)
  }

  // 行操作聚合 handlers
  const rowActionHandlers = {
    onCopy: handleCopy,
    onExport: handleExport,
    onViewSecret: handleViewSecret,
    onViewLogs: handleViewLogs,
    onMonitor: handleMonitor,
    onEditTags: handleOpenTagEditor,
    onChangeStatus: handleUpdateStatus,
    onDelete: handleDelete,
  }

  // 表格列定义
  const columns = [
    {
      key: '__favorite', header: '', width: '44px',
      render: (r) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggleFavorite(r) }}
          className="rounded p-1 transition hover:bg-secondary"
          aria-label={r.favorite ? '取消收藏' : '收藏'}
          title={r.favorite ? '取消收藏' : '收藏'}
        >
          <Star className={`h-4 w-4 ${r.favorite ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground hover:text-foreground'}`} />
        </button>
      ),
    },
    {
      key: 'id', header: 'ID', width: '80px',
      render: (r) => <span className="truncate font-mono text-primary">#{r.id}</span>,
    },
    {
      key: 'name', header: '名称', width: '220px',
      render: (r) => (
        <div className="flex max-w-[210px] flex-col">
          <span className="truncate text-foreground" title={r.name}>{r.name || '-'}</span>
          {r.description ? (
            <span className="truncate text-[11px] text-muted-foreground" title={r.description}>{r.description}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'trigger_type', header: '触发方式', width: '96px',
      render: (r) => <TriggerBadge type={r.trigger_type} />,
    },
    {
      key: 'category', header: '分类', width: '110px',
      render: (r) => {
        if (!r.category) return <span className="text-xs text-muted-foreground">未分类</span>
        const v = categoryVariant(r.category)
        const cls = v === 'info' ? 'bg-info/15 text-info'
          : v === 'warning' ? 'bg-warning/15 text-warning'
          : v === 'success' ? 'bg-success/15 text-success'
          : v === 'primary' ? 'bg-primary/15 text-primary'
          : 'bg-muted text-muted-foreground'
        return <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{r.category}</span>
      },
    },
    {
      key: 'tags', header: '标签', width: '170px',
      render: (r) => {
        const tags = Array.isArray(r.tags) ? r.tags : []
        if (tags.length === 0) {
          return (
            <button type="button" onClick={(e) => { e.stopPropagation(); handleOpenTagEditor(r) }} className="text-xs text-muted-foreground transition hover:text-foreground" title="点击添加标签">
              添加标签
            </button>
          )
        }
        const shown = tags.slice(0, 3)
        const rest = tags.length - shown.length
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleOpenTagEditor(r) }}
            className="inline-flex max-w-[160px] items-center gap-1 transition hover:opacity-80"
            title="点击编辑标签"
          >
            {shown.map((t, i) => (
              <span key={i} className="truncate rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>
            ))}
            {rest > 0 && <span className="text-[10px] text-muted-foreground">+{rest}</span>}
          </button>
        )
      },
    },
    {
      key: 'status', header: '状态', width: '88px',
      render: (r) => {
        const m = STATUS_META[r.status] || { variant: 'neutral', label: r.status || '-' }
        const cls = m.variant === 'success' ? 'bg-success/15 text-success'
          : m.variant === 'danger' ? 'bg-destructive/15 text-destructive'
          : 'bg-muted text-muted-foreground'
        return <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{m.label}</span>
      },
    },
    {
      key: 'last_run_status', header: '最近运行', width: '100px',
      render: (r) => <RunStatusBadge status={r.last_run_status} />,
    },
    {
      key: 'last_run_at', header: '最近运行时间', width: '160px',
      render: (r) => <span className="text-muted-foreground">{fmtTime(r.last_run_at)}</span>,
    },
    {
      key: 'today_count', header: '今日执行', width: '88px', numeric: true,
      render: (r) => {
        const n = Number(r.today_count) || 0
        return n === 0
          ? <span className="tabular-nums text-muted-foreground">0</span>
          : <span className="tabular-nums text-foreground">{n}</span>
      },
    },
    {
      key: 'success_rate_7d', header: '7天成功率', width: '100px', numeric: true,
      render: (r) => <SuccessRate rate={r.success_rate_7d} />,
    },
    {
      key: 'avg_duration_seconds', header: '平均耗时', width: '90px', numeric: true,
      render: (r) => <span className="tabular-nums text-foreground">{fmtDuration(r.avg_duration_seconds)}</span>,
    },
    {
      key: 'updated_at', header: '更新时间', width: '160px',
      render: (r) => <span className="text-muted-foreground">{fmtTime(r.updated_at)}</span>,
    },
    {
      key: '__actions', header: '操作', width: '305px',
      render: (r) => {
        const canEdit = canEditResource(r)
        const canShare = canManageShare(r)
        return (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => handleEdit(r.id)}
              className="btn-secondary btn-sm inline-flex items-center gap-1"
              title={canEdit ? '编辑' : '查看'}
            >
              {canEdit ? <Edit className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>{canEdit ? '编辑' : '查看'}</span>
            </button>
            {canShare && (
              <button
                type="button"
                onClick={() => { setShareResource(r); setShareOpen(true) }}
                className="btn-secondary btn-sm inline-flex items-center gap-1"
                title="共享给其他用户"
              >
                <Share2 className="h-3.5 w-3.5" />共享
              </button>
            )}
            <button
              type="button"
              disabled={running && testWf?.id === r.id}
              onClick={() => { setTestWf(r); setTestOpen(true) }}
              className="btn-secondary btn-sm inline-flex items-center gap-1"
            >
              <Play className="h-3.5 w-3.5" />试运行
            </button>
            <RowActions row={r} handlers={rowActionHandlers} canEdit={canEdit} />
          </div>
        )
      },
    },
  ]

  const triggerFilterOptions = [
    { value: '', label: '全部触发方式' },
    { value: 'webhook', label: 'Webhook' },
    { value: 'schedule', label: '定时' },
    { value: 'event', label: '事件' },
    { value: 'manual', label: '手动' },
  ]
  const statusFilterOptions = [
    { value: '', label: '全部状态' },
    { value: 'draft', label: '草稿' },
    { value: 'published', label: '已发布' },
    { value: 'disabled', label: '已停用' },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">工作流管理</h1>
          <span className="text-xs text-muted-foreground">共 {filteredRows.length} 个</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm">刷新</button>
          <button
            type="button"
            onClick={() => { setImportErr(''); setImportOpen(true) }}
            className="btn-secondary btn-sm inline-flex items-center gap-1"
          >
            <Upload className="h-3.5 w-3.5" />导入
          </button>
          {canCreate && (
            <button
              type="button"
              onClick={() => { setAiPrompt(''); setCreateOpen(true) }}
              className="btn-primary btn-sm inline-flex items-center gap-1"
            >
              <Plus className="h-3.5 w-3.5" />新建工作流
            </button>
          )}
        </div>
      </header>

      {/* 内容滚动区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <FilterBar
          search={{
            value: search,
            onChange: (v) => applyFilter({ search: v }),
            placeholder: '搜索工作流名称...',
          }}
          filters={[
            { key: 'category', label: '分类', value: categoryFilter, onChange: (v) => applyFilter({ category: v }), options: categoryFilterOptions },
            { key: 'trigger', label: '触发', value: triggerFilter, onChange: (v) => applyFilter({ trigger: v }), options: triggerFilterOptions },
            { key: 'status', label: '状态', value: statusFilter, onChange: (v) => applyFilter({ status: v }), options: statusFilterOptions },
          ]}
          actions={
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                checked={!!favoriteOnly}
                onChange={(e) => applyFilter({ favoriteOnly: e.target.checked })}
              />
              <Star className={`h-3.5 w-3.5 ${favoriteOnly ? 'fill-amber-400 text-amber-400' : ''}`} />
              <span>仅看收藏</span>
            </label>
          }
        />
        <div className="overflow-hidden rounded-lg border border-border">
          <DataTable
            columns={columns}
            data={paged}
            loading={loading}
            selectable
            selectedKeys={selectedKeys}
            onSelectChange={setSelectedKeys}
            rowKey="id"
            onRowClick={(r) => handleEdit(r.id)}
            rowClickHint="点击编辑"
            emptyText="暂无工作流，点击右上角「新建工作流」创建"
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
            { key: 'share', label: '批量授权', icon: Share2, variant: 'default', onClick: () => setBatchShareOpen(true) },
            { key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting },
          ]}
        />
      </div>

      {/* 试运行输入弹窗 */}
      <JsonInputDialog
        open={testOpen}
        title={`试运行工作流「${testWf?.name || ''}」 · 输入示例 payload（JSON）`}
        onClose={() => setTestOpen(false)}
        onSubmit={handleTestRun}
        submitText="开始运行"
      />

      {/* 试运行结果弹窗 */}
      <Modal
        open={resultOpen}
        title={`试运行结果${testWf ? `：${testWf.name || ''}` : ''}`}
        onClose={() => setResultOpen(false)}
        maxWidth="max-w-3xl"
        footer={
          <button type="button" onClick={() => setResultOpen(false)} className="btn-primary">关闭</button>
        }
      >
        {runErr ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {runErr}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="text-sm text-muted-foreground">
              状态：<span className="font-mono text-primary">{runResult?.status || '-'}</span>
              {runResult?.execution_id != null && (
                <span className="ml-3 text-xs text-muted-foreground">execution_id: {runResult.execution_id}</span>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                节点轨迹（{(runResult?.traces || []).length} 个）
              </div>
              <div className="max-h-72 w-full overflow-auto rounded-md bg-background p-3 ring-1 ring-border">
                {(runResult?.traces || []).length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无轨迹</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {runResult.traces.map((tr, idx) => (
                      <div key={idx} className="rounded-md border border-border bg-card p-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-foreground">
                            {tr.node_label || tr.node_type || `节点 ${tr.node_id}`}
                          </span>
                          <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                            {tr.status || '-'}
                          </span>
                        </div>
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                          {typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                日志（{(runResult?.logs || []).length} 条）
              </div>
              <div className="max-h-64 w-full overflow-auto rounded-md bg-background p-3 ring-1 ring-border">
                {(runResult?.logs || []).length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无日志</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {runResult.logs.map((log, idx) => (
                      <div key={idx} className="font-mono text-xs">
                        <span className="mr-2 text-muted-foreground">[{(log.level || 'info').toUpperCase()}]</span>
                        {log.node_id && (
                          <span className="mr-2 text-primary">[{log.node_id}]</span>
                        )}
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

      {/* Webhook 密钥查看/重置弹窗 */}
      <Modal
        open={secretOpen}
        title={`Webhook 密钥${secretWf ? `：${secretWf.name || ''}` : ''}`}
        onClose={() => setSecretOpen(false)}
        maxWidth="max-w-xl"
        footer={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopySecret}
              disabled={secretLoading || !secretValue || secretValue.startsWith('(')}
              className="btn-secondary btn-sm"
            >
              复制密钥
            </button>
            <button
              type="button"
              onClick={handleResetSecret}
              disabled={resetting || secretLoading}
              className="btn-secondary btn-sm"
            >
              {resetting ? '重置中...' : '重置密钥'}
            </button>
            <button type="button" onClick={() => setSecretOpen(false)} className="btn-primary btn-sm">
              关闭
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-border bg-background p-4">
            <div className="mb-1 text-xs text-muted-foreground">调用 webhook 时需在请求头携带：</div>
            <div className="font-mono text-[11px] text-primary">
              X-Webhook-Secret: &lt;下方密钥&gt;
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Webhook 密钥</div>
            {secretLoading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : (
              <div className="max-h-32 overflow-auto rounded-md bg-background p-3 ring-1 ring-border">
                <code className="break-all font-mono text-xs text-warning">
                  {secretValue || '-'}
                </code>
              </div>
            )}
          </div>
          <div className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning/80">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>密钥仅在工作流启用且请求头匹配时允许触发。重置后旧密钥立即失效，需同步更新调用方配置。</span>
          </div>
        </div>
      </Modal>

      {/* 标签 / 分类编辑弹窗 */}
      <Modal
        open={tagOpen}
        title={`编辑标签与分类${tagWf ? `：${tagWf.name || ''}` : ''}`}
        onClose={() => setTagOpen(false)}
        maxWidth="max-w-md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setTagOpen(false)} className="btn-secondary btn-sm">取消</button>
            <button type="button" disabled={tagSaving} onClick={handleSaveTags} className="btn-primary btn-sm">
              {tagSaving ? '保存中...' : '保存'}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">分类</label>
            <CompactSelect
              size="lg"
              block
              value={tagCategory}
              onChange={(e) => setTagCategory(e.target.value)}
            >
              <option value="">未分类</option>
              {tagCategoryOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </CompactSelect>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">标签（多个用英文逗号分隔）</label>
            <input
              type="text"
              className={inputCls}
              placeholder="例如：重保, 巡检"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">输入标签后按逗号分隔，保存时自动去除空项。</p>
          </div>
        </div>
      </Modal>

      {/* 导入工作流弹窗 */}
      <Modal
        open={importOpen}
        title="导入工作流"
        onClose={() => setImportOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setImportOpen(false)} className="btn-secondary btn-sm">取消</button>
            <button type="button" disabled={importing || !importText} onClick={handleImport} className="btn-primary btn-sm">
              {importing ? '导入中...' : '开始导入'}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <label className="btn-secondary btn-sm inline-flex cursor-pointer items-center gap-1">
              <Upload className="h-3.5 w-3.5" />选择 JSON 文件
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
            </label>
            <span className="text-[11px] text-muted-foreground">选择文件后会自动填入下方文本框，可手动编辑。</span>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">graph_config（JSON）</label>
            <AutoGrowTextarea
              className={`${inputCls} resize-y font-mono`}
              rows={8}
              placeholder='{\n  "nodes": [],\n  "edges": []\n}'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
            />
            {importErr && <p className="mt-1 text-xs text-destructive">{importErr}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">名称</label>
              <input
                type="text"
                className={inputCls}
                placeholder="导入的工作流"
                value={importMeta.name}
                onChange={(e) => setImportMeta((m) => ({ ...m, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">触发方式</label>
              <CompactSelect
                size="lg"
                block
                value={importMeta.trigger_type}
                onChange={(e) => setImportMeta((m) => ({ ...m, trigger_type: e.target.value }))}
              >
                <option value="webhook">Webhook</option>
                <option value="schedule">定时</option>
                <option value="event">事件</option>
                <option value="manual">手动</option>
              </CompactSelect>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">分类</label>
              <CompactSelect
                size="lg"
                block
                value={importMeta.category}
                onChange={(e) => setImportMeta((m) => ({ ...m, category: e.target.value }))}
              >
                <option value="">未分类</option>
                {CATEGORY_PRESETS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </CompactSelect>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">标签（逗号分隔）</label>
              <input
                type="text"
                className={inputCls}
                placeholder="例如：重保, 巡检"
                value={importMeta.tags}
                onChange={(e) => setImportMeta((m) => ({ ...m, tags: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">描述</label>
            <AutoGrowTextarea
              className={`${inputCls} resize-y`}
              rows={2}
              placeholder="可选"
              value={importMeta.description}
              onChange={(e) => setImportMeta((m) => ({ ...m, description: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      {/* 新建工作流：模板 / 一句话 / 从零（借鉴 n8n AI Workflow Builder + Shuffle 模板库） */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建工作流 — 选择方式"
        size="lg"
      >
        <div className="mb-4 rounded-lg border border-border bg-muted p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <MessageSquare className="h-4 w-4 text-primary" />
            用一句话描述流程（AI 草稿 PoC）
          </div>
          <AutoGrowTextarea
            className={`${inputCls} resize-y`}
            rows={2}
            placeholder="例如：收到告警后研判源 IP，若高风险则封禁并通知值班"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
          />
          <button
            type="button"
            disabled={!aiPrompt.trim() || generatingDraft}
            onClick={async () => {
              setGeneratingDraft(true)
              try {
                setCreateOpen(false)
                setAiPrompt('')
                navigate(`/workflows/new?mode=describe&q=${encodeURIComponent(aiPrompt.trim())}`)
              } catch (err) {
                toast.error(err.message || '生成草稿失败')
              } finally {
                setGeneratingDraft(false)
              }
            }}
            className="btn-primary btn-sm mt-2"
          >
            {generatingDraft ? '生成中…' : '生成草稿并打开画布'}
          </button>
          <p className="mt-1 text-[10px] text-muted-foreground">草稿保存到服务端（status=draft）；当前为规则化骨架生成，后续可接入 LLM。</p>
        </div>

        <p className="mb-3 text-sm text-muted-foreground">或从内置模板开始：</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {WORKFLOW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              onClick={() => {
                setCreateOpen(false)
                navigate(`/workflows/new?template=${tpl.key}`)
              }}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="text-sm font-medium text-foreground">{tpl.name}</span>
              <span className="text-xs text-muted-foreground">{tpl.description}</span>
              {tpl.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tpl.tags.map((tag) => (
                    <span key={tag} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setCreateOpen(false)
            navigate('/workflows/new')
          }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
        >
          <Pencil className="h-4 w-4" />
          打开快速创建向导
        </button>
      </Modal>

      {/* 资源共享设置弹窗 */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="workflow"
        resourceId={shareResource?.id}
        resourceName={shareResource?.name}
        ownerUserId={shareResource?.created_by}
      />

      {/* 批量授权弹窗：把选中的多个工作流一次性授权给多位用户 */}
      <BatchShareDialog
        open={batchShareOpen}
        onClose={() => setBatchShareOpen(false)}
        resourceType="workflow"
        resources={selectedKeys
          .map((id) => rows.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, name: r.name }))}
        onDone={() => clear()}
      />
    </div>
  )
}

export default WorkflowList
