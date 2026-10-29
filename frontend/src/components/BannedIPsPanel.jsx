/**
 * BannedIPsPanel —— 已封禁 IP 管理面板（可复用组件）
 *
 * 从 BannedIPs.jsx 提取，供工作台 Tab 和独立 /banned-ips 路由共用。
 * 包含完整功能：统计卡片、筛选搜索、表格、详情弹窗、新增封禁、CSV导入导出。
 * 不含页面级标题栏（由外层页面/Tab提供上下文）。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Shield,
  ClipboardList,
  CircleAlert,
  Clock,
  CheckCircle2,
  AlertTriangle,
  SkipForward,
  Info,
  Copy,
  Download,
  ChevronDown,
  Trash2,
  Unlock,
} from 'lucide-react'
import { bannedIpsApi } from '../api/bannedIps'
import { devices as devicesApi } from '../api/client'
import { useAuthStore } from '../store/authStore'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { inputCls, inputBaseCls } from '../components/property/FormControls'
import { CompactSelect } from './ui'
import { validateBanTarget } from '../utils/ipValidation'

// 封禁等级中文映射 + 配色
const LEVEL_META = {
  low: { label: '低', cls: 'bg-primary/15 text-primary' },
  medium: { label: '中', cls: 'bg-warning/15 text-warning' },
  high: { label: '高', cls: 'bg-warning/15 text-warning' },
  serious: { label: '严重', cls: 'bg-destructive/20 text-destructive' },
}

// 封禁状态中文映射 + 配色
const STATUS_META = {
  active: { label: '封禁中', cls: 'bg-destructive/20 text-destructive' },
  expired: { label: '已过期', cls: 'bg-secondary text-muted-foreground' },
  unblocked: { label: '已解封', cls: 'bg-success/20 text-success' },
}

// 来源标识中文映射 + 配色
const SOURCE_META = {
  manual: { label: '手动添加', cls: 'bg-primary/15 text-primary' },
  agent: { label: '智能体添加', cls: 'bg-primary/15 text-primary' },
}

const LEVEL_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'serious', label: '严重' },
]

const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '封禁中' },
  { value: 'expired', label: '已过期' },
  { value: 'unblocked', label: '已解封' },
]

function fmtTime(t) {
  if (!t) return '-'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}

function humanizeDuration(sec) {
  if (sec == null) return '-'
  const s = Number(sec)
  if (!Number.isFinite(s)) return '-'
  if (s <= 0) return '永久'
  if (s >= 86400) return `${Math.floor(s / 86400)} 天`
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时`
  if (s >= 60) return `${Math.floor(s / 60)} 分钟`
  return `${s} 秒`
}

function fmtExpiry(t) {
  if (!t) return '-'
  if (String(t).startsWith('9999')) return '永久'
  return fmtTime(t)
}

// ============ 详情弹窗 ============
function DetailModal({ open, record, onClose, onUnban, onHardDelete, canUnban, unbanning, deleting }) {
  if (!record) return null
  const levelMeta = LEVEL_META[record.ban_level] || { label: record.ban_level, cls: 'bg-secondary text-muted-foreground' }
  const statusMeta = STATUS_META[record.status] || { label: record.status, cls: 'bg-secondary text-muted-foreground' }

  const fields = [
    { label: 'IP 地址', value: record.ip, mono: true },
    { label: '封禁等级', value: levelMeta.label, badge: levelMeta.cls },
    { label: '当前状态', value: statusMeta.label, badge: statusMeta.cls },
    { label: '来源', value: (SOURCE_META[record.source] || { label: record.source || '-' }).label, badge: (SOURCE_META[record.source] || {}).cls },
    { label: '封禁时长', value: humanizeDuration(record.ban_duration) },
    { label: '过期时间', value: fmtExpiry(record.expired_at) },
    { label: '违规次数', value: record.violation_count ?? 0 },
    { label: '归属地区', value: record.region || '-' },
    { label: '封禁时间', value: fmtTime(record.created_at) },
    { label: '更新时间', value: fmtTime(record.updated_at) },
  ]

  return (
    <Modal
      open={open}
      title={`已封禁 IP 详情：${record.ip || ''}`}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">关闭</button>
          {canUnban && record.status === 'active' && (
            <button type="button" onClick={() => onUnban(record)} disabled={unbanning || deleting} className="btn-danger">
              {unbanning ? '解封中…' : '手动解封'}
            </button>
          )}
          {canUnban && (
            <button type="button" onClick={() => onHardDelete(record)} disabled={unbanning || deleting} className="btn-danger">
              {deleting ? '删除中…' : '硬删除记录'}
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {fields.map((f) => (
            <div key={f.label} className="min-w-0">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{f.label}</div>
              {f.badge ? (
                <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${f.badge}`}>{f.value}</span>
              ) : (
                <div className={`truncate text-sm text-foreground ${f.mono ? 'font-mono' : ''}`} title={String(f.value)}>{f.value}</div>
              )}
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-muted-foreground">封禁原因</div>
          <div className="w-full rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
            {record.reason || '（未填写）'}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ============ 主面板组件 ============
function BannedIPsPanel() {
  const user = useAuthStore((s) => s.user)
  const canUnban = user?.role === 'admin'

  const [records, setRecords] = useState([])
  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0, unblocked: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRecord, setDetailRecord] = useState(null)
  const [unbanning, setUnbanning] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [devices, setDevices] = useState([])
  const [importDeviceId, setImportDeviceId] = useState('')
  const fileInputRef = useRef(null)
  // 批量选择
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [copiedIp, setCopiedIp] = useState(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState({ ip: '', ban_level: 'medium', ban_duration: 3600, region: '', reason: '' })
  const [createIpTouched, setCreateIpTouched] = useState(false)
  // 即时校验：封禁目标（单 IP / CIDR / 范围 / 多值，不允许通配）
  const createIpError = validateBanTarget(createForm.ip, '封禁目标')

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [list, st] = await Promise.all([
        bannedIpsApi.list({ search, status: statusFilter }),
        bannedIpsApi.stats(),
      ])
      setRecords(Array.isArray(list) ? list : [])
      setStats(st || { total: 0, active: 0, expired: 0, unblocked: 0 })
      setError('')
    } catch (err) {
      setError(err.message || '加载已封禁 IP 失败')
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => { loadAll() }, [loadAll])

  const handleUnban = async (record) => {
    if (!record) return
    const _ok = await confirm({ message: `确定手动解封 IP「${record.ip}」吗？解封后将无法恢复封禁状态。`, variant: 'danger', confirmText: '确定解封' })
    if (!_ok) return
    setUnbanning(true)
    try {
      await bannedIpsApi.unban(record.id)
      setDetailOpen(false); setDetailRecord(null)
      await loadAll()
    } catch (err) { toast.error(`解封失败：${err.message || err}`) }
    finally { setUnbanning(false) }
  }

  const handleHardDelete = async (record) => {
    if (!record) return
    const input = window.prompt(`⚠️ 硬删除将彻底从数据库删除 IP「${record.ip}」的记录，不可恢复！\n如确认删除，请输入该 IP 地址以继续：`)
    if (input === null) return
    if (input.trim() !== record.ip) { toast.info('输入的 IP 地址不匹配，已取消删除。'); return }
    setDeleting(true)
    try {
      await bannedIpsApi.hardDelete(record.id)
      setDetailOpen(false); setDetailRecord(null)
      await loadAll()
    } catch (err) { toast.error(`删除失败：${err.message || err}`) }
    finally { setDeleting(false) }
  }

  const handleCreate = async () => {
    if (!createForm.ip.trim()) { toast.warning('请填写 IP 地址'); return }
    const ipMsg = validateBanTarget(createForm.ip, '封禁目标')
    if (ipMsg) { setCreateIpTouched(true); toast.warning(ipMsg); return }
    setCreating(true)
    try {
      await bannedIpsApi.create({
        ip: createForm.ip.trim(),
        ban_level: createForm.ban_level,
        ban_duration: Number(createForm.ban_duration) || 0,
        region: createForm.region.trim(),
        reason: createForm.reason.trim(),
      })
      setCreateOpen(false)
      setCreateIpTouched(false)
      setCreateForm({ ip: '', ban_level: 'medium', ban_duration: 3600, region: '', reason: '' })
      await loadAll()
    } catch (err) { toast.error(`新增失败：${err.message || err}`) }
    finally { setCreating(false) }
  }

  const handleExport = async () => {
    setExporting(true)
    try { await bannedIpsApi.exportCsv() }
    catch (err) { toast.error(`导出失败：${err.message || err}`) }
    finally { setExporting(false) }
  }

  const handleImportClick = async () => {
    // 打开导入弹窗，先选择设备
    try {
      const list = await devicesApi.list()
      setDevices(Array.isArray(list) ? list : [])
      setImportDeviceId(list && list[0]?.id ? String(list[0].id) : '')
      setImportOpen(true)
    } catch (err) { toast.error(`加载设备列表失败：${err.message || err}`) }
  }

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!importDeviceId) { toast.warning('请先选择执行封禁的设备'); return }
    setImporting(true)
    try {
      const result = await bannedIpsApi.importCsv(file, Number(importDeviceId))
      setImportResult(result)
      setImportOpen(false)
      await loadAll()
    } catch (err) { toast.error(`导入失败：${err.message || err}`) }
    finally { setImporting(false) }
  }

  const handleDownloadTemplate = async () => {
    try { await bannedIpsApi.downloadTemplate() }
    catch (err) { toast.error(`下载模板失败：${err.message || err}`) }
  }

  // 复制 IP
  const handleCopyIp = (ip) => {
    navigator.clipboard.writeText(ip).then(() => {
      setCopiedIp(ip)
      setTimeout(() => setCopiedIp(null), 1500)
    })
  }

  // 批量选择操作
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === records.length) return new Set()
      return new Set(records.map((r) => r.id))
    })
  }
  const handleBatchUnban = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const ok = await confirm({ message: `确定批量解封 ${ids.length} 个 IP 吗？`, variant: 'danger', confirmText: '批量解封' })
    if (!ok) return
    setBatchBusy(true)
    let success = 0, failed = 0
    for (const id of ids) {
      try { await bannedIpsApi.unban(id); success++ }
      catch { failed++ }
    }
    setBatchBusy(false)
    setSelectedIds(new Set())
    await loadAll()
    if (failed === 0) toast.success(`批量解封成功 ${success} 个`)
    else toast.warning(`成功 ${success}，失败 ${failed}`)
  }
  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const ok = await confirm({ message: `⚠️ 批量硬删除 ${ids.length} 个 IP 记录？此操作不可恢复！`, variant: 'danger', confirmText: '批量删除' })
    if (!ok) return
    setBatchBusy(true)
    let success = 0, failed = 0
    for (const id of ids) {
      try { await bannedIpsApi.hardDelete(id); success++ }
      catch { failed++ }
    }
    setBatchBusy(false)
    setSelectedIds(new Set())
    await loadAll()
    if (failed === 0) toast.success(`批量删除成功 ${success} 个`)
    else toast.warning(`成功 ${success}，失败 ${failed}`)
  }
  const handleBatchExport = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const selected = records.filter((r) => ids.includes(r.id))
    const headers = ['IP地址', '等级', '封禁时长(秒)', '过期时间', '地区', '违规次数', '原因', '状态']
    const rows = selected.map((r) => [
      r.ip, r.ban_level, r.ban_duration || 0,
      r.expired_at || '', r.region || '', r.violation_count ?? 0,
      (r.reason || '').replace(/"/g, '""'), r.status,
    ])
    const csv = [headers, ...rows].map((row) => row.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `banned_ips_selected_${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${selected.length} 条记录`)
  }

  const statCards = [
    { key: 'total', label: '总计', value: stats.total, icon: <ClipboardList className="h-4 w-4" />, cls: 'text-foreground' },
    { key: 'active', label: '封禁中', value: stats.active, icon: <CircleAlert className="h-4 w-4" />, cls: 'text-destructive' },
    { key: 'expired', label: '已过期', value: stats.expired, icon: <Clock className="h-4 w-4" />, cls: 'text-muted-foreground' },
    { key: 'unblocked', label: '已解封', value: stats.unblocked, icon: <CheckCircle2 className="h-4 w-4" />, cls: 'text-success' },
  ]

  return (
    <div className="flex flex-col w-full min-w-0">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-4">
        {statCards.map((c) => (
          <div key={c.key} className="w-full rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{c.label}</span>
              <span className={`${c.cls}`}>{c.icon}</span>
            </div>
            <div className={`mt-1 text-2xl font-semibold ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* 工具栏：搜索 + 筛选 + 操作按钮 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card py-3 mb-4">
        <input
          className={`${inputBaseCls} max-w-xs`}
          placeholder="搜索 IP 地址..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <CompactSelect
          size="lg"
          block
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </CompactSelect>
        <div className="flex items-center gap-2">
          {canUnban && (
            <button type="button" onClick={() => { setCreateIpTouched(false); setCreateOpen(true) }} className="btn-primary btn-sm">
              + 新增封禁
            </button>
          )}
          <button type="button" onClick={handleExport} disabled={exporting} className="btn-secondary btn-sm">
            {exporting ? '导出中...' : '导出全部'}
          </button>
          {canUnban && (
            <div className="relative">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-secondary">
                  导入 CSV
                  <ChevronDown className="h-3 w-3" />
                </summary>
                <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-lg">
                  <button type="button" onClick={handleImportClick} className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted">
                    选择文件导入…
                  </button>
                  <button type="button" onClick={handleDownloadTemplate} className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted">
                    下载导入模板
                  </button>
                </div>
              </details>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
          <button type="button" onClick={loadAll} className="btn-secondary btn-sm">刷新</button>
        </div>
      </div>

      {/* 批量操作栏（选中时显示） */}
      {selectedIds.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-primary/40 bg-primary/5 px-4 py-2">
          <span className="text-xs font-medium text-primary">已选 {selectedIds.size} 项</span>
          <div className="flex items-center gap-2">
            {canUnban && (
              <button type="button" onClick={handleBatchUnban} disabled={batchBusy} className="flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning transition hover:bg-warning/20">
                <Unlock className="h-3 w-3" /> 批量解封
              </button>
            )}
            {canUnban && (
              <button type="button" onClick={handleBatchDelete} disabled={batchBusy} className="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive transition hover:bg-destructive/20">
                <Trash2 className="h-3 w-3" /> 批量删除
              </button>
            )}
            <button type="button" onClick={handleBatchExport} disabled={batchBusy} className="flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary">
              <Download className="h-3 w-3" /> 导出选中
            </button>
          </div>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">
            取消选择
          </button>
        </div>
      )}

      {/* 列表区 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : records.length === 0 ? (
          <div className="flex h-60 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Shield className="h-14 w-14 opacity-40" />
            <div className="text-sm font-medium">{search || statusFilter ? '没有匹配的封禁记录' : '暂无已封禁 IP 记录'}</div>
            {!search && !statusFilter && canUnban && (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setCreateIpTouched(false); setCreateOpen(true) }} className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                  + 手动新增封禁
                </button>
                <button type="button" onClick={handleImportClick} className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                  导入 CSV
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-card text-muted-foreground">
                <tr>
                  {canUnban && (
                    <th className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === records.length && records.length > 0}
                        onChange={toggleSelectAll}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </th>
                  )}
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">IP 地址</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">等级</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">状态</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">来源</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">时长 / 过期</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">违规</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">地区</th>
                  <th className="px-4 py-3 text-left font-medium">原因</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, idx) => {
                  const levelMeta = LEVEL_META[r.ban_level] || { label: r.ban_level, cls: 'bg-secondary text-muted-foreground' }
                  const statusMeta = STATUS_META[r.status] || { label: r.status, cls: 'bg-secondary text-muted-foreground' }
                  const isUnblocked = r.status === 'unblocked'
                  const isSelected = selectedIds.has(r.id)
                  return (
                    <tr key={r.id} className={`border-t border-border transition-colors ${isSelected ? 'bg-primary/5' : idx % 2 === 0 ? 'bg-card' : ''} hover:bg-muted`}>
                      {canUnban && (
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(r.id)}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        </td>
                      )}
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="group flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => { setDetailRecord(r); setDetailOpen(true) }}
                            className={`font-mono text-primary hover:underline ${isUnblocked ? 'line-through opacity-60' : ''}`}
                            title="点击查看详情"
                          >
                            {r.ip}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCopyIp(r.ip)}
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                            title="复制 IP"
                          >
                            {copiedIp === r.ip ? (
                              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${levelMeta.cls}`}>{levelMeta.label}</span></td>
                      <td className="px-4 py-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.cls} ${isUnblocked ? 'opacity-70' : ''}`}>{statusMeta.label}</span></td>
                      <td className="px-4 py-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${(SOURCE_META[r.source] || { cls: 'bg-secondary text-muted-foreground' }).cls}`}>{(SOURCE_META[r.source] || { label: r.source || '-' }).label}</span></td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                        <div>{humanizeDuration(r.ban_duration)}</div>
                        {r.ban_duration > 0 && (
                          <div className="text-[10px] text-muted-foreground">{fmtExpiry(r.expired_at)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{r.violation_count ?? 0}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.region || '-'}</td>
                      <td className="max-w-[220px] truncate px-4 py-3 text-muted-foreground" title={r.reason || ''}>{r.reason || '-'}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex gap-1.5">
                          {canUnban && r.status === 'active' && (
                            <button
                              type="button"
                              onClick={() => handleUnban(r)}
                              disabled={deleting}
                              className="flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning transition hover:bg-warning/20"
                              title="解除封禁"
                            >
                              <Unlock className="h-3 w-3" /> 解封
                            </button>
                          )}
                          {canUnban && (
                            <button
                              type="button"
                              onClick={() => handleHardDelete(r)}
                              disabled={unbanning}
                              className="flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive transition hover:bg-destructive/20"
                              title="硬删除：彻底从数据库删除记录（不可恢复）"
                            >
                              <Trash2 className="h-3 w-3" /> 删除
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      <DetailModal
        open={detailOpen}
        record={detailRecord}
        onClose={() => { setDetailOpen(false); setDetailRecord(null) }}
        onUnban={handleUnban}
        onHardDelete={handleHardDelete}
        canUnban={canUnban}
        unbanning={unbanning}
        deleting={deleting}
      />

      {/* 导入结果弹窗 */}
      <Modal
        open={!!importResult}
        title="CSV 导入结果"
        onClose={() => setImportResult(null)}
        maxWidth="max-w-md"
        footer={<button type="button" onClick={() => setImportResult(null)} className="btn-primary btn-sm">确定</button>}
      >
        {importResult && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>导入成功 {importResult.imported || 0} 条</span>
            </div>
            {importResult.skipped > 0 && <div className="flex items-center gap-1.5 text-muted-foreground"><SkipForward className="h-3.5 w-3.5" /> 跳过已存在 {importResult.skipped} 条</div>}
            {importResult.errors?.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-warning"><AlertTriangle className="h-3.5 w-3.5" /> 错误 {importResult.errors.length} 条：</div>
                <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
                  {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 新增封禁弹窗 */}
      <Modal
        open={createOpen}
        title="手动新增封禁 IP"
        onClose={() => setCreateOpen(false)}
        maxWidth="max-w-lg"
        footer={
          <>
            <button type="button" onClick={() => setCreateOpen(false)} className="btn-secondary">取消</button>
            <button type="button" onClick={handleCreate} disabled={creating} className="btn-primary">
              {creating ? '提交中…' : '确认封禁'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">IP 地址 *</label>
              <input
                className={`${inputCls}${createIpTouched && createIpError ? ' !border-destructive ring-1 ring-destructive' : ''}`}
                placeholder="如 1.2.3.4 / 10.0.0.0/8 / 1.2.3.4-1.2.3.20"
                value={createForm.ip}
                onChange={(e) => setCreateForm({ ...createForm, ip: e.target.value })}
                onBlur={() => setCreateIpTouched(true)}
              />
              {createIpTouched && createIpError && (
                <div className="mt-1 text-[11px] text-destructive">{createIpError}</div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">封禁等级</label>
              <CompactSelect
                size="lg"
                block
                value={createForm.ban_level}
                onChange={(e) => setCreateForm({ ...createForm, ban_level: e.target.value })}
              >
                {LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CompactSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">封禁时长（秒，0=永久）</label>
              <input type="number" className={inputCls} placeholder="3600" value={createForm.ban_duration} onChange={(e) => setCreateForm({ ...createForm, ban_duration: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">归属地区</label>
              <input className={inputCls} placeholder="如 中国 北京" value={createForm.region} onChange={(e) => setCreateForm({ ...createForm, region: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">封禁原因</label>
            <textarea className={`${inputCls} min-h-[72px] resize-y`} placeholder="说明封禁原因..." value={createForm.reason} onChange={(e) => setCreateForm({ ...createForm, reason: e.target.value })} />
          </div>
          <div className="flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-xs text-primary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>手动新增的记录将标记为「手动添加」来源，与智能体自动封禁的记录区分。</span>
          </div>
        </div>
      </Modal>

      {/* 导入 CSV 弹窗：选择设备 + 上传文件 */}
      <Modal
        open={importOpen}
        title="导入 CSV 封禁记录"
        onClose={() => setImportOpen(false)}
        maxWidth="max-w-md"
        footer={
          <>
            <button type="button" onClick={() => setImportOpen(false)} className="btn-secondary">取消</button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!importDeviceId || importing}
              className="btn-primary"
            >
              {importing ? '导入中…' : '选择文件并导入'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">执行封禁的设备 *</label>
            <CompactSelect
              size="lg"
              block
              value={importDeviceId}
              onChange={(e) => setImportDeviceId(e.target.value)}
            >
              {devices.length === 0 && <option value="">暂无可用设备</option>}
              {devices.map((d) => (
                <option key={d.id} value={String(d.id)}>{d.name}</option>
              ))}
            </CompactSelect>
            <p className="mt-1 text-[11px] text-muted-foreground">导入的每条 IP 都会调用该设备的 block_ip 动作实际封禁</p>
          </div>
          <div className="flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-xs text-primary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div>CSV 格式与导出一致，第一行为表头（跳过）。</div>
              <div>已存在的 IP 会自动跳过。建议单次导入不超过 50 行。</div>
              <button type="button" onClick={handleDownloadTemplate} className="mt-1 underline hover:no-underline">下载 CSV 模板查看格式</button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default BannedIPsPanel
