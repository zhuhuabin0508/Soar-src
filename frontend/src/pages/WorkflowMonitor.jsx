// 工作流监控页：展示单个工作流的运行统计、趋势、节点瓶颈与执行历史。
// 参考 AgentMonitor，复用后端 GET /executions/stats/overview?workflow_id=X
import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Workflow, RefreshCw, Edit, ExternalLink } from 'lucide-react'
import { workflows as workflowsApi } from '../api/client'
import { getStatsOverview, getExecutions } from '../api/executions'
import { guardNavPermission } from '../utils/permissions'
import { CompactSelect } from '../components/ui'

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 格式化耗时（秒）
function fmtDuration(s) {
  if (s == null || s === '') return '-'
  const n = Number(s)
  if (!Number.isFinite(n)) return '-'
  if (n < 1) return Math.round(n * 1000) + 'ms'
  if (n < 60) return n.toFixed(1) + 's'
  const m = Math.floor(n / 60)
  const sec = Math.round(n % 60)
  return `${m}分${sec}秒`
}

// 状态徽章
function StatusBadge({ status }) {
  const map = {
    success: { cls: 'bg-success/20 text-success', label: '成功' },
    failed: { cls: 'bg-destructive/20 text-destructive', label: '失败' },
    running: { cls: 'bg-primary/20 text-primary', label: '运行中' },
    waiting_for_approval: { cls: 'bg-warning/20 text-warning', label: '待审批' },
  }
  const m = map[(status || '').toLowerCase()] || { cls: 'bg-secondary text-muted-foreground', label: status || '-' }
  return <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${m.cls}`}>{m.label}</span>
}

// 触发类型标签
function triggerLabel(t) {
  const map = { webhook: 'Webhook', test_run: '流程测试', manual: '手动', schedule: '定时', agent_test: '智能体测试' }
  return map[(t || '').toLowerCase()] || t || '-'
}

// 统计卡片
function StatCard({ label, value, sub, color = 'text-foreground' }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

// 7天趋势柱状图（成功/失败堆叠）
function TrendChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          最近执行趋势
        </div>
        <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
          暂无趋势数据
        </div>
      </div>
    )
  }
  const maxCount = Math.max(...data.map((d) => d.total), 1)
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        最近执行趋势（{data.length} 天）
      </div>
      <div className="flex items-end justify-between gap-2" style={{ height: '140px' }}>
        {data.map((d, idx) => (
          <div key={idx} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-[100px] w-full items-end justify-center gap-0.5">
              {/* 成功（绿）+ 失败（红）堆叠 */}
              <div
                className="w-1/2 rounded-t bg-success/70 transition-all hover:bg-success"
                style={{ height: `${(d.success / maxCount) * 100}%`, minHeight: d.success > 0 ? '4px' : '0' }}
                title={`${d.date} 成功: ${d.success}`}
              />
              <div
                className="w-1/2 rounded-t bg-destructive/70 transition-all hover:bg-destructive"
                style={{ height: `${(d.failed / maxCount) * 100}%`, minHeight: d.failed > 0 ? '4px' : '0' }}
                title={`${d.date} 失败: ${d.failed}`}
              />
            </div>
            <div className="text-[10px] text-muted-foreground">{d.total}</div>
            <div className="text-[10px] text-muted-foreground">{d.date.slice(5)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-success/70" />成功</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-destructive/70" />失败</span>
      </div>
    </div>
  )
}

// 触发类型分布
function TriggerDist({ data }) {
  const entries = Object.entries(data || {})
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          触发类型分布
        </div>
        <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
          暂无数据
        </div>
      </div>
    )
  }
  const total = entries.reduce((s, [, n]) => s + n, 0)
  const colors = ['bg-primary', 'bg-success', 'bg-warning', 'bg-info', 'bg-destructive']
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        触发类型分布
      </div>
      <div className="flex flex-col gap-2">
        {entries.map(([type, count], idx) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          return (
            <div key={type} className="flex items-center gap-2">
              <span className="w-20 truncate text-xs text-muted-foreground">{triggerLabel(type)}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-secondary">
                <div
                  className={`h-full ${colors[idx % colors.length]}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 text-right text-xs tabular-nums text-foreground">{count} 次</span>
              <span className="w-10 text-right text-[10px] text-muted-foreground">{pct}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 节点瓶颈排行
function NodeBottleneck({ data }) {
  const arr = Array.isArray(data) ? data : []
  if (arr.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          节点性能瓶颈
        </div>
        <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
          暂无节点执行数据
        </div>
      </div>
    )
  }
  const sorted = [...arr].sort((a, b) => (b.avg_duration_seconds || 0) - (a.avg_duration_seconds || 0))
  const maxDur = Math.max(...sorted.map((n) => n.avg_duration_seconds || 0), 1)
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        节点性能瓶颈（按平均耗时降序）
      </div>
      <div className="flex flex-col gap-2">
        {sorted.slice(0, 8).map((n, idx) => {
          const dur = n.avg_duration_seconds || 0
          const pct = Math.round((dur / maxDur) * 100)
          const failRate = n.count > 0 ? Math.round((n.failed_count / n.count) * 100) : 0
          return (
            <div key={idx} className="flex items-center gap-2">
              <span className="w-32 truncate text-xs text-foreground" title={n.node_type}>{n.node_type || '-'}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-secondary">
                <div
                  className={`h-full ${failRate > 20 ? 'bg-destructive/70' : 'bg-warning/70'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">{fmtDuration(dur)}</span>
              <span className="w-20 text-right text-[10px] text-muted-foreground">
                {n.count} 次{failRate > 0 ? ` · 失败${failRate}%` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'waiting_for_approval', label: '待审批' },
]

function WorkflowMonitor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [workflow, setWorkflow] = useState(null)
  const [stats, setStats] = useState(null)
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 统计天数选择
  const [days, setDays] = useState(7)
  // 执行历史筛选
  const [statusFilter, setStatusFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [wfData, statsData, execData] = await Promise.all([
        workflowsApi.get(id),
        getStatsOverview(days, id),
        getExecutions(50, 0, id, statusFilter || null),
      ])
      setWorkflow(wfData)
      setStats(statsData)
      setExecutions(Array.isArray(execData) ? execData : [])
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [id, days, statusFilter])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('/studio?tab=workflow')}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 返回
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            工作流监控
            {workflow && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {workflow.name || `#${id}`}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <CompactSelect
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            size="lg"
          >
            <option value={1}>近1天</option>
            <option value={7}>近7天</option>
            <option value={14}>近14天</option>
            <option value={30}>近30天</option>
            <option value={90}>近90天</option>
          </CompactSelect>
          <button
            type="button"
            onClick={() => navigate(`/editor?id=${id}`)}
            className="btn-secondary btn-sm inline-flex items-center gap-1"
          >
            <Edit className="h-3.5 w-3.5" />编辑
          </button>
          <button type="button" onClick={load} className="btn-secondary btn-sm inline-flex items-center gap-1">
            <RefreshCw className="h-3.5 w-3.5" />刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {/* 工作流信息 */}
          {workflow && (
            <div className="mb-4 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <Workflow className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground">{workflow.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {workflow.description || '无描述'}
                  </div>
                </div>
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span>触发: {triggerLabel(workflow.trigger_type)}</span>
                  <span>·</span>
                  <span>状态: {workflow.status || '-'}</span>
                  <span>·</span>
                  <span>分类: {workflow.category || '未分类'}</span>
                </div>
              </div>
            </div>
          )}

          {/* 统计卡片 */}
          {stats && (
            <div className="mb-4 grid grid-cols-5 gap-3">
              <StatCard label="总执行次数" value={stats.total ?? 0} sub={`近${days}天`} />
              <StatCard label="成功" value={stats.success ?? 0} color="text-success" />
              <StatCard label="失败" value={stats.failed ?? 0} color="text-destructive" />
              <StatCard
                label="成功率"
                value={stats.total > 0 ? Math.round((stats.success / stats.total) * 100) + '%' : '-'}
                color={stats.total > 0 && (stats.success / stats.total) >= 0.95 ? 'text-success' : stats.total > 0 && (stats.success / stats.total) >= 0.8 ? 'text-warning' : 'text-destructive'}
              />
              <StatCard label="平均耗时" value={fmtDuration(stats.avg_duration_seconds)} />
            </div>
          )}

          {/* 趋势图 + 触发类型分布 */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <TrendChart data={stats?.by_day} />
            <TriggerDist data={stats?.by_trigger} />
          </div>

          {/* 节点瓶颈 */}
          <div className="mb-4">
            <NodeBottleneck data={stats?.node_bottleneck} />
          </div>

          {/* 执行历史 */}
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                执行历史（{executions.length} 条）
              </h2>
              <CompactSelect
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                size="lg"
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </CompactSelect>
            </div>
            {executions.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                暂无执行记录
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full table-fixed border-collapse text-sm">
                  <thead className="bg-card text-muted-foreground">
                    <tr>
                      <th className="w-16 px-4 py-3 text-left font-medium">ID</th>
                      <th className="w-24 px-4 py-3 text-left font-medium">状态</th>
                      <th className="w-28 px-4 py-3 text-left font-medium">触发类型</th>
                      <th className="w-40 px-4 py-3 text-left font-medium">创建时间</th>
                      <th className="w-40 px-4 py-3 text-left font-medium">完成时间</th>
                      <th className="w-20 px-4 py-3 text-left font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executions.map((e, idx) => (
                      <tr
                        key={e.id}
                        className={`cursor-pointer border-t border-border transition-colors hover:bg-primary/5 ${
                          idx % 2 === 0 ? 'bg-card' : 'bg-card'
                        }`}
                        onClick={() => { if (!guardNavPermission('execution', 'view', '日志中心')) return; navigate(`/executions/${e.id}`) }}
                      >
                        <td className="px-4 py-3 font-mono text-primary">#{e.id}</td>
                        <td className="px-4 py-3"><StatusBadge status={e.status} /></td>
                        <td className="px-4 py-3 text-muted-foreground">{triggerLabel(e.trigger_type)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtTime(e.created_at)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtTime(e.finished_at)}</td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={(ev) => { ev.stopPropagation(); if (!guardNavPermission('execution', 'view', '日志中心')) return; navigate(`/executions/${e.id}`) }}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                          >
                            <ExternalLink className="h-3 w-3" />详情
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default WorkflowMonitor
