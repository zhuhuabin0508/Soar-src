import { useEffect, useState, useMemo, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import { getStatsOverview } from '../api/executions'
import { workflows as workflowsApi } from '../api/client'
import { CompactSelect } from '../components/ui'

// 统计卡片：图标 + 数值 + 标签
function StatCard({ icon, label, value, suffix, accent }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4 rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-gray-900/40 p-5 shadow-lg">
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-2xl ${
          accent || 'bg-brand-500/10 text-brand-300'
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-2xl font-bold text-gray-100">{value}</span>
          {suffix && <span className="text-sm text-gray-400">{suffix}</span>}
        </div>
      </div>
    </div>
  )
}

// 执行监测看板
function MonitorDashboard() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState(7)
  const [workflowId, setWorkflowId] = useState('')
  const [workflows, setWorkflows] = useState([])

  // 加载工作流列表（用于筛选下拉，仅一次）
  useEffect(() => {
    ;(async () => {
      try {
        const data = await workflowsApi.list()
        setWorkflows(Array.isArray(data) ? data : [])
      } catch {
        setWorkflows([])
      }
    })()
  }, [])

  // 加载监测统计数据
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getStatsOverview(days, workflowId || null)
      setStats(data)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, workflowId])

  useEffect(() => {
    load()
  }, [load])

  // 按天趋势折线图：total / success / failed
  const trendOption = useMemo(() => {
    const byDay = stats?.by_day || []
    return {
      backgroundColor: 'transparent',
      color: ['#22d3ee', '#10b981', '#ef4444'],
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['总执行', '成功', '失败'],
        textStyle: { color: '#9ca3af' },
        top: 0,
      },
      grid: { left: 40, right: 24, top: 40, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: byDay.map((d) => d.date),
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
          name: '总执行',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.2 },
          data: byDay.map((d) => d.total),
        },
        {
          name: '成功',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.2 },
          data: byDay.map((d) => d.success),
        },
        {
          name: '失败',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.2 },
          data: byDay.map((d) => d.failed),
        },
      ],
    }
  }, [stats])

  // 触发类型分布饼图
  const triggerOption = useMemo(() => {
    const byTrigger = stats?.by_trigger || {}
    const data = Object.entries(byTrigger).map(([name, value]) => ({ name, value }))
    return {
      backgroundColor: 'transparent',
      color: [
        '#22d3ee',
        '#3b82f6',
        '#a855f7',
        '#ec4899',
        '#f59e0b',
        '#10b981',
        '#ef4444',
        '#6366f1',
      ],
      tooltip: { trigger: 'item' },
      legend: {
        type: 'scroll',
        orient: 'vertical',
        right: 8,
        top: 'center',
        textStyle: { color: '#9ca3af' },
      },
      series: [
        {
          name: '触发类型',
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['40%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#0b1020', borderWidth: 2 },
          label: { color: '#d1d5db' },
          data,
        },
      ],
    }
  }, [stats])

  // 节点瓶颈 Top 10 水平柱状图：按 avg_duration_seconds 降序，颜色按 failed_count 渐变
  const bottleneckOption = useMemo(() => {
    const bottleneck = (stats?.node_bottleneck || [])
      .slice()
      .sort((a, b) => b.avg_duration_seconds - a.avg_duration_seconds)
      .slice(0, 10)
    // 水平柱状图倒序，使最大值显示在顶部
    const sorted = bottleneck.slice().reverse()
    const maxFailed = sorted.reduce((m, d) => Math.max(m, d.failed_count || 0), 0)

    // 颜色按 failed_count 渐变：青色 -> 琥珀 -> 红色
    const interpolate = (c1, c2, t) => {
      const a = c1.match(/\w\w/g).map((x) => parseInt(x, 16))
      const b = c2.match(/\w\w/g).map((x) => parseInt(x, 16))
      const r = Math.round(a[0] + (b[0] - a[0]) * t)
      const g = Math.round(a[1] + (b[1] - a[1]) * t)
      const bl = Math.round(a[2] + (b[2] - a[2]) * t)
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl
        .toString(16)
        .padStart(2, '0')}`
    }
    const colorByFailed = (failed) => {
      if (maxFailed <= 0) return '#22d3ee'
      const ratio = (failed || 0) / maxFailed
      if (ratio <= 0.5) return interpolate('22d3ee', 'f59e0b', ratio / 0.5)
      return interpolate('f59e0b', 'ef4444', (ratio - 0.5) / 0.5)
    }
    const colors = sorted.map((d) => colorByFailed(d.failed_count))

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const item = sorted[params[0].dataIndex]
          if (!item) return ''
          return `${item.node_type}<br/>平均耗时: ${item.avg_duration_seconds}s<br/>执行次数: ${item.count}<br/>失败次数: ${item.failed_count}`
        },
      },
      grid: { left: 40, right: 24, top: 20, bottom: 32, containLabel: true },
      xAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#1f2937' } },
        axisLabel: { color: '#9ca3af' },
      },
      yAxis: {
        type: 'category',
        data: sorted.map((d) => d.node_type),
        axisLine: { lineStyle: { color: '#4b5563' } },
        axisLabel: { color: '#9ca3af' },
      },
      series: [
        {
          name: '平均耗时(秒)',
          type: 'bar',
          barWidth: '60%',
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: (params) => colors[params.dataIndex],
          },
          data: sorted.map((d) => d.avg_duration_seconds),
        },
      ],
    }
  }, [stats])

  const total = stats?.total ?? 0
  const successRate =
    stats?.success_rate != null ? Math.round(stats.success_rate * 100) : 0
  const avgDuration = stats?.avg_duration_seconds ?? 0
  const failed = stats?.failed ?? 0
  const dayOptions = [7, 14, 30, 90]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gray-950 text-gray-100">
      {/* 顶部标题栏 */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900/60 px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">执行监测看板</h1>
        <div className="flex flex-wrap items-center gap-4">
          {/* 工作流筛选 */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">工作流</span>
            <CompactSelect
              size="lg"
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
            >
              <option value="">全部</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </CompactSelect>
          </div>
          {/* 天数选择器 */}
          <div className="flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900/60 p-1">
            {dayOptions.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  days === d
                    ? 'bg-brand-500/20 text-brand-300'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {d} 天
              </button>
            ))}
          </div>
          {/* 刷新按钮 */}
          <button
            onClick={load}
            disabled={loading}
            className="btn-secondary btn-sm"
          >
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </header>

      {/* 内容滚动区 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-danger-500/40 bg-danger-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && !stats ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-500">
            加载中...
          </div>
        ) : (
          <div className="flex w-full flex-col gap-4">
            {/* 第一行：4 个统计卡片 */}
            <div className="flex w-full flex-col gap-4 sm:flex-row">
              <StatCard
                icon="📊"
                label="总执行数"
                value={total}
                accent="bg-brand-500/10 text-brand-300"
              />
              <StatCard
                icon="✅"
                label="成功率"
                value={successRate}
                suffix="%"
                accent="bg-success-500/10 text-success-300"
              />
              <StatCard
                icon="⏱️"
                label="平均耗时"
                value={avgDuration}
                suffix="秒"
                accent="bg-brand-500/10 text-brand-300"
              />
              <StatCard
                icon="⚠️"
                label="失败数"
                value={failed}
                accent="bg-danger-500/10 text-red-300"
              />
            </div>

            {/* 第二行：按天趋势折线图 */}
            <div className="w-full rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/80 to-gray-950 p-4">
              <div className="mb-2 text-sm font-medium text-gray-300">
                近 {days} 天执行趋势
              </div>
              <ReactECharts option={trendOption} style={{ height: 320, width: '100%' }} />
            </div>

            {/* 第三行：左触发类型饼图 + 右节点瓶颈柱状图 */}
            <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="w-full rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/80 to-gray-950 p-4">
                <div className="mb-2 text-sm font-medium text-gray-300">触发类型分布</div>
                <ReactECharts option={triggerOption} style={{ height: 320, width: '100%' }} />
              </div>
              <div className="w-full rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/80 to-gray-950 p-4">
                <div className="mb-2 text-sm font-medium text-gray-300">
                  节点瓶颈 Top 10（按平均耗时降序）
                </div>
                <ReactECharts option={bottleneckOption} style={{ height: 320, width: '100%' }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default MonitorDashboard
