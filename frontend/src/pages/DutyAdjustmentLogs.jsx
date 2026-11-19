// 调班记录页：查看所有手动调班日志
import { useState, useEffect, useCallback } from 'react'
import { ClipboardList, Undo2, Trash2 } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, DataTable, Pagination, DatePicker } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import dutyApi from '../api/duty'

const SHIFT_META = { DAY: '白班', NIGHT: '晚班' }

export default function DutyAdjustmentLogs() {
  const canEdit = hasPermission('duty_log', 'edit')
  const canDelete = hasPermission('duty_log', 'delete')
  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [revertingId, setRevertingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState([])
  const [range, setRange] = useState({ start_date: '', end_date: '' })

  const load = useCallback(() => {
    setLoading(true)
    const params = { page, size }
    if (range.start_date) params.start_date = range.start_date
    if (range.end_date) params.end_date = range.end_date
    dutyApi.adjustmentLogs(params)
      .then((res) => { setList(res.items || []); setTotal(res.total || 0) })
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [page, size, range])

  useEffect(() => { load() }, [load])

  const handleRevert = (row) => {
    confirm({
      title: '撤销调班',
      message: `确认撤销「${row.duty_date || '该日'} ${SHIFT_META[row.shift] || row.shift}」的此次调班？该班次将恢复为原值班人「${row.original_member_name || '待分配'}」，并记录一条反向日志。`,
      variant: 'info',
      confirmText: '撤销',
    }).then((ok) => {
      if (!ok) return
      setRevertingId(row.id)
      dutyApi.revertAdjust(row.id)
        .then((res) => {
          toast.success(res.reverted ? '已撤销调班，班次已恢复原值班人' : '已撤销')
          load()
        })
        .catch((e) => toast.error(e.message || '撤销失败'))
        .finally(() => setRevertingId(null))
    })
  }

  const handleDelete = (row) => {
    confirm({
      title: '删除调班记录',
      message: `确认删除「${row.duty_date || '该日'} ${SHIFT_META[row.shift] || row.shift}」的调班日志？此操作仅删除日志，不回退实际班次变更（如需回退请先「撤销」）。不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setDeletingId(row.id)
      dutyApi.deleteAdjustLog(row.id)
        .then(() => { toast.success('调班记录已删除'); setSelectedKeys((s) => s.filter((k) => k !== row.id)); load() })
        .catch((e) => toast.error(e.message || '删除失败'))
        .finally(() => setDeletingId(null))
    })
  }

  const handleBatchDelete = () => {
    if (!selectedKeys.length) { toast.error('请先勾选待删除记录'); return }
    confirm({
      title: '批量删除调班记录',
      message: `确认删除已勾选的 ${selectedKeys.length} 条调班记录？不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      setBatchDeleting(true)
      dutyApi.batchDeleteAdjustLogs(selectedKeys)
        .then((res) => { toast.success(`已删除 ${res.deleted} 条`); setSelectedKeys([]); load() })
        .catch((e) => toast.error(e.message || '批量删除失败'))
        .finally(() => setBatchDeleting(false))
    })
  }

  const columns = [
    { key: 'duty_date', header: '值班日期', width: '120px', render: (r) => <span className="tabular-nums font-medium">{r.duty_date || '-'}</span> },
    {
      key: 'shift', header: '班次', width: '90px',
      render: (r) => {
        const isDay = r.shift === 'DAY'
        const cls = isDay ? 'bg-blue-500/10 text-blue-500' : 'bg-purple-500/10 text-purple-500'
        return (
          <span className={`inline-flex items-center rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${cls}`}>
            {SHIFT_META[r.shift] || r.shift}
          </span>
        )
      },
    },
    {
      key: 'original_member', header: '原值班人', width: '160px',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{r.original_member_name || '待分配'}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{r.original_member_phone || '-'}</span>
        </div>
      ),
    },
    {
      key: 'new_member', header: '新值班人', width: '160px',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{r.new_member_name || '待分配'}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{r.new_member_phone || '-'}</span>
        </div>
      ),
    },
    { key: 'reason', header: '调整原因', render: (r) => <span className="text-muted-foreground">{r.reason || '-'}</span> },
    { key: 'operator_name', header: '操作人', width: '110px', render: (r) => r.operator_name || '-' },
    { key: 'operated_at', header: '操作时间', width: '170px', className: 'tabular-nums', render: (r) => r.operated_at ? new Date(r.operated_at).toLocaleString('zh-CN') : '-' },
    {
      key: 'actions', header: '操作', width: '195px',
      render: (r) => {
        // 反向撤销日志（reason 以「撤销调班」开头）不再提供撤销按钮
        const isRevertLog = (r.reason || '').startsWith('撤销调班')
        const canRevert = canEdit && !isRevertLog
        if (!canRevert && !canDelete) return <span className="text-xs text-muted-foreground">-</span>
        return (
          <div className="flex items-center gap-1 whitespace-nowrap">
            {canRevert && (
              <button
                onClick={() => handleRevert(r)}
                disabled={revertingId === r.id}
                className="flex items-center gap-1 rounded px-2 py-1 text-sm text-primary hover:bg-primary/10 disabled:opacity-50"
                title="撤销此次调班，恢复原值班人"
              >
                <Undo2 className="h-3.5 w-3.5" />{revertingId === r.id ? '撤销中' : '撤销'}
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => handleDelete(r)}
                disabled={deletingId === r.id}
                className="flex items-center gap-1 rounded px-2 py-1 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                title="删除该调班日志（不回退班次）"
              >
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
      <PageHeader
        title="调班记录"
      />

      <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <label className="text-xs text-muted-foreground whitespace-nowrap">按值班日期</label>
        <DatePicker value={range.start_date} onChange={(e) => setRange((r) => ({ ...r, start_date: e.target.value }))} />
        <span className="text-muted-foreground">~</span>
        <DatePicker value={range.end_date} onChange={(e) => setRange((r) => ({ ...r, end_date: e.target.value }))} />
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => { setPage(1); load() }} className="h-9 whitespace-nowrap">查询</Button>
        <Button size="sm" variant="ghost" onClick={() => { setRange({ start_date: '', end_date: '' }); setPage(1) }} className="h-9 whitespace-nowrap">重置</Button>
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
        emptyText="暂无调班记录"
        emptyIcon={ClipboardList}
        emptyDescription="手动调整值班人员的操作会在这里留痕，便于追溯与复盘"
      />
      <Pagination page={page} pageSize={size} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setSize(s); setPage(1) }} />
    </PageContainer>
  )
}
