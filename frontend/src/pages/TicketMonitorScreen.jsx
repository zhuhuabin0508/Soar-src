// 网络安全工单监测平台 —— 政务风格监控大屏
//
// 设计基准 1920×1080，16:9 三栏布局，整屏 transform scale 自适应。
// 数据来源：GET /tickets/monitor 聚合接口（真实工单数据，排除归档），
// 页面 15s 轮询整体刷新，底部跑马灯每 8s 轮播一条告警（仅超时 / 紧急工单）。
// 提交团队排名按流程模板首节点「提交团队」字段聚合；接口接入前以演示样例渲染（带标记）。
//
// 七个分区（代码内以注释分隔）：
//   ① 顶部：标题栏 + 核心 KPI 总览（等宽数字；超时预警↔待处理橙红描边编组）
//   ② 左上：工单趋势分析（近 24 小时 / 7 天 / 30 天，新增 vs 关闭）
//   ③ 左下：事件类型与等级分布（类型 <10 件切横向条形、≥10 件环形；严重度×状态堆叠条形）
//   ④ 中央：处置状态流转图（虚线流动连线 + 节点下方停留件数）
//          + 提交团队工单排名（横排 Top 8，其余合并尾签）
//          + 最新工单实时列表
//   ⑤ 右上：SLA 时效分析（超时率主环阈值变色 + 底部达标率/响应/解决指标条）
//   ⑥ 右下：来源平台统计（状态构成堆叠条形图，柱端标注工单总量）
//   ⑦ 底部：告警播报跑马灯（仅超时 / 紧急工单，不与实时列表重复）
//   ⑧ 全屏交互：弹窗下钻体系（不跳转路由）——各统计区块点击压入弹窗栈逐级覆盖显示，
//      面包屑可回跳任意上级（ESC / 遮罩点击关闭当前层）：
//      团队排名条 → 全部团队数据 → 团队工单列表 → 工单详情（最多四级）；
//      KPI / 趋势 / 分布 / 流转节点 / SLA / 平台 / 实时列表均可点击下钻对应工单列表。
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { AlertTriangle, Activity, CheckCircle2, Clock, Layers, Timer, TimerReset, Trophy } from 'lucide-react'
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

// ============ 通用面板卡片（深蓝黑半透明底 + 微发光描边 + 橙色竖条标题 + L 型角标） ============
// L 型角标颜色语义统一：正常模块青色，含告警数据的模块橙红（alert 属性控制）
function Panel({ title, subtitle, icon: Icon, right, children, className = '', bodyClassName = '', alert = false, ...rest }) {
  const cornerColor = alert ? C.red : C.cyan
  const cornerGlow = alert ? 'rgba(255,77,79,0.6)' : 'rgba(69,184,205,0.6)'
  return (
    <div className={`relative flex flex-col rounded-md border backdrop-blur-md ${className}`}
      style={{ background: C.panelBg, borderColor: C.panelBorder, boxShadow: `0 0 14px rgba(80, 130, 190, 0.14), inset 0 0 24px rgba(8, 16, 26, 0.4)` }} {...rest}>
      {/* 玻璃顶缘高光：层叠质感 */}
      <div className="pointer-events-none absolute inset-x-3 top-0 z-10 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(168,200,236,0.4), transparent)' }} />
      {/* L 型角标（左上 / 右下）：青=正常模块，橙红=含告警数据 */}
      <span className="pointer-events-none absolute left-0 top-0 z-10 h-2.5 w-2.5 rounded-tl border-l-2 border-t-2"
        style={{ borderColor: cornerColor, filter: `drop-shadow(0 0 3px ${cornerGlow})` }} />
      <span className="pointer-events-none absolute bottom-0 right-0 z-10 h-2.5 w-2.5 rounded-br border-b-2 border-r-2"
        style={{ borderColor: cornerColor, filter: `drop-shadow(0 0 3px ${cornerGlow})` }} />
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

function HeaderBar({ demo }) {
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
      {/* 演示模式标记（全屏演示数据时显示；后端聚合接口接入后自动消失） */}
      {demo && (
        <span className="absolute left-6 top-2 z-10 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]"
          style={{ background: 'rgba(229,120,50,0.13)', color: C.accent, borderColor: 'rgba(229,120,50,0.45)' }}
          title="大屏当前以内置演示数据预览（各分区数字与下钻弹窗列表条数一致）；后端聚合接口接入「提交团队」统计与下钻工单集后自动切换真实数据">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}` }} />
          演示数据
        </span>
      )}
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

// ============ ① KPI 指标卡（等宽数字滚动 + 昨日对比箭头 + 编组描边 / 零值态） ============
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

// groupBorder：与关联卡片同色橙红描边做视觉编组（超时预警↔待处理）
// zeroNote：数值为 0 时灰色虚线描边 + 底部文案（避免"灰得像坏了"）
// note：底部小字补充口径（如"占待处理 X%"）
// onClick：点击卡片下钻对应口径的工单列表（弹窗，不跳转）
function KpiCard({ label, value, unit = '件', tone = 'blue', delta, deltaLabel = '较昨日', note, zeroNote, groupBorder, onClick }) {
  const toneColor = tone === 'red' ? C.red : tone === 'green' ? C.green : tone === 'orange' ? C.orange : C.lightBlue
  const animated = useCountUp(value)
  const zeroState = value === 0 && zeroNote
  const bottomNote = zeroState ? zeroNote : note
  return (
    <div
      onClick={onClick}
      title={onClick ? '点击下钻查看对应工单列表' : undefined}
      className={`relative flex flex-col justify-center rounded-md border px-4 py-2 transition-all duration-300 hover:brightness-110 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: 'linear-gradient(160deg, rgba(78,138,212,0.14), rgba(14,26,38,0.72))',
        borderColor: groupBorder ? 'rgba(255,77,79,0.60)' : zeroState ? 'rgba(147,166,184,0.45)' : 'rgba(96,138,188,0.35)',
        borderStyle: zeroState ? 'dashed' : 'solid',
        boxShadow: groupBorder ? '0 0 10px rgba(255,77,79,0.16)' : '0 0 10px rgba(80,130,190,0.10)',
      }}>
      <div className="text-[13px]" style={{ color: C.subText }}>{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[30px] font-bold leading-[1.15] tabular-nums"
          style={{ color: zeroState ? 'rgba(147,166,184,0.85)' : toneColor, textShadow: `0 0 10px ${toneColor}40` }}>
          {animated ?? '--'}
        </span>
        <span className="text-[11px]" style={{ color: C.subText }}>{unit}</span>
        {delta !== undefined && delta !== null && !zeroState && (
          <span className="ml-auto flex items-center gap-0.5 font-mono text-[11px] tabular-nums"
            style={{ color: delta > 0 ? C.green : delta < 0 ? C.orange : C.subText }}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}{Math.abs(delta)}
            <span style={{ color: C.subText }}>&nbsp;{deltaLabel}</span>
          </span>
        )}
      </div>
      {bottomNote && <div className="mt-0.5 truncate text-[11px]" style={{ color: C.subText }}>{bottomNote}</div>}
      <div className="absolute bottom-0 left-0 h-[2px] w-full rounded-b-md opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${zeroState ? 'rgba(147,166,184,0.6)' : toneColor}, transparent)` }} />
    </div>
  )
}

// ============ ② 左上：工单趋势（折线面积图，24h/7天/30天切换；点击数据点下钻该时段工单） ============
function TrendChart({ trend, onDrill }) {
  const [range, setRange] = useState('hours24')
  const tabs = [['hours24', '近24小时'], ['days7', '近7天'], ['days30', '近30天']]
  const rows = trend?.[range] || []
  // echarts-for-react 的 onEvents 仅在实例挂载时绑定一次，此处经 ref 读取最新的
  // 时间粒度与数据行，避免切换 Tab 后点击命中旧闭包（桶区间错位）
  const clickCtxRef = useRef({ range, rows })
  clickCtxRef.current = { range, rows }
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
  // 点击折线数据点下钻：按当前时间粒度还原该桶起止时间，筛选该时段新增/关闭工单
  const handleChartClick = (p) => {
    if (!onDrill || p?.componentType !== 'series') return
    const { range: cur, rows: curRows } = clickCtxRef.current
    const bucket = curRows[p.dataIndex]
    if (!bucket) return
    const now = new Date()
    const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0)
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
    let from
    let to
    if (cur === 'hours24') {
      const s = new Date(hourStart.getTime() - (23 - p.dataIndex) * 3600000)
      from = isoLocal(s)
      to = isoLocal(new Date(s.getTime() + 3600000))
    } else {
      const n = cur === 'days7' ? 7 : 30
      const s = new Date(dayStart.getTime() - (n - 1 - p.dataIndex) * 86400000)
      from = isoLocal(s)
      to = isoLocal(new Date(s.getTime() + 86400000))
    }
    const isNew = p.seriesName === '新增工单'
    onDrill({
      kind: 'tickets',
      title: `${bucket.label} ${isNew ? '新增' : '关闭'}工单`,
      subtitle: cur === 'hours24'
        ? `${from.slice(5, 16).replace('T', ' ')} ~ ${to.slice(11, 16)}`
        : `${from.slice(5, 10)} 当日`,
      filters: isNew ? { from, to } : { from, to, closedOnly: true },
    })
  }
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
      <ReactECharts option={option} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }}
        onEvents={{ click: handleChartClick }} />
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

// 类型分布自适应形态：总数 <10 件时环形图空洞失衡 → 切横向条形图（柱端直接标注数值+占比）。
// 与 pieOption 共用 BLUE_PALETTE 且同为数据顺序取色，两种形态切换时分类颜色语义保持一致。
function typeBarOption(rows) {
  const data = rows || []
  const total = data.reduce((s, d) => s + (d.value || 0), 0)
  const pct = (v) => (total > 0 ? Math.round((v / total) * 1000) / 10 : 0)
  return {
    ...CHART_BASE,
    grid: { left: 8, right: 80, top: 10, bottom: 10, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: C.tooltipBg, borderColor: C.panelBorder,
      textStyle: { color: C.text, fontSize: 12 },
      formatter: (ps) => {
        const p = ps?.[0]
        return p ? `${p.name}：${p.value} 件（${pct(p.value)}%）` : ''
      },
    },
    xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: C.split } }, ...axisStyle({ fontSize: 10 }) },
    yAxis: {
      type: 'category', inverse: true, data: data.map((d) => d.name),
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      axisLabel: { color: C.text, fontSize: 12, interval: 0, margin: 10 },
    },
    series: [{
      type: 'bar', barWidth: 14,
      data: data.map((d, i) => ({
        value: d.value || 0,
        itemStyle: { color: BLUE_PALETTE[i % BLUE_PALETTE.length], borderRadius: [0, 2, 2, 0] },
      })),
      label: {
        show: true, position: 'right', color: C.text, fontSize: 12, fontFamily: 'monospace',
        formatter: (p) => `${p.value} 件 · ${pct(p.value)}%`,
      },
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

function DistPanel({ dist, severityStatus, onDrill }) {
  const [tab, setTab] = useState('type')
  const [paused, setPaused] = useState(false)
  const sev = severityStatus || []
  // 类型分布自适应形态：总数 <10 件切横向条形图（小样本环形空洞失衡），≥10 件恢复环形图
  const typeRows = dist?.type || []
  const typeTotal = typeRows.reduce((s, d) => s + (d.value || 0), 0)
  const typeIsBar = typeTotal > 0 && typeTotal < 10

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

  // 类型图（环形 / 条形）点击分类下钻该类型工单
  const handleTypeClick = (p) => {
    if (!onDrill || p?.componentType !== 'series' || !p.name) return
    onDrill({ kind: 'tickets', title: `「${p.name}」类工单`, subtitle: '事件类型下钻', filters: { type: p.name } })
  }
  // 严重度堆叠图点击段下钻：段 = 严重度 × 状态
  const handleSevClick = (p) => {
    if (!onDrill || p?.componentType !== 'series') return
    const prio = { 紧急: 'critical', 高危: 'high', 中危: 'medium', 低危: 'low' }[p.name]
    const stat = { 进行中: 'processing', 已完成: 'completed', 已取消: 'cancelled' }[p.seriesName]
    if (!prio || !stat) return
    onDrill({ kind: 'tickets', title: `${p.name} · ${p.seriesName}工单`, subtitle: '严重度 × 状态下钻', filters: { priority: prio, status: stat } })
  }

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
        <ReactECharts key="sev" option={stackOption} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }}
          onEvents={{ click: handleSevClick }} />
      ) : (
        <ReactECharts key={typeIsBar ? 'type-bar' : 'type-pie'}
          option={typeIsBar ? typeBarOption(typeRows) : pieOption(typeRows)}
          notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }}
          onEvents={{ click: handleTypeClick }} />
      )}
    </Panel>
  )
}

// ============ ④ 中央-上：处置状态流转图（虚线流动连线 + 节点下方停留件数 + 流程切换） ============
// flows：可选流程模板列表；activeFlow：后端当前生效流程（auto=自动选取）；
// selected/onSelect：切换器受控状态（'' = 自动）。节点序列来自模板当前定义，改模板后轮询自动更新。
// onDrill：点击节点卡片下钻该节点停留工单（完成节点 → 已关闭工单）
function FlowPanel({ flowNodes, flows, activeFlow, selected, onSelect, onDrill }) {
  const nodes = flowNodes || []
  const flowsList = flows || []
  // 已保存的流程被删除时回退显示"自动"（与后端自动回退选取一致）
  const selectValue = flowsList.some((f) => String(f.id) === selected) ? selected : ''
  return (
    <Panel
      title="处置状态流转" subtitle="STATUS FLOW" icon={TimerReset} className="h-[240px]"
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
        // 上行：节点卡片 + 连线（连线与卡片中线对齐）；下行：卡片下方停留件数（两行同构布局保证对齐）
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-center">
            {nodes.map((n, i) => {
              const active = n.current > 0
              return (
                <div key={n.key} className="flex min-w-0 flex-1 items-center">
                  {/* 节点卡片：宽度上限收窄 + 连线加长，节点间距加大；点击下钻该节点停留工单 */}
                  <div className="flex min-w-0 flex-1 flex-col items-center" style={{ maxWidth: 150 }}>
                    <div
                      title={onDrill
                        ? `点击查看「${n.name}」${n.key === '_finished' ? '已关闭' : '停留'}工单列表`
                        : `${n.name}${n.group ? ` · ${n.group}` : ''}`}
                      onClick={onDrill ? () => onDrill({
                        kind: 'tickets',
                        title: `「${n.name}」${n.key === '_finished' ? '已关闭工单' : '节点停留工单'}`,
                        subtitle: '处置流转下钻',
                        // 后端节点计数限定当前展示流程（多流程节点 key 可能重名），下钻同步限定
                        filters: n.key === '_finished'
                          ? { closedAll: true, flowId: activeFlow?.id ?? null }
                          : { nodeKey: n.key, flowId: activeFlow?.id ?? null },
                      }) : undefined}
                      className={`flex min-w-0 w-full cursor-pointer flex-col items-center rounded-md border px-2 py-2 transition-all duration-300 hover:brightness-125 ${active ? 'node-glow' : ''}`}
                      style={{
                        borderColor: active ? `${C.cyan}99` : 'rgba(96,138,188,0.28)',
                        background: active
                          ? 'linear-gradient(160deg, rgba(69,184,205,0.22), rgba(14,26,38,0.65))'
                          : n.key === '_finished' && n.current > 0
                            ? 'linear-gradient(160deg, rgba(65,208,140,0.14), rgba(14,26,38,0.6))'
                            : 'rgba(14,26,38,0.55)',
                      }}
                    >
                      <div className="w-full truncate text-center text-[13px] font-medium" style={{ color: C.text }}>{n.name}</div>
                      {n.group && <div className="w-full truncate text-center text-[10px]" style={{ color: C.subText }}>{n.group}</div>}
                    </div>
                  </div>
                  {i < nodes.length - 1 && (
                    /* 节点连线：淡色轨道 + 沿流转方向（左→右）流动的虚线 */
                    <div className="relative mx-2.5 h-[2px] min-w-[28px] flex-1 rounded"
                      style={{ background: `linear-gradient(90deg, ${C.techBlue}26, ${C.cyan}26)` }}>
                      <div className="flow-dash absolute inset-0 rounded" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {/* 每个节点下方标注当前停留件数（数字变化时缩放弹跳一次；完成节点 ✓） */}
          <div className="mt-2 flex min-w-0">
            {nodes.map((n, i) => {
              const active = n.current > 0
              const finished = n.key === '_finished'
              const color = finished ? (n.current > 0 ? C.green : C.subText) : active ? C.cyan : C.subText
              return (
                <div key={n.key} className="flex min-w-0 flex-1">
                  <div className="flex min-w-0 flex-1 items-baseline justify-center gap-1" style={{ maxWidth: 150 }}>
                    <span key={`${n.key}-${n.current}`}
                      className="count-bounce inline-block font-mono text-[24px] font-bold leading-none tabular-nums"
                      style={{ color, textShadow: active ? `0 0 10px ${C.cyan}55` : 'none' }}>
                      {n.current}
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: C.subText }}>{finished ? '✓ 已关闭' : '当前停留'}</span>
                  </div>
                  {i < nodes.length - 1 && <div className="mx-2.5 min-w-[28px] flex-1" />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Panel>
  )
}

// ============ ④ 中央-中：提交团队工单排名（横排 Top 8 + 其余合并尾签 + 点击下钻） ============
// 统计口径：流程模板首节点（发起工单）「提交团队」下拉字段，按选项值聚合计数、降序排名。
// 模板选项共 13 个团队，全部横排则单卡过窄（3-5 米观看距离不可读），故取 Top 8 逐卡展示
// （前三名金银铜徽章 + 榜首卡金色描边/条），其余团队合并为尾签（悬停可看明细）。
// 下钻入口：团队卡 / 尾签 / 右上「查看全部」→ 全部团队数据 → 点击团队行 → 该团队工单列表。
const DEMO_TEAM_ROWS = [
  { name: '中心', value: 86 },
  { name: '运营团队', value: 64 },
  { name: '深信服', value: 45 },
  { name: '奇安信', value: 38 },
  { name: '360', value: 31 },
  { name: '石犀科技', value: 27 },
  { name: '安络', value: 22 },
  { name: '天融信', value: 18 },
  { name: '安恒', value: 14 },
  { name: '亚信', value: 11 },
  { name: '全知科技', value: 8 },
  { name: '四蜜团队', value: 5 },
  { name: '其他', value: 3 },
]

// 前三名排名徽章配色：金 / 银 / 铜；其余名次弱化为灰蓝数字（不抢焦点）
const RANK_META = [
  { color: '#F5C84F', bg: 'rgba(245,200,79,0.20)', border: 'rgba(245,200,79,0.65)' },
  { color: '#CBD6E6', bg: 'rgba(203,214,230,0.15)', border: 'rgba(203,214,230,0.55)' },
  { color: '#D89A66', bg: 'rgba(216,154,102,0.20)', border: 'rgba(216,154,102,0.65)' },
]

// 展示的领先团队数量；其余合并为尾签
const TEAM_RANK_TOP_N = 8

function TeamRankPanel({ rows, onDrill }) {
  const list = useMemo(
    () => [...(rows || [])].sort((a, b) => (b.value || 0) - (a.value || 0)),
    [rows],
  )
  const total = list.reduce((s, d) => s + (d.value || 0), 0)
  const max = list.length ? Math.max(...list.map((d) => d.value || 0)) : 0
  const top = list.slice(0, TEAM_RANK_TOP_N)
  const rest = list.slice(TEAM_RANK_TOP_N)
  const restTotal = rest.reduce((s, d) => s + (d.value || 0), 0)
  const pct = (v) => (total > 0 ? Math.round(((v || 0) / total) * 1000) / 10 : 0)
  return (
    <Panel
      title="提交团队工单排名" subtitle="TEAM RANKING" icon={Trophy}
      className="h-[128px]" bodyClassName="px-3 py-2"
      right={(
        <>
          <span className="text-[11px]" style={{ color: C.subText }}>{list.length} 队 · 共 {total} 件</span>
          {onDrill && (
            <button
              onClick={() => onDrill({ kind: 'teams', title: '提交团队 · 全部团队数据', subtitle: '全部团队工单排名' })}
              title="弹窗查看全部团队的排名明细（点击团队行可继续下钻其工单列表）"
              className="rounded px-2 py-0.5 text-[11px] transition hover:brightness-125"
              style={{ color: C.cyan, border: '1px solid rgba(69,184,205,0.4)', background: 'rgba(69,184,205,0.08)' }}>
              查看全部
            </button>
          )}
        </>
      )}
    >
      {top.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px]" style={{ color: C.subText }}>
          暂无提交团队数据
        </div>
      ) : (
        <div className="flex h-full items-stretch gap-2">
          {top.map((d, i) => {
            const meta = RANK_META[i]
            const champion = i === 0
            // 条长相对榜首（100%），过低值给 6% 下限保证可见
            const barW = max > 0 ? Math.max(6, Math.round(((d.value || 0) / max) * 100)) : 0
            return (
              <div key={d.name} title={`${d.name}：${d.value} 件（${pct(d.value)}%）${onDrill ? '，点击查看该团队工单列表' : ''}`}
                onClick={onDrill ? () => onDrill({
                  kind: 'tickets',
                  title: `${d.name} · 提交工单列表`,
                  subtitle: '团队排名下钻',
                  filters: { team: d.name },
                }) : undefined}
                className="relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded border px-1.5 py-1.5 transition hover:brightness-125"
                style={{
                  borderColor: champion ? 'rgba(245,200,79,0.5)' : 'rgba(96,138,188,0.2)',
                  background: champion
                    ? 'linear-gradient(165deg, rgba(245,200,79,0.10), rgba(14,26,38,0.65))'
                    : 'rgba(18,34,52,0.45)',
                }}>
                <div className="flex min-w-0 items-center gap-1.5">
                  {meta ? (
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-bold"
                      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>
                      {i + 1}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: C.subText }}>{i + 1}</span>
                  )}
                  <span className="max-w-full truncate text-[12px]" style={{ color: C.text }}>{d.name}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-[17px] font-bold leading-none tabular-nums"
                    style={{
                      color: champion ? '#F5C84F' : C.lightBlue,
                      textShadow: champion ? '0 0 8px rgba(245,200,79,0.35)' : 'none',
                    }}>
                    {d.value}
                  </span>
                  <span className="text-[10px] tabular-nums" style={{ color: C.subText }}>{pct(d.value)}%</span>
                </div>
                {/* 相对条长：以榜首为基准；榜首金色渐变，其余蓝青渐变 */}
                <div className="h-[3px] w-full overflow-hidden rounded" style={{ background: 'rgba(96,138,188,0.16)' }}>
                  <div className="h-full rounded transition-all"
                    style={{
                      width: `${barW}%`,
                      background: champion
                        ? 'linear-gradient(90deg, #B98A2E, #F5C84F)'
                        : `linear-gradient(90deg, ${C.techBlue}, ${C.cyan})`,
                      boxShadow: champion ? '0 0 6px rgba(245,200,79,0.5)' : 'none',
                    }} />
                </div>
              </div>
            )
          })}
          {rest.length > 0 && (
            <div title={onDrill ? '点击查看全部团队排名明细' : rest.map((d) => `${d.name} ${d.value} 件`).join(' / ')}
              onClick={onDrill ? () => onDrill({ kind: 'teams', title: '提交团队 · 全部团队数据', subtitle: '全部团队工单排名' }) : undefined}
              className="flex w-[76px] shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded border border-dashed px-1 transition hover:brightness-125"
              style={{ borderColor: 'rgba(147,166,184,0.4)', background: 'rgba(18,34,52,0.3)' }}>
              <span className="text-[11px]" style={{ color: C.subText }}>其余 {rest.length} 队</span>
              <span className="font-mono text-[14px] font-bold tabular-nums" style={{ color: C.subText }}>{restTotal} 件</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

// ============ ④ 中央-下：最新工单实时列表（48px 行高 / 新行 2s 青色渐隐高亮 / 等级 pill / 超时置顶） ============
// 等级 pill 配色：紧急=红、高=橙、中=蓝、低=灰；紧急另加「!」做色彩之外的告警编码（色盲无障碍）
const PRIORITY_PILL = {
  critical: { bg: 'rgba(255,77,79,0.16)', color: C.red, border: 'rgba(255,77,79,0.5)' },
  high: { bg: 'rgba(255,169,64,0.13)', color: C.orange, border: 'rgba(255,169,64,0.42)' },
  medium: { bg: 'rgba(78,138,212,0.15)', color: C.lightBlue, border: 'rgba(78,138,212,0.42)' },
  low: { bg: 'rgba(147,166,184,0.14)', color: C.subText, border: 'rgba(147,166,184,0.35)' },
}

function LiveList({ latest, onDrill }) {
  const prevIdsRef = useRef(null)
  const rows = useMemo(() => {
    const list = [...(latest || [])]
    // 超时工单红色高亮并置顶，其余按时间倒序
    list.sort((a, b) => (b.timeout - a.timeout) || (b.created_at || '').localeCompare(a.created_at || ''))
    // 行高增至 48px（适配 3-5 米远距离观看）；中央栏加入团队排名条后可视行数调整为 6 行
    return list.slice(0, 6)
  }, [latest])
  const newIds = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id))
    const fresh = prevIdsRef.current ? new Set([...ids].filter((id) => !prevIdsRef.current.has(id))) : new Set()
    prevIdsRef.current = ids
    return fresh
  }, [rows])
  const statusColor = { processing: C.lightBlue, completed: C.green, cancelled: C.subText }
  return (
    <Panel
      title="最新工单实时监控" subtitle="REALTIME LIST" icon={Activity} className="h-[396px]"
      alert={(latest || []).some((r) => r.timeout)}
      right={<span className="flex items-center gap-1 text-[11px]" style={{ color: C.subText }}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: C.green, boxShadow: `0 0 6px ${C.green}` }} />实时更新
      </span>}
      bodyClassName="px-3 py-2"
    >
      {/* 表头（字号 +2px） */}
      <div className="flex items-center px-2 pb-1.5 text-[13px]" style={{ color: C.subText }}>
        <span className="w-[72px] shrink-0">时间</span>
        <span className="w-[128px] shrink-0">工单编号</span>
        <span className="min-w-0 flex-1 truncate">工单标题</span>
        <span className="w-[56px] shrink-0 text-center">等级</span>
        <span className="w-[64px] shrink-0 text-center">状态</span>
        <span className="w-[92px] shrink-0 text-right">当前节点</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.length === 0 && (
          <div className="py-10 text-center text-[13px]" style={{ color: C.subText }}>暂无工单数据</div>
        )}
        {rows.map((r) => {
          const isNew = newIds.has(r.id)
          const time = r.created_at ? r.created_at.slice(11, 19) : '--'
          const pill = PRIORITY_PILL[r.priority] || PRIORITY_PILL.low
          return (
            <div key={r.id}
              onClick={onDrill ? () => onDrill({
                kind: 'detail', ticket: r,
                title: `工单详情 · ${r.ticket_no}`, subtitle: '实时列表下钻',
              }) : undefined}
              title={onDrill ? '点击查看工单详情' : undefined}
              className={`relative flex min-h-[48px] cursor-pointer items-center rounded border px-2 py-2 text-[14px] transition hover:brightness-125 ${isNew ? 'row-enter' : ''}`}
              style={{
                borderColor: r.timeout ? 'rgba(255,77,79,0.55)' : 'rgba(96,138,188,0.18)',
                background: r.timeout ? 'rgba(255,77,79,0.10)' : 'rgba(18,34,52,0.45)',
              }}>
              {/* 新工单插入：2 秒青色渐隐高亮（覆盖层不与行背景冲突） */}
              {isNew && <span className="row-flash pointer-events-none absolute inset-0 rounded" />}
              <span className="w-[72px] shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>{time}</span>
              <span className="w-[128px] shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }} title={r.title}>
                {r.timeout && <span className="mr-1 inline-flex items-center gap-0.5 rounded px-1 py-px text-[11px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
                  <AlertTriangle className="h-3 w-3" />超时
                </span>}
                {r.title}
              </span>
              <span className="w-[56px] shrink-0 text-center">
                <span className="inline-flex items-center rounded-full border px-2 py-px text-[12px]"
                  style={{ background: pill.bg, color: pill.color, borderColor: pill.border }}>
                  {r.priority === 'critical' ? '! ' : ''}{r.priority_label}
                </span>
              </span>
              <span className="w-[64px] shrink-0 text-center" style={{ color: statusColor[r.status] || C.subText }}>
                {r.status === 'completed' ? '✓ ' : ''}{r.status_label}
              </span>
              <span className="w-[92px] shrink-0 truncate text-right" style={{ color: C.subText }}>{r.current_node_name || '--'}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ============ ⑤ 右上：SLA 时效分析（超时率主环 + 底部指标条，按优先级 SLA 目标口径） ============
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

// 主环配色：超时率 ≤30% 青绿（良好）/ 30%-60% 橙（关注）/ >60% 红（告警），带轻微外发光
function slaRingColor(rate) {
  if (rate <= 30) return C.green
  if (rate <= 60) return C.orange
  return C.red
}

// 底部小型指标条：图标 + 指标名 + 数值
function SlaMetric({ icon: Icon, name, value, color }) {
  return (
    <div className="flex flex-col justify-center rounded-md border px-3"
      style={{ borderColor: 'rgba(96,138,188,0.28)', background: 'rgba(18,34,52,0.45)' }}>
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="truncate text-[11px]" style={{ color: C.subText }}>{name}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[17px] font-bold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}

function SlaPanel({ sla, onDrill }) {
  const targets = sla?.targets || {}
  const timeoutRate = sla?.timeout_rate ?? 0
  const ringColor = slaRingColor(timeoutRate)
  // 主环：只保留一个核心指标（SLA 超时率），环中央大号百分比，阈值变色
  const gaugeOption = useMemo(() => ({
    ...CHART_BASE,
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 100,
      radius: '94%', center: ['50%', '56%'],
      progress: { show: true, width: 13, itemStyle: { color: ringColor, shadowColor: `${ringColor}90`, shadowBlur: 10 } },
      axisLine: { lineStyle: { width: 13, color: [[1, 'rgba(96,138,188,0.16)']] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, anchor: { show: false },
      title: { show: true, offsetCenter: [0, '42%'], color: C.subText, fontSize: 12 },
      detail: {
        valueAnimation: true, offsetCenter: [0, '-6%'], formatter: '{value}%',
        color: ringColor, fontSize: 34, fontWeight: 'bold', fontFamily: 'monospace',
      },
      data: [{ value: timeoutRate, name: 'SLA 超时率' }],
    }],
  }), [timeoutRate, ringColor])
  const fmtAvg = (m) => (m === null || m === undefined ? '—' : fmtDur(m))
  return (
    <Panel title="SLA 时效分析" subtitle="SLA ANALYSIS" icon={TimerReset} alert={timeoutRate > 0}
      className="h-[400px]" bodyClassName="flex flex-col px-3 py-1">
      <div className="flex h-[212px] shrink-0">
        <div className="flex-[1.15] cursor-pointer" title={onDrill ? '点击下钻查看 SLA 超时工单列表' : undefined}>
          <ReactECharts option={gaugeOption} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }}
            onEvents={onDrill ? { click: () => onDrill({ kind: 'tickets', title: 'SLA 超时工单列表', subtitle: '超时率下钻 · 含已完结超时', filters: { slaTimeout: true } }) } : undefined} />
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1.5 px-2">
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
      {/* 按时完成达标率 / 平均响应时长 / 平均解决时长：降级为底部并排小型指标条（图标 + 指标名 + 数值） */}
      <div className="mt-1.5 grid h-[96px] shrink-0 grid-cols-3 gap-2">
        <SlaMetric icon={CheckCircle2} name="按时完成达标率"
          value={sla?.on_time_rate == null ? '—' : `${sla.on_time_rate}%`} color={C.green} />
        <SlaMetric icon={Timer} name="平均响应时长" value={fmtAvg(sla?.avg_response_minutes)} color={C.lightBlue} />
        <SlaMetric icon={Clock} name="平均解决时长" value={fmtAvg(sla?.avg_resolve_minutes)} color={C.paleBlue} />
      </div>
    </Panel>
  )
}

// ============ ⑥ 右下：来源平台统计（状态构成堆叠条形图，柱端直接标注工单总量） ============
// 颜色语义与全屏一致：待处理=橙、处理中=蓝、已解决=绿；口径与顶部 KPI 相同。
// 悬停提示框保留原统计表全部指标（总量/今日新增/待处理/处理中/已解决）。
// 提示框指标元数据：字段 / 名称 / 数值颜色
const PLATFORM_TIP_COLS = [
  ['total', '工单总量', C.lightBlue],
  ['today_new', '今日新增', C.paleBlue],
  ['pending', '待处理', C.orange],
  ['processing_active', '处理中', C.techBlue],
  ['completed', '已解决', C.green],
]

// 数值千位分隔；null/undefined 显示 --
const fmtInt = (n) => (n === null || n === undefined ? '--' : (n || 0).toLocaleString('en-US'))

function platformBarOption(rows) {
  const list = rows || []
  const names = list.map((r) => r.name)
  const totals = list.map((r) => r.total ?? 0)
  const stack = (name, key, color) => ({
    name, type: 'bar', stack: 'total', barWidth: 14,
    itemStyle: { color },
    data: list.map((r) => r[key] ?? 0),
  })
  const series = [
    stack('待处理', 'pending', C.orange),
    stack('处理中', 'processing_active', C.techBlue),
    stack('已解决', 'completed', C.green),
  ]
  // 柱端总量标注挂在堆叠末段（取整行 total），消除视线在坐标轴与柱体之间的往返
  series[series.length - 1].label = {
    show: true, position: 'right', color: C.text, fontSize: 12,
    fontFamily: 'monospace', fontWeight: 'bold',
    formatter: (p) => `${fmtInt(totals[p.dataIndex])} 件`,
  }
  return {
    ...CHART_BASE,
    grid: { left: 8, right: 60, top: 30, bottom: 6, containLabel: true },
    legend: {
      data: series.map((s) => s.name), top: 0, right: 8, itemWidth: 12, itemHeight: 8,
      textStyle: { color: C.subText, fontSize: 11 },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 12 },
      formatter: (ps) => {
        const r = list[ps?.[0]?.dataIndex]
        if (!r) return ''
        const lines = PLATFORM_TIP_COLS.map(([key, label, color]) =>
          `${label}：<b style="color:${color}">${fmtInt(r[key])}</b>`)
        return `<div style="font-weight:600;margin-bottom:4px;">${r.name}</div>${lines.join('<br/>')}`
      },
    },
    xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: C.split } }, ...axisStyle({ fontSize: 10 }) },
    yAxis: {
      type: 'category', inverse: true, data: names,
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      axisLabel: { color: C.text, fontSize: 12, interval: 0, margin: 10 },
    },
    series,
  }
}

function PlatformPanel({ rows, onDrill }) {
  const list = rows || []
  // 点击堆叠段下钻：平台 × 状态构成（待处理/处理中→进行中，已解决→已完成）
  const handleBarClick = (p) => {
    if (!onDrill || p?.componentType !== 'series' || !p.name) return
    let f
    let seg
    if (p.seriesName === '已解决') {
      f = { platform: p.name, status: 'completed' }
      seg = '已解决'
    } else if (p.seriesName === '处理中') {
      f = { platform: p.name, status: 'processing', activeToday: true }
      seg = '处理中（今日活跃）'
    } else {
      f = { platform: p.name, status: 'processing' }
      seg = '待处理'
    }
    onDrill({ kind: 'tickets', title: `「${p.name}」· ${seg}工单`, subtitle: '来源平台下钻', filters: f })
  }
  return (
    <Panel title="来源平台统计" subtitle="PLATFORM STATISTICS" icon={Layers} className="h-[376px]" bodyClassName="px-3 py-2">
      {list.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px]" style={{ color: C.subText }}>暂无数据</div>
      ) : (
        <ReactECharts option={platformBarOption(list)} notMerge style={{ height: '100%' }} opts={{ renderer: 'canvas' }}
          onEvents={{ click: handleBarClick }} />
      )}
    </Panel>
  )
}

// ============ ⑦ 底部：告警播报跑马灯（仅超时 / 紧急工单，每 8 秒轮播一条） ============
// 只播报警示类信息，普通新增工单由实时列表展示，避免信息重复
function MarqueeBar({ latest }) {
  const rows = (latest || []).filter((r) => r.timeout || r.priority === 'critical')
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (rows.length < 2) return undefined
    const t = setInterval(() => setIdx((i) => (i + 1) % rows.length), 8000)
    return () => clearInterval(t)
  }, [rows.length])
  if (rows.length === 0) {
    return (
      <div className="flex h-14 items-center justify-center gap-2 rounded-md border text-[13px]"
        style={{ background: C.panelBg, borderColor: C.panelBorder, color: C.subText }}>
        <CheckCircle2 className="h-4 w-4" style={{ color: C.green }} />
        暂无超时 / 紧急告警工单
      </div>
    )
  }
  const r = rows[idx % rows.length]
  return (
    <div className="flex h-14 items-center gap-4 overflow-hidden rounded-md border px-5"
      style={{ background: C.panelBg, borderColor: 'rgba(255,77,79,0.35)', boxShadow: '0 0 14px rgba(255,77,79,0.10)' }}>
      <span className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium"
        style={{ background: 'rgba(255,77,79,0.16)', color: C.red, border: `1px solid ${C.red}66` }}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: C.red, boxShadow: `0 0 6px ${C.red}` }} />! 告警播报
      </span>
      <div key={r.id} className="marquee-enter flex min-w-0 flex-1 items-center gap-4 text-[14px]">
        <span className="shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>
          {r.created_at ? r.created_at.slice(0, 19).replace('T', ' ') : '--'}
        </span>
        <span className="shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
        <span className="min-w-0 flex-1 truncate font-medium" style={{ color: C.text }}>{r.title}</span>
        {r.timeout && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
            ! 超时预警
          </span>
        )}
        <span className="shrink-0" style={{ color: r.priority === 'critical' ? C.red : C.orange }}>
          等级：{r.priority === 'critical' ? '! ' : ''}{r.priority_label}
        </span>
        <span className="shrink-0" style={{ color: r.status === 'completed' ? C.green : C.lightBlue }}>
          状态：{r.status === 'completed' ? '✓ ' : ''}{r.status_label}
        </span>
        <span className="shrink-0 text-[12px]" style={{ color: C.subText }}>当前节点：{r.current_node_name || '--'}</span>
      </div>
    </div>
  )
}

// ============ ⑧ 弹窗下钻体系（大屏内多级弹窗，不跳转路由） ============
// 交互模型：各统计区块点击 → openDrill(view) 压入弹窗栈逐级覆盖显示；面包屑回跳任意上级，
// × / ESC / 遮罩点击关闭当前层。弹窗内表格行可继续下钻（最深可达四级）。
// 视图配置 view：{ kind: 'teams' | 'tickets' | 'detail', title, subtitle?, filters?, ticket? }
// filters 字段口径与大屏各分区一致（详见 matchDrill），工单数据源由页面主体统一注入
// （演示阶段为内置演示工单集，后端接入后为聚合接口返回的 tickets）。

// 状态展示色（弹窗表格与实时列表同语义）
const STATUS_COLOR = { processing: C.lightBlue, completed: C.green, cancelled: C.subText }

// 下钻筛选谓词：filters → 工单匹配条件（全部可选，字段口径与各面板统计一致）
// team=提交团队 / platform=来源平台 / type=告警类型 / status=工单状态 / priority=等级 /
// activeToday=处理中且今日活跃（KPI「处理中（今日活跃）」口径）/
// timeoutOnly=超时预警（进行中且超 SLA，KPI 口径）/ slaTimeout=SLA 超时工单（不限状态，
// 超时率分子口径，含已完结超时）/ nodeKey+flowId=流转节点停留（多流程节点 key 可能重名，
// 按当前展示流程限定）/ closedAll+flowId=已关闭（closed_at 口径，与流转图已完结计数一致）/
// from,to=创建时间范围（ISO 本地字符串，闭开区间）/ closedOnly+from,to=关闭时间范围（趋势图「关闭工单」）
function matchDrill(t, f = {}) {
  if (f.flowId != null && t.flow_id !== f.flowId) return false
  if (f.team && t.team !== f.team) return false
  if (f.platform && t.platform !== f.platform) return false
  if (f.type && t.alert_type !== f.type) return false
  if (f.status && t.status !== f.status) return false
  if (f.priority && t.priority !== f.priority) return false
  if (f.activeToday && !t.active_today) return false
  if (f.timeoutOnly && !(t.timeout && t.status === 'processing')) return false
  if (f.slaTimeout && !t.timeout) return false
  if (f.nodeKey && (t.status !== 'processing' || t.current_node_key !== f.nodeKey)) return false
  if (f.closedAll && !t.closed_at) return false
  if (f.closedOnly) {
    if (!t.closed_at) return false
    if (f.from && t.closed_at < f.from) return false
    if (f.to && t.closed_at >= f.to) return false
    return true
  }
  if (f.from && (!t.created_at || t.created_at < f.from)) return false
  if (f.to && (!t.created_at || t.created_at >= f.to)) return false
  return true
}

// 弹窗表格通用分页器（工单列表 10 件/页，团队列表 12 队/页）
function Pager({ total, page, size, unit = '件', onChange }) {
  const pages = Math.max(1, Math.ceil(total / size))
  const safe = Math.min(page, pages)
  const btnStyle = (disabled) => ({
    borderColor: 'rgba(96,138,188,0.35)',
    color: disabled ? 'rgba(147,166,184,0.5)' : C.text,
    cursor: disabled ? 'not-allowed' : 'pointer',
  })
  return (
    <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[12px]"
      style={{ borderColor: 'rgba(96,138,188,0.22)', color: C.subText }}>
      <span>共 <b className="font-mono tabular-nums" style={{ color: C.text }}>{total}</b> {unit}{pages > 1 ? ` · ${size} ${unit}/页` : ''}</span>
      {pages > 1 && (
        <span className="flex items-center gap-2">
          <span>第 <b className="font-mono tabular-nums" style={{ color: C.text }}>{safe}</b> / {pages} 页</span>
          <button disabled={safe <= 1} onClick={() => onChange(safe - 1)} className="rounded border px-2.5 py-0.5 transition enabled:hover:brightness-125" style={btnStyle(safe <= 1)}>上一页</button>
          <button disabled={safe >= pages} onClick={() => onChange(safe + 1)} className="rounded border px-2.5 py-0.5 transition enabled:hover:brightness-125" style={btnStyle(safe >= pages)}>下一页</button>
        </span>
      )}
    </div>
  )
}

// 工单列表（下钻二级/三级通用）：列宽与实时列表对齐，行点击继续下钻工单详情
function TicketTable({ rows, onRowClick }) {
  const [page, setPage] = useState(1)
  const size = 10
  useEffect(() => { setPage(1) }, [rows])
  const view = useMemo(() => rows.slice((Math.min(page, Math.max(1, Math.ceil(rows.length / size))) - 1) * size, Math.min(page, Math.max(1, Math.ceil(rows.length / size))) * size), [rows, page, size])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 列头 */}
      <div className="flex shrink-0 items-center px-3 pb-1.5 text-[12px]" style={{ color: C.subText }}>
        <span className="w-[128px] shrink-0">创建时间</span>
        <span className="w-[150px] shrink-0">工单编号</span>
        <span className="min-w-0 flex-1 truncate">工单标题</span>
        <span className="w-[96px] shrink-0 text-center">提交团队</span>
        <span className="w-[118px] shrink-0 truncate">来源平台</span>
        <span className="w-[60px] shrink-0 text-center">等级</span>
        <span className="w-[68px] shrink-0 text-center">状态</span>
        <span className="w-[100px] shrink-0 truncate text-right">当前节点</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-1">
        {view.length === 0 && (
          <div className="py-10 text-center text-[13px]" style={{ color: C.subText }}>暂无符合条件的工单</div>
        )}
        {view.map((r) => {
          const pill = PRIORITY_PILL[r.priority] || PRIORITY_PILL.low
          return (
            <div key={r.id} onClick={onRowClick ? () => onRowClick(r) : undefined}
              title={onRowClick ? '点击查看工单详情' : undefined}
              className="flex min-h-[42px] cursor-pointer items-center rounded border px-2 text-[13px] transition hover:brightness-125"
              style={{
                borderColor: r.timeout ? 'rgba(255,77,79,0.5)' : 'rgba(96,138,188,0.18)',
                background: r.timeout ? 'rgba(255,77,79,0.08)' : 'rgba(18,34,52,0.45)',
              }}>
              <span className="w-[128px] shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>
                {r.created_at ? r.created_at.slice(5, 16).replace('T', ' ') : '--'}
              </span>
              <span className="w-[150px] shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }}>
                {r.timeout && (
                  <span className="mr-1 rounded px-1 py-px text-[11px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>超时</span>
                )}
                {r.title}
              </span>
              <span className="w-[96px] shrink-0 truncate text-center" style={{ color: C.paleBlue }}>{r.team || '--'}</span>
              <span className="w-[118px] shrink-0 truncate" style={{ color: C.subText }}>{r.platform || '--'}</span>
              <span className="w-[60px] shrink-0 text-center">
                <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[11px]"
                  style={{ background: pill.bg, color: pill.color, borderColor: pill.border }}>
                  {r.priority === 'critical' ? '! ' : ''}{r.priority_label || '--'}
                </span>
              </span>
              <span className="w-[68px] shrink-0 text-center" style={{ color: STATUS_COLOR[r.status] || C.subText }}>
                {r.status === 'completed' ? '✓ ' : ''}{r.status_label || '--'}
              </span>
              <span className="w-[100px] shrink-0 truncate text-right" style={{ color: C.subText }}>{r.current_node_name || '--'}</span>
            </div>
          )
        })}
      </div>
      <Pager total={rows.length} page={page} size={size} onChange={setPage} />
    </div>
  )
}

// 全部团队数据（团队排名下钻二级）：排名徽章 + 团队名 + 提交量 + 占比 + 分布条；行点击下钻该团队工单
function TeamTable({ teams, onTeamClick }) {
  const [page, setPage] = useState(1)
  const size = 12
  const total = teams.reduce((s, d) => s + (d.value || 0), 0)
  const max = teams.length ? Math.max(...teams.map((d) => d.value || 0)) : 0
  const pct = (v) => (total > 0 ? Math.round(((v || 0) / total) * 1000) / 10 : 0)
  const pages = Math.max(1, Math.ceil(teams.length / size))
  const safe = Math.min(page, pages)
  const view = teams.slice((safe - 1) * size, safe * size)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 列头 */}
      <div className="flex shrink-0 items-center px-3 pb-1.5 text-[12px]" style={{ color: C.subText }}>
        <span className="w-[64px] shrink-0 text-center">排名</span>
        <span className="min-w-0 flex-1">团队名称</span>
        <span className="w-[96px] shrink-0 text-right">提交工单量</span>
        <span className="w-[70px] shrink-0 text-right">占比</span>
        <span className="w-[220px] shrink-0 text-right">工单量分布</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-1">
        {view.length === 0 && (
          <div className="py-10 text-center text-[13px]" style={{ color: C.subText }}>暂无提交团队数据</div>
        )}
        {view.map((d, i) => {
          const rank = (safe - 1) * size + i + 1
          const meta = RANK_META[rank - 1]
          const champion = rank === 1
          return (
            <div key={d.name} onClick={onTeamClick ? () => onTeamClick(d) : undefined}
              title={onTeamClick ? `点击查看「${d.name}」提交的工单列表` : undefined}
              className="flex min-h-[42px] cursor-pointer items-center rounded border px-2 text-[13px] transition hover:brightness-125"
              style={{
                borderColor: champion ? 'rgba(245,200,79,0.45)' : 'rgba(96,138,188,0.18)',
                background: champion ? 'rgba(245,200,79,0.06)' : 'rgba(18,34,52,0.45)',
              }}>
              <span className="w-[64px] shrink-0 text-center">
                {meta ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[11px] font-bold"
                    style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>{rank}</span>
                ) : (
                  <span className="font-mono text-[12px] tabular-nums" style={{ color: C.subText }}>{rank}</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }}>{d.name}</span>
              <span className="w-[96px] shrink-0 text-right font-mono text-[15px] font-bold tabular-nums"
                style={{ color: champion ? '#F5C84F' : C.lightBlue }}>{d.value}</span>
              <span className="w-[70px] shrink-0 text-right font-mono tabular-nums" style={{ color: C.subText }}>{pct(d.value)}%</span>
              <span className="flex w-[220px] shrink-0 items-center justify-end">
                <span className="block h-[5px] w-full overflow-hidden rounded" style={{ background: 'rgba(96,138,188,0.16)' }}>
                  <span className="block h-full rounded"
                    style={{
                      width: `${max > 0 ? Math.max(4, Math.round(((d.value || 0) / max) * 100)) : 0}%`,
                      background: champion
                        ? 'linear-gradient(90deg, #B98A2E, #F5C84F)'
                        : `linear-gradient(90deg, ${C.techBlue}, ${C.cyan})`,
                      boxShadow: champion ? '0 0 6px rgba(245,200,79,0.45)' : 'none',
                    }} />
                </span>
              </span>
            </div>
          )
        })}
      </div>
      {/* 合计行 + 分页 */}
      <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[12px]"
        style={{ borderColor: 'rgba(96,138,188,0.22)', color: C.subText }}>
        <span>合计 <b className="font-mono tabular-nums" style={{ color: C.text }}>{teams.length}</b> 队 ·
          提交 <b className="font-mono tabular-nums" style={{ color: C.text }}>{total}</b> 件 · 占比 100%</span>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <span>第 <b className="font-mono tabular-nums" style={{ color: C.text }}>{safe}</b> / {pages} 页</span>
            <button disabled={safe <= 1} onClick={() => setPage(safe - 1)} className="rounded border px-2.5 py-0.5 transition enabled:hover:brightness-125"
              style={{ borderColor: 'rgba(96,138,188,0.35)', color: safe <= 1 ? 'rgba(147,166,184,0.5)' : C.text, cursor: safe <= 1 ? 'not-allowed' : 'pointer' }}>上一页</button>
            <button disabled={safe >= pages} onClick={() => setPage(safe + 1)} className="rounded border px-2.5 py-0.5 transition enabled:hover:brightness-125"
              style={{ borderColor: 'rgba(96,138,188,0.35)', color: safe >= pages ? 'rgba(147,166,184,0.5)' : C.text, cursor: safe >= pages ? 'not-allowed' : 'pointer' }}>下一页</button>
          </span>
        )}
      </div>
    </div>
  )
}

// 工单详情（下钻末级）：关键信息栅格（字段缺失显示 --，兼容真实接口尚未补充的字段）
function TicketDetail({ t }) {
  if (!t) return null
  const pill = PRIORITY_PILL[t.priority] || PRIORITY_PILL.low
  const items = [
    ['工单编号', t.ticket_no, true],
    ['创建时间', t.created_at ? t.created_at.slice(0, 19).replace('T', ' ') : '--'],
    ['提交团队', t.team || '--'],
    ['来源平台', t.platform || '--'],
    ['告警类型', t.alert_type || '--'],
    ['源 IP 地址', t.src_ip || '--'],
    ['当前节点', t.current_node_name || '--'],
    ['关闭时间', t.closed_at ? t.closed_at.slice(0, 19).replace('T', ' ') : '未关闭'],
    ['SLA 响应时长', t.response_minutes != null ? fmtDur(t.response_minutes) : '--'],
    ['SLA 解决时长', t.resolve_minutes != null ? fmtDur(t.resolve_minutes) : '--'],
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-[16px] font-bold" style={{ color: C.text }}>{t.title || '工单详情'}</span>
        <span className="inline-flex items-center rounded-full border px-2 py-px text-[12px]"
          style={{ background: pill.bg, color: pill.color, borderColor: pill.border }}>
          {t.priority === 'critical' ? '! ' : ''}{t.priority_label || '--'}
        </span>
        <span className="rounded px-2 py-px text-[12px]"
          style={{ background: 'rgba(96,138,188,0.14)', color: STATUS_COLOR[t.status] || C.subText, border: '1px solid rgba(96,138,188,0.3)' }}>
          {t.status_label || '--'}
        </span>
        {t.timeout && (
          <span className="rounded px-2 py-px text-[12px]" style={{ background: 'rgba(255,77,79,0.16)', color: C.red, border: '1px solid rgba(255,77,79,0.45)' }}>
            超时预警
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2.5">
        {items.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b pb-1.5"
            style={{ borderColor: 'rgba(96,138,188,0.15)' }}>
            <span className="shrink-0 text-[12px]" style={{ color: C.subText }}>{k}</span>
            <span className="min-w-0 truncate text-right text-[13px] font-medium" style={{ color: C.text }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// 弹窗壳：层级标记 + 面包屑（可点回跳）+ 关闭；主体按 view.kind 分发
// teams → 全部团队数据（由当前数据源实时聚合，保证与排名条/各级下钻列表口径一致）；
// tickets → 筛选后的工单列表；detail → 单工单详情
// truncated：后端下钻工单集超上限截断时弹窗内提示（仅真实数据模式）
function DrillModal({ level, view, stack, tickets, truncated = false, onJump, onClose, onDrill }) {
  const teams = useMemo(() => {
    if (view.kind !== 'teams') return []
    const m = new Map()
    tickets.forEach((t) => { if (t.team) m.set(t.team, (m.get(t.team) || 0) + 1) })
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [view.kind, tickets])
  const rows = useMemo(
    () => (view.kind === 'tickets' ? tickets.filter((t) => matchDrill(t, view.filters)) : []),
    [view.kind, view.filters, tickets],
  )
  const crumbs = stack.slice(0, level + 1).map((v) => v.title)
  const close = () => onClose(level)
  const wide = view.kind !== 'detail'
  return (
    // 遮罩层：点击关闭当前层；层级越高 zIndex 越大，形成多级覆盖
    <div className="drill-in absolute inset-0 flex items-center justify-center"
      style={{ zIndex: 40 + level, background: 'rgba(4,9,15,0.55)', backdropFilter: 'blur(3px)' }}
      onClick={close}>
      <div className="drill-pop flex flex-col overflow-hidden rounded-md border"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: wide ? 920 : 720, maxWidth: '94%',
          height: wide ? 680 : undefined, maxHeight: '78%',
          background: 'rgba(10,19,29,0.97)',
          borderColor: 'rgba(96,138,188,0.45)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 24px rgba(80,130,190,0.18)',
        }}>
        {/* 头部：层级标记 + 面包屑导航 + 副标题 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: 'rgba(96,138,188,0.22)' }}>
          <span className="h-3.5 w-[3px] shrink-0 rounded" style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}80` }} />
          <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{ color: C.subText, border: '1px solid rgba(96,138,188,0.3)' }} title="下钻层级">L{level + 1}</span>
          {crumbs.map((t, i) => (
            <span key={i} className="flex min-w-0 items-center gap-2 text-[14px]">
              {i > 0 && <span className="shrink-0" style={{ color: C.subText }}>›</span>}
              <span className={i === level ? 'min-w-0 truncate font-bold' : 'min-w-0 shrink-0 cursor-pointer truncate transition hover:underline'}
                style={{ color: i === level ? C.text : C.subText }}
                onClick={i === level ? undefined : () => onJump(i)}
                title={i === level ? undefined : `返回第 ${i + 1} 级：${t}`}>
                {t}
              </span>
            </span>
          ))}
          {view.subtitle && <span className="hidden shrink-0 text-[11px] lg:inline" style={{ color: C.subText }}>{view.subtitle}</span>}
          <button onClick={close} title="关闭（ESC）"
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded border text-[13px] transition hover:brightness-150"
            style={{ borderColor: 'rgba(96,138,188,0.4)', color: C.subText }}>✕</button>
        </div>
        {/* 主体（截断时团队/工单视图均提示：团队数据由下钻工单集聚合，同为截断口径） */}
        {truncated && view.kind !== 'detail' && (
          <div className="shrink-0 px-4 pt-2 text-[11px]" style={{ color: C.orange }}>
            工单量较大，弹窗仅基于最近 2000 件展示（面板统计数字为全量口径）
          </div>
        )}
        {view.kind === 'teams' && (
          <TeamTable teams={teams}
            onTeamClick={(d) => onDrill({
              kind: 'tickets',
              title: `${d.name} · 提交工单列表`,
              subtitle: '团队下钻',
              filters: { team: d.name },
            })} />
        )}
        {view.kind === 'tickets' && (
          <TicketTable rows={rows}
            onRowClick={(r) => onDrill({
              kind: 'detail', ticket: r,
              title: `工单详情 · ${r.ticket_no}`, subtitle: '工单下钻',
            })} />
        )}
        {view.kind === 'detail' && <TicketDetail t={view.ticket} />}
      </div>
    </div>
  )
}


// ============ 演示数据（降级预览层：仅旧版后端 / team_stats 缺失时生效） ============
// 后端 /tickets/monitor 已返回 team_stats（团队排名）与 tickets（下钻工单集），大屏默认走真实数据；
// 当响应缺少 team_stats（旧版后端未升级）时全屏回退到本演示数据，保证任何环境下大屏可预览。
// 以 DEMO_TEAM_ROWS 的团队件数为基数，固定种子伪随机（mulberry32）生成确定性演示工单集，
// 再派生 KPI / 趋势 / 分布 / 平台 / SLA / 流转 / 团队排名等全部分区统计，
// 保证「面板数字 = 弹窗下钻列表条数」的口径一致（演示工单含 flow_id，与真实接口字段对齐）。
// 演示工单字段口径与后端下钻工单集一致：team / platform / alert_type / current_node_key /
// active_today / timeout / closed_at / response_minutes / resolve_minutes 等。

const DEMO_LABELS = {
  status: { processing: '处理中', completed: '已完成', cancelled: '已取消' },
  priority: { critical: '紧急', high: '高危', medium: '中危', low: '低危' },
}

const DEMO_PLATFORMS = ['奇安信天眼', '深信服态势感知', '绿盟IDS', '安恒明御WAF', '360天擎', '微步云沙箱']
const DEMO_TYPES = ['暴力破解', 'Web应用攻击', '挖矿木马', 'SQL注入', 'DDoS攻击', '弱口令探测', '恶意扫描', '钓鱼邮件']
const DEMO_FLOW_NODES = [
  { key: 'n_monitor', name: '监测预警', group: '监测组' },
  { key: 'n_judge', name: '研判分析', group: '研判组' },
  { key: 'n_emergency', name: '应急处置', group: '处置组' },
]

// 固定种子伪随机（mulberry32）：演示数据确定性生成，刷新不变
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Date → 本地时间 ISO 串（YYYY-MM-DDTHH:mm:ss，与后端 created_at 同格式，可直接字典序比较）
function isoLocal(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 演示工单集：按 DEMO_TEAM_ROWS 各团队件数生成（近 30 天均匀分布），字段与真实
// monitor 接口的下钻工单集对齐；状态/等级/平台/类型加权取值更接近真实告警工区面
function buildDemoTickets() {
  const rand = mulberry32(0x20261029)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1))
  const now = new Date()
  const tickets = []
  let seq = 0
  DEMO_TEAM_ROWS.forEach((team) => {
    for (let i = 0; i < team.value; i += 1) {
      seq += 1
      const created = new Date(now)
      created.setDate(created.getDate() - between(0, 29))
      created.setHours(between(0, 23), between(0, 59), between(0, 59), 0)
      const rs = rand()
      const status = rs < 0.35 ? 'processing' : rs < 0.9 ? 'completed' : 'cancelled'
      const rp = rand()
      const priority = rp < 0.08 ? 'critical' : rp < 0.3 ? 'high' : rp < 0.75 ? 'medium' : 'low'
      const srcIp = `10.${between(10, 60)}.${between(20, 220)}.${between(10, 240)}`
      const type = pick(DEMO_TYPES)
      const t = {
        id: seq,
        // 与 buildDemoStats 的 flow.id 一致：流转节点下钻按流程限定（口径与真实接口相同）
        flow_id: 1,
        ticket_no: `TK-${isoLocal(created).slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`,
        title: `${type}告警处置（源IP ${srcIp}）`,
        created_at: isoLocal(created),
        priority,
        priority_label: DEMO_LABELS.priority[priority],
        status,
        status_label: DEMO_LABELS.status[status],
        team: team.name,
        platform: pick(DEMO_PLATFORMS),
        alert_type: type,
        src_ip: srcIp,
        response_minutes: between(6, 120),
        // 进行中：停留在流程节点（监测/研判/处置），可超时、可今日活跃；关闭件补 closed_at 与解决时长
        active_today: false,
        timeout: false,
        current_node_key: '_finished',
        current_node_name: '已关闭',
        closed_at: null,
        resolve_minutes: null,
        response_overdue: false,
        resolve_overdue: false,
      }
      if (status === 'processing') {
        const node = rand() < 0.25 ? DEMO_FLOW_NODES[0] : rand() < 0.55 ? DEMO_FLOW_NODES[1] : DEMO_FLOW_NODES[2]
        t.current_node_key = node.key
        t.current_node_name = node.name
        t.timeout = rand() < 0.17
        t.active_today = rand() < 0.35
        t.response_overdue = rand() < 0.25
      } else {
        const closed = new Date(created.getTime() + between(40, 2600) * 60000)
        if (closed > now) closed.setTime(now.getTime() - between(10, 300) * 60000)
        t.closed_at = isoLocal(closed)
        t.resolve_minutes = between(40, 2400)
        t.resolve_overdue = rand() < 0.1
      }
      tickets.push(t)
    }
  })
  return tickets
}

// 由演示工单集派生大屏全部分区统计（字段结构与后端 monitor 聚合返回一致）
function buildDemoStats(tickets) {
  const now = new Date()
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
  const todayIso = isoLocal(dayStart)
  const processing = tickets.filter((t) => t.status === 'processing')
  const completed = tickets.filter((t) => t.status === 'completed')
  const cancelled = tickets.filter((t) => t.status === 'cancelled')
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : null)
  const inRange = (v, from, to) => !!v && v >= from && v < to

  const kpi = {
    total: tickets.length,
    today_new: tickets.filter((t) => t.created_at >= todayIso).length,
    today_closed: tickets.filter((t) => inRange(t.closed_at, todayIso, '\uffff')).length,
    pending: processing.length,
    processing_active: processing.filter((t) => t.active_today).length,
    completed: completed.length,
    cancelled: cancelled.length,
    timeout_warning: processing.filter((t) => t.timeout).length,
  }

  // 趋势：近 24 小时（小时桶）/ 近 7 天 / 近 30 天（日桶）
  const trendHours = () => {
    const cur = new Date(now); cur.setMinutes(0, 0, 0)
    return Array.from({ length: 24 }, (_, i) => {
      const s = new Date(cur.getTime() - (23 - i) * 3600000)
      const from = isoLocal(s)
      const to = isoLocal(new Date(s.getTime() + 3600000))
      return {
        label: `${String(s.getHours()).padStart(2, '0')}:00`,
        new: tickets.filter((t) => t.created_at >= from && t.created_at < to).length,
        closed: tickets.filter((t) => inRange(t.closed_at, from, to)).length,
      }
    })
  }
  const trendDays = (n) => Array.from({ length: n }, (_, i) => {
    const s = new Date(dayStart.getTime() - (n - 1 - i) * 86400000)
    const from = isoLocal(s)
    const to = isoLocal(new Date(s.getTime() + 86400000))
    return {
      label: `${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`,
      new: tickets.filter((t) => t.created_at >= from && t.created_at < to).length,
      closed: tickets.filter((t) => inRange(t.closed_at, from, to)).length,
    }
  })

  // 告警类型分布（降序）
  const typeMap = new Map()
  tickets.forEach((t) => typeMap.set(t.alert_type, (typeMap.get(t.alert_type) || 0) + 1))
  const type = [...typeMap.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)

  // 严重度 × 状态（紧急→低危）
  const severity_status = ['critical', 'high', 'medium', 'low'].map((p) => ({
    name: DEMO_LABELS.priority[p],
    processing: tickets.filter((t) => t.priority === p && t.status === 'processing').length,
    completed: tickets.filter((t) => t.priority === p && t.status === 'completed').length,
    cancelled: tickets.filter((t) => t.priority === p && t.status === 'cancelled').length,
  }))

  // 来源平台 × 状态构成
  const pm = {}
  tickets.forEach((t) => {
    const row = pm[t.platform] || (pm[t.platform] = { name: t.platform, total: 0, today_new: 0, pending: 0, processing_active: 0, completed: 0 })
    row.total += 1
    if (t.created_at >= todayIso) row.today_new += 1
    if (t.status === 'processing') {
      row.pending += 1
      if (t.active_today) row.processing_active += 1
    } else if (t.status === 'completed') row.completed += 1
  })

  // 提交团队排名（与生成基数一致）
  const tm = new Map()
  tickets.forEach((t) => tm.set(t.team, (tm.get(t.team) || 0) + 1))

  // 流转节点停留（进行中按节点停留；完成节点 = 已完成 + 已取消）
  const flowNodes = DEMO_FLOW_NODES.map((n) => ({ ...n, current: processing.filter((t) => t.current_node_key === n.key).length }))
  flowNodes.push({ key: '_finished', name: '已关闭', current: completed.length + cancelled.length })

  return {
    kpi,
    trend: { hours24: trendHours(), days7: trendDays(7), days30: trendDays(30) },
    dist: { type },
    severity_status,
    platform_stats: Object.values(pm).sort((a, b) => b.total - a.total),
    team_stats: [...tm.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    flow_nodes: flowNodes,
    flows: [{ id: 1, name: '安全告警处置流程', enabled: true, is_draft: false }],
    flow: { id: 1, name: '安全告警处置流程', auto: true },
    latest: [...tickets].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8),
    sla: {
      avg_response_minutes: avg(tickets.map((t) => t.response_minutes)),
      avg_resolve_minutes: avg(tickets.filter((t) => t.resolve_minutes != null).map((t) => t.resolve_minutes)),
      timeout_rate: processing.length ? Math.round((kpi.timeout_warning / processing.length) * 1000) / 10 : 0,
      on_time_rate: completed.length
        ? Math.round(((completed.length - completed.filter((t) => t.resolve_overdue).length) / completed.length) * 1000) / 10
        : null,
      responded_count: tickets.length,
      resolved_count: completed.length + cancelled.length,
      timeout_count: kpi.timeout_warning,
      response_overdue_count: processing.filter((t) => t.response_overdue).length,
      resolve_overdue_count: completed.filter((t) => t.resolve_overdue).length,
      in_scope_count: tickets.length,
      targets: {
        critical: { response: 15, resolve: 240 },
        high: { response: 30, resolve: 480 },
        medium: { response: 60, resolve: 1440 },
        low: { response: 120, resolve: 2880 },
      },
    },
    tickets,
  }
}

// 模块级一次性构建（固定种子，刷新结果一致）
const DEMO_STATS = buildDemoStats(buildDemoTickets())

// ============ 页面主体：1920×1080 基准 + 整屏缩放自适应 ============
export default function TicketMonitorScreen() {
  const [stats, setStats] = useState(null)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState(null)
  // 处置状态流转的流程选择：'' = 自动（进行中工单最多的流程），选择本地持久化
  const [flowId, setFlowId] = useState(() => {
    try { return window.localStorage.getItem('ticket_monitor_flow') || '' } catch { return '' }
  })
  // 弹窗下钻栈：各区块点击 → openDrill(view) 逐级压栈覆盖显示；
  // ESC / 遮罩 / × 关闭当前层，面包屑可回跳任意上级（全程不跳转路由）
  const [drillStack, setDrillStack] = useState([])

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

  // 下钻栈操作：openDrill 压入下一级；jumpDrill 回跳到指定级；closeDrill 关闭指定级（含以上）
  const openDrill = (view) => setDrillStack((s) => [...s, view])
  const jumpDrill = (idx) => setDrillStack((s) => s.slice(0, idx + 1))
  const closeDrill = (level) => setDrillStack((s) => s.slice(0, level))

  // ESC 关闭最顶层下钻弹窗
  useEffect(() => {
    if (drillStack.length === 0) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setDrillStack((s) => s.slice(0, -1)) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drillStack.length])

  // 演示模式判定：后端聚合接口未返回 team_stats（字段不存在，如旧版后端或接口异常前）→
  // 全屏改用内置演示数据（面板数字与弹窗下钻列表条数严格一致），标题栏显示「演示数据」标记。
  // 后端已接入 team_stats + 下钻工单集 tickets：正常返回即自动切换真实数据，无需改前端。
  const isDemo = !Array.isArray(stats?.team_stats)
  const data = isDemo ? DEMO_STATS : stats
  const drillTickets = isDemo ? DEMO_STATS.tickets : (Array.isArray(stats?.tickets) ? stats.tickets : [])
  // 下钻工单集超上限截断（后端 tickets_truncated）：弹窗内提示，避免与面板全量口径混淆
  const drillTruncated = !isDemo && !!stats?.tickets_truncated

  // KPI：今日新增对比昨日（趋势 days30 末两个点）
  const yesterdayNew = data?.trend?.days30?.length >= 2 ? data.trend.days30[data.trend.days30.length - 2]?.new : undefined
  const kpi = data?.kpi
  const todayDelta = kpi && yesterdayNew !== undefined ? kpi.today_new - yesterdayNew : undefined
  // 超时预警占待处理比例（待处理为 0 时无意义，显示 —）
  const warnPct = kpi && kpi.pending > 0 && kpi.timeout_warning != null
    ? Math.round((kpi.timeout_warning / kpi.pending) * 1000) / 10
    : null
  // 今日零点（ISO 本地串）：KPI「今日新增」下钻筛选用
  const todayStartIso = isoLocal(new Date(new Date().setHours(0, 0, 0, 0)))

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
        /* 流转连线虚线流动（repeating 渐变横向位移，方向与流转方向一致） */
        @keyframes dashFlow { from { background-position-x: 0; } to { background-position-x: 12px; } }
        .flow-dash {
          background-image: repeating-linear-gradient(90deg, rgba(111,160,216,0.95) 0 5px, transparent 5px 12px);
          animation: dashFlow 0.8s linear infinite;
        }
        @keyframes nodeGlow { 0%, 100% { box-shadow: 0 0 10px rgba(69,184,205,0.30); } 50% { box-shadow: 0 0 20px rgba(69,184,205,0.60); } }
        .node-glow { animation: nodeGlow 2.4s ease-in-out infinite; }
        @keyframes rowEnter { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        .row-enter { animation: rowEnter 0.5s ease-out; }
        /* 新工单插入行：2 秒青色渐隐高亮（rgba(0,212,170,0.25) → 透明） */
        @keyframes rowFlash { from { background: rgba(0,212,170,0.25); } to { background: rgba(0,212,170,0); } }
        .row-flash { animation: rowFlash 2s ease-out forwards; }
        /* 节点停留件数变化：一次性缩放弹跳 */
        @keyframes countBounce { 0% { transform: scale(1); } 40% { transform: scale(1.3); } 100% { transform: scale(1); } }
        .count-bounce { animation: countBounce 0.45s ease-out; }
        @keyframes marqueeEnter { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
        .marquee-enter { animation: marqueeEnter 0.8s ease-out; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .screen-fade { animation: fadeIn 0.6s ease-out; }
        /* 弹窗下钻：遮罩淡入 + 对话框弹入（缩放 + 上移，层级感） */
        @keyframes drillIn { from { opacity: 0; } to { opacity: 1; } }
        .drill-in { animation: drillIn 0.18s ease-out; }
        @keyframes drillPop { from { opacity: 0; transform: scale(0.96) translateY(12px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .drill-pop { animation: drillPop 0.22s ease-out; }
        /* 系统开启"减少动态效果"时关闭装饰动画 */
        @media (prefers-reduced-motion: reduce) {
          .flow-dash, .node-glow, .row-enter, .row-flash, .count-bounce, .marquee-enter, .screen-fade,
          .drill-in, .drill-pop { animation: none !important; }
        }
      `}</style>

      <div className="screen-fade absolute" style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: 'center' }}>
        {/* ① 顶部标题栏（演示模式带「演示数据」标记） */}
        <HeaderBar demo={isDemo} />

        {/* ① KPI 指标卡横排（点击下钻对应口径工单列表；超时预警↔待处理同色橙红描边编组，处理中 0 件灰色虚线态） */}
        <div className="mt-1 grid h-[96px] grid-cols-6 gap-3 px-4">
          <KpiCard label="工单总量" value={kpi?.total} tone="blue"
            onClick={() => openDrill({ kind: 'tickets', title: '全部工单列表', subtitle: 'KPI 下钻 · 工单总量' })} />
          <KpiCard label="今日新增" value={kpi?.today_new} tone="blue" delta={todayDelta}
            onClick={() => openDrill({ kind: 'tickets', title: '今日新增工单', subtitle: 'KPI 下钻 · 今日创建', filters: { from: todayStartIso } })} />
          <KpiCard label="待处理" value={kpi?.pending} tone="orange" groupBorder
            onClick={() => openDrill({ kind: 'tickets', title: '待处理工单', subtitle: 'KPI 下钻 · 进行中', filters: { status: 'processing' } })} />
          <KpiCard label="处理中（今日活跃）" value={kpi?.processing_active} tone="blue" zeroNote="暂无进行中工单"
            onClick={() => openDrill({ kind: 'tickets', title: '今日活跃处理中工单', subtitle: 'KPI 下钻 · 今日活跃', filters: { status: 'processing', activeToday: true } })} />
          <KpiCard label="已解决" value={kpi?.completed} tone="green"
            onClick={() => openDrill({ kind: 'tickets', title: '已解决工单', subtitle: 'KPI 下钻 · 已完成', filters: { status: 'completed' } })} />
          <KpiCard label="超时预警" value={kpi?.timeout_warning} tone={(kpi?.timeout_warning ?? 0) > 0 ? 'red' : 'blue'} groupBorder
            note={`占待处理 ${warnPct == null ? '—' : `${warnPct}%`}`}
            onClick={() => openDrill({ kind: 'tickets', title: 'SLA 超时预警工单', subtitle: 'KPI 下钻 · 超时预警', filters: { timeoutOnly: true } })} />
        </div>

        {/* 主体三栏 */}
        <div className="mt-3 flex h-[788px] gap-3 px-4">
          {/* 左栏 */}
          <div className="flex w-[470px] shrink-0 flex-col gap-3">
            {/* ② 工单趋势分析（点击数据点下钻该时段工单） */}
            <TrendChart trend={data?.trend} onDrill={openDrill} />
            {/* ③ 事件类型与等级分布（点击类型/严重度段下钻） */}
            <DistPanel dist={data?.dist} severityStatus={data?.severity_status} onDrill={openDrill} />
          </div>

          {/* 中央栏（视觉焦点） */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {/* ④ 处置状态流转图（节点卡片点击下钻停留工单，支持流程切换） */}
            <FlowPanel
              flowNodes={data?.flow_nodes}
              flows={data?.flows}
              activeFlow={data?.flow}
              selected={flowId}
              onSelect={selectFlow}
              onDrill={openDrill}
            />
            {/* ④ 提交团队工单排名（模板「提交团队」字段聚合；卡片/尾签/查看全部可下钻） */}
            <TeamRankPanel rows={data?.team_stats} onDrill={openDrill} />
            {/* ④ 最新工单实时列表（行点击查看工单详情） */}
            {/* 实时列表行点击 → 工单详情：latest 记录字段精简，按 id 从下钻工单集换完整对象，
                保证详情页 team/platform/alert_type/SLA 时长等字段完整展示 */}
            <LiveList latest={data?.latest}
              onDrill={(v) => openDrill(v.kind === 'detail' && v.ticket
                ? { ...v, ticket: drillTickets.find((x) => x.id === v.ticket.id) || v.ticket }
                : v)} />
          </div>

          {/* 右栏 */}
          <div className="flex w-[470px] shrink-0 flex-col gap-3">
            {/* ⑤ SLA 时效分析（主环点击下钻超时工单） */}
            <SlaPanel sla={data?.sla} onDrill={openDrill} />
            {/* ⑥ 来源平台统计（点击堆叠段下钻平台×状态工单） */}
            <PlatformPanel rows={data?.platform_stats} onDrill={openDrill} />
          </div>
        </div>

        {/* ⑦ 底部跑马灯 */}
        <div className="mt-3 h-14 px-4">
          <MarqueeBar latest={data?.latest} />
        </div>

        {/* ⑧ 弹窗下钻层（按栈逐级覆盖显示，全程不离开大屏；数据源与面板同源保证口径一致） */}
        {drillStack.map((view, i) => (
          <DrillModal key={i} level={i} view={view} stack={drillStack} tickets={drillTickets}
            truncated={drillTruncated} onJump={jumpDrill} onClose={closeDrill} onDrill={openDrill} />
        ))}
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
