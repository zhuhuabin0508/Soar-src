// 网络安全工单监测平台 —— 政务风格监控大屏
//
// 设计基准 1920×1080，16:9 三栏布局，整屏 transform scale 自适应。
// 数据来源：GET /tickets/monitor 聚合接口（真实工单数据，排除归档），
// 页面按「刷新频率」（默认 15s，可切换 5s/10s/15s/30s/1min/5min 或暂停）轮询整体刷新，
// 底部跑马灯每 8s 轮播一条告警（仅超时 / 紧急工单）。
// 提交团队排名按流程模板首节点「提交团队」字段聚合；接口接入前以演示样例渲染（带标记）。
//
// 七个分区（代码内以注释分隔）：
//   ① 顶部：标题栏 + 核心 KPI 总览（等宽数字；超时预警↔处理中橙红描边编组）
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
//   ⑨ 大屏操作：右上工具条（数据健康度 / 刷新频率切换 / 立即刷新 / 报警开关 / 屏幕适配 /
//      值守轮播 / 全屏切换 + 实时时钟）；中央实时列表状态筛选（全部 / 进行中 / 已完成 / 已取消）
//      + 快捷筛选（仅超时 / 仅紧急 / ★关注）+ 纵向无缝自动滚动（悬停暂停 + 速度可选）。
//   ⑩ 投屏细节：空闲 30s 自动隐藏光标与工具条；快捷键 F 全屏 / R 刷新 / 1-4 状态筛选 / T 轮播。
//   ⑪ 参数化：/ticket-monitor?flow=&refresh=&status=&fit=&fullscreen=1（可直接投屏开机直启）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  AlertTriangle, Activity, Bell, BellOff, CheckCircle2, Clock, Copy, ExternalLink,
  Layers, Maximize2, Minimize2, Pause, Play, RefreshCw, Send, Star, Timer, TimerReset, Trophy,
} from 'lucide-react'
import { ticketApi } from '../api/tickets'
import { toast } from '../store/toastStore'

// ============ 主题常量（最初版：深蓝黑底 + 灰蓝科技蓝 + 橙色强调 + 青色装饰） ============
// 背景为深蓝黑底，中心略亮、四角压暗；卡片为高透磨砂玻璃：
// 约 60% 背景透出 + backdrop-filter 模糊 + 斜向玻璃反光 + 细霜纹理 + 微发光描边。
const PANEL_GLASS =
  'linear-gradient(318deg, rgba(205,230,250,0.10) 0%, rgba(205,230,250,0.045) 30%, rgba(205,230,250,0.02) 62%) padding-box, '
  + 'linear-gradient(0deg, rgba(205,230,250,0.04) 0%, rgba(205,230,250,0.04) 100%) padding-box, '
  + 'radial-gradient(85% 65% at 0% 0%, rgba(96,138,188,0.06) 0%, rgba(96,138,188,0) 62%) padding-box, '
  + 'repeating-linear-gradient(45deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, transparent 1px, transparent 7px) padding-box, '
  + 'linear-gradient(158deg, rgba(16,30,44,0.40) 0%, rgba(13,25,37,0.38) 100%) padding-box'

const C = {
  // 背景层：中心略亮 → 过渡 → 四角压暗
  deepNavy: '#0B131C',          // 四角/边缘深底
  canvasCenter: '#16222E',      // 中心亮区
  canvasBase: '#111D2A',        // 画面主底色
  canvasEdge: '#0D1824',        // 过渡带
  // 卡片层：高透磨砂玻璃（约 60% 背景透出）
  panelBg: PANEL_GLASS,
  panelFade: 'rgba(17, 30, 43, 0.85)',       // 列表滚动渐隐（与玻璃合成色一致）
  panelBorder: 'rgba(96, 138, 188, 0.38)',
  panelBorderSoft: 'rgba(96, 138, 188, 0.22)',
  innerBg: 'rgba(255, 255, 255, 0.04)',     // 卡面之上的内层卡片
  innerBgSoft: 'rgba(255, 255, 255, 0.028)',
  controlBg: 'rgba(14, 26, 38, 0.80)',      // 输入/下拉等控件底
  techBlue: '#4E8AD4',          // 科技蓝（主色）
  lightBlue: '#6FA0D8',         // 浅蓝（辅助）
  paleBlue: '#A8C8EC',
  cyan: '#45B8CD',              // 青色霓虹（装饰线条/流光）
  accent: '#E57832',            // 橙色强调（标题竖条/点缀）
  // 文字层
  text: '#E6ECF2',
  subText: '#93A6B8',
  axis: 'rgba(110, 140, 175, 0.45)',
  split: 'rgba(80, 120, 170, 0.12)',
  red: '#FF4D4F',               // 紧急/超时
  orange: '#FFA940',            // 高危
  green: '#41D08C',             // 已解决
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
    axisLabel: { color: C.subText, fontSize: 12, ...extra },
  }
}

// ============ 通用面板卡片（深蓝黑半透明底 + 微发光描边 + 橙色竖条标题 + L 型角标） ============
// L 型角标颜色语义统一：正常模块青色，含告警数据的模块橙红（alert 属性控制）
function Panel({ title, subtitle, icon: Icon, right, children, className = '', bodyClassName = '', alert = false, ...rest }) {
  const cornerColor = alert ? C.red : C.cyan
  const cornerGlow = alert ? 'rgba(255,77,79,0.6)' : 'rgba(69,184,205,0.6)'
  return (
    <div className={`relative flex flex-col rounded-md border backdrop-blur-xl ${className}`}
      style={{
        background: C.panelBg,
        borderColor: C.panelBorder,
        backdropFilter: 'blur(24px) saturate(150%)',
        WebkitBackdropFilter: 'blur(24px) saturate(150%)',
        boxShadow: '0 8px 26px rgba(2, 6, 12, 0.30), 0 0 16px rgba(80, 130, 190, 0.12), inset 0 1px 0 rgba(168, 200, 236, 0.16), inset 0 0 32px rgba(96, 138, 188, 0.06)',
      }} {...rest}>
      {/* 玻璃顶缘高光：层叠质感 */}
      <div className="pointer-events-none absolute inset-x-3 top-0 z-10 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(168,200,236,0.4), transparent)' }} />
      {/* L 型角标（左上 / 右下）：青=正常模块，橙红=含告警数据 */}
      <span className="pointer-events-none absolute left-0 top-0 z-10 h-2.5 w-2.5 rounded-tl border-l-2 border-t-2"
        style={{ borderColor: cornerColor, filter: `drop-shadow(0 0 3px ${cornerGlow})` }} />
      <span className="pointer-events-none absolute bottom-0 right-0 z-10 h-2.5 w-2.5 rounded-br border-b-2 border-r-2"
        style={{ borderColor: cornerColor, filter: `drop-shadow(0 0 3px ${cornerGlow})` }} />
      <div className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: C.panelBorderSoft }}>
        <span className="h-3.5 w-[3px] shrink-0 rounded" style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}80` }} />
        {/* 标题不换行（窄面板也要完整展示）；空间不足时优先压缩英文副标题与右侧操作区 */}
        <span className="shrink-0 whitespace-nowrap text-[16px] font-bold tracking-wide" style={{ color: C.text }}>{title}</span>
        {subtitle && (
          <span className="min-w-0 truncate text-[10px] uppercase tracking-[2px]" style={{ color: C.subText, opacity: 0.75 }}>{subtitle}</span>
        )}
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: C.lightBlue }} />}
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </div>
  )
}

// ============ ① 顶部：标题栏 + 时钟 ============
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

// 数据刷新频率选项（值 = 毫秒；0 = 暂停自动刷新，仅手动刷新）。选择后本地记忆，刷新页面仍生效。
const REFRESH_OPTIONS = [
  { label: '5 秒', value: 5000 },
  { label: '10 秒', value: 10000 },
  { label: '15 秒', value: 15000 },
  { label: '30 秒', value: 30000 },
  { label: '1 分钟', value: 60000 },
  { label: '5 分钟', value: 300000 },
  { label: '暂停刷新', value: 0 },
]
const REFRESH_KEY = 'ticket_monitor_refresh_ms'
const DEFAULT_REFRESH_MS = 15000

function readRefreshMs() {
  try {
    const raw = window.localStorage.getItem(REFRESH_KEY)
    // 空值（首次进入）不能用 Number(null)=0，否则会误命中「暂停刷新」
    if (raw === null || raw === '') return DEFAULT_REFRESH_MS
    const n = Number(raw)
    return REFRESH_OPTIONS.some((o) => o.value === n) ? n : DEFAULT_REFRESH_MS
  } catch {
    return DEFAULT_REFRESH_MS
  }
}

// ============ 大屏偏好（全部本地记忆，可被 URL 参数覆盖）============
const SPEED_KEY = 'ticket_monitor_speed'      // 实时列表滚动速度 px/s
const WATCH_KEY = 'ticket_monitor_watch'      // ★关注工单 id 列表
const ALARM_KEY = 'ticket_monitor_alarm'      // 声光报警开关
const FIT_KEY = 'ticket_monitor_fit'          // 屏幕适配：contain=等比留边 / cover=满屏拉伸
const SPEED_OPTIONS = [
  { label: '慢', value: 12 },
  { label: '中', value: 24 },
  { label: '快', value: 36 },
]
const DEFAULT_SPEED = 24
const FIT_OPTIONS = [
  { label: '等比', value: 'contain' },
  { label: '满屏', value: 'cover' },
]
const IDLE_MS = 30000       // 无操作自动隐藏光标/工具条
const TOUR_MS = 15000       // 值守轮播间隔

function readSpeed() {
  try {
    const n = Number(window.localStorage.getItem(SPEED_KEY))
    return SPEED_OPTIONS.some((o) => o.value === n) ? n : DEFAULT_SPEED
  } catch {
    return DEFAULT_SPEED
  }
}

function readWatchIds() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(WATCH_KEY) || '[]')
    return Array.isArray(raw) ? raw.map(Number).filter((x) => Number.isFinite(x)) : []
  } catch {
    return []
  }
}

function readFlag(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1' || raw === 'true'
  } catch {
    return fallback
  }
}

function readFit() {
  try {
    const raw = window.localStorage.getItem(FIT_KEY)
    return FIT_OPTIONS.some((o) => o.value === raw) ? raw : 'contain'
  } catch {
    return 'contain'
  }
}

// ============ URL 参数（可直接生成投屏专用链接）============
// /ticket-monitor?flow=<流程ID>&refresh=<刷新毫秒>&status=<全部|processing|completed|cancelled>
//                &fit=<contain|cover>&fullscreen=1
// 参数优先级高于本地记忆；fullscreen=1 因浏览器策略需首个用户手势后进入全屏（页面会提示点击）
function readUrlParams() {
  let p
  try {
    p = new URLSearchParams(window.location.search)
  } catch {
    p = new URLSearchParams()
  }
  const refresh = Number(p.get('refresh'))
  const status = p.get('status')
  const fit = p.get('fit')
  return {
    flow: (p.get('flow') || '').trim() || null,
    refresh: REFRESH_OPTIONS.some((o) => o.value === refresh) ? refresh : null,
    status: ['all', 'processing', 'completed', 'cancelled'].includes(status) ? status : null,
    fit: FIT_OPTIONS.some((o) => o.value === fit) ? fit : null,
    fullscreen: p.get('fullscreen') === '1' || p.get('fullscreen') === 'true',
  }
}

// KPI 迷你趋势采样（本屏观测最近 24 次；切换流程时重置）
const KPI_FIELDS = ['total', 'today_new', 'pending', 'processing_active', 'completed', 'cancelled', 'timeout_warning']
const KPI_HIST_MAX = 24
const DRILL_CACHE_MS = 5 * 60 * 1000   // 下钻工单集缓存有效期（按需拉取，避免每次轮询下发 2000 条）
const ALARM_FLASH_MS = 4200            // 新增超时工单时顶部红闪时长
const STATUS_HOTKEYS = { 1: 'all', 2: 'processing', 3: 'completed', 4: 'cancelled' }

// ============ 数据健康度（正常 / 延迟 / 断开）============
const HEALTH_META = {
  ok: { color: C.green, label: '正常' },
  stale: { color: C.orange, label: '延迟' },
  offline: { color: C.red, label: '断开' },
}

// ============ ① 顶部标题栏 + 工具条 ============
// 工具条：健康度 · 时钟 · 刷新频率 · 立即刷新 · 报警 · 屏幕适配 · 值守轮播 · 全屏
function HeaderBar({
  demo, refreshMs, onRefreshMs, onRefresh, refreshing, lastUpdated,
  isFullscreen, onToggleFullscreen, health, alarmOn, onToggleAlarm,
  fit, onFit, tourOn, onToggleTour, hidden,
}) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const pad = (n) => String(n).padStart(2, '0')
  const updatedAt = lastUpdated
    ? `${pad(lastUpdated.getHours())}:${pad(lastUpdated.getMinutes())}:${pad(lastUpdated.getSeconds())}`
    : '--:--:--'
  // 工具条按钮统一样式（玻璃底 + 微描边，悬停提亮）
  const toolBtn = {
    borderColor: 'rgba(96,138,188,0.40)',
    background: 'rgba(78,138,212,0.10)',
    color: C.paleBlue,
  }
  const hm = HEALTH_META[health?.status] || HEALTH_META.ok
  const healthTip = [
    `数据源：${hm.label}`,
    lastUpdated ? `最近成功 ${updatedAt}` : null,
    health?.latency != null ? `响应 ${health.latency}ms` : null,
    health?.fails ? `连续失败 ${health.fails} 次` : null,
    health?.error || null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="relative flex h-16 items-center justify-center px-6">
      {/* 标题底衬光带 */}
      <div className="absolute inset-x-0 top-0 h-16"
        style={{ background: 'linear-gradient(180deg, rgba(69,184,205,0.14) 0%, rgba(13,24,38,0) 100%)' }} />
      {/* 演示模式标记（全屏演示数据时显示；后端聚合接口接入后自动消失） */}
      {demo && (
        <span className="absolute left-6 top-2 z-10 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px]"
          style={{ background: 'rgba(229,120,50,0.13)', color: C.accent, borderColor: 'rgba(229,120,50,0.45)' }}
          title="大屏当前以内置演示数据预览（各分区数字与下钻弹窗列表条数一致）；后端聚合接口接入「提交团队」统计与下钻工单集后自动切换真实数据">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}` }} />
          演示数据
        </span>
      )}
      {/* 两侧装饰线（青色霓虹）；右侧让位于工具条，避免穿过控件文字 */}
      <div className="absolute left-6 top-1/2 h-[2px] w-[260px] -translate-y-1/2"
        style={{ background: `linear-gradient(90deg, transparent, ${C.cyan})`, boxShadow: `0 0 8px ${C.cyan}66` }} />
      <div className="absolute top-1/2 h-[2px] w-[150px] -translate-y-1/2"
        style={{ right: 600, background: `linear-gradient(270deg, transparent, ${C.cyan})`, boxShadow: `0 0 8px ${C.cyan}66` }} />
      <div className="relative text-center">
        <h1 className="text-[30px] font-bold tracking-[6px]"
          style={{ color: C.text, textShadow: `0 0 18px ${C.cyan}59`, fontFamily: "'PingFang SC','Microsoft YaHei',sans-serif" }}>
          网络安全工单监测平台
        </h1>
        <div className="mt-0.5 text-[11px] tracking-[4px]" style={{ color: C.cyan, opacity: 0.85 }}>
          TICKET&nbsp;MONITORING&nbsp;&amp;&nbsp;OPERATIONS&nbsp;CENTER
        </div>
      </div>

      {/* 右上工具条：健康度 · 时钟 · 刷新频率 · 立即刷新 · 报警 · 屏幕适配 · 值守轮播 · 全屏
          （独立玻璃底托，压住装饰线；空闲 30s 自动淡出，鼠标一动恢复） */}
      <div className={`absolute right-6 top-1/2 z-20 flex -translate-y-1/2 items-center gap-2 rounded-md border px-2.5 py-1.5 backdrop-blur-xl transition-opacity duration-500 ${hidden ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
        data-tour
        style={{
          background: C.panelBg,
          borderColor: C.panelBorder,
          backdropFilter: 'blur(20px) saturate(150%)',
          WebkitBackdropFilter: 'blur(20px) saturate(150%)',
          boxShadow: '0 4px 16px rgba(2,6,12,0.28), 0 0 12px rgba(80,130,190,0.12), inset 0 1px 0 rgba(168,200,236,0.16)',
        }}>
        {/* 数据健康度：正常 / 延迟 / 断开（悬停查看最近成功时间、响应耗时、连续失败次数） */}
        <div className="flex items-center gap-1 text-[12px]" style={{ color: hm.color }} title={healthTip}>
          <span className={`h-1.5 w-1.5 rounded-full ${health?.status === 'ok' ? 'animate-pulse' : ''}`}
            style={{ background: hm.color, boxShadow: `0 0 6px ${hm.color}` }} />
          {hm.label}
        </div>
        <span className="h-8 w-px shrink-0" style={{ background: 'rgba(96,138,188,0.32)' }} />
        {/* 实时时钟 */}
        <div className="text-right">
          <div className="font-mono text-[18px] font-bold leading-tight tabular-nums" style={{ color: C.text }}>
            {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
          </div>
          <div className="text-[11px] leading-tight" style={{ color: C.subText }}>
            {now.getFullYear()}-{pad(now.getMonth() + 1)}-{pad(now.getDate())}&nbsp;{WEEKDAYS[now.getDay()]}
          </div>
        </div>
        <span className="h-8 w-px shrink-0" style={{ background: 'rgba(96,138,188,0.32)' }} />
        {/* 刷新频率：选择即生效并本地记忆；暂停态以橙色提示 */}
        <div className="flex flex-col">
          <div className="flex items-center gap-1 text-[12px]" style={{ color: C.subText }}>
            <span>刷新</span>
            <select
              value={refreshMs}
              onChange={(e) => onRefreshMs(Number(e.target.value))}
              title="实时列表刷新频率（选择后立即生效并记住；全景数据每 60s 或 4 个周期自动同步一次；暂停仅保留手动刷新）"
              className="cursor-pointer rounded border px-1 py-0.5 text-[12px] outline-none transition hover:brightness-125"
              style={{ ...toolBtn, background: C.controlBg, colorScheme: 'dark' }}>
              {REFRESH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="mt-0.5 text-[10px] tabular-nums"
            style={{ color: refreshMs === 0 ? C.orange : C.subText, opacity: 0.9 }}>
            {refreshMs === 0 ? '已暂停自动刷新' : `更新于 ${updatedAt}`}
          </div>
        </div>
        {/* 立即刷新（刷新中图标旋转） */}
        <button type="button" onClick={onRefresh} title="立即刷新数据（R）" aria-label="立即刷新数据"
          className="flex h-6 w-6 items-center justify-center rounded border transition hover:brightness-125"
          style={toolBtn}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
        {/* 报警开关：新增超时工单时提示音 + 顶部红闪 */}
        <button type="button" onClick={onToggleAlarm}
          title={alarmOn ? '声光报警：开（新增超时工单时响铃+顶部红闪，点击关闭）' : '声光报警：关（点击开启）'}
          aria-label={alarmOn ? '关闭声光报警' : '开启声光报警'} aria-pressed={alarmOn}
          className="flex h-6 w-6 items-center justify-center rounded border transition hover:brightness-125"
          style={alarmOn ? { ...toolBtn, color: C.orange, borderColor: 'rgba(229,120,50,0.55)', background: 'rgba(229,120,50,0.14)' } : toolBtn}>
          {alarmOn ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
        </button>
        {/* 屏幕适配：等比（16:9 留黑边）/ 满屏（拉伸填满非 16:9 投影） */}
        <select
          value={fit}
          onChange={(e) => onFit(e.target.value)}
          title="屏幕适配：等比=保持 16:9（4K/2K 等比放大，最清晰）；满屏=拉伸填满（非 16:9 投影/带鱼屏）"
          className="cursor-pointer rounded border px-1 py-0.5 text-[12px] outline-none transition hover:brightness-125"
          style={{ ...toolBtn, background: C.controlBg, colorScheme: 'dark' }}>
          {FIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {/* 值守轮播：每 15s 轮播「处理中 / 超时 / 平台 / 团队」下钻视图（鼠标点击/ESC 即停） */}
        <button type="button" onClick={onToggleTour} data-tour
          title={tourOn ? '值守轮播：进行中（每 15s 自动切换下钻视图，点击/ESC 停止）' : '值守轮播：每 15s 自动轮播重点下钻视图（T）'}
          aria-label={tourOn ? '停止值守轮播' : '开始值守轮播'} aria-pressed={tourOn}
          className="flex h-6 w-6 items-center justify-center rounded border transition hover:brightness-125"
          style={tourOn ? { ...toolBtn, color: C.cyan, borderColor: 'rgba(69,184,205,0.55)', background: 'rgba(69,184,205,0.16)' } : toolBtn}>
          {tourOn ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        {/* 全屏切换（浏览器级全屏，隐藏系统任务栏/浏览器边框，大屏投放用） */}
        <button type="button" onClick={onToggleFullscreen}
          title={isFullscreen ? '退出全屏（ESC / F）' : '进入全屏（F 或浏览器 F11）'}
          aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
          className="flex h-6 items-center gap-1 rounded border px-1.5 text-[12px] transition hover:brightness-125"
          style={toolBtn}>
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          <span>{isFullscreen ? '退出' : '全屏'}</span>
        </button>
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

// 系统「减少动态效果」偏好：开启时关闭实时列表自动滚动（无障碍）
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return undefined
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return reduce
}

// 迷你趋势线（KPI 卡右上角）：本屏观测到的最近 24 个采样点，纯 SVG 不引入图表实例
function Sparkline({ values, color, width = 56, height = 16 }) {
  if (!Array.isArray(values) || values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - 1 - ((v - min) / span) * (height - 3)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const lastX = width
  const lastY = height - 1 - ((values[values.length - 1] - min) / span) * (height - 3)
  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden="true" style={{ opacity: 0.85 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="1.8" fill={color} />
    </svg>
  )
}

// groupBorder：与关联卡片同色橙红描边做视觉编组（超时预警↔处理中）
// zeroNote：数值为 0 时灰色虚线描边 + 底部文案（避免"灰得像坏了"）
// note：底部小字补充口径（如"占处理中 X%"）
// spark：本屏观测的迷你趋势数据（≥2 个采样才显示）
// pulse：数值异常时描边呼吸（超时预警 > 0）
// onClick：点击卡片下钻对应口径的工单列表（弹窗，不跳转）
function KpiCard({ label, value, unit = '件', tone = 'blue', delta, deltaLabel = '较昨日', note, zeroNote, groupBorder, onClick, spark, pulse }) {
  const toneColor = tone === 'red' ? C.red : tone === 'green' ? C.green : tone === 'orange' ? C.orange : tone === 'gray' ? C.grayBlue : C.lightBlue
  const animated = useCountUp(value)
  const zeroState = value === 0 && zeroNote
  const bottomNote = zeroState ? zeroNote : note
  return (
    <div
      onClick={onClick}
      title={onClick ? '点击下钻查看对应工单列表' : undefined}
      className={`relative flex flex-col justify-center rounded-md border px-4 py-2 backdrop-blur-lg transition-all duration-300 hover:brightness-110 ${onClick ? 'cursor-pointer' : ''} ${pulse ? 'kpi-alert-pulse' : ''}`}
      style={{
        background: C.panelBg,
        borderColor: groupBorder ? 'rgba(255,77,79,0.60)' : zeroState ? 'rgba(147,166,184,0.45)' : C.panelBorder,
        borderStyle: zeroState ? 'dashed' : 'solid',
        backdropFilter: 'blur(18px) saturate(150%)',
        WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        boxShadow: groupBorder
          ? '0 0 12px rgba(255,77,79,0.20), inset 0 1px 0 rgba(255,220,220,0.18)'
          : '0 4px 16px rgba(2, 6, 12, 0.28), 0 0 12px rgba(80, 130, 190, 0.10), inset 0 1px 0 rgba(168,200,236,0.16)',
      }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px]" style={{ color: C.subText }}>{label}</span>
        <Sparkline values={spark} color={toneColor} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[32px] font-bold leading-[1.15] tabular-nums"
          style={{ color: zeroState ? 'rgba(147,166,184,0.9)' : toneColor, textShadow: `0 0 10px ${toneColor}40` }}>
          {animated ?? '--'}
        </span>
        <span className="text-[12px]" style={{ color: C.subText }}>{unit}</span>
        {delta !== undefined && delta !== null && !zeroState && (
          <span className="ml-auto flex items-center gap-0.5 font-mono text-[12px] tabular-nums"
            style={{ color: delta > 0 ? C.green : delta < 0 ? C.orange : C.subText }}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}{Math.abs(delta)}
            <span style={{ color: C.subText }}>&nbsp;{deltaLabel}</span>
          </span>
        )}
      </div>
      {bottomNote && <div className="mt-0.5 truncate text-[12px]" style={{ color: C.subText }}>{bottomNote}</div>}
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
      textStyle: { color: C.subText, fontSize: 12 },
    },
    tooltip: { trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 13 } },
    xAxis: { type: 'category', data: rows.map((r) => r.label), boundaryGap: false, ...axisStyle({ interval: range === 'hours24' ? 3 : 'auto' }) },
    yAxis: { type: 'value', minInterval: 1, name: '件', nameTextStyle: { color: C.subText, fontSize: 12 }, splitLine: { lineStyle: { color: C.split } }, ...axisStyle() },
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
        <button key={key} onClick={() => setRange(key)} className="rounded px-2 py-0.5 text-[12px] transition"
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
      textStyle: { color: C.text, fontSize: 13 }, formatter: '{b}：{c} 件（{d}%）',
    },
    // 环形中心显示总量
    title: total > 0 ? {
      text: String(total), subtext: '总件数',
      left: 'center', top: '36%',
      textStyle: { color: C.text, fontSize: 32, fontWeight: 'bold', fontFamily: 'monospace' },
      subtextStyle: { color: C.subText, fontSize: 13 },
    } : undefined,
    graphic: total === 0 ? [{
      type: 'text', left: 'center', top: 'middle',
      style: { text: '暂无数据', fill: C.subText, fontSize: 14 },
    }] : undefined,
    series: [{
      type: 'pie', radius: ['48%', '70%'], center: ['50%', '46%'],
      label: { color: C.text, fontSize: 13, width: 100, overflow: 'break', formatter: '{b}\n{c}件 · {d}%' },
      labelLine: { length: 14, length2: 10, lineStyle: { color: C.axis } },
      itemStyle: { borderColor: '#0B131C', borderWidth: 1 },
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
      textStyle: { color: C.text, fontSize: 13 },
      formatter: (ps) => {
        const p = ps?.[0]
        return p ? `${p.name}：${p.value} 件（${pct(p.value)}%）` : ''
      },
    },
    xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: C.split } }, ...axisStyle({ fontSize: 11 }) },
    yAxis: {
      type: 'category', inverse: true, data: data.map((d) => d.name),
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      axisLabel: { color: C.text, fontSize: 13, interval: 0, margin: 10 },
    },
    series: [{
      type: 'bar', barWidth: 14,
      data: data.map((d, i) => ({
        value: d.value || 0,
        itemStyle: { color: BLUE_PALETTE[i % BLUE_PALETTE.length], borderRadius: [0, 2, 2, 0] },
      })),
      label: {
        show: true, position: 'right', color: C.text, fontSize: 13, fontFamily: 'monospace',
        formatter: (p) => `${p.value} 件 · ${pct(p.value)}%`,
      },
    }],
  }
}

// 严重度堆叠条形图：段内白字数值（仅非 0 段显示）
const SEG_LABEL = {
  show: true, position: 'inside', color: '#FFFFFF', fontSize: 12,
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
      textStyle: { color: C.subText, fontSize: 12 },
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 13 } },
    xAxis: { type: 'value', minInterval: 1, name: '件', nameTextStyle: { color: C.subText, fontSize: 12 }, splitLine: { lineStyle: { color: C.split } }, ...axisStyle() },
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
          n: { color: C.text, fontSize: 13, lineHeight: 17, align: 'right' },
          t: { color: C.subText, fontSize: 11, lineHeight: 14, align: 'right' },
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
        <button key={key} onClick={() => setTab(key)} className="rounded px-2 py-0.5 text-[12px] transition"
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
// onDrill：点击节点卡片下钻该节点停留工单（完成节点 → 全流程已解决工单）
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
          <span className="text-[11px] uppercase tracking-[2px]" style={{ color: C.subText }}>FLOW</span>
          <select
            value={selectValue}
            onChange={(e) => onSelect(e.target.value)}
            className="max-w-[240px] cursor-pointer truncate rounded border px-2 py-1 text-[13px] outline-none transition focus:ring-1"
            style={{ borderColor: 'rgba(96,138,188,0.45)', color: C.text, background: C.controlBg }}
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
      <div className="mb-2 flex shrink-0 items-center gap-1.5 text-[12px]" style={{ color: C.subText }}>
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
                        ? `点击查看「${n.name}」${n.key === '_finished' ? '已解决' : '停留'}工单列表`
                        : `${n.name}${n.group ? ` · ${n.group}` : ''}`}
                      onClick={onDrill ? () => onDrill({
                        kind: 'tickets',
                        title: `「${n.name}」${n.key === '_finished' ? '已解决工单' : '节点停留工单'}`,
                        subtitle: '处置流转下钻',
                        // 普通节点计数限定当前展示流程（多流程节点 key 可能重名），下钻同步限定；
                        // 已完结节点为全流程已解决口径（后端计数已不再限定流程，下钻同步不限定）
                        filters: n.key === '_finished'
                          ? { status: 'completed' }
                          : { nodeKey: n.key, flowId: activeFlow?.id ?? null },
                      }) : undefined}
                      className={`flex min-w-0 w-full cursor-pointer flex-col items-center rounded-md border px-2 py-2 transition-all duration-300 hover:brightness-125 ${active ? 'node-glow' : ''}`}
                      style={{
                        borderColor: active ? `${C.cyan}99` : 'rgba(96,138,188,0.28)',
                        background: active
                          ? 'linear-gradient(160deg, rgba(69,184,205,0.26), rgba(255,255,255,0.05))'
                          : n.key === '_finished' && n.current > 0
                            ? 'linear-gradient(160deg, rgba(65,208,140,0.16), rgba(255,255,255,0.05))'
                            : 'rgba(255,255,255,0.05)',
                      }}
                    >
                      <div className="w-full truncate text-center text-[14px] font-medium" style={{ color: C.text }}>{n.name}</div>
                      {n.group && <div className="w-full truncate text-center text-[11px]" style={{ color: C.subText }}>{n.group}</div>}
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
                      className="count-bounce inline-block font-mono text-[26px] font-bold leading-none tabular-nums"
                      style={{ color, textShadow: active ? `0 0 10px ${C.cyan}55` : 'none' }}>
                      {n.current}
                    </span>
                    <span className="shrink-0 text-[11px]" style={{ color: C.subText }}>{finished ? '✓ 已解决' : '当前停留'}</span>
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
          <span className="text-[12px]" style={{ color: C.subText }}>{list.length} 队 · 共 {total} 件</span>
          {onDrill && (
            <button
              onClick={() => onDrill({ kind: 'teams', title: '提交团队 · 全部团队数据', subtitle: '全部团队工单排名' })}
              title="弹窗查看全部团队的排名明细（点击团队行可继续下钻其工单列表）"
              className="rounded px-2 py-0.5 text-[12px] transition hover:brightness-125"
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
                    ? 'linear-gradient(165deg, rgba(245,200,79,0.14), rgba(255,255,255,0.05))'
                    : C.innerBg,
                }}>
                <div className="flex min-w-0 items-center gap-1.5">
                  {meta ? (
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-bold"
                      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>
                      {i + 1}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[12px] tabular-nums" style={{ color: C.subText }}>{i + 1}</span>
                  )}
                  <span className="max-w-full truncate text-[13px]" style={{ color: C.text }}>{d.name}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-[19px] font-bold leading-none tabular-nums"
                    style={{
                      color: champion ? '#F5C84F' : C.lightBlue,
                      textShadow: champion ? '0 0 8px rgba(245,200,79,0.35)' : 'none',
                    }}>
                    {d.value}
                  </span>
                  <span className="text-[11px] tabular-nums" style={{ color: C.subText }}>{pct(d.value)}%</span>
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
              style={{ borderColor: 'rgba(147,166,184,0.4)', background: C.innerBgSoft }}>
              <span className="text-[12px]" style={{ color: C.subText }}>其余 {rest.length} 队</span>
              <span className="font-mono text-[15px] font-bold tabular-nums" style={{ color: C.subText }}>{restTotal} 件</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

// ============ ④ 中央-下：最新工单实时列表（48px 行高 / 状态筛选 / 纵向自动滚动 / 新行渐隐高亮） ============
// 等级 pill 配色：紧急=红、高=橙、中=蓝、低=灰；紧急另加「!」做色彩之外的告警编码（色盲无障碍）
const PRIORITY_PILL = {
  critical: { bg: 'rgba(255,77,79,0.16)', color: C.red, border: 'rgba(255,77,79,0.5)' },
  high: { bg: 'rgba(255,169,64,0.13)', color: C.orange, border: 'rgba(255,169,64,0.42)' },
  medium: { bg: 'rgba(78,138,212,0.15)', color: C.lightBlue, border: 'rgba(78,138,212,0.42)' },
  low: { bg: 'rgba(147,166,184,0.14)', color: C.subText, border: 'rgba(147,166,184,0.35)' },
}

// 状态筛选项（与工单状态枚举、列表「状态」列文案一致；计数按筛选前全量口径）
const LIVE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'processing', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
]
const ROW_UNIT = 52        // 单行占位高度 = 48px 行高 + 4px 行间距（滚动位移按此整数倍计算）
const LIVE_MAX_ROWS = 100  // 最多渲染行数（防超长 DOM；筛选计数仍展示全量）

// status/onStatus：状态筛选由父组件持有（便于快捷键 1-4 与 URL 参数联动）
function LiveList({ latest, tickets, onDrill, status = 'all', onStatus }) {
  const [hovering, setHovering] = useState(false)
  const [viewportH, setViewportH] = useState(0)
  const [speed, setSpeed] = useState(readSpeed)
  const [quick, setQuick] = useState({ timeout: false, critical: false, watch: false })
  const [watchIds, setWatchIds] = useState(readWatchIds)
  const viewportRef = useRef(null)
  const hoveringRef = useRef(false)
  const reduceMotion = usePrefersReducedMotion()
  // 新工单识别：仅在「同一筛选口径」下新增的 id 高亮，切换筛选时不整列表闪烁
  const seenRef = useRef({ scope: null, ids: new Set() })
  const setStatus = (v) => { if (onStatus) onStatus(v) }
  const watchSet = useMemo(() => new Set(watchIds), [watchIds])

  // ★关注：写 localStorage（跨刷新保留），关注工单在列表中置顶
  const toggleWatch = (id) => {
    setWatchIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      try { window.localStorage.setItem(WATCH_KEY, JSON.stringify(next)) } catch { /* 忽略存储异常 */ }
      return next
    })
  }

  const changeSpeed = (v) => {
    setSpeed(v)
    try { window.localStorage.setItem(SPEED_KEY, String(v)) } catch { /* 忽略存储异常 */ }
  }

  // 数据池：下钻工单集（全量）∪ 最新列表（覆盖同 id 的新鲜字段，保证高频轮询能看到新工单）
  const pool = useMemo(() => {
    const map = new Map()
    if (Array.isArray(tickets)) tickets.forEach((t) => map.set(t.id, t))
    if (Array.isArray(latest)) latest.forEach((t) => map.set(t.id, { ...(map.get(t.id) || {}), ...t }))
    // 排序：★关注置顶 → 近 24 小时内超时 → 创建时间倒序
    const recent = isoLocal(new Date(Date.now() - 24 * 3600 * 1000))
    const urgent = (r) => (r.timeout && (r.created_at || '') >= recent ? 1 : 0)
    const watched = (r) => (watchSet.has(r.id) ? 1 : 0)
    return [...map.values()].sort(
      (a, b) => watched(b) - watched(a) || urgent(b) - urgent(a)
        || (b.created_at || '').localeCompare(a.created_at || ''),
    )
  }, [tickets, latest, watchSet])

  const counts = useMemo(() => {
    const c = { all: pool.length, processing: 0, completed: 0, cancelled: 0, timeout: 0, critical: 0, watch: 0 }
    for (const r of pool) {
      if (Object.prototype.hasOwnProperty.call(c, r.status)) c[r.status] += 1
      if (r.timeout && r.status === 'processing') c.timeout += 1
      if (r.priority === 'critical') c.critical += 1
      if (watchSet.has(r.id)) c.watch += 1
    }
    return c
  }, [pool, watchSet])

  const filtered = useMemo(
    () => pool.filter((r) => (status === 'all' || r.status === status)
      && (!quick.timeout || (r.timeout && r.status === 'processing'))
      && (!quick.critical || r.priority === 'critical')
      && (!quick.watch || watchSet.has(r.id))),
    [pool, status, quick, watchSet],
  )
  const rows = useMemo(() => filtered.slice(0, LIVE_MAX_ROWS), [filtered])
  const truncated = filtered.length > rows.length
  const scopeKey = `${status}|${quick.timeout ? 1 : 0}${quick.critical ? 1 : 0}${quick.watch ? 1 : 0}`

  const newIds = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id))
    const prev = seenRef.current
    const fresh = prev.scope === scopeKey ? new Set([...ids].filter((id) => !prev.ids.has(id))) : new Set()
    seenRef.current = { scope: scopeKey, ids }
    return fresh
  }, [rows, scopeKey])

  // 滚动视口高度（面板固定高度，首次渲染后测量；窗口/全屏变化由 ResizeObserver 跟随）
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const update = () => setViewportH(el.clientHeight)
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const unitH = rows.length * ROW_UNIT
  // 内容不足一屏时不滚动（避免空转）；系统开启"减少动态效果"时改为可手动滚动
  const canScroll = !reduceMotion && rows.length > 0 && unitH > viewportH
  // 复制份数：保证循环位移期间视口始终被内容填满
  const copies = canScroll ? Math.max(2, Math.ceil(viewportH / unitH) + 1) : 1

  // 自动滚动：requestAnimationFrame 累加 scrollTop（一份内容走完即回卷，内容由多份复制保证无缝）；
  // 数据刷新不影响滚动进度（不重建滚动容器），悬停时通过 ref 跳过累加，移出继续
  useEffect(() => {
    const el = viewportRef.current
    if (!el || !canScroll) return undefined
    let raf = 0
    let last = performance.now()
    let acc = 0
    const step = (t) => {
      // 上限 64ms：切后台/长时间挂起回来时不会瞬移一大段
      const dt = Math.min(64, Math.max(0, t - last))
      last = t
      if (!hoveringRef.current) {
        acc += (speed * dt) / 1000
        const px = Math.floor(acc)
        if (px > 0) {
          acc -= px
          el.scrollTop += px
          if (el.scrollTop >= unitH) el.scrollTop -= unitH
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [canScroll, unitH, speed])

  // 切换筛选口径后回到列表顶部
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [scopeKey])

  const setHover = (v) => {
    hoveringRef.current = v
    setHovering(v)
  }

  const renderRow = (r, ci) => {
    const isNew = newIds.has(r.id)
    const watched = watchSet.has(r.id)
    const time = r.created_at ? r.created_at.slice(11, 19) : '--'
    const pill = PRIORITY_PILL[r.priority] || PRIORITY_PILL.low
    return (
      <div key={`${ci}-${r.id}`}
        onClick={onDrill ? () => onDrill({
          kind: 'detail', ticket: r,
          title: `工单详情 · ${r.ticket_no}`, subtitle: '实时列表下钻',
        }) : undefined}
        title={onDrill ? '点击查看工单详情' : undefined}
        className={`relative mb-1 flex h-12 cursor-pointer items-center rounded border px-2 text-[14px] transition hover:brightness-125 ${isNew ? 'row-enter' : ''}`}
        style={{
          borderColor: r.timeout ? 'rgba(255,77,79,0.55)' : watched ? 'rgba(229,120,50,0.35)' : 'rgba(96,138,188,0.18)',
          background: r.timeout ? 'rgba(255,77,79,0.10)' : watched ? 'rgba(229,120,50,0.08)' : C.innerBg,
        }}>
        {/* 新工单插入：2 秒青色渐隐高亮（覆盖层不与行背景冲突） */}
        {isNew && <span className="row-flash pointer-events-none absolute inset-0 rounded" />}
        {/* ★关注：点击切换，关注工单置顶（不随滚动被大量新工单淹没） */}
        <button type="button"
          onClick={(e) => { e.stopPropagation(); toggleWatch(r.id) }}
          title={watched ? '取消关注' : '关注该工单（列表中置顶）'}
          aria-label={watched ? '取消关注工单' : '关注工单'} aria-pressed={watched}
          className="mr-1 flex w-5 shrink-0 items-center justify-center transition hover:brightness-150">
          <Star className="h-3.5 w-3.5" style={{ color: watched ? C.orange : 'rgba(147,166,184,0.42)' }}
            fill={watched ? C.orange : 'none'} />
        </button>
        <span className="w-[72px] shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>{time}</span>
        <span className="w-[150px] shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
        <span className="min-w-0 flex-1 truncate" style={{ color: C.text }} title={r.title}>
          {r.timeout && <span className="mr-1 inline-flex items-center gap-0.5 rounded px-1 py-px text-[12px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
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
        <span className="w-[64px] shrink-0 text-center" style={{ color: STATUS_COLOR[r.status] || C.subText }}>
          {r.status === 'completed' ? '✓ ' : ''}{r.status_label}
        </span>
        <span className="w-[92px] shrink-0 truncate text-right" style={{ color: C.subText }}>{r.current_node_name || '--'}</span>
      </div>
    )
  }

  // 滚动状态提示色：自动滚动=青色，悬停暂停=橙色
  const liveColor = canScroll ? (hovering ? C.orange : C.green) : C.subText
  return (
    <Panel
      title="最新工单实时监控"
      subtitle={truncated ? `REALTIME · TOP ${LIVE_MAX_ROWS}` : 'REALTIME LIST'}
      icon={Activity}
      className="h-[396px]"
      alert={(latest || []).some((r) => r.timeout)}
      right={
        <>
          {/* 工单状态筛选（计数按全量口径，点击即筛选实时列表） */}
          <div className="flex items-center gap-1">
            {LIVE_FILTERS.map((f) => {
              const active = status === f.key
              return (
                <button key={f.key} type="button" aria-pressed={active}
                  onClick={() => setStatus(f.key)}
                  title={`筛选：${f.label}（${counts[f.key]} 件）`}
                  className="rounded border px-1.5 py-[2px] text-[12px] transition hover:brightness-125"
                  style={active ? {
                    background: 'rgba(69,184,205,0.16)',
                    borderColor: 'rgba(69,184,205,0.62)',
                    color: C.text,
                    boxShadow: '0 0 8px rgba(69,184,205,0.18)',
                  } : {
                    background: 'transparent',
                    borderColor: 'rgba(96,138,188,0.30)',
                    color: C.subText,
                  }}>
                  {f.label}
                  <span className="ml-1 font-mono tabular-nums" style={{ opacity: 0.72 }}>{counts[f.key]}</span>
                </button>
              )
            })}
          </div>
          {/* 滚动状态（悬停列表自动暂停） */}
          <span className="ml-1 flex items-center gap-1 text-[12px]" style={{ color: liveColor }}>
            <span className={`h-1.5 w-1.5 rounded-full ${hovering && canScroll ? '' : 'animate-pulse'}`}
              style={{ background: liveColor, boxShadow: `0 0 6px ${liveColor}` }} />
            {canScroll ? (hovering ? '已暂停' : '自动滚动') : '实时更新'}
          </span>
        </>
      }
      bodyClassName="flex flex-col px-3 py-2"
    >
      {/* 快捷筛选 + 滚动速度：仅超时 / 仅紧急 / ★关注（与状态筛选叠加生效） */}
      <div className="mb-1 flex shrink-0 items-center gap-1.5 text-[12px]">
        {[
          { key: 'timeout', label: '仅超时', n: counts.timeout, color: C.red, bg: 'rgba(255,77,79,0.16)', border: 'rgba(255,77,79,0.52)' },
          { key: 'critical', label: '仅紧急', n: counts.critical, color: C.orange, bg: 'rgba(255,169,64,0.14)', border: 'rgba(255,169,64,0.5)' },
          { key: 'watch', label: '★关注', n: counts.watch, color: C.cyan, bg: 'rgba(69,184,205,0.14)', border: 'rgba(69,184,205,0.5)' },
        ].map((q) => {
          const active = quick[q.key]
          return (
            <button key={q.key} type="button" aria-pressed={active}
              onClick={() => setQuick((s) => ({ ...s, [q.key]: !s[q.key] }))}
              title={`快捷筛选：${q.label}（${q.n} 件）${active ? ' · 再点取消' : ''}`}
              className="rounded border px-1.5 py-[1px] transition hover:brightness-125"
              style={active
                ? { background: q.bg, borderColor: q.border, color: q.color }
                : { background: 'transparent', borderColor: 'rgba(96,138,188,0.30)', color: C.subText }}>
              {q.label}
              <span className="ml-1 font-mono tabular-nums" style={{ opacity: 0.72 }}>{q.n}</span>
            </button>
          )
        })}
        {truncated && (
          <span className="ml-1 text-[11px]" style={{ color: C.subText, opacity: 0.8 }}>
            共 {filtered.length} 件 · 显示前 {LIVE_MAX_ROWS}
          </span>
        )}
        <span className="ml-auto text-[11px]" style={{ color: C.subText }}>速度</span>
        <div className="flex items-center overflow-hidden rounded border" style={{ borderColor: 'rgba(96,138,188,0.30)' }}>
          {SPEED_OPTIONS.map((o) => (
            <button key={o.value} type="button" aria-pressed={speed === o.value}
              onClick={() => changeSpeed(o.value)}
              title={`自动滚动速度：${o.label}（${o.value}px/s）`}
              className="px-1.5 py-[1px] transition hover:brightness-125"
              style={speed === o.value
                ? { background: 'rgba(69,184,205,0.16)', color: C.text }
                : { background: 'transparent', color: C.subText }}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {/* 表头（字号 +3px，远距可读） */}
      <div className="flex shrink-0 items-center px-2 pb-1.5 text-[14px]" style={{ color: C.subText }}>
        <span className="mr-1 w-5 shrink-0" />
        <span className="w-[72px] shrink-0">时间</span>
        <span className="w-[150px] shrink-0">工单编号</span>
        <span className="min-w-0 flex-1 truncate">工单标题</span>
        <span className="w-[56px] shrink-0 text-center">等级</span>
        <span className="w-[64px] shrink-0 text-center">状态</span>
        <span className="w-[92px] shrink-0 text-right">当前节点</span>
      </div>
      {/* 滚动视口：鼠标移入即暂停，移出续播（遮罩放在滚动容器外层，避免随内容滚走） */}
      <div className="relative min-h-0 flex-1">
        <div ref={viewportRef}
          className={`h-full ${canScroll ? 'overflow-hidden' : 'overflow-y-auto'}`}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onTouchStart={() => setHover(true)}
          onTouchEnd={() => setHover(false)}>
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px]" style={{ color: C.subText }}>
              {status === 'all' && !quick.timeout && !quick.critical && !quick.watch
                ? '暂无工单数据'
                : '当前筛选条件下暂无工单'}
            </div>
          ) : (
            <div key={scopeKey}>
              {Array.from({ length: copies }).map((_, ci) => (
                <div key={ci} aria-hidden={ci > 0 ? 'true' : undefined}>
                  {rows.map((r) => renderRow(r, ci))}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 上下渐隐遮罩：滚动出入更柔和，避免行被硬切 */}
        {canScroll && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-4"
              style={{ background: `linear-gradient(180deg, ${C.panelFade} 0%, transparent 100%)`, opacity: 0.9 }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4"
              style={{ background: `linear-gradient(0deg, ${C.panelFade} 0%, transparent 100%)`, opacity: 0.9 }} />
          </>
        )}
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
      style={{ borderColor: 'rgba(96,138,188,0.28)', background: C.innerBg }}>
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="truncate text-[12px]" style={{ color: C.subText }}>{name}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[18px] font-bold tabular-nums" style={{ color }}>{value}</div>
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
      title: { show: true, offsetCenter: [0, '42%'], color: C.subText, fontSize: 13 },
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
          <div className="text-[12px]" style={{ color: C.subText }}>
            响应超时 {sla?.response_overdue_count ?? 0} 件 · 解决超时 {sla?.resolve_overdue_count ?? 0} 件
          </div>
          <div className="my-1 h-px" style={{ background: 'rgba(96,138,188,0.22)' }} />
          <div className="text-[12px] font-medium" style={{ color: C.cyan }}>SLA 目标（响应 / 解决）</div>
          {SLA_PRIORITY_ROWS.map(([key, label]) => {
            const t = targets[key] || {}
            return (
              <div key={key} className="flex items-center gap-2 text-[12px] leading-[16px]">
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
    show: true, position: 'right', color: C.text, fontSize: 13,
    fontFamily: 'monospace', fontWeight: 'bold',
    formatter: (p) => `${fmtInt(totals[p.dataIndex])} 件`,
  }
  return {
    ...CHART_BASE,
    grid: { left: 8, right: 60, top: 30, bottom: 6, containLabel: true },
    legend: {
      data: series.map((s) => s.name), top: 0, right: 8, itemWidth: 12, itemHeight: 8,
      textStyle: { color: C.subText, fontSize: 12 },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: C.tooltipBg, borderColor: C.panelBorder, textStyle: { color: C.text, fontSize: 13 },
      formatter: (ps) => {
        const r = list[ps?.[0]?.dataIndex]
        if (!r) return ''
        const lines = PLATFORM_TIP_COLS.map(([key, label, color]) =>
          `${label}：<b style="color:${color}">${fmtInt(r[key])}</b>`)
        return `<div style="font-weight:600;margin-bottom:4px;">${r.name}</div>${lines.join('<br/>')}`
      },
    },
    xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: C.split } }, ...axisStyle({ fontSize: 11 }) },
    yAxis: {
      type: 'category', inverse: true, data: names,
      axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
      axisLabel: { color: C.text, fontSize: 13, interval: 0, margin: 10 },
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
      <div className="flex h-14 items-center justify-center gap-2 rounded-md border text-[13px] backdrop-blur-xl"
        style={{
          background: C.panelBg, borderColor: C.panelBorder, color: C.subText,
          backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        }}>
        <CheckCircle2 className="h-4 w-4" style={{ color: C.green }} />
        暂无超时 / 紧急告警工单
      </div>
    )
  }
  const r = rows[idx % rows.length]
  return (
    <div className="flex h-14 items-center gap-4 overflow-hidden rounded-md border px-5 backdrop-blur-xl"
      style={{
        background: C.panelBg, borderColor: 'rgba(255,77,79,0.35)',
        backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        boxShadow: '0 0 14px rgba(255,77,79,0.10)',
      }}>
      <span className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[13px] font-medium"
        style={{ background: 'rgba(255,77,79,0.16)', color: C.red, border: `1px solid ${C.red}66` }}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: C.red, boxShadow: `0 0 6px ${C.red}` }} />! 告警播报
      </span>
      <div key={r.id} className="marquee-enter flex min-w-0 flex-1 items-center gap-4 text-[15px]">
        <span className="shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>
          {r.created_at ? r.created_at.slice(0, 19).replace('T', ' ') : '--'}
        </span>
        <span className="shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
        <span className="min-w-0 flex-1 truncate font-medium" style={{ color: C.text }}>{r.title}</span>
        {r.timeout && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[12px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>
            ! 超时预警
          </span>
        )}
        <span className="shrink-0" style={{ color: r.priority === 'critical' ? C.red : C.orange }}>
          等级：{r.priority === 'critical' ? '! ' : ''}{r.priority_label}
        </span>
        <span className="shrink-0" style={{ color: r.status === 'completed' ? C.green : C.lightBlue }}>
          状态：{r.status === 'completed' ? '✓ ' : ''}{r.status_label}
        </span>
        <span className="shrink-0 text-[13px]" style={{ color: C.subText }}>当前节点：{r.current_node_name || '--'}</span>
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
// activeToday=处理中且今日活跃（KPI「处理中」卡底部「今日活跃」小字口径）/
// timeoutOnly=超时预警（进行中且超 SLA，KPI 口径）/ slaTimeout=SLA 超时工单（不限状态，
// 超时率分子口径，含已完结超时）/ nodeKey+flowId=流转节点停留（多流程节点 key 可能重名，
// 按当前展示流程限定）；status=completed 与流转图「已完结」计数一致（全流程已解决）/
// closedAll=已关闭（closed_at 非空）/
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

// 弹窗表格通用分页器（工单列表默认 20 件/页，团队列表 12 队/页）
// sizes/onSizeChange：可选每页条数切换（工单列表用 10/20/50）
function Pager({ total, page, size, unit = '件', onChange, sizes, onSizeChange }) {
  const pages = Math.max(1, Math.ceil(total / size))
  const safe = Math.min(page, pages)
  const btnStyle = (disabled) => ({
    borderColor: 'rgba(96,138,188,0.35)',
    color: disabled ? 'rgba(147,166,184,0.5)' : C.text,
    cursor: disabled ? 'not-allowed' : 'pointer',
  })
  return (
    <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[13px]"
      style={{ borderColor: 'rgba(96,138,188,0.22)', color: C.subText }}>
      <span className="flex items-center gap-2">
        共 <b className="font-mono tabular-nums" style={{ color: C.text }}>{total}</b> {unit}
        {sizes && onSizeChange && (
          <select value={size} onChange={(e) => onSizeChange(Number(e.target.value))}
            title="每页条数（大页容量自动窗口化渲染，长列表不卡顿）"
            className="cursor-pointer rounded border px-1 py-0.5 text-[12px] outline-none"
            style={{ colorScheme: 'dark', background: C.controlBg, borderColor: 'rgba(96,138,188,0.35)', color: C.paleBlue }}>
            {sizes.map((s) => <option key={s} value={s}>{s} {unit}/页</option>)}
          </select>
        )}
      </span>
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
// 分页 + 每页条数可调（10/20/50）；超过 20 行自动窗口化渲染，只挂载可视区行（长列表不卡顿）
function TicketTable({ rows, onRowClick }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  useEffect(() => { setPage(1) }, [rows, size])
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const safe = Math.min(page, pages)
  const view = useMemo(() => rows.slice((safe - 1) * size, safe * size), [rows, safe, size])
  // 窗口化渲染：行高 42 + 间距 4 = 46px；滚动时只渲染可视区附近的行
  const ROW_H = 46
  const listRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [boxH, setBoxH] = useState(0)
  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const update = () => setBoxH(el.clientHeight)
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const virtual = view.length > 20
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - 2) : 0
  const end = virtual ? Math.min(view.length, start + Math.ceil((boxH || 460) / ROW_H) + 5) : view.length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 列头 */}
      <div className="flex shrink-0 items-center px-3 pb-1.5 text-[13px]" style={{ color: C.subText }}>
        <span className="w-[128px] shrink-0">创建时间</span>
        <span className="w-[150px] shrink-0">工单编号</span>
        <span className="min-w-0 flex-1 truncate">工单标题</span>
        <span className="w-[96px] shrink-0 text-center">提交团队</span>
        <span className="w-[118px] shrink-0 truncate">来源平台</span>
        <span className="w-[64px] shrink-0 text-center">等级</span>
        <span className="w-[68px] shrink-0 text-center">状态</span>
        <span className="w-[100px] shrink-0 truncate text-right">当前节点</span>
      </div>
      <div ref={listRef} onScroll={(e) => setScrollTop(e.target.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {view.length === 0 && (
          <div className="py-10 text-center text-[13px]" style={{ color: C.subText }}>暂无符合条件的工单</div>
        )}
        {virtual && start > 0 && <div style={{ height: start * ROW_H }} />}
        {view.slice(start, end).map((r) => {
          const pill = PRIORITY_PILL[r.priority] || PRIORITY_PILL.low
          return (
            <div key={r.id} onClick={onRowClick ? () => onRowClick(r) : undefined}
              title={onRowClick ? '点击查看工单详情' : undefined}
              className="mb-1 flex min-h-[42px] cursor-pointer items-center rounded border px-2 text-[14px] transition hover:brightness-125"
              style={{
                borderColor: r.timeout ? 'rgba(255,77,79,0.5)' : 'rgba(96,138,188,0.18)',
                background: r.timeout ? 'rgba(255,77,79,0.08)' : C.innerBg,
              }}>
              <span className="w-[128px] shrink-0 font-mono tabular-nums" style={{ color: C.subText }}>
                {r.created_at ? r.created_at.slice(5, 16).replace('T', ' ') : '--'}
              </span>
              <span className="w-[150px] shrink-0 font-mono" style={{ color: C.lightBlue }}>{r.ticket_no}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }}>
                {r.timeout && (
                  <span className="mr-1 rounded px-1 py-px text-[12px]" style={{ background: 'rgba(255,77,79,0.18)', color: C.red }}>超时</span>
                )}
                {r.title}
              </span>
              <span className="w-[96px] shrink-0 truncate text-center" style={{ color: C.paleBlue }}>{r.team || '--'}</span>
              <span className="w-[118px] shrink-0 truncate" style={{ color: C.subText }}>{r.platform || '--'}</span>
              <span className="w-[64px] shrink-0 text-center">
                <span className="inline-flex items-center rounded-full border px-1.5 py-px text-[12px]"
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
        {virtual && end < view.length && <div style={{ height: (view.length - end) * ROW_H }} />}
      </div>
      <Pager total={rows.length} page={page} size={size} onChange={setPage}
        sizes={[10, 20, 50]} onSizeChange={setSize} />
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
      <div className="flex shrink-0 items-center px-3 pb-1.5 text-[13px]" style={{ color: C.subText }}>
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
              className="flex min-h-[42px] cursor-pointer items-center rounded border px-2 text-[14px] transition hover:brightness-125"
              style={{
                borderColor: champion ? 'rgba(245,200,79,0.45)' : 'rgba(96,138,188,0.18)',
                background: champion ? 'rgba(245,200,79,0.06)' : C.innerBg,
              }}>
              <span className="w-[64px] shrink-0 text-center">
                {meta ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[12px] font-bold"
                    style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>{rank}</span>
                ) : (
                  <span className="font-mono text-[13px] tabular-nums" style={{ color: C.subText }}>{rank}</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.text }}>{d.name}</span>
              <span className="w-[96px] shrink-0 text-right font-mono text-[16px] font-bold tabular-nums"
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
      <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[13px]"
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

// ============ 工单时间线（下钻详情内：创建 / 每个节点到达 / 完结） ============
// 动作中文与工单中心详情页 ACTION_META 同语义；配色沿用大屏主题
const TL_ACTION = {
  create: { label: '发起', color: C.cyan },
  submit: { label: '提交流转', color: C.lightBlue },
  arrive: { label: '到达', color: C.techBlue },
  rollback: { label: '退回上一步', color: C.orange },
  transfer: { label: '转办', color: C.cyan },
  claim: { label: '认领', color: C.techBlue },
  urge: { label: '催办', color: C.orange },
  cancel: { label: '取消', color: C.red },
  end: { label: '完成', color: C.green },
  current: { label: '处理中', color: C.orange },
}

// 后端时间串（YYYY-MM-DDTHH:mm:ss 或含 T 的 ISO）→ 展示串（YYYY-MM-DD HH:mm:ss）
function fmtTimeStr(v) {
  if (!v) return null
  return String(v).replace('T', ' ').slice(0, 19)
}

// 两个时间串之间的间隔（分钟 → 可读时长）；非法/倒序返回 null
function fmtTimeGap(from, to) {
  if (!from || !to) return null
  const a = new Date(String(from).replace(' ', 'T')).getTime()
  const b = new Date(String(to).replace(' ', 'T')).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return fmtDur(Math.max(0, Math.round((b - a) / 60000)))
}

/**
 * 构建节点时间线：创建 → 各节点处理/到达 → 当前节点 → 完成/取消。
 * - records：/tickets/{id} 返回的节点处理记录（node_key / node_name / action / handler_name / created_at / route_to / comment）
 * - snapshot：同一接口返回的流程快照，用于把 route_to 解析成节点中文名
 * - 到达时间口径：一次提交/退回的时间即下一节点的到达时间（与流转引擎一致）
 * - 无记录（演示数据 / 拉取失败）时退化为：创建 → 当前节点（处理中）→ 完成/取消
 */
function buildTimeline(t, records, snapshot) {
  if (!t) return []
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  const nodeOf = (key) => (key ? nodes.find((n) => n && n.key === key) || null : null)
  const nameOf = (key) => (key ? nodeOf(key)?.name || key : '')
  const items = []
  const recs = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.created_at)
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const createdRec = recs.find((r) => r.action === 'create')
  let prev = fmtTimeStr(t.created_at) || fmtTimeStr(createdRec?.created_at)
  let lastArrivalKey = null
  let endTime = null
  items.push({
    key: 'create',
    kind: 'create',
    title: '创建工单',
    who: createdRec?.handler_name || t.created_by_name || '',
    note: [createdRec?.node_name || nameOf(createdRec?.node_key), t.team, t.platform].filter(Boolean).join(' · '),
    time: prev,
  })
  recs.forEach((r, i) => {
    if (r.action === 'create' || r.action === 'comment') return
    const at = fmtTimeStr(r.created_at)
    const key = `r-${r.id ?? i}`
    // 完结/取消记录只补最终时间（最终事件由工单状态统一生成，避免重复）
    if (r.action === 'end' || r.action === 'cancel') {
      endTime = at || endTime
      return
    }
    const nodeName = r.node_name || nameOf(r.node_key) || '--'
    const meta = TL_ACTION[r.action] || TL_ACTION.submit
    items.push({
      key,
      kind: r.action || 'submit',
      title: `${meta.label} · 节点「${nodeName}」`,
      who: r.handler_name || '',
      note: r.comment || '',
      time: at,
    })
    // 提交/退回后立刻到达下一节点（结束节点由完结事件承载，不再重复一条到达）
    if ((r.action === 'submit' || r.action === 'rollback') && r.route_to) {
      const target = nodeOf(r.route_to)
      const isEnd = r.route_to === 'end' || (target && target.type === 'end')
      if (!isEnd) {
        items.push({
          key: `${key}-arrive`,
          kind: 'arrive',
          title: `到达节点「${nameOf(r.route_to)}」`,
          who: '',
          note: '',
          time: at,
        })
        lastArrivalKey = r.route_to
      }
    }
    prev = at || prev
  })
  // 当前停留节点（进行中）：已由「到达」事件体现时只补“处理中”标记，避免重复
  if (t.status === 'processing' && t.current_node_name) {
    const tail = items[items.length - 1]
    if (lastArrivalKey && lastArrivalKey === t.current_node_key && tail) {
      tail.current = true
      tail.who = tail.who || t.claimed_by_name || ''
    } else {
      items.push({
        key: 'current',
        kind: 'current',
        title: `当前节点「${t.current_node_name}」`,
        who: t.claimed_by_name || '',
        note: '处理中',
        time: prev,
      })
    }
  }
  if (t.status === 'completed' || t.status === 'cancelled') {
    items.push({
      key: 'end',
      kind: t.status === 'completed' ? 'end' : 'cancel',
      title: t.status === 'completed' ? '工单完成' : '工单取消',
      who: '',
      note: '',
      time: endTime || fmtTimeStr(t.closed_at) || prev,
    })
  }
  // 每段耗时（相对上一事件，便于看出节点停留时长）
  let last = null
  items.forEach((it) => {
    if (it.time && last) it.gap = fmtTimeGap(last, it.time)
    if (it.time) last = it.time
  })
  return items
}

function TicketTimeline({ items, loading, error }) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold" style={{ color: C.text }}>处理时间线</span>
        <span className="text-[12px]" style={{ color: C.subText }}>创建 / 每个节点到达 / 完结时间</span>
        {loading && <span className="text-[12px]" style={{ color: C.cyan }}>节点记录加载中…</span>}
        {!loading && error && (
          <span className="text-[12px]" style={{ color: C.orange }}>节点记录获取失败，已按工单字段兜底</span>
        )}
      </div>
      <div className="relative pl-5">
        <span className="absolute bottom-2 left-[5px] top-2 w-px" style={{ background: 'rgba(96,138,188,0.26)' }} />
        <div className="space-y-2">
          {items.map((it) => {
            const meta = TL_ACTION[it.kind] || TL_ACTION.submit
            return (
              <div key={it.key} className="relative rounded border px-3 py-1.5"
                style={{ borderColor: 'rgba(96,138,188,0.22)', background: C.innerBg }}>
                <span className="absolute -left-5 top-[11px] h-[9px] w-[9px] rounded-full border-2"
                  style={{ borderColor: meta.color, background: C.deepNavy, boxShadow: `0 0 6px ${meta.color}70` }} />
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[14px] font-semibold" style={{ color: C.text }}>{it.title}</span>
                  <span className="rounded px-1.5 py-px text-[11px]"
                    style={{ color: meta.color, background: `${meta.color}1f`, border: `1px solid ${meta.color}55` }}>{meta.label}</span>
                  {it.current && (
                    <span className="rounded px-1.5 py-px text-[11px]"
                      style={{ color: C.orange, background: `${C.orange}1f`, border: `1px solid ${C.orange}55` }}>处理中</span>
                  )}
                  {it.who && <span className="text-[12px]" style={{ color: C.subText }}>{it.who}</span>}
                  {it.gap && <span className="text-[11px]" style={{ color: C.subText, opacity: 0.8 }}>+{it.gap}</span>}
                  <span className="ml-auto font-mono tabular-nums text-[13px]" style={{ color: it.time ? C.text : C.subText }}>
                    {it.time || '时间待同步'}
                  </span>
                </div>
                {it.note && (
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-[12px]" style={{ color: C.subText }}>
                    <span className="min-w-0 break-all">{it.note}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// 工单详情（下钻末级）：关键信息栅格 + 处理时间线 + 行动按钮（复制工单号 / 催办 / 在工单中心打开）
// 字段缺失显示 --（兼容真实接口尚未补充的字段）；催办复用工单中心接口（30 分钟限频）
// demo=true（演示数据兜底）：无真实 id，跳过详情接口，时间线按工单字段降级展示
function TicketDetail({ t, demo = false }) {
  const [urging, setUrging] = useState(false)
  // 节点处理记录 + 流程快照：打开详情时按需拉取 /tickets/{id}（快照用于解析流转去向节点名）
  const [detail, setDetail] = useState({ records: [], snapshot: null })
  const [tlLoading, setTlLoading] = useState(false)
  const [tlError, setTlError] = useState(null)
  useEffect(() => {
    if (!t || demo || !t.id) {
      setDetail({ records: [], snapshot: null })
      setTlLoading(false)
      setTlError(null)
      return undefined
    }
    let alive = true
    setTlLoading(true)
    setTlError(null)
    ticketApi.getTicket(t.id)
      .then((d) => {
        if (!alive) return
        setDetail({
          records: Array.isArray(d?.records) ? d.records : [],
          snapshot: d?.flow_snapshot || null,
        })
      })
      .catch((e) => {
        if (!alive) return
        setDetail({ records: [], snapshot: null })
        setTlError(e?.message || '获取失败')
      })
      .finally(() => { if (alive) setTlLoading(false) })
    return () => { alive = false }
  }, [t, demo])
  const timeline = useMemo(() => buildTimeline(t, detail.records, detail.snapshot), [t, detail])
  if (!t) return null
  const pill = PRIORITY_PILL[t.priority] || PRIORITY_PILL.low
  const copyNo = async () => {
    try {
      await navigator.clipboard.writeText(String(t.ticket_no || ''))
      toast.success(`已复制工单号 ${t.ticket_no}`)
    } catch {
      toast.warning('复制失败，请手动选择工单号')
    }
  }
  const urge = () => {
    if (urging) return
    setUrging(true)
    ticketApi.urgeTicket(t.id)
      .then(() => toast.success(`已催办 ${t.ticket_no}，已通知当前处理分组`))
      .catch((e) => toast.error(e?.message || '催办失败（仅发起人/抄送人/管理员可催办，30 分钟内不可重复）'))
      .finally(() => setUrging(false))
  }
  const openTicket = () => {
    // 新标签页打开工单中心详情，不打断大屏投放
    window.open(`/tickets/${t.id}`, '_blank', 'noopener,noreferrer')
  }
  const actionBtn = {
    borderColor: 'rgba(96,138,188,0.40)',
    background: 'rgba(78,138,212,0.10)',
    color: C.paleBlue,
  }
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
        <span className="min-w-0 text-[17px] font-bold" style={{ color: C.text }}>{t.title || '工单详情'}</span>
        <span className="inline-flex items-center rounded-full border px-2 py-px text-[13px]"
          style={{ background: pill.bg, color: pill.color, borderColor: pill.border }}>
          {t.priority === 'critical' ? '! ' : ''}{t.priority_label || '--'}
        </span>
        <span className="rounded px-2 py-px text-[13px]"
          style={{ background: 'rgba(96,138,188,0.14)', color: STATUS_COLOR[t.status] || C.subText, border: '1px solid rgba(96,138,188,0.3)' }}>
          {t.status_label || '--'}
        </span>
        {t.timeout && (
          <span className="rounded px-2 py-px text-[13px]" style={{ background: 'rgba(255,77,79,0.16)', color: C.red, border: '1px solid rgba(255,77,79,0.45)' }}>
            超时预警
          </span>
        )}
      </div>
      {/* 行动区：复制工单号 / 催办（仅进行中）/ 在工单中心打开（新标签页，不打断大屏） */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={copyNo}
          className="flex items-center gap-1 rounded border px-2 py-1 text-[13px] transition hover:brightness-125"
          style={actionBtn}>
          <Copy className="h-3.5 w-3.5" />复制工单号
        </button>
        {t.status === 'processing' && (
          <button type="button" onClick={urge} disabled={urging}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[13px] transition enabled:hover:brightness-125 disabled:opacity-60"
            style={{ ...actionBtn, color: C.orange, borderColor: 'rgba(229,120,50,0.5)', background: 'rgba(229,120,50,0.12)' }}>
          <Send className={`h-3.5 w-3.5 ${urging ? 'animate-pulse' : ''}`} />{urging ? '催办中…' : '一键催办'}
        </button>
        )}
        <button type="button" onClick={openTicket}
          className="flex items-center gap-1 rounded border px-2 py-1 text-[13px] transition hover:brightness-125"
          style={actionBtn}>
          <ExternalLink className="h-3.5 w-3.5" />在工单中心打开
        </button>
        <span className="ml-auto text-[12px]" style={{ color: C.subText, opacity: 0.8 }}>
          提示：催办需具备发起人/抄送人/管理员身份，30 分钟内不可重复
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2.5">
        {items.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b pb-1.5"
            style={{ borderColor: 'rgba(96,138,188,0.15)' }}>
            <span className="shrink-0 text-[13px]" style={{ color: C.subText }}>{k}</span>
            <span className="min-w-0 truncate text-right text-[14px] font-medium" style={{ color: C.text }}>{v}</span>
          </div>
        ))}
      </div>
      {/* 时间线：创建时间 → 每个节点到达时间 → 完成/取消时间（真实模式按需拉取节点记录） */}
      <TicketTimeline items={timeline} loading={tlLoading} error={tlError} />
    </div>
  )
}

// 弹窗壳：层级标记 + 面包屑（可点回跳）+ 关闭；主体按 view.kind 分发
// teams → 全部团队数据（由当前数据源实时聚合，保证与排名条/各级下钻列表口径一致）；
// tickets → 筛选后的工单列表；detail → 单工单详情
// truncated：后端下钻工单集超上限截断时弹窗内提示（仅真实数据模式）
// loading：下钻工单集按需拉取中（大屏轮询不再携带全量下钻集）
// demo：演示数据兜底（详情内时间线跳过 /tickets/{id}，按工单字段降级展示）
function DrillModal({ level, view, stack, tickets, truncated = false, loading = false, demo = false, onJump, onClose, onDrill }) {
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
      style={{ zIndex: 40 + level, background: 'rgba(9,16,26,0.62)', backdropFilter: 'blur(3px)' }}
      onClick={close}>
      <div className="drill-pop flex flex-col overflow-hidden rounded-md border"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: wide ? 920 : 720, maxWidth: '94%',
          height: wide ? 680 : undefined, maxHeight: '78%',
          background: C.panelBg,
          borderColor: C.panelBorder,
          backdropFilter: 'blur(28px) saturate(155%)',
          WebkitBackdropFilter: 'blur(28px) saturate(155%)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 18px rgba(80,130,190,0.12), inset 0 1px 0 rgba(168,200,236,0.14)',
        }}>
        {/* 头部：层级标记 + 面包屑导航 + 副标题 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: 'rgba(96,138,188,0.22)' }}>
          <span className="h-3.5 w-[3px] shrink-0 rounded" style={{ background: C.accent, boxShadow: `0 0 6px ${C.accent}80` }} />
          <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]"
            style={{ color: C.subText, border: '1px solid rgba(96,138,188,0.3)' }} title="下钻层级">L{level + 1}</span>
          {crumbs.map((t, i) => (
            <span key={i} className="flex min-w-0 items-center gap-2 text-[15px]">
              {i > 0 && <span className="shrink-0" style={{ color: C.subText }}>›</span>}
              <span className={i === level ? 'min-w-0 truncate font-bold' : 'min-w-0 shrink-0 cursor-pointer truncate transition hover:underline'}
                style={{ color: i === level ? C.text : C.subText }}
                onClick={i === level ? undefined : () => onJump(i)}
                title={i === level ? undefined : `返回第 ${i + 1} 级：${t}`}>
                {t}
              </span>
            </span>
          ))}
          {view.subtitle && <span className="hidden shrink-0 text-[12px] lg:inline" style={{ color: C.subText }}>{view.subtitle}</span>}
          <button onClick={close} title="关闭（ESC）"
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded border text-[13px] transition hover:brightness-150"
            style={{ borderColor: 'rgba(96,138,188,0.4)', color: C.subText }}>✕</button>
        </div>
        {/* 主体（截断时团队/工单视图均提示：团队数据由下钻工单集聚合，同为截断口径） */}
        {loading && view.kind !== 'detail' && (
          <div className="shrink-0 px-4 pt-2 text-[12px]" style={{ color: C.cyan }}>
            下钻工单集加载中…
          </div>
        )}
        {truncated && view.kind !== 'detail' && (
          <div className="shrink-0 px-4 pt-2 text-[12px]" style={{ color: C.orange }}>
            工单量较大，弹窗仅基于最近一批工单展示（面板统计数字为全量口径）
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
        {view.kind === 'detail' && <TicketDetail t={view.ticket} demo={demo} />}
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
  // 状态文案与后端 STATUS_LABELS / 工单中心保持一致（processing = 进行中）
  status: { processing: '进行中', completed: '已完成', cancelled: '已取消' },
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

  // 流转节点停留（进行中按节点停留；已完结节点 = 全流程已解决工单数，与后端口径一致）
  const flowNodes = DEMO_FLOW_NODES.map((n) => ({ ...n, current: processing.filter((t) => t.current_node_key === n.key).length }))
  flowNodes.push({ key: '_finished', name: '已完结', current: completed.length })

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
  const initialParams = useMemo(readUrlParams, [])
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  // 处置状态流转的流程选择：'' = 自动（进行中工单最多的流程），选择本地持久化
  // URL ?flow= 优先（投屏链接可固定流程）
  const [flowId, setFlowId] = useState(() => {
    if (initialParams.flow) return initialParams.flow
    try { return window.localStorage.getItem('ticket_monitor_flow') || '' } catch { return '' }
  })
  // 弹窗下钻栈：各区块点击 → openDrill(view) 逐级压栈覆盖显示；
  // ESC / 遮罩 / × 关闭当前层，面包屑可回跳任意上级（全程不跳转路由）
  const [drillStack, setDrillStack] = useState([])
  // 下钻工单集：不再随高频轮询下发（响应体从 2000 条降到 KPI+最新），首次全量与打开弹窗时按需拉取
  const [drillSet, setDrillSet] = useState({ tickets: [], truncated: false, total: 0, at: 0 })
  const [drillLoading, setDrillLoading] = useState(false)
  // 实时列表状态筛选提升到父组件：快捷键 1-4 与 URL ?status= 联动
  const [liveStatus, setLiveStatus] = useState(() => initialParams.status || 'all')
  // 数据健康度：ok=正常 / stale=延迟（连续失败 1-2 次）/ offline=断开（≥3 次，保留上一帧继续展示）
  const [health, setHealth] = useState({ status: 'ok', fails: 0, latency: null, error: null })
  // 声光报警：新增超时工单时双音提示 + 顶部红闪；开关本地记忆
  const [alarmOn, setAlarmOn] = useState(() => readFlag(ALARM_KEY, true))
  const [alarmFlash, setAlarmFlash] = useState(false)
  // 值守轮播：每 15s 自动切换重点下钻视图，点击工具条以外区域 / ESC 停止
  const [tourOn, setTourOn] = useState(false)
  // 空闲态：30s 无操作隐藏光标与工具条（投屏不被操作痕迹干扰），移动/按键即恢复
  const [idle, setIdle] = useState(false)
  // 屏幕适配：contain=等比留边（默认，16:9 投影最佳）/ cover=满屏拉伸（非 16:9 拼接屏）
  const [fit, setFit] = useState(() => initialParams.fit || readFit())
  const [scale, setScale] = useState({ x: 1, y: 1 })
  // 刷新频率：右上工具条切换，选择后本地记忆（0 = 暂停自动刷新，仅手动刷新）
  const [refreshMs, setRefreshMs] = useState(
    () => (initialParams.refresh != null ? initialParams.refresh : readRefreshMs()),
  )
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  // KPI 迷你趋势采样（本屏观测最近 24 次，切换流程重置）
  const [kpiHist, setKpiHist] = useState({})
  // ?fullscreen=1：浏览器要求用户手势后才能全屏，首个点击/按键触发（页面角落给出提示）
  const [needFsGesture, setNeedFsGesture] = useState(initialParams.fullscreen)

  const mountedRef = useRef(true)
  const reqRef = useRef({ full: 0, light: 0, drill: 0 })
  const drillSetRef = useRef(drillSet)
  const flowRef = useRef(flowId)
  const timeoutIdsRef = useRef(null)
  const flashTimerRef = useRef(null)
  const audioCtxRef = useRef(null)
  const pendingAutoFsRef = useRef(initialParams.fullscreen)
  const isDemoRef = useRef(false)
  const dataRef = useRef(null)

  useEffect(() => { drillSetRef.current = drillSet }, [drillSet])

  // 演示模式判定：后端聚合接口未返回 team_stats（字段不存在，如旧版后端或接口异常前）→
  // 全屏改用内置演示数据（面板数字与弹窗下钻列表条数严格一致），标题栏显示「演示数据」标记。
  // 后端已接入 team_stats + 下钻工单集 tickets：正常返回即自动切换真实数据，无需改前端。
  // （派生值须在下方各 effect 的依赖数组之前计算，避免闭包/依赖数组读取未初始化变量）
  const isDemo = !Array.isArray(stats?.team_stats)
  const data = isDemo ? DEMO_STATS : stats
  isDemoRef.current = isDemo
  dataRef.current = data
  // 下钻工单集：演示模式用内置数据；真实数据按下钻集（不再随高频轮询下发）
  const drillTickets = isDemo ? DEMO_STATS.tickets : drillSet.tickets
  const drillTruncated = !isDemo && drillSet.truncated
  const kpi = data?.kpi

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      try { audioCtxRef.current?.close?.() } catch { /* 忽略音频上下文关闭异常 */ }
    }
  }, [])

  const selectFlow = (v) => {
    setFlowId(v)
    try { window.localStorage.setItem('ticket_monitor_flow', v) } catch { /* 忽略存储异常 */ }
  }
  const selectRefreshMs = (v) => {
    setRefreshMs(v)
    try { window.localStorage.setItem(REFRESH_KEY, String(v)) } catch { /* 忽略存储异常 */ }
  }
  const selectFit = (v) => {
    setFit(v)
    try { window.localStorage.setItem(FIT_KEY, v) } catch { /* 忽略存储异常 */ }
  }
  const toggleAlarm = () => {
    setAlarmOn((v) => {
      const next = !v
      try { window.localStorage.setItem(ALARM_KEY, next ? '1' : '0') } catch { /* 忽略存储异常 */ }
      return next
    })
  }

  // 整屏自适应：contain 取宽/高缩放比最小值（居中留黑边）；cover 双轴拉伸铺满
  // （全屏切换时窗口尺寸变化，浏览器会同步触发 resize / fullscreenchange）
  useEffect(() => {
    const apply = () => {
      const sx = window.innerWidth / 1920
      const sy = window.innerHeight / 1080
      const ok = (v) => Number.isFinite(v) && v > 0
      if (fit === 'cover') {
        setScale({ x: ok(sx) ? sx : 1, y: ok(sy) ? sy : 1 })
      } else {
        const s = Math.min(sx, sy)
        setScale({ x: ok(s) ? s : 1, y: ok(s) ? s : 1 })
      }
    }
    apply()
    window.addEventListener('resize', apply)
    document.addEventListener('fullscreenchange', apply)
    return () => {
      window.removeEventListener('resize', apply)
      document.removeEventListener('fullscreenchange', apply)
    }
  }, [fit])

  // 健康度：成功复位；失败累加（1-2 次=延迟，≥3 次=断开；数据保留上一帧）
  const markHealthOk = useCallback((t0) => {
    setHealth({ status: 'ok', fails: 0, latency: Math.max(0, Math.round(performance.now() - t0)), error: null })
    setError(null)
  }, [])
  const markHealthFail = useCallback((e) => {
    const msg = String(e?.message || e)
    setHealth((h) => {
      const fails = (h.fails || 0) + 1
      return { status: fails >= 3 ? 'offline' : 'stale', fails, latency: h.latency, error: msg }
    })
    setError(msg)
  }, [])

  // 全量加载：各面板全量（趋势/分布/团队/流转/SLA/平台）+ 可选下钻工单集
  const loadFull = useCallback(async ({ withDrill = false } = {}) => {
    const seq = (reqRef.current.full += 1)
    const t0 = performance.now()
    setRefreshing(true)
    try {
      const data = await ticketApi.getMonitorStats(flowId || undefined, {
        includeDrill: withDrill,
        drillLimit: 2000,
      })
      if (!mountedRef.current || seq !== reqRef.current.full) return
      setStats(data)
      setLastUpdated(new Date())
      markHealthOk(t0)
      if (withDrill && Array.isArray(data?.tickets)) {
        setDrillSet({
          tickets: data.tickets,
          truncated: !!data.tickets_truncated,
          total: data.tickets_total ?? data.tickets.length,
          at: Date.now(),
        })
      }
    } catch (e) {
      if (!mountedRef.current || seq !== reqRef.current.full) return
      markHealthFail(e)
    } finally {
      if (mountedRef.current && seq === reqRef.current.full) setRefreshing(false)
    }
  }, [flowId, markHealthOk, markHealthFail])

  // 轻量加载：仅 KPI + 最新工单（高频轮询，响应体极小）
  const loadLight = useCallback(async () => {
    const seq = (reqRef.current.light += 1)
    const t0 = performance.now()
    try {
      const data = await ticketApi.getMonitorStats(flowId || undefined, { light: true })
      if (!mountedRef.current || seq !== reqRef.current.light) return
      // 首帧尚无全量数据时以全量请求为准（轻量响应缺少各面板数据）
      setStats((s) => (s ? { ...s, kpi: data.kpi, latest: data.latest, generated_at: data.generated_at } : s))
      setLastUpdated(new Date())
      markHealthOk(t0)
    } catch (e) {
      if (!mountedRef.current || seq !== reqRef.current.light) return
      markHealthFail(e)
    }
  }, [flowId, markHealthOk, markHealthFail])

  // 按需下钻工单集：打开弹窗时补拉（5 分钟内复用缓存，避免高频轮询重复下发 2000 条）
  const ensureDrill = useCallback(async () => {
    const cur = drillSetRef.current
    if (cur.at && Date.now() - cur.at < DRILL_CACHE_MS && cur.tickets.length) return
    const seq = (reqRef.current.drill += 1)
    setDrillLoading(true)
    try {
      const data = await ticketApi.getMonitorStats(flowId || undefined, { includeDrill: true, drillLimit: 2000 })
      if (!mountedRef.current || seq !== reqRef.current.drill) return
      if (Array.isArray(data?.tickets)) {
        setDrillSet({
          tickets: data.tickets,
          truncated: !!data.tickets_truncated,
          total: data.tickets_total ?? data.tickets.length,
          at: Date.now(),
        })
      }
    } catch {
      if (mountedRef.current && seq === reqRef.current.drill) toast.warning('下钻工单集加载失败，请稍后重试')
    } finally {
      if (mountedRef.current && seq === reqRef.current.drill) setDrillLoading(false)
    }
  }, [flowId])

  // 分层刷新：高频（light = refreshMs，只取 KPI+最新工单）+ 低频全景（max(60s, 4×refreshMs)）；
  // 首次加载与切换流程带下钻集，之后全景轮询不再下发下钻集（响应体显著减小）
  useEffect(() => {
    loadFull({ withDrill: true })
    if (refreshMs <= 0) return undefined
    const light = setInterval(loadLight, refreshMs)
    const full = setInterval(() => loadFull({ withDrill: false }), Math.max(60000, refreshMs * 4))
    return () => {
      clearInterval(light)
      clearInterval(full)
    }
  }, [loadFull, loadLight, refreshMs])

  // 手动刷新（工具条 / R 键）：带下钻集，保证打开弹窗时数据同步
  const refreshNow = useCallback(() => { loadFull({ withDrill: true }) }, [loadFull])

  // 浏览器级全屏：隐藏浏览器边框与任务栏，便于会议室/指挥中心投放
  const screenRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    onFs()
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  const toggleFullscreen = useCallback(() => {
    pendingAutoFsRef.current = false
    setNeedFsGesture(false)
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen?.()?.catch?.(() => {})
      } else {
        screenRef.current?.requestFullscreen?.()?.catch?.(() => {})
      }
    } catch {
      /* 浏览器不支持或被拒绝（非用户手势等）时静默忽略，可改用 F11 */
    }
  }, [])

  // ?fullscreen=1：等待首个用户手势（浏览器全屏策略要求）后自动进入全屏
  useEffect(() => {
    if (!pendingAutoFsRef.current) return undefined
    const fire = () => {
      if (!pendingAutoFsRef.current) return
      toggleFullscreen()
    }
    window.addEventListener('pointerdown', fire)
    window.addEventListener('keydown', fire)
    return () => {
      window.removeEventListener('pointerdown', fire)
      window.removeEventListener('keydown', fire)
    }
  }, [toggleFullscreen])

  // 下钻栈操作：openDrill 压入下一级（并按需补拉下钻工单集）；jump/close 回跳与关闭
  const openDrill = useCallback((view) => {
    setDrillStack((s) => [...s, view])
    if (!isDemoRef.current) ensureDrill()
  }, [ensureDrill])
  const jumpDrill = (idx) => setDrillStack((s) => s.slice(0, idx + 1))
  const closeDrill = (level) => setDrillStack((s) => s.slice(0, level))

  // ESC 关闭最顶层下钻弹窗
  useEffect(() => {
    if (drillStack.length === 0) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setDrillStack((s) => s.slice(0, -1)) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drillStack.length])

  // 值守轮播：停止并收起轮播视图（保留用户自己打开的下钻层）
  const stopTour = useCallback(() => {
    setTourOn(false)
    setDrillStack((s) => (s.some((v) => v.tour) ? [] : s))
  }, [])

  // 值守轮播：每 15s 依次展示 处理中 / 超时预警 / 平台（取量最大平台）/ 提交团队排名
  useEffect(() => {
    if (!tourOn) return undefined
    let i = 0
    const buildViews = () => {
      const d = dataRef.current
      const top = [...(d?.platform_stats || [])].sort((a, b) => (b.total || 0) - (a.total || 0))[0]
      const views = [
        {
          kind: 'tickets', tour: true, title: '值守轮播 · 处理中工单',
          subtitle: 'AUTO TOUR · 每 15 秒切换', filters: { status: 'processing' },
        },
        {
          kind: 'tickets', tour: true, title: '值守轮播 · SLA 超时预警',
          subtitle: 'AUTO TOUR · 每 15 秒切换', filters: { timeoutOnly: true },
        },
      ]
      if (top?.name) {
        views.push({
          kind: 'tickets', tour: true, title: `值守轮播 · 来源平台「${top.name}」`,
          subtitle: 'AUTO TOUR · 每 15 秒切换', filters: { platform: top.name },
        })
      }
      views.push({ kind: 'teams', tour: true, title: '值守轮播 · 提交团队排名', subtitle: 'AUTO TOUR · 每 15 秒切换' })
      return views
    }
    const tick = () => {
      const views = buildViews()
      setDrillStack([views[i % views.length]])
      i += 1
      if (!isDemoRef.current) ensureDrill()
    }
    tick()
    const t = setInterval(tick, TOUR_MS)
    return () => clearInterval(t)
  }, [tourOn, ensureDrill])

  // 轮播期间：点击工具条以外区域 或 ESC 停止（避免值守结束后仍自动切换）
  useEffect(() => {
    if (!tourOn) return undefined
    const onDown = (e) => {
      if (e.target?.closest?.('[data-tour]')) return
      stopTour()
    }
    const onKey = (e) => { if (e.key === 'Escape') stopTour() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [tourOn, stopTour])

  // 声光报警：新增「超时且进行中」工单 → 双音提示 + 顶部红闪（首帧只记基线，不误报）
  const playAlarm = useCallback(() => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = audioCtxRef.current || (audioCtxRef.current = new Ctx())
      if (ctx.state === 'suspended') ctx.resume?.()
      const t0 = ctx.currentTime
      ;[880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const start = t0 + i * 0.22
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(freq, start)
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2)
        osc.connect(gain).connect(ctx.destination)
        osc.start(start)
        osc.stop(start + 0.22)
      })
    } catch {
      /* 浏览器自动播放策略限制时静默（仅保留视觉红闪） */
    }
  }, [])
  useEffect(() => {
    const ids = new Set(
      (data?.latest || []).filter((t) => t.timeout && t.status === 'processing').map((t) => t.id),
    )
    const prev = timeoutIdsRef.current
    timeoutIdsRef.current = ids
    if (!prev) return                       // 首帧只记录基线
    const added = [...ids].filter((id) => !prev.has(id))
    if (added.length === 0 || !alarmOn) return
    playAlarm()
    setAlarmFlash(true)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setAlarmFlash(false), ALARM_FLASH_MS)
  }, [data?.latest, alarmOn, playAlarm])

  // 空闲 30s：隐藏光标 + 收起工具条（投屏观感），任意移动/按键/滚动恢复
  useEffect(() => {
    let timer
    const wake = () => {
      setIdle(false)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), IDLE_MS)
    }
    wake()
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel']
    events.forEach((ev) => window.addEventListener(ev, wake, { passive: true }))
    return () => {
      if (timer) clearTimeout(timer)
      events.forEach((ev) => window.removeEventListener(ev, wake))
    }
  }, [])

  // 快捷键：F 全屏 / R 刷新 / T 轮播 / 1-4 状态筛选（输入控件与组合键不拦截）
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
      const key = String(e.key).toLowerCase()
      if (key === 'f') { e.preventDefault(); toggleFullscreen() }
      else if (key === 'r') { e.preventDefault(); refreshNow() }
      else if (key === 't') { e.preventDefault(); if (tourOn) stopTour(); else setTourOn(true) }
      else if (STATUS_HOTKEYS[key]) { e.preventDefault(); setLiveStatus(STATUS_HOTKEYS[key]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen, refreshNow, tourOn, stopTour])

  // 崩溃自愈（投屏无人值守）：React 在 commit 阶段（如 insertBefore NotFoundError，DOM 与
  // 虚拟树失配时）抛出的异常会卸载整棵树且 ErrorBoundary 无法捕获，页面白屏。
  // 大屏所有状态均可由 URL 参数 + localStorage 复原，此处捕获该类未处理异常后自动整页
  // 重载恢复投屏；带防循环保护（10 分钟窗口内最多自动恢复 3 次，超出则停止避免风暴）。
  useEffect(() => {
    const GUARD_KEY = 'ticket_monitor_crash_reloads'
    const WINDOW_MS = 10 * 60 * 1000
    const MAX_RELOADS = 3
    const onErr = (e) => {
      const msg = String(e?.message || e || '')
      // 仅处理会破坏 React 树的 DOM 失配类错误（insertBefore/removeChild NotFoundError）；
      // 普通业务异常（网络等）不触发整页重载
      if (!/insertBefore|removeChild|NotFoundError/i.test(msg)) return
      // eslint-disable-next-line no-console
      console.error('[MonitorSelfHeal] 检测到 DOM 失配崩溃，准备自动恢复：', msg)
      let reloads = []
      try {
        reloads = JSON.parse(window.localStorage.getItem(GUARD_KEY) || '[]')
          .filter((t) => Date.now() - t < WINDOW_MS)
      } catch { reloads = [] }
      if (reloads.length >= MAX_RELOADS) return
      reloads.push(Date.now())
      try { window.localStorage.setItem(GUARD_KEY, JSON.stringify(reloads)) } catch { /* 忽略 */ }
      setTimeout(() => window.location.reload(), 500)
    }
    window.addEventListener('error', onErr)
    return () => window.removeEventListener('error', onErr)
  }, [])

  // URL 参数回写：当前流程/刷新/筛选/适配同步到地址栏（复制链接即可复现同屏；
  // fullscreen 为一次性参数，消费后移除避免刷新被反复触发）
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search)
      if (flowId) qs.set('flow', flowId); else qs.delete('flow')
      if (refreshMs !== DEFAULT_REFRESH_MS) qs.set('refresh', String(refreshMs)); else qs.delete('refresh')
      if (liveStatus !== 'all') qs.set('status', liveStatus); else qs.delete('status')
      if (fit !== 'contain') qs.set('fit', fit); else qs.delete('fit')
      qs.delete('fullscreen')
      const q = qs.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`)
    } catch {
      /* 隐私模式等场景下忽略 URL 写入异常 */
    }
  }, [flowId, refreshMs, liveStatus, fit])

  // KPI 迷你趋势：每次采样缓存最近 24 个点；切换流程清空（避免跨流程曲线混淆）
  useEffect(() => {
    if (flowRef.current !== flowId) {
      flowRef.current = flowId
      setKpiHist({})
      setDrillSet({ tickets: [], truncated: false, total: 0, at: 0 })
    }
  }, [flowId])
  useEffect(() => {
    if (!kpi) return
    setKpiHist((h) => {
      const next = {}
      for (const f of KPI_FIELDS) {
        const arr = Array.isArray(h[f]) ? h[f].slice(-(KPI_HIST_MAX - 1)) : []
        if (typeof kpi[f] === 'number') arr.push(kpi[f])
        next[f] = arr
      }
      return next
    })
  }, [kpi])

  // KPI：今日新增对比昨日（趋势 days30 末两个点）
  const yesterdayNew = data?.trend?.days30?.length >= 2 ? data.trend.days30[data.trend.days30.length - 2]?.new : undefined
  const todayDelta = kpi && yesterdayNew !== undefined ? kpi.today_new - yesterdayNew : undefined
  // 超时预警占处理中比例（处理中为 0 时无意义，显示 —）
  const warnPct = kpi && kpi.pending > 0 && kpi.timeout_warning != null
    ? Math.round((kpi.timeout_warning / kpi.pending) * 1000) / 10
    : null
  // 今日零点（ISO 本地串）：KPI「今日新增」下钻筛选用
  const todayStartIso = isoLocal(new Date(new Date().setHours(0, 0, 0, 0)))

  return (
    <div ref={screenRef} translate="no"
      className={`fixed inset-0 flex items-center justify-center overflow-hidden ${idle ? 'screen-idle' : ''}`}
      style={{
        background:
          `radial-gradient(ellipse 90% 70% at 50% 45%, ${C.canvasCenter} 0%, ${C.canvasBase} 45%, ${C.canvasEdge} 72%, ${C.deepNavy} 100%)`,
      }}>
      {/* 说明：translate="no" 阻止浏览器/翻译扩展对大屏 DOM 做翻译改写——
          整页中文界面被自动翻译时会移动/包裹文本节点，破坏 React 虚拟树与
          实际 DOM 的对应关系，触发 insertBefore NotFoundError 导致整树卸载白屏 */}
      {/* 背景 1px 科技网格线（低对比，避免抢卡片层级） */}
      <div className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(rgba(80,120,170,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(80,120,170,0.06) 1px, transparent 1px)',
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
        /* KPI 异常（超时预警>0）描边呼吸 + 声光报警顶部红闪 */
        @keyframes kpiPulse {
          0%, 100% { box-shadow: 0 0 10px rgba(255,77,79,0.16); }
          50% { box-shadow: 0 0 22px rgba(255,77,79,0.55); }
        }
        .kpi-alert-pulse { animation: kpiPulse 2.4s ease-in-out infinite; }
        @keyframes alarmFlash { 0%, 100% { opacity: 0; } 35% { opacity: 1; } 65% { opacity: 0.45; } }
        .alarm-flash { animation: alarmFlash 1s ease-in-out 4; }
        /* 空闲态：隐藏鼠标光标（投屏观感） */
        .screen-idle, .screen-idle * { cursor: none !important; }
        /* 系统开启"减少动态效果"时关闭装饰动画 */
        @media (prefers-reduced-motion: reduce) {
          .flow-dash, .node-glow, .row-enter, .row-flash, .count-bounce, .marquee-enter, .screen-fade,
          .drill-in, .drill-pop, .kpi-alert-pulse, .alarm-flash { animation: none !important; }
        }
      `}</style>

      <div className="screen-fade absolute"
        style={{ width: 1920, height: 1080, transform: `scale(${scale.x}, ${scale.y})`, transformOrigin: 'center' }}>
        {/* ① 顶部标题栏（演示模式带「演示数据」标记；右侧工具条：刷新频率 / 立即刷新 / 全屏 + 时钟） */}
        <HeaderBar
          demo={isDemo}
          refreshMs={refreshMs}
          onRefreshMs={selectRefreshMs}
          onRefresh={refreshNow}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          health={health}
          alarmOn={alarmOn}
          onToggleAlarm={toggleAlarm}
          fit={fit}
          onFit={selectFit}
          tourOn={tourOn}
          onToggleTour={() => (tourOn ? stopTour() : setTourOn(true))}
          hidden={idle}
        />

        {/* ① KPI 指标卡横排（点击下钻对应口径工单列表；超时预警↔处理中同色橙红描边编组，处理中 0 件灰色虚线态）
            处理中 + 已解决 + 已取消 = 工单总量（三类状态完整口径，便于总量核对）；
            「处理中」卡为全部进行中工单（合并原「待处理」卡），底部小字展示今日活跃数 */}
        <div className="mt-1 grid h-[96px] grid-cols-6 gap-3 px-4">
          <KpiCard label="工单总量" value={kpi?.total} tone="blue" spark={kpiHist.total}
            onClick={() => openDrill({ kind: 'tickets', title: '全部工单列表', subtitle: 'KPI 下钻 · 工单总量' })} />
          <KpiCard label="今日新增" value={kpi?.today_new} tone="blue" delta={todayDelta} spark={kpiHist.today_new}
            onClick={() => openDrill({ kind: 'tickets', title: '今日新增工单', subtitle: 'KPI 下钻 · 今日创建', filters: { from: todayStartIso } })} />
          <KpiCard label="处理中" value={kpi?.pending} tone="orange" groupBorder zeroNote="暂无进行中工单"
            note={kpi ? `今日活跃 ${kpi.processing_active} 件` : '今日活跃 —'}
            spark={kpiHist.pending}
            onClick={() => openDrill({ kind: 'tickets', title: '处理中工单', subtitle: 'KPI 下钻 · 进行中', filters: { status: 'processing' } })} />
          <KpiCard label="已解决" value={kpi?.completed} tone="green" spark={kpiHist.completed}
            onClick={() => openDrill({ kind: 'tickets', title: '已解决工单', subtitle: 'KPI 下钻 · 已完成', filters: { status: 'completed' } })} />
          <KpiCard label="已取消" value={kpi?.cancelled} tone="gray" spark={kpiHist.cancelled}
            onClick={() => openDrill({ kind: 'tickets', title: '已取消工单', subtitle: 'KPI 下钻 · 已取消', filters: { status: 'cancelled' } })} />
          <KpiCard label="超时预警" value={kpi?.timeout_warning} tone={(kpi?.timeout_warning ?? 0) > 0 ? 'red' : 'blue'} groupBorder
            note={`占处理中 ${warnPct == null ? '—' : `${warnPct}%`}`} spark={kpiHist.timeout_warning}
            pulse={(kpi?.timeout_warning ?? 0) > 0}
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
            {/* ④ 最新工单实时列表（状态筛选 + 自动滚动 + 行点击查看工单详情） */}
            {/* 实时列表行点击 → 工单详情：latest 记录字段精简，按 id 从下钻工单集换完整对象，
                保证详情页 team/platform/alert_type/SLA 时长等字段完整展示 */}
            <LiveList latest={data?.latest} tickets={drillTickets}
              status={liveStatus} onStatus={setLiveStatus}
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
            truncated={drillTruncated} loading={drillLoading} demo={isDemo}
            onJump={jumpDrill} onClose={closeDrill} onDrill={openDrill} />
        ))}
      </div>

      {/* 声光报警：新增超时工单时顶部红边 + 内发光闪烁（4 秒；仅视觉，提示音受浏览器策略限制） */}
      {alarmFlash && (
        <div className="alarm-flash pointer-events-none absolute inset-0 z-[55]"
          style={{ border: '2px solid rgba(255,77,79,0.75)', boxShadow: 'inset 0 0 120px 24px rgba(255,77,79,0.45)' }} />
      )}

      {/* ?fullscreen=1 提示：浏览器要求用户手势才允许全屏，点击/按键任意位置即进入 */}
      {needFsGesture && (
        <div className="absolute bottom-4 left-4 z-30 rounded border px-3 py-1.5 text-[12px]"
          style={{ background: 'rgba(69,184,205,0.12)', borderColor: 'rgba(69,184,205,0.45)', color: C.paleBlue }}>
          点击任意位置进入全屏投屏（URL 参数 fullscreen=1）
        </div>
      )}

      {/* 数据加载异常：断线时保留上一帧继续展示（不白屏），底部提示 + 工具条健康度同步变色 */}
      {error && (!stats || health.status === 'offline') && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded border px-4 py-2 text-[12px]"
          style={{ background: 'rgba(255,77,79,0.12)', borderColor: 'rgba(255,77,79,0.4)', color: C.red }}>
          {stats ? '数据源断开，正在展示上一帧数据' : '数据加载失败'}：{error}
          {stats ? '（' : '（大屏需在已登录会话中访问'}
          {refreshMs > 0
            ? `，${refreshMs >= 60000 ? `${refreshMs / 60000} 分钟` : `${refreshMs / 1000} 秒`}后自动重试`
            : '，自动刷新已暂停，可点右上角刷新或按 R'}
          ）
        </div>
      )}
    </div>
  )
}
