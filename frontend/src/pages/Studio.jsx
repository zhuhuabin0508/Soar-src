import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Bot,
  ChevronDown,
  FolderKanban,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react'
import { agents as agentsApi, workflows as workflowsApi, isAgentPublished } from '../api/client'
import { SearchInput, PillTabs } from '../components/ui'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { hasPermission, canEditResource } from '../utils/permissions'

const TABS = [
  { id: 'all', label: '全部' },
  { id: 'agent', label: '智能体' },
  { id: 'workflow', label: '工作流' },
]

function fmtTime(t) {
  if (!t) return ''
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(t)
  }
}

function Studio() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'all'
  const [agents, setAgents] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [menuId, setMenuId] = useState(null)
  const [quickFilter, setQuickFilter] = useState('') // '' | 'published' | 'draft'
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const createMenuRef = useRef(null)
  const cardMenuRef = useRef(null)
  const canCreateAgent = hasPermission('agent', 'edit')
  const canCreateWorkflow = hasPermission('workflow_list', 'edit') || hasPermission('workflow_editor', 'edit')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, w] = await Promise.all([
        hasPermission('agent', 'view') ? agentsApi.list() : Promise.resolve([]),
        hasPermission('workflow_list', 'view') ? workflowsApi.list() : Promise.resolve([]),
      ])
      setAgents(Array.isArray(a) ? a : [])
      setWorkflows(Array.isArray(w) ? w : [])
    } catch (err) {
      toast.error(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 头部「创建」下拉：点击外部关闭（mousedown 监听，不用全屏遮罩）
  useEffect(() => {
    if (!createMenuOpen) return
    const onDocMouseDown = (e) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target)) {
        setCreateMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [createMenuOpen])

  // 卡片操作菜单：点击外部关闭
  useEffect(() => {
    if (!menuId) return
    const onDocMouseDown = (e) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target)) {
        setMenuId(null)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuId])

  // 指标条统计：从现有数据派生，不发额外请求
  const stats = useMemo(
    () => ({
      agents: agents.length,
      workflows: workflows.length,
      published: agents.filter((a) => isAgentPublished(a)).length,
      drafts: agents.filter((a) => !isAgentPublished(a)).length,
    }),
    [agents, workflows]
  )

  const items = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const agentItems = agents.map((row) => ({
      key: `agent-${row.id}`,
      kind: 'agent',
      id: row.id,
      name: row.name || `智能体 ${row.id}`,
      description: row.description || '',
      updated_at: row.updated_at || row.created_at,
      avatar: row.avatar,
      engine: row.engine,
      published: isAgentPublished(row),
      raw: row,
    }))
    const wfItems = workflows.map((row) => ({
      key: `workflow-${row.id}`,
      kind: 'workflow',
      id: row.id,
      name: row.name || `工作流 ${row.id}`,
      description: row.description || '',
      updated_at: row.updated_at || row.created_at,
      status: row.status,
      trigger_type: row.trigger_type,
      raw: row,
    }))
    let list = tab === 'agent' ? agentItems : tab === 'workflow' ? wfItems : [...agentItems, ...wfItems]
    if (quickFilter === 'published') list = list.filter((it) => it.kind === 'agent' && it.published)
    else if (quickFilter === 'draft') list = list.filter((it) => it.kind === 'agent' && !it.published)
    if (kw) {
      list = list.filter(
        (it) =>
          it.name.toLowerCase().includes(kw) ||
          (it.description || '').toLowerCase().includes(kw)
      )
    }
    list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    return list
  }, [agents, workflows, q, tab, quickFilter])

  const openItem = (it) => {
    if (it.kind === 'agent') navigate(`/agents/${it.id}/edit`)
    else navigate(`/editor?id=${it.id}`)
  }

  const chatAgent = (it) => {
    try {
      localStorage.setItem('soar_chat_selected_agent', String(it.id))
    } catch {
    }
    navigate('/chat')
  }

  const handleDelete = async (it) => {
    setMenuId(null)
    const ok = await confirm({
      message: `确定删除${it.kind === 'agent' ? '智能体' : '工作流'}「${it.name}」吗？`,
      variant: 'danger',
      confirmText: '确定删除',
    })
    if (!ok) return
    try {
      if (it.kind === 'agent') await agentsApi.remove(it.id)
      else await workflowsApi.remove(it.id)
      await load()
    } catch (err) {
      toast.error(err.message || '删除失败')
    }
  }

  const hasFilter = q.trim() !== '' || quickFilter !== ''

  const clearFilters = () => {
    setQ('')
    setQuickFilter('')
    setParams({})
  }

  const createAgent = () => navigate('/agents/new')

  const createWorkflow = () => {
    navigate('/workflows/new')
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">工作室</h1>
            {!loading && (
              <span className="text-xs text-muted-foreground">
                共 <span className="font-medium tabular-nums text-foreground">{items.length}</span> 个应用
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasPermission('skill', 'view') && (
            <button
              type="button"
              onClick={() => navigate('/skills')}
              className="btn-secondary btn-sm"
              title="前往技能库"
            >
              <Target className="mr-1 h-3.5 w-3.5" /> 技能库
            </button>
          )}
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新应用列表">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          {(canCreateAgent || canCreateWorkflow) && (
            <div className="relative" ref={createMenuRef}>
              <button
                type="button"
                onClick={() => setCreateMenuOpen((v) => !v)}
                className={`btn-primary btn-sm ${createMenuOpen ? 'ring-1 ring-ring' : ''}`}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> 创建
                <ChevronDown className={`ml-1 h-3 w-3 transition-transform ${createMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {createMenuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-lg">
                  {canCreateAgent && (
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMenuOpen(false)
                        createAgent()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <Bot className="h-3.5 w-3.5 text-primary" /> 新建智能体
                    </button>
                  )}
                  {canCreateWorkflow && (
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMenuOpen(false)
                        createWorkflow()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <FolderKanban className="h-3.5 w-3.5 text-cyan-500" /> 新建工作流
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
        <PillTabs
          items={TABS.map((t) => ({ key: t.id, label: t.label }))}
          value={tab}
          onChange={(id) => setParams(id === 'all' ? {} : { tab: id })}
        />
        <SearchInput
          className="ml-auto w-64"
          value={q}
          onChange={setQ}
          placeholder="搜索应用"
          onClear={() => setQ('')}
        />
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        {/* 状态指标条：分类分布（联动 tab）+ 发布状态 + 右侧汇总，全部从现有数据派生 */}
        {!loading && stats.agents + stats.workflows > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            {[
              { key: 'agent', label: '智能体', dot: 'bg-primary' },
              { key: 'workflow', label: '工作流', dot: 'bg-cyan-500' },
            ].map((chip) => {
              const active = tab === chip.key
              const count = chip.key === 'agent' ? stats.agents : stats.workflows
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setParams(active ? {} : { tab: chip.key })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition-all duration-200 ${
                    active
                      ? 'border-transparent bg-primary/15 text-primary ring-1 ring-primary/40'
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击返回全部应用' : `点击查看${chip.label}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
                  {chip.label}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
            <span className="mx-1 h-4 w-px bg-border" />
            {[
              { key: 'published', label: '已发布', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
              { key: 'draft', label: '草稿', dot: 'bg-warning', active: 'bg-warning/15 text-warning ring-warning/40' },
            ].map((chip) => {
              const active = quickFilter === chip.key
              const count = chip.key === 'published' ? stats.published : stats.drafts
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => {
                    setParams({})
                    setQuickFilter(active ? '' : chip.key)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition-all duration-200 ${
                    active
                      ? `border-transparent ring-1 ${chip.active}`
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该筛选' : `点击筛选${chip.label}的应用`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                      chip.key === 'published' && count > 0 ? 'animate-pulse' : ''
                    }`}
                  />
                  {chip.label}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
            <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="智能体与工作流总数">
                <Layers className="h-3.5 w-3.5 text-primary/80" />
                应用
                <span className="font-semibold tabular-nums text-foreground">
                  {(stats.agents + stats.workflows).toLocaleString()}
                </span>
              </span>
            </div>
          </div>
        )}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 shrink-0 rounded-lg skeleton-shimmer" />
                    <div className="flex-1">
                      <div className="h-4 w-24 rounded skeleton-shimmer" />
                      <div className="mt-1.5 h-3 w-16 rounded skeleton-shimmer" />
                    </div>
                  </div>
                  <div className="h-5 w-5 rounded skeleton-shimmer" />
                </div>
                <div className="mt-3 h-3 w-full rounded skeleton-shimmer" />
                <div className="mt-2 h-3 w-2/3 rounded skeleton-shimmer" />
                <div className="mt-auto flex items-center justify-between pt-4">
                  <div className="h-3 w-24 rounded skeleton-shimmer" />
                  <div className="h-7 w-16 rounded skeleton-shimmer" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="text-sm font-medium text-foreground">
              {hasFilter ? '没有匹配的应用' : '还没有应用'}
            </div>
            <div className="text-xs text-muted-foreground">
              {hasFilter ? '调整关键词或清除筛选条件后再试' : '创建一个智能体，或编排一条工作流'}
            </div>
            {hasFilter ? (
              <button type="button" onClick={clearFilters} className="btn-secondary btn-sm">
                清除筛选
              </button>
            ) : (
              <div className="mt-1 flex gap-2">
                {canCreateAgent && (
                  <button type="button" onClick={createAgent} className="btn-primary btn-sm">
                    <Plus className="mr-1 h-3.5 w-3.5" />创建智能体
                  </button>
                )}
                {canCreateWorkflow && (
                  <button type="button" onClick={createWorkflow} className="btn-secondary btn-sm">
                    创建工作流
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="card-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {items.map((it) => {
              const editable = canEditResource(it.raw)
              return (
                <div
                  key={it.key}
                  className="card-hover group relative flex cursor-pointer flex-col rounded-lg border border-border bg-card p-4 transition hover:border-primary/40"
                  onClick={() => openItem(it)}
                >
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg ${
                          it.kind === 'agent' ? 'bg-primary/15 text-primary' : 'bg-cyan-500/15 text-cyan-500'
                        }`}
                      >
                        {it.avatar ? (
                          <img src={it.avatar} alt="" className="h-full w-full object-cover" />
                        ) : it.kind === 'agent' ? (
                          <Bot className="h-5 w-5" />
                        ) : (
                          <FolderKanban className="h-5 w-5" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{it.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {it.kind === 'agent' ? '智能体' : '工作流'}
                          {it.kind === 'agent' && it.engine ? ` · ${it.engine}` : ''}
                          {it.kind === 'agent' && !it.published ? ' · 草稿' : ''}
                          {it.kind === 'workflow' && it.status ? ` · ${it.status}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="relative shrink-0" ref={menuId === it.key ? cardMenuRef : undefined}>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground opacity-0 transition hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuId(menuId === it.key ? null : it.key)
                        }}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuId === it.key && (
                        <div
                          className="absolute right-0 top-7 z-20 w-36 rounded-md border border-border bg-popover p-1 shadow-lg"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
                            onClick={() => {
                              setMenuId(null)
                              openItem(it)
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            编辑
                          </button>
                          {it.kind === 'agent' && editable && !it.published && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
                              onClick={async () => {
                                setMenuId(null)
                                try {
                                  await agentsApi.publish(it.id)
                                  toast.success('已发布，可在对话中使用')
                                  await load()
                                } catch (err) {
                                  toast.error(err.message || '发布失败')
                                }
                              }}
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              发布
                            </button>
                          )}
                          {editable && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition hover:bg-destructive/10"
                              onClick={() => handleDelete(it)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-[2.5rem] text-xs text-muted-foreground">
                    {it.description || '暂无描述'}
                  </p>
                  <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{fmtTime(it.updated_at)}</span>
                    {it.kind === 'agent' && it.published && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          chatAgent(it)
                        }}
                      >
                        <MessageSquare className="h-3 w-3" />
                        对话
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default Studio
