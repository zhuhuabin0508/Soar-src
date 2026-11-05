// 调用日志：全量网关调用明细（含 401/403/429 拒绝），支持多维筛选与分页
import { useCallback, useEffect, useState } from 'react'
import { openAdminApi } from '../../api/openApi'
import { RefreshCw, ScrollText, Search } from 'lucide-react'

const PAGE_SIZE = 20
const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '-')

const STATUS_META = {
  2: { label: '2xx 成功', cls: 'bg-success/15 text-success' },
  4: { label: '4xx 拒绝', cls: 'bg-warning/15 text-warning' },
  5: { label: '5xx 异常', cls: 'bg-destructive/15 text-destructive' },
}
const statusClass = (code) => (STATUS_META[Math.floor(code / 100)]?.cls || 'bg-muted text-muted-foreground')

export default function LogsTab() {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 筛选条件
  const [filter, setFilter] = useState({ app_id: '', resource_code: '', status_group: 'all', client_ip: '' })
  const [applied, setApplied] = useState(filter)

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

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const handleQuery = () => { setPage(1); setApplied(filter) }
  const handleReset = () => { const f = { app_id: '', resource_code: '', status_group: 'all', client_ip: '' }; setFilter(f); setApplied(f); setPage(1) }

  const inputCls = 'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary'

  return (
    <div className="flex flex-col gap-4">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5">
        <input
          value={filter.client_ip}
          onChange={(e) => setFilter((p) => ({ ...p, client_ip: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
          placeholder="客户端 IP..."
          className={`${inputCls} w-36`}
        />
        <select value={filter.resource_code} onChange={(e) => setFilter((p) => ({ ...p, resource_code: e.target.value }))} className={inputCls}>
          <option value="">全部资源</option>
          {['alerts', 'assets', 'banned_ips', 'tickets', 'executions', 'dashboard_stats', 'ticket_monitor'].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={filter.status_group} onChange={(e) => setFilter((p) => ({ ...p, status_group: e.target.value }))} className={inputCls}>
          <option value="all">全部状态</option>
          <option value="2xx">2xx 成功</option>
          <option value="4xx">4xx 拒绝</option>
          <option value="5xx">5xx 异常</option>
        </select>
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
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
      ) : logs.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground">
          <ScrollText className="h-10 w-10" />
          <div className="text-sm">
            {JSON.stringify({ ...applied, status_group: applied.status_group, client_ip: applied.client_ip }) === JSON.stringify({ app_id: '', resource_code: '', status_group: 'all', client_ip: '' })
              ? '暂无任何调用日志，第三方系统调用开放 API 后将在此记录'
              : '当前筛选条件下没有匹配的调用日志'}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} className="btn-secondary btn-sm"><RefreshCw className="h-3.5 w-3.5" /> 刷新</button>
            {JSON.stringify({ ...applied, status_group: applied.status_group, client_ip: applied.client_ip }) !== JSON.stringify({ app_id: '', resource_code: '', status_group: 'all', client_ip: '' }) && (
              <button type="button" onClick={handleReset} className="btn-secondary btn-sm">清除筛选</button>
            )}
          </div>
        </div>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="w-40 px-4 py-3 text-right font-medium">时间</th>
                <th className="w-32 px-4 py-3 text-left font-medium">应用</th>
                <th className="w-28 px-4 py-3 text-left font-medium">资源</th>
                <th className="w-20 px-4 py-3 text-left font-medium">状态码</th>
                <th className="w-24 px-4 py-3 text-right font-medium">耗时</th>
                <th className="w-32 px-4 py-3 text-left font-medium">客户端 IP</th>
                <th className="px-4 py-3 text-left font-medium">路径 / 参数</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => (
                <tr
                  key={log.id}
                  title={log.error_message ? `错误：${log.error_message}` : ''}
                  className={`border-t border-border ${log.status_code >= 500 ? 'bg-destructive/5' : idx % 2 === 0 ? 'bg-muted' : 'bg-card'}`}
                >
                  <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{fmtTime(log.created_at)}</td>
                  <td className="truncate px-4 py-2.5 text-foreground" title={log.app_name}>{log.app_name || '-'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{log.resource_code || '-'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${statusClass(log.status_code)}`}>{log.status_code}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{log.response_ms} ms</td>
                  <td className="truncate px-4 py-2.5 font-mono text-xs text-muted-foreground">{log.client_ip || '-'}</td>
                  <td className="truncate px-4 py-2.5 text-xs text-muted-foreground" title={`${log.path} ${log.query_params || ''}`}>
                    <span className="font-mono">{log.method} {log.path}</span>
                    {log.query_params && <span className="ml-1 opacity-70">{String(log.query_params).slice(0, 80)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {!loading && logs.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">共 {total} 条，第 {page} / {totalPages} 页</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-secondary btn-sm">上一页</button>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="btn-secondary btn-sm">下一页</button>
          </div>
        </div>
      )}
    </div>
  )
}
