// 值班监控大屏：全屏暗色主题，实时展示当前班次、异常提醒、近7天排班与月度排班
import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import { Maximize2, Minimize2, RefreshCw, AlertTriangle, CalendarDays, Sun, Moon, Phone, Clock, Users, ChevronLeft, ChevronRight, LayoutDashboard, Cpu, Package, ShieldCheck } from 'lucide-react'
import dutyApi from '../api/duty'

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

// 值班大屏子视图：日常运营 / 重保，分别加载不同类型的值班表数据
const ROSTER_VIEWS = [
  { value: 'DAILY', label: '日常值班', icon: CalendarDays, color: '#3B82F6' },
  { value: 'RESERVE', label: '重保值班', icon: ShieldCheck, color: '#EF4444' },
]

// 主题色
const C = {
  day: '#3B82F6',
  night: '#8B5CF6',
  pending: '#EF4444',
  leave: '#F59E0B',
  adjust: '#EAB308',
  normal: '#10B981',
}

// 节假日背景色（非工作日=紫色；周末调休上班日按工作日处理）
function dayBgStyle(day) {
  if (!day) return {}
  if (day.is_holiday) return { background: 'rgba(139,92,246,0.12)', borderColor: 'rgba(139,92,246,0.35)' }
  return {}
}

// 日期数字颜色（跟随主题令牌，随亮/暗色切换）
function dateColor(day) {
  if (!day) return 'var(--muted-foreground)'
  if (day.is_holiday) return '#A78BFA'
  return 'var(--foreground)'
}

// 多人显示：姓名用逗号隔开
function fmtMembers(list) {
  if (!list || list.length === 0) return '--'
  return list.map((m) => m.name).filter(Boolean).join('，') || '--'
}

function fmtPhones(list) {
  if (!list || list.length === 0) return ''
  return list.map((m) => m?.phone).filter(Boolean).join('，')
}

export default function DutyDashboard({ onSwitchTab }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  // 当前值班大屏子视图：DAILY=日常运营 / RESERVE=重保
  const [rosterType, setRosterType] = useState('DAILY')
  const [now, setNow] = useState(new Date())
  const [fullscreen, setFullscreen] = useState(false)
  const [monthData, setMonthData] = useState({ days: [] })
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() + 1 }
  })
  const containerRef = useRef(null)

  // 加载大屏数据（按当前值班表类型）
  const loadData = useCallback(async () => {
    try {
      const res = await dutyApi.dashboard(rosterType)
      setData(res)
    } catch (e) {
      console.error('加载值班大屏数据失败:', e)
    } finally {
      setLoading(false)
    }
  }, [rosterType])

  // 加载月度排班（按当前值班表类型）
  const loadMonth = useCallback(async (year, month) => {
    try {
      const res = await dutyApi.monthSchedule(year, month, rosterType)
      setMonthData(res || { days: [] })
    } catch (e) {
      console.error('加载月度排班失败:', e)
    }
  }, [rosterType])

  // 初始加载 + 60s 自动刷新
  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 60000)
    return () => clearInterval(timer)
  }, [loadData])

  // 时钟 1s 刷新
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 月度排班加载
  useEffect(() => {
    loadMonth(monthCursor.year, monthCursor.month)
  }, [monthCursor, loadMonth])

  // 全屏切换
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.()
      setFullscreen(true)
    } else {
      document.exitFullscreen?.()
      setFullscreen(false)
    }
  }, [])

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    const onEsc = (e) => { if (e.key === 'Escape' && fullscreen) document.exitFullscreen?.() }
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('keydown', onEsc)
    }
  }, [fullscreen])

  // 倒计时到班次结束
  const countdown = (() => {
    if (!data) return '--'
    const h = now.getHours()
    const m = now.getMinutes()
    const s = now.getSeconds()
    if (data.current_shift === 'DAY') {
      // 白班结束 18:00
      const endH = 18
      let dh = endH - 1 - h
      let dm = 59 - m
      let ds = 60 - s
      if (ds === 60) { ds = 0; dm++ }
      if (dm === 60) { dm = 0; dh++ }
      if (dh < 0) return '已结束'
      return `${String(dh).padStart(2, '0')}:${String(dm).padStart(2, '0')}:${String(ds).padStart(2, '0')}`
    } else {
      // 晚班结束 次日09:00
      let dh = 8 - h
      let dm = 59 - m
      let ds = 60 - s
      if (ds === 60) { ds = 0; dm++ }
      if (dm === 60) { dm = 0; dh++ }
      if (dh < 0) dh += 24
      return `${String(dh).padStart(2, '0')}:${String(dm).padStart(2, '0')}:${String(ds).padStart(2, '0')}`
    }
  })()

  const shiftTitle = data?.current_shift === 'DAY' ? '白班' : '晚班'
  const shiftColor = data?.current_shift === 'DAY' ? C.day : C.night
  // 深色主题下使用更亮的同色系变体，确保班次文字在暗色/投影场景下清晰（组件每秒随时钟重渲染，可自动跟随主题切换）
  const isDark = document.documentElement.classList.contains('dark')
  const shiftTextColor = data?.current_shift === 'DAY' ? (isDark ? '#60A5FA' : '#2563EB') : (isDark ? '#A78BFA' : '#7C3AED')
  const curMember = data?.current_member
  const curMembers = (data?.current_members?.length ? data.current_members : (curMember ? [curMember] : []))
  const backupMember = data?.backup_member
  const todayRec = data?.today_record
  const upcoming7 = data?.upcoming_7days || []
  const anomalies = data?.anomalies || {}

  // 月历网格
  const monthGrid = (() => {
    const days = monthData.days || []
    if (days.length === 0) return []
    const first = new Date(monthCursor.year, monthCursor.month - 1, 1)
    // 周一为第一天：偏移
    let offset = first.getDay() - 1
    if (offset < 0) offset = 6
    const cells = new Array(offset).fill(null)
    days.forEach((d) => cells.push(d))
    while (cells.length % 7 !== 0) cells.push(null)
    const weeks = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
    return weeks
  })()

  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  const weekdayStr = WEEKDAY_CN[(now.getDay() + 6) % 7]

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[200] flex flex-col text-foreground"
      style={{ background: 'linear-gradient(135deg, var(--background) 0%, var(--card) 100%)' }}
    >
      {/* ===== 顶部栏 96px ===== */}
      <header className="flex h-24 shrink-0 items-center justify-between border-b border-border px-8">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: 'rgba(59,130,246,0.15)' }}>
            <CalendarDays className="h-6 w-6" style={{ color: shiftColor }} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-gradient-primary text-3xl font-bold tracking-wide">值班监控大屏</h1>
              <span
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold"
                style={rosterType === 'RESERVE'
                  ? { background: 'rgba(239,68,68,0.14)', color: '#EF4444' }
                  : { background: 'rgba(59,130,246,0.14)', color: '#3B82F6' }}
              >
                {rosterType === 'RESERVE' ? <ShieldCheck className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
                {rosterType === 'RESERVE' ? '重保值班' : '日常运营'}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{dateStr} {weekdayStr}</p>
          </div>
          {/* 大屏切换 */}
          {onSwitchTab && (
            <div className="ml-4 flex items-center gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                onClick={() => onSwitchTab('operations')}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
                title="运营大屏"
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                运营
              </button>
              <button
                type="button"
                onClick={() => onSwitchTab('ai_usage')}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
                title="AI 用量大屏"
              >
                <Cpu className="h-3.5 w-3.5" />
                AI用量
              </button>
              <button
                type="button"
                onClick={() => onSwitchTab('materials')}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
                title="材料管理大屏"
              >
                <Package className="h-3.5 w-3.5" />
                材料
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary ring-1 ring-primary/25 transition-colors"
                title="值班大屏（当前）"
              >
                <CalendarDays className="h-3.5 w-3.5" />
                值班
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-6">
          {/* 值班大屏子视图切换：日常 / 重保（位于右侧「值班」按钮与时间之间） */}
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1" title="切换日常运营/重保值班大屏">
            {ROSTER_VIEWS.map((v) => {
              const Icon = v.icon
              const active = rosterType === v.value
              return (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setRosterType(v.value)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  style={active ? { color: v.color, boxShadow: `inset 0 0 0 1px ${v.color}55` } : undefined}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {v.label}
                </button>
              )
            })}
          </div>

          {/* 实时时钟 */}
          <div className="text-right">
            <div className="text-glow text-3xl font-bold tabular-nums text-foreground" style={{ fontVariantNumeric: 'tabular-nums' }}>{timeStr}</div>
          </div>

          {/* 班次状态 */}
          <div className="flex items-center gap-2 rounded-lg px-4 py-2" style={{ background: `${shiftColor}26`, border: `1px solid ${shiftColor}66` }}>
            {data?.current_shift === 'DAY' ? <Sun className="h-5 w-5" style={{ color: shiftTextColor }} /> : <Moon className="h-5 w-5" style={{ color: shiftTextColor }} />}
            <span className="text-lg font-semibold" style={{ color: shiftTextColor }}>{shiftTitle}</span>
          </div>

          {/* 全屏切换 */}
          <button onClick={toggleFullscreen} className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground" title={fullscreen ? '退出全屏' : '全屏'}>
            {fullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </button>

          {/* 手动刷新 */}
          <button onClick={loadData} className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground" title="刷新">
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* ===== 主区域 ===== */}
      {rosterType === 'RESERVE' ? (
        /* 重保大屏：仅保留近 7 天排班，采用正式值班安排表样式 */
        <ReserveDutySheet days={upcoming7} today={data?.today} memberGroups={data?.member_groups} />
      ) : (
      <div className="flex min-h-0 flex-1 bg-tech-grid">
        {/* 左侧 30%：上 2/3 当前值班卡片 + 下 1/3 异常提醒 */}
        <div className="flex w-[30%] shrink-0 flex-col border-r border-border px-6 py-4">
          {/* 上 2/3：当前值班 */}
          <div className="flex flex-1 flex-col items-center justify-center">
            {/* 呼吸灯 */}
            <div className="relative mb-3">
              <div className="absolute inset-0 animate-ping rounded-full" style={{ background: `${shiftColor}33`, animationDuration: '2s' }} />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-full" style={{ background: `${shiftColor}22`, border: `2px solid ${shiftTextColor}` }}>
                {data?.current_shift === 'DAY' ? <Sun className="h-7 w-7" style={{ color: shiftTextColor }} /> : <Moon className="h-7 w-7" style={{ color: shiftTextColor }} />}
              </div>
            </div>

            {/* 班次标题 */}
            <div className="mb-1.5 text-xs text-muted-foreground">当前班次</div>
            <div className="mb-4" style={{ fontSize: 48, fontWeight: 700, color: shiftTextColor, lineHeight: 1 }}>{shiftTitle}</div>

            {/* 值班人姓名 */}
            {curMember ? (
              <>
                <div className="mb-1.5 text-xs text-muted-foreground">值班人员</div>
                <div className="mb-3 flex items-center gap-4">
                  {/* 头像：主题色圆环 + 姓名首字 */}
                  <div
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold"
                    style={{ background: `${shiftColor}1F`, border: `2px solid ${shiftTextColor}66`, color: shiftTextColor }}
                  >
                    {(curMember.name || '?').slice(0, 1)}
                  </div>
                  <div className="text-foreground" style={{ fontSize: curMembers.length > 1 ? 36 : 60, fontWeight: 700, lineHeight: 1.2 }}>
                    {fmtMembers(curMembers)}
                  </div>
                </div>
                {fmtPhones(curMembers) && (
                  <div className="mb-4 flex items-center gap-2 tabular-nums text-foreground" style={{ fontSize: curMembers.length > 1 ? 20 : 28, fontWeight: 500 }}>
                    <Phone className="h-5 w-5 text-muted-foreground" />
                    {fmtPhones(curMembers)}
                  </div>
                )}
              </>
            ) : (
              <div className="mb-4 text-xl text-muted-foreground">暂未排班</div>
            )}

            {/* 倒计时 */}
            <div className="mb-1.5 text-xs text-muted-foreground">距离下班</div>
            <div className="text-glow tabular-nums mb-3 text-foreground" style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{countdown}</div>

            {/* 备班 */}
            {backupMember && (
              <div className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="mb-0.5 text-[10px] text-muted-foreground">备班人员</div>
                <div className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-base font-semibold text-foreground">{backupMember.name}</span>
                </div>
              </div>
            )}
          </div>

          {/* 下 1/3：异常提醒 */}
          <div className="shrink-0 rounded-lg border border-border bg-muted p-3" style={{ maxHeight: '33%' }}>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <AlertTriangle className="h-3.5 w-3.5" style={{ color: data?.has_anomaly ? C.pending : C.normal }} />
              异常提醒
            </h2>
            <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 'calc(33vh - 80px)' }}>
              {/* 待分配 */}
              {(anomalies.pending || []).length > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-medium" style={{ color: C.pending }}>待分配</span>
                  <span className="text-muted-foreground">{anomalies.pending.length} 项</span>
                </div>
              )}
              {/* 请假 */}
              {(anomalies.leaves || []).length > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-medium" style={{ color: C.leave }}>请假</span>
                  <span className="text-muted-foreground">{anomalies.leaves.map(l => l.member_name).join('、')}</span>
                </div>
              )}
              {/* 调班记录详情 */}
              {(anomalies.adjustments || []).length > 0 && (
                <div>
                  <div className="mb-0.5 text-[11px] font-medium" style={{ color: C.adjust }}>调班记录 ({anomalies.adjustments.length})</div>
                  {anomalies.adjustments.slice(0, 6).map((a, i) => (
                    <div key={i} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="whitespace-nowrap">{a.duty_date?.slice(5)}</span>
                      <span className="truncate">{a.original_member_name}</span>
                      <span style={{ color: C.adjust }}>→</span>
                      <span className="truncate">{a.new_member_name}</span>
                      <span className="whitespace-nowrap" style={{ color: a.shift === '白班' ? C.day : C.night }}>{a.shift}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* 交班 */}
              {anomalies.upcoming_handover && (
                <div className="flex items-center gap-2 text-[11px]">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    交班 {anomalies.upcoming_handover.time} → {anomalies.upcoming_handover.next_shift === 'DAY' ? '白班' : '晚班'}
                    {anomalies.upcoming_handover.members?.length ? `（${fmtMembers(anomalies.upcoming_handover.members)}）` : ''}
                  </span>
                </div>
              )}
              {/* 无异常 */}
              {!data?.has_anomaly && (anomalies.pending || []).length === 0 && (anomalies.leaves || []).length === 0 && (
                <div className="flex items-center gap-2 text-[11px]" style={{ color: C.normal }}>
                  <span className="dot-pulse inline-block h-1.5 w-1.5 rounded-full" style={{ background: C.normal }} /> 一切正常
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧 70%：7天排班 + 月历 */}
        <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-5">

          {/* ===== 近7天排班 ===== */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-foreground">
              <CalendarDays className="h-4 w-4" style={{ color: shiftColor }} />
              近 7 天排班
            </h2>
            <div className="grid grid-cols-7 gap-2">
              {upcoming7.map((d, i) => {
                const bg = dayBgStyle(d)
                return (
                  <div
                    key={i}
                    className="rounded-lg p-2.5"
                    style={{
                      background: bg.background || 'var(--muted)',
                      border: `1px solid ${bg.borderColor || 'var(--border)'}`,
                      ...(d?.is_today ? { boxShadow: `0 0 0 2px ${shiftColor}44` } : {}),
                    }}
                    title={d?.holiday_name || ''}
                  >
                    {/* 日期行 */}
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold" style={{ color: dateColor(d) }}>
                        {d ? Number(d.duty_date.slice(8)) : '--'}
                      </span>
                      <span className="text-[10px]" style={{ color: dateColor(d) }}>
                        {d?.weekday || ''}
                      </span>
                    </div>

                    {/* 节假/休息标记 */}
                    {d?.is_holiday && (
                      <div className="mb-1.5 text-[10px] font-medium" style={{ color: '#A78BFA' }}>
                        {d.holiday_name || '休'}
                      </div>
                    )}

                    {/* 白班 */}
                    <div className="mb-1 flex items-center gap-1.5 rounded px-1.5 py-1" style={{ background: 'rgba(59,130,246,0.10)' }}>
                      <Sun className="h-3 w-3 shrink-0" style={{ color: C.day }} />
                      <span className="truncate text-xs text-foreground">{fmtMembers(d?.day_members)}</span>
                    </div>

                    {/* 晚班 */}
                    <div className="flex items-center gap-1.5 rounded px-1.5 py-1" style={{ background: 'rgba(139,92,246,0.10)' }}>
                      <Moon className="h-3 w-3 shrink-0" style={{ color: C.night }} />
                      <span className="truncate text-xs text-foreground">{fmtMembers(d?.night_members)}</span>
                    </div>

                    {/* 需调整标记 */}
                    {(d?.day_needs_adjust || d?.night_needs_adjust) && (
                      <div className="mt-1 flex items-center gap-1 text-[10px]" style={{ color: C.adjust }}>
                        <AlertTriangle className="h-2.5 w-2.5" /> 需调整
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* ===== 月度排班日历 ===== */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                {monthCursor.year} 年 {MONTH_CN[monthCursor.month - 1]} 排班
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMonthCursor((p) => {
                    let y = p.year, m = p.month - 1
                    if (m < 1) { m = 12; y-- }
                    return { year: y, month: m }
                  })}
                  className="flex h-7 w-7 items-center justify-center rounded bg-muted text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setMonthCursor(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 } })}
                  className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  本月
                </button>
                <button
                  onClick={() => setMonthCursor((p) => {
                    let y = p.year, m = p.month + 1
                    if (m > 12) { m = 1; y++ }
                    return { year: y, month: m }
                  })}
                  className="flex h-7 w-7 items-center justify-center rounded bg-muted text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-muted">
                    {WEEKDAY_CN.map((w, i) => (
                      <th key={w} className="px-1.5 py-2 text-center text-xs font-semibold" style={{ color: i >= 5 ? '#FBBF24' : 'var(--muted-foreground)' }}>{w}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthGrid.map((week, wi) => (
                    <tr key={wi}>
                      {week.map((d, di) => {
                        const bg = dayBgStyle(d)
                        return (
                          <td
                            key={di}
                            className="align-top p-1.5"
                            style={{
                              height: 64,
                              minWidth: 70,
                              background: bg.background || 'transparent',
                              borderTop: '1px solid var(--border)',
                              borderLeft: di > 0 ? '1px solid var(--border)' : 'none',
                              ...(d?.is_today ? { boxShadow: 'inset 0 0 0 2px rgba(59,130,246,0.4)' } : {}),
                            }}
                            title={d?.holiday_name || ''}
                          >
                            {d && (
                              <div className="flex h-full flex-col gap-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-bold" style={{ color: dateColor(d) }}>
                                    {Number(d.duty_date.slice(8))}
                                  </span>
                                  <span className="text-[9px]" style={{ color: d.is_holiday ? '#A78BFA' : 'var(--muted-foreground)' }}>
                                    {d.is_holiday ? '休' : '班'}
                                  </span>
                                </div>
                                {d.holiday_name && (
                                  <div className="truncate text-[9px]" style={{ color: '#A78BFA' }} title={d.holiday_name}>{d.holiday_name}</div>
                                )}
                                <div className="flex items-center gap-0.5 text-[10px]">
                                  <Sun className="h-2.5 w-2.5 shrink-0" style={{ color: C.day }} />
                                  <span className="truncate text-muted-foreground">{fmtMembers(d.day_members)}</span>
                                </div>
                                <div className="flex items-center gap-0.5 text-[10px]">
                                  <Moon className="h-2.5 w-2.5 shrink-0" style={{ color: C.night }} />
                                  <span className="truncate text-muted-foreground">{fmtMembers(d.night_members)}</span>
                                </div>
                              </div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 图例 */}
            <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.35)' }} /> 节假日
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }} /> 周末
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'var(--muted)', border: '1px solid var(--border)' }} /> 工作日
              </span>
            </div>
          </section>
        </div>
      </div>
      )}
    </div>
  )
}

// 重保值班安排表：近 7 天、按组别分列（沿用深色主题，正式值班表布局）
function ReserveDutySheet({ days = [], today = '', memberGroups = [] }) {
  const groups = useMemo(() => {
    // 优先使用全部启用人员的组别（保证空组别也显示列），再补充排班中出现但未在人员表中的组
    const set = new Set((memberGroups || []).filter(Boolean))
    days.forEach((d) => {
      ;[...(d.day_members || []), ...(d.night_members || [])].forEach((m) => {
        set.add((m.group_name || '').trim() || '未分组')
      })
    })
    return set.size > 0 ? Array.from(set) : ['值班人员']
  }, [days, memberGroups])
  const flatMode = groups.length === 1 && groups[0] === '值班人员'
  const start = days[0]?.duty_date || today
  const end = days[days.length - 1]?.duty_date || today

  const membersOf = (members, group) => {
    const list = members || []
    return flatMode ? list : list.filter((m) => ((m.group_name || '').trim() || '未分组') === group)
  }
  const renderMembers = (members, group) => {
    const picked = membersOf(members, group)
    if (picked.length === 0) return <span className="text-muted-foreground/40">—</span>
    return (
      <div className="flex flex-wrap items-center justify-center gap-1">
        {picked.map((m) => (
          <span key={m.id} className="inline-flex max-w-full items-center rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
            <span className="truncate">{m.name}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-tech-grid p-6">
      <div className="relative w-full max-w-[1500px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-red-500/80 to-transparent" />
        <div className="bg-gradient-to-r from-red-500/[0.08] via-transparent to-transparent px-6 pb-4 pt-5">
          <div className="flex items-center justify-center gap-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-500 ring-1 ring-inset ring-red-500/25">
              <ShieldCheck className="h-3 w-3" />重保
            </span>
            <h2 className="text-center text-2xl font-bold tracking-wide text-foreground">近7天重保网络安全保障值班安排</h2>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{start} 至 {end}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" />白班 09:00-21:00</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-purple-500" />晚班 21:00-09:00</span>
          </div>
        </div>

        <div className="max-h-[calc(100vh-250px)] overflow-auto border-t border-border">
          <table className="w-full table-fixed border-collapse text-center text-sm">
            <colgroup>
              <col style={{ width: '120px' }} />
              <col style={{ width: '170px' }} />
              {groups.map((g) => <col key={g} />)}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/95 text-muted-foreground backdrop-blur">
                <th className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold">日期</th>
                <th className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold">班次</th>
                {groups.map((g) => (
                  <th key={g} className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold last:border-r-0">{g}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, idx) => {
                const rowBg = d.is_today ? 'bg-primary/10' : idx % 2 === 1 ? 'bg-muted/20' : ''
                return (
                  <Fragment key={d.duty_date}>
                    <tr className={`${rowBg} transition-colors hover:bg-accent/30`}>
                      <td rowSpan={2} className="border-b border-r border-border bg-muted/30 px-2 py-2.5 align-middle">
                        <div className="text-sm font-semibold tabular-nums text-foreground">{String(d.duty_date || '').replaceAll('-', '/')}</div>
                        <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                          {d.weekday}{d.is_today ? ' · 今天' : ''}
                        </div>
                      </td>
                      <td className="border-b border-r border-border px-2 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500 ring-1 ring-inset ring-blue-500/20">
                          <Sun className="h-3 w-3" />白班
                        </span>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">09:00-21:00</div>
                      </td>
                      {groups.map((g) => (
                        <td key={g} className="border-b border-r border-border px-2 py-2.5 last:border-r-0">{renderMembers(d.day_members, g)}</td>
                      ))}
                    </tr>
                    <tr className={`${rowBg} transition-colors hover:bg-accent/30`}>
                      <td className="border-b border-r border-border px-2 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-500 ring-1 ring-inset ring-purple-500/20">
                          <Moon className="h-3 w-3" />晚班
                        </span>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">21:00-09:00</div>
                      </td>
                      {groups.map((g) => (
                        <td key={g} className="border-b border-r border-border px-2 py-2.5 last:border-r-0">{renderMembers(d.night_members, g)}</td>
                      ))}
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {days.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">近 7 天暂无排班</div>
          )}
        </div>
      </div>
    </div>
  )
}
