// 值班表页：查看（列表/月视图）+ 编辑排班（每班可多人）+ 发布 + 导出 + 特殊日期
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, List, Download, CalendarCog, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, Sun, Moon, CalendarOff, ClipboardCheck, Trash2, ShieldCheck, Layers, Pencil, Plus, LayoutGrid } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import HalfDrawer from '../components/HalfDrawer'
import { inputBaseCls, labelCls } from '../components/property/FormControls'
import { Button, PageContainer, Badge, EmptyState, DataTable, LoadingState, CompactSelect, DatePicker } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import dutyApi from '../api/duty'

const STATUS_META = {
  draft: { label: '草稿', variant: 'warning' },
  published: { label: '已发布', variant: 'success' },
  expired: { label: '已过期', variant: 'neutral' },
}
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
// 值班表类型：日常运营 / 重保 / 全部（同一日期两类表并存；ALL 仅用于查看与导出）
const ROSTER_TYPES = [
  { value: 'DAILY', label: '日常运营', icon: CalendarDays, color: 'text-blue-500', activeCls: 'bg-blue-500/10 text-blue-500 ring-1 ring-inset ring-blue-500/25' },
  { value: 'RESERVE', label: '重保值班', icon: ShieldCheck, color: 'text-red-500', activeCls: 'bg-red-500/10 text-red-500 ring-1 ring-inset ring-red-500/25' },
  { value: 'ALL', label: '全部', icon: Layers, color: 'text-foreground', activeCls: 'bg-muted text-foreground ring-1 ring-inset ring-border' },
]
const rosterLabel = (t) => (t === 'RESERVE' ? '重保值班' : t === 'ALL' ? '全部' : '日常运营')
const rosterShort = (t) => (t === 'RESERVE' ? '重保' : t === 'ALL' ? '全部' : '日常运营')
const rosterScope = (t) => (t === 'ALL' ? '全部类型' : rosterLabel(t))
// 空态文案：全部时不加类型前缀
const rosterEmpty = (t) => (t === 'ALL' ? '暂无值班记录' : `暂无${rosterShort(t)}值班记录`)

function todayStr() { return fmtLocalDate(new Date()) }
function fmtLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 枚举日期范围（含首尾），最多 62 天
function buildDateRange(start, end) {
  if (!start || !end || end < start) return []
  const out = []
  const d = new Date(`${start}T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  while (d <= e && out.length < 62) {
    out.push(fmtLocalDate(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}
function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const end = fmtLocalDate(new Date(year, month, 0))
  return { start, end }
}

export default function DutySchedule() {
  const navigate = useNavigate()
  const canEdit = hasPermission('duty_schedule', 'edit')
  const canDelete = hasPermission('duty_schedule', 'delete')

  // 视图模式与日期范围
  const today = new Date()
  const [view, setView] = useState('list') // list | month
  const [range, setRange] = useState(monthRange(today.getFullYear(), today.getMonth() + 1))
  // 值班表类型：日常运营 / 重保 / 全部（页面所有查询都按当前类型隔离；默认展示全部）
  const [rosterType, setRosterType] = useState('ALL')

  const [list, setList] = useState([])
  const [monthData, setMonthData] = useState({ days: [] })
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState(null)
  const [members, setMembers] = useState([])

  // 筛选
  const [filterGroup, setFilterGroup] = useState('')
  const [filterMember, setFilterMember] = useState(0)
  const [showPhone, setShowPhone] = useState(true) // 显示电话
  const [onlyPending, setOnlyPending] = useState(false) // 只看待分配/需调整

  // 整条记录编辑（草稿/已发布均可，支持每班多人）
  const [editTarget, setEditTarget] = useState(null)
  const [editForm, setEditForm] = useState({ day_member_ids: [], night_member_ids: [], status: 'draft' })
  const [editSaving, setEditSaving] = useState(false)
  const [editMembers, setEditMembers] = useState([]) // 含停用人员，供编辑下拉选择

  // 新建值班表（手动指定每天人员，替代原自动生成）
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({
    roster_type: 'DAILY',
    start_date: todayStr(),
    end_date: todayStr(),
    conflict_strategy: 'overwrite',
    auto_publish: false,
  })
  const [createDays, setCreateDays] = useState([])
  const [creating, setCreating] = useState(false)

  // 特殊日期抽屉
  const [specialOpen, setSpecialOpen] = useState(false)
  const [specialList, setSpecialList] = useState([])
  const [specialForm, setSpecialForm] = useState({ date: todayStr(), day_type: 'holiday', note: '' })
  const [specialLoading, setSpecialLoading] = useState(false)

  const loadMembers = useCallback(() => {
    dutyApi.allMembers('').then(setMembers).catch(() => {})
  }, [])

  const loadList = useCallback(() => {
    setLoading(true)
    dutyApi.listSchedule({ start_date: range.start, end_date: range.end, roster_type: rosterType, group_name: filterGroup, member_id: filterMember })
      .then((res) => setList(res.items || []))
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [range, rosterType, filterGroup, filterMember])

  const loadMonth = useCallback(() => {
    const [y, m] = range.start.split('-').map(Number)
    setLoading(true)
    dutyApi.monthSchedule(y, m, rosterType)
      .then((res) => setMonthData(res))
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [range.start, rosterType])

  const loadStats = useCallback(() => {
    dutyApi.scheduleStats({ start_date: range.start, end_date: range.end, roster_type: rosterType })
      .then(setStats)
      .catch(() => {})
  }, [range.start, range.end, rosterType])

  useEffect(() => { loadMembers() }, [loadMembers])
  useEffect(() => { view === 'list' ? loadList() : loadMonth() }, [view, loadList, loadMonth])
  useEffect(() => { loadStats() }, [loadStats])

  // 今日值班（从已加载数据提取；「全部」视图下可能同时有日常/重保两条）
  const todayStr2 = todayStr()
  const todayDuties = useMemo(() => {
    if (view === 'list') return list.filter((r) => r.duty_date === todayStr2)
    const day = (monthData.days || []).find((d) => d.duty_date === todayStr2)
    if (!day) return []
    if (rosterType === 'ALL') return day.entries || []
    return [day]
  }, [view, list, monthData, rosterType, todayStr2])

  // 发布当前日期范围内的草稿记录（排班由手动编辑/图形化拖拽产生）
  const handlePublishRange = () => {
    confirm({ title: '确认发布值班表', message: `将 ${range.start} 至 ${range.end} 范围内「${rosterScope(rosterType)}」值班表的草稿记录发布为已发布？发布后该范围内的记录将锁定，手动调班不再触发自动接排。`, variant: 'info', confirmText: '发布' })
      .then((ok) => {
        if (!ok) return
        dutyApi.confirm(range.start, range.end, rosterType)
          .then((res) => { toast.success(`已发布 ${res.published} 条`); view === 'list' ? loadList() : loadMonth(); loadStats() })
          .catch((e) => toast.error(e.message || '发布失败'))
      })
  }
  // 删除单条值班记录（admin）
  const [deletingRecordId, setDeletingRecordId] = useState(null)
  const handleDeleteRecord = (row) => {
    confirm({
      title: '删除值班记录',
      message: `确认删除 ${row.duty_date}（${row.weekday}）的值班记录？该日白班/晚班安排及关联调班日志将一并清除，不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setDeletingRecordId(row.id)
      dutyApi.deleteRecord(row.id)
        .then(() => { toast.success('值班记录已删除'); view === 'list' ? loadList() : loadMonth(); loadStats() })
        .catch((e) => toast.error(e.message || '删除失败'))
        .finally(() => setDeletingRecordId(null))
    })
  }

  // 整条记录编辑：打开弹窗（草稿/已发布均可，已过期不可编辑）
  const openEditRecord = useCallback((row) => {
    if (!canEdit) return
    if (!row.id) return toast.warning('该日期暂无值班记录，请到「值班表（图形化）」拖拽人员创建')
    if (row.status === 'expired') return toast.warning('已过期记录不可编辑')
    const dayIds = (row.day_members || (row.day_member ? [row.day_member] : [])).map((m) => m.id)
    const nightIds = (row.night_members || (row.night_member ? [row.night_member] : [])).map((m) => m.id)
    setEditTarget(row)
    setEditForm({
      day_member_ids: dayIds,
      night_member_ids: nightIds,
      status: row.status === 'published' ? 'published' : 'draft',
    })
    if (editMembers.length === 0) {
      dutyApi.members({ page: 1, size: 200 })
        .then((res) => setEditMembers(res.items || []))
        .catch(() => {})
    }
  }, [canEdit, editMembers.length])

  const handleSaveEdit = () => {
    if (!editTarget) return
    const dayIds = editForm.day_member_ids
    const nightIds = editForm.night_member_ids
    if (dayIds.some((id) => nightIds.includes(id))) return toast.error('同一人不能同时排白班和晚班')
    setEditSaving(true)
    dutyApi.editRecord(editTarget.id, {
      day_member_ids: dayIds,
      night_member_ids: nightIds,
      status: editForm.status,
      reason: '数据编辑',
    })
      .then(() => {
        toast.success('值班记录已更新')
        setEditTarget(null)
        view === 'list' ? loadList() : loadMonth()
        loadStats()
      })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setEditSaving(false))
  }

  // 勾选/取消某班次人员（支持多人）
  const toggleEditMember = (field, id) => {
    setEditForm((f) => {
      const ids = f[field] || []
      return { ...f, [field]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] }
    })
  }

  // ===== 新建值班表（手动指定每天人员） =====
  const makeCreateDay = (date, existing) => existing || ({
    date,
    weekday: WEEKDAY_CN[(new Date(`${date}T00:00:00`).getDay() + 6) % 7],
    day_member_ids: [],
    night_member_ids: [],
  })

  // 重建日期列表，并把已有记录的人员带入（避免覆盖时误清空）
  const syncCreateDays = useCallback(async (start, end, rtype) => {
    const dates = buildDateRange(start, end)
    let existing = {}
    if (dates.length) {
      try {
        const res = await dutyApi.listSchedule({ start_date: start, end_date: end, roster_type: rtype })
        existing = Object.fromEntries((res.items || []).map((r) => [r.duty_date, r]))
      } catch {
        existing = {}
      }
    }
    setCreateDays((prev) => {
      const prevMap = new Map(prev.map((d) => [d.date, d]))
      return dates.map((date) => {
        const p = prevMap.get(date)
        const rec = existing[date]
        const keep = p && (p.day_member_ids.length > 0 || p.night_member_ids.length > 0)
        return makeCreateDay(date, keep ? p : {
          ...(p || {}),
          date,
          weekday: WEEKDAY_CN[(new Date(`${date}T00:00:00`).getDay() + 6) % 7],
          day_member_ids: (rec?.day_members || []).map((m) => m.id),
          night_member_ids: (rec?.night_members || []).map((m) => m.id),
        })
      })
    })
  }, [])

  const openCreate = () => {
    const start = todayStr()
    const rtype = rosterType === 'RESERVE' ? 'RESERVE' : 'DAILY'
    setCreateForm({
      roster_type: rtype,
      start_date: start,
      end_date: start,
      conflict_strategy: 'overwrite',
      auto_publish: false,
    })
    setCreateDays([])
    setCreateOpen(true)
    syncCreateDays(start, start, rtype)
    if (editMembers.length === 0) {
      dutyApi.members({ page: 1, size: 200 })
        .then((res) => setEditMembers(res.items || []))
        .catch(() => {})
    }
  }

  const changeCreateRange = (field, value) => {
    const next = { ...createForm, [field]: value }
    setCreateForm(next)
    syncCreateDays(next.start_date, next.end_date, next.roster_type)
  }

  const changeCreateType = (value) => {
    const next = { ...createForm, roster_type: value }
    setCreateForm(next)
    setCreateDays((prev) => prev.map((d) => ({ ...d, day_member_ids: [], night_member_ids: [] })))
    syncCreateDays(next.start_date, next.end_date, value)
  }

  const toggleCreateMember = (date, field, id) => {
    setCreateDays((prev) => prev.map((d) => {
      if (d.date !== date) return d
      const ids = d[field] || []
      return { ...d, [field]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] }
    }))
  }

  const handleCreateSubmit = () => {
    if (!createDays.length) return toast.error('请选择有效的日期范围')
    if (createDays.length > 62) return toast.error('单次最多新建 62 天')
    for (const d of createDays) {
      if (d.day_member_ids.some((id) => d.night_member_ids.includes(id))) {
        return toast.error(`${d.date} 同一人不能同时排白班和晚班`)
      }
    }
    setCreating(true)
    dutyApi.manualCreate({
      start_date: createForm.start_date,
      end_date: createForm.end_date,
      roster_type: createForm.roster_type,
      conflict_strategy: createForm.conflict_strategy,
      auto_publish: createForm.auto_publish,
      days: createDays.map((d) => ({
        duty_date: d.date,
        day_member_ids: d.day_member_ids,
        night_member_ids: d.night_member_ids,
      })),
    })
      .then((res) => {
        toast.success(`新建 ${res.created} 条、更新 ${res.updated} 条、跳过 ${res.skipped} 条`)
        setCreateOpen(false)
        setRosterType(createForm.roster_type)
        setRange({ start: createForm.start_date, end: createForm.end_date })
      })
      .catch((e) => toast.error(e.message || '新建失败'))
      .finally(() => setCreating(false))
  }

  // 编辑下拉候选项：全量人员 + 当前记录上已有人员（防止停用/分页遗漏导致显示为空）
  const editMemberOptions = useMemo(() => {
    const map = new Map(editMembers.map((m) => [m.id, m]))
    const current = [
      ...(editTarget?.day_members || []),
      ...(editTarget?.night_members || []),
      editTarget?.day_member,
      editTarget?.night_member,
    ]
    current.forEach((m) => { if (m && !map.has(m.id)) map.set(m.id, m) })
    return Array.from(map.values())
  }, [editMembers, editTarget])

  // 导出（导出当前值班表类型）
  const handleExport = () => {
    dutyApi.exportSchedule(range.start, range.end, rosterType).catch((e) => toast.error(e.message || '导出失败'))
  }

  // 特殊日期
  const openSpecial = () => {
    setSpecialOpen(true)
    loadSpecial()
  }
  const loadSpecial = () => {
    setSpecialLoading(true)
    dutyApi.specialDates().then((res) => setSpecialList(res.items || [])).catch(() => {}).finally(() => setSpecialLoading(false))
  }
  const handleAddSpecial = () => {
    if (!specialForm.date) return toast.error('请选择日期')
    const items = [...specialList, { date: specialForm.date, day_type: specialForm.day_type, note: specialForm.note }]
    dutyApi.setSpecialDates(items)
      .then(() => { toast.success('已保存'); loadSpecial() })
      .catch((e) => toast.error(e.message || '保存失败'))
  }
  const handleDeleteSpecial = (d) => {
    dutyApi.deleteSpecialDate(d).then(() => { toast.success('已删除'); loadSpecial() }).catch((e) => toast.error(e.message || '删除失败'))
  }

  // 只看待分配/需调整：客户端二次过滤
  const filteredList = useMemo(() => {
    if (!onlyPending) return list
    return list.filter((r) => r.day_needs_adjust || r.night_needs_adjust || !(r.day_members || []).length || !(r.night_members || []).length)
  }, [list, onlyPending])

  // ===== 列表视图 =====
  const listColumns = useMemo(() => ([
    { key: 'duty_date', header: '日期', width: '110px', render: (r) => <span className="text-sm font-medium tabular-nums whitespace-nowrap">{r.duty_date}</span> },
    { key: 'weekday', header: '星期', width: '70px', render: (r) => <span className="text-sm text-muted-foreground whitespace-nowrap">{r.weekday || '--'}</span> },
    {
      key: 'day_type', header: '日期类型', width: '96px',
      render: (r) => r.is_holiday
        ? <span className="inline-flex items-center rounded bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-500 whitespace-nowrap">{r.holiday_name ? `非工作日` : '非工作日'}</span>
        : <span className="text-xs text-muted-foreground whitespace-nowrap">工作日</span>,
    },
    {
      key: 'roster_type', header: '值班表类型', width: '104px',
      render: (r) => (r.roster_type === 'RESERVE'
        ? <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500 whitespace-nowrap"><ShieldCheck className="h-3 w-3" />重保</span>
        : <span className="inline-flex items-center rounded bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500 whitespace-nowrap">日常运营</span>),
    },
    {
      key: 'day', header: '白班', width: '170px',
      render: (r) => <ShiftCell shift="DAY" members={r.day_members || []} needsAdjust={r.day_needs_adjust} showPhone={showPhone} onClick={() => openEditRecord(r)} canEdit={canEdit} />,
    },
    {
      key: 'night', header: '晚班', width: '170px',
      render: (r) => <ShiftCell shift="NIGHT" members={r.night_members || []} needsAdjust={r.night_needs_adjust} showPhone={showPhone} onClick={() => openEditRecord(r)} canEdit={canEdit} />,
    },
    {
      key: 'status', header: '状态', width: '84px',
      render: (r) => {
        const m = STATUS_META[r.status] || { label: r.status || '--' }
        const cls = r.status === 'published' ? 'bg-emerald-500/10 text-emerald-500' : r.status === 'draft' ? 'bg-amber-500/10 text-amber-500' : 'bg-muted text-muted-foreground'
        return <span className={`inline-flex items-center rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${cls}`}>{m.label}</span>
      },
    },
    ...(canEdit || canDelete ? [{
      key: 'actions', header: '操作', width: '180px',
      render: (r) => (
        <div className="flex items-center gap-1 whitespace-nowrap">
          {canEdit && (
            <button
              onClick={() => openEditRecord(r)}
              disabled={r.status === 'expired'}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              title={r.status === 'expired' ? '已过期记录不可编辑' : '编辑该日值班记录（白班/晚班/状态）'}
            >
              <Pencil className="h-3.5 w-3.5" />编辑
            </button>
          )}
          {canDelete && (
            <button onClick={() => handleDeleteRecord(r)} disabled={deletingRecordId === r.id}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50 whitespace-nowrap" title="删除该日值班记录">
              <Trash2 className="h-3.5 w-3.5" />{deletingRecordId === r.id ? '删除中' : '删除'}
            </button>
          )}
        </div>
      ),
    }] : []),
  ]), [canEdit, canDelete, showPhone, deletingRecordId, openEditRecord])

  // ===== 月视图网格 =====
  const calendarGrid = useMemo(() => {
    const days = monthData.days || []
    if (days.length === 0) return []
    const byDate = {}
    days.forEach((d) => { byDate[d.duty_date] = d })
    const first = new Date(days[0].duty_date)
    const leadDays = (first.getDay() + 6) % 7 // 周一为首列
    const cells = []
    for (let i = 0; i < leadDays; i++) cells.push(null)
    days.forEach((d) => cells.push(d))
    while (cells.length % 7 !== 0) cells.push(null)
    // 分周
    const weeks = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
    return weeks
  }, [monthData])

  const shiftMonth = (delta) => {
    const [y, m] = range.start.split('-').map(Number)
    let ny = y, nm = m + delta
    if (nm < 1) { nm = 12; ny -= 1 }
    if (nm > 12) { nm = 1; ny += 1 }
    setRange(monthRange(ny, nm))
  }

  return (
    <PageContainer className="flex flex-col">
      {/* 标题区 */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground whitespace-nowrap">值班表</h1>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${rosterType === 'RESERVE' ? 'bg-red-500/10 text-red-500' : rosterType === 'ALL' ? 'bg-muted text-muted-foreground' : 'bg-blue-500/10 text-blue-500'}`}>
              {rosterType === 'RESERVE' ? <ShieldCheck className="h-3 w-3" /> : rosterType === 'ALL' ? <Layers className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
              {rosterLabel(rosterType)}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">手动编辑每天白班/晚班人员（每班可多人，逗号分隔），支持列表/月视图查看、发布与导出；也可用「值班表（图形化）」拖拽排班</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 值班表类型切换：日常运营 / 重保，切换后列表、月视图、统计、导出均按类型隔离 */}
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
                  title={`查看${t.label}值班表`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>
          <div className="h-6 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={openSpecial}><CalendarCog className="mr-1 h-3.5 w-3.5" />特殊日期</Button>
          <Button variant="ghost" size="sm" onClick={handleExport}><Download className="mr-1 h-3.5 w-3.5" />导出</Button>
          {canEdit && stats && stats.draft > 0 && <Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={handlePublishRange}><CheckCircle2 className="mr-1 h-3.5 w-3.5" />发布草稿<span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-500">{stats.draft}</span></Button>}
          <Button variant="secondary" size="sm" onClick={() => navigate('/duty/schedule/graph')}><LayoutGrid className="mr-1 h-3.5 w-3.5" />值班表（图形化）</Button>
          {canEdit && <Button variant="primary" size="sm" onClick={openCreate}><Plus className="mr-1 h-3.5 w-3.5" />新建值班表</Button>}
        </div>
      </div>

      {/* 今日值班条：全部视图下按类型分行展示（日常/重保），单类型视图保持单行 */}
      {todayDuties.length > 0 && (
        <div className="mb-4 rounded-md border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground whitespace-nowrap"><CalendarDays className="h-4 w-4 text-muted-foreground" />今日值班</span>
            {rosterType === 'ALL' && <span className="text-xs text-muted-foreground whitespace-nowrap">日常运营 / 重保</span>}
          </div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {todayDuties.map((d, idx) => {
              const rt = d.roster_type || (rosterType === 'ALL' ? 'DAILY' : rosterType)
              const dayNames = (d.day_members || []).map((m) => m.name).join('，') || '--'
              const dayPhones = (d.day_members || []).map((m) => m.phone).filter(Boolean).join('，')
              const nightNames = (d.night_members || []).map((m) => m.name).join('，') || '--'
              const nightPhones = (d.night_members || []).map((m) => m.phone).filter(Boolean).join('，')
              return (
                <div key={d.id ?? `${rt}-${idx}`} className="flex items-center gap-2">
                  {rosterType === 'ALL' && (
                    <span className={`inline-flex w-[52px] shrink-0 items-center justify-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium ${rt === 'RESERVE' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-500'}`}>
                      {rt === 'RESERVE' ? <ShieldCheck className="h-2.5 w-2.5" /> : <CalendarDays className="h-2.5 w-2.5" />}
                      {rt === 'RESERVE' ? '重保' : '日常'}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded border-l-4 border-l-blue-500 bg-blue-500/5 px-2.5 py-1">
                    <Sun className="h-4 w-4 shrink-0 text-blue-500" />
                    <div className="min-w-0">
                      <div className="truncate text-[16px] font-medium leading-tight text-foreground">{dayNames}</div>
                      <div className="truncate text-[13px] leading-tight text-muted-foreground">{dayPhones}</div>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded border-l-4 border-l-purple-500 bg-purple-500/5 px-2.5 py-1">
                    <Moon className="h-4 w-4 shrink-0 text-purple-500" />
                    <div className="min-w-0">
                      <div className="truncate text-[16px] font-medium leading-tight text-foreground">{nightNames}</div>
                      <div className="truncate text-[13px] leading-tight text-muted-foreground">{nightPhones}</div>
                    </div>
                  </div>
                  {(d.day_needs_adjust || d.night_needs_adjust) && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-amber-500 whitespace-nowrap"><AlertTriangle className="h-3.5 w-3.5" />需调整</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 统计面板：5 卡片等分，左图标+右数字/标签 */}
      {stats && (
        <div className="mb-4 flex gap-4">
          {[
            { icon: CalendarDays, label: rosterType === 'ALL' ? '总记录' : '总天数', value: stats.total, color: 'text-muted-foreground', valueColor: 'text-foreground' },
            { icon: Sun, label: '白班已排', value: stats.day_assigned, sub: `/ 待${stats.day_pending}`, color: 'text-blue-500', valueColor: 'text-blue-500' },
            { icon: Moon, label: '晚班已排', value: stats.night_assigned, sub: `/ 待${stats.night_pending}`, color: 'text-purple-500', valueColor: 'text-purple-500' },
            { icon: CalendarOff, label: '需调整', value: stats.needs_adjust, color: stats.needs_adjust ? 'text-amber-500' : 'text-muted-foreground', valueColor: stats.needs_adjust ? 'text-amber-500' : 'text-foreground' },
            { icon: ClipboardCheck, label: '已发布/草稿', value: stats.published, sub: ` / ${stats.draft}`, color: 'text-emerald-500', valueColor: 'text-foreground' },
          ].map((c) => (
            <div key={c.label} className="flex flex-1 items-center gap-3 rounded-md border border-border bg-card px-4" style={{ height: '80px' }}>
              <c.icon className={`h-5 w-5 shrink-0 ${c.color}`} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-1">
                  <span className={`text-[24px] font-bold tabular-nums leading-none ${c.valueColor}`}>{c.value}</span>
                  {c.sub && <span className="text-[12px] text-muted-foreground whitespace-nowrap">{c.sub}</span>}
                </div>
                <div className="mt-1 text-[13px] text-muted-foreground whitespace-nowrap">{c.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 控制行：视图切换 + 筛选（列表）/ 月份导航（月视图），合并为一行避免垂直堆叠 */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
          <button onClick={() => setView('list')} className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${view === 'list' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}><List className="h-3.5 w-3.5" />列表</button>
          <button onClick={() => setView('month')} className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${view === 'month' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}><CalendarDays className="h-3.5 w-3.5" />月视图</button>
        </div>
        {view === 'month' ? (
          <div className="flex items-center gap-2">
            <button onClick={() => shiftMonth(-1)} className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground" title="上一月"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-medium tabular-nums whitespace-nowrap">{range.start.slice(0, 4)}年 {MONTH_CN[Number(range.start.slice(5, 7)) - 1]}</span>
            <button onClick={() => shiftMonth(1)} className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground" title="下一月"><ChevronRight className="h-4 w-4" /></button>
          </div>
        ) : (
          <>
            <div className="h-6 w-px shrink-0 bg-border" />
            <label className="text-xs text-muted-foreground whitespace-nowrap">日期</label>
            <DatePicker value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
            <span className="text-muted-foreground">~</span>
            <DatePicker value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
            <input className={`${inputBaseCls} h-9 w-32`} placeholder="组别" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)} />
            <CompactSelect size="lg" className="w-32" value={filterMember} onChange={(e) => setFilterMember(Number(e.target.value))}>
              <option value={0}>全部人员</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </CompactSelect>
            <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
              <input type="checkbox" className="h-4 w-4 rounded border-border accent-primary" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />只看待分配
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
              <input type="checkbox" className="h-4 w-4 rounded border-border accent-primary" checked={showPhone} onChange={(e) => setShowPhone(e.target.checked)} />显示电话
            </label>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" className="h-9 whitespace-nowrap" onClick={loadList}>查询</Button>
          </>
        )}
      </div>

      {/* 内容区：占满剩余高度 */}
      <div className="flex-1 min-h-0">
        {view === 'list' ? (
          <DataTable
            columns={listColumns}
            data={filteredList}
            loading={loading}
            rowKey="id"
            rowClassName={(r) => `h-12 ${r.is_holiday ? 'bg-purple-500/5' : ''}`}
            emptyText={rosterEmpty(rosterType)}
            emptyIcon={CalendarDays}
            emptyDescription="点击「编辑」安排白班/晚班人员，或使用「值班表（图形化）」拖拽排班"
          />
        ) : (
          <div className="h-full overflow-auto rounded-md border border-border">
            {loading ? (
              <LoadingState rows={6} cols={7} className="py-6" />
            ) : calendarGrid.length === 0 ? (
              <div className="flex h-full min-h-[300px] items-center justify-center">
                <EmptyState
                  icon={CalendarDays}
                  title={rosterEmpty(rosterType)}
                  description="点击日期格或「编辑」安排白班/晚班人员，也可使用「值班表（图形化）」拖拽排班"
                />
              </div>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted">
                    {WEEKDAY_CN.map((w, i) => (
                      <th key={w} className={`px-2 py-2 text-center text-sm font-bold whitespace-nowrap ${i >= 5 ? 'text-amber-500/80' : 'text-muted-foreground'}`}>{w}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calendarGrid.map((week, wi) => (
                    <tr key={wi}>
                      {week.map((d, di) => {
                        const isWeekend = di >= 5
                        const dateNum = d ? Number(d.duty_date.slice(8, 10)) : ''
                        return (
                          <td key={di}
                            onClick={d && rosterType !== 'ALL' ? () => openEditRecord(d) : undefined}
                            className={`align-top p-1.5 border border-border ${d && d.is_today ? 'bg-primary/5 ring-1 ring-inset ring-primary' : ''} ${d && d.is_holiday ? 'bg-purple-500/5' : ''} ${d && rosterType !== 'ALL' ? 'cursor-pointer transition-colors hover:bg-accent' : ''}`}
                            style={{ minWidth: '100px', height: rosterType === 'ALL' ? '150px' : '108px', width: '14.28%' }}
                          >
                            {d && (
                              <div className="flex h-full flex-col gap-1">
                                <div className="flex items-center justify-between">
                                  <span className={`text-sm font-semibold tabular-nums ${isWeekend ? 'text-amber-500' : 'text-foreground'}`}>{dateNum}</span>
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">{d.is_holiday ? '休' : '班'}</span>
                                </div>
                                {rosterType === 'ALL' ? (
                                  (d.entries || []).length > 0 ? (
                                    (d.entries || []).map((en) => (
                                      <div key={en.id} className="flex flex-col gap-0.5 rounded bg-muted/40 px-1 py-0.5">
                                        <span className={`flex items-center gap-0.5 text-[9px] font-medium ${en.roster_type === 'RESERVE' ? 'text-red-500' : 'text-blue-500'}`}>
                                          {en.roster_type === 'RESERVE' ? <ShieldCheck className="h-2.5 w-2.5" /> : <CalendarDays className="h-2.5 w-2.5" />}
                                          {en.roster_type === 'RESERVE' ? '重保' : '日常'}
                                        </span>
                                        <ShiftMini members={en.day_members || []} shift="白班" needsAdjust={en.day_needs_adjust} onClick={() => openEditRecord(en)} canEdit={canEdit} />
                                        <ShiftMini members={en.night_members || []} shift="晚班" needsAdjust={en.night_needs_adjust} onClick={() => openEditRecord(en)} canEdit={canEdit} />
                                      </div>
                                    ))
                                  ) : (
                                    <div className="mt-1 text-[10px] text-muted-foreground">未排班</div>
                                  )
                                ) : (
                                  <>
                                    <ShiftMini members={d.day_members || []} shift="白班" needsAdjust={d.day_needs_adjust} onClick={(e) => { e?.stopPropagation?.(); openEditRecord(d) }} canEdit={canEdit} />
                                    <ShiftMini members={d.night_members || []} shift="晚班" needsAdjust={d.night_needs_adjust} onClick={(e) => { e?.stopPropagation?.(); openEditRecord(d) }} canEdit={canEdit} />
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* 新建值班表弹窗：手动指定每天白班/晚班人员（替代原自动生成） */}
      <Modal
        open={createOpen}
        title="新建值班表"
        onClose={() => setCreateOpen(false)}
        size="xl"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={creating} onClick={handleCreateSubmit}>保存</Button>
          </>
        }
      >
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-5 gap-3">
            <div>
              <label className={labelCls}>值班表类型</label>
              <CompactSelect size="lg" block value={createForm.roster_type} onChange={(e) => changeCreateType(e.target.value)}>
                <option value="DAILY">日常运营</option>
                <option value="RESERVE">重保值班</option>
              </CompactSelect>
            </div>
            <div>
              <label className={labelCls}>起始日期</label>
              <DatePicker block value={createForm.start_date} onChange={(e) => changeCreateRange('start_date', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>结束日期</label>
              <DatePicker block value={createForm.end_date} onChange={(e) => changeCreateRange('end_date', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>冲突处理</label>
              <CompactSelect size="lg" block value={createForm.conflict_strategy} onChange={(e) => setCreateForm({ ...createForm, conflict_strategy: e.target.value })}>
                <option value="overwrite">覆盖已有记录</option>
                <option value="fill">仅创建缺失日期</option>
              </CompactSelect>
            </div>
            <div>
              <label className={labelCls}>生成后状态</label>
              <CompactSelect size="lg" block value={createForm.auto_publish ? '1' : '0'} onChange={(e) => setCreateForm({ ...createForm, auto_publish: e.target.value === '1' })}>
                <option value="0">草稿</option>
                <option value="1">直接发布</option>
              </CompactSelect>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>共 {createDays.length} 天（单次最多 62 天），每天白班/晚班均可多选人员</span>
            <span>{createForm.conflict_strategy === 'fill' ? '已有记录的日期将跳过' : '已有记录将按本次填写覆盖'}</span>
          </div>

          <div className="max-h-[420px] overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">日期</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">星期</th>
                  <th className="px-2 py-1.5 text-left">白班人员</th>
                  <th className="px-2 py-1.5 text-left">晚班人员</th>
                </tr>
              </thead>
              <tbody>
                {createDays.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">请选择有效的日期范围</td>
                  </tr>
                ) : createDays.map((d) => (
                  <tr key={d.date} className="border-t border-border align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                      {d.date}{d.date === todayStr() ? <span className="ml-1 text-[10px] text-primary">今天</span> : null}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{d.weekday}</td>
                    <td className="px-2 py-1.5">
                      <CreateMemberPicker
                        options={editMembers}
                        value={d.day_member_ids}
                        onChange={(id) => toggleCreateMember(d.date, 'day_member_ids', id)}
                        accentCls="border-blue-500/40 bg-blue-500/5 text-blue-500"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <CreateMemberPicker
                        options={editMembers}
                        value={d.night_member_ids}
                        onChange={(id) => toggleCreateMember(d.date, 'night_member_ids', id)}
                        accentCls="border-purple-500/40 bg-purple-500/5 text-purple-500"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
            这里替代原来的「自动生成」：为日期范围内每天手动指定白班/晚班人员，可多选；未选择的班次保存为待分配。
            保存后仍可在列表中继续编辑。
          </div>
        </div>
      </Modal>

      {/* 编辑值班记录弹窗：草稿/已发布均可编辑白班、晚班与状态 */}
      <Modal
        open={!!editTarget}
        title="编辑值班记录"
        onClose={() => setEditTarget(null)}
        size="lg"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditTarget(null)}>取消</Button>
            <Button variant="primary" size="sm" loading={editSaving} onClick={handleSaveEdit}>保存</Button>
          </>
        }
      >
        {editTarget && (
          <div className="space-y-4 py-2">
            <div className="space-y-1 rounded-md border border-border bg-muted p-3 text-sm">
              <div>
                日期：<span className="font-medium tabular-nums">{editTarget.duty_date} {editTarget.weekday}</span>
              </div>
              <div className="flex items-center gap-2">
                值班表类型：
                <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${editTarget.roster_type === 'RESERVE' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-500'}`}>
                  {editTarget.roster_type === 'RESERVE' ? <ShieldCheck className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
                  {editTarget.roster_type === 'RESERVE' ? '重保值班' : '日常运营'}
                </span>
              </div>
              <div>日期类型：{editTarget.is_holiday ? '非工作日' : '工作日'}{editTarget.holiday_name ? `（${editTarget.holiday_name}）` : ''}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>白班人员（可多选）<span className="ml-1 text-[11px] text-muted-foreground">已选 {editForm.day_member_ids.length} 人</span></label>
                <div className="max-h-44 overflow-y-auto rounded-md border border-border p-1.5">
                  {editMemberOptions.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-muted-foreground">加载中…</div>
                  ) : editMemberOptions.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                        checked={editForm.day_member_ids.includes(m.id)}
                        onChange={() => toggleEditMember('day_member_ids', m.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {m.name}（{m.group_name || '未分组'}）{m.status === 'inactive' ? '（停用）' : ''}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>晚班人员（可多选）<span className="ml-1 text-[11px] text-muted-foreground">已选 {editForm.night_member_ids.length} 人</span></label>
                <div className="max-h-44 overflow-y-auto rounded-md border border-border p-1.5">
                  {editMemberOptions.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-muted-foreground">加载中…</div>
                  ) : editMemberOptions.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                        checked={editForm.night_member_ids.includes(m.id)}
                        onChange={() => toggleEditMember('night_member_ids', m.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {m.name}（{m.group_name || '未分组'}）{m.status === 'inactive' ? '（停用）' : ''}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="w-1/2 pr-1.5">
              <label className={labelCls}>记录状态</label>
              <CompactSelect size="lg" block value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                <option value="draft">草稿</option>
                <option value="published">已发布</option>
              </CompactSelect>
            </div>
            <div className="rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
              编辑直接修改该日记录，不改变轮换顺序、不影响其他日期；草稿与已发布记录均可编辑，已过期记录不可编辑。每次白班/晚班变化会写入调班记录。
            </div>
          </div>
        )}
      </Modal>

      {/* 特殊日期抽屉 */}
      <HalfDrawer
        open={specialOpen}
        onClose={() => setSpecialOpen(false)}
        title="特殊日期管理"
        footer={<div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => setSpecialOpen(false)}>关闭</Button></div>}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">手动标记某日为非工作日（holiday）或工作日/调休上班（workday），覆盖内置节假日表。用于内置数据缺失或临时调休。</p>
          <div className="rounded-md border border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>日期</label>
                <DatePicker block value={specialForm.date} onChange={(e) => setSpecialForm({ ...specialForm, date: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>类型</label>
                <CompactSelect size="lg" block value={specialForm.day_type} onChange={(e) => setSpecialForm({ ...specialForm, day_type: e.target.value })}>
                  <option value="holiday">非工作日（放假）</option>
                  <option value="workday">工作日（调休上班）</option>
                </CompactSelect>
              </div>
            </div>
            <Button className="mt-2" variant="primary" size="sm" onClick={handleAddSpecial}>添加</Button>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">已标记的特殊日期</div>
            {specialLoading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : specialList.length === 0 ? (
              <EmptyState title="暂无特殊日期" />
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {specialList.map((s) => (
                  <div key={s.date} className="flex items-center justify-between rounded border border-border px-3 py-1.5 text-sm">
                    <span className="tabular-nums">{s.date}</span>
                    <Badge variant={s.day_type === 'holiday' ? 'info' : 'success'}>{s.day_type === 'holiday' ? '非工作日' : '工作日'}</Badge>
                    <button onClick={() => handleDeleteSpecial(s.date)} className="text-xs text-destructive hover:underline">删除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </HalfDrawer>
    </PageContainer>
  )
}

// 新建值班表：单日班次人员多选（details 内联展开，避免弹窗裁剪）
function CreateMemberPicker({ options = [], value = [], onChange, accentCls }) {
  // 默认只显示启用人员；已选中的停用人员仍显示，便于保留或手动移除
  const visibleOptions = options.filter((m) => m.status === 'active' || value.includes(m.id))
  const names = visibleOptions.filter((m) => value.includes(m.id)).map((m) => m.name).join('，')
  return (
    <details>
      <summary className={`cursor-pointer list-none rounded border px-2 py-1 ${value.length ? accentCls : 'border-dashed border-border text-muted-foreground'}`}>
        <span className="block truncate">{names || '选择人员'}</span>
      </summary>
      <div className="mt-1 max-h-36 space-y-0.5 overflow-y-auto rounded border border-border bg-card p-1">
        {visibleOptions.length === 0 ? (
          <div className="px-1 py-1 text-[10px] text-muted-foreground">暂无可选人员</div>
        ) : visibleOptions.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent">
            <input
              type="checkbox"
              className="h-3 w-3 rounded border-border accent-primary"
              checked={value.includes(m.id)}
              onChange={() => onChange(m.id)}
            />
            <span className="truncate">{m.name}（{m.group_name || '未分组'}）</span>
          </label>
        ))}
      </div>
    </details>
  )
}

// 班次单元（列表视图）：左侧4px色条 + 人员姓名（多人逗号分隔）+ 电话，请假角标
function ShiftCell({ members = [], shift, needsAdjust, showPhone, onClick, canEdit }) {
  const stripeCls = shift === 'DAY' ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-purple-500'
  const names = members.map((m) => m.name).join('，')
  const phones = members.map((m) => m.phone).filter(Boolean).join('，')
  const titleText = members.map((m) => `${m.name} ${m.phone || ''}`).join('，')
  if (!members.length) {
    return (
      <button onClick={onClick} disabled={!canEdit}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${stripeCls} ${canEdit ? 'cursor-pointer border border-dashed border-amber-500/40 text-amber-500 hover:bg-amber-500/5' : 'text-amber-500'}`}
        title={`${shift === 'DAY' ? '白班' : '晚班'}：待分配`}
      >
        <span className="text-sm">--</span>
      </button>
    )
  }
  return (
    <button onClick={onClick} disabled={!canEdit}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${stripeCls} ${needsAdjust ? 'bg-amber-500/5' : ''} ${canEdit ? 'cursor-pointer hover:bg-accent' : 'cursor-default'}`}
      title={`${shift === 'DAY' ? '白班' : '晚班'}：${titleText}${needsAdjust ? '（有人员请假，需替换）' : ''}`}>
      <span className="flex flex-col min-w-0">
        <span className="flex items-center gap-1">
          <span className="truncate text-sm font-medium text-foreground">{names}</span>
          {needsAdjust && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="有人员请假，需替换" />}
        </span>
        {showPhone && <span className="truncate text-xs text-muted-foreground">{phones}</span>}
      </span>
    </button>
  )
}

// 班次迷你单元（月视图）：蓝/紫小点 + 姓名（多人逗号分隔），未分配显示"--"
function ShiftMini({ members = [], shift, needsAdjust, onClick, canEdit }) {
  const dotCls = needsAdjust ? 'bg-amber-500' : (shift === '白班' ? 'bg-blue-500' : 'bg-purple-500')
  const names = members.map((m) => m.name).join('，')
  const titleText = members.map((m) => `${m.name} ${m.phone || ''}`).join('，')
  return (
    <button onClick={onClick} disabled={!canEdit}
      className={`flex items-center gap-1 truncate rounded px-0.5 py-0.5 text-left ${canEdit ? 'cursor-pointer hover:bg-accent' : 'cursor-default'}`}
      title={members.length ? `${shift}：${titleText}${needsAdjust ? '（有人员请假，需替换）' : ''}` : `${shift}：--`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} />
      <span className={`truncate font-medium ${members.length ? (needsAdjust ? 'text-amber-500' : 'text-foreground') : 'text-muted-foreground'}`} style={{ fontSize: '13px' }}>
        {names || '--'}
      </span>
    </button>
  )
}
