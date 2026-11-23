import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { getExecutionDetail } from '../api/executions'

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 计算时长（秒）
function duration(started, finished) {
  if (!started || !finished) return '-'
  try {
    const ms = new Date(finished).getTime() - new Date(started).getTime()
    if (ms < 0) return '-'
    if (ms < 1000) return `${ms} ms`
    return `${(ms / 1000).toFixed(2)} 秒`
  } catch {
    return '-'
  }
}

// 状态对应圆点颜色
function dotColor(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return 'bg-success-400 ring-success-400/40'
    case 'failed':
    case 'error':
      return 'bg-destructive ring-destructive/40'
    case 'waiting':
    case 'waiting_for_approval':
      return 'bg-warning-400 ring-warning-400/40'
    case 'running':
      return 'bg-primary ring-primary/40'
    default:
      return 'bg-muted-foreground ring-gray-400/40'
  }
}

function statusBadgeClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return 'bg-success/20 text-success'
    case 'failed':
    case 'error':
      return 'bg-destructive/20 text-destructive'
    case 'waiting':
    case 'waiting_for_approval':
      return 'bg-warning/20 text-warning'
    case 'running':
      return 'bg-primary/20 text-primary'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

// 日志级别对应彩色标签样式
function logLevelBadgeClass(level) {
  switch ((level || '').toLowerCase()) {
    case 'info':
      return 'bg-primary/20 text-primary'
    case 'warning':
    case 'warn':
      return 'bg-warning/20 text-warning'
    case 'error':
      return 'bg-destructive/20 text-destructive'
    case 'debug':
      return 'bg-secondary text-muted-foreground'
    default:
      return 'bg-secondary text-muted-foreground'
  }
}

// JSON 查看器：等宽字体，可滚动，填满宽度，可折叠/展开
function JsonViewer({ label, data }) {
  const [open, setOpen] = useState(true)
  const isEmpty =
    data == null || (typeof data === 'object' && Object.keys(data).length === 0)
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-muted-foreground"
      >
        <span className="inline-block w-3 text-muted-foreground">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
        <span>{label}</span>
      </button>
      {open && (
        <pre className="w-full max-h-64 overflow-auto rounded-md bg-background p-4 font-mono text-xs text-muted-foreground ring-1 ring-border">
          {isEmpty ? '(空)' : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

// 日志区域：支持级别筛选、彩色标签、时间戳
function LogsSection({ logs }) {
  const [filter, setFilter] = useState('all')
  const levels = ['all', 'info', 'warning', 'error']
  const filtered =
    filter === 'all'
      ? logs
      : logs.filter((l) => (l.level || '').toLowerCase() === filter)

  return (
    <div className="mt-6 w-full">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-muted-foreground">
          日志（{logs.length} 条{filter !== 'all' ? `，筛选后 ${filtered.length} 条` : ''}）
        </div>
        <div className="flex items-center gap-1">
          {levels.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => setFilter(lv)}
              className={`rounded px-2 py-1 text-xs ${
                filter === lv
                  ? 'bg-secondary text-foreground'
                  : 'bg-secondary text-muted-foreground hover:bg-secondary'
              }`}
            >
              {lv === 'all' ? '全部' : lv}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
          暂无日志
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-border bg-card">
          {filtered.map((log, idx) => (
            <div
              key={idx}
              className="flex items-start gap-4 border-b border-border px-4 py-2 text-xs last:border-b-0"
            >
              <span className="shrink-0 text-muted-foreground">{fmtTime(log.timestamp)}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium uppercase ${logLevelBadgeClass(log.level)}`}
              >
                {log.level || '-'}
              </span>
              {log.node_id && (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                  {log.node_id}
                </span>
              )}
              <span className="min-w-0 flex-1 break-words text-muted-foreground">{log.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 执行追溯详情页：垂直时间轴
function ExecutionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await getExecutionDetail(id)
        if (!alive) return
        setData(res)
        setError('')
      } catch (err) {
        if (!alive) return
        setError(err.message || '加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  const execution = data?.execution || {}
  const traces = data?.traces || []
  const logs = data?.logs || []

  // 导出整个执行详情为 JSON 文件下载
  const handleExport = () => {
    if (!data) return
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `execution-${id}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setError('导出失败：' + (e?.message || e))
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('/executions')}
            className="btn-secondary btn-sm"
          >
            ← 返回列表
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">执行详情 #{id}</h1>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={!data}
          className="btn-secondary btn-sm"
        >
          导出 JSON
        </button>
      </header>

      {/* 内容滚动区 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            加载中...
          </div>
        ) : !data ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            未找到数据
          </div>
        ) : (
          <>
            {/* 执行概要 */}
            <div className="mb-6 w-full rounded-lg border border-border bg-card p-4">
              <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                <InfoCell label="执行 ID" value={`#${execution.id}`} />
                <InfoCell label="工作流 ID" value={execution.workflow_id} />
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">状态</div>
                  <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(execution.status)}`}>
                    {execution.status || '-'}
                  </span>
                </div>
                <InfoCell label="触发类型" value={execution.trigger_type || '-'} />
                <InfoCell label="创建时间" value={fmtTime(execution.created_at)} />
                <InfoCell label="完成时间" value={fmtTime(execution.finished_at)} />
                <InfoCell label="总耗时" value={duration(execution.created_at, execution.finished_at)} />
              </div>
            </div>

            {/* 垂直时间轴 */}
            <div className="w-full">
              <div className="mb-3 text-sm font-medium text-muted-foreground">
                执行轨迹（{traces.length} 个节点）
              </div>
              {traces.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  暂无轨迹数据
                </div>
              ) : (
                <div className="relative w-full">
                  {/* 时间轴左侧轴线 */}
                  <div className="absolute bottom-0 left-[11px] top-2 w-px bg-secondary" />
                  <div className="flex flex-col gap-4">
                    {traces.map((tr) => (
                      <div key={tr.id} className="relative flex w-full gap-4">
                        {/* 圆点 */}
                        <div
                          className={`relative z-dropdown mt-1 h-5 w-5 shrink-0 rounded-full ring-4 ${dotColor(tr.status)}`}
                        />
                        {/* 右侧详情卡片：填满剩余宽度 */}
                        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {tr.node_label || tr.node_type || `节点 ${tr.node_id}`}
                              </span>
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                                {tr.node_type}
                              </span>
                            </div>
                            <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(tr.status)}`}>
                              {tr.status || '-'}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 py-2 text-xs text-muted-foreground">
                            <span>开始：{fmtTime(tr.started_at)}</span>
                            <span>结束：{fmtTime(tr.finished_at)}</span>
                            <span className="inline-flex items-center gap-1">
                              耗时：
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                                {duration(tr.started_at, tr.finished_at)}
                              </span>
                            </span>
                          </div>
                          <div className="flex w-full flex-col gap-4 pt-2 sm:flex-row">
                            <JsonViewer label="输入" data={tr.input} />
                            <JsonViewer label="输出" data={tr.output} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 日志区 */}
            <LogsSection logs={logs} />
          </>
        )}
      </div>
    </div>
  )
}

// 信息单元
function InfoCell({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm text-foreground" title={String(value)}>
        {value == null ? '-' : String(value)}
      </div>
    </div>
  )
}

export default ExecutionDetail
