// 值班表（图形化）：把左侧值班人员拖拽到日历中的白班/晚班区域，直接生成/修改当日排班。
// 与「值班表」页共用同一份 duty_records 数据，只是操作方式不同（拖拽 vs 文字/点击）。
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays, ChevronLeft, ChevronRight, GripVertical, Search, ShieldCheck,
  Sun, Moon, X, Info, RefreshCw, ArrowLeft,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { Button, PageContainer } from '../components/ui'
import { inputBaseCls } from '../components/property/FormControls'
import { hasPermission } from '../utils/permissions'
import dutyApi from '../api/duty'

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const DRAG_MIME = 'application/x-soar-duty-member'

const ROSTER_TYPES = [
  { value: 'DAILY', label: '日常运营', icon: CalendarDays, activeCls: 'bg-blue-500/10 text-blue-500 ring-1 ring-inset ring-blue-500/25' },
  { value: 'RESERVE', label: '重保值班', icon: ShieldCheck, activeCls: 'bg-red-500/10 text-red-500 ring-1 ring-inset ring-red-500/25' },
]

export default function DutyScheduleGraph() {
  const navigate = useNavigate()
  const canEdit = hasPermission('duty_schedule', 'edit')
  const today = new Date()

  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 })
  const [rosterType, setRosterType] = useState('DAILY')
  const [days, setDays] = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dragOver, setDragOver] = useState('')
  const [assigning, setAssigning] = useState('')

  const loadMonth = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await dutyApi.monthSchedule(cursor.year, cursor.month, rosterType)
      setDays(res?.days || [])
    } catch (e) {
      toast.error(e.message || '加载值班表失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [cursor, rosterType])

  useEffect(() => { loadMonth() }, [loadMonth])
  useEffect(() => { dutyApi.allMembers('').then(setMembers).catch(() => {}) }, [])

  // 月历网格（周一为首列）
  const calendarGrid = useMemo(() => {
    if (!days.length) return []
    const first = new Date(`${days[0].duty_date}T00:00:00`)
    const lead = (first.getDay() + 6) % 7
    const cells = new Array(lead).fill(null)
    days.forEach((d) => cells.push(d))
    while (cells.length % 7 !== 0) cells.push(null)
    const weeks = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
    return weeks
  }, [days])

  // 全部人员（不再分类别），支持姓名/电话搜索
  const filteredMembers = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return members.filter((m) => {
      if (!kw) return true
      return (m.name || '').toLowerCase().includes(kw) || (m.phone || '').includes(kw)
    })
  }, [members, search])

  const memberName = useCallback((id) => members.find((m) => m.id === id)?.name || '人员', [members])

  // 拖动人员 → 追加到某日某班次；action=remove 用于移除单个人员
  const assign = useCallback(async (day, shift, memberId, action = 'add') => {
    if (!canEdit) return
    const key = `${day.duty_date}-${shift}`
    if (assigning === key) return
    setAssigning(key)
    try {
      const res = await dutyApi.graphAssign({
        duty_date: day.duty_date,
        roster_type: rosterType,
        shift,
        member_id: memberId,
        action,
        reason: '图形化排班',
      })
      const shiftLabel = shift === 'DAY' ? '白班' : '晚班'
      if (action === 'remove') {
        toast.success(`已从 ${day.duty_date} ${shiftLabel} 移除 ${memberName(memberId)}`)
      } else if (res?.changed === false) {
        toast.warning(`${memberName(memberId)} 已在该班次中`)
      } else {
        toast.success(`已添加 ${memberName(memberId)} 到 ${day.duty_date} ${shiftLabel}`)
      }
      await loadMonth(true)
    } catch (e) {
      toast.error(e.message || '排班失败')
    } finally {
      setAssigning('')
    }
  }, [canEdit, assigning, rosterType, memberName, loadMonth])

  const handleDragStart = (e, m) => {
    e.dataTransfer.setData(DRAG_MIME, String(m.id))
    e.dataTransfer.setData('text/plain', String(m.id))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleDragOver = (e, key) => {
    if (!canEdit) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (dragOver !== key) setDragOver(key)
  }

  const handleDragLeave = (e, key) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOver((prev) => (prev === key ? '' : prev))
    }
  }

  const handleDrop = (e, day, shift) => {
    e.preventDefault()
    setDragOver('')
    if (!canEdit) return
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')
    const memberId = Number(raw)
    if (!memberId) return
    assign(day, shift, memberId)
  }

  // 单个班次拖放区：支持多人，拖入追加，每人可单独移除
  const renderSlot = (day, shift) => {
    const isDay = shift === 'DAY'
    const slotMembers = isDay ? (day.day_members || []) : (day.night_members || [])
    const needsAdjust = isDay ? day.day_needs_adjust : day.night_needs_adjust
    const key = `${day.duty_date}-${shift}`
    const over = dragOver === key
    const busy = assigning === key
    const base = isDay
      ? (slotMembers.length ? 'border-blue-500/30 bg-blue-500/5' : 'border-dashed border-border bg-background/40')
      : (slotMembers.length ? 'border-purple-500/30 bg-purple-500/5' : 'border-dashed border-border bg-background/40')
    const titleText = slotMembers.map((m) => `${m.name} ${m.phone || ''}`).join('，')
    return (
      <div
        onDragOver={canEdit ? (e) => handleDragOver(e, key) : undefined}
        onDragLeave={canEdit ? (e) => handleDragLeave(e, key) : undefined}
        onDrop={canEdit ? (e) => handleDrop(e, day, shift) : undefined}
        className={`group flex min-h-[38px] flex-col gap-0.5 rounded border px-1.5 py-1 transition-colors ${over ? 'border-primary bg-primary/10 ring-1 ring-inset ring-primary/40' : base} ${busy ? 'opacity-40' : ''} ${canEdit ? 'hover:border-primary/50' : ''}`}
        title={slotMembers.length ? `${isDay ? '白班' : '晚班'}：${titleText}` : `${isDay ? '白班' : '晚班'}：将人员拖到此处`}
      >
        <div className="flex items-center gap-1">
          {isDay
            ? <Sun className="h-3 w-3 shrink-0 text-blue-500" />
            : <Moon className="h-3 w-3 shrink-0 text-purple-500" />}
          {slotMembers.length === 0 && (
            <span className="truncate text-[10px] text-muted-foreground">
              {canEdit ? (over ? '松开鼠标添加' : '拖入人员') : '未安排'}
            </span>
          )}
        </div>
        {slotMembers.map((m) => (
          <div key={m.id} className="flex items-center gap-1 rounded bg-background/80 px-1 py-0.5">
            <span className={`min-w-0 flex-1 truncate text-xs font-medium ${needsAdjust ? 'text-amber-500' : 'text-foreground'}`}>{m.name}</span>
            {canEdit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); assign(day, shift, m.id, 'remove') }}
                disabled={busy}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                title={`移除 ${m.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    )
  }

  const shiftMonth = (delta) => {
    setCursor((prev) => {
      let year = prev.year
      let month = prev.month + delta
      if (month < 1) { month = 12; year -= 1 }
      if (month > 12) { month = 1; year += 1 }
      return { year, month }
    })
  }
  const goToday = () => {
    const d = new Date()
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  return (
    <PageContainer>
      {/* 标题 + 控制区 */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground whitespace-nowrap">值班表（图形化）</h1>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${rosterType === 'RESERVE' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-500'}`}>
              {rosterType === 'RESERVE' ? <ShieldCheck className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
              {rosterType === 'RESERVE' ? '重保值班' : '日常运营'}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">从左侧拖拽人员到日历中的白班/晚班区域即可排班；与「值班表」页共用同一份排班数据</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('/duty/schedule')} title="返回值班表">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />返回值班表
          </Button>
          <div className="flex items-center rounded-md border border-border p-0.5">
            {ROSTER_TYPES.map((t) => {
              const Icon = t.icon
              const active = rosterType === t.value
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setRosterType(t.value)}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${active ? `font-medium ${t.activeCls}` : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button type="button" onClick={() => shiftMonth(-1)} className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground" title="上一月">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-1 text-sm font-medium tabular-nums whitespace-nowrap">{cursor.year} 年 {MONTH_CN[cursor.month - 1]}</span>
            <button type="button" onClick={() => shiftMonth(1)} className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground" title="下一月">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={goToday} className="rounded px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground">本月</button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => loadMonth()} title="刷新">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* 操作提示 */}
      <div className="mb-3 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          拖动左侧人员到日历中的「白班 / 晚班」区域即可排班；拖入为追加，可重复拖入多人，悬停每个人员可点 × 单独移除。
          拖拽只修改当前格，不影响其他日期；同一人同一天不能同时排白班和晚班。
          {!canEdit && <span className="ml-1 text-amber-500">当前账号无排班编辑权限，仅可查看。</span>}
        </span>
      </div>

      <div className="flex items-start gap-4">
        {/* 左侧人员池 */}
        <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-card" style={{ maxHeight: 'calc(100vh - 220px)' }}>
          <div className="border-b border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">值班人员</span>
              <span className="text-xs text-muted-foreground">{members.length} 人</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className={`${inputBaseCls} h-8 w-full pl-7 text-xs`}
                placeholder="搜索姓名 / 电话"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {filteredMembers.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无可用人员</div>
            ) : filteredMembers.map((m) => (
              <div
                key={m.id}
                draggable={canEdit}
                onDragStart={canEdit ? (e) => handleDragStart(e, m) : undefined}
                className={`flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1.5 ${canEdit ? 'cursor-grab active:cursor-grabbing hover:border-primary/50 hover:bg-accent' : ''}`}
                title={canEdit ? `拖动 ${m.name} 到日历排班` : m.name}
              >
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{m.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{m.phone || '未填电话'}</div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* 日历 */}
        <div className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-card">
          {loading ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">正在加载排班…</div>
          ) : calendarGrid.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无数据</div>
          ) : (
            <table className="w-full min-w-[860px] border-collapse">
              <thead>
                <tr className="border-b border-border bg-muted">
                  {WEEKDAY_CN.map((w, i) => (
                    <th key={w} className={`px-2 py-2 text-center text-xs font-semibold whitespace-nowrap ${i >= 5 ? 'text-amber-500/80' : 'text-muted-foreground'}`}>{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calendarGrid.map((week, wi) => (
                  <tr key={wi}>
                    {week.map((d, di) => (
                      <td
                        key={di}
                        className={`align-top border border-border p-1.5 ${d && d.is_today ? 'bg-primary/5 ring-1 ring-inset ring-primary' : ''} ${d && d.is_holiday ? 'bg-purple-500/5' : ''}`}
                        style={{ width: '14.28%', verticalAlign: 'top' }}
                      >
                        {d && (
                          <div className="flex min-h-[170px] flex-col gap-1">
                            <div className="flex items-center justify-between">
                              <span className={`text-sm font-semibold tabular-nums ${di >= 5 ? 'text-amber-500' : 'text-foreground'}`}>
                                {Number(d.duty_date.slice(8, 10))}
                              </span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{d.is_holiday ? '休' : '班'}</span>
                            </div>
                            {d.holiday_name && (
                              <div className="truncate text-[9px] text-purple-500" title={d.holiday_name}>{d.holiday_name}</div>
                            )}
                            {renderSlot(d, 'DAY')}
                            {renderSlot(d, 'NIGHT')}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
