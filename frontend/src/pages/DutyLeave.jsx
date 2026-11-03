// 请假管理页：列表 + 新增请假 + 审批（含审批意见）
import { useState, useEffect, useCallback } from 'react'
import { CalendarX, CalendarDays, Clock, Check, X, AlertTriangle, Trash2 } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputCls, labelCls } from '../components/property/FormControls'
import {Button, PageContainer, DataTable, Pagination, StatusBadge, CompactSelect, DatePicker, AutoGrowTextarea } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import dutyApi from '../api/duty'

const STATUS_META = {
  pending: { label: '待审批', color: 'warning' },
  approved: { label: '已批准', color: 'success' },
  rejected: { label: '已拒绝', color: 'danger' },
}
const SHIFT_META = { DAY: '白班', NIGHT: '晚班', ALL: '全天' }

export default function DutyLeave() {
  const canEdit = hasPermission('duty_leave', 'edit')
  const canDelete = hasPermission('duty_leave', 'delete')

  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState([])

  const [members, setMembers] = useState([])
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ member_id: '', start_date: '', end_date: '', shift: 'ALL', reason: '' })
  const [saving, setSaving] = useState(false)

  // 审批弹窗
  const [approveTarget, setApproveTarget] = useState(null) // { row, status }
  const [approveReason, setApproveReason] = useState('')
  const [approving, setApproving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    dutyApi.leaves({ page, size, status: filterStatus })
      .then((res) => { setList(res.items || []); setTotal(res.total || 0) })
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [page, size, filterStatus])

  useEffect(() => { load() }, [load])
  useEffect(() => { dutyApi.allMembers('').then(setMembers).catch(() => {}) }, [])

  // 请假统计：本月请假人次 + 待审批数量（基于当前列表数据）
  const now = new Date()
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthCount = list.filter((r) => r.start_date && r.start_date.startsWith(yearMonth)).length
  const pendingCount = list.filter((r) => r.status === 'pending').length

  const openCreate = () => {
    setForm({ member_id: members[0]?.id ? String(members[0].id) : '', start_date: '', end_date: '', shift: 'ALL', reason: '' })
    setModalOpen(true)
  }

  const handleSave = () => {
    if (!form.member_id) return toast.error('请选择请假人员')
    if (!form.start_date || !form.end_date) return toast.error('请选择请假日期范围')
    if (form.end_date < form.start_date) return toast.error('结束日期不能早于开始日期')
    setSaving(true)
    dutyApi.createLeave({
      member_id: Number(form.member_id),
      start_date: form.start_date,
      end_date: form.end_date,
      shift: form.shift,
      reason: form.reason,
    })
      .then(() => { toast.success('已提交请假申请'); setModalOpen(false); load() })
      .catch((e) => toast.error(e.message || '提交失败'))
      .finally(() => setSaving(false))
  }

  const openApprove = (row, status) => {
    setApproveTarget({ row, status })
    setApproveReason('')
  }

  const handleApprove = () => {
    if (!approveTarget) return
    const { row, status } = approveTarget
    const label = status === 'approved' ? '批准' : '拒绝'
    setApproving(true)
    dutyApi.approveLeave(row.id, { status, reason: approveReason })
      .then((res) => {
        toast.success(`已${label}`)
        // 批准且影响已发布排班时提示联动
        if (status === 'approved' && res.affected_count > 0) {
          setTimeout(() => toast.warning(`该请假影响 ${res.affected_count} 个已排班次，请前往值班表手动调整或重新生成`), 500)
        }
        setApproveTarget(null)
        load()
      })
      .catch((e) => toast.error(e.message || '操作失败'))
      .finally(() => setApproving(false))
  }

  const resetFilter = () => {
    setFilterStatus('')
    setPage(1)
  }

  const handleDelete = (row) => {
    confirm({
      title: '删除请假记录',
      message: `确认删除「${row.member_name || '该员'}」${row.start_date}~${row.end_date} 的请假记录？仅删除记录，不回退已受影响的值班表。不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setDeletingId(row.id)
      dutyApi.deleteLeave(row.id)
        .then(() => { toast.success('请假记录已删除'); setSelectedKeys((s) => s.filter((k) => k !== row.id)); load() })
        .catch((e) => toast.error(e.message || '删除失败'))
        .finally(() => setDeletingId(null))
    })
  }

  const handleBatchDelete = () => {
    if (!selectedKeys.length) { toast.error('请先勾选待删除记录'); return }
    confirm({
      title: '批量删除请假记录',
      message: `确认删除已勾选的 ${selectedKeys.length} 条请假记录？不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setBatchDeleting(true)
      dutyApi.batchDeleteLeaves(selectedKeys)
        .then((res) => { toast.success(`已删除 ${res.deleted} 条`); setSelectedKeys([]); load() })
        .catch((e) => toast.error(e.message || '批量删除失败'))
        .finally(() => setBatchDeleting(false))
    })
  }

  const columns = [
    { key: 'member_name', header: '请假人员', width: '120px', render: (r) => <span className="font-medium">{r.member_name || '-'}</span> },
    { key: 'date_range', header: '请假日期', width: '200px', render: (r) => <span className="tabular-nums">{r.start_date} ~ {r.end_date}</span> },
    { key: 'shift', header: '班次', width: '90px', render: (r) => SHIFT_META[r.shift] || r.shift },
    { key: 'reason', header: '请假原因', render: (r) => <span className="text-muted-foreground">{r.reason || '-'}</span> },
    {
      key: 'approve_reason', header: '审批意见', width: '160px',
      render: (r) => r.approve_reason
        ? <span className="text-muted-foreground">{r.approve_reason}</span>
        : <span className="text-xs text-muted-foreground">--</span>,
    },
    {
      key: 'status', header: '状态', width: '90px',
      render: (r) => {
        const m = STATUS_META[r.status] || { label: r.status || '--', color: 'neutral' }
        return <StatusBadge color={m.color} label={m.label} />
      },
    },
    {
      key: 'actions', header: '操作', width: '240px',
      render: (r) => {
        const canApprove = r.status === 'pending' && canEdit
        if (!canApprove && !canDelete) return <span className="text-xs text-muted-foreground">--</span>
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            {canApprove && (
              <>
                <button onClick={() => openApprove(r, 'approved')} className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-success transition hover:bg-success/10" title="批准">
                  <Check className="h-3.5 w-3.5" />批准
                </button>
                <button onClick={() => openApprove(r, 'rejected')} className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/10" title="拒绝">
                  <X className="h-3.5 w-3.5" />拒绝
                </button>
              </>
            )}
            {canDelete && (
              <button onClick={() => handleDelete(r)} disabled={deletingId === r.id}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50" title="删除该请假记录">
                <Trash2 className="h-3.5 w-3.5" />{deletingId === r.id ? '删除中' : '删除'}
              </button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <PageContainer>
      {/* 标题区：主标题 + 描述 + 右侧提交按钮 */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">请假管理</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">值班人员请假申请与审批，批准后请假期间自动跳过排班</p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="primary" size="sm" onClick={openCreate}>
              <CalendarX className="mr-1 h-3.5 w-3.5" />提交请假
            </Button>
          </div>
        )}
      </div>

      {/* 请假统计：本月请假人次 + 待审批数量 */}
      <div className="mb-4 flex gap-4">
        <div className="flex flex-1 items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[24px] font-bold leading-none text-foreground tabular-nums">{monthCount}</div>
            <div className="mt-1 text-[13px] text-muted-foreground">本月请假人次</div>
          </div>
        </div>
        <div className="flex flex-1 items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${pendingCount > 0 ? 'bg-amber-500/10 text-amber-500' : 'bg-muted text-muted-foreground'}`}>
            <Clock className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className={`text-[24px] font-bold leading-none tabular-nums ${pendingCount > 0 ? 'text-amber-500' : 'text-foreground'}`}>{pendingCount}</div>
            <div className="mt-1 text-[13px] text-muted-foreground">待审批数量</div>
          </div>
        </div>
      </div>

      {/* 筛选区：状态下拉 + 查询/重置，整行横向排列 */}
      <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <label className="text-xs text-muted-foreground whitespace-nowrap">按状态</label>
        <CompactSelect
          size="lg"
          className="w-32"
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setPage(1) }}
        >
          <option value="">全部状态</option>
          <option value="pending">待审批</option>
          <option value="approved">已批准</option>
          <option value="rejected">已拒绝</option>
        </CompactSelect>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" className="h-9 whitespace-nowrap" onClick={load}>查询</Button>
        <Button variant="ghost" size="sm" className="h-9 whitespace-nowrap" onClick={resetFilter}>重置</Button>
      </div>

      {canDelete && !!list.length && (
        <div className="mb-3 flex items-center gap-3">
          <span className="text-xs text-muted-foreground">已选 <span className="font-medium tabular-nums text-foreground">{selectedKeys.length}</span> 项</span>
          <Button size="sm" variant="danger" onClick={handleBatchDelete} disabled={!selectedKeys.length || batchDeleting} className="h-9">
            <Trash2 className="mr-1 h-3.5 w-3.5" />{batchDeleting ? '删除中' : '批量删除'}
          </Button>
          {!!selectedKeys.length && (
            <button onClick={() => setSelectedKeys([])} className="rounded px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground">清空选择</button>
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        data={list}
        loading={loading}
        rowKey="id"
        rowClassName={() => 'h-12'}
        selectable={canDelete}
        selectedKeys={selectedKeys}
        onSelectChange={setSelectedKeys}
        emptyText="暂无请假记录"
        emptyIcon={CalendarX}
        emptyDescription="提交请假申请后，批准期间会自动从排班中跳过该人员"
        emptyAction={canEdit && (
          <Button variant="primary" size="sm" onClick={openCreate}>
            <CalendarX className="mr-1 h-3.5 w-3.5" />提交请假
          </Button>
        )}
      />
      <Pagination page={page} pageSize={size} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setSize(s); setPage(1) }} />

      <Modal
        open={modalOpen}
        title="提交请假申请"
        onClose={() => setModalOpen(false)}
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>提交</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-5 py-2">
          <div className="col-span-2">
            <label className={labelCls}>请假人员<span className="text-red-500">*</span></label>
            <CompactSelect size="lg" block value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
              <option value="">请选择</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}（{m.group_name || '未分组'}）</option>)}
            </CompactSelect>
          </div>
          <div>
            <label className={labelCls}>开始日期<span className="text-red-500">*</span></label>
            <DatePicker block value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>结束日期<span className="text-red-500">*</span></label>
            <DatePicker block value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>班次</label>
            <CompactSelect size="lg" block value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>
              <option value="ALL">全天（白班+晚班）</option>
              <option value="DAY">仅白班</option>
              <option value="NIGHT">仅晚班</option>
            </CompactSelect>
          </div>
          <div className="col-span-2">
            <label className={labelCls}>请假原因</label>
            <AutoGrowTextarea className={`${inputCls} resize-y`} rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* 审批弹窗（含审批意见输入） */}
      <Modal
        open={!!approveTarget}
        title={approveTarget?.status === 'approved' ? '批准请假申请' : '拒绝请假申请'}
        onClose={() => setApproveTarget(null)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setApproveTarget(null)}>取消</Button>
            <Button
              variant={approveTarget?.status === 'approved' ? 'primary' : 'danger'}
              size="sm"
              loading={approving}
              onClick={handleApprove}
            >
              {approveTarget?.status === 'approved' ? '确认批准' : '确认拒绝'}
            </Button>
          </>
        }
      >
        {approveTarget && (
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-border bg-muted p-3 text-sm">
              <div>请假人员：<span className="font-medium">{approveTarget.row.member_name || '-'}</span></div>
              <div>请假日期：<span className="tabular-nums">{approveTarget.row.start_date} ~ {approveTarget.row.end_date}</span></div>
              <div>班次：{SHIFT_META[approveTarget.row.shift] || approveTarget.row.shift}</div>
            </div>
            {approveTarget.status === 'approved' && (
              <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>批准后该人员请假期间将自动跳过排班；若已有已发布排班受影响，将提示前往值班表调整。</span>
              </div>
            )}
            <div>
              <label className={labelCls}>审批意见</label>
              <AutoGrowTextarea
                className={`${inputCls} resize-y`}
                rows={3}
                placeholder={approveTarget.status === 'approved' ? '可填写批准说明（选填）' : '请填写拒绝理由'}
                value={approveReason}
                onChange={(e) => setApproveReason(e.target.value)}
              />
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
