import { useEffect, useState, useCallback } from 'react'
import { BookOpen, Trash2, Share2, Pencil, Eye, Shield, ShieldBan, Package, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { agents as agentsApi, isAgentPublished } from '../api/client'
import { Modal } from '../components/Dialog'
import { inputCls } from '../components/property/FormControls'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import {DataTable, Pagination, AutoGrowTextarea } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import { hasPermission, canEditResource, canManageShare } from '../utils/permissions'
import ShareDialog from '../components/ShareDialog'
import BatchShareDialog from '../components/BatchShareDialog'
import { AGENT_TEMPLATES, stashAgentTemplate, stashAgentDsl, teamAgentToPlanInput } from '../constants/agentTemplates'

const TEMPLATE_ICONS = {
  shield: Shield,
  ban: ShieldBan,
  package: Package,
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

// 智能体列表：列出 GET /agents，支持新建/编辑跳转、测试、删除
function AgentList() {
  const navigate = useNavigate()
  const canCreate = hasPermission('agent', 'edit')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 测试相关状态
  const [testOpen, setTestOpen] = useState(false)
  const [testAgent, setTestAgent] = useState(null)
  const [testInput, setTestInput] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [resultErr, setResultErr] = useState('')
  const [resultOpen, setResultOpen] = useState(false)

  // 资源共享设置弹窗
  const [shareOpen, setShareOpen] = useState(false)
  // 批量授权：选中多个智能体后一次性授权给多位用户
  const [batchShareOpen, setBatchShareOpen] = useState(false)
  const [shareResource, setShareResource] = useState(null)

  // 从模板创建
  const [templateOpen, setTemplateOpen] = useState(false)
  const [teamTemplates, setTeamTemplates] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)

  // 列表搜索关键字
  const [{ search }, setFilters] = usePersistedFilters('agent_list', { search: '' })
  const setSearch = (v) => setFilters({ search: v })

  // 筛选 / 分页 / 批量选择
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const [deleting, setDeleting] = useState(false)
  const filteredRows = search
    ? rows.filter((r) => {
        const q = search.toLowerCase()
        return [r.name, r.description].some((v) => (v || '').toLowerCase().includes(q))
      })
    : rows
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  const load = useCallback(async () => {
    try {
      const data = await agentsApi.list()
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

  useEffect(() => {
    if (!templateOpen) return
    let alive = true
    setTeamLoading(true)
    agentsApi.templates()
      .then((data) => { if (alive) setTeamTemplates(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setTeamTemplates([]) })
      .finally(() => { if (alive) setTeamLoading(false) })
    return () => { alive = false }
  }, [templateOpen])

  const handleDelete = async (id, name) => {
    const _ok = await confirm({ message: `确定删除智能体「${name || id}」吗？`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await agentsApi.remove(id)
      setRows((prev) => prev.filter((r) => r.id !== id))
      setSelectedKeys((prev) => prev.filter((k) => k !== id))
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个智能体吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await agentsApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个智能体`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 打开测试弹窗
  const openTest = (agent) => {
    setTestAgent(agent)
    setTestInput('')
    setTestOpen(true)
  }

  // 执行测试：POST /agents/{id}/test body={input}
  const handleTest = async () => {
    if (!testAgent) return
    setRunning(true)
    setResultErr('')
    try {
      const res = await agentsApi.test(testAgent.id, testInput)
      setResult(res)
      setResultOpen(true)
      setTestOpen(false)
    } catch (err) {
      setResultErr(err.message || String(err))
      setResultOpen(true)
      setTestOpen(false)
    } finally {
      setRunning(false)
    }
  }

  // 表格列定义
  const columns = [
    { key: 'id', header: 'ID', width: '70px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
    { key: 'name', header: '名称', render: (r) => (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="truncate text-foreground">{r.name || '-'}</span>
        {!isAgentPublished(r) && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">草稿</span>
        )}
      </span>
    ) },
    {
      key: 'description', header: '描述',
      render: (r) => <span className="truncate text-muted-foreground" title={r.description || ''}>{r.description || '-'}</span>,
    },
    { key: 'model_config_id', header: '模型配置', width: '120px', render: (r) => <span className="truncate text-muted-foreground">{r.model_config_id ?? '-'}</span> },
    { key: 'max_iterations', header: '迭代上限', width: '100px', numeric: true, render: (r) => <span className="text-muted-foreground">{r.max_iterations ?? '-'}</span> },
    { key: 'updated_at', header: '更新时间', width: '170px', render: (r) => <span className="text-muted-foreground">{fmtTime(r.updated_at)}</span> },
    {
      key: '__actions', header: '操作', width: '410px',
      render: (r) => {
        const canEdit = canEditResource(r)
        const canShare = canManageShare(r)
        return (
          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => navigate(`/agents/${r.id}/edit`)} className="btn-secondary btn-sm inline-flex items-center gap-1" title={canEdit ? '编辑' : '查看'}>
              {canEdit ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              <span>{canEdit ? '编辑' : '查看'}</span>
            </button>
            <button type="button" onClick={() => navigate(`/agents/${r.id}/monitor`)} className="btn-secondary btn-sm">监控</button>
            <button type="button" disabled={running && testAgent?.id === r.id} onClick={() => openTest(r)} className="btn-secondary btn-sm">测试</button>
            {canShare && (
              <button type="button" onClick={() => { setShareResource(r); setShareOpen(true) }} className="btn-secondary btn-sm inline-flex items-center gap-1" title="共享给其他用户">
                <Share2 className="h-3.5 w-3.5" />共享
              </button>
            )}
            {canEdit && !isAgentPublished(r) && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await agentsApi.publish(r.id)
                    toast.success('已发布')
                    await load()
                  } catch (err) {
                    toast.error(err.message || '发布失败')
                  }
                }}
                className="btn-primary btn-sm"
              >
                发布
              </button>
            )}
            {canEdit && (
              <button type="button" onClick={() => handleDelete(r.id, r.name)} className="btn-danger btn-sm">删除</button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-foreground">智能体</h1>
          <span className="text-xs text-muted-foreground">共 {filteredRows.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="btn-secondary btn-sm"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => navigate('/agent-tutorial')}
            className="btn-secondary btn-sm"
            title="查看智能体配置教程"
          >
            <span className="flex items-center gap-1.5">
              <BookOpen className="h-4 w-4" />
              使用教程
            </span>
          </button>
          {canCreate && (
            <button
              type="button"
              onClick={() => setTemplateOpen(true)}
              className="btn-primary btn-sm inline-flex items-center gap-1.5"
            >
              <Sparkles className="h-4 w-4" />
              + 新建智能体
            </button>
          )}
        </div>
      </header>

      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <FilterBar
          search={{ value: search, onChange: (v) => { setSearch(v); setPage(1) }, placeholder: '搜索名称 / 描述...' }}
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
            onRowClick={(r) => navigate(`/agents/${r.id}/edit`)}
            rowClickHint="点击编辑"
            emptyText="暂无智能体"
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

      {/* 测试输入弹窗 */}
      <Modal
        open={testOpen}
        title={`测试智能体${testAgent ? `：${testAgent.name || ''}` : ''}`}
        onClose={() => setTestOpen(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setTestOpen(false)}
              className="btn-secondary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={running}
              className="btn-primary"
            >
              {running ? '运行中…' : '开始测试'}
            </button>
          </>
        }
      >
        <label className="mb-1 block text-xs text-muted-foreground">输入文本（input）</label>
        <AutoGrowTextarea
          className={`${inputCls} resize-y`}
          rows={5}
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="请输入待测试的告警/事件描述…"
        />
      </Modal>

      {/* 测试结果弹窗 */}
      <Modal
        open={resultOpen}
        title="智能体测试结果"
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
            <div className="grid w-full grid-cols-2 gap-4">
              <div className="rounded-md border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">decision</div>
                <div className="mt-1 font-mono text-sm text-primary">
                  {result?.decision ?? '-'}
                </div>
              </div>
              <div className="rounded-md border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">target_ip</div>
                <div className="mt-1 font-mono text-sm text-foreground">
                  {result?.target_ip ?? '-'}
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">reason</div>
              <div className="mt-1 rounded-md bg-background p-4 text-sm text-foreground ring-1 ring-border">
                {result?.reason || '-'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">duration</div>
              <div className="mt-1 font-mono text-sm text-muted-foreground">{result?.duration ?? '-'}</div>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                推理过程 messages（{(result?.messages || []).length} 条）
              </div>
              <div className="max-h-72 w-full overflow-auto rounded-md bg-background p-4 ring-1 ring-border">
                {(result?.messages || []).length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无消息</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {result.messages.map((m, idx) => (
                      <div key={idx} className="border-b border-border pb-2 last:border-0">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {m.role || '-'}
                          </span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                          {typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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

      {/* 从模板创建 */}
      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="新建智能体 — 选择方式"
        size="lg"
      >
        <p className="mb-4 text-sm text-muted-foreground">
          推荐像 <strong className="font-medium text-foreground">Coze</strong> 一样：先描述需求，系统自动选配工具 → 测试 → 发布或暂存。
        </p>
        <button
          type="button"
          onClick={() => { setTemplateOpen(false); navigate('/agents/quick') }}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 py-3 text-sm font-medium text-primary transition hover:bg-primary/10"
        >
          <Sparkles className="h-4 w-4" />
          用自然语言描述创建（推荐）
        </button>
        {teamLoading ? (
          <p className="mb-4 text-xs text-muted-foreground">正在加载团队模板…</p>
        ) : teamTemplates.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">团队模板</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {teamTemplates.map((agent) => (
                <div
                  key={agent.id}
                  className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <span className="font-medium text-foreground">{agent.name}</span>
                  </div>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {agent.template_scenario || agent.description || '团队共享模板'}
                  </span>
                  {(agent.template_tags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {agent.template_tags.map((tag) => (
                        <span key={tag} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const input = teamAgentToPlanInput(agent)
                        stashAgentDsl(input)
                        setTemplateOpen(false)
                        navigate('/agents/quick')
                      }}
                      className="btn-primary btn-sm flex-1"
                    >
                      描述创建
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        stashAgentDsl(teamAgentToPlanInput(agent).dsl)
                        setTemplateOpen(false)
                        navigate('/agents/new')
                      }}
                      className="btn-secondary btn-sm flex-1"
                    >
                      进编辑器
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">内置场景模板</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_TEMPLATES.map((tpl) => {
            const Icon = TEMPLATE_ICONS[tpl.icon] || Sparkles
            return (
              <div
                key={tpl.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="font-medium text-foreground">{tpl.name}</span>
                </div>
                <span className="text-xs leading-relaxed text-muted-foreground">{tpl.description}</span>
                {tpl.scenario && (
                  <span className="text-[10px] text-muted-foreground">适用：{tpl.scenario}</span>
                )}
                {tpl.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {tpl.tags.map((tag) => (
                      <span key={tag} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                    ))}
                  </div>
                )}
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateOpen(false)
                      navigate(`/agents/quick?template=${tpl.id}`)
                    }}
                    className="btn-primary btn-sm flex-1"
                  >
                    描述创建
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stashAgentTemplate(tpl)
                      setTemplateOpen(false)
                      navigate('/agents/new')
                    }}
                    className="btn-secondary btn-sm flex-1"
                  >
                    进编辑器
                  </button>
                </div>
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => {
              setTemplateOpen(false)
              navigate('/agents/new')
            }}
            className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card p-4 text-left transition hover:border-primary/50 hover:bg-secondary sm:col-span-2"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                <Pencil className="h-4 w-4" />
              </span>
              <span className="font-medium text-foreground">从零开始（高级）</span>
            </div>
            <span className="text-xs leading-relaxed text-muted-foreground">直接进入完整编辑器，适合开发者精细配置</span>
          </button>
        </div>
      </Modal>

      {/* 资源共享设置弹窗 */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="agent"
        resourceId={shareResource?.id}
        resourceName={shareResource?.name}
        ownerUserId={shareResource?.created_by}
      />

      {/* 批量授权弹窗：把选中的多个智能体一次性授权给多位用户 */}
      <BatchShareDialog
        open={batchShareOpen}
        onClose={() => setBatchShareOpen(false)}
        resourceType="agent"
        resources={selectedKeys
          .map((id) => rows.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, name: r.name }))}
        onDone={() => clear()}
      />
    </div>
  )
}

export default AgentList
