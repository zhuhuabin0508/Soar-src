// 调用监控：概览卡片 + 调用量趋势（成功/失败双系列）+ 按资源/按应用聚合
import { useCallback, useEffect, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { openAdminApi } from '../../api/openApi'
import { Card, DataTable, PillTabs } from '../../components/ui'
import { Activity, RefreshCw, PhoneCall, Timer, AppWindow } from 'lucide-react'

const PERIODS = [
  { key: '24h', label: '近 24 小时' },
  { key: '7d', label: '近 7 天' },
]

export default function StatsTab({ refreshKey = 0 }) {
  const [period, setPeriod] = useState('24h')
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await openAdminApi.stats(period)
      setStats(res?.data || null)
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load, refreshKey])

  const overview = stats?.overview || {}
  const timeseries = stats?.timeseries || []

  const trendOption = {
    grid: { left: 48, right: 16, top: 32, bottom: 28 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['成功', '失败'], top: 0, textStyle: { fontSize: 12 } },
    xAxis: { type: 'category', data: timeseries.map((t) => t.label), boundaryGap: false },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '成功', type: 'line', smooth: true, symbolSize: 4,
        data: timeseries.map((t) => t.success),
        itemStyle: { color: '#10b981' }, areaStyle: { color: 'rgba(16,185,129,0.12)' },
      },
      {
        name: '失败', type: 'line', smooth: true, symbolSize: 4,
        data: timeseries.map((t) => t.failed),
        itemStyle: { color: '#ef4444' }, areaStyle: { color: 'rgba(239,68,68,0.10)' },
      },
    ],
  }

  const aggBar = (rows, nameKey) => ({
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: rows.map((r) => r[nameKey] || 'unknown'), axisLabel: { interval: 0, fontSize: 11 } },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ type: 'bar', barMaxWidth: 42, data: rows.map((r) => r.calls), itemStyle: { color: '#3b82f6' } }],
  })

  const cards = [
    { icon: PhoneCall, label: '今日调用总数', value: overview.today_calls ?? 0, suffix: '次' },
    { icon: Activity, label: '成功率（周期内 2xx 占比）', value: overview.success_rate ?? 0, suffix: '%' },
    { icon: Timer, label: '平均响应耗时', value: overview.avg_response_ms ?? 0, suffix: 'ms' },
    { icon: AppWindow, label: '活跃应用数', value: overview.active_apps ?? 0, suffix: '个' },
  ]

  const detailColumns = [
    { key: 'resource_code', header: '资源', width: '180px', render: (r) => <span className="font-mono text-xs text-foreground">{r.resource_code}</span> },
    { key: 'calls', header: '调用次数', width: '110px', numeric: true },
    {
      key: 'success_rate', header: '成功率', width: '110px', numeric: true,
      render: (r) => <span className={r.success_rate < 80 ? 'text-destructive' : 'text-success'}>{r.success_rate}%</span>,
    },
    { key: 'avg_response_ms', header: '平均耗时', numeric: true, render: (r) => `${r.avg_response_ms} ms` },
  ]

  const emptyChart = (text) => (
    <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">{text}</div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs items={PERIODS} value={period} onChange={setPeriod} />
        <button type="button" className="btn-secondary btn-sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" /> 刷新
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* 概览卡片 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map(({ icon: Icon, label, value, suffix }) => (
          <div key={label} className="card px-4 py-3.5">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" /> {label}
            </div>
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {value}
              <span className="ml-1 text-xs font-normal text-muted-foreground">{suffix}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 趋势图 */}
      <Card title={`调用量趋势（${period === '24h' ? '按小时' : '按天'}）`}>
        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : (
          <ReactECharts option={trendOption} style={{ height: 300, width: '100%' }} />
        )}
      </Card>

      {/* 按资源 / 按应用聚合 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="按资源调用量">
          {loading
            ? emptyChart('加载中...')
            : (stats?.by_resource || []).length === 0
              ? emptyChart('暂无调用数据')
              : <ReactECharts option={aggBar(stats.by_resource, 'resource_code')} style={{ height: 260, width: '100%' }} />}
        </Card>
        <Card title="按应用调用量">
          {loading
            ? emptyChart('加载中...')
            : (stats?.by_app || []).length === 0
              ? emptyChart('暂无调用数据')
              : <ReactECharts option={aggBar(stats.by_app, 'app_name')} style={{ height: 260, width: '100%' }} />}
        </Card>
      </div>

      {/* 聚合明细表 */}
      {!loading && (stats?.by_resource || []).length > 0 && (
        <Card title="资源调用明细">
          <div className="overflow-hidden rounded-lg border border-border">
            <DataTable
              columns={detailColumns}
              data={stats.by_resource || []}
              rowKey="resource_code"
            />
          </div>
        </Card>
      )}
    </div>
  )
}
