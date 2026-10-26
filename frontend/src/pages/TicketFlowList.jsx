// 工单流程模板列表页：模板 CRUD + 发布 + 启停 + 导入导出
// - 发布前必须通过服务端结构校验（节点/字段/路由/分组绑定）
// - 已发布的模板被编辑后自动回到草稿态，需重新发布才能发起工单
// - 导出：模板名称/描述/nodes 导出为 JSON；导入：JSON 创建为草稿副本，检查后重新发布
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitGraph, Plus, Pencil, Trash2, Rocket, FileJson, Power, Download, Upload, RefreshCw, MoreVertical } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Button, PageContainer, DataTable, Pagination, EmptyState } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import ticketApi from '../api/tickets'

export default function TicketFlowList() {
  const canEdit = hasPermission('ticket_config', 'edit')
  const navigate = useNavigate()

  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [publishingId, setPublishingId] = useState(null)
  const [togglingId, setTogglingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // 行内「更多」下拉菜单（ref + document 监听点击外部关闭，不用全屏遮罩避免拦截交互）
  const [rowMenuId, setRowMenuId] = useState(null)
  const rowMenuRef = useRef(null)
  useEffect(() => {
    if (rowMenuId == null) return
    const onDocMouseDown = (e) => {
      if (rowMenuRef.current && !rowMenuRef.current.contains(e.target)) {
        setRowMenuId(null)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [rowMenuId])

  const load = useCallback(() => {
    setLoading(true)
    ticketApi.listFlows()
      .then((res) => { setList(res.items || []); setTotal(res.items?.length || 0) })
      .catch((e) => toast.error(e.message || '加载流程模板失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const openNew = () => navigate('/ticket-config/flows/new')

  const openEdit = (row) => navigate(`/ticket-config/flows/${row.id}/edit`)

  const handlePublish = (row) => {
    confirm({
      title: '发布流程模板',
      message: `确认发布「${row.name}」？发布后将校验流程结构（节点/字段/路由/分组绑定），校验通过后即可发起工单；已发起的工单不受影响。`,
      confirmText: '发布',
    }).then((ok) => {
      if (!ok) return
      setPublishingId(row.id)
      ticketApi.publishFlow(row.id)
        .then(() => { toast.success(`模板已发布（v${(row.version || 0) + 1}）`); load() })
        .catch((e) => toast.error(e.message || '发布失败，请检查流程结构'))
        .finally(() => setPublishingId(null))
    })
  }

  const handleToggle = (row) => {
    setTogglingId(row.id)
    ticketApi.updateFlow(row.id, { enabled: !row.enabled })
      .then(() => { toast.success(row.enabled ? '已停用' : '已启用'); load() })
      .catch((e) => toast.error(e.message || '操作失败'))
      .finally(() => setTogglingId(null))
  }

  const handleDelete = (row) => {
    confirm({
      title: '删除流程模板',
      message: `确认删除「${row.name}」？已被工单引用的模板无法删除。不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setDeletingId(row.id)
      ticketApi.deleteFlow(row.id)
        .then(() => { toast.success('模板已删除'); load() })
        .catch((e) => toast.error(e.message || '删除失败'))
        .finally(() => setDeletingId(null))
    })
  }

  // 导出：拉取模板详情，名称/描述/nodes 序列化为 JSON 文件下载
  const exportFlow = (row) => {
    ticketApi.getFlow(row.id)
      .then((f) => {
        const payload = { name: f.name, description: f.description || '', nodes: f.nodes || {} }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `流程模板-${f.name}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success(`模板「${f.name}」已导出`)
      })
      .catch((e) => toast.error(e.message || '导出失败'))
  }

  // 导入：解析 JSON → 结构校验 → 重名加后缀 → 创建为草稿副本（检查后手动发布）
  const importRef = useRef(null)
  const [importing, setImporting] = useState(false)

  const handleImportFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) return toast.error('请选择 .json 模板文件')
    const reader = new FileReader()
    reader.onload = () => {
      let data
      try { data = JSON.parse(reader.result) } catch { return toast.error('文件不是合法的 JSON，无法导入') }
      const name = typeof data?.name === 'string' ? data.name.trim() : ''
      const nodes = data?.nodes
      if (!name) return toast.error('模板文件缺少 name 字段，无法导入')
      if (!nodes || typeof nodes !== 'object' || !Array.isArray(nodes.nodes)) {
        return toast.error('模板文件缺少节点定义（nodes.nodes 数组），无法导入')
      }
      // 与现有模板重名时自动加后缀，避免混淆
      const names = new Set(list.map((r) => r.name))
      const finalName = names.has(name) ? `${name}（导入）` : name
      confirm({
        title: '导入流程模板',
        message: `将导入模板「${name}」为草稿副本「${finalName}」。导入后请检查节点与分组配置，确认无误后手动发布。`,
        confirmText: '导入',
      }).then((ok) => {
        if (!ok) return
        setImporting(true)
        ticketApi.createFlow({ name: finalName, description: typeof data.description === 'string' ? data.description : '', nodes })
          .then(() => { toast.success(`模板「${finalName}」已导入（草稿），请检查后发布`); load() })
          .catch((err) => toast.error(err.message || '导入失败'))
          .finally(() => setImporting(false))
      })
    }
    reader.onerror = () => toast.error('读取文件失败')
    reader.readAsText(file, 'utf-8')
  }

  const columns = [
    {
      key: 'name', header: '模板名称',
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileJson className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{r.name}</span>
              {r.is_draft
                ? <span className="shrink-0 rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">草稿</span>
                : <span className="shrink-0 rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">已发布 v{r.version}</span>}
            </div>
            {r.description && <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.description}</div>}
          </div>
        </div>
      ),
    },
    {
      key: 'node_count', header: '节点数', width: '90px', numeric: true,
      render: (r) => (
        <span className={r.node_count ? '' : 'text-muted-foreground'} title={r.node_count == null ? '未统计' : undefined}>
          {r.node_count == null ? '--' : r.node_count.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'ticket_count', header: '工单数', width: '90px', numeric: true,
      render: (r) => (
        <span className={r.ticket_count ? '' : 'text-muted-foreground'} title={r.ticket_count == null ? '未统计' : undefined}>
          {r.ticket_count == null ? '--' : r.ticket_count.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'enabled', header: '状态', width: '90px',
      render: (r) => (
        <span className={`inline-flex whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${r.enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
          {r.enabled ? '启用' : '停用'}
        </span>
      ),
    },
    {
      key: 'updated_at', header: '更新时间', width: '160px',
      render: (r) => <span className="tabular-nums text-muted-foreground">{r.updated_at ? new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</span>,
    },
    {
      // 操作收敛：高频「编辑 / 发布」平铺，导出 / 停用 / 删除收进「更多」下拉（规范：>3 个操作收敛）
      key: 'actions', header: '操作', width: '235px',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
          {canEdit ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); openEdit(r) }} className="btn-secondary btn-sm" title="编辑流程">
                <Pencil className="h-3 w-3" />编辑
              </button>
              <button onClick={(e) => { e.stopPropagation(); handlePublish(r) }} disabled={publishingId === r.id}
                className="btn-secondary btn-sm" title={r.is_draft ? '发布后才能发起工单' : '重新发布'}>
                <Rocket className="h-3 w-3" />{publishingId === r.id ? '发布中' : '发布'}
              </button>
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setRowMenuId(rowMenuId === r.id ? null : r.id)}
                  className={`btn-secondary btn-sm !px-2 ${rowMenuId === r.id ? 'ring-1 ring-ring' : ''}`} title="更多操作">
                  <MoreVertical className="h-3 w-3" />
                </button>
                {rowMenuId === r.id && (
                  <div ref={rowMenuRef} className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-border bg-popover p-1 shadow-lg">
                    <button type="button" onClick={() => { setRowMenuId(null); exportFlow(r) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent">
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />导出 JSON
                    </button>
                    {!r.is_draft && (
                      <button type="button" onClick={() => { setRowMenuId(null); handleToggle(r) }} disabled={togglingId === r.id}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        title={r.enabled ? '停用后不能发起工单' : '启用'}>
                        <Power className="h-3.5 w-3.5 text-muted-foreground" />{r.enabled ? '停用' : '启用'}
                      </button>
                    )}
                    <button type="button" onClick={() => { setRowMenuId(null); handleDelete(r) }} disabled={deletingId === r.id}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" />{deletingId === r.id ? '删除中' : '删除'}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); exportFlow(r) }}
              className="btn-secondary btn-sm" title="导出为 JSON 文件（可在其他环境导入）">
              <Download className="h-3 w-3" />导出
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">流程模板</h1>
            {!loading && (
              <span className="text-sm font-medium tabular-nums text-foreground">
                共 {total.toLocaleString()} 个模板
              </span>
            )}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">自定义工单流转程序：节点绑定处理分组、节点字段自定义、流转路由支持条件判断；模板发布后即可发起工单</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新流程模板列表">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              disabled={importing}
              className="btn-secondary btn-sm"
              title="从 JSON 文件导入模板"
            >
              <Upload className="mr-1 h-3.5 w-3.5" />{importing ? '导入中' : '导入'}
            </button>
          )}
          {canEdit && (
            <Button variant="primary" size="sm" onClick={openNew}>
              <Plus className="mr-1 h-3.5 w-3.5" />新建模板
            </Button>
          )}
          <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          className="table-stagger"
          columns={columns}
          data={list.slice((page - 1) * size, page * size)}
          loading={loading}
          rowKey="id"
          onRowClick={canEdit ? (r) => openEdit(r) : undefined}
          rowClickHint="点击编辑"
          rowClassName={() => 'h-14'}
          emptyText="暂无流程模板"
          emptyIcon={GitGraph}
          emptyDescription="创建并发布流程模板后，即可在工单中心发起工单"
          emptyAction={canEdit && (
            <Button variant="primary" size="sm" onClick={openNew}>
              <Plus className="mr-1 h-3.5 w-3.5" />新建模板
            </Button>
          )}
        />
      </div>
      <Pagination page={page} pageSize={size} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setSize(s); setPage(1) }} />
    </PageContainer>
  )
}
