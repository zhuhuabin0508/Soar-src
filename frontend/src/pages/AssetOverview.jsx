import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import {
  PieChart as PieIcon, List as ListIcon, Boxes, ShieldAlert,
  Activity, RefreshCw, Server, Network, Globe, ArrowRight,
} from 'lucide-react'
import { assetsApi } from '../api/assets'
import { guardNavPermission } from '../utils/permissions'
import { PageContainer, Card, ErrorState, StatusBadge } from '../components/ui'

// ECharts 配色（与 chart-1..5 令牌呼应）
const CHART_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
]

// 模板图标映射（code → lucide 组件）
const TEMPLATE_ICONS = {
  host_asset: Server,
  network_segment: Network,
  egress_ip: Globe,
}

// 状态中文映射
const STATUS_LABELS = {
  in_use: '在用', idle: '闲置', repair: '维修', retired: '报废', lost: '丢失',
}
const STATUS_COLORS = {
  in_use: '#10b981', idle: '#6b7280', repair: '#f59e0b', retired: '#6366f1', lost: '#ef4444',
}

// 重要性中文映射
const CRIT_LABELS = { low: '低', medium: '中', high: '高', critical: '严重' }
const CRIT_COLORS = { low: '#10b981', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' }

// ============================================================================
// ECharts 颜色解析：Canvas 无法解析 CSS 变量 var(--xxx)，需先用浏览器解析为 rgb
// 否则 axisLabel/axisLine/splitLine/legend 会回退为黑色，在深色主题下不可见。
// 通过临时 DOM 元素让浏览器把 oklch/color-mix 等计算为 rgb/rgba，结果缓存复用。
// ============================================================================
const _colorCache = {}
function resolveColor(cssVar, fallback) {
  if (typeof window === 'undefined') return fallback
  if (_colorCache[cssVar]) return _colorCache[cssVar]
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
    if (!raw) { _colorCache[cssVar] = fallback; return fallback }
    // 用临时元素让浏览器把 oklch / color-mix 等解析为 rgb 计算值
    const probe = document.createElement('div')
    probe.style.color = raw
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    document.body.removeChild(probe)
    const result = resolved || fallback
    _colorCache[cssVar] = result
    return result
  } catch {
    _colorCache[cssVar] = fallback
    return fallback
  }
}

// 统一获取 ECharts 主题色（渲染时调用，此时 DOM 已就绪、CSS 变量已应用）
// fallback 用浅色，适配深色主题（系统默认）
function chartThemeColors() {
  return {
    label: resolveColor('--muted-foreground', 'rgba(203, 213, 225, 0.85)'),
    legend: resolveColor('--muted-foreground', 'rgba(203, 213, 225, 0.85)'),
    axisLine: resolveColor('--border', 'rgba(255, 255, 255, 0.25)'),
    splitLine: resolveColor('--border', 'rgba(255, 255, 255, 0.1)'),
    cardBorder: resolveColor('--card', '#1a1a1a'),
  }
}

function StatCard({ icon: Icon, label, value, color = 'chart-1', sub }) {
  return (
    <Card className="flex items-center gap-4 p-5" hover>
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
        style={{ background: `var(--${color}, #6366f1)20`, color: `var(--${color}, #6366f1)` }}
      >
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={`mt-0.5 text-2xl font-bold tabular-nums ${value > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
          title={value == null ? '未统计' : undefined}
        >
          {value == null ? '--' : value.toLocaleString()}
        </div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
      </div>
    </Card>
  )
}

function ChartCard({ title, children, action }) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </Card>
  )
}

export default function AssetOverview() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await assetsApi.overview()
      setData(res)
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (error)
    return (
      <PageContainer>
        <ErrorState description={error} onRetry={load} />
      </PageContainer>
    )

  const total = data?.total ?? 0
  const tplCount = data?.templates?.length ?? 0
  const inUse = data?.by_status?.in_use ?? 0
  const highCrit = (data?.by_criticality?.high ?? 0) + (data?.by_criticality?.critical ?? 0)

  // ECharts 主题色（Canvas 可识别的 rgb 值）
  const tc = chartThemeColors()

  // 按模板分布（饼图）
  const tplPieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: tc.legend } },
    color: CHART_COLORS,
    series: [
      {
        type: 'pie',
        radius: ['40%', '68%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: tc.cardBorder, borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold', color: tc.label } },
        data: (data?.templates || [])
          .filter((t) => t.count > 0)
          .map((t) => ({ name: t.name, value: t.count })),
      },
    ],
  }

  // 按状态分布（环形图）
  const statusPieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: tc.legend } },
    color: Object.values(STATUS_COLORS),
    series: [
      {
        type: 'pie',
        radius: ['40%', '68%'],
        center: ['50%', '45%'],
        itemStyle: { borderRadius: 6, borderColor: tc.cardBorder, borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 'bold', color: tc.label } },
        data: Object.entries(data?.by_status || {}).map(([k, v]) => ({
          name: STATUS_LABELS[k] || k, value: v,
        })),
      },
    ],
  }

  // 按重要性（柱状图）
  const critOrder = ['low', 'medium', 'high', 'critical']
  const critBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: critOrder.map((k) => CRIT_LABELS[k] || k),
      axisLabel: { color: tc.label },
      axisLine: { lineStyle: { color: tc.axisLine } },
      axisTick: { lineStyle: { color: tc.axisLine } },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: tc.label },
      axisLine: { show: true, lineStyle: { color: tc.axisLine } },
      splitLine: { lineStyle: { color: tc.splitLine } },
    },
    series: [
      {
        type: 'bar',
        barWidth: '50%',
        itemStyle: { borderRadius: [6, 6, 0, 0] },
        data: critOrder.map((k) => ({
          value: data?.by_criticality?.[k] ?? 0,
          itemStyle: { color: CRIT_COLORS[k] },
        })),
      },
    ],
  }

  // 按部门 Top15（横向柱状图）
  const deptEntries = Object.entries(data?.by_department || {}).sort((a, b) => b[1] - a[1])
  const deptBarOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 10, right: 30, top: 10, bottom: 20, containLabel: true },
    xAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: tc.label },
      axisLine: { show: true, lineStyle: { color: tc.axisLine } },
      splitLine: { lineStyle: { color: tc.splitLine } },
    },
    yAxis: {
      type: 'category',
      data: deptEntries.map(([k]) => k).reverse(),
      axisLabel: { color: tc.label, width: 120, overflow: 'truncate' },
      axisLine: { lineStyle: { color: tc.axisLine } },
      axisTick: { lineStyle: { color: tc.axisLine } },
    },
    series: [
      {
        type: 'bar',
        barWidth: '55%',
        itemStyle: { borderRadius: [0, 6, 6, 0], color: '#6366f1' },
        data: deptEntries.map(([, v]) => v).reverse(),
      },
    ],
  }

  // 主机资产按所属云（饼图）
  const cloudEntries = Object.entries(data?.by_cloud || {})
  const cloudPieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: tc.legend } },
    color: CHART_COLORS,
    series: [
      {
        type: 'pie',
        radius: ['40%', '68%'],
        center: ['50%', '45%'],
        itemStyle: { borderRadius: 6, borderColor: tc.cardBorder, borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 'bold', color: tc.label } },
        data: cloudEntries.map(([k, v]) => ({ name: k, value: v })),
      },
    ],
  }

  // 近 30 天趋势（折线图）
  const trend = data?.trend || []
  const trendLineOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map((t) => t.date.slice(5)),
      axisLabel: { color: tc.label },
      axisLine: { lineStyle: { color: tc.axisLine } },
      axisTick: { lineStyle: { color: tc.axisLine } },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: tc.label },
      axisLine: { show: true, lineStyle: { color: tc.axisLine } },
      splitLine: { lineStyle: { color: tc.splitLine } },
    },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: '#6366f1' },
        itemStyle: { color: '#6366f1' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#6366f180' },
              { offset: 1, color: '#6366f110' },
            ],
          },
        },
        data: trend.map((t) => t.count),
      },
    ],
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部操作栏 */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">资产总览</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{total.toLocaleString()}</span> 项资产 ·{' '}
              <span className="font-medium tabular-nums text-foreground">{tplCount}</span> 个类型
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新资产总览数据">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          <button
            type="button"
            onClick={() => { if (!guardNavPermission('asset_list', 'view', '资产清单')) return; navigate('/assets/list') }}
            className="btn-secondary btn-sm"
            title="进入资产清单"
          >
            <ListIcon className="mr-1 h-3.5 w-3.5" /> 资产清单
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
      {/* 统计卡片（加载时渲染同结构骨架） */}
      <div className="card-stagger mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
                <div className="h-12 w-12 shrink-0 rounded-xl skeleton-shimmer" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3 w-20 rounded skeleton-shimmer" />
                  <div className="h-8 w-24 rounded skeleton-shimmer" />
                </div>
              </div>
            ))
          : (
            <>
              <StatCard icon={Boxes} label="资产总数" value={total} color="chart-1" sub={`${tplCount} 个资产类型`} />
              <StatCard icon={Activity} label="在用资产" value={inUse} color="chart-2" sub={`占比 ${total ? Math.round((inUse / total) * 100) : 0}%`} />
              <StatCard icon={ShieldAlert} label="高危资产" value={highCrit} color="chart-3" sub="高 + 严重" />
              <StatCard icon={PieIcon} label="资产类型" value={tplCount} color="chart-4" sub="含预设与自定义" />
            </>
          )}
      </div>

      {/* 模板卡片（可点击进入清单） */}
      <div className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">资产类型分布</h2>
          <button
            type="button"
            onClick={() => { if (!guardNavPermission('asset_templates', 'view', '类型模板')) return; navigate('/assets/templates') }}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            管理模板 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        <div className="card-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
                  <div className="h-10 w-10 shrink-0 rounded-lg skeleton-shimmer" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 w-1/2 rounded skeleton-shimmer" />
                    <div className="h-2.5 w-3/4 rounded skeleton-shimmer" />
                  </div>
                  <div className="h-7 w-10 rounded skeleton-shimmer" />
                </div>
              ))
            : (data?.templates || []).map((t, idx) => {
              const Icon = TEMPLATE_ICONS[t.code] || Boxes
              const color = CHART_COLORS[idx % CHART_COLORS.length]
              return (
                <button
                  key={t.code}
                  type="button"
                  onClick={() => { if (!guardNavPermission('asset_list', 'view', '资产清单')) return; navigate(`/assets/list?type_code=${encodeURIComponent(t.code)}`) }}
                  className="card-hover group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
                >
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: `${color}20`, color }}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{t.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{t.description || t.code}</div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-lg font-bold tabular-nums ${t.count > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                      title={t.count == null ? '未统计' : undefined}
                    >
                      {t.count == null ? '--' : t.count.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">条</div>
                  </div>
                </button>
              )
            })}
        </div>
      </div>

      {/* 图表网格（加载时渲染同结构骨架） */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col rounded-lg border border-border bg-card">
                <div className="border-b border-border px-5 py-3">
                  <div className="h-3.5 w-28 rounded skeleton-shimmer" />
                </div>
                <div className="p-4">
                  <div className="h-[280px] w-full rounded-md skeleton-shimmer" />
                </div>
              </div>
            ))
          : (
            <>
        <ChartCard title="按资产类型分布">
          {(data?.templates || []).some((t) => t.count > 0) ? (
            <ReactECharts option={tplPieOption} style={{ height: 300 }} />
          ) : (
            <EmptyChart />
          )}
        </ChartCard>
        <ChartCard title="按生命周期状态">
          {Object.keys(data?.by_status || {}).length > 0 ? (
            <ReactECharts option={statusPieOption} style={{ height: 300 }} />
          ) : (
            <EmptyChart />
          )}
        </ChartCard>
        <ChartCard title="按重要性等级">
          <ReactECharts option={critBarOption} style={{ height: 280 }} />
        </ChartCard>
        <ChartCard title="按部门 Top 15">
          {deptEntries.length > 0 ? (
            <ReactECharts option={deptBarOption} style={{ height: 320 }} />
          ) : (
            <EmptyChart />
          )}
        </ChartCard>
        <ChartCard title="主机资产 · 按所属云">
          {cloudEntries.length > 0 ? (
            <ReactECharts option={cloudPieOption} style={{ height: 300 }} />
          ) : (
            <EmptyChart text="暂无主机资产所属云数据" />
          )}
        </ChartCard>
        <ChartCard title="近 30 天新增趋势">
          <ReactECharts option={trendLineOption} style={{ height: 300 }} />
        </ChartCard>
            </>
          )}
      </div>
      </div>
    </div>
  )
}

function EmptyChart({ text = '暂无数据' }) {
  return (
    <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}
