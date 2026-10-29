// 日志中心：统一查看系统所有日志（操作日志/执行记录/执行日志/模型调用）。
// 优化：概览+趋势+明细布局、多维筛选、错误聚合、详情抽屉、分类保留策略、实时tail、批量导出。
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  ScrollText, ShieldCheck, Activity, Cpu, Database, Settings2,
  RefreshCw, Download, Play, Pause, Trash2, Copy, Zap,
  TrendingUp, AlertCircle, Clock, Eye,
} from 'lucide-react'
import { logsApi } from '../api/logs'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import HalfDrawer from '../components/HalfDrawer'
import { Pagination, DataTable, StatusBadge, CompactSelect } from '../components/ui'

// ===== 工具函数 =====
function fmtTime(t) {
  if (!t) return '--'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}
function fmtRelative(t) {
  if (!t) return '--'
  try {
    const ts = new Date(t).getTime()
    if (isNaN(ts)) return t
    const diff = Date.now() - ts
    if (diff < 0) return '刚刚'
    const s = Math.floor(diff / 1000)
    if (s < 60) return '刚刚'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}小时前`
    const d = Math.floor(h / 24)
    return `${d}天前`
  } catch { return t }
}
function fmtNum(n) {
  if (n == null) return '--'
  return Number(n).toLocaleString()
}
function fmtDuration(ms) {
  if (ms == null) return '--'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// 将审计日志的原始 JSON detail 转为人话摘要
function summarizeAuditDetail(detail, action, resourceType) {
  if (!detail) return '--'
  // 尝试解析 JSON
  let obj = null
  try {
    obj = typeof detail === 'string' ? JSON.parse(detail) : detail
  } catch {
    // 非 JSON，直接截断返回
    return String(detail).slice(0, 60)
  }
  if (!obj || typeof obj !== 'object') return String(detail).slice(0, 60)
  // 提取关键信息拼接摘要
  const parts = []
  if (obj.method) parts.push(obj.method)
  if (obj.path) {
    // 只取最后一段路径
    const seg = obj.path.split('?')[0].split('/').filter(Boolean).pop() || obj.path
    parts.push(seg)
  }
  if (obj.status) parts.push(`${obj.status}`)
  if (obj.name) parts.push(obj.name)
  if (obj.username) parts.push(obj.username)
  if (obj.target) parts.push(obj.target)
  if (obj.resource_name) parts.push(obj.resource_name)
  // 如果没有提取到关键字段，回退到 action + resource_type
  if (parts.length === 0) {
    if (action) parts.push(action)
    if (resourceType) parts.push(resourceType)
  }
  return parts.length > 0 ? parts.join(' · ') : String(detail).slice(0, 60)
}

// 错误分类标签：统一蓝色系深浅，仅在表达严重度时用红/黄
const ERROR_CAT_META = {
  dns_resolve: { cls: 'bg-primary/15 text-primary', label: 'DNS解析失败' },
  timeout: { cls: 'bg-primary/15 text-primary', label: '请求超时' },
  quota_exceeded: { cls: 'bg-primary/15 text-primary', label: '配额/限流' },
  auth_failed: { cls: 'bg-destructive/15 text-destructive', label: '鉴权失败' },
  model_unavailable: { cls: 'bg-destructive/15 text-destructive', label: '模型不可用' },
  server_error: { cls: 'bg-destructive/15 text-destructive', label: '服务端错误' },
  network_error: { cls: 'bg-warning/15 text-warning', label: '网络异常' },
  other: { cls: 'bg-muted text-muted-foreground', label: '其他错误' },
  unknown: { cls: 'bg-muted text-muted-foreground', label: '未知' },
}
function ErrorBadge({ category }) {
  const m = ERROR_CAT_META[category] || ERROR_CAT_META.other
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${m.cls}`}>{m.label}</span>
}

// 状态徽章：统一圆角胶囊
function ResultBadge({ result }) {
  const ok = result === 'success'
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}>{ok ? '成功' : '失败'}</span>
}
function LevelBadge({ level }) {
  const map = { error: 'bg-destructive/15 text-destructive', warning: 'bg-warning/15 text-warning', info: 'bg-info/15 text-info' }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map[(level || '').toLowerCase()] || 'bg-muted text-muted-foreground'}`}>{(level || 'info').toUpperCase()}</span>
}
function ExecStatusBadge({ status }) {
  const s = (status || '').toLowerCase()
  if (!s) return <span className="text-xs text-muted-foreground">--</span>
  // 统一圆点+文字状态徽章：运行中由 StatusBadge 自动呼吸点（dot-pulse）
  return <StatusBadge status={s} />
}

// 统计卡片（带成功率/环比）：标签左对齐，数字右对齐等宽千分位
function StatCard({ icon: Icon, label, value, sub, subColor, color = 'text-foreground', onClick }) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 ${onClick ? 'cursor-pointer transition-colors hover:border-primary/40 hover:bg-primary/5' : ''}`}
      onClick={onClick}
    >
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${color === 'text-success' ? 'bg-success/15' : color === 'text-destructive' ? 'bg-destructive/15' : color === 'text-warning' ? 'bg-warning/15' : 'bg-primary/15'}`}>
        <Icon className={`h-3.5 w-3.5 ${color}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-left text-[10px] text-muted-foreground">{label}</div>
        <div className={`text-right text-base font-semibold tabular-nums ${color}`}>{value}</div>
        {sub && <div className={`text-right text-[9px] tabular-nums ${subColor || 'text-muted-foreground'}`}>{sub}</div>}
      </div>
    </div>
  )
}

// 迷你趋势图（7天柱状图）：带坐标轴、网格线、数值标签、hover 详情
function MiniTrendChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <TrendingUp className="h-3 w-3" />7天趋势
        </div>
        <div className="flex h-24 items-center justify-center text-[10px] text-muted-foreground">暂无数据</div>
      </div>
    )
  }
  const maxVal = Math.max(...data.map((d) => d.audit + d.executions + d.execution_logs + d.model_calls), 1)
  // Y 轴 4 等分刻度：0 在下，向上递增
  const yTicks = [maxVal, Math.round(maxVal * 0.75), Math.round(maxVal * 0.5), Math.round(maxVal * 0.25), 0]
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      {/* 标题 + 标题下边距 16px */}
      <div className="mb-4 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <TrendingUp className="h-3 w-3" />7天日志趋势
      </div>
      <div className="flex" style={{ height: '140px' }}>
        {/* Y 轴刻度（0 在下，向上递增） */}
        <div className="relative mr-2 w-8 shrink-0">
          {yTicks.map((t, i) => (
            <div key={i} className="absolute right-0 flex translate-y-1/2 items-center" style={{ bottom: `${(i / (yTicks.length - 1)) * 100}%` }}>
              <span className="text-[9px] tabular-nums text-muted-foreground">{t}</span>
            </div>
          ))}
        </div>
        {/* 图表主体 */}
        <div className="relative flex-1">
          {/* 水平网格线：极淡虚线 */}
          {yTicks.map((_, i) => (
            <div key={i} className="absolute left-0 right-0 border-t border-dashed border-white/10" style={{ bottom: `${(i / (yTicks.length - 1)) * 100}%` }} />
          ))}
          {/* 柱子 */}
          <div className="relative flex h-full items-end justify-between gap-1">
            {data.map((d, i) => {
              const total = d.audit + d.executions + d.execution_logs + d.model_calls
              const h = Math.max((total / maxVal) * 100, 1)
              return (
                <div key={i} className="group relative flex flex-1 flex-col items-center">
                  {/* hover 详情：日期 + 各类型数量 */}
                  <div className="pointer-events-none absolute -top-2 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-[10px] shadow-lg group-hover:block">
                    <div className="mb-0.5 font-semibold text-foreground">{d.date}</div>
                    <div className="text-muted-foreground">总计 {total} 条</div>
                    <div className="text-muted-foreground">操作 {d.audit} · 执行 {d.executions}</div>
                    <div className="text-muted-foreground">日志 {d.execution_logs} · 模型 {d.model_calls}</div>
                  </div>
                  {/* 柱顶数值标签 */}
                  <span className="mb-0.5 text-[9px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{total}</span>
                  {/* 柱子：品牌主色，hover 加深 */}
                  <div className="flex w-full items-end justify-center" style={{ height: '120px' }}>
                    <div
                      className="w-full max-w-[24px] rounded-t bg-primary transition-all group-hover:bg-primary/80 group-hover:shadow-[0_0_8px_rgba(0,212,170,0.4)]"
                      style={{ height: `${h}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {/* X 轴日期标签 */}
      <div className="mt-1 flex pl-10">
        {data.map((d, i) => (
          <span key={i} className="flex-1 text-center text-[9px] text-muted-foreground">{d.date.slice(5)}</span>
        ))}
      </div>
    </div>
  )
}

// 错误聚合 TOP5：统一蓝色系深浅表示数量高低
function TopErrorsPanel({ errors, onFilter }) {
  if (!errors || errors.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <AlertCircle className="h-3 w-3" />错误类型 TOP5
        </div>
        <div className="flex h-10 items-center justify-center text-[10px] text-muted-foreground">暂无错误</div>
      </div>
    )
  }
  const maxCount = Math.max(...errors.map((e) => e.count), 1)
  // 蓝色系深浅：数量越高越深
  const blueShades = ['bg-primary', 'bg-primary/80', 'bg-primary/60', 'bg-primary/45', 'bg-primary/30']
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <AlertCircle className="h-3 w-3" />错误类型 TOP5
        </span>
        <span className="text-[10px] text-muted-foreground">点击筛选</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {errors.map((e, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onFilter?.(e.category)}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-primary/5"
          >
            <span className="w-16 shrink-0 truncate text-[10px] text-muted-foreground">{e.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-secondary">
              <div className={`h-full ${blueShades[i] || 'bg-primary/30'}`} style={{ width: `${(e.count / maxCount) * 100}%` }} />
            </div>
            <span className="w-10 text-right text-[10px] tabular-nums text-foreground">{e.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// 存储进度条
function StorageBar({ used, max, onCleanup, cleaning }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0
  const color = pct > 80 ? 'bg-destructive' : pct > 60 ? 'bg-warning' : 'bg-success'
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Database className="h-3 w-3" />存储用量
        </span>
        <button
          type="button"
          onClick={onCleanup}
          disabled={cleaning}
          className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 disabled:opacity-50"
        >
          <Trash2 className="h-2.5 w-2.5" />{cleaning ? '清理中' : '清理'}
        </button>
      </div>
      <div className="mb-1 h-2.5 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span className="tabular-nums">{used} MB</span>
        <span className="tabular-nums">/ {max} MB ({pct.toFixed(1)}%)</span>
      </div>
    </div>
  )
}

// ===== 常量配置 =====
const PAGE_SIZE = 20
const TABS = [
  { key: 'audit', label: '操作日志', icon: ShieldCheck },
  { key: 'executions', label: '执行记录', icon: ScrollText },
  { key: 'execution-logs', label: '执行日志', icon: Activity },
  { key: 'model-calls', label: '模型调用', icon: Cpu },
]
const AUDIT_ACTIONS = [
  { value: '', label: '全部操作' }, { value: 'login', label: '登录' }, { value: 'logout', label: '登出' },
  { value: 'create', label: '创建' }, { value: 'update', label: '更新' }, { value: 'delete', label: '删除' },
  { value: 'execute', label: '执行' }, { value: 'export', label: '导出' },
]
const RESULT_OPTIONS = [{ value: '', label: '全部结果' }, { value: 'success', label: '成功' }, { value: 'failed', label: '失败' }]
const EXEC_STATUS_OPTIONS = [
  { value: '', label: '全部状态' }, { value: 'success', label: '成功' }, { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' }, { value: 'waiting_for_approval', label: '待审批' },
]
const LOG_LEVEL_OPTIONS = [{ value: '', label: '全部级别' }, { value: 'error', label: '错误' }, { value: 'warning', label: '警告' }, { value: 'info', label: '信息' }]
const TIME_RANGES = [
  { value: '', label: '全部时间' },
  { value: '15m', label: '近15分钟' },
  { value: '1h', label: '近1小时' },
  { value: '24h', label: '近24小时' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
]

// 时间范围 → ISO 字符串
function rangeToStartTime(range) {
  if (!range) return null
  const now = new Date()
  const map = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }
  const ms = map[range]
  if (!ms) return null
  return new Date(now.getTime() - ms).toISOString()
}

// 推荐保留配置
const RETENTION_PRESETS = [
  { name: '生产环境', config: { audit_retention_days: 180, executions_retention_days: 90, execution_logs_retention_days: 90, model_calls_retention_days: 30, max_storage_mb: 2000 } },
  { name: '开发环境', config: { audit_retention_days: 30, executions_retention_days: 14, execution_logs_retention_days: 14, model_calls_retention_days: 7, max_storage_mb: 500 } },
  { name: '最小存储', config: { audit_retention_days: 14, executions_retention_days: 7, execution_logs_retention_days: 7, model_calls_retention_days: 3, max_storage_mb: 200 } },
]

function LogCenter() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialWorkflowId = searchParams.get('workflow_id') || ''
  const initialUsername = searchParams.get('username') || ''
  const [tab, setTab] = useState(initialWorkflowId ? 'executions' : 'audit')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedKeys, setSelectedKeys] = useState([])

  // 筛选条件（各 Tab 独立 + 通用时间范围）
  const [timeRange, setTimeRange] = useState('')
  const [auditFilter, setAuditFilter] = useState({ action: '', result: '', username: initialUsername })
  const [execFilter, setExecFilter] = useState({ workflow_id: initialWorkflowId, status: '', trigger_type: '' })
  const [execLogFilter, setExecLogFilter] = useState({ execution_id: '', level: '', keyword: '' })
  const [modelFilter, setModelFilter] = useState({ status: '', model_name: '', provider: '', error_category: '' })

  // 统计
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // 保留策略
  const [retention, setRetention] = useState(null)
  const [retentionEditing, setRetentionEditing] = useState(null)
  const [savingRetention, setSavingRetention] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  // 实时 tail 模式
  const [tailMode, setTailMode] = useState(false)
  const tailTimerRef = useRef(null)

  // 详情抽屉
  const [detailItem, setDetailItem] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const offset = (page - 1) * pageSize
  const startTime = useMemo(() => rangeToStartTime(timeRange), [timeRange])

  // 加载统计
  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const data = await logsApi.stats()
      setStats(data)
      setRetention(data.retention)
      setRetentionEditing(data.retention)
    } catch { /* 静默 */ } finally { setStatsLoading(false) }
  }, [])

  useEffect(() => { loadStats() }, [loadStats])

  // 加载列表
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const common = { limit: pageSize, offset, start_time: startTime || undefined }
      let res
      if (tab === 'audit') res = await logsApi.audit({ ...common, ...auditFilter })
      else if (tab === 'executions') res = await logsApi.executions({ ...common, ...execFilter })
      else if (tab === 'execution-logs') res = await logsApi.executionLogs({ ...common, ...execLogFilter })
      else if (tab === 'model-calls') res = await logsApi.modelCalls({ ...common, ...modelFilter })
      setItems(res?.items || [])
      setTotal(res?.total ?? 0)
      setSelectedKeys([])
    } catch (err) {
      setError(err.message || '加载失败')
      setItems([]); setTotal(0)
    } finally { setLoading(false) }
  }, [tab, offset, pageSize, startTime, auditFilter, execFilter, execLogFilter, modelFilter])

  useEffect(() => { load() }, [load])

  // 实时 tail 模式：每 5 秒自动刷新
  useEffect(() => {
    if (!tailMode) {
      if (tailTimerRef.current) { clearInterval(tailTimerRef.current); tailTimerRef.current = null }
      return
    }
    tailTimerRef.current = setInterval(() => { load() }, 5000)
    return () => { if (tailTimerRef.current) clearInterval(tailTimerRef.current) }
  }, [tailMode, load])

  const switchTab = (next) => { setTab(next); setPage(1); setSelectedKeys([]); setModelFilter((f) => ({ ...f, error_category: '' })) }

  // 保存保留策略
  const handleSaveRetention = async () => {
    if (!retentionEditing) return
    setSavingRetention(true)
    try {
      const res = await logsApi.updateRetention(retentionEditing)
      setRetention(res)
      toast.success('保留策略已更新')
      await loadStats()
    } catch (err) { toast.error('保存失败：' + (err.message || '未知错误')) }
    finally { setSavingRetention(false) }
  }

  // 应用推荐配置
  const applyPreset = (preset) => {
    setRetentionEditing((r) => ({ ...r, ...preset.config }))
    toast.info(`已应用「${preset.name}」配置，点击保存生效`)
  }

  // 手动清理
  const handleCleanup = async () => {
    const ok = await confirm({
      title: '清理过期日志',
      message: '将按各类型保留天数删除过期日志，此操作不可撤销。确定继续？',
      confirmText: '确定清理', danger: true,
    })
    if (!ok) return
    setCleaning(true)
    try {
      const res = await logsApi.cleanup()
      toast.success(`已清理 ${res.total} 条过期日志`)
      await loadStats(); await load()
    } catch (err) { toast.error('清理失败：' + (err.message || '未知错误')) }
    finally { setCleaning(false) }
  }

  // 批量导出 CSV
  const handleExport = () => {
    if (selectedKeys.length === 0) { toast.warning('请先勾选要导出的日志'); return }
    const selected = items.filter((it) => selectedKeys.includes(it.id))
    if (selected.length === 0) return
    const headers = Object.keys(selected[0])
    const csv = [
      headers.join(','),
      ...selected.map((row) => headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `logs_${tab}_${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${selected.length} 条日志`)
  }

  // 查看详情（模型调用加载完整信息）
  const handleViewDetail = async (row) => {
    setDetailItem(row)
    setDetailLoading(true)
    try {
      if (tab === 'model-calls') {
        const full = await logsApi.modelCallDetail(row.id)
        if (full && !full.error) setDetailItem(full)
      }
    } catch { /* 使用列表数据 */ } finally { setDetailLoading(false) }
  }

  // 复制错误信息
  const handleCopyError = (msg) => {
    if (!msg) return
    navigator.clipboard.writeText(msg).then(() => toast.success('已复制错误信息'))
  }

  // 输入控件：统一 input-base 风格（悬停边框反馈 + 聚焦主色环），控件统一 h-9
  const inputCls = 'input-base h-9'
  const filterSelectCls = 'input-base !w-auto h-9'
  const filterInputCls = 'input-base !w-auto h-9 min-w-[160px] flex-1'
  const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground'

  // ===== 表格列定义（各 Tab 差异化） =====
  const columns = useMemo(() => {
    const timeCol = (key) => ({
      key, header: '时间', width: '120px',
      render: (r) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={fmtTime(r[key])}>
          {fmtRelative(r[key])}
        </span>
      ),
    })
    if (tab === 'audit') return [
      { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
      { key: 'username', header: '用户', width: '100px', render: (r) => <span className="truncate text-foreground" title={r.username}>{r.username || '--'}</span> },
      { key: 'action', header: '操作', width: '80px', render: (r) => <span className="text-muted-foreground">{r.action || '--'}</span> },
      { key: 'resource_type', header: '资源类型', width: '100px', render: (r) => <span className="text-muted-foreground">{r.resource_type || '--'}</span> },
      { key: 'ip_address', header: 'IP', width: '120px', render: (r) => <span className="truncate font-mono text-xs text-muted-foreground" title={r.ip_address}>{r.ip_address || '--'}</span> },
      { key: 'result', header: '结果', width: '60px', render: (r) => <ResultBadge result={r.result} /> },
      { key: 'detail', header: '详情', render: (r) => {
        // 将原始 JSON 详情转为人话摘要
        const summary = summarizeAuditDetail(r.detail, r.action, r.resource_type)
        return <span className="truncate text-xs text-muted-foreground" title={summary}>{summary}</span>
      } },
      timeCol('created_at'),
      { key: '_op', header: '', width: '60px', render: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleViewDetail(r) }} className="rounded px-1.5 py-0.5 text-[10px] text-primary opacity-60 transition-opacity hover:opacity-100" title="查看详情">
          详情
        </button>
      ) },
    ]
    if (tab === 'executions') return [
      { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
      { key: 'workflow_id', header: '工作流', width: '100px', render: (r) => <span className="text-muted-foreground">{r.workflow_id ? `#${r.workflow_id}` : '—（智能体测试）'}</span> },
      { key: 'trigger_type', header: '触发类型', width: '100px', render: (r) => <span className="text-muted-foreground">{r.trigger_type || '--'}</span> },
      { key: 'status', header: '状态', width: '70px', render: (r) => <ExecStatusBadge status={r.status} /> },
      { key: 'created_at', header: '创建时间', width: '120px', render: (r) => <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={fmtTime(r.created_at)}>{fmtRelative(r.created_at)}</span> },
      { key: 'finished_at', header: '完成时间', width: '120px', render: (r) => <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={fmtTime(r.finished_at)}>{fmtRelative(r.finished_at)}</span> },
      { key: '_op', header: '', width: '60px', render: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/executions/${r.id}`) }} className="rounded px-1.5 py-0.5 text-[10px] text-primary opacity-60 transition-opacity hover:opacity-100" title="查看追溯详情">
          追溯
        </button>
      ) },
    ]
    if (tab === 'execution-logs') return [
      { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
      { key: 'execution_id', header: '执行ID', width: '70px', render: (r) => <span className="font-mono text-primary">#{r.execution_id}</span> },
      { key: 'node_id', header: '节点', width: '120px', render: (r) => <span className="truncate font-mono text-xs text-muted-foreground" title={r.node_id}>{r.node_id || '--'}</span> },
      { key: 'level', header: '级别', width: '60px', render: (r) => <LevelBadge level={r.level} /> },
      { key: 'message', header: '消息', render: (r) => <span className="truncate text-xs text-muted-foreground" title={r.message}>{r.message || '--'}</span> },
      timeCol('timestamp'),
      { key: '_op', header: '', width: '60px', render: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleViewDetail(r) }} className="rounded px-1.5 py-0.5 text-[10px] text-primary opacity-60 transition-opacity hover:opacity-100" title="查看详情">
          详情
        </button>
      ) },
    ]
    // model-calls
    return [
      { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
      { key: 'model_name', header: '模型', width: '180px', render: (r) => <span className="truncate text-foreground" title={r.model_name}>{r.model_name || '--'}</span> },
      { key: 'provider', header: '供应商', width: '90px', render: (r) => <span className="text-muted-foreground">{r.provider || '--'}</span> },
      { key: 'status', header: '状态', width: '60px', render: (r) => <ResultBadge result={r.status} /> },
      { key: 'error_category', header: '错误类型', width: '90px', render: (r) => r.error_category ? <ErrorBadge category={r.error_category} /> : <span className="text-muted-foreground">--</span> },
      { key: 'latency_ms', header: '耗时', width: '70px', numeric: true, render: (r) => <span className="tabular-nums text-muted-foreground">{fmtDuration(r.latency_ms)}</span> },
      { key: 'total_tokens', header: 'Token', width: '80px', numeric: true, render: (r) => <span className="tabular-nums text-muted-foreground">{r.total_tokens ? fmtNum(r.total_tokens) : '--'}</span> },
      { key: 'trigger_type', header: '来源', width: '90px', render: (r) => <span className="text-muted-foreground">{r.trigger_type || '--'}</span> },
      { key: 'error_message', header: '错误信息', width: '200px', render: (r) => r.error_message ? (
        <div className="flex items-center gap-1">
          <span className="truncate text-xs text-destructive/80" title={r.error_message}>{r.error_message}</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); handleCopyError(r.error_message) }} className="shrink-0 text-muted-foreground hover:text-primary" title="复制错误信息"><Copy className="h-3 w-3" /></button>
        </div>
      ) : <span className="text-muted-foreground">--</span> },
      timeCol('created_at'),
      { key: '_op', header: '', width: '60px', render: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleViewDetail(r) }} className="rounded px-1.5 py-0.5 text-[10px] text-primary opacity-60 transition-opacity hover:opacity-100" title="查看详情">
          详情
        </button>
      ) },
    ]
  }, [tab, navigate])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">日志中心</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* 实时 tail 模式 */}
          <button
            type="button"
            onClick={() => setTailMode((v) => !v)}
            className={`btn-sm inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors ${
              tailMode ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
            title={tailMode ? '暂停自动刷新' : '开启实时刷新（5秒）'}
          >
            {tailMode ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {tailMode ? '暂停' : '实时'}
          </button>
          <button type="button" onClick={loadStats} className="btn-secondary btn-sm inline-flex items-center gap-1">
            <RefreshCw className="h-3.5 w-3.5" />刷新统计
          </button>
          <button type="button" onClick={() => setShowConfig((v) => !v)} className="btn-secondary btn-sm inline-flex items-center gap-1">
            <Settings2 className="h-3.5 w-3.5" />保留策略
          </button>
        </div>
      </header>

      {/* 概览区：上排 KPI 卡片（横向填满） + 下排 趋势图+TOP5+存储进度 */}
      {!showConfig && (
        <div className="space-y-1.5 border-b border-border bg-card px-6 py-2">
          {/* 上排：4 个 KPI 卡片横向填满 */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard icon={ShieldCheck} label="操作日志" value={fmtNum(stats?.counts?.audit)} sub={stats?.storage_mb?.audit_logs ? `${stats.storage_mb.audit_logs} MB` : ''} onClick={() => switchTab('audit')} />
            <StatCard icon={ScrollText} label="执行记录" value={fmtNum(stats?.counts?.executions)} sub={stats?.storage_mb?.executions ? `${stats.storage_mb.executions} MB` : ''} onClick={() => switchTab('executions')} />
            <StatCard icon={Activity} label="执行日志" value={fmtNum(stats?.counts?.execution_logs)} sub={stats?.storage_mb?.execution_logs ? `${stats.storage_mb.execution_logs} MB` : ''} onClick={() => switchTab('execution-logs')} />
            <StatCard
              icon={Cpu}
              label="模型调用"
              value={fmtNum(stats?.counts?.model_calls)}
              sub={stats?.model_call_stats ? `成功率 ${stats.model_call_stats.success_rate}%` : ''}
              subColor={stats?.model_call_stats && stats.model_call_stats.success_rate >= 95 ? 'text-success' : stats?.model_call_stats && stats.model_call_stats.success_rate >= 80 ? 'text-warning' : 'text-destructive'}
              color={stats?.model_call_stats && stats.model_call_stats.success_rate >= 95 ? 'text-success' : 'text-foreground'}
              onClick={() => switchTab('model-calls')}
            />
          </div>
          {/* 下排：趋势图 + TOP5 + 存储进度，三列均分 */}
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
            <MiniTrendChart data={stats?.by_day} />
            <TopErrorsPanel errors={stats?.top_errors} onFilter={(cat) => { switchTab('model-calls'); setModelFilter((f) => ({ ...f, error_category: cat, status: 'failed' })) }} />
            <StorageBar used={stats?.total_storage_mb ?? 0} max={retention?.max_storage_mb ?? 500} onCleanup={handleCleanup} cleaning={cleaning} />
          </div>
        </div>
      )}

      {/* 保留策略抽屉（从右侧滑出） */}
      <HalfDrawer
        open={showConfig}
        onClose={() => setShowConfig(false)}
        title="日志保留策略"
        loading={false}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setShowConfig(false)} className="btn-secondary btn-sm">取消</button>
            <button type="button" onClick={handleSaveRetention} disabled={savingRetention} className="btn-primary btn-sm">
              {savingRetention ? '保存中...' : '保存'}
            </button>
          </div>
        }
      >
        {retentionEditing && (
          <div className="space-y-5">
            {/* 推荐配置 */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-muted-foreground">推荐配置：</span>
              {RETENTION_PRESETS.map((p) => (
                <button key={p.name} type="button" onClick={() => applyPreset(p)} className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-primary">
                  <Zap className="mr-1 inline h-2.5 w-2.5" />{p.name}
                </button>
              ))}
            </div>

            {/* 存储进度条（顶部可视化） */}
            <div className="rounded-md border border-border bg-secondary p-3">
              <div className="mb-1.5 flex justify-between text-xs">
                <span className="text-muted-foreground">当前存储用量</span>
                <span className="tabular-nums text-foreground">{stats?.total_storage_mb ?? 0} / {retentionEditing.max_storage_mb} MB</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full transition-all duration-500 ${((stats?.total_storage_mb ?? 0) / (retentionEditing.max_storage_mb || 1)) * 100 > 80 ? 'bg-destructive' : ((stats?.total_storage_mb ?? 0) / (retentionEditing.max_storage_mb || 1)) * 100 > 60 ? 'bg-warning' : 'bg-success'}`}
                  style={{ width: `${Math.min(((stats?.total_storage_mb ?? 0) / (retentionEditing.max_storage_mb || 1)) * 100, 100)}%` }}
                />
              </div>
            </div>

            {/* 分组1：按日志类型保留天数 */}
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground">按日志类型保留天数</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>操作日志</label>
                  <input type="number" min={7} max={365} className={inputCls} value={retentionEditing.audit_retention_days} onChange={(e) => setRetentionEditing((r) => ({ ...r, audit_retention_days: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>执行记录</label>
                  <input type="number" min={7} max={365} className={inputCls} value={retentionEditing.executions_retention_days} onChange={(e) => setRetentionEditing((r) => ({ ...r, executions_retention_days: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>执行日志</label>
                  <input type="number" min={7} max={365} className={inputCls} value={retentionEditing.execution_logs_retention_days} onChange={(e) => setRetentionEditing((r) => ({ ...r, execution_logs_retention_days: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>模型调用</label>
                  <input type="number" min={7} max={365} className={inputCls} value={retentionEditing.model_calls_retention_days} onChange={(e) => setRetentionEditing((r) => ({ ...r, model_calls_retention_days: e.target.value }))} />
                </div>
              </div>
            </div>

            {/* 分组2：全局配额 */}
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground">全局配额</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>最大存储量（MB）</label>
                  <input type="number" min={50} max={10240} className={inputCls} value={retentionEditing.max_storage_mb} onChange={(e) => setRetentionEditing((r) => ({ ...r, max_storage_mb: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>全局默认保留（天）</label>
                  <input type="number" min={7} max={365} className={inputCls} value={retentionEditing.retention_days} onChange={(e) => setRetentionEditing((r) => ({ ...r, retention_days: e.target.value }))} />
                </div>
              </div>
            </div>

            {/* 危险操作区：清理按钮单独放底部，灰色次要样式 */}
            <div className="flex items-center justify-between rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">删除超过保留天数的过期日志，不可撤销</span>
              <button type="button" onClick={handleCleanup} disabled={cleaning} className="rounded border border-border bg-secondary px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50">
                <Trash2 className="mr-1 inline h-2.5 w-2.5" />{cleaning ? '清理中...' : '立即清理'}
              </button>
            </div>
          </div>
        )}
      </HalfDrawer>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-6 py-2">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => switchTab(t.key)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === t.key ? 'bg-primary/10 text-primary ring-1 ring-primary/25' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
            <t.icon className="h-3.5 w-3.5" />{t.label}
            {stats?.counts && (
              <span className={`rounded px-1 text-[10px] tabular-nums ${tab === t.key ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                {t.key === 'audit' ? fmtNum(stats.counts.audit) : t.key === 'executions' ? fmtNum(stats.counts.executions) : t.key === 'execution-logs' ? fmtNum(stats.counts.execution_logs) : fmtNum(stats.counts.model_calls)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 筛选栏：卡片条样式，控件统一 input-base 风格（h-9） */}
      <div className="border-b border-border px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
          {/* 时间范围快捷选择 */}
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <CompactSelect size="lg" value={timeRange} onChange={(e) => { setTimeRange(e.target.value); setPage(1) }}>
              {TIME_RANGES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CompactSelect>
          </label>
          {/* 各 Tab 特有筛选 */}
          {tab === 'audit' && (
            <>
              <CompactSelect size="lg" value={auditFilter.action} onChange={(e) => { setAuditFilter((f) => ({ ...f, action: e.target.value })); setPage(1) }}>
                {AUDIT_ACTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
              <CompactSelect size="lg" value={auditFilter.result} onChange={(e) => { setAuditFilter((f) => ({ ...f, result: e.target.value })); setPage(1) }}>
                {RESULT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
              <input type="text" className={filterInputCls} placeholder="搜索用户名..." value={auditFilter.username} onChange={(e) => { setAuditFilter((f) => ({ ...f, username: e.target.value })); setPage(1) }} />
            </>
          )}
          {tab === 'executions' && (
            <>
              <CompactSelect size="lg" value={execFilter.status} onChange={(e) => { setExecFilter((f) => ({ ...f, status: e.target.value })); setPage(1) }}>
                {EXEC_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
              <input type="text" inputMode="numeric" className={filterInputCls} placeholder="工作流 ID（数字）..." value={execFilter.workflow_id} onChange={(e) => { setExecFilter((f) => ({ ...f, workflow_id: e.target.value })); setPage(1) }} />
            </>
          )}
          {tab === 'execution-logs' && (
            <>
              <CompactSelect size="lg" value={execLogFilter.level} onChange={(e) => { setExecLogFilter((f) => ({ ...f, level: e.target.value })); setPage(1) }}>
                {LOG_LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
              <input type="text" inputMode="numeric" className="input-base !w-32 h-9" placeholder="执行 ID" value={execLogFilter.execution_id} onChange={(e) => { setExecLogFilter((f) => ({ ...f, execution_id: e.target.value })); setPage(1) }} />
              <input type="text" className={filterInputCls} placeholder="搜索日志消息..." value={execLogFilter.keyword} onChange={(e) => { setExecLogFilter((f) => ({ ...f, keyword: e.target.value })); setPage(1) }} />
            </>
          )}
          {tab === 'model-calls' && (
            <>
              <CompactSelect size="lg" value={modelFilter.status} onChange={(e) => { setModelFilter((f) => ({ ...f, status: e.target.value, error_category: e.target.value === 'failed' ? f.error_category : '' })); setPage(1) }}>
                {RESULT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
              {modelFilter.status === 'failed' && (
                <CompactSelect size="lg" value={modelFilter.error_category} onChange={(e) => { setModelFilter((f) => ({ ...f, error_category: e.target.value })); setPage(1) }}>
                  <option value="">全部错误类型</option>
                  {Object.entries(ERROR_CAT_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </CompactSelect>
              )}
              <input type="text" className={filterInputCls} placeholder="搜索模型名..." value={modelFilter.model_name} onChange={(e) => { setModelFilter((f) => ({ ...f, model_name: e.target.value })); setPage(1) }} />
            </>
          )}
          {/* 批量导出 */}
          {selectedKeys.length > 0 && (
            <button type="button" onClick={handleExport} className="ml-auto btn-secondary btn-sm inline-flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />导出 {selectedKeys.length} 条
            </button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-6 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* 表格 */}
      <div className="flex-1 overflow-y-auto px-6 py-3">
        {/* 加载中显示骨架屏，空数据走 DataTable 内置空态 */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <DataTable
            columns={columns}
            data={items}
            rowKey="id"
            loading={loading}
            selectable
            selectedKeys={selectedKeys}
            onSelectChange={setSelectedKeys}
            onRowClick={handleViewDetail}
            stickyHeader
            emptyText="暂无日志记录"
            emptyDescription="系统运行后日志将在此显示"
            emptyIcon={ScrollText}
          />
        </div>

        {/* 分页 */}
        {!loading && items.length > 0 && (
          <div className="mt-4">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              pageSizeOptions={[10, 20, 50, 100]}
            />
          </div>
        )}
      </div>

      {/* 详情抽屉 */}
      <HalfDrawer open={!!detailItem} onClose={() => setDetailItem(null)} title={detailItem ? `${TABS.find((t) => t.key === tab)?.label}详情 #${detailItem.id}` : ''} loading={detailLoading}>
        {detailItem && <LogDetailPanel item={detailItem} tab={tab} onCopyError={handleCopyError} onNavigate={(path) => navigate(path)} />}
      </HalfDrawer>
    </div>
  )
}

// 日志详情面板（抽屉内容）
function LogDetailPanel({ item, tab, onCopyError, onNavigate }) {
  // 键值行：label + value 两列布局；full=true 时整行跨两列（长文本）
  const Row = ({ label, value, mono, full }) => (
    <div className={`flex gap-3 border-b border-border py-2 ${full ? 'col-span-full' : ''}`}>
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 break-all text-sm text-foreground ${mono ? 'font-mono text-xs tabular-nums' : ''}`}>{value || '--'}</span>
    </div>
  )
  const Section = ({ title, children }) => (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">{children}</div>
    </div>
  )
  return (
    <div className="space-y-4 p-1">
      <Section title="基本信息">
        <Row label="ID" value={`#${item.id}`} mono />
        {tab === 'audit' && (
          <>
            <Row label="用户" value={item.username} />
            <Row label="操作" value={item.action} />
            <Row label="资源类型" value={item.resource_type} />
            <Row label="资源 ID" value={item.resource_id} mono />
            <Row label="IP" value={item.ip_address} mono />
            <Row label="结果" value={item.result === 'success' ? '成功' : '失败'} />
            <Row label="时间" value={fmtTime(item.created_at)} />
            {item.detail && <Row label="详情" value={item.detail} full />}
          </>
        )}
        {tab === 'executions' && (
          <>
            <Row label="工作流" value={item.workflow_id ? `#${item.workflow_id}` : '—（智能体测试）'} />
            <Row label="触发类型" value={item.trigger_type} />
            <Row label="状态" value={item.status} />
            <Row label="创建时间" value={fmtTime(item.created_at)} />
            <Row label="完成时间" value={fmtTime(item.finished_at)} />
            <button type="button" onClick={() => onNavigate(`/executions/${item.id}`)} className="col-span-full mt-2 inline-flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80">
              <Eye className="h-3.5 w-3.5" />查看完整追溯详情
            </button>
          </>
        )}
        {tab === 'execution-logs' && (
          <>
            <Row label="执行 ID" value={`#${item.execution_id}`} mono />
            <Row label="节点" value={item.node_id} mono />
            <Row label="级别" value={item.level} />
            <Row label="时间" value={fmtTime(item.timestamp)} />
            {item.message && <Row label="消息" value={item.message} full />}
          </>
        )}
        {tab === 'model-calls' && (
          <>
            <Row label="模型" value={item.model_name} />
            <Row label="供应商" value={item.provider} />
            <Row label="状态" value={item.status === 'success' ? '成功' : '失败'} />
            {item.error_category && <Row label="错误类型" value={<ErrorBadge category={item.error_category} />} />}
            <Row label="耗时" value={fmtDuration(item.latency_ms)} />
            <Row label="Input Tokens" value={fmtNum(item.input_tokens)} />
            <Row label="Output Tokens" value={fmtNum(item.output_tokens)} />
            <Row label="Total Tokens" value={fmtNum(item.total_tokens)} />
            <Row label="来源" value={item.trigger_type} />
            <Row label="调用 IP" value={item.source_ip} mono />
            <Row label="时间" value={fmtTime(item.created_at)} />
          </>
        )}
      </Section>

      {/* 错误信息（模型调用失败时） */}
      {tab === 'model-calls' && item.error_message && (
        <Section title="错误信息">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="flex-1">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-destructive/90">{item.error_message}</pre>
              <button type="button" onClick={() => onCopyError(item.error_message)} className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80">
                <Copy className="h-3 w-3" />复制错误
              </button>
            </div>
          </div>
          {item.error_stack && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] text-muted-foreground">错误堆栈：</div>
              <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">{item.error_stack}</pre>
            </div>
          )}
        </Section>
      )}

      {/* 请求/响应摘要（模型调用） */}
      {tab === 'model-calls' && (item.prompt_summary || item.response_summary) && (
        <Section title="调用摘要">
          {item.prompt_summary && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] text-muted-foreground">请求 Prompt：</div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">{item.prompt_summary}</pre>
            </div>
          )}
          {item.response_summary && (
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">响应摘要：</div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">{item.response_summary}</pre>
            </div>
          )}
        </Section>
      )}

      {/* 操作日志详情 */}
      {tab === 'audit' && item.detail && (
        <Section title="操作详情">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">{item.detail}</pre>
        </Section>
      )}

      {/* 执行日志消息 */}
      {tab === 'execution-logs' && item.message && (
        <Section title="完整消息">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">{item.message}</pre>
        </Section>
      )}
    </div>
  )
}

export default LogCenter
