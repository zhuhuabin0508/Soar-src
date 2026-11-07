// 值班大屏：嵌入运营大屏内容区，与安全运营/AI 用量/材料管理大屏保持同一卡片体系与视觉规范；
// 顶部提供「日常值班 / 重保值班」二级切换，重保视图为近 7 天正式值班安排表
import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import { Maximize2, Minimize2, AlertTriangle, CalendarDays, Sun, Moon, Phone, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'
import dutyApi from '../api/duty'
import { Skeleton, EmptyState } from '../components/ui'

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

// 值班大屏二级子标签：日常值班 / 重保值班（风格与主 Tab 切换组件一致）
const ROSTER_VIEWS = [
  { value: 'DAILY', label: '日常值班', icon: CalendarDays },
  { value: 'RESERVE', label: '重保值班', icon: ShieldCheck },
]

// 主题色（班次 / 调整语义色，亮暗色通用）
const C = {
  day: '#3B82F6',
  night: '#8B5CF6',
  adjust: '#EAB308',
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

// ============ 卡片容器（与其余大屏 ChartCard 同规范） ============
function DutyCard({ title, icon: Icon, iconStyle, extra, children }) {
  return (
    <div
      className="card-accent-top card-hover w-full rounded-xl border border-border bg-card p-5 shadow-lg"
      style={{ animation: 'card-enter 0.35s ease-out' }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 shrink-0" style={iconStyle} />}
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </div>
        {extra}
      </div>
      {children}
    </div>
  )
}

// ============ KPI 卡片（与其余大屏 KpiCard 同规范，无点击态） ============
function DutyKpiCard({ label, icon: Icon, iconStyle, hint, children }) {
  return (
    <div
      className="card-accent-top card-hover relative min-w-0 flex-1 rounded-xl border border-border bg-card p-5 shadow-lg"
      style={{ animation: 'card-enter 0.35s ease-out' }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        {Icon && <Icon className="h-4 w-4 shrink-0" style={iconStyle} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-1">{children}</div>
      {hint && (
        <div className="mt-2 inline-flex max-w-full items-center gap-1 truncate rounded-md bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  )
}

export default function DutyDashboard({ refreshing, autoRefresh }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 二级子标签当前视图：DAILY=日常值班 / RESERVE=重保值班
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
      setError('')
    } catch (e) {
      setError(e.message || '加载失败')
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

  // 初始加载 + 60s 自动刷新（受 autoRefresh 控制，与其余大屏一致）
  useEffect(() => {
    loadData()
    if (!autoRefresh) return
    const timer = setInterval(loadData, 60000)
    return () => clearInterval(timer)
  }, [loadData, autoRefresh])

  // 外部触发刷新（顶部「刷新」按钮）
  useEffect(() => {
    if (refreshing) loadData()
  }, [refreshing, loadData])

  // 时钟 1s 刷新（驱动倒计时）
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 月度排班加载
  useEffect(() => {
    loadMonth(monthCursor.year, monthCursor.month)
  }, [monthCursor, loadMonth])

  // 全屏切换（作用于内容区自身，全屏时补齐大屏底纹与内边距）
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }, [])

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

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
  const upcoming7 = data?.upcoming_7days || []

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

  if (loading) return <Skeleton className="h-96 w-full" />
  if (error) return <EmptyState title="加载失败" description={error} icon={AlertTriangle} />
  if (!data) return null

  return (
    <div
      ref={containerRef}
      className={`flex w-full flex-col gap-4 ${fullscreen ? 'overflow-y-auto bg-background bg-tech-grid p-6' : ''}`}
    >
      {/* ===== 二级切换：日常值班 / 重保值班（与其余大屏 Tab/内层切换同规范） ===== */}
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
          {ROSTER_VIEWS.map((v) => {
            const Icon = v.icon
            const active = rosterType === v.value
            return (
              <button
                key={v.value}
                type="button"
                onClick={() => setRosterType(v.value)}
                className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                    : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {v.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{rosterType === 'RESERVE' ? '近 7 天重保值班安排表' : '当前班次 · 近 7 天排班 · 月度排班'}</span>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? '退出全屏' : '全屏'}
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        </div>
      </div>

      {rosterType === 'RESERVE' ? (
        /* 重保视图：近 7 天正式值班安排表 */
        <ReserveDutySheet days={upcoming7} today={data?.today} memberGroups={data?.member_groups} />
      ) : (
        <Fragment>
          {/* ===== 1. 近 7 天排班（首行全宽） ===== */}
          <DutyCard title="近 7 天排班" icon={CalendarDays} iconStyle={{ color: shiftColor }}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {upcoming7.map((d, i) => {
                const bg = dayBgStyle(d)
                return (
                  <div
                    key={i}
                    className="min-w-0 rounded-lg border border-border bg-secondary p-2.5 transition-colors hover:border-primary/40"
                    style={{
                      ...(bg.background ? bg : {}),
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
                      <div className="mb-1.5 truncate text-[10px] font-medium" style={{ color: '#A78BFA' }}>
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
                        需调整
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {upcoming7.length === 0 && (
              <EmptyState icon={CalendarDays} title="暂无排班" description="生成值班表后将在此展示" />
            )}
          </DutyCard>

          {/* ===== 2. KPI 卡片行（三张） ===== */}
          <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
            {/* 当前班次 + 下班倒计时 */}
            <DutyKpiCard
              label="当前班次"
              icon={data?.current_shift === 'DAY' ? Sun : Moon}
              iconStyle={{ color: shiftColor }}
              hint={data?.current_shift === 'DAY' ? '09:00 - 18:00' : '18:00 - 次日 09:00'}
            >
              <span className="text-glow text-4xl font-bold tabular-nums" style={{ color: shiftTextColor }}>
                {shiftTitle}
              </span>
              <span className="text-sm text-muted-foreground">距下班 {countdown}</span>
            </DutyKpiCard>

            {/* 值班人员 */}
            <DutyKpiCard
              label="值班人员"
              icon={CalendarDays}
              iconStyle={{ color: shiftColor }}
              hint={fmtPhones(curMembers) ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{fmtPhones(curMembers)}</span> : null}
            >
              {curMembers.length > 0 ? (
                <span
                  className={`min-w-0 truncate text-glow font-bold text-foreground ${curMembers.length > 1 ? 'text-2xl' : 'text-4xl'}`}
                  title={fmtMembers(curMembers)}
                >
                  {fmtMembers(curMembers)}
                </span>
              ) : (
                <span className="text-2xl font-semibold text-muted-foreground">暂未排班</span>
              )}
            </DutyKpiCard>

            {/* 备班人员 */}
            <DutyKpiCard label="备班人员" icon={ShieldCheck}>
              {backupMember ? (
                <span className="text-glow truncate text-4xl font-bold text-foreground">{backupMember.name}</span>
              ) : (
                <span className="text-2xl font-semibold text-muted-foreground">--</span>
              )}
            </DutyKpiCard>
          </div>

          {/* ===== 3. 月度排班日历 ===== */}
          <DutyCard
            title={`${monthCursor.year} 年 ${MONTH_CN[monthCursor.month - 1]} 排班`}
            icon={CalendarDays}
            extra={
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMonthCursor((p) => {
                    let y = p.year, m = p.month - 1
                    if (m < 1) { m = 12; y-- }
                    return { year: y, month: m }
                  })}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  title="上个月"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setMonthCursor(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 } })}
                  className="rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                >
                  本月
                </button>
                <button
                  type="button"
                  onClick={() => setMonthCursor((p) => {
                    let y = p.year, m = p.month + 1
                    if (m > 12) { m = 1; y++ }
                    return { year: y, month: m }
                  })}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  title="下个月"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            }
          >
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="bg-secondary">
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
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.35)' }} /> 节假日
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }} /> 周末
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }} /> 工作日
              </span>
              <span className="flex items-center gap-1">
                <Sun className="h-3 w-3" style={{ color: C.day }} /> 白班 09:00-21:00
              </span>
              <span className="flex items-center gap-1">
                <Moon className="h-3 w-3" style={{ color: C.night }} /> 晚班 21:00-09:00
              </span>
            </div>
          </DutyCard>
        </Fragment>
      )}
    </div>
  )
}

// 重保值班安排表：近 7 天、按组别分列（嵌入卡片体系，正式值班表布局）
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
          <span key={m.id} className="inline-flex max-w-full items-center rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-foreground">
            <span className="truncate">{m.name}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="flex w-full justify-center">
      <div
        className="card-accent-top card-hover relative w-full max-w-[1500px] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        style={{ animation: 'card-enter 0.35s ease-out' }}
      >
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

        <div className="max-h-[65vh] overflow-auto border-t border-border">
          <table className="w-full table-fixed border-collapse text-center text-sm">
            <colgroup>
              <col style={{ width: '120px' }} />
              <col style={{ width: '170px' }} />
              {groups.map((g) => <col key={g} />)}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-secondary/95 text-muted-foreground backdrop-blur">
                <th className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold">日期</th>
                <th className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold">班次</th>
                {groups.map((g) => (
                  <th key={g} className="border-b border-r border-border px-2 py-2.5 text-xs font-semibold last:border-r-0">{g}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, idx) => {
                const rowBg = d.is_today ? 'bg-primary/10' : idx % 2 === 1 ? 'bg-secondary/20' : ''
                return (
                  <Fragment key={d.duty_date}>
                    <tr className={`${rowBg} transition-colors hover:bg-accent/30`}>
                      <td rowSpan={2} className="border-b border-r border-border bg-secondary/30 px-2 py-2.5 align-middle">
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
