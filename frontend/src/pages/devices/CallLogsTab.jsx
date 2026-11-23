// 调用日志 Tab
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Check, History, RefreshCw } from 'lucide-react'
import { Modal } from '../../components/Dialog'
import { devices as devicesApi } from '../../api/client'
import { usePersistedFilters } from '../../hooks/usePersistedFilters'
import FilterBar from '../../components/FilterBar'
import { fmtRelative, fmtTime, truncate } from './constants'


// ============ 调用日志 Tab ============
export function CallLogsTab() {
  const [stats, setStats] = useState(null)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState(7)
  const [filters, setFilters] = usePersistedFilters('device_call_logs', {
    search: '',
    deviceId: '',
    source: '',
    status: '',
  })
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLog, setDetailLog] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        devicesApi.callLogStats(days),
        devicesApi.callLogs({
          device_id: filters.deviceId || undefined,
          source: filters.source || undefined,
          status: filters.status || undefined,
          limit: 200,
        }),
      ])
      setStats(statsRes)
      setLogs(Array.isArray(logsRes) ? logsRes : logsRes?.logs || logsRes?.items || [])
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, filters.deviceId, filters.source, filters.status])

  useEffect(() => {
    load()
  }, [load])

  const openDetail = async (log) => {
    setDetailLog(log)
    setDetailOpen(true)
    if (log.id) {
      setDetailLoading(true)
      try {
        const res = await devicesApi.callLogDetail(log.id)
        setDetailLog({ ...log, ...res })
      } catch {
        // 忽略
      } finally {
        setDetailLoading(false)
      }
    }
  }

  const filteredLogs = useMemo(() => {
    if (!filters.search) return logs
    const q = filters.search.toLowerCase()
    return logs.filter((l) =>
      [l.device_name, l.action_name, l.error_message, l.source_ip]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    )
  }, [logs, filters.search])

  const dayOptions = [1, 7, 14, 30]
  const sourceOptions = [
    { value: '', label: '全部来源' },
    { value: 'manual_test', label: '手动测试' },
    { value: 'workflow', label: '工作流' },
    { value: 'agent', label: '智能体' },
    { value: 'api', label: 'API 调用' },
  ]
  const statusOptions = [
    { value: '', label: '全部状态' },
    { value: 'success', label: '成功' },
    { value: 'partial', label: '部分成功' },
    { value: 'failed', label: '失败' },
  ]

  const summary = stats || {}
  const totalCalls = summary.total_calls ?? 0
  const successRate = summary.success_rate ?? 0
  const avgLatency = summary.avg_latency_ms ?? 0
  const failedCount = summary.failed_count ?? 0

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-3 whitespace-nowrap rounded-lg border border-border bg-card p-4">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围：</span>
          {dayOptions.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                days === d
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {d} 天
            </button>
          ))}
        </div>
        <button type="button" onClick={load} disabled={loading} className="btn-secondary btn-sm">
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && (
        <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 统计卡片 */}
      {!loading && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">总调用次数</span>
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">{totalCalls}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">成功率</span>
              <Check className={`h-4 w-4 ${successRate >= 90 ? 'text-success' : 'text-warning'}`} />
            </div>
            <div
              className={`text-2xl font-bold ${
                successRate >= 90 ? 'text-success' : 'text-warning'
              }`}
            >
              {successRate.toFixed(1)}
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">平均耗时</span>
              <RefreshCw className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">
              {avgLatency}
              <span className="text-sm text-muted-foreground"> ms</span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">失败次数</span>
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </div>
            <div className="text-2xl font-bold text-destructive">{failedCount}</div>
          </div>
        </div>
      )}

      {/* 筛选器 */}
      <FilterBar
        search={{
          value: filters.search,
          onChange: (v) => setFilters({ search: v }),
          placeholder: '搜索设备 / 动作 / 错误信息...',
        }}
        filters={[
          {
            key: 'source',
            label: '来源',
            value: filters.source,
            onChange: (v) => setFilters({ source: v }),
            options: sourceOptions,
          },
          {
            key: 'status',
            label: '状态',
            value: filters.status,
            onChange: (v) => setFilters({ status: v }),
            options: statusOptions,
          },
        ]}
      />

      {/* 明细表格 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
          <History className="h-10 w-10" />
          <div className="text-sm">暂无调用记录</div>
        </div>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1100px] table-fixed border-collapse text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="w-40 px-4 py-3 text-left font-medium">时间</th>
                <th className="w-16 px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">设备 / 动作</th>
                <th className="w-20 px-4 py-3 text-left font-medium">来源</th>
                <th className="w-20 px-4 py-3 text-right font-medium">耗时</th>
                <th className="w-20 px-4 py-3 text-right font-medium">状态码</th>
                <th className="w-32 px-4 py-3 text-left font-medium">来源 IP</th>
                <th className="px-4 py-3 text-left font-medium">错误信息</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.slice(0, 200).map((l, idx) => (
                <tr
                  key={l.id || idx}
                  className={`cursor-pointer border-t border-border hover:bg-primary/5 ${
                    l.status === 'failed'
                      ? 'bg-destructive/5'
                      : l.status === 'partial'
                        ? 'bg-warning/5'
                        : idx % 2 === 0
                          ? 'bg-card'
                          : ''
                  }`}
                  onClick={() => openDetail(l)}
                >
                  <td className="px-4 py-3 text-xs text-muted-foreground" title={fmtTime(l.created_at)}>
                    {fmtRelative(l.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        l.status === 'success'
                          ? 'bg-success/20 text-success'
                          : l.status === 'partial'
                            ? 'bg-warning/20 text-warning'
                            : 'bg-destructive/20 text-destructive'
                      }`}
                    >
                      {l.status === 'success'
                        ? '成功'
                        : l.status === 'partial' ? '部分成功' : '失败'}
                    </span>
                  </td>
                  <td className="truncate px-4 py-3 text-foreground">
                    <div className="truncate">{l.device_name || '-'}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {l.action_name || '-'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {l.source || '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                    {l.latency_ms != null ? `${l.latency_ms}ms` : '-'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                    {l.status_code ?? '-'}
                  </td>
                  <td className="truncate px-4 py-3 font-mono text-xs text-muted-foreground">
                    {l.source_ip || '-'}
                  </td>
                  <td className="truncate px-4 py-3 text-xs text-destructive" title={l.error_message || ''}>
                    {l.error_message ? truncate(l.error_message, 50) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 详情弹窗 */}
      <Modal
        open={detailOpen}
        title="调用日志详情"
        onClose={() => setDetailOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <button type="button" onClick={() => setDetailOpen(false)} className="btn-primary">
            关闭
          </button>
        }
      >
        {detailLoading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            加载中...
          </div>
        ) : detailLog ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">设备</div>
                <div className="text-sm text-foreground">{detailLog.device_name || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">动作</div>
                <div className="text-sm text-foreground">{detailLog.action_name || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">状态</div>
                <span
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                    detailLog.status === 'success'
                      ? 'bg-success/20 text-success'
                      : 'bg-destructive/20 text-destructive'
                  }`}
                >
                  {detailLog.status === 'success' ? '成功' : '失败'}
                </span>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">HTTP 状态码</div>
                <div className="font-mono text-sm text-foreground">{detailLog.status_code ?? '-'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">耗时</div>
                <div className="font-mono text-sm text-foreground">
                  {detailLog.latency_ms != null ? `${detailLog.latency_ms}ms` : '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">来源</div>
                <div className="text-sm text-foreground">{detailLog.source || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">来源 IP</div>
                <div className="font-mono text-sm text-foreground">{detailLog.source_ip || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">时间</div>
                <div className="text-sm text-foreground">{fmtTime(detailLog.created_at)}</div>
              </div>
            </div>
            {detailLog.request_summary && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">请求摘要</div>
                <pre className="max-h-40 overflow-auto rounded-md bg-card p-3 font-mono text-xs text-foreground ring-1 ring-border">
                  {typeof detailLog.request_summary === 'string'
                    ? detailLog.request_summary
                    : JSON.stringify(detailLog.request_summary, null, 2)}
                </pre>
              </div>
            )}
            {detailLog.response_summary && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">响应摘要</div>
                <pre className="max-h-40 overflow-auto rounded-md bg-card p-3 font-mono text-xs text-foreground ring-1 ring-border">
                  {typeof detailLog.response_summary === 'string'
                    ? detailLog.response_summary
                    : JSON.stringify(detailLog.response_summary, null, 2)}
                </pre>
              </div>
            )}
            {detailLog.error_message && (
              <div>
                <div className="mb-1 text-xs text-destructive">错误信息</div>
                <pre className="max-h-40 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">
                  {detailLog.error_message}
                </pre>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
