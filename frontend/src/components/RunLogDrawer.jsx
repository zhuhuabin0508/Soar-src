// 执行日志面板（底部抽屉）：执行历史 + 实时日志
// - 顶部：标题「执行日志」+ 执行次数统计 + 状态筛选下拉
// - 列表：按时间倒序展示每次执行，可展开查看节点轨迹详情
// - 每项右侧「重新运行」按钮（调用 workflows.testRun）
// - 实时日志 Tab：运行时 runLogs 实时刷新 + 中止按钮
// - 底部抽屉可折叠/展开，展开时高度 40vh
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronRight, ChevronUp, ChevronDown, RefreshCw, RotateCw,
  Square, Loader2, Activity,
} from 'lucide-react'
import { useWorkflowStore } from '../store/workflowStore'
import { getExecutions, getExecutionDetail } from '../api/executions'
import { workflows as workflowsApi } from '../api/client'
import { toast } from '../store/toastStore'
import { CompactSelect, PillTabs } from './ui'

// 格式化时间
function fmtTime(t) {
  if (!t) return ''
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(t)
  }
}

// 计算单次执行耗时（秒）
function durationSeconds(exec) {
  if (!exec || !exec.created_at || !exec.finished_at) return 0
  const start = new Date(exec.created_at).getTime()
  const end = new Date(exec.finished_at).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.max(0, (end - start) / 1000)
}

// 计算节点轨迹耗时（秒）
function traceDuration(tr) {
  if (!tr || !tr.started_at || !tr.finished_at) return 0
  const s = new Date(tr.started_at).getTime()
  const e = new Date(tr.finished_at).getTime()
  if (Number.isNaN(s) || Number.isNaN(e)) return 0
  return Math.max(0, (e - s) / 1000)
}

// 执行状态徽章颜色
function execStatusClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return 'bg-success/20 text-success'
    case 'failed':
    case 'error':
      return 'bg-destructive/20 text-destructive'
    case 'running':
      return 'bg-primary/20 text-primary'
    case 'waiting':
    case 'waiting_for_approval':
      return 'bg-warning/20 text-warning'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

// 轨迹节点状态颜色
function traceStatusClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return 'bg-success/20 text-success'
    case 'failed':
    case 'error':
      return 'bg-destructive/20 text-destructive'
    case 'running':
      return 'bg-primary/20 text-primary'
    case 'skipped':
      return 'bg-secondary text-muted-foreground'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

// 日志 level 颜色
function logLevelClass(level) {
  switch ((level || '').toLowerCase()) {
    case 'error':
      return 'bg-destructive/20 text-destructive'
    case 'warn':
    case 'warning':
      return 'bg-warning/20 text-warning'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

// 可折叠 JSON 区块
function CollapsibleJson({ label, data }) {
  const [open, setOpen] = useState(false)
  const text = (() => {
    if (data == null) return ''
    if (typeof data === 'string') return data
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  })()
  return (
    <div className="rounded border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {open && (
        <pre className="max-h-28 overflow-auto border-t border-border px-1.5 py-1 font-mono text-xs leading-relaxed text-muted-foreground">
          {text || '—'}
        </pre>
      )}
    </div>
  )
}

// 单次执行行：点击展开详情，右侧「重新运行」按钮
function ExecutionRow({ exec, onRerun, rerunning }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailErr, setDetailErr] = useState('')

  // 展开时按需拉取详情（轨迹 + 日志）
  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (detail) return
    setLoadingDetail(true)
    setDetailErr('')
    try {
      const data = await getExecutionDetail(exec.id)
      setDetail({
        execution: data?.execution || {},
        traces: Array.isArray(data?.traces) ? data.traces : [],
        logs: Array.isArray(data?.logs) ? data.logs : [],
      })
    } catch (err) {
      setDetailErr(err.message || '加载详情失败')
    } finally {
      setLoadingDetail(false)
    }
  }, [expanded, detail, exec.id])

  const nodeCount =
    detail?.traces.length ?? exec.node_count ?? exec.trace_count ?? null

  return (
    <div className="rounded-md border border-border bg-card">
      {/* 行首：点击展开/折叠 */}
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${execStatusClass(
            exec.status
          )}`}
        >
          {exec.status || '-'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          #{exec.id}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {exec.trigger_type || '-'}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {durationSeconds(exec).toFixed(1)}s
        </span>
        {/* 重新运行按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRerun(exec)
          }}
          disabled={rerunning}
          title="重新运行"
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {rerunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCw className="h-3 w-3" />
          )}
        </button>
      </button>

      {/* 第二行：开始时间 + 节点数 */}
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pl-7 text-xs text-muted-foreground">
        <span className="truncate">{fmtTime(exec.created_at)}</span>
        <span className="text-muted-foreground">·</span>
        <span>节点 {nodeCount != null ? nodeCount : '-'}</span>
      </div>

      {/* 展开内容：节点轨迹 + 日志 */}
      {expanded && (
        <div className="border-t border-border p-2.5">
          {loadingDetail && (
            <div className="py-2 text-center text-xs text-muted-foreground">
              加载详情…
            </div>
          )}
          {detailErr && (
            <div className="rounded border border-danger-700/40 bg-danger-900/20 p-2 text-xs text-destructive">
              {detailErr}
            </div>
          )}
          {detail && (
            <>
              {/* 节点轨迹列表 */}
              <div className="mb-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  节点轨迹（{detail.traces.length}）
                </div>
                {detail.traces.length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无轨迹</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {detail.traces.map((tr, idx) => (
                      <div
                        key={idx}
                        className="rounded bg-background p-1.5 text-xs"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`shrink-0 rounded px-1 py-0.5 ${traceStatusClass(
                              tr.status
                            )}`}
                          >
                            {tr.status || '-'}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                            {tr.node_label || tr.node_type || tr.node_id}
                          </span>
                          {tr.node_type && (
                            <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-muted-foreground">
                              {tr.node_type}
                            </span>
                          )}
                          <span className="shrink-0 text-muted-foreground">
                            {traceDuration(tr).toFixed(2)}s
                          </span>
                        </div>
                        {(tr.input != null || tr.output != null) && (
                          <div className="mt-1 grid gap-1 sm:grid-cols-2">
                            {tr.input != null && (
                              <CollapsibleJson label="输入" data={tr.input} />
                            )}
                            {tr.output != null && (
                              <CollapsibleJson label="输出" data={tr.output} />
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 日志列表 */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  日志（{detail.logs.length}）
                </div>
                {detail.logs.length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无日志</div>
                ) : (
                  <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                    {detail.logs.map((log, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-1.5 font-mono text-xs"
                      >
                        <span
                          className={`shrink-0 rounded px-1 py-0.5 ${logLevelClass(
                            log.level
                          )}`}
                        >
                          {(log.level || 'info').toUpperCase()}
                        </span>
                        {log.node_id && log.node_id !== '-' && (
                          <span className="shrink-0 text-primary">[{log.node_id}]</span>
                        )}
                        <span className="min-w-0 flex-1 break-words text-muted-foreground">
                          {log.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RunLogDrawer() {
  const workflowId = useWorkflowStore((s) => s.workflowId)
  const runStatus = useWorkflowStore((s) => s.runStatus)
  const runLogs = useWorkflowStore((s) => s.runLogs)
  const setRunStatus = useWorkflowStore((s) => s.setRunStatus)
  const setRunLogs = useWorkflowStore((s) => s.setRunLogs)
  const setRunTraces = useWorkflowStore((s) => s.setRunTraces)
  const clearRunLogs = useWorkflowStore((s) => s.clearRunLogs)
  const clearNodeRunStatus = useWorkflowStore((s) => s.clearNodeRunStatus)
  const setAllNodeRunStatus = useWorkflowStore((s) => s.setAllNodeRunStatus)

  // 抽屉折叠状态（默认折叠）
  const [collapsed, setCollapsed] = useState(true)
  // tab：history 执行历史 | live 实时日志
  const [tab, setTab] = useState('history')
  // 状态筛选：'' 全部 / success / failed / running
  const [statusFilter, setStatusFilter] = useState('')
  // 执行记录列表
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 重新运行中的执行 id
  const [rerunId, setRerunId] = useState(null)
  // 中止标志（重新运行时）
  const abortRef = useRef({ aborted: false })

  // 拉取执行记录列表
  const load = useCallback(async () => {
    if (!workflowId) {
      setExecutions([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await getExecutions(50, 0, workflowId, statusFilter || null)
      setExecutions(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || '加载执行记录失败')
      setExecutions([])
    } finally {
      setLoading(false)
    }
  }, [workflowId, statusFilter])

  // workflowId / 筛选变化时重新拉取
  useEffect(() => {
    load()
  }, [load])

  // 运行状态变为 running 时自动切换到实时日志 tab 并展开
  useEffect(() => {
    if (runStatus === 'running') {
      setTab('live')
      setCollapsed(false)
    }
  }, [runStatus])

  // 重新运行某次执行：复用其 payload 调用 testRun
  const handleRerun = useCallback(
    async (exec) => {
      if (!workflowId) {
        toast.warning('请先保存工作流')
        return
      }
      if (runStatus === 'running') {
        toast.warning('当前已有运行中的任务')
        return
      }
      const payload =
        exec.payload || exec.input_data || exec.trigger_payload || {}
      setRerunId(exec.id)
      abortRef.current = { aborted: false }
      setRunStatus('running')
      clearNodeRunStatus()
      clearRunLogs()
      setRunTraces([])
      setTab('live')
      setCollapsed(false)
      try {
        const res = await workflowsApi.testRun(workflowId, payload)
        if (abortRef.current.aborted) return
        setRunTraces(res?.traces || [])
        setRunLogs(res?.logs || [])
        // 应用节点状态到画布高亮
        const statusMap = {}
        ;(res?.traces || []).forEach((tr) => {
          const st = (tr.status || 'idle').toLowerCase()
          statusMap[tr.node_id] = st === 'error' ? 'failed' : st
        })
        setAllNodeRunStatus(statusMap)
        const finalStatus = res?.status === 'failed' ? 'failed' : 'success'
        setRunStatus(finalStatus)
        if (finalStatus === 'failed') {
          toast.error('重新运行失败')
        } else {
          toast.success('重新运行完成')
        }
        // 刷新历史列表
        load()
      } catch (err) {
        if (abortRef.current.aborted) return
        setRunStatus('failed')
        setRunLogs([
          {
            level: 'error',
            node_id: '-',
            message: `重新运行失败：${err.message || err}`,
            timestamp: new Date().toISOString(),
          },
        ])
        toast.error(`重新运行失败：${err.message || err}`)
      } finally {
        setRerunId(null)
      }
    },
    [workflowId, runStatus, setRunStatus, clearNodeRunStatus, clearRunLogs, setRunTraces, setRunLogs, setAllNodeRunStatus, load]
  )

  // 中止运行（标记结束，忽略后续返回结果）
  const handleAbort = useCallback(() => {
    abortRef.current.aborted = true
    setRunStatus('failed')
    // 画布上运行中节点标记为跳过
    const cur = useWorkflowStore.getState().nodeRunStatus
    const next = {}
    Object.entries(cur).forEach(([id, st]) => {
      next[id] = st === 'running' ? 'skipped' : st
    })
    setAllNodeRunStatus(next)
    setRerunId(null)
    toast.info('已中止运行')
  }, [setRunStatus, setAllNodeRunStatus])

  const isRunning = runStatus === 'running'
  const totalCount = executions.length

  return (
    <div className="shrink-0 border-t border-border bg-card">
      {/* 顶栏：折叠按钮 + 标题 + 次数 + Tab + 筛选 + 中止 */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          <span>执行日志</span>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
            {totalCount}
          </span>
          {isRunning && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              运行中
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          {!collapsed && (
            <>
              {/* Tab 切换 */}
              <div>
                <PillTabs
                  items={[
                    { key: 'history', label: '执行历史' },
                    { key: 'live', label: '实时日志', icon: Activity, count: runLogs.length || undefined },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
              </div>

              {/* 状态筛选（仅历史 Tab） */}
              {tab === 'history' && (
                <CompactSelect
                  size="lg"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">全部</option>
                  <option value="success">成功</option>
                  <option value="failed">失败</option>
                  <option value="running">运行中</option>
                </CompactSelect>
              )}

              {/* 刷新按钮（仅历史 Tab） */}
              {tab === 'history' && (
                <button
                  type="button"
                  onClick={load}
                  disabled={loading}
                  title="刷新"
                  className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
              )}

              {/* 中止按钮（运行中显示） */}
              {isRunning && (
                <button
                  type="button"
                  onClick={handleAbort}
                  className="inline-flex items-center gap-1 rounded-md border border-danger-700 bg-danger-900/30 px-2 py-0.5 text-xs text-destructive transition hover:bg-danger-900/60"
                >
                  <Square className="h-3 w-3" />
                  中止
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 展开内容：40vh 高度 */}
      {!collapsed && (
        <div
          className="overflow-y-auto border-t border-border px-3 py-2"
          style={{ height: '40vh' }}
        >
          {tab === 'history' ? (
            <>
              {error && (
                <div className="mb-2 rounded border border-danger-700/40 bg-danger-900/20 px-2 py-1 text-xs text-destructive">
                  {error}
                </div>
              )}
              {loading && executions.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  加载中…
                </div>
              ) : executions.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {workflowId ? '暂无执行记录' : '请先保存工作流'}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {executions.map((ex) => (
                    <ExecutionRow
                      key={ex.id}
                      exec={ex}
                      onRerun={handleRerun}
                      rerunning={rerunId === ex.id}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            // 实时日志 Tab
            <div className="flex h-full flex-col">
              {runLogs.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  暂无实时日志，运行工作流后将在此显示
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {runLogs.map((log, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-1.5 font-mono text-xs"
                    >
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${logLevelClass(
                          log.level
                        )}`}
                      >
                        {(log.level || 'info').toUpperCase()}
                      </span>
                      {log.node_id && log.node_id !== '-' && (
                        <span className="shrink-0 text-primary">[{log.node_id}]</span>
                      )}
                      <span className="min-w-0 flex-1 break-words text-muted-foreground">
                        {log.message}
                      </span>
                      {log.timestamp && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {fmtTime(log.timestamp)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default RunLogDrawer
