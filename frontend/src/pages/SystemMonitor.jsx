import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Radio, ClipboardList, Package, FileText, Brain, HardDrive, Disc, Timer,
  Activity, AlertTriangle, CheckCircle2, XCircle, Server, Database, Cpu,
  RefreshCw, Search, Download, Copy, X, ChevronDown, ChevronRight, Play, Pause,
  Layers, Zap, TrendingUp, TrendingDown, ShieldAlert, Bell,
} from 'lucide-react'
import { systemMonitorApi } from '../api/systemMonitor'
import { toast } from '../store/toastStore'
import AuditLogsPanel, { RESOURCE_LABELS, ActionBadge, ResultBadge } from '../components/audit/AuditLogsPanel'
import { CompactSelect } from '../components/ui'

// ============ 常量映射 ============
// 审计相关常量（RESOURCE_LABELS / ACTION_META / ActionBadge / ResultBadge）抽至 components/audit/AuditLogsPanel.jsx 共享
// 服务分组映射
const SERVICE_GROUPS = {
  '数据层': ['soar-postgres', 'soar-redis'],
  '应用层': ['soar-backend', 'soar-frontend'],
  '任务层': ['soar-worker', 'soar-beat'],
  '外部依赖': [],
}

// 格式化字节数
const fmtBytes = (b) => {
  if (!b || b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ============ 工具函数 ============
function fmtTime(t) {
  if (!t) return '-'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}
function fmtRelative(t) {
  if (!t) return '-'
  const diff = Date.now() - new Date(t).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
function fmtUptime(seconds) {
  if (seconds == null || seconds < 0) return '-'
  const s = Math.floor(Number(seconds) || 0)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分钟`
  return `${minutes}分钟`
}
function progressColor(percent) {
  if (percent > 90) return 'bg-destructive'
  if (percent > 80) return 'bg-warning'
  if (percent >= 60) return 'bg-warning'
  return 'bg-success'
}
// 解析日志级别
function parseLogLevel(line) {
  const upper = (line || '').toUpperCase()
  if (upper.includes('ERROR') || upper.includes('CRITICAL') || upper.includes('FATAL')) return 'ERROR'
  if (upper.includes('WARN')) return 'WARN'
  if (upper.includes('DEBUG')) return 'DEBUG'
  if (upper.includes('INFO')) return 'INFO'
  return 'INFO'
}
function copyText(text) {
  if (!text) return
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast.success('已复制')).catch(() => {}) }
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast.success('已复制') } catch {} document.body.removeChild(ta) }
}
// ============ 通用组件 ============
function ProgressBar({ percent }) {
  const safe = Math.min(100, Math.max(0, Number(percent) || 0))
  return <div className="h-2 w-full overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full transition-all ${progressColor(safe)}`} style={{ width: `${safe}%` }} /></div>
}
// 迷你折线图（Sparkline，纯 SVG）
function Sparkline({ data, color = '#6366f1', height = 40, width = 120, threshold }) {
  if (!data || data.length < 2) return <div className="text-[10px] text-muted-foreground">暂无趋势</div>
  const max = Math.max(...data, threshold || 0, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const stepX = width / (data.length - 1)
  const points = data.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ')
  const thresholdY = threshold != null ? (height - ((threshold - min) / range) * height) : null
  return (
    <svg width={width} height={height} className="overflow-visible">
      {thresholdY != null && <line x1="0" y1={thresholdY} x2={width} y2={thresholdY} stroke="#ef4444" strokeWidth="1" strokeDasharray="3,2" />}
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={width} cy={height - ((data[data.length - 1] - min) / range) * height} r="2" fill={color} />
    </svg>
  )
}
// 趋势折线图（带网格、阈值线、时间轴）
function TrendChart({ data, color = '#6366f1', unit = '%', thresholdWarn, thresholdCrit, height = 160 }) {
  if (!data || data.length < 2) return <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">采集数据中...</div>
  const w = 600
  const h = height
  const padL = 40, padR = 10, padT = 10, padB = 20
  const cw = w - padL - padR
  const ch = h - padT - padB
  const max = 100
  const stepX = cw / (data.length - 1)
  const toY = (v) => padT + ch - (Math.min(v, max) / max) * ch
  const toX = (i) => padL + i * stepX
  const points = data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
  const areaPoints = `${padL},${padT + ch} ${points} ${padL + cw},${padT + ch}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: h }}>
      {/* 网格线 */}
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={padL} y1={toY(g)} x2={padL + cw} y2={toY(g)} stroke="currentColor" strokeWidth="0.5" opacity="0.15" />
          <text x={padL - 4} y={toY(g) + 3} textAnchor="end" fontSize="9" fill="currentColor" opacity="0.5">{g}{unit}</text>
        </g>
      ))}
      {/* 阈值线 */}
      {thresholdWarn != null && <line x1={padL} y1={toY(thresholdWarn)} x2={padL + cw} y2={toY(thresholdWarn)} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4,3" />}
      {thresholdCrit != null && <line x1={padL} y1={toY(thresholdCrit)} x2={padL + cw} y2={toY(thresholdCrit)} stroke="#ef4444" strokeWidth="1" strokeDasharray="4,3" />}
      {/* 面积 */}
      <polygon points={areaPoints} fill={color} opacity="0.1" />
      {/* 折线 */}
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
      {/* 当前点 */}
      <circle cx={toX(data.length - 1)} cy={toY(data[data.length - 1])} r="3" fill={color} />
    </svg>
  )
}
// 服务状态徽章：healthy=绿/degraded=黄/unhealthy=红/unknown=灰（运行中带呼吸点）
function ServiceStatusBadge({ status }) {
  const map = {
    healthy: { cls: 'bg-success/20 text-success', label: '正常', pulse: true },
    degraded: { cls: 'bg-warning/20 text-warning', label: '降级' },
    unhealthy: { cls: 'bg-destructive/20 text-destructive', label: '故障' },
    unknown: { cls: 'bg-muted text-muted-foreground', label: '未知' },
  }
  const item = map[status] || map.unknown
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${item.cls}`}>
      {item.pulse && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current dot-pulse" />}
      {item.label}
    </span>
  )
}
function OverallBadge({ overall }) {
  if (overall === 'healthy') return <span className="inline-flex items-center gap-1.5 rounded-full bg-success/20 px-3 py-1 text-sm font-medium text-success"><span className="h-2 w-2 rounded-full bg-success dot-pulse" />系统正常</span>
  if (overall === 'degraded') return <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/20 px-3 py-1 text-sm font-medium text-warning"><span className="h-2 w-2 rounded-full bg-warning" />系统降级</span>
  if (overall === 'unhealthy') return <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/20 px-3 py-1 text-sm font-medium text-destructive"><span className="h-2 w-2 rounded-full bg-destructive" />系统异常</span>
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground"><span className="h-2 w-2 rounded-full bg-muted-foreground" />未知</span>
}
function ContainerStatusBadge({ status, running }) {
  if (running) return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/20 px-2 py-0.5 text-[11px] font-medium text-success">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current dot-pulse" />
      running
    </span>
  )
  if (status === 'exited' || status === 'dead') return <span className="rounded-full bg-destructive/20 px-2 py-0.5 text-[11px] font-medium text-destructive">{status || 'unknown'}</span>
  return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{status || 'unknown'}</span>
}
// 日志级别彩色行
function LogLevelBadge({ level }) {
  const map = {
    ERROR: 'bg-destructive/20 text-destructive',
    WARN: 'bg-warning/20 text-warning',
    INFO: 'bg-info/20 text-info',
    DEBUG: 'bg-muted text-muted-foreground',
  }
  return <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${map[level] || map.INFO}`}>{level}</span>
}

// ============ 历史采样 hook（用于趋势图，存 localStorage） ============
function useHistoryBuffer(key, maxPoints = 120) {
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`soar_history_${key}`) || '[]') } catch { return [] }
  })
  const push = useCallback((value) => {
    setHistory((prev) => {
      const next = [...prev, value]
      if (next.length > maxPoints) next.shift()
      try { localStorage.setItem(`soar_history_${key}`, JSON.stringify(next)) } catch {}
      return next
    })
  }, [key, maxPoints])
  const clear = useCallback(() => { setHistory([]); try { localStorage.removeItem(`soar_history_${key}`) } catch {} }, [key])
  return { history, push, clear }
}

// ============ Tab 0：监控概览 ============
function OverviewTab({ onNavigate }) {
  const [health, setHealth] = useState(null)
  const [perf, setPerf] = useState(null)
  const [recentLogs, setRecentLogs] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [h, p, logs] = await Promise.all([
        systemMonitorApi.health(),
        systemMonitorApi.performance(),
        systemMonitorApi.auditLogs({ limit: 8, offset: 0 }),
      ])
      setHealth(h); setPerf(p); setRecentLogs(logs?.logs || [])
    } catch {} finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const services = health?.services || []
  const healthyCount = services.filter((s) => s.status === 'healthy').length
  const unhealthyCount = services.filter((s) => s.status === 'unhealthy' || s.status === 'degraded').length
  // 健康评分
  const healthScore = services.length > 0 ? Math.round((healthyCount / services.length) * 100) : 100
  // 近24小时审计失败数
  const failedCount = recentLogs.filter((l) => l.result === 'failed' || l.result === 'error').length

  const scoreColor = healthScore >= 90 ? 'text-success' : healthScore >= 60 ? 'text-warning' : 'text-destructive'
  const scoreBg = healthScore >= 90 ? 'bg-success' : healthScore >= 60 ? 'bg-warning' : 'bg-destructive'

  if (loading) return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>

  return (
    <div className="flex flex-col gap-4">
      {/* 概览卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* 健康评分 */}
        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">系统健康评分</span>
            <Activity className={`h-4 w-4 ${scoreColor}`} />
          </div>
          <div className={`text-glow text-2xl font-bold tabular-nums ${scoreColor}`}>{healthScore}<span className="text-sm text-muted-foreground">/100</span></div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${scoreBg}`} style={{ width: `${healthScore}%` }} /></div>
        </div>
        {/* 告警数 */}
        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">服务异常</span>
            <ShieldAlert className={`h-4 w-4 ${unhealthyCount > 0 ? 'text-destructive' : 'text-success'}`} />
          </div>
          <div className={`text-glow text-2xl font-bold tabular-nums ${unhealthyCount > 0 ? 'text-destructive' : 'text-success'}`}>{unhealthyCount}</div>
          <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">{healthyCount} 正常 / {unhealthyCount} 异常</div>
        </div>
        {/* CPU 峰值 */}
        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">CPU 使用率</span>
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className={`text-glow text-2xl font-bold tabular-nums ${(perf?.cpu_percent ?? 0) > 80 ? 'text-destructive' : 'text-foreground'}`}>{Math.round(perf?.cpu_percent ?? 0)}<span className="text-sm text-muted-foreground">%</span></div>
          <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">{perf?.cpu_count ?? '-'} 核</div>
        </div>
        {/* 内存 */}
        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">内存使用率</span>
            <HardDrive className="h-4 w-4 text-primary" />
          </div>
          <div className={`text-glow text-2xl font-bold tabular-nums ${(perf?.memory?.percent ?? 0) > 85 ? 'text-destructive' : 'text-foreground'}`}>{Math.round(perf?.memory?.percent ?? 0)}<span className="text-sm text-muted-foreground">%</span></div>
          <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">{perf?.memory?.used_gb ?? '-'} / {perf?.memory?.total_gb ?? '-'} GB</div>
        </div>
      </div>

      {/* 告警横幅 */}
      {unhealthyCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1 text-sm text-destructive">
            {services.filter((s) => s.status !== 'healthy').map((s) => s.name).join('、')} 服务异常，请及时处理
          </div>
          <button onClick={() => onNavigate('health')} className="shrink-0 rounded border border-destructive/40 px-3 py-1 text-xs text-destructive hover:bg-destructive/20">查看详情</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 服务状态摘要 */}
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Server className="h-4 w-4 text-primary" />各服务健康状态</h3>
          <div className="flex flex-col gap-2">
            {services.map((s) => (
              <div key={s.name} className="flex items-center justify-between rounded-md border border-border bg-secondary px-3 py-2 transition hover:border-primary/30">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${s.status === 'healthy' ? 'bg-success dot-pulse' : s.status === 'degraded' ? 'bg-warning' : 'bg-destructive'}`} />
                  <span className="text-sm text-foreground">{s.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] tabular-nums text-muted-foreground">{s.latency_ms != null ? `${s.latency_ms}ms` : '-'}</span>
                  <ServiceStatusBadge status={s.status} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 最近审计事件 */}
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ClipboardList className="h-4 w-4 text-primary" />最近操作记录</h3>
          <div className="flex flex-col gap-1.5">
            {recentLogs.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">暂无记录</div>
            ) : recentLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary">
                <ResultBadge result={log.result} />
                <ActionBadge action={log.action} />
                <span className="text-muted-foreground">{RESOURCE_LABELS[log.resource_type] || log.resource_type}</span>
                <span className="text-foreground">{log.username || '-'}</span>
                <span className="ml-auto text-muted-foreground" title={fmtTime(log.created_at)}>{fmtRelative(log.created_at)}</span>
              </div>
            ))}
          </div>
          <button onClick={() => onNavigate('audit')} className="mt-2 w-full text-center text-[11px] text-primary hover:underline">查看全部审计日志 →</button>
        </div>
      </div>
    </div>
  )
}

// ============ Tab 1：服务健康 ============
function HealthTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshInterval, setRefreshInterval] = useState(30)
  const [countdown, setCountdown] = useState(30)

  const load = useCallback(async () => {
    try { const res = await systemMonitorApi.health(); setData(res); setError('') }
    catch (err) { setError(err.message || '加载失败') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // 自动刷新：带倒计时
  useEffect(() => {
    if (!autoRefresh) return
    setCountdown(refreshInterval)
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { load(); return refreshInterval }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [autoRefresh, refreshInterval, load])

  const services = data?.services || []
  // 按后端 group 字段分组归类（组内异常优先）
  const groupedServices = useMemo(() => {
    const groups = {}
    const order = { unhealthy: 0, degraded: 1, unknown: 2, healthy: 3 }
    services.forEach((s) => {
      const gname = s.group || '其他服务'
      if (!groups[gname]) groups[gname] = []
      groups[gname].push(s)
    })
    Object.values(groups).forEach((arr) => arr.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)))
    return groups
  }, [services])
  // 异常服务置顶
  const sortedServices = useMemo(() => {
    const order = { unhealthy: 0, degraded: 1, unknown: 2, healthy: 3 }
    return [...services].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [services])

  const selectCls = 'h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none transition hover:border-primary/50 focus:border-primary'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-4">
          {data ? <OverallBadge overall={data.overall} /> : null}
          <span className="text-xs tabular-nums text-muted-foreground">最后检查：{data?.checked_at ? fmtTime(data.checked_at) : '-'}</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            自动刷新
          </label>
          {autoRefresh && (
            <>
              <CompactSelect size="lg" value={refreshInterval} onChange={(e) => { setRefreshInterval(Number(e.target.value)); setCountdown(Number(e.target.value)) }}>
                <option value={10}>10 秒</option>
                <option value={30}>30 秒</option>
                <option value={60}>1 分钟</option>
                <option value={300}>5 分钟</option>
              </CompactSelect>
              <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary dot-pulse" />
                {countdown} 秒后刷新
              </span>
            </>
          )}
          <button type="button" onClick={load} disabled={loading} className="btn-secondary btn-sm">{loading ? '刷新中...' : '刷新'}</button>
        </div>
      </div>

      {error && <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      {loading && !data ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 按分组展示 */}
          {Object.entries(groupedServices).map(([gname, svcs]) => svcs.length > 0 && (
            <div key={gname}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Layers className="h-3.5 w-3.5" /> {gname}
                <span className="font-normal text-muted-foreground">({svcs.length})</span>
              </h3>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {svcs.map((svc) => (
                  <div key={svc.name} className={`rounded-lg border p-5 shadow-lg transition-colors hover:border-primary/40 ${svc.status === 'unhealthy' ? 'border-destructive/40 bg-destructive/5' : svc.status === 'degraded' ? 'border-warning/40 bg-warning/5' : 'border-border bg-card'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-semibold text-foreground">{svc.name}</div>
                      <ServiceStatusBadge status={svc.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>延迟：{svc.latency_ms != null ? `${svc.latency_ms} ms` : '-'}</span>
                      <span className="text-muted-foreground">·</span>
                      <span title={svc.detail}>详情：{svc.detail ? (svc.detail.length > 40 ? svc.detail.slice(0, 40) + '...' : svc.detail) : '-'}</span>
                    </div>
                    {/* 容器资源使用率 */}
                    {svc.container && svc.mem_pct != null && (
                      <div className="mt-2 flex flex-wrap items-center gap-4 border-t border-border pt-2 text-xs">
                        <span className="flex items-center gap-1.5">
                          <Cpu className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">CPU</span>
                          <span className={`font-medium tabular-nums ${svc.cpu_pct > 80 ? 'text-destructive' : svc.cpu_pct > 50 ? 'text-amber-500' : 'text-emerald-500'}`}>
                            {svc.cpu_pct ?? 0}%
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <HardDrive className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">内存</span>
                          <span className={`font-medium tabular-nums ${svc.mem_pct > 80 ? 'text-destructive' : svc.mem_pct > 50 ? 'text-amber-500' : 'text-emerald-500'}`}>
                            {svc.mem_pct}%
                          </span>
                          <span className="text-muted-foreground">
                            ({fmtBytes(svc.mem_usage)} / {fmtBytes(svc.mem_limit)})
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============ Tab 2：性能指标 ============
function PerformanceTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [timeRange, setTimeRange] = useState('1h')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const cpuHist = useHistoryBuffer('cpu')
  const memHist = useHistoryBuffer('mem')
  const diskHist = useHistoryBuffer('disk')

  const load = useCallback(async () => {
    try {
      const res = await systemMonitorApi.performance()
      setData(res); setError('')
      // 采样到历史
      if (res?.cpu_percent != null) cpuHist.push(Math.round(res.cpu_percent))
      if (res?.memory?.percent != null) memHist.push(Math.round(res.memory.percent))
      if (res?.disk?.percent != null) diskHist.push(Math.round(res.disk.percent))
    } catch (err) { setError(err.message || '加载失败') } finally { setLoading(false) }
  }, [cpuHist, memHist, diskHist])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [autoRefresh, load])

  const cpuPercent = data?.cpu_percent ?? 0
  const mem = data?.memory || {}
  const disk = data?.disk || {}
  const uptime = data?.uptime_seconds

  // 根据时间范围过滤历史数据点数
  const filterHistory = (hist) => {
    const points = timeRange === '1h' ? 60 : timeRange === '6h' ? 120 : timeRange === '24h' ? 144 : 168
    return hist.slice(-points)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <span className="text-xs text-muted-foreground">实时性能指标 · 自动采样趋势</span>
        <div className="flex items-center gap-2">
          <CompactSelect size="lg" value={timeRange} onChange={(e) => setTimeRange(e.target.value)}>
            <option value="1h">最近 1 小时</option>
            <option value="6h">最近 6 小时</option>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
          </CompactSelect>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            自动采集
          </label>
          <button type="button" onClick={load} disabled={loading} className="btn-secondary btn-sm">{loading ? '刷新中...' : '刷新'}</button>
        </div>
      </div>

      {error && <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* 趋势图表 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2"><Cpu className="h-4 w-4 text-primary" /><span className="text-sm font-semibold">CPU 使用率趋势</span></div>
            <span className={`text-glow text-xl font-bold tabular-nums ${cpuPercent > 90 ? 'text-destructive' : cpuPercent > 80 ? 'text-warning' : 'text-foreground'}`}>{Math.round(cpuPercent)}%</span>
          </div>
          <div className="text-muted-foreground"><TrendChart data={filterHistory(cpuHist.history)} color="#6366f1" thresholdWarn={80} thresholdCrit={90} /></div>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
            <span><span className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: '#f59e0b' }} />预警 80%</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: '#ef4444' }} />告警 90%</span>
            <span>核心数：{data?.cpu_count ?? '-'}</span>
          </div>
        </div>

        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-primary" /><span className="text-sm font-semibold">内存使用率趋势</span></div>
            <span className={`text-glow text-xl font-bold tabular-nums ${(mem.percent ?? 0) > 90 ? 'text-destructive' : (mem.percent ?? 0) > 85 ? 'text-warning' : 'text-foreground'}`}>{Math.round(mem.percent ?? 0)}%</span>
          </div>
          <div className="text-muted-foreground"><TrendChart data={filterHistory(memHist.history)} color="#10b981" thresholdWarn={85} thresholdCrit={95} /></div>
          <div className="mt-2 text-[10px] text-muted-foreground">{mem.used_gb ?? '-'} GB / {mem.total_gb ?? '-'} GB</div>
        </div>

        <div className="card-accent-top rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2"><Disc className="h-4 w-4 text-warning" /><span className="text-sm font-semibold">磁盘使用率趋势</span></div>
            <span className={`text-glow text-xl font-bold tabular-nums ${(disk.percent ?? 0) > 90 ? 'text-destructive' : 'text-foreground'}`}>{Math.round(disk.percent ?? 0)}%</span>
          </div>
          <div className="text-muted-foreground"><TrendChart data={filterHistory(diskHist.history)} color="#f59e0b" thresholdWarn={85} thresholdCrit={95} /></div>
          <div className="mt-2 text-[10px] text-muted-foreground">{disk.used_gb ?? '-'} GB / {disk.total_gb ?? '-'} GB</div>
        </div>

        {/* 运行时长 + 瞬时指标 */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center gap-2"><Timer className="h-4 w-4 text-success" /><span className="text-sm font-semibold">系统运行信息</span></div>
          <div className="grid grid-cols-2 gap-3 text-xs tabular-nums">
            <div><span className="text-muted-foreground">运行时长：</span><span className="font-medium text-foreground">{fmtUptime(uptime)}</span></div>
            <div><span className="text-muted-foreground">CPU 核心数：</span><span className="font-medium text-foreground">{data?.cpu_count ?? '-'}</span></div>
            <div><span className="text-muted-foreground">内存总量：</span><span className="font-medium text-foreground">{mem.total_gb ?? '-'} GB</span></div>
            <div><span className="text-muted-foreground">内存已用：</span><span className="font-medium text-foreground">{mem.used_gb ?? '-'} GB</span></div>
            <div><span className="text-muted-foreground">磁盘总量：</span><span className="font-medium text-foreground">{disk.total_gb ?? '-'} GB</span></div>
            <div><span className="text-muted-foreground">磁盘已用：</span><span className="font-medium text-foreground">{disk.used_gb ?? '-'} GB</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ============ Tab 4：服务日志 ============
function ServiceLogsTab() {
  const [services, setServices] = useState([])
  const [error, setError] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const [selected, setSelected] = useState([])
  const [logs, setLogs] = useState([])
  const [logsError, setLogsError] = useState('')
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [tail, setTail] = useState(200)
  // 日志展示控制
  const [levelFilter, setLevelFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [regexMode, setRegexMode] = useState(false)
  const [liveTail, setLiveTail] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [relTime, setRelTime] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const logsEndRef = useRef(null)
  const logsContainerRef = useRef(null)

  const loadServices = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await systemMonitorApi.listServices()
      setServices(res?.services || [])
      setError(res?.error || '')
      if (selected.length === 0 && (res?.services || []).length > 0) setSelected([res.services[0].name])
    } catch (err) { setError(err.message || '加载失败'); setServices([]) } finally { setLoadingList(false) }
  }, [selected])

  const loadLogs = useCallback(async () => {
    if (selected.length === 0) return
    setLoadingLogs(true); setLogsError('')
    try {
      const allLogs = []
      for (const name of selected) {
        const res = await systemMonitorApi.getServiceLogs(name, tail)
        if (res?.logs) allLogs.push(...res.logs.map((l) => ({ container: name, text: l, level: parseLogLevel(l) })))
      }
      setLogs(allLogs.reverse())
    } catch (err) { setLogsError(err.message || '获取日志失败'); setLogs([]) } finally { setLoadingLogs(false) }
  }, [selected, tail])

  useEffect(() => { loadServices() }, [loadServices])
  useEffect(() => { if (selected.length > 0) loadLogs() }, [selected, tail, loadLogs])

  // 实时 Tail
  useEffect(() => {
    if (!liveTail) return
    const t = setInterval(loadLogs, 3000)
    return () => clearInterval(t)
  }, [liveTail, loadLogs])

  // 自动滚动
  useEffect(() => {
    if (autoScroll && logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const toggleContainer = (name) => {
    setSelected((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name])
  }

  // 过滤日志
  const filteredLogs = useMemo(() => {
    let result = logs
    if (levelFilter !== 'ALL') result = result.filter((l) => l.level === levelFilter)
    if (search.trim()) {
      if (regexMode) {
        try { const re = new RegExp(search); result = result.filter((l) => re.test(l.text)) } catch {}
      } else {
        const q = search.toLowerCase()
        result = result.filter((l) => l.text.toLowerCase().includes(q))
      }
    }
    return result
  }, [logs, levelFilter, search, regexMode])

  const levelColors = {
    ERROR: 'text-destructive',
    WARN: 'text-warning',
    INFO: 'text-foreground',
    DEBUG: 'text-muted-foreground',
  }

  const handleDownload = (maxLines) => {
    const lines = filteredLogs.slice(0, maxLines).map((l) => `[${l.container}] ${l.text}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${selected.join('_') || 'logs'}-${Date.now()}.log`; a.click()
    URL.revokeObjectURL(url)
    setDownloadOpen(false)
    toast.success(`已下载 ${lines.length} 行日志`)
  }

  const selectCls = 'h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none transition hover:border-primary/50 focus:border-primary'

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* 级别筛选 */}
          <div className="flex items-center gap-1">
            {['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'].map((lv) => (
              <button key={lv} type="button" onClick={() => setLevelFilter(lv)} className={`rounded px-2 py-0.5 text-[10px] font-medium ${levelFilter === lv ? (lv === 'ERROR' ? 'bg-destructive/20 text-destructive' : lv === 'WARN' ? 'bg-warning/20 text-warning' : lv === 'ALL' ? 'bg-primary/20 text-primary' : lv === 'DEBUG' ? 'bg-muted text-muted-foreground' : 'bg-info/20 text-info') : 'text-muted-foreground hover:bg-secondary'}`}>{lv}</button>
            ))}
          </div>
          {/* 搜索 */}
          <div className="flex items-center gap-1">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={regexMode ? '正则搜索...' : '关键词搜索...'} className="h-9 w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none transition hover:border-primary/50 focus:border-primary" />
            <button type="button" onClick={() => setRegexMode((p) => !p)} className={`rounded px-1.5 py-0.5 text-[9px] transition ${regexMode ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`} title="正则模式">.*</button>
          </div>
          {/* 实时 Tail */}
          <button type="button" onClick={() => setLiveTail((p) => !p)} className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition ${liveTail ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'}`}>
            {liveTail ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />} {liveTail ? '暂停' : '实时跟踪'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground">
            <CompactSelect size="lg" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              <option value={100}>100</option><option value="200">200</option><option value={500}>500</option><option value={1000}>1000</option>
            </CompactSelect> 行
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="h-3 w-3 accent-primary" /> 自动滚动</label>
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"><input type="checkbox" checked={relTime} onChange={(e) => setRelTime(e.target.checked)} className="h-3 w-3 accent-primary" /> 相对时间</label>
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="h-3 w-3 accent-primary" /> 自动换行</label>
          <button type="button" onClick={loadServices} disabled={loadingList} className="btn-secondary btn-sm">{loadingList ? '刷新中...' : '刷新服务'}</button>
          <button type="button" onClick={() => setDownloadOpen(true)} disabled={filteredLogs.length === 0} className="btn-secondary btn-sm">下载</button>
        </div>
      </div>

      {error && <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* 左侧：容器列表（支持多选） */}
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="flex items-center justify-between px-2 py-2">
            <span className="text-xs font-medium text-muted-foreground">服务容器（{services.length}）</span>
            <span className="text-[10px] text-primary">已选 {selected.length}</span>
          </div>
          {loadingList && services.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">加载中...</div>
          ) : services.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-muted-foreground"><Package className="h-8 w-8" /><div className="text-xs">暂无容器数据</div></div>
          ) : (
            <div className="flex flex-col gap-1">
              {services.map((svc) => {
                const active = selected.includes(svc.name)
                return (
                  <button key={svc.name} type="button" onClick={() => toggleContainer(svc.name)} className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition ${active ? 'bg-primary/15 text-foreground ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-muted'}`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{svc.name}</div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{svc.image || '-'}</div>
                      {svc.mem_pct != null && svc.running && (
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] tabular-nums">
                          <span className={svc.cpu_pct > 80 ? 'text-destructive' : svc.cpu_pct > 50 ? 'text-amber-500' : 'text-emerald-500/80'}>
                            CPU {svc.cpu_pct ?? 0}%
                          </span>
                          <span className={svc.mem_pct > 80 ? 'text-destructive' : svc.mem_pct > 50 ? 'text-amber-500' : 'text-emerald-500/80'}>
                            内存 {svc.mem_pct}% ({fmtBytes(svc.mem_usage)})
                          </span>
                        </div>
                      )}
                    </div>
                    <ContainerStatusBadge status={svc.status} running={svc.running} />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 右侧：日志内容 */}
        <div className="flex min-h-[500px] flex-col rounded-lg border border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{selected.join(' + ') || '未选择服务'}</span>
              <span className="text-[11px] text-muted-foreground">显示 {filteredLogs.length} / {logs.length} 行</span>
            </div>
            <button type="button" onClick={loadLogs} disabled={selected.length === 0 || loadingLogs} className="btn-secondary btn-sm">{loadingLogs ? '拉取中...' : '刷新日志'}</button>
          </div>
          <div ref={logsContainerRef} className="flex-1 overflow-auto p-2">
            {logsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{logsError}</div>
            ) : loadingLogs && logs.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">拉取日志中...</div>
            ) : selected.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">请在左侧选择服务容器</div>
            ) : filteredLogs.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-1 text-muted-foreground"><FileText className="h-8 w-8" /><div className="text-xs">{logs.length === 0 ? '暂无日志输出' : '无匹配日志'}</div></div>
            ) : (
              <div className="font-mono text-[11px] leading-relaxed">
                {filteredLogs.map((ln, idx) => (
                  <div key={idx} className={`border-b border-border px-2 py-0.5 hover:bg-muted ${wrap ? '' : 'whitespace-nowrap overflow-x-auto'}`} onClick={() => copyText(ln.text)} title="点击复制">
                    {selected.length > 1 && <span className="mr-2 rounded bg-secondary px-1 text-[9px] text-primary">{ln.container}</span>}
                    <LogLevelBadge level={ln.level} />
                    <span className={`ml-2 ${levelColors[ln.level] || 'text-muted-foreground'}`}>{ln.text}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 下载弹窗 */}
      {downloadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setDownloadOpen(false)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">下载日志</h3>
              <button onClick={() => setDownloadOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground">当前筛选结果共 {filteredLogs.length} 行，请选择下载范围：</p>
            <div className="flex flex-col gap-2">
              <button onClick={() => handleDownload(1000)} className="btn-secondary btn-sm">下载前 1000 行</button>
              <button onClick={() => handleDownload(10000)} className="btn-secondary btn-sm">下载前 1 万行</button>
              <button onClick={() => handleDownload(100000)} className="btn-secondary btn-sm">下载前 10 万行</button>
              <button onClick={() => handleDownload(Infinity)} className="btn-primary btn-sm">下载全部（{filteredLogs.length} 行）</button>
            </div>
            {filteredLogs.length > 100000 && <p className="mt-2 text-[10px] text-warning">⚠ 日志量较大，建议选择限制行数</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 主组件 ============
function SystemMonitor() {
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { key: 'overview', label: '监控概览' },
    { key: 'health', label: '服务健康' },
    { key: 'performance', label: '性能指标' },
    { key: 'logs', label: '服务日志' },
    { key: 'audit', label: '审计日志' },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">系统监控</h1>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-border bg-card px-6">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)} className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${activeTab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t.label}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'overview' && <OverviewTab onNavigate={setActiveTab} />}
        {activeTab === 'health' && <HealthTab />}
        {activeTab === 'performance' && <PerformanceTab />}
        {activeTab === 'logs' && <ServiceLogsTab />}
        {activeTab === 'audit' && <AuditLogsPanel />}
      </div>
    </div>
  )
}

export default SystemMonitor
