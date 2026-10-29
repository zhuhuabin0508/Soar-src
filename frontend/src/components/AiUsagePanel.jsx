import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { getAiUsageStats } from '../api/dashboard'
import { Skeleton, EmptyState } from './ui'
import {
  Bot, Cpu, Activity, CheckCircle, Coins, Clock,
  TrendingUp, BarChart3, PieChart as PieIcon, Inbox, RefreshCw, Radio,
  ArrowUp, ArrowDown, Minus,
} from 'lucide-react'

// ============ 工具函数 ============
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(t)
  }
}

function fmtTokens(n) {
  if (n == null) return '--'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms) {
  if (ms == null) return '--'
  if (ms === 0) return '0ms'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms}ms`
}

// 数字加千分位（用于表格数值列）
function fmtNum(n) {
  if (n == null) return '--'
  if (n === 0) return '0'
  return n.toLocaleString('en-US')
}

// 0 值样式：灰色
function zeroClass(val) {
  return val === 0 ? 'text-muted-foreground' : ''
}

// 成功率等级颜色（≥99% 绿 / 95-99% 黄 / <95% 红）
function successRateClass(rate) {
  if (rate == null) return 'text-muted-foreground'
  if (rate >= 0.99) return 'text-success'
  if (rate >= 0.95) return 'text-warning'
  return 'text-destructive'
}

// 成功率进度条颜色
function successRateBarColor(rate) {
  if (rate == null) return '#6b7280'
  if (rate >= 0.99) return '#10b981'
  if (rate >= 0.95) return '#f59e0b'
  return '#ef4444'
}

// 按耗时阈值返回颜色
function latencyColor(ms) {
  if (ms == null) return 'text-muted-foreground'
  if (ms < 1000) return 'text-success'
  if (ms <= 3000) return 'text-warning'
  return 'text-destructive'
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

// ============ 带计数动画的数字 ============
function AnimatedNumber({ value, duration = 1000 }) {
  const display = useCountUp(value, duration)
  if (value == null) return <span className="text-muted-foreground">--</span>
  return <span className="tabular-nums">{display}</span>
}

// ============ KPI 卡片（带图标、语义颜色、趋势） ============
function AiKpiCard({ icon: Icon, label, value, suffix, accent, trend, loading }) {
  if (loading) {
    return (
      <div className="min-w-0 flex-1 rounded-xl border border-border bg-card p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-3 h-8 w-16" />
      </div>
    )
  }
  // 空值处理
  const isEmpty = value == null || value === '-'
  // 颜色：空值用中性灰，有值用语义色
  const valueClass = isEmpty ? 'text-muted-foreground' : accent

  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
      <div className="flex items-center gap-2">
        {Icon && (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
        )}
        <span className="text-xs font-normal text-muted-foreground">{label}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span
          className={`bg-clip-text text-3xl font-bold text-transparent ${valueClass}`}
        >
          {typeof value === 'number' ? <AnimatedNumber value={value} /> : (isEmpty ? '--' : value)}
        </span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {/* 趋势提示 */}
      {trend != null && !isEmpty && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px]">
          {trend > 0 ? (
            <ArrowUp className="h-3 w-3 text-success" />
          ) : trend < 0 ? (
            <ArrowDown className="h-3 w-3 text-destructive" />
          ) : (
            <Minus className="h-3 w-3 text-muted-foreground" />
          )}
          <span className={trend > 0 ? 'text-success' : trend < 0 ? 'text-destructive' : 'text-muted-foreground'}>
            {trend > 0 ? '+' : ''}{Math.abs(trend)}% 较昨日
          </span>
        </div>
      )}
    </div>
  )
}

// ============ 图表卡片包装 ============
function ChartCard({ title, icon: Icon, loading, isEmpty, emptyText, emptyDesc, updatedAt, description, children }) {
  const [showTip, setShowTip] = useState(false)
  return (
    <div className="w-full rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          <span className="text-sm font-medium text-foreground">{title}</span>
          {description && (
            <div className="relative">
              <button
                type="button"
                onMouseEnter={() => setShowTip(true)}
                onMouseLeave={() => setShowTip(false)}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground transition hover:text-foreground"
              >
                ?
              </button>
              {showTip && (
                <div className="absolute left-1/2 top-full z-20 mt-1 w-48 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-[11px] leading-relaxed text-muted-foreground shadow-lg">
                  {description}
                </div>
              )}
            </div>
          )}
        </div>
        {updatedAt && !loading && !isEmpty && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            更新于 {updatedAt}
          </span>
        )}
      </div>
      {loading ? (
        <div className="flex h-[300px] items-center justify-center">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      ) : isEmpty ? (
        <div className="flex h-[300px] items-center justify-center">
          <EmptyState icon={Inbox} title={emptyText || '暂无数据'} description={emptyDesc} />
        </div>
      ) : (
        children
      )}
    </div>
  )
}

// ============ AI 使用大屏 ============
function AiUsagePanel() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(7)
  const [refreshing, setRefreshing] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastUpdate, setLastUpdate] = useState('')

  const loadData = useCallback(async () => {
    try {
      const data = await getAiUsageStats(days)
      setStats(data)
      setError('')
      setLastUpdate(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [days])

  // 每 30 秒轮询（统一刷新频率，受 autoRefresh 控制）
  useEffect(() => {
    loadData()
    if (!autoRefresh) return
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [loadData, autoRefresh])

  // 手动刷新
  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    loadData()
  }, [loadData])

  const kpi = stats?.kpi || {}
  const agentUsage = stats?.agent_usage || []
  const modelUsage = stats?.model_usage || []
  const agentTrend = stats?.agent_trend || []
  const modelTrend = stats?.model_trend || []
  const providerDist = stats?.provider_distribution || []
  const triggerDist = stats?.trigger_distribution || []

  // 判断空数据
  const agentTrendEmpty = agentTrend.every((d) => (d.count || 0) === 0)
  const modelTrendEmpty = modelTrend.every((d) => (d.count || 0) === 0 && (d.tokens || 0) === 0)
  const providerEmpty = providerDist.length === 0 || providerDist.every((c) => (c.value || 0) === 0)
  const triggerEmpty = triggerDist.length === 0 || triggerDist.every((c) => (c.value || 0) === 0)

  // 成功率特殊处理
  const successRateRaw = kpi.model_success_rate
  const successRateValue = successRateRaw != null ? Math.round(successRateRaw * 100) : null
  const successRateAccent =
    successRateValue == null ? 'text-muted-foreground'
    : successRateValue >= 90 ? 'bg-gradient-to-r from-emerald-400 to-cyan-500'
    : successRateValue >= 50 ? 'bg-gradient-to-r from-amber-400 to-orange-500'
    : 'bg-gradient-to-r from-red-400 to-pink-500'

  // 智能体调用趋势（折线，含峰值标注）
  const agentTrendOption = useMemo(() => {
    const data = agentTrend.map((d) => d.count)
    const maxVal = Math.max(...data, 0)
    const maxIdx = data.indexOf(maxVal)
    return {
      backgroundColor: 'transparent',
      color: ['#22d3ee'],
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const p = params[0]
          return `${p.axisValue}<br/>${p.marker} ${p.seriesName}: <b>${p.value}</b>`
        },
      },
      grid: { left: 40, right: 24, top: 30, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: agentTrend.map((d) => d.date),
        axisLine: { lineStyle: { color: '#4b5563' } },
        axisLabel: { color: '#9ca3af' },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#1f2937' } },
        axisLabel: { color: '#9ca3af' },
      },
      series: [
        {
          name: '智能体调用',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.2 },
          data,
          symbolSize: (val) => val === maxVal && val > 0 ? 10 : 6,
          markPoint: maxVal > 0 ? {
            data: [{ coord: [maxIdx, maxVal], value: maxVal, name: '峰值' }],
            symbolSize: 40,
            itemStyle: { color: '#22d3ee' },
            label: { color: '#fff', fontSize: 11 },
          } : undefined,
        },
      ],
    }
  }, [agentTrend])

  // 模型调用趋势（折线 + Token 柱状双轴）
  const modelTrendOption = useMemo(() => {
    const hasData = modelTrend.length > 0 && !modelTrendEmpty
    return {
      backgroundColor: 'transparent',
      color: ['#22d3ee', '#f59e0b'],
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          let s = params[0].axisValue + '<br/>'
          params.forEach((p) => {
            const val = p.seriesName === 'Token 消耗' ? fmtTokens(p.value) : p.value
            s += `${p.marker} ${p.seriesName}: <b>${val}</b><br/>`
          })
          return s
        },
      },
      legend: {
        data: ['调用次数', 'Token 消耗'],
        textStyle: { color: '#9ca3af' },
        top: 0,
      },
      grid: { left: 40, right: 50, top: 40, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: modelTrend.map((d) => d.date),
        axisLine: { lineStyle: { color: '#4b5563' } },
        axisLabel: { color: '#9ca3af' },
      },
      yAxis: [
        {
          type: 'value',
          name: '次数',
          nameTextStyle: { color: '#22d3ee' },
          splitLine: { lineStyle: { color: '#1f2937' } },
          axisLabel: { color: '#22d3ee' },
          axisLine: { show: true, lineStyle: { color: '#22d3ee' } },
        },
        {
          type: 'value',
          name: 'Token',
          nameTextStyle: { color: '#f59e0b' },
          splitLine: { show: false },
          axisLabel: { color: '#f59e0b', formatter: (v) => fmtTokens(v) },
          axisLine: { show: true, lineStyle: { color: '#f59e0b' } },
        },
      ],
      series: [
        {
          name: '调用次数',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.2 },
          data: modelTrend.map((d) => d.count),
          // 确保折线在柱子上方
          z: 3,
        },
        {
          name: 'Token 消耗',
          type: 'bar',
          yAxisIndex: 1,
          barWidth: '25%',
          // 半透明填充 + 实色边框
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: 'rgba(245, 158, 11, 0.5)',
            borderColor: '#f59e0b',
            borderWidth: 1,
          },
          data: modelTrend.map((d) => d.tokens),
          z: 1,
        },
      ],
    }
  }, [modelTrend, modelTrendEmpty])

  // 供应商分布（环形图，中心显示总数）
  const providerTotal = providerDist.reduce((sum, c) => sum + (c.value || 0), 0)
  const providerOption = useMemo(() => ({
    backgroundColor: 'transparent',
    color: ['#22d3ee', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#10b981', '#ef4444'],
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 8,
      top: 'center',
      textStyle: { color: '#9ca3af' },
    },
    series: [
      {
        name: '供应商',
        type: 'pie',
        // 环更薄
        radius: ['45%', '60%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#0b1020', borderWidth: 2 },
        label: {
          color: '#d1d5db',
          formatter: '{b}\n{d}%',
        },
        // 中心文字
        labelLine: { length: 10, length2: 8 },
        emphasis: {
          label: { show: true, fontSize: 14, fontWeight: 'bold' },
        },
        data: providerDist.map((c) => ({ name: c.name, value: c.value })),
      },
    ],
    // 中心 graphic
    graphic: providerTotal > 0 ? {
      type: 'text',
      left: '28%',
      top: '46%',
      style: {
        text: `共 ${providerTotal}`,
        fill: '#9ca3af',
        fontSize: 13,
        textAlign: 'center',
      },
    } : undefined,
  }), [providerDist, providerTotal])

  // 触发来源分布（水平条形图：百分比 + 最小可见宽度 + 语义色）
  const triggerOption = useMemo(() => {
    const sorted = [...triggerDist].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 10)
    const total = sorted.reduce((sum, c) => sum + (c.value || 0), 0) || 1
    // 语义着色：health_check 蓝/青、agent_test 紫、manual_test 橙、其他灰
    const semanticColor = (name) => {
      const n = (name || '').toLowerCase()
      if (n.includes('health')) return { color: '#22d3ee', bg: 'rgba(34,211,238,0.7)' }
      if (n.includes('agent')) return { color: '#a855f7', bg: 'rgba(168,85,247,0.7)' }
      if (n.includes('manual')) return { color: '#f59e0b', bg: 'rgba(245,158,11,0.7)' }
      return { color: '#3b82f6', bg: 'rgba(59,130,246,0.7)' }
    }
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const p = params[0]
          const pct = ((p.value / total) * 100).toFixed(1)
          return `${p.name}<br/>${p.marker} 调用次数: <b>${p.value}</b> (${pct}%)`
        },
      },
      grid: { left: 90, right: 80, top: 10, bottom: 20, containLabel: true },
      xAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#1f2937' } },
        axisLabel: { color: '#9ca3af' },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((c) => c.name),
        axisLine: { lineStyle: { color: '#4b5563' } },
        axisLabel: { color: '#9ca3af' },
      },
      series: [
        {
          name: '调用次数',
          type: 'bar',
          barWidth: '55%',
          // 最小可见宽度：barMinHeight 对水平条无效，改用 barMinWidth
          barMinWidth: 8,
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            // 语义着色
            color: (params) => semanticColor(sorted[params.dataIndex]?.name).bg,
            borderColor: (params) => semanticColor(sorted[params.dataIndex]?.name).color,
            borderWidth: 1,
          },
          label: {
            show: true,
            position: 'right',
            color: '#9ca3af',
            fontSize: 11,
            // 显示「数值 (百分比%)」
            formatter: (params) => {
              const pct = ((params.value / total) * 100).toFixed(1)
              return `${params.value} (${pct}%)`
            },
          },
          data: sorted.map((c) => c.value),
        },
      ],
    }
  }, [triggerDist])

  return (
    <div className="flex w-full flex-col gap-6">
      {/* 顶部控制区：时间范围 + 刷新 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">统计范围：</span>
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => { setDays(d); setLoading(true) }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                days === d
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              近 {d} 天
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {/* 实时状态 */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              {autoRefresh && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${autoRefresh ? 'bg-success' : 'bg-border'}`} />
            </span>
            <span>{autoRefresh ? '实时 · 每 30 秒' : '已暂停'}</span>
          </div>

          {/* 自动刷新开关 */}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? '关闭自动刷新' : '开启自动刷新'}
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <Radio className={`h-3.5 w-3.5 ${autoRefresh ? 'text-success' : ''}`} />
            <span>自动</span>
            <span className={`ml-0.5 inline-flex h-3.5 w-6 items-center rounded-full p-0.5 transition ${autoRefresh ? 'bg-success' : 'bg-input'}`}>
              <span className={`h-2.5 w-2.5 rounded-full bg-white transition ${autoRefresh ? 'translate-x-2.5' : ''}`} />
            </span>
          </button>

          {/* 刷新按钮 */}
          <button
            type="button"
            onClick={handleRefresh}
            title="刷新数据"
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>

          {/* 最后更新时间 */}
          {lastUpdate && (
            <span className="text-[10px] text-muted-foreground">
              最后更新 {lastUpdate}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* KPI 卡片：响应式布局，大屏6列、中屏3列、小屏2列 */}
      <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <AiKpiCard
          icon={Activity}
          label="智能体调用总数"
          value={kpi.total_agent_calls ?? null}
          accent="bg-gradient-to-r from-cyan-400 to-cyan-600"
          loading={loading && !stats}
        />
        <AiKpiCard
          icon={Bot}
          label="活跃智能体数"
          value={kpi.active_agents ?? null}
          accent="bg-gradient-to-r from-emerald-400 to-emerald-600"
          loading={loading && !stats}
        />
        <AiKpiCard
          icon={Cpu}
          label="大模型调用总数"
          value={kpi.total_model_calls ?? null}
          accent="bg-gradient-to-r from-cyan-400 to-blue-500"
          loading={loading && !stats}
        />
        <AiKpiCard
          icon={CheckCircle}
          label="模型调用成功率"
          value={successRateValue}
          suffix="%"
          accent={successRateAccent}
          loading={loading && !stats}
        />
        <AiKpiCard
          icon={Coins}
          label="总 Token 消耗"
          value={fmtTokens(kpi.total_tokens)}
          accent="bg-gradient-to-r from-amber-400 to-orange-500"
          loading={loading && !stats}
        />
        <AiKpiCard
          icon={Clock}
          label="模型平均耗时"
          value={fmtMs(kpi.avg_model_latency_ms)}
          accent={kpi.avg_model_latency_ms == null
            ? 'text-muted-foreground'
            : kpi.avg_model_latency_ms < 1000
              ? 'bg-gradient-to-r from-emerald-400 to-emerald-600'
              : kpi.avg_model_latency_ms <= 3000
                ? 'bg-gradient-to-r from-amber-400 to-orange-500'
                : 'bg-gradient-to-r from-red-400 to-pink-500'
          }
          loading={loading && !stats}
        />
      </div>

      {/* 中间：左折线 + 右组合图 */}
      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="智能体调用趋势"
          icon={TrendingUp}
          loading={loading && !stats}
          isEmpty={!loading && agentTrendEmpty}
          emptyText="暂无调用记录"
          emptyDesc="当前时间范围内未产生智能体调用"
          updatedAt={lastUpdate}
          description="峰值点自动标注"
        >
          <ReactECharts option={agentTrendOption} style={{ height: 300, width: '100%' }} />
        </ChartCard>

        <ChartCard
          title="调用次数与 Token 消耗趋势"
          icon={BarChart3}
          loading={loading && !stats}
          isEmpty={!loading && modelTrendEmpty}
          emptyText="暂无模型调用记录"
          emptyDesc="当前时间范围内未产生模型调用"
          updatedAt={lastUpdate}
          description="左轴(青色)为调用次数折线，右轴(橙色)为 Token 消耗柱状。"
        >
          <ReactECharts option={modelTrendOption} style={{ height: 300, width: '100%' }} />
        </ChartCard>
      </div>

      {/* 双图：供应商环形 + 触发来源条形 */}
      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="大模型供应商分布"
          icon={PieIcon}
          loading={loading && !stats}
          isEmpty={!loading && providerEmpty}
          emptyText="暂无供应商数据"
          emptyDesc="模型调用后将自动统计分布"
          updatedAt={lastUpdate}
          description="中心显示总调用次数"
        >
          <ReactECharts option={providerOption} style={{ height: 300, width: '100%' }} />
        </ChartCard>

        <ChartCard
          title="模型调用触发来源分布"
          icon={BarChart3}
          loading={loading && !stats}
          isEmpty={!loading && triggerEmpty}
          emptyText="暂无触发来源数据"
          emptyDesc="模型调用后将自动统计来源"
          updatedAt={lastUpdate}
          description="按触发来源(健康检查/智能体测试/人工测试)统计调用次数，条形末端显示数值与占比。"
        >
          <ReactECharts option={triggerOption} style={{ height: 300, width: '100%' }} />
        </ChartCard>
      </div>

      {/* 智能体使用排行表格 */}
      <div className="w-full rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">智能体使用排行</span>
          </div>
          <span className="text-xs text-muted-foreground">共 {agentUsage.length} 条数据</span>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm" style={{ fontFamily: "'Inter', 'Roboto Mono', monospace" }}>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2.5 pr-4 font-medium">智能体</th>
                <th className="py-2.5 pr-4 font-medium">引擎</th>
                <th className="py-2.5 pr-4 text-right font-medium">对话数</th>
                <th className="py-2.5 pr-4 text-right font-medium">消息数</th>
                <th className="py-2.5 pr-4 text-right font-medium">执行数</th>
                <th className="py-2.5 pr-4 text-right font-medium">模型调用</th>
                <th className="py-2.5 pr-4 text-right font-medium">Token</th>
                <th className="py-2.5 pr-4 font-medium">最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {loading && !stats ? (
                <tr>
                  <td colSpan={8} className="py-6">
                    <div className="flex flex-col gap-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-5 w-full" />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : agentUsage.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6">
                    <EmptyState icon={Inbox} title={`近 ${days} 天暂无智能体调用记录`} />
                  </td>
                </tr>
              ) : (
                agentUsage.map((a) => (
                  <tr
                    key={a.agent_id}
                    onClick={() => a.agent_id && navigate(`/agents/${a.agent_id}/monitor`)}
                    className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-primary/5"
                  >
                    <td className="py-2.5 pr-4 text-foreground">{a.agent_name}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {a.engine ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px]">{a.engine}</span>
                      ) : '-'}
                    </td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(a.conversation_count)}`}>{fmtNum(a.conversation_count)}</td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(a.message_count)} text-muted-foreground`}>{fmtNum(a.message_count)}</td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(a.execution_count)} text-muted-foreground`}>{fmtNum(a.execution_count)}</td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(a.model_call_count)}`}>{fmtNum(a.model_call_count)}</td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(a.total_tokens)} text-muted-foreground`}>{fmtTokens(a.total_tokens)}</td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground">{fmtTime(a.last_active_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 大模型使用排行表格 */}
      <div className="w-full rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">大模型使用排行</span>
          </div>
          <span className="text-xs text-muted-foreground">共 {modelUsage.length} 条数据</span>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm" style={{ fontFamily: "'Inter', 'Roboto Mono', monospace" }}>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2.5 pr-4 font-medium">配置名称</th>
                <th className="py-2.5 pr-4 font-medium">模型</th>
                <th className="py-2.5 pr-4 font-medium">供应商</th>
                <th className="py-2.5 pr-4 text-right font-medium">调用次数</th>
                <th className="py-2.5 pr-4 text-right font-medium">成功率</th>
                <th className="py-2.5 pr-4 text-right font-medium">平均耗时</th>
                <th className="py-2.5 pr-4 text-right font-medium">输入 Token</th>
                <th className="py-2.5 pr-4 text-right font-medium">输出 Token</th>
                <th className="py-2.5 pr-4 text-right font-medium">总 Token</th>
              </tr>
            </thead>
            <tbody>
              {loading && !stats ? (
                <tr>
                  <td colSpan={9} className="py-6">
                    <div className="flex flex-col gap-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-5 w-full" />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : modelUsage.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-6">
                    <EmptyState icon={Inbox} title={`近 ${days} 天暂无模型调用记录`} />
                  </td>
                </tr>
              ) : (
                modelUsage.map((m) => {
                  const rate = m.success_rate
                  const ratePct = rate != null ? Math.round(rate * 100) : null
                  // 异常组合：高调用但 0 Token
                  const isAnomaly = m.call_count > 0 && m.total_tokens === 0
                  return (
                    <tr
                      key={`${m.model_config_id ?? 'none'}`}
                      className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-primary/5"
                    >
                      <td className="py-2.5 pr-4 text-foreground">
                        {m.config_name}
                        {isAnomaly && (
                          <span
                            title="调用次数大于 0 但 Token 为 0，可能未统计 Token 或模型不支持"
                            className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warning/20 text-[9px] text-warning"
                          >?</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">{m.model_name || '-'}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        {m.provider ? (
                          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{m.provider}</span>
                        ) : '-'}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-foreground">{fmtNum(m.call_count)}</td>
                      <td className="py-2.5 pr-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className={`tabular-nums font-medium ${successRateClass(rate)}`}>
                            {ratePct != null ? `${ratePct}%` : '--'}
                          </span>
                          {ratePct != null && (
                            <div className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{ width: `${ratePct}%`, backgroundColor: successRateBarColor(rate) }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className={`py-2.5 pr-4 text-right tabular-nums ${latencyColor(m.avg_latency_ms)}`}>
                        {fmtMs(m.avg_latency_ms)}
                      </td>
                      <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(m.input_tokens)} text-muted-foreground`}>{fmtTokens(m.input_tokens)}</td>
                      <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(m.output_tokens)} text-muted-foreground`}>{fmtTokens(m.output_tokens)}</td>
                      <td className={`py-2.5 pr-4 text-right tabular-nums ${zeroClass(m.total_tokens)}`}>{fmtTokens(m.total_tokens)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default AiUsagePanel
