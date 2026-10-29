// 执行追溯页：展示工作流执行历史
//
// 改造（批次 C）：从手写表格 + 简单分页 → 统一 DataTable / Pagination / FilterBar
// - DataTable 提供粘性表头、骨架加载、空态、斑马纹、行 hover
// - Pagination 提供每页大小选择 + 跳页
// - FilterBar 提供搜索 + 字段筛选（工作流 + 状态）
//
// 后端接口限制：getExecutions 返回当前页数组,不返回 total。
// 此处用估算 total(满页则可能有下一页),分页可继续翻;翻到空页时自动回退。
import { useEffect, useState, useCallback } from 'react'
import { ScrollText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getExecutions } from '../api/executions'
import { workflows as workflowsApi } from '../api/client'
import { PageContainer, PageHeader, DataTable, Pagination, EmptyState } from '../components/ui'
import FilterBar from '../components/FilterBar'

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 状态徽章色
function statusBadge(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return { variant: 'success', label: '成功' }
    case 'failed':
    case 'error':
      return { variant: 'danger', label: '失败' }
    case 'running':
      return { variant: 'primary', label: '运行中' }
    case 'waiting_for_approval':
    case 'waiting':
      return { variant: 'warning', label: '待审批' }
    default:
      return { variant: 'neutral', label: status || '-' }
  }
}

// 触发类型标签
function triggerLabel(t) {
  switch ((t || '').toLowerCase()) {
    case 'webhook':
      return 'Webhook'
    case 'test_run':
      return '流程测试'
    case 'manual':
      return '手动'
    case 'agent_test':
      return '智能体测试'
    default:
      return t || '-'
  }
}

const PAGE_SIZE = 20
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'waiting_for_approval', label: '待审批' },
]

// 执行列表页
function ExecutionList() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 工作流列表（用于筛选下拉）
  const [workflows, setWorkflows] = useState([])
  // 已提交的筛选条件
  const [filters, setFilters] = useState({ workflowId: '', status: '' })

  // 分页:offset-based(后端按 offset 返回)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const offset = (page - 1) * pageSize

  // 是否还有下一页(满页时假设有)
  const [hasMore, setHasMore] = useState(false)
  // 估算 total(用于 Pagination 显示)
  // 真实 total = offset + 当前页条数 + (hasMore ? 估算下一页条数 : 0)
  // 简化:用 offset + rows.length + (hasMore ? pageSize : 0)
  const estimatedTotal = offset + rows.length + (hasMore ? pageSize : 0)

  // 加载工作流列表（仅一次）
  useEffect(() => {
    ;(async () => {
      try {
        const data = await workflowsApi.list()
        setWorkflows(Array.isArray(data) ? data : [])
      } catch {
        setWorkflows([])
      }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getExecutions(
        pageSize,
        offset,
        filters.workflowId || null,
        filters.status || null
      )
      const arr = Array.isArray(data) ? data : []
      setRows(arr)
      setHasMore(arr.length === pageSize)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
      setRows([])
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [offset, pageSize, filters])

  useEffect(() => {
    load()
  }, [load])

  // 应用筛选:重置到第 1 页
  const applyFilters = (next) => {
    setFilters(next)
    setPage(1)
  }

  // 工作流名映射:workflow_id -> name
  const wfNameMap = {}
  workflows.forEach((w) => {
    wfNameMap[w.id] = w.name
  })

  // 表格列定义
  const columns = [
    {
      key: 'id',
      header: 'ID',
      width: '80px',
      render: (r) => <span className="font-mono text-primary">#{r.id}</span>,
    },
    {
      key: 'workflow_id',
      header: '工作流',
      render: (r) =>
        r.workflow_id ? (
          <span className="truncate text-foreground" title={wfNameMap[r.workflow_id] || `工作流 #${r.workflow_id}`}>
            {wfNameMap[r.workflow_id] || `工作流 #${r.workflow_id}`}
          </span>
        ) : (
          <span className="text-muted-foreground">—（智能体测试）</span>
        ),
    },
    {
      key: 'trigger_type',
      header: '触发类型',
      width: '120px',
      render: (r) => (
        <span className="badge bg-muted text-muted-foreground">{triggerLabel(r.trigger_type)}</span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: '110px',
      render: (r) => {
        const b = statusBadge(r.status)
        const cls = {
          success: 'bg-success/15 text-success',
          danger: 'bg-destructive/15 text-destructive',
          primary: 'bg-primary/15 text-primary',
          warning: 'bg-warning/15 text-warning',
          neutral: 'bg-muted text-muted-foreground',
        }[b.variant]
        return <span className={`badge ${cls}`}>{b.label}</span>
      },
    },
    {
      key: 'created_at',
      header: '创建时间',
      width: '170px',
      render: (r) => <span className="text-muted-foreground tabular-nums">{fmtTime(r.created_at)}</span>,
    },
    {
      key: 'finished_at',
      header: '完成时间',
      width: '170px',
      render: (r) => <span className="text-muted-foreground tabular-nums">{fmtTime(r.finished_at)}</span>,
    },
  ]

  // 翻页保护:翻到空页时回退
  useEffect(() => {
    if (!loading && rows.length === 0 && page > 1) {
      setPage((p) => Math.max(1, p - 1))
    }
  }, [loading, rows.length, page])

  return (
    <PageContainer className="flex flex-col">
      <PageHeader title="执行追溯" />

      {/* 筛选栏 */}
      <FilterBar
        filters={[
          {
            key: 'workflowId',
            label: '工作流',
            value: filters.workflowId,
            onChange: (v) => applyFilters({ ...filters, workflowId: v }),
            options: [
              { value: '', label: '全部' },
              ...workflows.map((w) => ({ value: w.id, label: w.name })),
            ],
          },
          {
            key: 'status',
            label: '状态',
            value: filters.status,
            onChange: (v) => applyFilters({ ...filters, status: v }),
            options: STATUS_OPTIONS,
          },
        ]}
      />

      {/* 错误提示 */}
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 表格 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          columns={columns}
          data={rows}
          loading={loading}
          rowKey="id"
          onRowClick={(r) => navigate(`/executions/${r.id}`)}
          emptyText="暂无执行记录"
        />
      </div>

      {/* 分页 */}
      {!loading && rows.length > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={estimatedTotal}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s)
            setPage(1)
          }}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      )}

      {/* 空态提示(无数据且无筛选时) */}
      {!loading && rows.length === 0 && !error && (
        <EmptyState
          icon={ScrollText}
          title="暂无执行记录"
          description="触发工作流后,执行记录将在此显示"
          className="mt-6"
        />
      )}
    </PageContainer>
  )
}

export default ExecutionList
