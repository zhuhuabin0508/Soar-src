// 网络安全工单监测平台 —— 政务风格监控大屏
//
// 设计基准 1920×1080，16:9 三栏布局，整屏 transform scale 自适应。
// 数据来源：GET /tickets/monitor 聚合接口（真实工单数据，排除归档），
// 页面 15s 轮询整体刷新，底部跑马灯每 8s 轮播一条最新工单。
//
// 七个分区（代码内以注释分隔）：
//   ① 顶部：标题栏 + 核心 KPI 总览
//   ② 左上：工单趋势分析（近 24 小时 / 7 天 / 30 天，新增 vs 关闭）
//   ③ 左下：事件类型与等级分布（类型环形 + 严重度×状态堆叠条形）
//   ④ 中央：处置状态流转图（流光连线）+ 最新工单实时列表
//   ⑤ 右上：SLA 时效分析（达标率仪表 + 响应/解决时长 + 超时率）
//   ⑥ 右下：来源平台统计（各平台 工单总量 / 今日新增 / 待处理 / 处理中 / 已解决）
//   ⑦ 底部：最新工单滚动明细（跑马灯）
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { AlertTriangle, Activity, Layers, TimerReset } from 'lucide-react'
import { ticketApi } from '../api/tickets'

// ============ 主题常量（参考大屏风格：深蓝黑底 + 灰蓝科技蓝 + 橙色强调 + 青色装饰） ============
const C = {
  deepNavy: '#0B131C',      // 底色（深蓝黑）
  panelBg: 'rgba(14, 26, 38, 0.78)',
  panelBorder: 'rgba(96, 138, 188, 0.38)',
  techBlue: '#4E8AD4',      // 科技蓝（主色）
  lightBlue: '#6FA0D8',     // 浅蓝（辅助）
  paleBlue: '#A8C8EC',
  cyan: '#45B8CD',          // 青色霓虹（装饰线条/流光）
  accent: '#E57832',        // 橙色强调（标题竖条/点缀）
  text: '#E6ECF2',
  subText: '#93A6B8',
  axis: 'rgba(110, 140, 175, 0.45)',
  split: 'rgba(80, 120, 170, 0.12)',
  red: '#FF4D4F',           // 紧急/超时
  orange: '#FFA940',        // 高危
  green: '#41D08C',         // 已解决
  grayBlue: '#5D7089',
  tooltipBg: '#10222F',
}
// 蓝灰渐变色板（饼图/多系列，含青色点缀）
const BLUE_PALETTE = ['#4E8AD4', '#5A9CAB', '#78A0D2', '#A8C8EC', '#3B5F8F', '#6FA8DC', '#8FB8D8', '#2E4A6B']

// ECharts 公共文本/坐标轴样式
const CHART_BASE = {
  textStyle: { color: C.subText, fontFamily: "'PingFang SC','Microsoft YaHei',sans-serif" },
}

function axisStyle(extra = {}) {
  return {
    axisLine: { lineStyle: { color: C.axis } },
    axisTick: { show: false },
    axisLabel: { color: C.subText, fontSize: 11, ...extra },
  }
}

// ============ 通用面板卡片（深蓝黑半透明底 + 微发光描边 + 橙色竖条标题 + 英文副标题） ============
function Panel({ title, subtitle, icon: Icon, right, children, className = '', bodyClassName = '', ...rest }) {
  return (
    <div className={`relative flex flex-col rounded-md border backdrop-blur-md ${className}`}
      style={{ background: C.panelBg, borderColor: C.panelBorder, boxShadow: `0 0 14px rgba(80, 130, 190, 0.14), inset 0 0 24px rgba(8, 16, 26, 0.4)` }} {...rest}>
      {/* 玻璃顶缘高光：层叠质感 */}
      <div className="pointer-events-none absolute inset-x-3 top-0 z-10 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(168,200,236,0.4), transparent)' }} />
      <div className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'rgba(96,138,188,0.22)' }}>
        <span className="h-3.5 w-[3px] rounded" style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}80` }} />
        <span className="text-[15px] font-bold tracking-wide" style={{ color: C.text }}>{title}</span>
        {subtitle && (
          <span className="truncate text-[10px] uppercase tracking-[2px]" style={{ color: C.subText, opacity: 0.75 }}>{subtitle}</span>
        )}
        {Icon && <Icon className="h-3.5 w-3.5" style={{ color: C.lightBlue }} />}
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </div>
  )
}

// ============ ① 顶部：标题栏 + 时钟 ============
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function HeaderBar() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const pad = (n) => String(n).padStart(2, '0')
  return (
    <div className="relative flex h-16 items-center justify-center px-6">
      {/* 标题底衬光带 */}
      <div className="absolute inset-x-0 top-0 h-16"
        style={{ background: 'linear-gradient(180deg, rgba(69,184,205,0.20) 0%, rgba(11,19,28,0) 100%)' }} />
      {/* 两侧对称装饰线（青色霓虹） */}
      <div className="absolute left-6 top-1/2 h-[2px] w-[260px] -translate-y-1/2"
        style={{ background: `linear-gradient(90deg, transparent, ${C.cyan})`, boxShadow: `0 0 8px ${C.cyan}66` }} />
      <div className="absolute right-6 top-1/2 h-[2px] w-[260px] -translate-y-1/2"
        style={{ background: `linear-gradient(270deg, transparent, ${C.cyan})`, boxShadow: `0 0 8px ${C.cyan}66` }} />
      <div className="relative text-center">
        <h1 className="text-[30px] font-bold tracking-[6px]"
          style={{ color: C.text, textShadow: `0 0 18px ${C.cyan}59`, fontFamily: "'PingFang SC','Microsoft YaHei',sans-serif" }}>
          网络安全工单监测平台
        </h1>
        <div className="mt-0.5 text-[11px] tracking-[4px]" style={{ color: C.cyan, opacity: 0.85 }}>
          TICKET&nbsp;MONITORING&nbsp;&amp;&nbsp;OPERATIONS&nbsp;CENTER
        </div>
      </div>
      {/* 右上角实时时钟 */}
      <div className="absolute right-6 top-1/2 -translate-y-1/2 text-right">
        <div className="font-mono text-[20px] font-bold tabular-nums" style={{ color: C.text }}>
          {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
        </div>
        <div className="text-[12px]" style={{ color: C.subText }}>
          {now.getFullYear()}-{pad(now.getMonth() + 1)}-{pad(now.getDate())}&nbsp;&nbsp;{WEEKDAYS[now.getDay()]}
        </div>
      </div>
    </div>
  )
}

// ============ ① KPI 指标卡（数字滚动动画 + 昨日对比箭头） ============
// 数字缓动滚动（科技感）；系统开启"减少动态效果"时直接显示终值
function useCountUp(value, duration = 800) {
  const [display, setDisplay] = useState(value ?? 0)
  const fromRef = useRef(value ?? 0)
  useEffect(() => {
    const target = value ?? 0
    const from = fromRef.current
    if (from === target) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target
      setDisplay(target)
      return undefined
    }
    const start = performance.now()
    let raf
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(Math.round(from + (target - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return value === null || value === undefined ? value : display
}

function KpiCard({ label, value, unit = '件', tone = 'blue', delta, deltaLabel = '较昨日' }) {
  const toneColor = tone === 'red' ? C.red : tone === 'green' ? C.green : tone === 'orange' ? C.orange : C.lightBlue
  const animated = useCountUp(value)
  return (
    <div className="relative flex flex-col justify-center rounded-md border px-4 transition-all duration-300 hover:brightness-110"
      style={{ background: 'linear-gradient(160deg, rgba(78,138,212,0.14), rgba(14,26,38,0.72))', borderColor: 'rgba(96,138,188,0.35)', boxShadow: '0 0 10px rgba(80,130,190,0.10)' }}>
      <div className="text-[13px]" style={{ color: C.subText }}>{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[30px] font-bold leading-[1.15] tabular-nums" style={{ color: toneColor, textShadow: `0 0 10px ${toneColor}40` }}>
          {animated ?? '--'}
        </span>
        <span className="text-[11px]" style={{ color: C.subText }}>{unit}</span>
        {delta !== undefined && delta !== null && (
          <span className="ml-auto flex items-center gap-0.5 text-[11px]"
            style={{ color: delta > 0 ? C.green : delta < 0 ? C.orange : C.subText }}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}{Math.abs(delta)}
            <span style={{ color: C.subText }}>&nbsp;{deltaLabel}</span>
          </span>
        )}
      </div>
      <div className="absolute bottom-0 left-0 h-[2px] w-full rounded-b-md opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${toneColor}, transparent)` }} />
    </div>
  )
}

// ============ ② 左上：工单趋势（折线面积图，24h/7天/30天切换） ============
function TrendChart({ trend }) {
  const [range, setRange] = useState('hours24')
  const tabs = [['hours24', '近24小时'], ['days7', '近7天'], ['days30', '近30天']]
  const rows = trend?.[range] || []
  const option = useMemo(() => ({
    ...CHART_BASE,
    grid: { left: 42, right: 16, top: 34, bottom: 26 },
    legend: {
      data: ['新增工单', '关闭工单'], right: 8, top: 2, itemWidth: 14, itemHeight: 8,
      textStyle: { color: C.subText, fontSize: 11 },
    },
    tooltip: { trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 12 } },
    xAxis: { type: 'category', data: rows.map((r) => r.label), boundaryGap: false, ...axisStyle({ interval: range === 'hours24' ? 3 : 'auto' }) },
    yAxis: { type: 'value', minInterval: 1, name: '件', nameTextStyle: { color: C.subText, fontSize: 11 }, splitLine: { lineStyle: { color: C.split } }, ...axisStyle() },
    series: [
      {
        name: '新增工单', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
        data: rows.map((r) => r.new), lineStyle: { width: 2, color: C.techBlue },
        itemStyle: { color: C.techBlue },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: 'rgba(78,138,212,0.35)' }, { offset: 1, color: 'rgba(78,138,212,0.02)' }] } },
      },
      {
        name: '关闭工单', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
        data: rows.map((r) => r.closed), lineStyle: { width: 2, color: C.cyan },
        itemStyle: { color: C.cyan },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: 'rgba(69,184,205,0.26)' }, { offset: 1, color: 'rgba(69,184,205,0.02)' }] } },
      },
    ],
  }), [rows, range])
  return (
    <Panel
      title="工单趋势分析" subtitle="TREND ANALYSIS" icon={Activity} className="h-[400px]"
      right={tabs.map(([key, label]) => (
        <button key={key} onClick={() => setRange(key)} className="rounded px-2 py-0.5 text-[11px] transition"
          style={range === key
            ? { background: 'rgba(78,138,212,0.35)', color: C.text, border: `1px solid ${C.techBlue}66` }
            : { color: C.subText, border: '1px solid rgba(96,138,188,0.25)' }}>
          {label}
        </button>
      ))}
    >
      <ReactECharts option={option} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }} />
    </Panel>
  )
}

// ============ ③ 左下：类型与等级分布（Tab 轮播：类型 / 平台 / 严重度×状态） ============
function pieOption(rows) {
  const data = rows || []
  const total = data.reduce((s, d) => s + (d.value || 0), 0)
  return {
    ...CHART_BASE,
    color: BLUE_PALETTE,
    tooltip: {
      trigger: 'item', backgroundColor: C.tooltipBg, borderColor: C.panelBorder,
      textStyle: { color: C.text, fontSize: 12 }, formatter: '{b}：{c} 件（{d}%）',
    },
    // 环形中心显示总量
    title: total > 0 ? {
      text: String(total), subtext: '总件数',
      left: 'center', top: '36%',
      textStyle: { color: C.text, fontSize: 32, fontWeight: 'bold', fontFamily: 'monospace' },
      subtextStyle: { color: C.subText, fontSize: 12 },
    } : undefined,
    graphic: total === 0 ? [{
      type: 'text', left: 'center', top: 'middle',
      style: { text: '暂无数据', fill: C.subText, fontSize: 13 },
    }] : undefined,
    series: [{
      type: 'pie', radius: ['48%', '70%'], center: ['50%', '46%'],
      label: { color: C.text, fontSize: 12, width: 100, overflow: 'break', formatter: '{b}\n{c}件 · {d}%' },
      labelLine: { length: 14, length2: 10, lineStyle: { color: C.axis } },
      itemStyle: { borderColor: '#0A1220', borderWidth: 1 },
      data,
    }],
  }
}

// 严重度堆叠条形图：段内白字数值（仅非 0 段显示）
const SEG_LABEL = {
  show: true, position: 'inside', color: '#FFFFFF', fontSize: 11,
  fontFamily: 'monospace', formatter: (p) => (p.value > 0 ? p.value : ''),
}

// 分布模块视图 Tab：告警类型 / 严重度×状态
const DIST_TABS = [['type', '告警类型'], ['sev', '严重度×状态']]

function DistPanel({ dist, severityStatus }) {
  const [tab, setTab] = useState('type')
  const [paused, setPaused] = useState(false)
  const sev = severityStatus || []

  // 自动轮播：8s 切换下一视图；hover 面板暂停；手动切换后重新计时
  useEffect(() => {
    if (paused) return undefined
    const t = setInterval(() => {
      setTab((cur) => {
        const i = DIST_TABS.findIndex(([k]) => k === cur)
        return DIST_TABS[(i + 1) % DIST_TABS.length][0]
      })
    }, 8000)
    return () => clearInterval(t)
  }, [paused, tab])

  const stackOption = useMemo(() => ({
    ...CHART_BASE,
    grid: { left: 78, right: 46, top: 32, bottom: 20 },
    legend: {
      data: ['进行中', '已完成', '已取消'], top: 0, itemWidth: 12, itemHeight: 8,
      textStyle: { color: C.subText, fontSize: 11 },
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 12 } },
    xAxis: { type: 'value', minInterval: 1, name: '件', nameTextStyle: { color: C.subText, fontSize: 11 }, splitLine: { lineStyle: { color: C.split } }, ...axisStyle() },
    yAxis: {
      type: 'category', inverse: true,
      data: sev.map((s) => s.name),
      axisLine: { lineStyle: { color: C.axis } },
      axisTick: { show: false },
      axisLabel: {
        interval: 0, margin: 10,
        formatter: (name) => {
          const row = sev.find((s) => s.name === name)
          const total = row ? (row.processing || 0) + (row.completed || 0) + (row.cancelled || 0) : 0
          return total > 0 ? `{n|${name}}\n{t|合计 ${total} 件}` : name
        },
        rich: {
          n: { color: C.text, fontSize: 12, lineHeight: 16, align: 'right' },
          t: { color: C.subText, fontSize: 10, lineHeight: 13, align: 'right' },
        },
      },
    },
    series: [
      { name: '进行中', type: 'bar', stack: 'total', barWidth: 18, itemStyle: { color: C.techBlue }, label: SEG_LABEL, data: sev.map((s) => s.processing) },
      { name: '已完成', type: 'bar', stack: 'total', itemStyle: { color: C.green }, label: SEG_LABEL, data: sev.map((s) => s.completed) },
      { name: '已取消', type: 'bar', stack: 'total', itemStyle: { color: C.grayBlue }, label: SEG_LABEL, data: sev.map((s) => s.cancelled) },
    ],
  }), [sev])

  return (
    <Panel
      title="事件类型与等级分布" subtitle="DISTRIBUTION" icon={AlertTriangle} className="h-[376px]"
      bodyClassName="px-3 py-2"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      right={DIST_TABS.map(([key, label]) => (
        <button key={key} onClick={() => setTab(key)} className="rounded px-2 py-0.5 text-[11px] transition"
          style={tab === key
            ? { background: 'rgba(78,138,212,0.35)', color: C.text, border: `1px solid ${C.techBlue}66` }
            : { color: C.subText, border: '1px solid rgba(96,138,188,0.25)' }}>
          {label}
        </button>
      ))}
    >
      {tab === 'sev' ? (
        <ReactECharts key="sev" option={stackOption} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }} />
      ) : (
        <ReactECharts key={tab} option={pieOption(dist?.type)} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }} />
      )}
    </Panel>
  )
}

// ============ ④ 中央-上：处置状态流转图（节点 + 流光连线 + 流程切换） ============
// flows：可选流程模板列表；activeFlow：后端当前生效流程（auto=自动选取）；
// selected/onSelect：切换器受控状态（'' = 自动）。节点序列来自模板当前定义，改模板后轮询自动更新。
function FlowPanel({ flowNodes, flows, activeFlow, selected, onSelect }) {
  const nodes = flowNodes || []
  const flowsList = flows || []
  // 已保存的流程被删除时回退显示"自动"（与后端自动回退选取一致）
  const selectValue = flowsList.some((f) => String(f.id) === selected) ? selected : ''
  return (
    <Panel
      title="处置状态流转" subtitle="STATUS FLOW" icon={TimerReset} className="h-[280px]"
      bodyClassName="flex flex-col px-5 py-2.5"
      right={(
        <label className="flex cursor-pointer items-center gap-1.5" title="切换展示的流程模板；模板修改重新发布后大屏自动更新">
          <span className="text-[10px] uppercase tracking-[2px]" style={{ color: C.subText }}>FLOW</span>
          <select
            value={selectValue}
            onChange={(e) => onSelect(e.target.value)}
            className="max-w-[240px] cursor-pointer truncate rounded border px-2 py-1 text-[12px] outline-none transition focus:ring-1"
            style={{ borderColor: 'rgba(96,138,188,0.45)', color: C.text, background: 'rgba(16,34,52,0.9)' }}
          >
            <option value="">自动（工单最多的流程）</option>
            {flowsList.map((f) => (
              <option key={f.id} value={String(f.id)}>
                {f.name}{f.is_draft ? '（草稿）' : !f.enabled ? '（停用）' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    >
      {/* 当前生效流程名（自动模式下展示后端实际选取的流程） */}
      <div className="mb-2 flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: C.subText }}>
        <span className="h-1.5 w-1.5 rounded-full"
          style={{ background: activeFlow?.auto ? C.cyan : C.accent, boxShadow: `0 0 6px ${activeFlow?.auto ? C.cyan : C.accent}` }} />
        当前展示：{activeFlow?.name ? `${activeFlow.name}${activeFlow.auto ? '（自动选取）' : ''}` : '暂无流程模板，请先在工单配置中创建'}
      </div>
      {nodes.length <= 1 ? (
        <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: C.subText }}>
          {flowsList.length === 0 ? '暂无流程模板' : '该流程暂未定义处理节点'}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center">
          {nodes.map((n, i) => {
            const active = n.current > 0
            const finished = n.key === '_finished'
            const color = finished ? (n.current > 0 ? C.green : C.grayBlue) : active ? C.cyan : C.grayBlue
            return (
              <div key={n.key} className="flex min-w-0 flex-1 items-center">
                <div
                  title={`${n.name}${n.group ? ` · ${n.group}` : ''}`}
                  className={`flex min-w-0 flex-1 flex-col items-center rounded-md border px-2 py-2 transition-all duration-300 ${active ? 'node-glow' : ''}`}
                  style={{
                    maxWidth: 168,
                    borderColor: active ? `${C.cyan}99` : 'rgba(96,138,188,0.28)',
                    background: active
                      ? 'linear-gradient(160deg, rgba(69,184,205,0.22), rgba(14,26,38,0.65))'
                      : finished && n.current > 0
                        ? 'linear-gradient(160deg, rgba(65,208,140,0.14), rgba(14,26,38,0.6))'
                        : 'rgba(14,26,38,0.55)',
                  }}
                >
                  <div className="w-full truncate text-center text-[13px] font-medium" style={{ color: C.text }}>{n.name}</div>
                  {n.group && <div className="w-full truncate text-center text-[10px]" style={{ color: C.subText }}>{n.group}</div>}
                  <div className="font-mono text-[26px] font-bold leading-[1.2] tabular-nums" style={{ color, textShadow: active ? `0 0 10px ${C.cyan}55` : 'none' }}>
                    {n.current}
                  </div>
                  <div className="text-[10px]" style={{ color: C.subText }}>{finished ? '已关闭' : '当前停留'}</div>
                </div>
                {i < nodes.length - 1 && (
                  /* 节点连线：青蓝渐变轨道 + 流光 */
                  <div className="relative mx-1 h-[2px] min-w-[10px] flex-1 rounded" style={{ background: `linear-gradient(90deg, ${C.techBlue}55, ${C.cyan}55)` }}>
                    <div className="flow-beam absolute top-0 h-[2px] w-[36px] rounded"
                      style={{ background: `linear-gradient(90deg, transparent, ${C.paleBlue}, transparent)`, boxShadow: `0 0 6px ${C.cyan}88` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

// ============ ④ 中央-下：最新工单实时列表（新条目入场动画，超时红色置顶） ============
function LiveList({ latest }) {
  const prevIdsRef = useRef(null)
  const rows = useMemo(() => {
    const list = [...(latest || [])]
    // 超时工单红色高亮并置顶，其余按时间倒序
    list.sort((a, b) => (b.timeout - a.timeout) || (b.created_at || '').localeCompare(a.created_at || ''))
    return list.slice(0, 12)
  }, [latest])
  const newIds = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id))
    const fresh = prevIdsRef.current ? new Set([...ids].filter((id) => !prevIdsRef.current.has(id))) : new Set()
    prevIdsRef.current = ids
    return fresh
  }, [rows])
  const priorityColor = { critical: C.red, high: C.orange, medium: C.lightBlue, low: C.paleBlue }
  const statusColor = { processing: C.lightBlue, completed: C.green, cancelled: C.grayBlue }
  return (
    <Panel
      title="最新工单实时监控" subtitle="REALTIME LIST" icon={Activity} className="h-[496px]"
      right={<span className="flex items-center gap-1 text-[11px]" style={{ color: C.subText }}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: C.green, boxShadow: `0 0 6px ${C.green}` }} />实时更新
      </span>}
      bodyClassName="px-3 py-2"
    >
      {/* 表头 */}
      <div className="flex items-center px-2 pb-1.5 text-[11px]" style={{ color: C.subText }}>
        <span className="w-[72px] shrink-0">时间</span>
        <span className="w-[128px] shrink-0">工单编号</span>
        <span className="min-w-0 flex-1 truncate">工单标题</span>
        <span className="w-[48px] shrink-0 text-center">等级</span>
        <span className="w-[60px] shrink-0 text-center">状态</span>
        <span className="w-[92px] shrink-0 text-right">当前节点</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.length === 0 && (
          <div className="py-10 text-center text-[13px]" style={{ color: C.subText }}>暂无工单数据</div>
        )}
        {rows.map((r) => {
          const isNew = newIds.has(r.id)
          const time = r.created_at ? r.created_at.slice(11, 19) : '--'
          return (
            <div key={r.id}
              className={`flex items-center rounded border px-2 py-[7px] text-[12px] transition ${isNew ? 'row-enter' : ''}`}
              style={{
                borderColor: r.timeout ? 'rgba(255,77,79,0.55)' : 'rgba(96,138,188,0.18)',
                background: r.timeout ? 'rgba(255,77,79,0.10)' : 'rgba(18,34,52,0.45)',
              }}>
              <span className="w-[72px] shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>{time}</span>
              <span className="w-[128px] shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }} title={r.title}>
                {r.timeout && <span className="mr-1 inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
                  <AlertTriangle className="h-2.5 w-2.5" />超时
                </span>}
                {r.title}
              </span>
              <span className="w-[48px] shrink-0 text-center" style={{ color: priorityColor[r.priority] || C.subText }}>{r.priority_label}</span>
              <span className="w-[60px] shrink-0 text-center" style={{ color: statusColor[r.status] || C.subText }}>{r.status_label}</span>
              <span className="w-[92px] shrink-0 truncate text-right" style={{ color: C.subText }}>{r.current_node_name || '--'}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ============ ⑤ 右上：SLA 时效分析（按优先级 SLA 目标口径） ============
// 分钟 → 紧凑可读时长（如 30 分 / 4 时 / 1 天 4 时）
function fmtDur(m) {
  if (m === null || m === undefined) return '不限'
  if (m < 60) return `${m} 分`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h} 时 ${r} 分` : `${h} 时`
  }
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return h ? `${d} 天 ${h} 时` : `${d} 天`
}

const SLA_PRIORITY_ROWS = [
  ['critical', '紧急'],
  ['high', '高危'],
  ['medium', '中危'],
  ['low', '低危'],
]

function SlaPanel({ sla }) {
  const targets = sla?.targets || {}
  const gaugeOption = useMemo(() => ({
    ...CHART_BASE,
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 100,
      radius: '92%', center: ['50%', '62%'],
      progress: { show: true, width: 12, itemStyle: { color: C.cyan, shadowColor: `${C.cyan}80`, shadowBlur: 8 } },
      axisLine: { lineStyle: { width: 12, color: [[1, 'rgba(69,184,205,0.16)']] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, anchor: { show: false },
      title: { show: true, offsetCenter: [0, '34%'], color: C.subText, fontSize: 12 },
      detail: {
        valueAnimation: true, offsetCenter: [0, '-2%'], formatter: '{value}%', color: C.text,
        fontSize: 24, fontWeight: 'bold', fontFamily: 'monospace',
      },
      data: [{ value: sla?.on_time_rate ?? 0, name: 'SLA 按时完成达标率' }],
    }],
  }), [sla?.on_time_rate])
  const barOption = useMemo(() => ({
    ...CHART_BASE,
    grid: { left: 46, right: 34, top: 12, bottom: 24 },
    tooltip: { trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 12 } },
    xAxis: { type: 'value', name: '分钟', nameTextStyle: { color: C.subText, fontSize: 11 }, splitLine: { lineStyle: { color: C.split } }, ...axisStyle() },
    yAxis: {
      type: 'category',
      data: ['平均响应时长', '平均解决时长'],
      ...axisStyle({ fontSize: 12 }),
    },
    series: [{
      type: 'bar', barWidth: 12,
      itemStyle: { borderRadius: 2, color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [
        { offset: 0, color: C.techBlue }, { offset: 1, color: C.paleBlue }] } },
      label: { show: true, position: 'right', color: C.text, fontSize: 11, fontFamily: 'monospace', formatter: '{c} 分' },
      data: [sla?.avg_response_minutes ?? 0, sla?.avg_resolve_minutes ?? 0],
    }],
  }), [sla])
  return (
    <Panel title="SLA 时效分析" subtitle="SLA ANALYSIS" icon={TimerReset} className="h-[400px]" bodyClassName="flex flex-col px-3 py-1">
      <div className="flex h-[212px] shrink-0">
        <div className="flex-[1.1]">
          <ReactECharts option={gaugeOption} notMerge style={{ height: '100%' }} />
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1.5 px-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px]" style={{ color: C.subText }}>SLA 超时率</span>
            <span className="font-mono text-[24px] font-bold tabular-nums"
              style={{ color: (sla?.timeout_rate ?? 0) > 0 ? C.red : C.green }}>{sla?.timeout_rate ?? 0}%</span>
          </div>
          <div className="text-[11px]" style={{ color: C.subText }}>
            响应超时 {sla?.response_overdue_count ?? 0} 件 · 解决超时 {sla?.resolve_overdue_count ?? 0} 件
          </div>
          <div className="my-1 h-px" style={{ background: 'rgba(96,138,188,0.22)' }} />
          <div className="text-[11px] font-medium" style={{ color: C.cyan }}>SLA 目标（响应 / 解决）</div>
          {SLA_PRIORITY_ROWS.map(([key, label]) => {
            const t = targets[key] || {}
            return (
              <div key={key} className="flex items-center gap-2 text-[11px] leading-[15px]">
                <span className="w-[30px] shrink-0" style={{ color: C.text }}>{label}</span>
                <span className="min-w-0 flex-1 truncate font-mono" style={{ color: C.subText }}>
                  {fmtDur(t.response)} / {fmtDur(t.resolve)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="h-[168px] shrink-0">
        <ReactECharts option={barOption} notMerge style={{ height: '100%' }} />
      </div>
    </Panel>
  )
}

// ============ ⑥ 右下：来源平台统计（各平台 工单总量 / 今日新增 / 待处理 / 处理中 / 已解决） ============
// 列定义：字段 / 表头 / 列宽 / 数值颜色 / 表头 tooltip
// 口径与顶部 KPI 一致：待处理=进行中工单，处理中=今日有提交流转且仍在处理中
const PLATFORM_COLS = [
  ['total', '工单总量', 58, C.lightBlue, ''],
  ['today_new', '今日新增', 52, C.paleBlue, ''],
  ['pending', '待处理', 46, C.orange, '状态为处理中的工单'],
  ['processing_active', '处理中', 46, C.techBlue, '今日有提交流转且仍在处理中'],
  ['completed', '已解决', 46, C.green, ''],
]

// 数值千位分隔；null/undefined 显示 --
const fmtInt = (n) => (n === null || n === undefined ? '--' : (n || 0).toLocaleString('en-US'))

// 统计表：数值列右对齐等宽字体，零值置灰；平台较多时滚动
function PlatformStatsTable({ rows }) {
  const list = rows || []
  return (
    <div className="flex h-full flex-col">
      {/* 表头 */}
      <div className="flex shrink-0 items-center gap-2 px-2 pb-1.5 text-[11px]" style={{ color: C.subText }}>
        <span className="min-w-0 flex-1 truncate">来源平台</span>
        {PLATFORM_COLS.map(([key, label, w, , tip]) => (
          <span key={key} className="shrink-0 text-right" style={{ width: w }} title={tip || undefined}>{label}</span>
        ))}
      </div>
      {/* 数据行 */}
      <div className="platform-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-1">
        {list.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: C.subText }}>暂无数据</div>
        )}
        {list.map((r) => (
          <div key={r.name}
            className="flex shrink-0 items-center gap-2 rounded border px-2 py-[7px] text-[12px] transition"
            style={{ borderColor: 'rgba(96,138,188,0.18)', background: 'rgba(18,34,52,0.45)' }}>
            <span className="min-w-0 flex-1 truncate font-medium" style={{ color: C.text }} title={r.name}>{r.name}</span>
            {PLATFORM_COLS.map(([key, , w, color]) => {
              const v = r[key] ?? 0
              return (
                <span key={key} className="shrink-0 text-right font-mono tabular-nums"
                  style={{ width: w, color: v > 0 ? color : 'rgba(147,166,184,0.45)' }}>
                  {fmtInt(v)}
                </span>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function PlatformPanel({ rows }) {
  return (
    <Panel title="来源平台统计" subtitle="PLATFORM STATISTICS" icon={Layers} className="h-[376px]" bodyClassName="px-3 py-2">
      <PlatformStatsTable rows={rows} />
    </Panel>
  )
}

// ============ ⑦ 底部：最新工单跑马灯（每 8 秒滚动一条） ============
function MarqueeBar({ latest }) {
  const rows = latest || []
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (rows.length < 2) return undefined
    const t = setInterval(() => setIdx((i) => (i + 1) % rows.length), 8000)
    return () => clearInterval(t)
  }, [rows.length])
  if (rows.length === 0) {
    return (
      <div className="flex h-14 items-center justify-center rounded-md border text-[13px]"
        style={{ background: C.panelBg, borderColor: C.panelBorder, color: C.subText }}>
        暂无最新工单
      </div>
    )
  }
  const r = rows[idx % rows.length]
  return (
    <div className="flex h-14 items-center gap-4 overflow-hidden rounded-md border px-5"
      style={{ background: C.panelBg, borderColor: C.panelBorder, boxShadow: '0 0 14px rgba(80,130,190,0.12)' }}>
      <span className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium"
        style={{ background: 'rgba(69,184,205,0.18)', color: C.paleBlue, border: `1px solid ${C.cyan}55` }}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} />最新工单
      </span>
      <div key={r.id} className="marquee-enter flex min-w-0 flex-1 items-center gap-4 text-[14px]">
        <span className="shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>
          {r.created_at ? r.created_at.slice(0, 19).replace('T', ' ') : '--'}
        </span>
        <span className="shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
        <span className="min-w-0 flex-1 truncate font-medium" style={{ color: C.text }}>{r.title}</span>
        {r.timeout && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
            超时预警
          </span>
        )}
        <span className="shrink-0" style={{ color: r.priority === 'high' || r.priority === 'critical' ? C.orange : C.paleBlue }}>
          等级：{r.priority_label}
        </span>
        <span className="shrink-0" style={{ color: r.status === 'completed' ? C.green : C.lightBlue }}>状态：{r.status_label}</span>
        <span className="shrink-0 text-[12px]" style={{ color: C.subText }}>当前节点：{r.current_node_name || '--'}</span>
      </div>
    </div>
  )
}

// ============ 页面主体：1920×1080 基准 + 整屏缩放自适应 ============
export default function TicketMonitorScreen() {
  const [stats, setStats] = useState(null)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState(null)
  // 处置状态流转的流程选择：'' = 自动（进行中工单最多的流程），选择本地持久化
  const [flowId, setFlowId] = useState(() => {
    try { return window.localStorage.getItem('ticket_monitor_flow') || '' } catch { return '' }
  })

  const selectFlow = (v) => {
    setFlowId(v)
    try { window.localStorage.setItem('ticket_monitor_flow', v) } catch { /* 忽略存储异常 */ }
  }

  // 整屏自适应缩放：取宽/高缩放比最小值，居中留黑边
  useEffect(() => {
    const fit = () => {
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
      setScale(Number.isFinite(s) && s > 0 ? s : 1)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // 数据轮询：15s 全量刷新（聚合接口负载极小，保证大屏实时性）；
  // 切换流程时依赖变化触发立即重载，流程模板修改重新发布后也会在轮询中自动更新
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const data = await ticketApi.getMonitorStats(flowId || undefined)
        if (alive) { setStats(data); setError(null) }
      } catch (e) {
        if (alive) setError(String(e?.message || e))
      }
    }
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [flowId])

  // KPI：今日新增对比昨日（趋势 days30 末两个点）
  const yesterdayNew = stats?.trend?.days30?.length >= 2 ? stats.trend.days30[stats.trend.days30.length - 2]?.new : undefined
  const kpi = stats?.kpi
  const todayDelta = kpi && yesterdayNew !== undefined ? kpi.today_new - yesterdayNew : undefined

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden"
      style={{
        background: `radial-gradient(120% 90% at 50% 0%, #16222E 0%, ${C.deepNavy} 55%, #05090F 100%)`,
      }}>
      {/* 背景 1px 科技网格线 */}
      <div className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(rgba(78,109,148,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(78,109,148,0.10) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }} />
      <style>{`
        @keyframes flowBeam { 0% { left: -36px; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
        .flow-beam { animation: flowBeam 2.2s linear infinite; }
        @keyframes nodeGlow { 0%, 100% { box-shadow: 0 0 10px rgba(69,184,205,0.30); } 50% { box-shadow: 0 0 20px rgba(69,184,205,0.60); } }
        .node-glow { animation: nodeGlow 2.4s ease-in-out infinite; }
        @keyframes rowEnter { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        .row-enter { animation: rowEnter 0.5s ease-out; }
        @keyframes marqueeEnter { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
        .marquee-enter { animation: marqueeEnter 0.8s ease-out; }
        /* 来源平台统计表滚动条（细条深色，与大屏风格一致） */
        .platform-scroll::-webkit-scrollbar { width: 4px; }
        .platform-scroll::-webkit-scrollbar-thumb { background: rgba(96,138,188,0.35); border-radius: 2px; }
        .platform-scroll::-webkit-scrollbar-track { background: transparent; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .screen-fade { animation: fadeIn 0.6s ease-out; }
        /* 系统开启"减少动态效果"时关闭装饰动画 */
        @media (prefers-reduced-motion: reduce) {
          .flow-beam, .node-glow, .row-enter, .marquee-enter, .screen-fade { animation: none !important; }
        }
      `}</style>

      <div className="screen-fade absolute" style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: 'center' }}>
        {/* ① 顶部标题栏 */}
        <HeaderBar />

        {/* ① KPI 指标卡横排 */}
        <div className="mt-1 grid h-[96px] grid-cols-6 gap-3 px-4">
          <KpiCard label="工单总量" value={kpi?.total} tone="blue" />
          <KpiCard label="今日新增" value={kpi?.today_new} tone="blue" delta={todayDelta} />
          <KpiCard label="待处理" value={kpi?.pending} tone="orange" />
          <KpiCard label="处理中（今日活跃）" value={kpi?.processing_active} tone="blue" />
          <KpiCard label="已解决" value={kpi?.completed} tone="green" />
          <KpiCard label="超时预警" value={kpi?.timeout_warning} tone={(kpi?.timeout_warning ?? 0) > 0 ? 'red' : 'blue'} />
        </div>

        {/* 主体三栏 */}
        <div className="mt-3 flex h-[788px] gap-3 px-4">
          {/* 左栏 */}
          <div className="flex w-[470px] shrink-0 flex-col gap-3">
            {/* ② 工单趋势分析 */}
            <TrendChart trend={stats?.trend} />
            {/* ③ 事件类型与等级分布 */}
            <DistPanel dist={stats?.dist} severityStatus={stats?.severity_status} />
          </div>

          {/* 中央栏（视觉焦点） */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {/* ④ 处置状态流转图（支持流程切换，模板修改后自动更新） */}
            <FlowPanel
              flowNodes={stats?.flow_nodes}
              flows={stats?.flows}
              activeFlow={stats?.flow}
              selected={flowId}
              onSelect={selectFlow}
            />
            {/* ④ 最新工单实时列表 */}
            <LiveList latest={stats?.latest} />
          </div>

          {/* 右栏 */}
          <div className="flex w-[470px] shrink-0 flex-col gap-3">
            {/* ⑤ SLA 时效分析 */}
            <SlaPanel sla={stats?.sla} />
            {/* ⑥ 来源平台统计 */}
            <PlatformPanel rows={stats?.platform_stats} />
          </div>
        </div>

        {/* ⑦ 底部跑马灯 */}
        <div className="mt-3 h-14 px-4">
          <MarqueeBar latest={stats?.latest} />
        </div>
      </div>

      {/* 数据加载失败提示（未登录 / 接口异常） */}
      {error && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded border px-4 py-2 text-[12px]"
          style={{ background: 'rgba(255,77,79,0.12)', borderColor: 'rgba(255,77,79,0.4)', color: C.red }}>
          数据加载失败：{error}（大屏需在已登录会话中访问，15 秒后自动重试）
        </div>
      )}
    </div>
  )
}
