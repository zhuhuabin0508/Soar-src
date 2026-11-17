import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Puzzle, Braces, Settings, TrendingUp, Package } from 'lucide-react'
import Toolbar from '../components/Toolbar'
import NodeLibrary from '../components/NodeLibrary'
import VariablePanel from '../components/VariablePanel'
import FlowCanvas from '../components/FlowCanvas'
import PropertyPanel from '../components/PropertyPanel'
import WorkflowInspection from '../components/WorkflowInspection'
import WorkflowVersionHistory from '../components/WorkflowVersionHistory'
import RunLogDrawer from '../components/RunLogDrawer'
import { PillTabs } from '../components/ui'
import { useWorkflowStore } from '../store/workflowStore'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { useAutoSave } from '../hooks/useAutoSave'
import { workflows as workflowsApi } from '../api/client'
import { loadStashedWorkflowTemplate } from '../constants/workflowTemplates'

// 工作流编排页：原三栏布局（顶部工具栏 + 左节点库 + 中画布 + 右属性面板）+ 底部日志抽屉
// 支持 URL ?id=xxx 加载已存在的工作流
// 快捷键：Ctrl/Cmd+S 保存、Delete/Backspace 删除选中节点
function WorkflowEditor() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow)
  const clearAll = useWorkflowStore((s) => s.clearAll)
  const workflowId = useWorkflowStore((s) => s.workflowId)
  const isDirty = useWorkflowStore((s) => s.isDirty)
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const workflowName = useWorkflowStore((s) => s.workflowName)
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const removeNode = useWorkflowStore((s) => s.removeNode)

  const editorRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 左侧面板 Tab：节点库 / 全局变量
  const [leftTab, setLeftTab] = useState('library')
  // 右侧面板 Tab：属性 / 监测 / 日志
  const [rightTab, setRightTab] = useState('property')

  // 未保存提示 + 自动保存草稿
  useUnsavedChanges(isDirty)
  const { draft, clearDraft } = useAutoSave(
    `soar_workflow_draft_${workflowId || 'new'}`,
    { nodes, edges, name: workflowName },
    30000
  )

  const idParam = searchParams.get('id')

  // 检测到 ?id= 时从后端拉取工作流并灌入 store
  useEffect(() => {
    let alive = true
    if (!idParam) {
      const tpl = loadStashedWorkflowTemplate()
      if (tpl && alive) {
        loadWorkflow({ id: null, name: tpl.template.name, graph_config: tpl.template.graph_config })
        return () => { alive = false }
      }
      try {
        const aiRaw = sessionStorage.getItem('soar:workflow:ai-draft')
        if (aiRaw && alive) {
          sessionStorage.removeItem('soar:workflow:ai-draft')
          const draft = JSON.parse(aiRaw)
          loadWorkflow({ id: null, name: draft.name, graph_config: draft.graph_config })
          return () => { alive = false }
        }
      } catch { /* ignore */ }
      clearAll()
      return () => {
        alive = false
      }
    }
    // 如果 store 里已经是该 id，不重复加载
    if (workflowId && String(workflowId) === String(idParam)) {
      return () => {
        alive = false
      }
    }
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const wf = await workflowsApi.get(idParam)
        if (!alive) return
        loadWorkflow(wf)
      } catch (err) {
        if (!alive) return
        setError(err.message || '加载工作流失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idParam])

  // 清理 URL 上的 id 参数后跳到空白编辑器
  const handleClearParam = () => {
    setSearchParams({})
    clearAll()
    navigate('/editor')
  }

  // 快捷键：Ctrl/Cmd+S 触发保存按钮点击；Delete/Backspace 删除选中节点
  // 注意：当焦点在 input/textarea/select 中时不拦截 Delete，避免影响文本编辑
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+S / Cmd+S：触发保存
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        const saveBtn = document.querySelector(
          'header button.btn-primary'
        )
        if (saveBtn) saveBtn.click()
        return
      }
      // Delete / Backspace：删除选中节点（仅当焦点不在表单控件中时）
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selectedNodeId
      ) {
        const tag = (e.target?.tagName || '').toLowerCase()
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          e.target?.isContentEditable
        ) {
          return // 不拦截表单内的删除
        }
        e.preventDefault()
        removeNode(selectedNodeId)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedNodeId, removeNode])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.()
      return
    }
    editorRef.current?.requestFullscreen?.().catch(() => {})
  }, [])

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === editorRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  return (
    <div
      ref={editorRef}
      className="workflow-editor-root flex h-full min-h-[calc(100vh-var(--app-header-height))] w-full flex-col overflow-hidden bg-card text-foreground"
    >
      <Toolbar isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />

      {/* 主体三栏：左节点库/变量面板 / 中画布 / 右属性面板 */}
      <div className="workflow-editor-main flex min-h-0 flex-1">
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-card">
          <div className="shrink-0 p-2">
            <PillTabs
              items={[
                { key: 'library', label: '节点库', icon: Puzzle },
                { key: 'variables', label: '变量', icon: Braces },
              ]}
              value={leftTab}
              onChange={setLeftTab}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {leftTab === 'library' ? <NodeLibrary /> : <VariablePanel />}
          </div>
        </aside>
        <main className="relative min-w-0 flex-1 bg-background">
          {loading && (
            <div className="absolute inset-0 z-dropdown flex items-center justify-center bg-background text-sm text-muted-foreground">
              加载工作流中...
            </div>
          )}
          {error && (
            <div className="absolute left-1/2 top-3 z-dropdown -translate-x-1/2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
              <button
                type="button"
                onClick={handleClearParam}
                className="ml-3 rounded border border-destructive px-2 py-0.5 text-xs hover:bg-destructive/10"
              >
                清空并新建
              </button>
            </div>
          )}
          <FlowCanvas isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
        </main>
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-card">
          <div className="shrink-0 p-2">
            <PillTabs
              items={[
                { key: 'property', label: '属性', icon: Settings },
                { key: 'monitor', label: '监测', icon: TrendingUp },
                { key: 'versions', label: '版本', icon: Package },
              ]}
              value={rightTab}
              onChange={setRightTab}
            />
          </div>
          {/* Tab 内容 */}
          <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            {rightTab === 'property' && <PropertyPanel />}
            {rightTab === 'monitor' && (
              <WorkflowInspection workflowId={workflowId} />
            )}
            {rightTab === 'versions' && (
              <WorkflowVersionHistory workflowId={workflowId} />
            )}
          </div>
        </aside>
      </div>

      {/* 底部运行日志抽屉 */}
      <RunLogDrawer />
    </div>
  )
}

export default WorkflowEditor
