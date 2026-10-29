import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { guardNavPermission } from '../utils/permissions'
import ReactECharts from 'echarts-for-react'
import { getChartTheme, emphasisPie, emphasisBar, emphasisLine } from '../utils/chartTheme'
import { getDashboardStats } from '../api/dashboard'
import { getExecutions } from '../api/executions'
import { getApprovals } from '../api/approvals'
import { deliverablesApi } from '../api/client'
import { fmtSize } from '../utils/feedback'
import HalfDrawer from '../components/HalfDrawer'
import AiUsagePanel from '../components/AiUsagePanel'
import { Skeleton, EmptyState } from '../components/ui'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { DASHBOARD_TUTORIAL } from '../components/tutorialContent'
import DutyDashboard from './DutyDashboard'
import { RefreshCw, Radio, BarChart3, PieChart as PieIcon, TrendingUp, Inbox, FolderOpen, FileText, Package, CalendarDays, ShieldCheck, Timer, ClipboardList, Database } from 'lucide-react'

// ============ 工具函数 ============
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(t)
  }
}

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '-'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

function triggerLabel(t) {
  switch (t) {
    case 'webhook': return '线上告警'
    case 'test_run': return '流程测试'
    case 'manual': return '手动触发'
    case 'agent_test': return '智能体测试'
    case 'asset_scan': return '资产扫描'
    default: return t || '-'
  }
}

function statusColorClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'success': return 'text-success'
    case 'failed': return 'text-destructive'
    case 'running': return 'text-primary'
    case 'waiting_for_approval': return 'text-warning'
    case 'pending': return 'text-muted-foreground'
    default: return 'text-muted-foreground'
  }
}

function statusLabel(status) {
  switch ((status || '').toLowerCase()) {
    case 'success': return '成功'
    case 'failed': return '失败'
    case 'running': return '运行中'
    case 'waiting_for_approval': return '待审批'
    case 'pending': return '等待中'
    default: return status || '-'
  }
}

// ============ 数字计数动画 hook ============
function useCountUp(target, duration = 1000) {
  const [display, setDisplay] = useState(0)
  const rafRef = useRef(null)
  const prevRef = useRef(0)

  useEffect(() => {
    if (target == null || isNaN(target)) {
      setDisplay(target)
      return
    }
    const from = prevRef.current || 0
    const to = Number(target)
    if (from === to) {
      setDisplay(to)
      return
    }
    const start = performance.now()
    const animate = (now) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = from + (to - from) * eased
      setDisplay(to >= 0 ? Math.round(current) : current)
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      } else {
        prevRef.current = to
      }
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, duration])

  return display
}

// ============ 带计数动画的数字显示 ============
function AnimatedNumber({ value, duration = 1000 }) {
  const display = useCountUp(value, duration)
  if (value == null || value === '-') return <span>-</span>
  return <span className="tabular-nums">{display}</span>
}

// ============ 可点击 KPI 卡片 ============
function KpiCard({ label, value, suffix, accent, onClick, hint, icon: Icon, iconColor }) {
  const clickable = !!onClick
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      style={{ animation: 'card-enter 0.35s ease-out' }}
      className={`group card-accent-top card-hover relative min-w-0 flex-1 rounded-xl border border-border bg-card p-5 text-left shadow-lg transition-all ${
        clickable
          ? 'cursor-pointer hover:border-primary/50 hover:shadow-primary/10 hover:shadow-xl'
          : 'cursor-default'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-foreground">
          {Icon && <Icon className={`h-4 w-4 shrink-0 ${iconColor || 'text-primary'}`} />}
          <span className="truncate">{label}</span>
        </span>
        {clickable && (
          <span className="shrink-0 text-[10px] text-muted-foreground transition-colors group-hover:text-primary">
            点击查看详情 →
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span
          className={`text-glow bg-clip-text text-4xl font-bold tabular-nums text-transparent ${accent || 'bg-gradient-to-r from-primary/80 to-primary'}`}
        >
          {typeof value === 'number' ? <AnimatedNumber value={value} /> : value}
        </span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {hint && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {hint}
        </div>
      )}
    </button>
  )
}

// ============ KPI 骨架屏 ============
function KpiSkeleton() {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-card p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-9 w-20" />
      <Skeleton className="mt-2 h-2.5 w-32" />
    </div>
  )
}

// ============ 图表卡片包装 ============
function ChartCard({ title, icon: Icon, loading, isEmpty, emptyText, emptyDesc, emptyAction, children }) {
  return (
    <div
      className="card-accent-top card-hover w-full rounded-xl border border-border bg-card p-5"
      style={{ animation: 'card-enter 0.35s ease-out' }}
    >
      <div className="mb-3 flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-primary" />}
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      {loading ? (
        <div className="flex h-[320px] items-center justify-center">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      ) : isEmpty ? (
        <div className="flex h-[320px] items-center justify-center">
          <EmptyState
            icon={Inbox}
            title={emptyText || '暂无数据'}
            description={emptyDesc}
            action={emptyAction}
          />
        </div>
      ) : (
        children
      )}
    </div>
  )
}

// ============ 执行记录列表 ============
function ExecutionList({ items }) {
  if (!items || items.length === 0) {
    return <EmptyState icon={Inbox} title="暂无执行记录" description="暂无符合条件的执行记录" />
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((e) => (
        <div
          key={e.id}
          className="rounded-lg border border-border bg-background p-3 text-sm transition-colors hover:border-primary/40"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">#{e.id}</span>
              <span className={`flex items-center gap-1.5 text-xs font-medium ${statusColorClass(e.status)}`}>
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${
                    (e.status || '').toLowerCase() === 'running' ? 'dot-pulse' : ''
                  }`}
                />
                {statusLabel(e.status)}
              </span>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {triggerLabel(e.trigger_type)}
              </span>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(e.created_at)}</span>
          </div>
          {e.workflow_id && (
            <div className="mt-1.5 text-xs text-muted-foreground">
              工作流 ID: <span className="font-mono">{e.workflow_id}</span>
              {e.agent_id && <span className="ml-3">智能体 ID: <span className="font-mono">{e.agent_id}</span></span>}
            </div>
          )}
          {!e.workflow_id && e.agent_id && (
            <div className="mt-1.5 text-xs text-muted-foreground">
              智能体 ID: <span className="font-mono">{e.agent_id}</span>
            </div>
          )}
          {e.finished_at && e.created_at && (
            <div className="mt-1 text-xs tabular-nums text-muted-foreground">
              耗时: {fmtDuration((new Date(e.finished_at) - new Date(e.created_at)) / 1000)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ============ 审批工单列表 ============
function ApprovalList({ items }) {
  if (!items || items.length === 0) {
    return <EmptyState icon={Inbox} title="暂无待处理工单" description="当前没有等待审批的工单" />
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((a) => {
        const alertData = a.alert_data || {}
        const decision = a.agent_decision || {}
        return (
          <div
            key={a.execution_id}
            className="rounded-lg border border-border bg-background p-3 text-sm transition-colors hover:border-warning/40"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">#{a.execution_id}</span>
              <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                待审批
              </span>
              {a.workflow_name && (
                <span className="truncate text-xs text-foreground">{a.workflow_name}</span>
              )}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtTime(a.created_at)}</span>
            </div>
            {(alertData.alert_type || alertData.src_ip) && (
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                {alertData.alert_type && <span>告警类型: <span className="text-foreground">{alertData.alert_type}</span></span>}
                {alertData.src_ip && <span>源 IP: <span className="font-mono text-foreground">{alertData.src_ip}</span></span>}
              </div>
            )}
            {decision.decision && (
              <div className="mt-1 text-xs text-muted-foreground">
                决策建议: <span className="text-warning">{decision.decision}</span>
                {decision.target_ip && <span className="ml-3">目标 IP: <span className="font-mono">{decision.target_ip}</span></span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============ 运营大屏 ============
function OperationsDashboard({ onRefresh, refreshing, autoRefresh, onToggleAutoRefresh }) {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [drawer, setDrawer] = useState({ open: false, type: '', title: '', loading: false, data: [] })

  const loadData = useCallback(async () => {
    try {
      const data = await getDashboardStats()
      setStats(data)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 每 30 秒轮询（受 autoRefresh 控制）
  useEffect(() => {
    loadData()
    if (!autoRefresh) return
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [loadData, autoRefresh])

  // 外部触发刷新
  useEffect(() => {
    if (refreshing) loadData()
  }, [refreshing, loadData])

  const kpi = stats?.kpi || {}
  const trend7d = stats?.trend_7d || []
  const alertCategories = stats?.alert_categories || []
  const topIps = stats?.top_malicious_ips || []

  // 判断数据是否为空
  const trendEmpty = trend7d.every((d) => (d.auto_count || 0) === 0 && (d.manual_count || 0) === 0)
  const categoryEmpty = alertCategories.length === 0 || alertCategories.every((c) => (c.value || 0) === 0)
  const topIpEmpty = topIps.length === 0 || topIps.every((d) => (d.count || 0) === 0)

  const openDrawer = useCallback(async (type, params = {}) => {
    if (type === 'today_alerts') {
      setDrawer({ open: true, type, title: '今日接警详情', loading: true, data: [] })
      try {
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)
        const since = todayStart.toISOString().slice(0, 19)
        const data = await getExecutions(200, 0, null, null, { since })
        setDrawer((d) => ({ ...d, loading: false, data }))
      } catch {
        setDrawer((d) => ({ ...d, loading: false, data: [] }))
      }
    } else if (type === 'pending_approvals') {
      setDrawer({ open: true, type, title: '待人工处理工单详情', loading: true, data: [] })
      try {
        const data = await getApprovals({ status: 'waiting_for_approval', limit: 200 })
        setDrawer((d) => ({ ...d, loading: false, data }))
      } catch {
        setDrawer((d) => ({ ...d, loading: false, data: [] }))
      }
    } else if (type === 'day_alerts') {
      // 点击趋势图某天 → 显示该天执行记录
      const { date } = params
      setDrawer({ open: true, type, title: `${date} 接警详情`, loading: true, data: [] })
      try {
        const now = new Date()
        const [mm, dd] = date.split('-')
        const dayStart = new Date(now.getFullYear(), parseInt(mm) - 1, parseInt(dd), 0, 0, 0)
        const dayEnd = new Date(dayStart)
        dayEnd.setDate(dayEnd.getDate() + 1)
        const since = dayStart.toISOString().slice(0, 19)
        const until = dayEnd.toISOString().slice(0, 19)
        const data = await getExecutions(200, 0, null, null, { since, until })
        setDrawer((d) => ({ ...d, loading: false, data }))
      } catch {
        setDrawer((d) => ({ ...d, loading: false, data: [] }))
      }
    } else if (type === 'recent_executions') {
      // KPI 下钻：显示最近执行记录
      const { title } = params
      setDrawer({ open: true, type, title: title || '最近执行记录', loading: true, data: [] })
      try {
        const data = await getExecutions(200, 0, null, null, {})
        setDrawer((d) => ({ ...d, loading: false, data }))
      } catch {
        setDrawer((d) => ({ ...d, loading: false, data: [] }))
      }
    } else if (type === 'category_alerts') {
      // 点击告警分类扇区 → 显示最近执行记录
      const { categoryName } = params
      setDrawer({ open: true, type, title: `${categoryName} 告警详情`, loading: true, data: [] })
      try {
        const data = await getExecutions(100, 0, null, null, {})
        setDrawer((d) => ({ ...d, loading: false, data }))
      } catch {
        setDrawer((d) => ({ ...d, loading: false, data: [] }))
      }
    }
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawer((d) => ({ ...d, open: false }))
  }, [])

  // 折线图配置
  const trendOption = useMemo(() => {
    const t = getChartTheme()
    return {
      backgroundColor: 'transparent',
      // 跟随主题色板：自动化处置=青 / 人工介入=琥珀
      color: [t.palette[0], t.palette[4]],
      tooltip: { trigger: 'axis', ...t.tooltip },
      legend: { data: ['自动化处置', '人工介入'], textStyle: { color: t.textMuted }, top: 0 },
      grid: { left: 40, right: 24, top: 40, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: trend7d.map((d) => d.date),
        axisLine: { lineStyle: { color: t.axisLine } },
        axisLabel: { color: t.textMuted },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: t.splitLine } },
        axisLabel: { color: t.textMuted },
      },
      series: [
        { name: '自动化处置', type: 'line', smooth: true, areaStyle: { opacity: 0.2 }, data: trend7d.map((d) => d.auto_count), ...emphasisLine() },
        { name: '人工介入', type: 'line', smooth: true, areaStyle: { opacity: 0.2 }, data: trend7d.map((d) => d.manual_count), ...emphasisLine() },
      ],
    }
  }, [trend7d])

  // 环形图配置
  const categoryOption = useMemo(() => {
    const t = getChartTheme()
    return {
      backgroundColor: 'transparent',
      color: t.palette,
      tooltip: { trigger: 'item', ...t.tooltip },
      legend: { type: 'scroll', orient: 'vertical', right: 8, top: 'center', textStyle: { color: t.textMuted } },
      series: [
        {
          name: '告警分类',
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['40%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: t.pieBorderColor, borderWidth: 2 },
          label: { color: t.text },
          data: alertCategories.map((c) => ({ name: c.name, value: c.value })),
          ...emphasisPie(),
        },
      ],
    }
  }, [alertCategories])

  // 柱状图配置
  const topIpOption = useMemo(() => {
    const t = getChartTheme()
    const top10 = topIps.slice(0, 10)
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...t.tooltip },
      grid: { left: 40, right: 24, top: 20, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: top10.map((d) => d.ip),
        axisLine: { lineStyle: { color: t.axisLine } },
        axisLabel: { color: t.textMuted, rotate: 20 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: t.splitLine } },
        axisLabel: { color: t.textMuted },
      },
      series: [
        {
          name: '攻击次数',
          type: 'bar',
          barWidth: '50%',
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
              { offset: 0, color: t.palette[0] },
              { offset: 1, color: t.palette[1] },
            ]},
          },
          data: top10.map((d) => d.count),
          ...emphasisBar(),
        },
      ],
    }
  }, [topIps])

  const successRate =
    kpi.auto_block_success_rate != null
      ? Math.round(kpi.auto_block_success_rate * 100)
      : null

  return (
    <div className="flex w-full flex-col gap-4">
      {error && (
        <div className="mb-2 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* KPI 卡片：加载时用骨架屏 */}
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          <>
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
            <KpiSkeleton />
          </>
        ) : (
          <>
            <KpiCard
              label="今日接警总数"
              value={kpi.today_alerts ?? '-'}
              icon={Radio}
              iconColor="text-chart-1"
              onClick={() => openDrawer('today_alerts')}
            />
            <KpiCard
              label="全自动化封禁成功率"
              value={successRate}
              suffix="%"
              icon={ShieldCheck}
              iconColor="text-chart-2"
              onClick={() => openDrawer('recent_executions', { title: '自动化封禁执行详情' })}
            />
            <KpiCard
              label="系统平均响应时间"
              value={kpi.mttr_seconds ?? '-'}
              suffix="秒"
              accent="bg-gradient-to-r from-emerald-400 to-cyan-500"
              icon={Timer}
              iconColor="text-chart-5"
              onClick={() => openDrawer('recent_executions', { title: '系统响应时间详情' })}
            />
            <KpiCard
              label="待人工处理工单数"
              value={kpi.pending_approvals ?? '-'}
              accent="bg-gradient-to-r from-amber-400 to-pink-500"
              icon={ClipboardList}
              iconColor="text-chart-4"
              onClick={() => openDrawer('pending_approvals')}
            />
          </>
        )}
      </div>

      {/* 中间：左折线 + 右环形 */}
      <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="近 7 天自动化处置 vs 人工介入趋势"
          icon={TrendingUp}
          loading={loading}
          isEmpty={trendEmpty}
          emptyText="暂无近 7 天处置记录"
          emptyDesc="创建自动化工作流后开始统计"
          emptyAction={
            <button
              type="button"
              onClick={() => navigate('/studio?tab=workflow')}
              className="btn-primary btn-sm"
            >
              去创建工作流
            </button>
          }
        >
          <ReactECharts
            option={trendOption}
            style={{ height: 320, width: '100%' }}
            onEvents={{
              click: (params) => {
                if (params.componentType === 'series') {
                  openDrawer('day_alerts', { date: params.name })
                }
              },
            }}
          />
        </ChartCard>

        <ChartCard
          title="安全告警分类占比"
          icon={PieIcon}
          loading={loading}
          isEmpty={categoryEmpty}
          emptyText="暂无分类数据"
          emptyDesc="告警触发后将自动统计分类"
        >
          <ReactECharts
            option={categoryOption}
            style={{ height: 320, width: '100%' }}
            onEvents={{
              click: (params) => {
                if (params.componentType === 'series') {
                  openDrawer('category_alerts', { categoryName: params.name })
                }
              },
            }}
          />
        </ChartCard>
      </div>

      {/* 底部：Top 10 柱状图 */}
      <ChartCard
        title="Top 10 恶意攻击源 IP"
        icon={BarChart3}
        loading={loading}
        isEmpty={topIpEmpty}
        emptyText="暂无攻击源记录"
        emptyDesc="系统检测到恶意 IP 后将在此展示"
      >
        <ReactECharts
            option={topIpOption}
            style={{ height: 360, width: '100%' }}
            onEvents={{
              click: (params) => {
                if (params.componentType === 'series') {
                  openDrawer('recent_executions', { title: `IP ${params.name} 攻击记录` })
                }
              },
            }}
          />
      </ChartCard>

      {/* 半屏抽屉 */}
      <HalfDrawer
        open={drawer.open}
        onClose={closeDrawer}
        title={drawer.title}
        loading={drawer.loading}
      >
        {drawer.type === 'today_alerts' && <ExecutionList items={drawer.data} />}
        {drawer.type === 'pending_approvals' && <ApprovalList items={drawer.data} />}
        {drawer.type === 'day_alerts' && <ExecutionList items={drawer.data} />}
        {drawer.type === 'recent_executions' && <ExecutionList items={drawer.data} />}
        {drawer.type === 'category_alerts' && <ExecutionList items={drawer.data} />}
      </HalfDrawer>
    </div>
  )
}

// ============ 材料管理大屏 ============
function MaterialsDashboard({ refreshing, autoRefresh }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 目录文件数统计 Tab：一级 / 二级 / 三级目录文件数排行
  const [catTab, setCatTab] = useState('level1')
  // 趋势时间维度：近 7 日 / 近 30 日 / 本年度
  const [trendRange, setTrendRange] = useState('7d')
  // 联动筛选：选中的扩展名 / 日期（MM-DD）
  const [extFilter, setExtFilter] = useState(null)
  const [dateFilter, setDateFilter] = useState(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    try {
      setError('')
      const data = await deliverablesApi.stats()
      setStats(data)
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshing])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load, autoRefresh])

  const s = stats || {}

  // ============ 目录文件数统计（一/二/三级，水平柱状图 Top 8）============
  // Top 3 用金/银/铜色 + 奖牌 emoji 标识，柱右侧显示数值+占比
  // 数据来源：s.by_level_1 / s.by_level_2 / s.by_level_3，每个目录含递归子目录材料数
  const catLevelOption = useMemo(() => {
    const t = getChartTheme()
    const dataMap = {
      level1: s.by_level_1,
      level2: s.by_level_2,
      level3: s.by_level_3,
    }
    const cats = (dataMap[catTab] || []).slice(0, 8)
    const total = cats.reduce((sum, c) => sum + (c.count || 0), 0) || 1
    // 反转：ECharts yAxis category 从下往上画，Top1 要在最上面
    const reversed = [...cats].reverse()
    const medalColors = ['#fbbf24', '#cbd5e1', '#b45309'] // 金 / 银 / 铜
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...t.tooltip,
        formatter: (params) => {
          const p = params[0]
          const v = p.value
          const c = reversed[p.dataIndex]
          const pct = total ? ((v / total) * 100).toFixed(1) : 0
          // 展示完整路径，便于区分同名目录
          const path = c && c.path ? c.path : p.name
          return `${path}<br/>文件数: <b>${v}</b>（占比 ${pct}%）`
        },
      },
      grid: { left: 8, right: 72, top: 12, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: t.textMuted },
        splitLine: { lineStyle: { color: t.splitLine } },
      },
      yAxis: {
        type: 'category',
        data: reversed.map((c) => c.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.text, fontSize: 12 },
      },
      series: [
        {
          name: '文件数',
          type: 'bar',
          data: reversed.map((c, revIdx) => {
            // revIdx=0 对应原数组最后一个；origIdx 指原数组中的排名
            const origIdx = cats.length - 1 - revIdx
            const color = origIdx < 3 ? medalColors[origIdx] : t.palette[origIdx % t.palette.length]
            return {
              value: c.count,
              itemStyle: { color, borderRadius: [0, 4, 4, 0] },
            }
          }),
          barWidth: 14,
          label: {
            show: true,
            position: 'right',
            color: t.text,
            fontSize: 11,
            formatter: (params) => {
              const c = reversed[params.dataIndex]
              if (!c) return ''
              const origIdx = cats.length - 1 - params.dataIndex
              const medal = origIdx === 0 ? '🥇 ' : origIdx === 1 ? '🥈 ' : origIdx === 2 ? '🥉 ' : ''
              const pct = total ? ((c.count / total) * 100).toFixed(1) : 0
              return `${medal}${c.count} (${pct}%)`
            },
          },
          ...emphasisBar(),
        },
      ],
    }
  }, [catTab, s.by_level_1, s.by_level_2, s.by_level_3])

  // ============ 文件类型环形图（中心总数 + 联动筛选）============
  const extPieOption = useMemo(() => {
    const t = getChartTheme()
    const data = (s.by_ext || []).map((it) => ({
      name: it.ext || '未知',
      value: it.count,
      ext: it.ext,
    }))
    const totalFiles = s.total_files || data.reduce((sum, d) => sum + d.value, 0)
    return {
      backgroundColor: 'transparent',
      color: t.palette,
      tooltip: {
        trigger: 'item',
        ...t.tooltip,
        formatter: (p) => {
          const pct = totalFiles ? ((p.value / totalFiles) * 100).toFixed(1) : 0
          return `${p.name}<br/>数量: <b>${p.value}</b>（${pct}%）`
        },
      },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { color: t.textMuted },
        // 图例格式：类型 数量 占比
        formatter: (name) => {
          const item = data.find((d) => d.name === name)
          if (!item) return name
          const pct = totalFiles ? ((item.value / totalFiles) * 100).toFixed(0) : 0
          return `${name}  ${item.value}  ${pct}%`
        },
      },
      // 中心显示总文件数
      graphic: {
        type: 'text',
        left: 'center',
        top: '38%',
        style: {
          text: `${totalFiles}`,
          textAlign: 'center',
          fill: t.text,
          fontSize: 22,
          fontWeight: 'bold',
        },
      },
      series: [
        {
          name: '文件类型',
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: t.pieBorderColor, borderWidth: 2 },
          label: { show: false },
          data,
          ...emphasisPie(),
        },
      ],
    }
  }, [s.by_ext, s.total_files])

  // ============ 上传趋势图（7d/30d/year 切换）============
  // 7d：双 Y 轴（左文件数折线 + 右总大小MB柱状）+ markPoint峰值 + markLine平均
  // 30d：单折线 + markPoint/markLine
  // year：月度柱状 + markPoint/markLine
  const trendOption = useMemo(() => {
    const t = getChartTheme()
    if (trendRange === '7d') {
      const days = s.recent_week || []
      const counts = days.map((d) => d.count)
      const sizesMB = days.map((d) => Number(((d.size || 0) / 1024 / 1024).toFixed(2)))
      const maxVal = counts.length ? Math.max(...counts) : 0
      const maxIdx = counts.indexOf(maxVal)
      return {
        backgroundColor: 'transparent',
        // 跟随主题色板：柱=琥珀 / 折线=青（与图例一致）
        color: [t.palette[4], t.palette[0]],
        tooltip: {
          trigger: 'axis',
          ...t.tooltip,
          formatter: (params) => {
            const d = days[params[0].dataIndex]
            if (!d) return ''
            return `${d.date}<br/>文件数: <b>${d.count}</b><br/>总大小: <b>${fmtSize(d.size)}</b>`
          },
        },
        legend: { data: ['文件数', '总大小(MB)'], textStyle: { color: t.textMuted }, top: 0 },
        grid: { left: 40, right: 40, top: 40, bottom: 32, containLabel: true },
        xAxis: {
          type: 'category',
          data: days.map((d) => d.date),
          axisLine: { lineStyle: { color: t.axisLine } },
          axisLabel: { color: t.textMuted },
        },
        yAxis: [
          {
            type: 'value',
            name: '文件数',
            minInterval: 1,
            axisLine: { show: false },
            axisLabel: { color: t.textMuted },
            splitLine: { lineStyle: { color: t.splitLine } },
          },
          {
            type: 'value',
            name: 'MB',
            axisLine: { show: false },
            axisLabel: { color: t.textMuted },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: '总大小(MB)',
            type: 'bar',
            yAxisIndex: 1,
            data: sizesMB,
            barWidth: '40%',
            itemStyle: { color: t.palette[4], borderRadius: [4, 4, 0, 0] },
            ...emphasisBar(),
          },
          {
            name: '文件数',
            type: 'line',
            yAxisIndex: 0,
            data: counts,
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            areaStyle: { opacity: 0.25 },
            lineStyle: { width: 2 },
            markPoint: maxVal > 0 ? {
              data: [{ name: '峰值', coord: [maxIdx, maxVal], value: maxVal }],
              symbol: 'pin',
              symbolSize: 40,
              itemStyle: { color: t.palette[6] },
              label: { color: '#fff', fontSize: 10 },
            } : undefined,
            markLine: {
              data: [{ type: 'average', name: '平均' }],
              lineStyle: { color: t.palette[0], type: 'dashed' },
              label: { color: t.textMuted },
            },
            ...emphasisLine(),
          },
        ],
      }
    }
    if (trendRange === '30d') {
      const days = s.trend_30d || []
      const counts = days.map((d) => d.count)
      const maxVal = counts.length ? Math.max(...counts) : 0
      const maxIdx = counts.indexOf(maxVal)
      return {
        backgroundColor: 'transparent',
        color: [t.palette[0]],
        tooltip: { trigger: 'axis', ...t.tooltip },
        grid: { left: 40, right: 24, top: 24, bottom: 40, containLabel: true },
        xAxis: {
          type: 'category',
          data: days.map((d) => d.date),
          axisLine: { lineStyle: { color: t.axisLine } },
          axisLabel: { color: t.textMuted, rotate: 30, fontSize: 10 },
        },
        yAxis: {
          type: 'value',
          minInterval: 1,
          axisLine: { show: false },
          axisLabel: { color: t.textMuted },
          splitLine: { lineStyle: { color: t.splitLine } },
        },
        series: [
          {
            name: '文件数',
            type: 'line',
            data: counts,
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            areaStyle: { opacity: 0.25 },
            lineStyle: { width: 2 },
            markPoint: maxVal > 0 ? {
              data: [{ name: '峰值', coord: [maxIdx, maxVal], value: maxVal }],
              symbol: 'pin',
              symbolSize: 40,
              itemStyle: { color: t.palette[6] },
              label: { color: '#fff', fontSize: 10 },
            } : undefined,
            markLine: {
              data: [{ type: 'average', name: '平均' }],
              lineStyle: { color: t.palette[0], type: 'dashed' },
              label: { color: t.textMuted },
            },
            ...emphasisLine(),
          },
        ],
      }
    }
    // 本年度月度柱状
    const months = s.trend_year || []
    const counts = months.map((m) => m.count)
    const maxVal = counts.length ? Math.max(...counts) : 0
    const maxIdx = counts.indexOf(maxVal)
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...t.tooltip },
      grid: { left: 40, right: 24, top: 24, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: months.map((m) => m.month),
        axisLine: { lineStyle: { color: t.axisLine } },
        axisLabel: { color: t.textMuted },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLine: { show: false },
        axisLabel: { color: t.textMuted },
        splitLine: { lineStyle: { color: t.splitLine } },
      },
      series: [
        {
          name: '文件数',
          type: 'bar',
          data: counts,
          barWidth: '50%',
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
              { offset: 0, color: t.palette[0] },
              { offset: 1, color: t.palette[1] },
            ]},
          },
          markPoint: maxVal > 0 ? {
            data: [{ name: '峰值', coord: [maxIdx, maxVal], value: maxVal }],
            symbol: 'pin',
            symbolSize: 40,
            itemStyle: { color: t.palette[6] },
            label: { color: '#fff', fontSize: 10 },
          } : undefined,
          markLine: {
            data: [{ type: 'average', name: '平均' }],
            lineStyle: { color: t.palette[0], type: 'dashed' },
            label: { color: t.textMuted },
          },
          ...emphasisBar(),
        },
      ],
    }
  }, [trendRange, s.recent_week, s.trend_30d, s.trend_year])

  // 早返回：所有 useMemo 必须在此之前调用，保证 hooks 顺序稳定
  if (loading) return <Skeleton className="h-96 w-full" />
  if (error) return <EmptyState title="加载失败" description={error} icon={Inbox} />
  if (!stats) return null

  // ============ 环比计算 ============
  const todayCount = s.today_count || 0
  const yesterdayCount = s.yesterday_count || 0
  // 昨日为 0 时：今日有数视为新增 100%，否则 0
  const todayDelta = yesterdayCount > 0
    ? Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)
    : (todayCount > 0 ? 100 : 0)
  const todayTrend = todayDelta > 0 ? `↑${todayDelta}%` : todayDelta < 0 ? `↓${Math.abs(todayDelta)}%` : '持平'
  const todayTrendColor = todayDelta > 0 ? 'text-success' : todayDelta < 0 ? 'text-destructive' : 'text-muted-foreground'

  const thisWeek = s.this_week_count || 0
  const lastWeek = s.last_week_count || 0
  const weekDelta = lastWeek > 0
    ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
    : (thisWeek > 0 ? 100 : 0)
  const weekTrend = weekDelta > 0 ? `↑${weekDelta}%` : weekDelta < 0 ? `↓${Math.abs(weekDelta)}%` : '持平'
  const weekTrendColor = weekDelta > 0 ? 'text-success' : weekDelta < 0 ? 'text-destructive' : 'text-muted-foreground'

  // ============ 类型详情列表数据 ============
  const extDetails = s.by_ext || []
  const totalForExt = s.total_files || extDetails.reduce((sum, e) => sum + (e.count || 0), 0) || 1

  // ============ 最近上传（联动筛选：按扩展名 + 按日期）============
  let recentList = s.recent_uploads || []
  if (extFilter) {
    recentList = recentList.filter((it) => (it.file_ext || '').toLowerCase() === extFilter.toLowerCase())
  }
  if (dateFilter) {
    // dateFilter 形如 "08-18"（MM-DD），匹配 created_at 的月-日
    const [mm, dd] = dateFilter.split('-')
    recentList = recentList.filter((it) => {
      try {
        const d = new Date(it.created_at)
        return String(d.getMonth() + 1).padStart(2, '0') === mm && String(d.getDate()).padStart(2, '0') === dd
      } catch {
        return false
      }
    })
  }

  // ============ 图表事件联动 ============
  // 点击环形图扇区 → 按扩展名筛选最近上传
  const onPieClick = (params) => {
    if (params && params.data && params.data.ext != null) {
      const ext = params.data.ext
      setExtFilter((prev) => (prev === ext ? null : ext))
      setDateFilter(null)
    }
  }
  // 点击趋势某天 → 联动最近上传（仅 7d 模式有效）
  const onTrendClick = (params) => {
    if (trendRange === '7d' && params && params.name) {
      const dateStr = params.name
      setDateFilter((prev) => (prev === dateStr ? null : dateStr))
      setExtFilter(null)
    }
  }
  // 跳转材料管理（跨模块，无权限时 toast 拦截）
  const goDeliverables = () => {
    if (!guardNavPermission('deliverable', 'view', '材料管理')) return
    navigate('/deliverables')
  }
  // 点击类别柱条 → 跳转材料管理页
  const onCatClick = goDeliverables

  // ============ 文件类型彩色图标 ============
  const fileColorClass = (ext) => {
    const e = (ext || '').toLowerCase()
    if (['xlsx', 'xls', 'csv'].includes(e)) return 'text-emerald-500'
    if (['doc', 'docx'].includes(e)) return 'text-blue-500'
    if (['ppt', 'pptx'].includes(e)) return 'text-orange-500'
    if (['zip', 'rar', '7z'].includes(e)) return 'text-amber-500'
    return 'text-muted-foreground'
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ============ 1. KPI 卡片（5 张，带环比 + 下钻）============ */}
      <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="目录类别"
          value={s.total_categories || 0}
          accent="bg-gradient-to-r from-primary/80 to-primary"
          icon={FolderOpen}
          iconColor="text-primary"
          onClick={goDeliverables}
        />
        <KpiCard
          label="材料总数"
          value={s.total_files || 0}
          accent="bg-gradient-to-r from-blue-400 to-cyan-500"
          icon={FileText}
          iconColor="text-chart-2"
          onClick={goDeliverables}
        />
        <KpiCard
          label="今日新增"
          value={todayCount}
          accent="bg-gradient-to-r from-emerald-400 to-teal-500"
          icon={TrendingUp}
          iconColor="text-chart-5"
          onClick={goDeliverables}
          hint={
            <span>
              较昨日 <span className={todayTrendColor}>{todayTrend}</span>（昨日 {yesterdayCount}）
            </span>
          }
        />
        <KpiCard
          label="本周新增"
          value={thisWeek}
          accent="bg-gradient-to-r from-amber-400 to-orange-500"
          icon={CalendarDays}
          iconColor="text-amber-500"
          onClick={goDeliverables}
          hint={
            <span>
              较上周 <span className={weekTrendColor}>{weekTrend}</span>（上周 {lastWeek}）
            </span>
          }
        />
        <KpiCard
          label="占用空间"
          value={fmtSize(s.total_size || 0)}
          accent="bg-gradient-to-r from-purple-400 to-pink-500"
          icon={Database}
          iconColor="text-chart-3"
        />
      </div>

      {/* ============ 2. 目录文件数统计 + 3. 文件类型分布 ============ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 目录文件数统计（Tab 切换：一级 / 二级 / 三级目录文件数排行） */}
        <ChartCard
          title="目录文件数统计"
          icon={BarChart3}
          loading={false}
          isEmpty={
            catTab === 'level1' ? (!s.by_level_1 || s.by_level_1.length === 0)
              : catTab === 'level2' ? (!s.by_level_2 || s.by_level_2.length === 0)
              : (!s.by_level_3 || s.by_level_3.length === 0)
          }
          emptyText="该层级暂无目录"
          emptyDesc="切换其他层级，或创建目录并上传材料后将自动统计"
        >
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCatTab('level1')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                catTab === 'level1'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              一级
            </button>
            <button
              type="button"
              onClick={() => setCatTab('level2')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                catTab === 'level2'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              二级
            </button>
            <button
              type="button"
              onClick={() => setCatTab('level3')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                catTab === 'level3'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              三级
            </button>
          </div>
          <ReactECharts
            option={catLevelOption}
            style={{ height: 320, width: '100%' }}
            onEvents={{ click: onCatClick }}
          />
        </ChartCard>

        {/* 文件类型分布（环形图 + 详情列表 + 联动筛选） */}
        <ChartCard
          title="文件类型分布"
          icon={PieIcon}
          loading={false}
          isEmpty={!s.by_ext || s.by_ext.length === 0}
          emptyText="暂无类型数据"
          emptyDesc="上传材料后将自动统计文件类型"
        >
          <ReactECharts
            option={extPieOption}
            style={{ height: 260, width: '100%' }}
            onEvents={{ click: onPieClick }}
          />
          {extDetails.length > 0 && (
            <div className="mt-2 max-h-[140px] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-secondary text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">类型</th>
                    <th className="px-2 py-1 text-right font-medium">数量</th>
                    <th className="px-2 py-1 text-right font-medium">占比</th>
                    <th className="px-2 py-1 text-right font-medium">总大小</th>
                    <th className="px-2 py-1 text-right font-medium">平均</th>
                  </tr>
                </thead>
                <tbody>
                  {extDetails.map((e) => (
                    <tr
                      key={e.ext || 'unknown'}
                      className={`border-t border-border transition-colors hover:bg-secondary ${
                        extFilter && (e.ext || '').toLowerCase() === extFilter.toLowerCase() ? 'bg-primary/10' : ''
                      }`}
                    >
                      <td className="px-2 py-1 font-mono text-foreground">.{e.ext || '?'}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-foreground">{e.count}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                        {((e.count / totalForExt) * 100).toFixed(1)}%
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmtSize(e.total_size)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{fmtSize(e.avg_size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </div>

      {/* ============ 4. 上传趋势（多维度切换）============ */}
      <ChartCard
        title="上传趋势"
        icon={TrendingUp}
        loading={false}
        isEmpty={
          (trendRange === '7d' && (!s.recent_week || s.recent_week.every((d) => (d.count || 0) === 0))) ||
          (trendRange === '30d' && (!s.trend_30d || s.trend_30d.every((d) => (d.count || 0) === 0))) ||
          (trendRange === 'year' && (!s.trend_year || s.trend_year.every((m) => (m.count || 0) === 0)))
        }
        emptyText="暂无趋势数据"
        emptyDesc="材料上传后将自动生成趋势"
      >
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTrendRange('7d')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              trendRange === '7d'
                ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
            }`}
          >
            近 7 日
          </button>
          <button
            type="button"
            onClick={() => setTrendRange('30d')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              trendRange === '30d'
                ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
            }`}
          >
            近 30 日
          </button>
          <button
            type="button"
            onClick={() => setTrendRange('year')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              trendRange === 'year'
                ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
            }`}
          >
            本年度
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {trendRange === '7d' ? '双轴：折线=文件数 / 柱=总大小MB' : trendRange === '30d' ? '近 30 天每日文件数' : '本年度每月文件数'}
          </span>
        </div>
        <ReactECharts
          option={trendOption}
          style={{ height: 320, width: '100%' }}
          onEvents={{ click: onTrendClick }}
        />
        {dateFilter && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>已筛选日期: <span className="text-primary">{dateFilter}</span></span>
            <button
              type="button"
              onClick={() => setDateFilter(null)}
              className="text-destructive transition-colors hover:underline"
            >
              清除
            </button>
          </div>
        )}
      </ChartCard>

      {/* ============ 5. 最近上传（实时材料流 + 联动筛选）============ */}
      <ChartCard
        title="最近上传"
        icon={FileText}
        loading={false}
        isEmpty={recentList.length === 0}
        emptyText={extFilter || dateFilter ? '当前筛选条件下无记录' : '暂无上传记录'}
        emptyDesc={extFilter || dateFilter ? '最近 8 条上传中无匹配项，可在材料管理页查看全部' : '上传材料后将在此实时展示'}
      >
        {extFilter && (
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>已筛选类型: <span className="text-primary">.{extFilter}</span></span>
            <button
              type="button"
              onClick={() => setExtFilter(null)}
              className="text-destructive transition-colors hover:underline"
            >
              清除
            </button>
          </div>
        )}
        <ul className="flex flex-col divide-y divide-border transition-opacity duration-300">
          {recentList.map((it) => (
            <li
              key={it.id}
              className="group flex items-center gap-3 py-2 transition-colors hover:bg-secondary"
            >
              <FileText className={`h-4 w-4 shrink-0 ${fileColorClass(it.file_ext)}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{it.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {it.category_name} · {fmtSize(it.file_size)} · {it.creator_name || '未知'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* 默认显示时间，hover 时显示操作按钮 */}
                <span className="text-xs text-muted-foreground tabular-nums group-hover:hidden">
                  {fmtTime(it.created_at)}
                </span>
                <div className="hidden gap-1 group-hover:flex">
                  <button
                    type="button"
                    title="预览（跳转材料管理）"
                    onClick={goDeliverables}
                    className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    title="下载"
                    onClick={() => {
                      deliverablesApi.download(it.id, it.filename || it.name).catch(() => {})
                    }}
                    className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    下载
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={goDeliverables}
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
          >
            查看全部 →
          </button>
        </div>
      </ChartCard>
    </div>
  )
}

// ============ 主页面 ============
function Dashboard() {
  const [tab, setTab] = useState('operations')
  const [refreshing, setRefreshing] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [now, setNow] = useState(new Date())
  // 使用教程抽屉
  const [tutorialOpen, setTutorialOpen] = useState(false)

  // 实时时钟
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 刷新数据
  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 100)
  }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex shrink-0 items-center justify-between border-b border-border panel-glass px-6 py-4">
        <div className="flex items-center gap-5">
          <div className="flex flex-col">
            <h1 className="text-gradient-primary text-3xl font-bold tracking-wide">运营大屏</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">智能安全运营平台 · 实时监控</p>
          </div>
          {/* Tab 切换 */}
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
            <button
              type="button"
              onClick={() => setTab('operations')}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === 'operations'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              安全运营大屏
            </button>
            <button
              type="button"
              onClick={() => setTab('ai_usage')}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === 'ai_usage'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              AI 使用大屏
            </button>
            <button
              type="button"
              onClick={() => setTab('materials')}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === 'materials'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              材料管理大屏
            </button>
            <button
              type="button"
              onClick={() => setTab('duty')}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === 'duty'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
              }`}
            >
              值班大屏
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* 实时状态标识 */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              {autoRefresh && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${autoRefresh ? 'dot-pulse bg-success' : 'bg-border'}`} />
            </span>
            <span>{autoRefresh ? '实时更新 · 每 30 秒刷新' : '已暂停自动刷新'}</span>
          </div>

          {/* 使用教程 */}
          <TutorialButton onClick={() => setTutorialOpen(true)} />

          {/* 自动刷新开关 */}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? '关闭自动刷新' : '开启自动刷新'}
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <Radio className={`h-3.5 w-3.5 ${autoRefresh ? 'text-success' : ''}`} />
            <span>自动刷新</span>
            <span className={`ml-0.5 inline-flex h-3.5 w-6 items-center rounded-full p-0.5 transition ${autoRefresh ? 'bg-success' : 'bg-input'}`}>
              <span className={`h-2.5 w-2.5 rounded-full bg-white transition ${autoRefresh ? 'translate-x-2.5' : ''}`} />
            </span>
          </button>

          {/* 刷新按钮 */}
          <button
            type="button"
            onClick={handleRefresh}
            title="刷新数据"
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>

          {/* 当前时间 */}
          <div className="text-sm tabular-nums text-muted-foreground">
            {now.toLocaleString('zh-CN', { hour12: false })}
          </div>
        </div>
      </header>

      {/* 内容滚动区 */}
      <div className={`flex-1 min-w-0 ${tab === 'duty' ? 'overflow-hidden' : 'bg-tech-grid overflow-y-auto p-6'}`}>
        {tab === 'operations' ? (
          <OperationsDashboard
            onRefresh={handleRefresh}
            refreshing={refreshing}
            autoRefresh={autoRefresh}
            onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
          />
        ) : tab === 'ai_usage' ? (
          <AiUsagePanel />
        ) : tab === 'duty' ? (
          <DutyDashboard onSwitchTab={setTab} />
        ) : (
          <MaterialsDashboard
            refreshing={refreshing}
            autoRefresh={autoRefresh}
          />
        )}
      </div>

      {/* 使用教程 */}
      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="运营大屏使用教程"
        subtitle="了解三大大屏的数据维度、自动刷新与点击下钻"
        sections={DASHBOARD_TUTORIAL}
      />
    </div>
  )
}

export default Dashboard
