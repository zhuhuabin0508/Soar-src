// 调用日志：全量网关调用明细（含 401/403/429 拒绝），支持多维筛选与分页
import { useCallback, useEffect, useState } from 'react'
import { openAdminApi } from '../../api/openApi'
import { CompactSelect, DataTable, Pagination } from '../../components/ui'
import { RefreshCw, ScrollText, Search } from 'lucide-react'

const PAGE_SIZE = 20
const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '-')

const EMPTY_FILTER = { app_id: '', resource_code: '', status_group: 'all', client_ip: '' }

const STATUS_META = {
  2: { label: '2xx 成功', cls: 'bg-success/15 text-success' },
  4: { label: '4xx 拒绝', cls: 'bg-warning/15 text-warning' },
  5: { label: '5xx 异常', cls: 'bg-destructive/15 text-destructive' },
}
const statusClass = (code) => (STATUS_META[Math.floor(code / 100)]?.cls || 'bg-muted text-muted-foreground')

const inputCls = 'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-primary'

export default function LogsTab({ refreshKey = 0 }) {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 筛选条件
  const [filter, setFilter] = useState(EMPTY_FILTER)
  const [applied, setApplied] = useState(EMPTY_FILTER)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await openAdminApi.callLogs({ ...applied, page, page_size: PAGE_SIZE })
      setLogs(res?.data?.items || [])
      setTotal(res?.data?.total || 0)
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [applied, page])

  useEffect(() => { load() }, [load, refreshKey])

  const isFiltered = JSON.stringify(applied) !== JSON.stringify(EMPTY_FILTER)
  const handleQuery = () => { setPage(1); setApplied(filter) }
  const handleReset = () => { setFilter(EMPTY_FILTER); setApplied(EMPTY_FILTER); setPage(1) }

  // 列定义：时间/耗时右对齐，路径列自适应剩余宽度
  const columns = [
    {
      key: 'created_at', header: '时间', width: '165px', numeric: true,
      render: (log) => <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(log.created_at)}</span>,
    },
    {
      key: 'app_name', header: '应用', width: '130px',
      render: (log) => <span className="truncate" title={log.app_name}>{log.app_name || '-'}</span>,
    },
    {
      key: 'resource_code', header: '资源', width: '120px',
      render: (log) => <span className="font-mono text-xs text-muted-foreground">{log.resource_code || '-'}</span>,
    },
    {
      key: 'status_code', header: '状态码', width: '100px',
      render: (log) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${statusClass(log.status_code)}`}>
          {log.status_code}
        </span>
      ),
    },
    {
      key: 'response_ms', header: '耗时', width: '90px', numeric: true,
      render: (log) => <span className="text-muted-foreground">{log.response_ms} ms</span>,
    },
    {
      key: 'client_ip', header: '客户端 IP', width: '140px',
      render: (log) => <span className="font-mono text-xs text-muted-foreground">{log.client_ip || '-'}</span>,
    },
    {
      key: '__path', header: '路径 / 参数',
      render: (log) => (
        <span className="block truncate text-xs text-muted-foreground" title={`${log.method} ${log.path} ${log.query_params || ''}`}>
          <span className="font-mono">{log.method} {log.path}</span>
          {log.query_params && <span className="ml-1 opacity-70">{String(log.query_params).slice(0, 80)}</span>}
        </span>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
        <input
          value={filter.client_ip}
          onChange={(e) => setFilter((p) => ({ ...p, client_ip: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
          placeholder="客户端 IP..."
          className={`${inputCls} w-36`}
        />
        <CompactSelect
          value={filter.resource_code}
          onChange={(e) => setFilter((p) => ({ ...p, resource_code: e.target.value }))}
          className="w-32"
        >
          <option value="">全部资源</option>
          {['alerts', 'assets', 'banned_ips', 'tickets', 'executions', 'dashboard_stats', 'ticket_monitor'].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </CompactSelect>
        <CompactSelect
          value={filter.status_group}
          onChange={(e) => setFilter((p) => ({ ...p, status_group: e.target.value }))}
          className="w-32"
        >
          <option value="all">全部状态</option>
          <option value="2xx">2xx 成功</option>
          <option value="4xx">4xx 拒绝</option>
          <option value="5xx">5xx 异常</option>
        </CompactSelect>
        <input
          value={filter.app_id}
          onChange={(e) => setFilter((p) => ({ ...p, app_id: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
          placeholder="应用 ID..."
          type="number"
          className={`${inputCls} w-24`}
        />
        <button type="button" onClick={handleQuery} className="btn-primary btn-sm"><Search className="h-3.5 w-3.5" /> 查询</button>
        <button type="button" onClick={handleReset} className="btn-secondary btn-sm">重置</button>
        <button type="button" onClick={load} className="btn-secondary btn-sm"><RefreshCw className="h-3.5 w-3.5" /> 刷新</button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* 日志表格 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          columns={columns}
          data={logs}
          loading={loading}
          rowKey="id"
          emptyIcon={ScrollText}
          emptyText={isFiltered ? '当前筛选条件下没有匹配的调用日志' : '暂无任何调用日志'}
          emptyDescription={isFiltered ? '调整筛选条件后重试' : '第三方系统调用开放 API 后将在此记录'}
          emptyAction={
            <div className="flex items-center gap-2">
              <button type="button" onClick={load} className="btn-secondary btn-sm"><RefreshCw className="h-3.5 w-3.5" /> 刷新</button>
              {isFiltered && <button type="button" onClick={handleReset} className="btn-secondary btn-sm">清除筛选</button>}
            </div>
          }
          rowClassName={(log) => (log.status_code >= 500 ? 'bg-destructive/5' : '')}
        />
      </div>

      {/* 分页 */}
      {!loading && logs.length > 0 && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          showPageSize={false}
        />
      )}
    </div>
  )
}
