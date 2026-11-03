import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Undo2, Redo2, Columns3, Rows3, LayoutGrid, ChevronDown,
  CopyPlus, FileCode2, Download, Upload, ClipboardPaste, Rocket,
  ArrowLeft, MoreHorizontal, Sparkles, Maximize, Minimize2,
} from 'lucide-react'
import { useWorkflowStore } from '../store/workflowStore'
import { workflows as workflowsApi } from '../api/client'
import { canEditResource } from '../utils/permissions'
import { inputCls } from './property/FormControls'
import { Modal } from './Dialog'
import { toast } from '../store/toastStore'
import { confirm } from './ConfirmDialog'
import TestRunDrawer from './TestRunDrawer'
import { WORKFLOW_TEMPLATES } from '../constants/workflowTemplates'
import { AutoGrowTextarea } from './ui'

// 简易 JSON → YAML 转换（手写，避免引入新依赖）
// 支持对象/数组/基本类型，缩进 2 空格
function jsonToYaml(data, indent = 0) {
  const pad = '  '.repeat(indent)
  if (data === null || data === undefined) return 'null'
  if (typeof data === 'string') {
    // 含特殊字符或空串则用双引号包裹
    if (data === '' || /[:#\n{}[\]"']/.test(data) || data !== data.trim()) {
      return JSON.stringify(data)
    }
    return data
  }
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]'
    return data.map((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item)
        if (entries.length === 0) return `${pad}- {}`
        return entries.map(([key, val], idx) => {
          const prefix = idx === 0 ? `${pad}- ` : `${pad}  `
          if (val !== null && typeof val === 'object') {
            return `${prefix}${key}:\n${jsonToYaml(val, indent + 2)}`
          }
          return `${prefix}${key}: ${jsonToYaml(val, 0)}`
        }).join('\n')
      }
      if (Array.isArray(item)) {
        return `${pad}-\n${jsonToYaml(item, indent + 1)}`
      }
      return `${pad}- ${jsonToYaml(item, 0)}`
    }).join('\n')
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data)
    if (entries.length === 0) return '{}'
    return entries.map(([key, val]) => {
      if (val !== null && typeof val === 'object') {
        return `${pad}${key}:\n${jsonToYaml(val, indent + 1)}`
      }
      return `${pad}${key}: ${jsonToYaml(val, 0)}`
    }).join('\n')
  }
  return String(data)
}

// 顶部工具栏：标题 + 工作流名称输入 + 保存/试运行/校验/清空/导入/导出 按钮
function Toolbar({ isFullscreen = false, onToggleFullscreen }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const serialize = useWorkflowStore((s) => s.serialize)
  const clearAll = useWorkflowStore((s) => s.clearAll)
  const workflowName = useWorkflowStore((s) => s.workflowName)
  const workflowId = useWorkflowStore((s) => s.workflowId)
  // 资源级 owner 控制：新建工作流可保存（POST），已存在工作流需 can_edit
  const workflowCanEdit = useWorkflowStore((s) => s.workflowCanEdit)
  const workflowCreatedBy = useWorkflowStore((s) => s.workflowCreatedBy)
  const canEdit = !workflowId
    ? true
    : canEditResource({ can_edit: workflowCanEdit, created_by: workflowCreatedBy })
  const setWorkflowName = useWorkflowStore((s) => s.setWorkflowName)
  const setWorkflowId = useWorkflowStore((s) => s.setWorkflowId)
  const markSaved = useWorkflowStore((s) => s.markSaved)
  // 用于导入：直接灌入 nodes/edges
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow)
  // 脏标记：用于导入前提醒
  const isDirty = useWorkflowStore((s) => s.isDirty)
  // 撤销 / 重做 / 自动布局
  const undo = useWorkflowStore((s) => s.undo)
  const redo = useWorkflowStore((s) => s.redo)
  const autoLayout = useWorkflowStore((s) => s.autoLayout)
  const alignToGrid = useWorkflowStore((s) => s.alignToGrid)
  const history = useWorkflowStore((s) => s.history)
  const historyIndex = useWorkflowStore((s) => s.historyIndex)
  // 运行状态：用于显示「运行中」徽章 + 试运行按钮禁用
  const runStatus = useWorkflowStore((s) => s.runStatus)

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < history.length - 1

  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  // 自动布局下拉菜单
  const [layoutOpen, setLayoutOpen] = useState(false)
  // 模板选择下拉菜单
  const [templateOpen, setTemplateOpen] = useState(false)
  // 导入下拉菜单
  const [importOpen, setImportOpen] = useState(false)
  // 导出格式下拉菜单
  const [exportOpen, setExportOpen] = useState(false)
  // 粘贴导入弹窗
  const [pasteOpen, setPasteOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // 工作流发布状态（draft / published / disabled），用于显示状态徽章
  const [workflowStatus, setWorkflowStatus] = useState(null)
  // 发布弹窗
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishNote, setPublishNote] = useState('')

  // 隐藏的文件输入：用于导入 JSON 文件
  const fileInputRef = useRef(null)

  // 拉取工作流状态（draft / published / disabled），用于显示状态徽章
  useEffect(() => {
    let cancelled = false
    async function fetchStatus() {
      if (workflowId == null) {
        setWorkflowStatus(null)
        return
      }
      try {
        const wf = await workflowsApi.get(workflowId)
        if (!cancelled) setWorkflowStatus(wf?.status || 'draft')
      } catch {
        if (!cancelled) setWorkflowStatus(null)
      }
    }
    fetchStatus()
    return () => { cancelled = true }
  }, [workflowId])

  // 调用后端校验接口，返回 { valid, errors, warnings }；失败时抛错由调用方处理
  const handleValidate = async (graphConfig) => {
    const res = await workflowsApi.validate(graphConfig)
    return {
      valid: !!res?.valid,
      errors: Array.isArray(res?.errors) ? res.errors : [],
      warnings: Array.isArray(res?.warnings) ? res.warnings : [],
    }
  }

  // 保存：workflowId 存在则 PUT 更新，否则 POST 新建
  const handleSave = async () => {
    const name = (workflowName || '').trim()
    if (!name) {
      toast.warning('请先填写工作流名称')
      return
    }
    // 保存前校验：errors 阻止保存；warnings 需用户确认
    setSaving(true)
    try {
      let v
      try {
        v = await handleValidate(serialize())
      } catch (err) {
        toast.error(`校验请求失败：${err.message || err}`)
        return
      }
      if (v.errors.length > 0) {
        toast.error('工作流校验未通过：\n\n' + v.errors.join('\n'))
        return
      }
      if (
        v.warnings.length > 0 &&
        !(await confirm({ message: '存在告警：\n' + v.warnings.join('\n') + '\n\n仍要保存吗？', variant: 'warning', confirmText: '确定保存' }))
      ) {
        return
      }
      const body = { name, graph_config: serialize() }
      let data
      if (workflowId) {
        data = await workflowsApi.update(workflowId, body)
      } else {
        data = await workflowsApi.create(body)
        // 新建后回填 workflowId，并同步 URL id 参数
        // 防止刷新页面时 useEffect 检测到无 id 参数而 clearAll 清空画布
        if (data && data.id != null) {
          setWorkflowId(data.id)
          setSearchParams({ id: data.id }, { replace: true })
        }
      }
      // 保存成功后清除脏标记
      markSaved()
      toast.success(`工作流已保存${data && data.id != null ? `（ID: ${data.id}）` : ''}`)
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  // 发布：先保存当前画布 → 创建版本快照 → 切换状态为 published
  // 创建版本时后端会自动从当前工作流读取 graph_config 作为快照
  const handlePublish = async () => {
    const note = publishNote.trim()
    if (!note) {
      toast.warning('请输入版本说明')
      return
    }
    if (!workflowId) {
      toast.warning('请先保存工作流')
      return
    }
    setPublishing(true)
    try {
      // 发布前校验，存在错误则中止
      let v
      try {
        v = await handleValidate(serialize())
      } catch (err) {
        toast.error(`校验请求失败：${err.message || err}`)
        return
      }
      if (v.errors.length > 0) {
        toast.error('工作流校验未通过，无法发布：\n\n' + v.errors.join('\n'))
        return
      }
      // 1. 保存当前画布到工作流（确保版本快照为最新内容）
      const name = (workflowName || '').trim()
      await workflowsApi.update(workflowId, { name, graph_config: serialize() })
      // 2. 基于当前工作流创建版本快照
      await workflowsApi.createVersion(workflowId, note)
      // 3. 切换状态为已发布
      await workflowsApi.updateStatus(workflowId, 'published')
      markSaved()
      setWorkflowStatus('published')
      setPublishOpen(false)
      setPublishNote('')
      toast.success('已发布新版本')
    } catch (err) {
      toast.error(`发布失败：${err.message || err}`)
    } finally {
      setPublishing(false)
    }
  }

  // 独立「检查」按钮：主动调用校验接口并用 alert 展示结果
  const handleCheck = async () => {
    setValidating(true)
    try {
      const v = await handleValidate(serialize())
      if (v.errors.length > 0) {
        toast.error(
          `校验未通过（${v.errors.length} 个错误）：\n\n` +
            v.errors.join('\n') +
            (v.warnings.length > 0
              ? '\n\n告警：\n' + v.warnings.join('\n')
              : '')
        )
      } else {
        toast.success(
          '校验通过' +
            (v.warnings.length > 0
              ? `（${v.warnings.length} 个告警）：\n\n` + v.warnings.join('\n')
              : '，无告警。')
        )
      }
    } catch (err) {
      toast.error(`校验请求失败：${err.message || err}`)
    } finally {
      setValidating(false)
    }
  }

  const handleClear = async () => {
    if (await confirm({ message: '确定要清空画布吗？所有节点与连线将被移除。', variant: 'danger', confirmText: '确定删除' })) {
      clearAll()
    }
  }

  // 导出当前画布为 JSON / YAML 文件（含工作流完整信息）
  // format: 'json' | 'yaml'
  const handleExport = (format = 'json') => {
    setExportOpen(false)
    const graphConfig = serialize()
    // 导出文件包含完整信息：name, graph_config, trigger_type, category, tags, description, variables
    const exportData = {
      _type: 'soar_workflow_export',
      _version: '1.0',
      name: workflowName || '未命名工作流',
      exported_at: new Date().toISOString(),
      trigger_type: 'manual',
      category: '',
      tags: [],
      description: '',
      graph_config: graphConfig,
      variables: graphConfig.variables || [],
    }
    const safeName = (workflowName || 'workflow').replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    let content, mime, ext
    if (format === 'yaml') {
      content = jsonToYaml(exportData)
      mime = 'text/yaml'
      ext = 'yaml'
    } else {
      content = JSON.stringify(exportData, null, 2)
      mime = 'application/json'
      ext = 'json'
    }
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeName}_${Date.now()}.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success(`已导出为 ${format.toUpperCase()} 文件`)
  }

  // 触发文件选择对话框
  const handleImportClick = async () => {
    if (isDirty) {
      if (
        !(await confirm({ message: '当前画布有未保存的变更，导入将覆盖现有内容。确定继续吗？', variant: 'warning', confirmText: '确定' }))
      ) {
        return
      }
    }
    fileInputRef.current?.click()
  }

  // 读取选中的 JSON 文件并灌入画布
  const handleImportFile = (e) => {
    const file = e.target.files?.[0]
    // 清空 input 的 value，便于重复选择同一文件
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result
        const data = JSON.parse(typeof raw === 'string' ? raw : '')
        // 兼容两种格式：导出文件 { name, graph_config } 或纯 graph_config { nodes, edges }
        let name = ''
        let graph = null
        if (data && data.graph_config && (data.graph_config.nodes || data.graph_config.edges)) {
          name = data.name || ''
          graph = data.graph_config
        } else if (data && (data.nodes || data.edges)) {
          graph = data
        } else {
          toast.error('文件格式不正确：未找到 nodes/edges 字段')
          return
        }
        // 灌入 store（清空当前画布并加载导入内容）
        loadWorkflow({
          id: null,
          name: name || `${workflowName || '导入工作流'}_副本`,
          graph_config: graph,
        })
        // 同步 URL（清除 id 参数，因为导入的是新工作流）
        setSearchParams({})
        toast.success('工作流已导入，请检查后点击「保存」以持久化')
      } catch (err) {
        toast.error(`导入失败：${err.message || err}`)
      }
    }
    reader.onerror = () => {
      toast.error('文件读取失败')
    }
    reader.readAsText(file)
  }

  // 另存为新工作流：将当前编辑内容保存为一个新工作流（POST，不传 id）
  // 保存成功后跳转到新工作流编辑器（更新 workflowId 与 URL）
  const handleSaveAsNew = async () => {
    const name = (workflowName || '').trim()
    if (!name) {
      toast.warning('请先填写工作流名称')
      return
    }
    setSaving(true)
    try {
      let v
      try {
        v = await handleValidate(serialize())
      } catch (err) {
        toast.error(`校验请求失败：${err.message || err}`)
        return
      }
      if (v.errors.length > 0) {
        toast.error('工作流校验未通过：\n\n' + v.errors.join('\n'))
        return
      }
      if (
        v.warnings.length > 0 &&
        !(await confirm({ message: '存在告警：\n' + v.warnings.join('\n') + '\n\n仍要另存为新工作流吗？', variant: 'warning', confirmText: '确定保存' }))
      ) {
        return
      }
      // 强制走 create（不传 id），保存为副本
      const body = { name: `${name}_副本`, graph_config: serialize() }
      const data = await workflowsApi.create(body)
      if (data && data.id != null) {
        // 加载新工作流（清空脏标记，刷新 id）
        loadWorkflow({ id: data.id, name: data.name || body.name, graph_config: body.graph_config })
        setSearchParams({ id: data.id }, { replace: true })
      }
      markSaved()
      toast.success(`已另存为新工作流${data && data.id != null ? `（ID: ${data.id}）` : ''}`)
    } catch (err) {
      toast.error(`另存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  // 加载内置模板到画布
  const handleLoadTemplate = async (tpl) => {
    setTemplateOpen(false)
    if (isDirty) {
      if (
        !(await confirm({ message: `当前画布有未保存的变更，加载模板「${tpl.name}」将覆盖现有内容。确定继续吗？`, variant: 'warning', confirmText: '确定加载' }))
      ) {
        return
      }
    }
    loadWorkflow({ id: null, name: tpl.name, graph_config: tpl.template.graph_config })
    setSearchParams({})
    toast.success(`已加载模板：${tpl.name}`)
  }

  // 粘贴文本导入：解析 JSON 文本并灌入画布
  const handleImportText = (text) => {
    try {
      const data = JSON.parse(text)
      let name = ''
      let graph = null
      if (data && data.graph_config && (data.graph_config.nodes || data.graph_config.edges)) {
        name = data.name || ''
        graph = data.graph_config
      } else if (data && (data.nodes || data.edges)) {
        graph = data
      } else {
        toast.error('格式不正确：未找到 nodes/edges 字段')
        return false
      }
      loadWorkflow({
        id: null,
        name: name || `${workflowName || '导入工作流'}_副本`,
        graph_config: graph,
      })
      setSearchParams({})
      setPasteOpen(false)
      toast.success('工作流已导入，请检查后点击「保存」以持久化')
      return true
    } catch (err) {
      toast.error(`导入失败：${err.message || err}`)
      return false
    }
  }

  // 工作流状态徽章：草稿(灰) / 已发布(绿) / 未发布更改(黄) / 已停用(红)
  // 已发布且 isDirty 时表示有未发布的本地改动，显示黄色「未发布更改」徽章
  let statusBadge = null
  if (workflowId != null) {
    let cls, label, dot
    if (workflowStatus === 'published' && isDirty) {
      cls = 'bg-warning/15 text-warning'; label = '未发布更改'; dot = 'bg-warning'
    } else if (workflowStatus === 'published') {
      cls = 'bg-success/15 text-success'; label = '已发布'; dot = 'bg-success'
    } else if (workflowStatus === 'disabled') {
      cls = 'bg-destructive/15 text-destructive'; label = '已停用'; dot = 'bg-destructive'
    } else {
      cls = 'bg-secondary text-muted-foreground'; label = '草稿'; dot = 'bg-muted-foreground'
    }
    statusBadge = (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </span>
    )
  }

  const closeMore = () => setMoreOpen(false)

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/studio')}
          title="返回工作室"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          className={`${inputCls} min-w-0 max-w-[280px] flex-1 text-sm`}
          placeholder="未命名工作流"
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
        />
        {statusBadge}
        {workflowId != null && (
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
            #{workflowId}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-secondary p-0.5">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          title="撤销 (Ctrl+Z)"
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          title="重做 (Ctrl+Y)"
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setLayoutOpen((o) => !o)}
            title="自动布局"
            className="flex h-7 items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <ChevronDown className="h-3 w-3" />
          </button>
          {layoutOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setLayoutOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <button
                  type="button"
                  onClick={() => { autoLayout('horizontal'); setLayoutOpen(false) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <Columns3 className="h-3.5 w-3.5 text-primary" /> 横向布局
                </button>
                <button
                  type="button"
                  onClick={() => { autoLayout('vertical'); setLayoutOpen(false) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <Rows3 className="h-3.5 w-3.5 text-primary" /> 纵向布局
                </button>
                <button
                  type="button"
                  onClick={() => { alignToGrid(20); setLayoutOpen(false) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-primary" /> 对齐网格
                </button>
              </div>
            </>
          )}
        </div>
        {onToggleFullscreen && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? '退出全屏' : '全屏编辑'}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {runStatus === 'running' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            运行中
          </span>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            title="更多操作"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={closeMore} />
              <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <button
                  type="button"
                  onClick={() => { closeMore(); navigate('/workflows/new') }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> 快速创建向导
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => { closeMore(); setTemplateOpen(true) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <FileCode2 className="h-3.5 w-3.5 text-primary" /> 加载模板
                </button>
                <button
                  type="button"
                  onClick={() => { closeMore(); setImportOpen(true) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <Upload className="h-3.5 w-3.5 text-primary" /> 导入
                </button>
                <button
                  type="button"
                  onClick={() => { closeMore(); setExportOpen(true) }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5 text-primary" /> 导出
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => { closeMore(); handleCheck() }}
                  disabled={validating}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  {validating ? '检查中…' : '检查工作流'}
                </button>
                <button
                  type="button"
                  onClick={() => { closeMore(); handleSaveAsNew() }}
                  disabled={saving}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  <CopyPlus className="h-3.5 w-3.5 text-primary" /> 另存为新工作流
                </button>
                <button
                  type="button"
                  onClick={() => { closeMore(); handleClear() }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                >
                  清空画布
                </button>
              </div>
            </>
          )}
        </div>

        {templateOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setTemplateOpen(false)} />
            <div className="absolute right-3 top-12 z-40 w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl">
              <div className="px-2.5 py-1 text-[10px] font-medium text-muted-foreground">内置模板</div>
              {WORKFLOW_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() => handleLoadTemplate(tpl)}
                  className="flex w-full flex-col items-start gap-0.5 rounded px-2.5 py-1.5 text-left transition hover:bg-accent"
                >
                  <span className="text-xs font-medium text-foreground">{tpl.name}</span>
                  <span className="text-[10px] text-muted-foreground">{tpl.description}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {importOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setImportOpen(false)} />
            <div className="absolute right-3 top-12 z-40 w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl">
              <button
                type="button"
                onClick={() => { setImportOpen(false); handleImportClick() }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
              >
                <Upload className="h-3.5 w-3.5 text-primary" /> 从文件导入
              </button>
              <button
                type="button"
                onClick={() => { setImportOpen(false); setPasteOpen(true) }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
              >
                <ClipboardPaste className="h-3.5 w-3.5 text-primary" /> 粘贴文本导入
              </button>
            </div>
          </>
        )}

        {exportOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
            <div className="absolute right-3 top-12 z-40 w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl">
              <button
                type="button"
                onClick={() => handleExport('json')}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
              >
                JSON 格式
              </button>
              <button
                type="button"
                onClick={() => handleExport('yaml')}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground transition hover:bg-accent"
              >
                YAML 格式
              </button>
            </div>
          </>
        )}

        <button
          type="button"
          onClick={() => setTestOpen(true)}
          disabled={runStatus === 'running'}
          title="试运行工作流"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Rocket className="h-3.5 w-3.5" />
          {runStatus === 'running' ? '运行中' : '试运行'}
        </button>
        <button
          type="button"
          onClick={() => setPublishOpen(true)}
          disabled={!workflowId || !canEdit}
          title={!canEdit ? '无编辑权限' : '发布当前工作流为新版本'}
          className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-xs text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          发布
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !canEdit}
          title={!canEdit ? '无编辑权限' : undefined}
          className="btn-primary btn-sm"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {/* 隐藏的文件输入：用于导入 JSON 文件 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportFile}
        className="hidden"
      />

      <TestRunDrawer
        open={testOpen}
        onClose={() => setTestOpen(false)}
      />

      {/* 粘贴文本导入弹窗 */}
      <PasteImportDialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSubmit={handleImportText}
      />

      {/* 发布新版本弹窗：输入版本说明后创建版本并发布 */}
      <Modal
        open={publishOpen}
        title="发布新版本"
        size="sm"
        onClose={() => setPublishOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setPublishOpen(false)} className="btn-secondary btn-sm">
              取消
            </button>
            <button type="button" onClick={handlePublish} disabled={publishing} className="btn-primary btn-sm">
              {publishing ? '发布中…' : '确认发布'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">版本说明（change_note）</label>
          <AutoGrowTextarea
            className={`${inputCls} resize-y`}
            rows={4}
            placeholder="例如：新增告警分流节点，优化封禁逻辑"
            value={publishNote}
            onChange={(e) => setPublishNote(e.target.value)}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            发布将基于当前画布创建一个新版本快照，并将工作流状态置为「已发布」。发布前会自动保存并校验工作流。
          </p>
        </div>
      </Modal>
    </header>
  )
}

// 粘贴文本导入弹窗：用户可粘贴 JSON 文本导入工作流
function PasteImportDialog({ open, onClose, onSubmit }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')

  // 每次打开时重置
  useEffect(() => {
    if (open) {
      setText('')
      setErr('')
    }
  }, [open])

  if (!open) return null

  const handleSubmit = () => {
    if (!text.trim()) {
      setErr('请粘贴工作流 JSON 文本')
      return
    }
    const ok = onSubmit(text)
    if (!ok) {
      setErr('解析失败，请检查 JSON 格式')
    }
  }

  return (
    <Modal
      open={open}
      title="粘贴文本导入工作流"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            取消
          </button>
          <button type="button" onClick={handleSubmit} className="btn-primary btn-sm">
            导入
          </button>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        粘贴工作流 JSON 文本（支持导出文件格式或纯 graph_config），导入后加载到画布。
      </p>
      <AutoGrowTextarea
        className={`${inputCls} resize-y font-mono`}
        rows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{\n  "name": "工作流名称",\n  "graph_config": {\n    "nodes": [...],\n    "edges": [...]\n  }\n}'}
        spellCheck={false}
      />
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </Modal>
  )
}

export default Toolbar
