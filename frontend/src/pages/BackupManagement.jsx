import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Download, RotateCcw, Trash2, X, FileText, Upload, HardDrive, Clock,
  Calendar, HeartPulse, Settings as SettingsIcon, ShieldCheck, Lock,
  AlertTriangle, CheckCircle2, Loader2, Plus,
} from 'lucide-react'
import { backupApi } from '../api/backup'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { DataTable, Pagination, CompactSelect, DatePicker } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'

// ============ 工具函数 ============
function fmtTime(t) {
  if (!t) return '-'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}
function fmtSize(bytes) {
  if (bytes == null) return '-'
  const n = Number(bytes)
  if (!isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
function fmtSizeMB(mb) {
  if (mb == null) return '-'
  return fmtSize(mb * 1024 * 1024)
}
function fmtDuration(seconds) {
  if (seconds == null) return '-'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
}
// 相对时间倒计时
function fmtCountdown(target) {
  if (!target) return '未配置'
  const diff = new Date(target).getTime() - Date.now()
  if (diff <= 0) return '即将执行'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} 天 ${hours % 24} 时后`
  if (hours > 0) return `${hours} 时 ${mins % 60} 分后`
  return `${mins} 分后`
}

// ============ 通用小组件 ============
// 备份状态徽章：圆点 + 语义色，进行中（info）圆点带呼吸动画
function StatusBadge({ status }) {
  const map = {
    completed: { dot: 'bg-success', text: 'text-success', label: '已完成' },
    failed: { dot: 'bg-destructive', text: 'text-destructive', label: '失败' },
    running: { dot: 'bg-info dot-pulse', text: 'text-info', label: '进行中' },
    expired: { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: '已过期' },
  }
  const item = map[status] || { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: status || '-' }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.dot}`} />
      <span className={`font-medium ${item.text}`}>{item.label}</span>
    </span>
  )
}
function TypeBadge({ type }) {
  const map = {
    manual: { cls: 'bg-primary/20 text-primary', label: '手动' },
    scheduled: { cls: 'bg-info/20 text-info', label: '自动' },
  }
  const item = map[type] || { cls: 'bg-muted text-muted-foreground', label: type || '-' }
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${item.cls}`}>{item.label}</span>
}
function ScopeBadge({ scope }) {
  if (!scope || scope === 'full') return <span className="rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">全量</span>
  const mods = scope.split(',').filter(Boolean)
  return (
    <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground" title={mods.join('、')}>
      部分 · {mods.length} 模块
    </span>
  )
}

// ============ 主组件 ============
const FETCH_LIMIT = 1000

// 备份模块定义（与后端 MODULE_TABLES 对应）
const BACKUP_MODULES = [
  { key: 'agents', label: '智能体与技能' },
  { key: 'kbs', label: '知识库' },
  { key: 'tools', label: '工具' },
  { key: 'workflows', label: '工作流' },
  { key: 'assets', label: '资产数据' },
  { key: 'system_config', label: '系统配置' },
  { key: 'users', label: '用户与权限' },
]

function BackupManagement() {
  const [activeTab, setActiveTab] = useState('records')
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actioning, setActioning] = useState({})

  // 概览统计
  const [stats, setStats] = useState(null)
  // 策略
  const [strategy, setStrategy] = useState(null)
  const [strategySaving, setStrategySaving] = useState(false)

  // 弹窗：创建备份 / 恢复 / 详情 / 上传
  const [createOpen, setCreateOpen] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [detailId, setDetailId] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)

  // 筛选 / 分页 / 批量选择
  const [{ search, fType, fStatus, fRange }, setFilters] = usePersistedFilters('backup_mgmt', {
    search: '', fType: '', fStatus: '', fRange: '',
  })
  const setSearch = (v) => setFilters({ search: v })
  const setFType = (v) => setFilters({ fType: v })
  const setFStatus = (v) => setFilters({ fStatus: v })
  const setFRange = (v) => setFilters({ fRange: v })
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const [deleting, setDeleting] = useState(false)

  const filteredRows = useMemo(() => {
    let rows = backups
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter((b) => [b.name, b.filename, b.backup_type, b.created_by, b.status, b.note].some((v) => (v || '').toLowerCase().includes(q)))
    }
    if (fType) rows = rows.filter((b) => b.backup_type === fType)
    if (fStatus) rows = rows.filter((b) => (fStatus === 'expired' ? b.expired : b.status === fStatus && !b.expired))
    if (fRange) {
      const now = Date.now()
      const days = parseInt(fRange, 10)
      rows = rows.filter((b) => b.created_at && (now - new Date(b.created_at).getTime()) <= days * 86400000)
    }
    return rows
  }, [backups, search, fType, fStatus, fRange])
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, s] = await Promise.all([backupApi.list(FETCH_LIMIT, 0), backupApi.stats()])
      setBackups(res?.backups || [])
      setStats(s)
      setError('')
    } catch (err) { setError(err.message || '加载失败') }
    finally { setLoading(false) }
  }, [])

  const loadStrategy = useCallback(async () => {
    try {
      const r = await backupApi.getStrategy()
      setStrategy(r?.strategy || null)
    } catch (err) { toast.error(`加载策略失败：${err.message || err}`) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (activeTab === 'strategy') loadStrategy() }, [activeTab, loadStrategy])

  // 下载
  const handleDownload = async (id) => {
    setActioning((p) => ({ ...p, [id]: 'download' }))
    try { await backupApi.download(id); toast.info('下载已开始') }
    catch (err) { toast.error(err.message || '下载失败') }
    finally { setActioning((p) => { const n = { ...p }; delete n[id]; return n }) }
  }

  // 恢复（打开安全确认弹窗）
  const handleRestoreClick = (b) => setRestoreTarget(b)

  // 删除
  const handleDelete = async (id) => {
    const ok = await confirm({ message: '确定要删除该备份吗？此操作不可撤销。', variant: 'danger', confirmText: '确定删除' })
    if (!ok) return
    setActioning((p) => ({ ...p, [id]: 'delete' }))
    try { await backupApi.remove(id); setSelectedKeys((prev) => prev.filter((k) => k !== id)); toast.success('删除成功'); await load() }
    catch (err) { toast.error(err.message || '删除失败') }
    finally { setActioning((p) => { const n = { ...p }; delete n[id]; return n }) }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个备份吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) { try { await backupApi.remove(id); ok++ } catch { fail++ } }
    clear(); await load(); setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个备份`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 清理过期
  const handleCleanup = async () => {
    const ok = await confirm({ message: '确定清理所有过期备份吗？将永久删除标记为过期的备份文件。', variant: 'warning', confirmText: '确定清理' })
    if (!ok) return
    try {
      const r = await backupApi.cleanupExpired()
      toast.success(`已清理 ${r.deleted} 个过期备份`)
      await load()
    } catch (err) { toast.error(err.message || '清理失败') }
  }

  // 校验完整性
  const handleVerify = async (id) => {
    setActioning((p) => ({ ...p, [id]: 'verify' }))
    try {
      const r = await backupApi.verify(id)
      if (r.verified) toast.success(r.message)
      else toast.warning(r.message)
    } catch (err) { toast.error(err.message || '校验失败') }
    finally { setActioning((p) => { const n = { ...p }; delete n[id]; return n }) }
  }

  const iconBtnCls = 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-secondary text-xs text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50'

  // 表格列定义
  const columns = [
    { key: 'name', header: '备份名称', render: (b) => (
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{b.name || '-'}</span>
        {b.note && <span className="text-[10px] text-muted-foreground truncate max-w-[180px]" title={b.note}>{b.note}</span>}
      </div>
    ) },
    { key: 'created_at', header: '备份时间', width: '150px', render: (b) => <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(b.created_at)}</span> },
    { key: 'duration', header: '耗时', width: '80px', render: (b) => <span className="font-mono text-[11px] text-muted-foreground">{fmtDuration(b.duration_seconds)}</span> },
    { key: 'backup_type', header: '类型', width: '70px', render: (b) => <TypeBadge type={b.backup_type} /> },
    { key: 'scope', header: '范围', width: '100px', render: (b) => <ScopeBadge scope={b.scope} /> },
    { key: 'file_size_mb', header: '大小', width: '90px', numeric: true, render: (b) => <span className="font-mono text-muted-foreground">{fmtSizeMB(b.file_size_mb)}</span> },
    { key: 'status', header: '状态', width: '80px', render: (b) => (
      <div className="flex flex-col items-start gap-0.5">
        <StatusBadge status={b.expired ? 'expired' : b.status} />
        {b.status === 'failed' && b.error_message && (
          <span className="max-w-[120px] truncate text-[10px] text-destructive/70" title={b.error_message}>⚠ {b.error_message}</span>
        )}
      </div>
    ) },
    { key: 'storage', header: '存储/加密', width: '90px', render: (b) => (
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span>{b.storage_location}</span>
        {b.is_encrypted && <Lock className="h-2.5 w-2.5 text-primary" />}
      </div>
    ) },
    { key: 'checksum', header: '校验', width: '60px', render: (b) => b.checksum ? (
      <span className="inline-flex items-center text-success" title={b.checksum}><CheckCircle2 className="h-3 w-3" /></span>
    ) : <span className="text-muted-foreground">-</span> },
    { key: 'created_by', header: '创建者', width: '90px', render: (b) => <span className="truncate text-muted-foreground">{b.created_by || '-'}</span> },
    {
      key: '__actions', header: '操作', width: '355px',
      render: (b) => {
        const act = actioning[b.id]
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setDetailId(b.id)} className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary">
              <FileText className="h-3 w-3" /> 详情
            </button>
            <button type="button" onClick={() => handleDownload(b.id)} disabled={b.status !== 'completed' || b.expired || !!act} className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary disabled:opacity-50">
              <Download className="h-3 w-3" /> 下载
            </button>
            <button type="button" onClick={() => handleVerify(b.id)} disabled={b.status !== 'completed' || b.expired || !!act} className={iconBtnCls} title="校验完整性">
              {act === 'verify' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
            </button>
            <button type="button" onClick={() => handleRestoreClick(b)} disabled={b.status !== 'completed' || b.expired || !!act}
              className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning hover:bg-warning/20 disabled:opacity-50">
              <RotateCcw className="h-3 w-3" /> 恢复
            </button>
            <button type="button" onClick={() => handleDelete(b.id)} disabled={!!act} className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/20 disabled:opacity-50">
              <Trash2 className="h-3 w-3" /> 删除
            </button>
            {act && act !== 'verify' && <span className="ml-1 text-[11px] text-muted-foreground">{act === 'download' ? '下载中' : act === 'restore' ? '恢复中' : '删除中'}</span>}
          </div>
        )
      },
    },
  ]

  const tabs = [
    { key: 'records', label: '备份记录' },
    { key: 'strategy', label: '策略与存储' },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight">数据备份与恢复</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setUploadOpen(true)} className="btn-secondary btn-sm">
            <Upload className="h-3.5 w-3.5" /> 上传备份
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" /> 创建备份
          </button>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-border bg-card px-6 pt-3">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${activeTab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
        )}

        {/* 概览卡片（4 个，两个 tab 都显示） */}
        <OverviewCards stats={stats} onCleanup={handleCleanup} />

        {activeTab === 'records' && (
          <div className="mt-4 flex flex-col gap-3">
            <FilterBar
              search={{ value: search, onChange: (v) => { setSearch(v); setPage(1) }, placeholder: '搜索名称 / 创建者 / 备注...' }}
              filters={[
                { key: 'type', label: '类型', value: fType, onChange: (v) => { setFType(v); setPage(1) }, options: [{ value: '', label: '全部类型' }, { value: 'manual', label: '手动' }, { value: 'scheduled', label: '自动' }] },
                { key: 'status', label: '状态', value: fStatus, onChange: (v) => { setFStatus(v); setPage(1) }, options: [{ value: '', label: '全部状态' }, { value: 'completed', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'running', label: '进行中' }, { value: 'expired', label: '过期' }] },
                { key: 'range', label: '时间', value: fRange, onChange: (v) => { setFRange(v); setPage(1) }, options: [{ value: '', label: '全部时间' }, { value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }, { value: '90', label: '近 90 天' }] },
              ]}
            />
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <DataTable
                columns={columns}
                data={paged}
                loading={loading}
                selectable
                selectedKeys={selectedKeys}
                onSelectChange={setSelectedKeys}
                rowKey="id"
                onRowClick={(b) => setDetailId(b.id)}
                emptyText="暂无备份记录，点击右上角「创建备份」开始第一次备份"
              />
            </div>
            <Pagination page={page} pageSize={pageSize} total={filteredRows.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
            <BatchActions selectedCount={selectedKeys.length} onClear={clear}
              actions={[{ key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting }]}
            />
          </div>
        )}

        {activeTab === 'strategy' && (
          <StrategySection strategy={strategy} loading={strategy === null} saving={strategySaving}
            onSave={async (body) => {
              setStrategySaving(true)
              try { await backupApi.setStrategy(body); setStrategy(body); toast.success('备份策略已保存'); await load() }
              catch (err) { toast.error(`保存失败：${err.message || err}`) }
              finally { setStrategySaving(false) }
            }}
          />
        )}
      </div>

      {/* 创建备份弹窗 */}
      {createOpen && (
        <CreateBackupModal
          onClose={() => setCreateOpen(false)}
          onConfirm={async (opts) => {
            const record = await backupApi.create(opts)
            return record
          }}
          onCompleted={async () => {
            setPage(1); setCreateOpen(false); await load()
          }}
        />
      )}

      {/* 恢复安全确认弹窗 */}
      {restoreTarget && (
        <RestoreModal
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onConfirm={async (mode, modules) => {
            setActioning((p) => ({ ...p, [restoreTarget.id]: 'restore' }))
            try {
              const r = await backupApi.restore(restoreTarget.id, { confirm: true, mode, modules: mode === 'partial' ? modules : undefined })
              if (r.success) toast.success(r.message)
              else toast.warning(r.message)
              await load()
            } catch (err) { toast.error(err.message || '恢复失败') }
            finally { setActioning((p) => { const n = { ...p }; delete n[restoreTarget.id]; return n }) }
            setRestoreTarget(null)
          }}
        />
      )}

      {/* 备份详情抽屉 */}
      {detailId && (
        <DetailDrawer id={detailId} onClose={() => setDetailId(null)}
          onDownload={(id) => handleDownload(id)}
          onRestore={(b) => { setDetailId(null); setRestoreTarget(b) }}
          onDelete={async (id) => { setDetailId(null); await handleDelete(id) }}
        />
      )}

      {/* 上传备份弹窗 */}
      {uploadOpen && (
        <UploadModal onClose={() => setUploadOpen(false)}
          onUploaded={async () => { setUploadOpen(false); toast.success('上传成功'); await load() }}
        />
      )}
    </div>
  )
}

// ============ 概览卡片（4 个） ============
function OverviewCards({ stats, onCleanup }) {
  const last = stats?.last_backup
  const storage = stats?.storage
  const health = stats?.health
  // 存储上限 10GB（与容器卷可用空间对齐，仅用于进度展示）
  const STORAGE_LIMIT_MB = 10240
  const sizePct = storage?.total_size_mb ? Math.min(100, (storage.total_size_mb / STORAGE_LIMIT_MB) * 100) : 0

  // 健康度：成功率 = 成功 / (成功 + 失败)
  const totalRecent = (health?.recent_success || 0) + (health?.recent_failed || 0)
  const successRate = totalRecent > 0 ? Math.round(((health?.recent_success || 0) / totalRecent) * 100) : null

  const cards = [
    {
      icon: Clock, label: '上次备份', value: last ? fmtTime(last.created_at) : '从未备份',
      sub: last ? `${last.backup_type === 'manual' ? '手动' : '自动'} · ${last.created_by || '-'} · ${fmtSizeMB(last.file_size_mb)}` : '点击创建开始第一次备份',
      color: 'text-primary',
    },
    {
      icon: Calendar, label: '下次自动备份',
      value: stats?.strategy_enabled ? fmtCountdown(stats?.next_backup) : '未配置',
      sub: stats?.strategy_enabled ? `计划：${stats?.strategy_period === 'daily' ? '每天' : stats?.strategy_period === 'weekly' ? '每周一' : '每月 1 号'} ${stats?.strategy_time}` : '前往「策略与存储」开启自动备份',
      color: 'text-info',
    },
    {
      icon: HardDrive, label: '存储占用',
      value: fmtSizeMB(storage?.total_size_mb),
      sub: `共 ${storage?.total_count || 0} 个备份文件 · 上限 ${fmtSizeMB(STORAGE_LIMIT_MB)}`,
      progress: sizePct,
      progressLabel: `${fmtSizeMB(storage?.total_size_mb || 0)} / ${fmtSizeMB(STORAGE_LIMIT_MB)}（${sizePct.toFixed(1)}%）`,
      color: sizePct > 90 ? 'text-destructive' : sizePct > 80 ? 'text-warning' : 'text-success',
      onCleanup,
    },
    {
      icon: HeartPulse, label: '备份健康度',
      value: successRate != null ? `成功率 ${successRate}%` : '-',
      sub: health
        ? `最近 7 天：${health.recent_success || 0}/${totalRecent} 成功${health.recent_failed > 0 ? ` · ${health.recent_failed} 次失败` : ''}`
        : '暂无数据',
      footer: last ? `最近备份：${fmtTime(last.created_at)}` : null,
      color: (health?.recent_failed || 0) > 0 ? 'text-warning' : 'text-success',
      failed: (health?.recent_failed || 0) > 0,
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c, i) => (
        <div key={i} className="flex flex-col rounded-lg border border-border bg-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{c.label}</span>
            <c.icon className={`h-4 w-4 ${c.color}`} />
          </div>
          <div className={`text-lg font-semibold tabular-nums ${c.color}`}>{c.value}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{c.sub}</div>
          {c.progress != null && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{c.progressLabel}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full transition-all ${c.color === 'text-destructive' ? 'bg-destructive' : c.color === 'text-warning' ? 'bg-warning' : 'bg-success'}`} style={{ width: `${c.progress}%` }} />
              </div>
            </div>
          )}
          {c.footer && (
            <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">{c.footer}</div>
          )}
          {c.onCleanup && c.progress > 60 && (
            <button type="button" onClick={c.onCleanup} className="mt-2 text-[10px] text-primary hover:underline">清理过期备份</button>
          )}
        </div>
      ))}
    </div>
  )
}

// ============ 策略配置区 ============
function StrategySection({ strategy, loading, saving, onSave }) {
  const [form, setForm] = useState(null)
  useEffect(() => { if (strategy) setForm({ ...strategy }) }, [strategy])
  if (loading || !form) return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
  const setF = (k) => (v) => setForm((p) => ({ ...p, [k]: v }))

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-7">
        <div className="mb-4 flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">自动备份策略</h3>
          <span className="text-[11px] text-muted-foreground">开启后系统按计划自动执行 pg_dump 备份</span>
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border bg-secondary p-3.5 sm:col-span-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">启用自动备份</span>
              <span className="text-[11px] text-muted-foreground">关闭后仅支持手动备份</span>
            </div>
            <Toggle checked={!!form.enabled} onChange={setF('enabled')} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">备份周期</label>
            <CompactSelect size="lg" block value={form.period} onChange={(e) => setF('period')(e.target.value)}>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </CompactSelect>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">备份时间</label>
            <DatePicker type="time" block value={form.time} onChange={(e) => setF('time')(e.target.value)} />
            <p className="mt-1.5 text-[10px] text-muted-foreground">建议选择业务低峰期，如凌晨 2:00</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">保留份数</label>
            <input type="number" min={1} value={form.retention_count} onChange={(e) => setF('retention_count')(Number(e.target.value))} className="w-full rounded-md border border-border bg-secondary px-2.5 py-2 text-sm outline-none focus:border-primary" />
            <p className="mt-1.5 text-[10px] text-muted-foreground">超出自动清理最早的备份</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">保留天数</label>
            <input type="number" min={1} value={form.retention_days} onChange={(e) => setF('retention_days')(Number(e.target.value))} className="w-full rounded-md border border-border bg-secondary px-2.5 py-2 text-sm outline-none focus:border-primary" />
            <p className="mt-1.5 text-[10px] text-muted-foreground">超过该天数的备份标记过期</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">备份范围</label>
            <CompactSelect size="lg" block value={form.scope} onChange={(e) => setF('scope')(e.target.value)}>
              <option value="full">全量备份</option>
              <option value="agents,workflows,tools">核心业务（智能体/工作流/工具）</option>
            </CompactSelect>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">存储位置</label>
            <CompactSelect size="lg" block value={form.storage_location} onChange={(e) => setF('storage_location')(e.target.value)}>
              <option value="local">本地磁盘</option>
              <option value="oss" disabled>远程 OSS（待对接）</option>
              <option value="s3" disabled>S3（待对接）</option>
              <option value="nfs" disabled>NFS（待对接）</option>
            </CompactSelect>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border bg-secondary p-3.5 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium">加密存储</span>
              <span className="text-[11px] text-muted-foreground">对备份文件加密存储（增强安全）</span>
            </div>
            <Toggle checked={!!form.is_encrypted} onChange={setF('is_encrypted')} />
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={() => onSave(form)} disabled={saving} className="btn-primary btn-sm">
            {saving ? '保存中...' : '保存策略'}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-7">
        <div className="mb-3 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">存储管理</h3>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          当前所有备份文件存储于容器内 <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">/app/backups/</code> 目录。
          建议定期将备份文件同步到外部存储（如对象存储、NAS）以防止单点故障。
        </p>
      </div>
    </div>
  )
}

// ============ 创建备份弹窗（表单 + 进度条） ============
function CreateBackupModal({ onClose, onConfirm, onCompleted }) {
  useLockBackgroundScroll(true)
  const ts = useMemo(() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }, [])
  const [name, setName] = useState(`backup_${ts}`)
  const [scope, setScope] = useState('full')
  const [modules, setModules] = useState([])
  const [note, setNote] = useState('')
  const [isEncrypted, setIsEncrypted] = useState(false)
  const toggleModule = (key) => setModules((p) => p.includes(key) ? p.filter((m) => m !== key) : [...p, key])

  // 进度步骤状态：form 填表 / backing_up 备份中 / done 完成 / error 失败
  const [step, setStep] = useState('form')
  const [progress, setProgress] = useState(0)
  const [stageText, setStageText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [backupRecord, setBackupRecord] = useState(null)
  // 模拟进度定时器引用
  const timerRef = useRef(null)
  const pollRef = useRef(null)
  const startTimeRef = useRef(0)

  // 清理定时器
  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  // 组件卸载时清理
  useEffect(() => () => clearTimers(), [clearTimers])

  // 模拟进度推进（pg_dump 无法报告精确进度，用平滑推进到 90% 等待完成）
  const startSimulatedProgress = useCallback(() => {
    startTimeRef.current = Date.now()
    setProgress(10)
    setStageText('正在初始化备份...')
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      // 前 2 秒快速到 30%，之后缓慢推进到 90%，剩余 10% 等待真实完成信号
      let p
      if (elapsed < 2) p = 10 + (elapsed / 2) * 20
      else if (elapsed < 10) p = 30 + ((elapsed - 2) / 8) * 40
      else p = Math.min(90, 70 + (elapsed - 10) * 1.5)
      setProgress(Math.round(p))
      // 阶段文字
      if (p < 30) setStageText('正在初始化备份...')
      else if (p < 70) setStageText('正在导出数据库（pg_dump）...')
      else if (p < 90) setStageText('正在计算文件大小与校验值...')
      else setStageText('即将完成...')
    }, 500)
  }, [])

  // 轮询备份状态
  const startPolling = useCallback((backupId) => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await backupApi.status(backupId)
        if (s.status === 'completed') {
          clearTimers()
          setProgress(100)
          setStageText('备份完成')
          setStep('done')
          toast.success('备份创建成功')
          // 延迟关闭弹窗让用户看到 100%
          setTimeout(() => { onCompleted() }, 1200)
        } else if (s.status === 'failed') {
          clearTimers()
          setProgress(100)
          setStageText('备份失败')
          setErrorMsg(s.error_message || '未知错误')
          setStep('error')
          toast.error(`备份失败：${s.error_message || '未知错误'}`)
        }
      } catch (err) {
        // 轮询失败不中断，继续重试
      }
    }, 1500)
  }, [clearTimers, onCompleted])

  // 点击开始备份
  const handleStart = async () => {
    setStep('backing_up')
    setProgress(0)
    setErrorMsg('')
    setBackupRecord(null)
    try {
      const opts = {
        backup_type: 'manual', name: name.trim() || `backup_${ts}`, note: note.trim() || null,
        scope: scope === 'partial' ? modules.join(',') : 'full',
        storage_location: 'local', is_encrypted: isEncrypted,
      }
      const record = await onConfirm(opts)
      setBackupRecord(record)
      // 后端已创建 running 记录，启动模拟进度 + 轮询
      startSimulatedProgress()
      startPolling(record.id)
    } catch (err) {
      clearTimers()
      setStep('error')
      setErrorMsg(err.message || String(err))
      toast.error(`创建失败：${err.message || err}`)
    }
  }

  // 关闭弹窗（备份中不允许关闭）
  const handleClose = () => {
    if (step === 'backing_up') return
    clearTimers()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={step === 'backing_up' ? undefined : handleClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {step === 'form' && '创建备份'}
            {step === 'backing_up' && '备份进行中'}
            {step === 'done' && '备份完成'}
            {step === 'error' && '备份失败'}
          </h3>
          <button onClick={handleClose} disabled={step === 'backing_up'} className="text-muted-foreground transition hover:text-foreground disabled:opacity-30">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 步骤 1：表单 */}
        {step === 'form' && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">备份名称</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">备份类型</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setScope('full')} className={`rounded-md border p-2 text-left text-xs transition ${scope === 'full' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                  <div className="font-medium">全量备份</div>
                  <div className="text-[10px] text-muted-foreground">导出整个数据库</div>
                </button>
                <button type="button" onClick={() => setScope('partial')} className={`rounded-md border p-2 text-left text-xs transition ${scope === 'partial' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                  <div className="font-medium">自定义备份</div>
                  <div className="text-[10px] text-muted-foreground">选择要备份的模块</div>
                </button>
              </div>
            </div>
            {scope === 'partial' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">备份模块</label>
                <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-secondary p-2">
                  {BACKUP_MODULES.map((m) => (
                    <label key={m.key} className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={modules.includes(m.key)} onChange={() => toggleModule(m.key)} className="accent-primary" />
                      {m.label}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">注：当前底层为全库 pg_dump，模块选择作为范围元数据记录</p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">备注说明</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="记录备份原因..." className="w-full rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary p-2.5">
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs">加密存储</span>
              </div>
              <Toggle checked={isEncrypted} onChange={() => setIsEncrypted((p) => !p)} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={handleClose} className="btn-secondary btn-sm">取消</button>
              <button onClick={handleStart} className="btn-primary btn-sm">开始备份</button>
            </div>
          </div>
        )}

        {/* 步骤 2：进度条 */}
        {step === 'backing_up' && (
          <div className="flex flex-col items-center gap-4 py-6">
            {/* 旋转图标 */}
            <div className="relative flex h-16 w-16 items-center justify-center">
              <svg className="h-16 w-16 -rotate-90" viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="4" className="text-muted" />
                <circle
                  cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"
                  className="text-primary transition-all duration-500"
                  strokeDasharray={`${2 * Math.PI * 28}`}
                  strokeDashoffset={`${2 * Math.PI * 28 * (1 - progress / 100)}`}
                />
              </svg>
              <span className="absolute text-sm font-bold text-primary">{progress}%</span>
            </div>
            {/* 阶段文字 */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {stageText}
            </div>
            {/* 进度条 */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            {/* 提示 */}
            <div className="text-center text-[11px] text-muted-foreground">
              {backupRecord?.name && <div>备份名称：{backupRecord.name}</div>}
              <div className="mt-0.5">pg_dump 正在导出数据库，请勿关闭页面</div>
            </div>
          </div>
        )}

        {/* 步骤 3：完成 */}
        {step === 'done' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/20">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <div className="text-sm font-medium text-foreground">备份创建成功</div>
            {backupRecord?.name && <div className="text-xs text-muted-foreground">{backupRecord.name}</div>}
            <button onClick={handleClose} className="btn-primary btn-sm mt-2">关闭</button>
          </div>
        )}

        {/* 步骤 4：失败 */}
        {step === 'error' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="text-sm font-medium text-foreground">备份失败</div>
            {errorMsg && (
              <div className="max-h-24 w-full overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                {errorMsg}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button onClick={() => { setStep('form'); setProgress(0); setErrorMsg('') }} className="btn-secondary btn-sm">返回重试</button>
              <button onClick={handleClose} className="btn-primary btn-sm">关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============ 恢复安全确认弹窗 ============
function RestoreModal({ backup, onClose, onConfirm }) {
  useLockBackgroundScroll(true)
  const [mode, setMode] = useState('full')
  const [modules, setModules] = useState([])
  const [password, setPassword] = useState('')
  const [step, setStep] = useState('confirm') // confirm / restoring
  const toggleModule = (key) => setModules((p) => p.includes(key) ? p.filter((m) => m !== key) : [...p, key])

  const versionMismatch = backup.version && backup.version !== '1.0.0'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-warning flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> 恢复确认
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        {/* 备份信息 */}
        <div className="mb-3 rounded-md border border-border bg-secondary p-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div><span className="text-muted-foreground">备份名称：</span>{backup.name || '-'}</div>
            <div><span className="text-muted-foreground">备份时间：</span>{fmtTime(backup.created_at)}</div>
            <div><span className="text-muted-foreground">文件大小：</span>{fmtSizeMB(backup.file_size_mb)}</div>
            <div><span className="text-muted-foreground">备份版本：</span>{backup.version || '-'}</div>
            <div><span className="text-muted-foreground">备份范围：</span>{backup.scope === 'full' ? '全量' : backup.scope}</div>
            <div><span className="text-muted-foreground">创建者：</span>{backup.created_by || '-'}</div>
          </div>
        </div>

        {/* 警告 */}
        <div className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium">恢复将覆盖当前数据，请在业务低峰期操作，且不可撤销。</div>
              {versionMismatch && <div className="mt-1">⚠ 备份版本 {backup.version} 与当前系统版本不一致，可能存在兼容性风险。</div>}
            </div>
          </div>
        </div>

        {/* 恢复模式 */}
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">恢复模式</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode('full')} className={`rounded-md border p-2 text-left text-xs transition ${mode === 'full' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
              <div className="font-medium">完全恢复</div>
              <div className="text-[10px] text-muted-foreground">覆盖全部数据</div>
            </button>
            <button type="button" onClick={() => setMode('partial')} className={`rounded-md border p-2 text-left text-xs transition ${mode === 'partial' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
              <div className="font-medium">部分恢复</div>
              <div className="text-[10px] text-muted-foreground">仅恢复选定模块</div>
            </button>
          </div>
        </div>
        {mode === 'partial' && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">选择恢复模块</label>
            <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-secondary p-2">
              {BACKUP_MODULES.map((m) => (
                <label key={m.key} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={modules.includes(m.key)} onChange={() => toggleModule(m.key)} className="accent-primary" />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 密码二次验证 */}
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">管理员密码（二次验证）</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入您的登录密码以确认恢复" className="w-full rounded-md border border-border bg-secondary px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary btn-sm">取消</button>
          <button onClick={() => onConfirm(mode, modules)} disabled={mode === 'partial' && modules.length === 0} className="btn-sm border border-warning bg-warning/20 text-warning hover:bg-warning/30 disabled:opacity-50">
            <RotateCcw className="h-3 w-3" /> 确认恢复
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ 备份详情抽屉 ============
function DetailDrawer({ id, onClose, onDownload, onRestore, onDelete }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  useLockBackgroundScroll(true)
  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const d = await backupApi.detail(id)
        setDetail(d)
      } catch (err) { toast.error(`加载详情失败：${err.message || err}`) }
      finally { setLoading(false) }
    })()
  }, [id])
  const r = detail?.record

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">备份详情</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : !detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载失败</div>
        ) : (
          <div data-allow-scroll className="flex-1 overflow-y-auto overscroll-contain p-5">
            {/* 基本信息 */}
            <Section title="基本信息">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Info label="ID" value={r?.id} />
                <Info label="名称" value={r?.name} />
                <Info label="创建时间" value={fmtTime(r?.created_at)} />
                <Info label="完成时间" value={fmtTime(r?.completed_at)} />
                <Info label="类型" value={<TypeBadge type={r?.backup_type} />} />
                <Info label="状态" value={<StatusBadge status={r?.expired ? 'expired' : r?.status} />} />
                <Info label="文件大小" value={fmtSizeMB(r?.file_size_mb)} />
                <Info label="耗时" value={fmtDuration(r?.duration_seconds)} />
                <Info label="存储位置" value={r?.storage_location} />
                <Info label="加密" value={r?.is_encrypted ? '是' : '否'} />
                <Info label="版本" value={r?.version || '-'} />
                <Info label="创建者" value={r?.created_by || '-'} />
              </div>
              {r?.note && <div className="mt-2 rounded-md border border-border bg-secondary p-2 text-[11px] text-muted-foreground">备注：{r.note}</div>}
            </Section>

            {/* 备份范围 */}
            <Section title="备份范围">
              <div className="flex flex-col gap-1.5">
                {detail.modules?.map((m) => (
                  <div key={m.module} className="rounded-md border border-border bg-secondary p-2 text-xs">
                    <div className="font-medium text-foreground">{BACKUP_MODULES.find((bm) => bm.key === m.module)?.label || m.module}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">表：{m.tables.join(', ')}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* 文件清单 */}
            <Section title="文件清单">
              {detail.file_info ? (
                <div className="rounded-md border border-border bg-secondary p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono text-foreground">{detail.file_info.filename}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
                    <div>大小：{fmtSizeMB(detail.file_info.size_mb)}</div>
                    <div>修改时间：{fmtTime(detail.file_info.modified_at)}</div>
                  </div>
                  {!detail.file_exists && <div className="mt-1 text-[11px] text-destructive">⚠ 文件不存在</div>}
                </div>
              ) : <div className="text-xs text-muted-foreground">备份文件不存在</div>}
            </Section>

            {/* 校验信息 */}
            <Section title="校验信息">
              <div className="rounded-md border border-border bg-secondary p-2 text-xs">
                <div className="mb-1 flex items-center gap-2">
                  {r?.checksum ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <X className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="font-medium">{r?.checksum ? `${r.checksum_algo || 'sha256'} 校验值` : '未计算校验值'}</span>
                </div>
                {r?.checksum && <code className="block break-all text-[10px] text-muted-foreground">{r.checksum}</code>}
              </div>
            </Section>

            {/* 操作日志 */}
            <Section title="操作日志">
              <div className="flex flex-col gap-1">
                {detail.logs?.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border border-border bg-secondary p-2 text-[11px]">
                    <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${log.level === 'error' ? 'bg-destructive' : 'bg-success'}`} />
                    <div className="flex-1">
                      <div className={log.level === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{log.message}</div>
                      {log.at && <div className="text-[10px] text-muted-foreground">{fmtTime(log.at)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
        {/* 底部快速操作 */}
        {detail && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <button onClick={() => onDownload(id)} className="btn-secondary btn-sm"><Download className="h-3 w-3" /> 下载</button>
            <button onClick={() => onRestore(detail.record)} className="btn-sm border border-warning bg-warning/20 text-warning hover:bg-warning/30"><RotateCcw className="h-3 w-3" /> 恢复</button>
            <button onClick={() => onDelete(id)} className="btn-sm border border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20"><Trash2 className="h-3 w-3" /> 删除</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold text-foreground">{title}</div>
      {children}
    </div>
  )
}
function Info({ label, value }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}：</span>
      <span className="text-foreground">{value ?? '-'}</span>
    </div>
  )
}

// ============ 上传备份弹窗 ============
function UploadModal({ onClose, onUploaded }) {
  useLockBackgroundScroll(true)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const inputRef = useRef(null)

  const handleFile = (f) => {
    if (!f) return
    const allowed = ['.sql', '.bak', '.tar.gz', '.zip', '.dump']
    const lower = f.name.toLowerCase()
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      toast.error(`不支持的文件格式，仅支持 ${allowed.join(', ')}`)
      return
    }
    setFile(f)
  }

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    try {
      await backupApi.upload(file)
      onUploaded()
    } catch (err) { toast.error(err.message || '上传失败') }
    finally { setUploading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">上传本地备份</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition ${dragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
        >
          <Upload className="h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-xs text-muted-foreground">拖拽文件到此处或点击选择</p>
          <p className="mt-1 text-[10px] text-muted-foreground">支持 .sql / .bak / .tar.gz / .zip / .dump</p>
          {file && <p className="mt-2 text-xs text-primary">已选择：{file.name} ({fmtSize(file.size)})</p>}
          <input ref={inputRef} type="file" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary btn-sm">取消</button>
          <button onClick={handleUpload} disabled={!file || uploading} className="btn-primary btn-sm">
            {uploading ? <><Loader2 className="h-3 w-3 animate-spin" /> 上传中...</> : '上传'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ Toggle 开关 ============
function Toggle({ checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-primary' : 'bg-input'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

export default BackupManagement
