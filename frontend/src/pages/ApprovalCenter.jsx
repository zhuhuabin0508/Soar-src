import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CheckCircle2,
  ClipboardList,
  Ban,
  ShieldBan,
  ShieldCheck,
  ScrollText,
  User,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  X,
  Copy,
  Download,
  AlertCircle,
  Clock,
  Rocket,
  Flag,
  Brain,
  Trash2,
  Activity,
} from 'lucide-react'
import {
  getApprovals,
  getApprovalStats,
  approveExecution,
  rejectExecution,
  deleteExecution,
} from '../api/approvals'
import { workflows as workflowsApi } from '../api/client'
import banWorkflowApi from '../api/banWorkflow'
import BanApprovals from './ban/BanApprovals'
import BanWorkbench from './ban/BanWorkbench'
import AnbotongBlacklist from './ban/AnbotongBlacklist'
import AnbotongWhitelist from './ban/AnbotongWhitelist'
import BanWorkflowInstances from './ban/BanWorkflowInstances'
import { inputBaseCls } from '../components/property/FormControls'
import { hasPermission } from '../utils/permissions'
import { confirm } from '../components/ConfirmDialog'
import { CompactSelect } from '../components/ui'

// ============ 工具函数 ============
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '-'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

function toText(v) {
  if (v == null) return '-'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// ============ 信息单元 ============
function InfoCell({ label, value, mono = true }) {
  const text = toText(value)
  const isEmpty = text === '-' || text === '' || text == null
  const display = typeof value === 'number' ? value.toLocaleString() : text
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`truncate ${mono ? 'font-mono' : ''} text-sm ${typeof value === 'number' ? 'tabular-nums' : ''} ${isEmpty ? 'text-muted-foreground' : 'text-foreground'}`}
        title={text}
      >
        {isEmpty ? '无' : display}
      </div>
    </div>
  )
}

// JSON 语法高亮（轻量级，返回 HTML 字符串）
function highlightJson(obj) {
  let json
  try { json = JSON.stringify(obj, null, 2) } catch { return '' }
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'text-amber-300' // number
      if (/^"/.test(match)) {
        if (/:$/.test(match)) cls = 'text-sky-300' // key
        else cls = 'text-emerald-300' // string
      } else if (/true|false/.test(match)) cls = 'text-purple-300'
      else if (/null/.test(match)) cls = 'text-muted-foreground'
      return `<span class="${cls}">${match}</span>`
    })
}

// ============ 完整上下文折叠区（JSON 高亮 + 复制/下载） ============
function ContextPanel({ ctx }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!ctx || typeof ctx !== 'object') return null
  const entries = Object.entries(ctx)
  if (entries.length === 0) return null

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(ctx, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(ctx, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `context_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-3 w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
      >
        <span>完整上下文（{entries.length} 项）</span>
        <span className="inline-flex items-center gap-1">{expanded ? '收起' : '展开'} {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</span>
      </button>
      {expanded && (
        <div className="mt-2 w-full overflow-hidden rounded-md border border-border bg-background">
          <div className="flex items-center justify-between border-b border-border bg-muted px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">JSON</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={handleCopy} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {copied ? '已复制' : '复制'}
              </button>
              <button type="button" onClick={handleDownload} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                <Download className="h-3 w-3" /> 下载
              </button>
            </div>
          </div>
          <pre
            className="max-h-96 w-full overflow-y-auto p-4 font-mono text-xs leading-relaxed"
            dangerouslySetInnerHTML={{ __html: highlightJson(ctx) }}
          />
        </div>
      )}
    </div>
  )
}

// ============ 推理过程日志 ============
function MessagesPanel({ messages }) {
  const [expanded, setExpanded] = useState(false)
  const list = Array.isArray(messages) ? messages : []
  return (
    <div className="mt-3 w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
      >
        <span>推理过程日志（{list.length} 条）</span>
        <span className="inline-flex items-center gap-1">{expanded ? '收起' : '展开'} {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</span>
      </button>
      {expanded && (
        <div className="mt-2 max-h-80 w-full overflow-y-auto rounded-md border border-border bg-background p-4">
          {list.length === 0 ? (
            <div className="text-xs text-muted-foreground">暂无日志</div>
          ) : (
            <div className="flex flex-col gap-2">
              {list.map((m, idx) => (
                <div
                  key={idx}
                  className="w-full border-b border-border pb-2 last:border-0"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        m.role === 'assistant'
                          ? 'bg-primary/20 text-primary'
                          : m.role === 'tool'
                          ? 'bg-primary/20 text-primary'
                          : 'bg-secondary text-muted-foreground'
                      }`}
                    >
                      {m.role}
                    </span>
                  </div>
                  <pre className="w-full whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                    {typeof m.content === 'string'
                      ? m.content
                      : JSON.stringify(m.content, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============ 快捷筛选 chips 定义（全部历史 Tab） ============
// 计数由前端从当前列表派生，仅作快速参考，不新增请求
const QUICK_FILTERS = [
  { value: 'success', label: '成功', dot: 'bg-success' },
  { value: 'failed', label: '失败', dot: 'bg-destructive' },
  { value: '今日', label: '今日', dot: 'bg-info' },
  { value: '近7天', label: '近 7 天', dot: 'bg-purple-400' },
]

// 工单结果近似判定（与快捷筛选的后端文本匹配语义对齐，用于 chips 计数）
function isSuccessItem(it) {
  const s = String(it?.status || '').toLowerCase()
  return s === 'success' || s === 'approved' || it?.context?.outcome === 'approved'
}

function isFailedItem(it) {
  const s = String(it?.status || '').toLowerCase()
  return s === 'failed' || s === 'rejected' || it?.context?.outcome === 'rejected'
}

// ============ 迷你时间线 ============
function MiniTimeline({ item }) {
  const alertData = item.alert_data || {}
  const decision = item.agent_decision || {}
  const ctx = item.context || {}
  const outcome = item.status !== 'waiting_for_approval'
    ? (ctx.outcome || (item.result && item.result.outcome) || item.status)
    : null

  const nodes = [
    { label: '告警触发', time: item.created_at, done: true, icon: <AlertCircle className="h-3 w-3" /> },
    { label: 'Agent 研判', time: item.agent_decided_at || item.updated_at, done: !!(decision.decision), icon: <Brain className="h-3 w-3" /> },
    { label: '人工审批', time: item.reviewed_at, done: outcome != null, icon: <User className="h-3 w-3" /> },
    {
      label: outcome === 'approved' ? '已封禁' : outcome === 'rejected' ? '已忽略' : '待处理',
      time: item.finished_at || item.updated_at,
      done: outcome != null,
      icon: outcome === 'approved' ? <Ban className="h-3 w-3" /> : outcome === 'rejected' ? <X className="h-3 w-3" /> : <Clock className="h-3 w-3" />,
    },
  ]
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {nodes.map((n, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <div className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
            n.done ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground'
          }`}>
            {n.icon}
            <span>{n.label}</span>
            {n.done && n.time && <span className="text-muted-foreground">· {fmtTime(n.time).split(' ')[1] || ''}</span>}
          </div>
          {idx < nodes.length - 1 && <span className="text-muted-foreground">→</span>}
        </div>
      ))}
    </div>
  )
}

// ============ 工单卡片 ============
function ApprovalCard({ item, onApprove, onReject, onDelete, busy }) {
  const alertData = item.alert_data || {}
  const decision = item.agent_decision || {}
  const ctx = item.context || {}
  const reviewMeta = item.review_meta || {}
  const isPending = item.status === 'waiting_for_approval'
  const isRejected = item.status === 'rejected' || ctx.outcome === 'rejected'

  // 已处理工单展示 outcome 徽章
  const outcome = !isPending ? (ctx.outcome || (item.result && item.result.outcome) || item.status) : null

  // 关键字段摘要
  const summaryItems = [
    { label: '告警类型', value: alertData.alert_type },
    { label: '源 IP', value: alertData.src_ip },
    { label: '目标 IP', value: alertData.dest_ip },
    { label: '告警次数', value: alertData.count },
  ].filter((s) => s.value != null && s.value !== '')

  return (
    <div className={`card-hover w-full rounded-lg border bg-card p-5 transition-colors ${
      isRejected
        ? 'border-border opacity-75 hover:border-border'
        : 'border-border hover:border-primary/40'
    }`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive">
            {alertData.alert_type || '未知告警'}
          </span>
          <span className="text-xs text-muted-foreground">
            工作流：{item.workflow_name || '-'}
          </span>
          <span className="text-xs text-muted-foreground">#{item.execution_id}</span>
          {outcome && (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                outcome === 'approved'
                  ? 'bg-success/20 text-success'
                  : 'bg-secondary text-muted-foreground'
              }`}
            >
              {outcome === 'approved' ? '已同意封禁' : '已忽略'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="btn-danger btn-sm"
              title="删除该工单（仅管理员）"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            创建：{fmtTime(item.created_at)}
          </span>
        </div>
      </div>

      {/* 迷你时间线 */}
      <MiniTimeline item={item} />

      {/* 关键字段摘要卡片 */}
      {summaryItems.length > 0 && (
        <div className="mt-2 grid w-full grid-cols-2 gap-2 rounded-md border border-border bg-background p-2 sm:grid-cols-4">
          {summaryItems.map((s) => (
            <div key={s.label} className="min-w-0">
              <div className="text-[10px] text-muted-foreground">{s.label}</div>
              <div className="truncate font-mono text-xs text-foreground" title={toText(s.value)}>{toText(s.value)}</div>
            </div>
          ))}
        </div>
      )}

      {(reviewMeta.title || reviewMeta.instructions) && (
        <div className="mt-3 w-full rounded-md border border-warning/40 bg-warning/20 p-4">
          {reviewMeta.title && (
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-warning">
              <User className="h-4 w-4" />
              {reviewMeta.title}
            </div>
          )}
          {reviewMeta.instructions && (
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-warning/80">
              {reviewMeta.instructions}
            </div>
          )}
        </div>
      )}

      {/* 告警详情：已忽略工单隐藏建议字段 */}
      <div className="grid w-full grid-cols-2 gap-4 py-3 sm:grid-cols-4">
        <InfoCell label="告警源 IP" value={alertData.src_ip} />
        <InfoCell label="目标 IP" value={alertData.dest_ip} />
        {!isRejected && <InfoCell label="建议目标" value={decision.target_ip} />}
        {!isRejected && <InfoCell label="建议时长" value={decision.duration} />}
      </div>

      {alertData && Object.keys(alertData).length > 0 && (
        <div className="grid w-full grid-cols-2 gap-4 pb-3 sm:grid-cols-4">
          {Object.entries(alertData)
            .filter(([k]) => !['src_ip', 'dest_ip', 'alert_type', 'count'].includes(k))
            .slice(0, 4)
            .map(([k, v]) => (
              <InfoCell key={k} label={k} value={v} />
            ))}
        </div>
      )}

      {/* Agent 建议：已忽略时显示「无需建议」 */}
      <div className="w-full rounded-md bg-background p-4">
        <div className="mb-1 text-xs text-muted-foreground">Agent 建议</div>
        {isRejected ? (
          <div className="text-sm text-muted-foreground">该工单已被忽略，无需 Agent 建议</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-warning/20 px-2 py-0.5 text-xs text-warning">
              {decision.decision || '无'}
            </span>
            <span className="text-sm text-muted-foreground">{decision.reason || '无'}</span>
          </div>
        )}
      </div>

      <ContextPanel ctx={ctx} />
      <MessagesPanel messages={item.agent_messages} />

      {isPending && (
        <div className="mt-4 flex w-full items-center justify-end gap-3 border-t border-border pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(item.execution_id)}
            className="btn-secondary btn-sm"
          >
            忽略
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(item.execution_id)}
            className="btn-danger btn-sm"
          >
            同意封禁
          </button>
        </div>
      )}
    </div>
  )
}

// ============ 工作台主组件 ============
function ApprovalCenter() {
  const [searchParams, setSearchParams] = useSearchParams()
  // 支持 URL ?tab=banned / blacklist / whitelist / all 直达；默认为统一审批中心。
  // 「已封禁 IP」「安博通黑名单」「安博通白名单」按权限矩阵控制（ban_workflow:view）：
  // 无权限时强制落到审批中心，避免其访问无权数据。
  const canViewBan = hasPermission('ban_workflow', 'view')
  const requestedTab = searchParams.get('tab') === 'banned' ? 'banned'
    : searchParams.get('tab') === 'blacklist' ? 'blacklist'
      : searchParams.get('tab') === 'whitelist' ? 'whitelist'
        : searchParams.get('tab') === 'all' ? 'all' : 'approval'
  const initialTab = ((requestedTab === 'banned' || requestedTab === 'blacklist' || requestedTab === 'whitelist') && !canViewBan) ? 'approval' : requestedTab

  const [items, setItems] = useState([])
  const [stats, setStats] = useState(null)
  // 封禁工作流统计：待审批工单数 + 生效中封禁数
  const [banStats, setBanStats] = useState({ pendingApprovals: 0, activeBans: 0 })
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  // 查询筛选条件：pending | all | banned
  const [tab, setTab] = useState(initialTab)
  // 全部历史 Tab 内子视图：instances（封禁实例）/ approvals（审批历史）
  // 封禁实例子页数据需 ban_workflow:view，无权限时默认落在审批历史
  const [historyTab, setHistoryTab] = useState(canViewBan ? 'instances' : 'approvals')
  const [workflowId, setWorkflowId] = useState(searchParams.get('workflow_id') || '')
  const [keyword, setKeyword] = useState(searchParams.get('q') || '')
  const [quickFilter, setQuickFilter] = useState(searchParams.get('filter') || '') // 严重/境外/今日/近7天

  // 切换 Tab 时同步 URL
  const switchTab = useCallback((newTab) => {
    setTab(newTab)
    setQuickFilter('')
    const params = {}
    if (newTab === 'banned') params.tab = 'banned'
    else if (newTab === 'blacklist') params.tab = 'blacklist'
    else if (newTab === 'whitelist') params.tab = 'whitelist'
    else if (newTab === 'all') params.tab = 'all'
    setSearchParams(params, { replace: true })
  }, [setSearchParams])

  // 拉取统计数据
  const loadStats = useCallback(async () => {
    try {
      const data = await getApprovalStats()
      setStats(data)
    } catch (err) {
      // 静默失败，不打断主流程
      console.error('stats load failed', err)
    }
  }, [])

  // 拉取封禁工作流统计（待审批工单 + 生效中封禁）
  // 「已封禁 IP」数据按权限矩阵控制（ban_workflow:view）：无权限不请求，避免 403 报错。
  const loadBanStats = useCallback(async () => {
    if (!hasPermission('ban_workflow', 'view')) return
    try {
      const [st, active] = await Promise.all([
        banWorkflowApi.stats(),
        banWorkflowApi.bannedIps({ status: 'active', page: 1, page_size: 1 }),
      ])
      setBanStats({
        pendingApprovals: st?.pending_approvals ?? 0,
        activeBans: active?.total ?? 0,
      })
    } catch (err) {
      // 静默失败，不打断主流程
      console.error('ban stats load failed', err)
    }
  }, [])

  // 拉取工作流列表（用于筛选下拉）
  const loadWorkflows = useCallback(async () => {
    try {
      const data = await workflowsApi.list()
      setWorkflows(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('workflows load failed', err)
    }
  }, [])

  // 拉取历史工单列表（全部历史 Tab 用）
  const load = useCallback(async () => {
    try {
      const params = {}
      if (tab === 'all') params.status = 'all'
      if (workflowId) params.workflow_id = workflowId
      // 合并关键词和快捷筛选
      const qParts = [keyword.trim(), quickFilter].filter(Boolean)
      if (qParts.length) params.q = qParts.join(' ')
      params.limit = 200
      const data = await getApprovals(params)
      setItems(Array.isArray(data) ? data : [])
      setError('')
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [tab, workflowId, keyword, quickFilter])

  // 手动刷新（审批中心/已封禁IP Tab 由嵌入组件自带刷新，这里刷新统计即可）
  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadBanStats(), loadStats()])
      if (tab === 'all') {
        await load()
      }
    } finally {
      setRefreshing(false)
    }
  }, [tab, load, loadStats, loadBanStats, refreshing])

  // 初始化加载：全历史 Tab 拉列表；统计始终拉取
  useEffect(() => {
    if (tab === 'all') {
      load()
    }
    loadStats()
    loadWorkflows()
    loadBanStats()
  }, [load, loadStats, loadWorkflows, loadBanStats, tab])

  const handleApprove = async (id) => {
    setBusyId(id)
    try {
      await approveExecution(id)
      setItems((prev) => prev.filter((it) => it.execution_id !== id))
      loadStats()
    } catch (err) {
      setError(err.message || '审批失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleReject = async (id) => {
    setBusyId(id)
    try {
      await rejectExecution(id)
      setItems((prev) => prev.filter((it) => it.execution_id !== id))
      loadStats()
    } catch (err) {
      setError(err.message || '拒绝失败')
    } finally {
      setBusyId(null)
    }
  }

  // 删除历史工单（需 approval:delete 权限，按钮显隐同口径）
  const handleDelete = async (item) => {
    const ok = await confirm({
      title: `删除工单 #${item.execution_id}`,
      message: '删除后该执行记录从工作台移除，需「工作台-删除」权限。确定删除？',
      danger: true,
    })
    if (!ok) return
    try {
      await deleteExecution(item.execution_id)
      setItems((prev) => prev.filter((it) => it.execution_id !== item.execution_id))
      loadStats()
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  // 快捷筛选 chips 计数：useMemo 从当前列表派生，不新增请求
  const quickCounts = useMemo(() => {
    const list = Array.isArray(items) ? items : []
    const startToday = new Date()
    startToday.setHours(0, 0, 0, 0)
    return {
      success: list.filter((it) => isSuccessItem(it)).length,
      failed: list.filter((it) => isFailedItem(it)).length,
      今日: list.filter((it) => {
        const t = new Date(it.created_at).getTime()
        return Number.isFinite(t) && t >= startToday.getTime()
      }).length,
      近7天: list.filter((it) => {
        const t = new Date(it.created_at).getTime()
        return Number.isFinite(t) && t >= Date.now() - 7 * 86400000
      }).length,
    }
  }, [items])

  // 是否存在生效中的筛选（区分「无数据」与「筛选无结果」两种空态）
  const hasFilter = Boolean(keyword.trim() || quickFilter || workflowId)
  const clearFilters = useCallback(() => {
    setKeyword('')
    setQuickFilter('')
    setWorkflowId('')
  }, [])

  // 待处理总数 = 工作流审批待办 + 封禁工作流审批待办
  const pendingTotal = (stats?.pending ?? 0) + banStats.pendingApprovals

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏：页面名 + 待办快捷入口 chips + 刷新 */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">工作台</h1>
          {!loading && tab === 'all' && (
            <span className="text-xs text-muted-foreground">
              共 <span className="text-sm font-medium tabular-nums text-foreground">{items.length.toLocaleString()}</span> 条工单
            </span>
          )}
          {/* 全局快捷入口（点击跳转对应 Tab） */}
          <button
            type="button"
            onClick={() => switchTab('approval')}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              pendingTotal > 0
                ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
                : 'border-border bg-secondary text-muted-foreground'
            }`}
            title="点击查看待审批工单"
          >
            <span className={`h-1.5 w-1.5 rounded-full bg-warning ${pendingTotal > 0 ? 'animate-pulse' : ''}`} />
            待处理
            <span className="tabular-nums">{pendingTotal.toLocaleString()}</span>
          </button>
          {canViewBan && (
            <button
              type="button"
              onClick={() => switchTab('banned')}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                banStats.activeBans > 0
                  ? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20'
                  : 'border-border bg-secondary text-muted-foreground'
              }`}
              title="点击查看已封禁 IP"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              封禁中
              <span className="tabular-nums">{banStats.activeBans.toLocaleString()}</span>
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {lastUpdated && (
            <span className="text-[11px] text-muted-foreground">
              最后更新：{lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn-secondary btn-sm"
            title="刷新统计与列表"
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </header>

      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {/* Tab 导航栏：下划线式 + tabular-nums 计数徽标 */}
        <div className="mb-4 flex w-full items-center border-b border-border">
          <button
            type="button"
            onClick={() => switchTab('approval')}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
              tab === 'approval'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <ClipboardList className="h-4 w-4" />
            审批中心
            {pendingTotal > 0 && (
              <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-warning">
                {pendingTotal.toLocaleString()}
              </span>
            )}
          </button>
          {canViewBan && (
            <button
              type="button"
              onClick={() => switchTab('banned')}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
                tab === 'banned'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Ban className="h-4 w-4" />
              已封禁 IP
              {banStats.activeBans > 0 && (
                <span className="rounded-full bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-destructive">
                  {banStats.activeBans.toLocaleString()}
                </span>
              )}
            </button>
          )}
          {canViewBan && (
            <button
              type="button"
              onClick={() => switchTab('blacklist')}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
                tab === 'blacklist'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <ShieldBan className="h-4 w-4" />
              安博通黑名单
            </button>
          )}
          {canViewBan && (
            <button
              type="button"
              onClick={() => switchTab('whitelist')}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
                tab === 'whitelist'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              安博通白名单
            </button>
          )}
          <button
            type="button"
            onClick={() => switchTab('all')}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
              tab === 'all'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <ScrollText className="h-4 w-4" />
            全部历史
          </button>
        </div>

        {/* ====== 审批中心 Tab：统一审批（封禁工单 + 工作流人工审批） ====== */}
        {tab === 'approval' || ((tab === 'banned' || tab === 'blacklist' || tab === 'whitelist') && !canViewBan) ? (
          <BanApprovals embedded />
        ) : tab === 'banned' ? (
          /* ====== 已封禁 IP Tab：嵌入封禁工作台（新封禁工作流数据，需 ban_workflow:view） ====== */
          <BanWorkbench embedded />
        ) : tab === 'blacklist' ? (
          /* ====== 安博通黑名单 Tab：设备侧实时黑名单（分页 + IP 精确查询，需 ban_workflow:view） ====== */
          <AnbotongBlacklist embedded />
        ) : tab === 'whitelist' ? (
          /* ====== 安博通白名单 Tab：本地 5 秒同步设备全局白名单（增删 + 批量，需 ban_workflow:view/edit） ====== */
          <AnbotongWhitelist embedded />
        ) : (
          <>
            {/* ====== 全部历史 Tab：统一历史（封禁实例 + 审批历史） ====== */}
            <div className="mb-4 flex w-full items-center border-b border-border">
              {canViewBan && (
                <button
                  type="button"
                  onClick={() => setHistoryTab('instances')}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
                    historyTab === 'instances'
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Activity className="h-4 w-4" />
                  封禁实例
                </button>
              )}
              <button
                type="button"
                onClick={() => setHistoryTab('approvals')}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${
                  historyTab === 'approvals'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <ScrollText className="h-4 w-4" />
                审批历史
              </button>
            </div>

            {historyTab === 'instances' ? (
              <BanWorkflowInstances embedded />
            ) : (
            <>
            {/* 查询筛选区：工作流下拉 + 关键词输入（实时搜索） */}
            <div className="mb-4 flex w-full flex-wrap items-center gap-3">
              <CompactSelect
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
                size="lg"
                block
                className="min-w-0 flex-1"
              >
                <option value="">全部工作流</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </CompactSelect>

              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索告警类型 / IP / 工作流名..."
                  className={`${inputBaseCls} w-full pl-8`}
                />
              </div>
            </div>

            {/* 状态指标条：快捷筛选 chips（前端派生计数，点击筛选/再点取消）+ 右侧汇总 */}
            {!loading && items.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {QUICK_FILTERS.map((f) => {
                  const active = quickFilter === f.value
                  const count = quickCounts[f.value] ?? 0
                  return (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setQuickFilter((prev) => (prev === f.value ? '' : f.value))}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
                        active
                          ? 'border-transparent bg-primary/15 text-primary ring-1 ring-primary/40'
                          : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                      }`}
                      title={active ? '点击取消该筛选' : `点击筛选「${f.label}」的工单`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${f.dot}`} />
                      {f.label}
                      <span className={`font-medium tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                    </button>
                  )
                })}
                <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5" title="今日新增工单数">
                    <Rocket className="h-3.5 w-3.5 text-primary/80" />
                    今日新增
                    <span className={`font-semibold tabular-nums ${stats?.today_new > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {stats?.today_new > 0 ? stats.today_new.toLocaleString() : '--'}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5" title="累计同意封禁的工单数">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary/80" />
                    同意封禁
                    <span className={`font-semibold tabular-nums ${stats?.approved > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {stats?.approved > 0 ? stats.approved.toLocaleString() : '--'}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5" title="累计已忽略的工单数">
                    <X className="h-3.5 w-3.5 text-primary/80" />
                    已忽略
                    <span className={`font-semibold tabular-nums ${stats?.rejected > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {stats?.rejected > 0 ? stats.rejected.toLocaleString() : '--'}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5" title="已结束工单的平均处理时长">
                    <Clock className="h-3.5 w-3.5 text-primary/80" />
                    平均时长
                    <span className={`font-semibold tabular-nums ${stats?.avg_handle_seconds > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {stats?.avg_handle_seconds > 0 ? fmtDuration(stats.avg_handle_seconds) : '--'}
                    </span>
                  </span>
                </div>
              </div>
            )}

            {error && (
              <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {loading ? (
              /* 骨架屏：模拟工单卡片真实结构 */
              <div className="flex flex-col gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card p-5">
                    <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
                      <div className="flex items-center gap-2">
                        <div className="h-5 w-24 rounded skeleton-shimmer" />
                        <div className="h-3.5 w-32 rounded skeleton-shimmer" />
                        <div className="h-3.5 w-16 rounded skeleton-shimmer" />
                      </div>
                      <div className="h-3.5 w-28 rounded skeleton-shimmer" />
                    </div>
                    <div className="mt-3 flex items-center gap-1.5">
                      <div className="h-6 w-28 rounded-full skeleton-shimmer" />
                      <div className="h-6 w-24 rounded-full skeleton-shimmer" />
                      <div className="h-6 w-28 rounded-full skeleton-shimmer" />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, j) => (
                        <div key={j} className="h-10 rounded-md skeleton-shimmer" />
                      ))}
                    </div>
                    <div className="mt-3 h-12 rounded-md skeleton-shimmer" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              /* 空态两分：无数据 → 主 CTA；有筛选无结果 → 清除筛选 */
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ScrollText className="h-6 w-6" />
                </div>
                {hasFilter ? (
                  <>
                    <div className="text-sm font-medium text-foreground">未找到匹配的工单</div>
                    <div className="text-xs text-muted-foreground">调整关键词或清除筛选条件后再试</div>
                    <button type="button" onClick={clearFilters} className="btn-secondary btn-sm">
                      清除筛选
                    </button>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-medium text-foreground">暂无历史工单</div>
                    <div className="text-xs text-muted-foreground">处理完成的审批工单将归档到此处</div>
                    <button type="button" onClick={() => switchTab('approval')} className="btn-primary btn-sm">
                      前往审批中心
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="card-stagger flex flex-col gap-4">
                {items.map((item) => (
                  <ApprovalCard
                    key={item.execution_id}
                    item={item}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onDelete={hasPermission('approval', 'delete') ? handleDelete : undefined}
                    busy={busyId === item.execution_id}
                  />
                ))}
              </div>
            )}
            </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default ApprovalCenter
