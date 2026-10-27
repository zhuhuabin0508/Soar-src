// 值班人员管理页：列表 + 新增/编辑弹窗 + 批量导入 + 模板下载 + 批量启停 + 轮班公平性统计
import { useState, useEffect, useCallback } from 'react'
import { UserPlus, Upload, Download, Pencil, Trash2, Search, Users, BarChart3, Power, PowerOff, GripVertical } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputCls, inputBaseCls, labelCls } from '../components/property/FormControls'
import { Button, PageContainer, DataTable, Pagination, Badge, CompactSelect, DatePicker } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import dutyApi from '../api/duty'

const EMPTY_FORM = {
  name: '',
  phone: '',
  group_name: '',
  sort_order: 0,
  status: 'active',
}

export default function DutyMemberManagement() {
  const canEdit = hasPermission('duty_member', 'edit')
  const canDelete = hasPermission('duty_member', 'delete')

  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState([])

  const [filters, setFilters] = useState({ group_name: '', keyword: '', status: '' })

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新增, 对象=编辑
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [togglingId, setTogglingId] = useState(null)

  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)

  // 轮班公平性统计弹窗
  const [statsOpen, setStatsOpen] = useState(false)
  const [statsData, setStatsData] = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsRange, setStatsRange] = useState({ start_date: '', end_date: '' })

  const load = useCallback(() => {
    setLoading(true)
    dutyApi
      .members({ page, size, ...filters })
      .then((res) => {
        setList(res.items || [])
        setTotal(res.total || 0)
      })
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [page, size, filters])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setModalOpen(true)
  }
  const openEdit = (row) => {
    setEditing(row)
    setForm({
      name: row.name || '',
      phone: row.phone || '',
      group_name: row.group_name || '',
      sort_order: row.sort_order || 0,
      status: row.status || 'active',
    })
    setModalOpen(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) return toast.error('姓名不能为空')
    if (!form.phone.trim()) return toast.error('电话不能为空')
    setSaving(true)
    const payload = { ...form, sort_order: Number(form.sort_order) || 0 }
    const action = editing
      ? dutyApi.updateMember(editing.id, payload)
      : dutyApi.createMember(payload)
    action
      .then(() => {
        toast.success(editing ? '已更新' : '已新增')
        setModalOpen(false)
        load()
      })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  // 状态开关：快速启用/停用
  const handleToggleStatus = (row) => {
    if (!canEdit) return
    const next = row.status === 'active' ? 'inactive' : 'active'
    setTogglingId(row.id)
    dutyApi.updateMember(row.id, { status: next })
      .then(() => { toast.success(next === 'active' ? '已启用' : '已停用'); load() })
      .catch((e) => toast.error(e.message || '操作失败'))
      .finally(() => setTogglingId(null))
  }

  // 批量启用/停用
  const handleBatchStatus = (status) => {
    if (selectedKeys.length === 0) return toast.warning('请先勾选人员')
    const label = status === 'active' ? '启用' : '停用'
    confirm({
      title: `批量${label}`,
      message: `确认批量${label}选中的 ${selectedKeys.length} 名值班人员？`,
      variant: status === 'active' ? 'info' : 'danger',
      confirmText: label,
    }).then((ok) => {
      if (!ok) return
      dutyApi.batchUpdateStatus({ ids: selectedKeys, status })
        .then((res) => {
          toast.success(`已${label} ${res.updated} 名${res.skipped ? `，${res.skipped} 名无效` : ''}`)
          setSelectedKeys([])
          load()
        })
        .catch((e) => toast.error(e.message || '操作失败'))
    })
  }

  // 轮班公平性统计
  const openStats = () => {
    setStatsOpen(true)
    loadStats()
  }
  const loadStats = () => {
    setStatsLoading(true)
    const params = {}
    if (statsRange.start_date) params.start_date = statsRange.start_date
    if (statsRange.end_date) params.end_date = statsRange.end_date
    dutyApi.memberStats(params)
      .then(setStatsData)
      .catch((e) => toast.error(e.message || '加载失败'))
      .finally(() => setStatsLoading(false))
  }

  const handleDelete = (row) => {
    confirm({ title: '删除值班人员', message: `确认删除「${row.name}」？历史值班记录将保留。`, variant: 'danger', confirmText: '删除' })
      .then((ok) => {
        if (!ok) return
        dutyApi.deleteMember(row.id)
          .then((res) => {
            toast.success(res.message || '已删除')
            if (res.future_duty_count > 0) {
              setTimeout(() => toast.warning('该人员有未来值班安排，建议前往值班表重新生成'), 600)
            }
            load()
          })
          .catch((e) => toast.error(e.message || '删除失败'))
      })
  }

  const handleDownloadTemplate = () => {
    dutyApi.downloadMemberTemplate().catch((e) => toast.error(e.message || '下载失败'))
  }

  const handleImport = () => {
    if (!importFile) return toast.error('请先选择文件')
    setImporting(true)
    setImportResult(null)
    dutyApi.importMembers(importFile)
      .then((res) => {
        setImportResult(res)
        toast.success(`导入完成：成功 ${res.success} 条${res.total_errors ? `，失败 ${res.total_errors} 条` : ''}`)
        load()
      })
      .catch((e) => toast.error(e.message || '导入失败'))
      .finally(() => setImporting(false))
  }

  // 拖拽重排：仅当当前页展示全部匹配人员时启用（避免跨页排序错乱）
  const canDrag = canEdit && list.length > 1 && total <= list.length
  const handleReorder = (fromIdx, toIdx) => {
    if (!canDrag) return
    const next = [...list]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    const orderedIds = next.map((m) => m.id)
    // 乐观更新：立即重算 sort_order 1..N 并刷新视图
    setList(next.map((m, i) => ({ ...m, sort_order: i + 1 })))
    dutyApi.reorderMembers(orderedIds)
      .then(() => toast.success('人员排序已更新'))
      .catch((e) => { toast.error(e.message || '排序保存失败'); load() }) // 失败回滚至服务端顺序
  }

  const columns = [
    ...(canDrag ? [{
      key: '__drag', header: '', width: '40px',
      render: () => <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />,
    }] : []),
    { key: 'name', header: '姓名', width: '160px', render: (r) => <span className="text-sm font-medium">{r.name}</span> },
    { key: 'phone', header: '电话', width: '140px', render: (r) => <span className="tabular-nums">{r.phone || '-'}</span> },
    { key: 'group_name', header: '组别', width: '120px', render: (r) => r.group_name || '-' },
    { key: 'sort_order', header: '排序', width: '70px', numeric: true, render: (r) => (r.sort_order ? r.sort_order : <span className="text-muted-foreground">0</span>) },
    {
      key: 'status', header: '状态', width: '90px',
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); handleToggleStatus(r) }}
          disabled={!canEdit || togglingId === r.id}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${r.status === 'active' ? 'bg-success hover:bg-success/90' : 'bg-input hover:opacity-80'}`}
          title={canEdit ? `${r.status === 'active' ? '停用' : '启用'}该人员` : r.status === 'active' ? '启用' : '停用'}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${r.status === 'active' ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      ),
    },
    {
      key: 'actions', header: '操作', width: '110px',
      render: (r) => (
        <div className="flex items-center gap-1">
          {canEdit && (
            <button onClick={(e) => { e.stopPropagation(); openEdit(r) }} className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary" title="编辑">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(r) }} className="rounded p-1 text-red-500 hover:bg-red-500/10" title="删除">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">值班人员管理</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">管理值班人员信息；人员不再区分白班/晚班，所有启用人员均可排到任意班次</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={openStats}>
            <BarChart3 className="mr-1 h-3.5 w-3.5" /> 轮班统计
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDownloadTemplate}>
            <Download className="mr-1 h-3.5 w-3.5" /> 下载模板
          </Button>
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="mr-1 h-3.5 w-3.5" /> 批量导入
            </Button>
          )}
          {canEdit && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <UserPlus className="mr-1 h-3.5 w-3.5" /> 新增人员
            </Button>
          )}
        </div>
      </div>

      {/* 筛选栏：单行横向排列，使用 inputBaseCls 避免 w-full 覆盖显式宽度 */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputBaseCls} h-9 w-60 pl-8`}
            placeholder="姓名搜索"
            value={filters.keyword}
            onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load() } }}
          />
        </div>
        <input
          className={`${inputBaseCls} h-9 w-40`}
          placeholder="组别"
          value={filters.group_name}
          onChange={(e) => setFilters((f) => ({ ...f, group_name: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load() } }}
        />
        <CompactSelect
          size="lg"
          className="w-32"
          value={filters.status}
          onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setPage(1) }}
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="inactive">停用</option>
        </CompactSelect>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" className="h-9 whitespace-nowrap" onClick={() => { setPage(1); load() }}>查询</Button>
        <Button size="sm" variant="ghost" className="h-9 whitespace-nowrap" onClick={() => { setFilters({ group_name: '', keyword: '', status: '' }); setPage(1) }}>重置</Button>
      </div>

      {/* 批量操作栏（选中时出现） */}
      {canEdit && selectedKeys.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-muted-foreground">已选 <span className="font-semibold tabular-nums text-primary">{selectedKeys.length}</span> 名</span>
          <div className="flex-1" />
          <button onClick={() => handleBatchStatus('active')} className="flex h-9 items-center gap-1 whitespace-nowrap rounded px-3 text-xs font-medium text-success transition hover:bg-success/10" title="批量启用">
            <Power className="h-3.5 w-3.5" />批量启用
          </button>
          <button onClick={() => handleBatchStatus('inactive')} className="flex h-9 items-center gap-1 whitespace-nowrap rounded px-3 text-xs font-medium text-destructive transition hover:bg-destructive/10" title="批量停用">
            <PowerOff className="h-3.5 w-3.5" />批量停用
          </button>
          <button onClick={() => setSelectedKeys([])} className="flex h-9 items-center whitespace-nowrap rounded px-3 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground">取消选择</button>
        </div>
      )}

      <div className="min-h-[400px]">
        {canEdit && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            {canDrag ? (
              <>
                <GripVertical className="h-3.5 w-3.5" />
                <span>拖动行可调整<span className="text-foreground">人员展示顺序</span>（按「排序」升序），松开自动保存</span>
              </>
            ) : (
              <span>当前未显示全部人员，请增大每页条数后再拖拽排序</span>
            )}
          </div>
        )}
        <DataTable
          columns={columns}
          data={list}
          loading={loading}
          rowKey="id"
          selectable={canEdit}
          selectedKeys={selectedKeys}
          onSelectChange={setSelectedKeys}
          onRowClick={canEdit ? (r) => openEdit(r) : undefined}
          rowClickHint="点击编辑"
          rowClassName={() => 'hover:bg-secondary'}
          draggable={canDrag}
          onReorder={handleReorder}
          emptyText="暂无值班人员"
          emptyIcon={Users}
          emptyDescription="新增人员后即可参与值班排班，也可批量导入 Excel"
          emptyAction={canEdit && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <UserPlus className="mr-1 h-3.5 w-3.5" />新增人员
            </Button>
          )}
        />
      </div>
      <Pagination
        page={page}
        pageSize={size}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setSize(s); setPage(1) }}
      />

      {/* 新增/编辑弹窗 */}
      <Modal
        open={modalOpen}
        title={editing ? '编辑值班人员' : '新增值班人员'}
        onClose={() => setModalOpen(false)}
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>保存</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <label className={labelCls}>姓名<span className="text-red-500">*</span></label>
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>电话<span className="text-red-500">*</span></label>
            <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>组别</label>
            <input className={inputCls} value={form.group_name} onChange={(e) => setForm({ ...form, group_name: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>排序</label>
            <input type="number" className={inputCls} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>状态</label>
            <CompactSelect size="lg" block value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="active">启用</option>
              <option value="inactive">停用</option>
            </CompactSelect>
          </div>
          <p className="col-span-2 text-[11px] leading-relaxed text-muted-foreground">
            值班人员不再区分白班/晚班类别，所有启用人员都可以被排到任意班次；一个班次可选择一名或多名人员。
          </p>
        </div>
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal
        open={importOpen}
        title="批量导入值班人员"
        onClose={() => { setImportOpen(false); setImportFile(null); setImportResult(null) }}
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setImportOpen(false); setImportFile(null); setImportResult(null) }}>关闭</Button>
            <Button variant="primary" size="sm" loading={importing} disabled={!importFile} onClick={handleImport}>开始导入</Button>
          </>
        }
      >
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">请先下载模板，按格式填写后上传 .xlsx 文件。</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleDownloadTemplate}><Download className="mr-1 h-3.5 w-3.5" />下载模板</Button>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportResult(null) }}
              className="text-xs text-muted-foreground file:mr-2 file:rounded file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-primary"
            />
          </div>
          {importResult && (
            <div className="rounded-md border border-border bg-muted p-3 text-xs">
              <div className="text-success">成功 {importResult.success} 条</div>
              {importResult.total_errors > 0 && (
                <div className="mt-1 text-destructive">失败 {importResult.total_errors} 条：</div>
              )}
              {importResult.errors && importResult.errors.length > 0 && (
                <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4 text-muted-foreground">
                  {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 轮班公平性统计弹窗 */}
      <Modal
        open={statsOpen}
        title="轮班公平性统计"
        onClose={() => setStatsOpen(false)}
        size="lg"
        footer={<div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => setStatsOpen(false)}>关闭</Button></div>}
      >
        <div className="space-y-3 py-2">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className={labelCls}>起始日期</label>
              <DatePicker value={statsRange.start_date} onChange={(e) => setStatsRange((r) => ({ ...r, start_date: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls}>结束日期</label>
              <DatePicker value={statsRange.end_date} onChange={(e) => setStatsRange((r) => ({ ...r, end_date: e.target.value }))} />
            </div>
            <Button size="sm" variant="secondary" onClick={loadStats}>查询</Button>
            <span className="text-xs text-muted-foreground">默认近 90 天</span>
          </div>

          {statsLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
          ) : statsData ? (
            <>
              {/* 公平性摘要 */}
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(statsData.fairness || {}).map(([cat, f]) => (
                  <div key={cat} className="rounded-md border border-border bg-card px-3 py-2 text-xs">
                    <div className="flex items-center gap-1.5"><Badge variant="primary">全部值班人员</Badge></div>
                    <div className="mt-1.5 space-y-0.5 text-muted-foreground">
                      <div>最多 <span className="font-semibold text-foreground tabular-nums">{f.max}</span></div>
                      <div>最少 <span className="font-semibold text-foreground tabular-nums">{f.min}</span></div>
                      <div>平均 <span className="font-semibold text-foreground tabular-nums">{f.avg}</span></div>
                      <div>差距 <span className={`font-semibold tabular-nums ${f.gap > 2 ? 'text-warning' : 'text-success'}`}>{f.gap}</span></div>
                    </div>
                  </div>
                ))}
              </div>

              {/* 人员明细 */}
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">姓名</th>
                      <th className="px-2 py-1.5 text-left">组别</th>
                      <th className="px-2 py-1.5 text-right">白班</th>
                      <th className="px-2 py-1.5 text-right">晚班</th>
                      <th className="px-2 py-1.5 text-right">合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(statsData.items || []).map((it) => (
                      <tr key={it.id} className="border-t border-border">
                        <td className="px-2 py-1 font-medium">{it.name}</td>
                        <td className="px-2 py-1 text-muted-foreground">{it.group_name || '-'}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-primary">{it.day_count}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-purple-500">{it.night_count}</td>
                        <td className="px-2 py-1 text-right font-semibold tabular-nums">{it.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted-foreground">统计区间：{statsData.start_date} ~ {statsData.end_date}。差距为全部人员中最多与最少班次之差，差距越大排班越不均衡。</p>
            </>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无数据</div>
          )}
        </div>
      </Modal>
    </PageContainer>
  )
}
