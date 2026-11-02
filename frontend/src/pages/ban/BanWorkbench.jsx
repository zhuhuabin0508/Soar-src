// 封禁工作台（已封禁 IP 模块）：状态筛选 + 来源标识 + 手动封禁 + 解封 + 删除（admin）
// + CSV/Excel 导入（仅入库待同步）+ 同步安博通封禁（单条/批量，资产匹配预览后确认）
// + 导出（全部/当前筛选/选中 + 字段选择）
// 详情含封禁方案、智能体研判结论、审批记录、关联告警（点击跳转告警列表按 IP 过滤）
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldBan, ShieldCheck, Search, Inbox, LockOpen, Loader2, RotateCw, ExternalLink, Plus, Trash2,
  Upload, Download, Info, CheckCircle2, AlertTriangle, SkipForward, XCircle,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { confirm } from '../../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, Card, DataTable, Badge, Pagination, CompactSelect } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission, isAdmin, guardNavPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'
import { validateBanTarget } from '../../utils/ipValidation'

const STATUS_OPTIONS = [
  { v: 'pending_sync', label: '待同步' }, { v: 'syncing', label: '同步中' },
  { v: 'active', label: '生效中' },
  { v: 'pending_approval', label: '待审批' }, { v: 'expired', label: '已解封' },
  { v: 'unbanned', label: '已解封' }, { v: 'cancelled', label: '已取消' },
]
const STATUS_VARIANT = {
  active: 'danger', pending_sync: 'warning', syncing: 'warning', pending_approval: 'warning',
  expired: 'neutral', unbanned: 'neutral', cancelled: 'neutral',
}
const LEVEL_LABELS = { critical: '严重', high: '高', medium: '中', low: '低' }
// 封禁来源徽章：自动 / 审批 / 手动 / 聊天 / 工单同步 / 导入
const SOURCE_VARIANT = {
  auto: 'danger', approval: 'warning', manual: 'info', chat: 'neutral', ticket: 'primary', import: 'info',
}
// 封禁时长快捷天数（天；也支持小数自定义输入，如 0.5 = 12 小时）
const DURATION_PRESETS = [1, 7, 30, 90, 365]
// 导出可选字段（与后端 _WB_EXPORT_FIELDS 对应）
const EXPORT_FIELDS = [
  { key: 'ip', label: 'IP地址' }, { key: 'ban_level', label: '封禁等级' },
  { key: 'ban_duration_days', label: '封禁时长(天)' }, { key: 'is_permanent', label: '是否永久' },
  { key: 'reason', label: '封禁原因' }, { key: 'region', label: '归属地区' },
  { key: 'ban_source', label: '封禁方式' }, { key: 'status', label: '当前状态' },
  { key: 'created_at', label: '开始封禁时间' }, { key: 'expire_time', label: '解封时间' },
  { key: 'ban_device', label: '封堵设备' }, { key: 'record_id', label: '封禁工具记录' },
]

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')
// 封禁时长展示（后端存秒；永久封禁直接标记）
const fmtDuration = (seconds, permanent) => {
  if (permanent) return '永久'
  const s = Number(seconds || 0)
  if (!s) return '--'
  const days = s / 86400
  if (days >= 1) return `${Number(days.toFixed(2))} 天`
  return `${Number((s / 3600).toFixed(2))} 小时`
}
// 资产匹配详情字段中文名（与后端 _ASSET_BRIEF_KEYS 对应）
const ASSET_DETAIL_LABELS = {
  resource_type: '资源类型', resource_label: '资源标签', instance_name: '实例名称', inst_name: '实例名称',
  name: '资产名称', hostname: '主机名', cmdb_id: 'CMDB ID', department: '所属部门', owner: '负责人',
  status: '状态', criticality: '重要性', ip: 'IP', identifier: '标识', asset_type: '资产类型',
  os: '操作系统', company: '公司', using_unit: '使用单位', using_dept: '使用部门', tags: '标签',
}
const fmtRemaining = (ms) => {
  if (ms == null) return '--'
  if (ms <= 0) return '已到期'
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分钟`
}
const riskVariant = (level) => (
  { 严重: 'danger', 高危: 'danger', 中危: 'warning', 低危: 'info' }[level] || 'neutral'
)

const fmtSize = (bytes) => {
  const n = Number(bytes || 0)
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// 导入进度条（与资产导入一致：上传百分比 → 服务器解析 → 完成/失败）
function ImportProgressBar({ progress, fileName }) {
  const { phase, percent, loaded, total } = progress
  let icon, label, percentText
  if (phase === 'uploading') {
    icon = <Upload className="h-4 w-4 text-primary" />
    label = `上传中${fileName ? ` · ${fileName}` : ''}${total ? ` · ${fmtSize(loaded)} / ${fmtSize(total)}` : ''}`
    percentText = `${percent}%`
  } else if (phase === 'processing') {
    icon = <Loader2 className="h-4 w-4 animate-spin text-primary" />
    label = '上传完成，服务器正在校验字段并写入待同步记录...'
    percentText = ''
  } else if (phase === 'done') {
    icon = <CheckCircle2 className="h-4 w-4 text-success" />
    label = '导入完成'
    percentText = '100%'
  } else {
    icon = <XCircle className="h-4 w-4 text-destructive" />
    label = '导入失败'
    percentText = ''
  }
  const width = phase === 'uploading' ? `${percent}%` : '100%'
  const barColor = phase === 'done' ? 'bg-success' : phase === 'error' ? 'bg-destructive' : 'bg-primary'
  const isProcessing = phase === 'processing'
  return (
    <div className="rounded-md border border-border bg-muted p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {percentText && <span className="shrink-0 font-medium text-foreground">{percentText}</span>}
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${barColor} ${isProcessing ? 'animate-pulse opacity-80' : ''}`}
          style={{ width }}
        />
        {isProcessing && (
          <div className="animate-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary/40" />
        )}
      </div>
    </div>
  )
}

function DetailSection({ title, data }) {
  if (!data) return null
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-52 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

export default function BanWorkbench({ embedded = false }) {
  const navigate = useNavigate()
  const canEdit = hasPermission('ban_workflow', 'edit')
  const admin = isAdmin()
  const [status, setStatus] = useState('')
  const [ip, setIp] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [list, setList] = useState({ total: 0, items: [] })
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [unbanTarget, setUnbanTarget] = useState(null)
  const [unbanReason, setUnbanReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 手动封禁弹窗
  const [manualOpen, setManualOpen] = useState(false)
  const [manualForm, setManualForm] = useState({
    ip: '', ban_level: 'medium', ban_duration_days: '1', is_permanent: false, reason: '', region: '',
  })
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [manualIpTouched, setManualIpTouched] = useState(false)
  // 即时校验：封禁目标（单 IP / CIDR / 范围 / 多值，不允许通配）
  const manualIpError = validateBanTarget(manualForm.ip, '封禁目标')

  // 选择（批量同步）
  const [selected, setSelected] = useState([])
  // 同步安博通封禁：预览 / 结果
  const [syncPreview, setSyncPreview] = useState(null)
  const [syncPreviewLoading, setSyncPreviewLoading] = useState(false)
  const [syncSubmitting, setSyncSubmitting] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  // 预览请求序号（作废关闭弹窗后返回的旧响应）
  const syncPreviewSeq = useRef(0)
  // 导入（CSV/Excel）
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importError, setImportError] = useState('')
  const [importProgress, setImportProgress] = useState({ phase: 'idle', percent: 0 })
  // 导出
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportScope, setExportScope] = useState('filtered')
  const [exportFields, setExportFields] = useState([])

  const load = useCallback(() => {
    setLoading(true)
    banWorkflowApi.bannedIps({ status, ip, page, page_size: pageSize })
      .then((res) => setList({ total: res.total || 0, items: res.items || [] }))
      .catch((e) => toast.error(e.message || '封禁列表加载失败'))
      .finally(() => setLoading(false))
  }, [status, ip, page, pageSize])

  useEffect(() => { load() }, [load])
  // 筛选/翻页变化后清空选择，避免批量操作误作用于不可见记录
  useEffect(() => { setSelected([]) }, [status, ip, page, pageSize])

  const openDetail = (id) => {
    setDetailLoading(true)
    setDetail({ id })
    banWorkflowApi.bannedIp(id)
      .then(setDetail)
      .catch((e) => { toast.error(e.message || '详情加载失败'); setDetail(null) })
      .finally(() => setDetailLoading(false))
  }

  const doUnban = () => {
    if (!unbanTarget) return
    if (!unbanReason.trim()) {
      toast.error('请填写解封原因')
      return
    }
    setSubmitting(true)
    banWorkflowApi.unbanIp(unbanTarget.id, unbanReason.trim())
      .then(() => {
        toast.success(`IP ${unbanTarget.ip} 已解封`)
        setUnbanTarget(null); setUnbanReason('')
        load()
        if (detail && detail.id === unbanTarget.id) openDetail(detail.id)
      })
      .catch((e) => toast.error(e.message || '解封失败'))
      .finally(() => setSubmitting(false))
  }

  // 手动发起封禁
  const doManualBan = () => {
    if (!manualForm.ip.trim()) { toast.error('请填写目标 IP'); return }
    const ipMsg = validateBanTarget(manualForm.ip, '封禁目标')
    if (ipMsg) { setManualIpTouched(true); toast.error(ipMsg); return }
    if (!manualForm.reason.trim()) { toast.error('请填写封禁原因'); return }
    // Ban duration in days (decimals allowed, e.g. 0.5 = 12h); permanent bans skip duration
    const days = Number(manualForm.ban_duration_days)
    if (!manualForm.is_permanent && (!Number.isFinite(days) || days <= 0)) {
      toast.error('请填写有效的封禁时长（天）')
      return
    }
    setManualSubmitting(true)
    banWorkflowApi.createManualBan({
      ip: manualForm.ip.trim(),
      ban_level: manualForm.ban_level,
      ban_duration: manualForm.is_permanent ? 3600 : Math.max(1, Math.round(days * 86400)),
      is_permanent: manualForm.is_permanent,
      reason: manualForm.reason.trim(),
      region: manualForm.region.trim(),
    })
      .then((rec) => {
        toast.success(`IP ${rec.ip} 已下发封禁（手动封禁）`)
        setManualOpen(false)
        setManualIpTouched(false)
        setManualForm({ ip: '', ban_level: 'medium', ban_duration_days: '1', is_permanent: false, reason: '', region: '' })
        load()
      })
      .catch((e) => toast.error(e.message || '手动封禁失败'))
      .finally(() => setManualSubmitting(false))
  }

  // 删除封禁记录（仅 admin）
  const doDelete = async (r) => {
    const ok = await confirm({
      title: `删除封禁记录 ${r.ip}`,
      message: '生效中且已下发设备的记录会先联动设备解封，解封失败将保留该记录（避免设备侧黑名单残留）；操作将记录审计日志。确定删除？',
      danger: true,
    })
    if (!ok) return
    try {
      await banWorkflowApi.deleteBannedIp(r.id)
      toast.success(`封禁记录 ${r.ip} 已删除`)
      load()
      if (detail && detail.id === r.id) setDetail(null)
    } catch (e) {
      toast.error(e.message || '删除失败')
    }
  }

  // 打开导出弹窗：有选中项时默认导出选中
  const openExport = () => {
    setExportScope(selected.length > 0 ? 'selected' : 'filtered')
    setExportFields([])
    setExportOpen(true)
  }

  // 导出 CSV（admin，支持全部/当前筛选/选中 + 字段选择）
  const doExport = async () => {
    setExporting(true)
    try {
      let params = { fields: exportFields }
      if (exportScope === 'selected') params = { ids: selected, fields: exportFields }
      else if (exportScope === 'filtered') params = { status, ip, fields: exportFields }
      await banWorkflowApi.exportBannedIpsCsv(params)
      toast.success('封禁记录已导出')
      setExportOpen(false)
    } catch (e) {
      toast.error(e.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // 打开导入弹窗（重置进度与结果）
  const openImport = () => {
    setImportFile(null)
    setImportResult(null)
    setImportError('')
    setImportProgress({ phase: 'idle', percent: 0 })
    setImportOpen(true)
  }

  // 导入 CSV/Excel：仅入库待同步，不自动下发
  const doImport = async () => {
    if (!importFile) {
      toast.error('请选择导入文件')
      return
    }
    setImporting(true)
    setImportError('')
    setImportResult(null)
    setImportProgress({ phase: 'uploading', percent: 0 })
    try {
      const result = await banWorkflowApi.importBannedIpsWithProgress(
        importFile,
        (p) => setImportProgress(p),
      )
      setImportResult(result)
      setImportProgress({ phase: 'done', percent: 100 })
      load()
      if (result.imported > 0) {
        toast.success(`已导入 ${result.imported} 条待同步记录，请勾选后同步安博通封禁`)
      } else {
        toast.warning(result.message || '没有可导入的记录，请查看失败原因')
      }
    } catch (err) {
      setImportError(err.message || '导入失败')
      setImportProgress((p) => ({ ...p, phase: 'error' }))
    } finally {
      setImporting(false)
    }
  }

  const doDownloadTemplate = async () => {
    try {
      await banWorkflowApi.downloadBannedIpTemplate()
    } catch (e) {
      toast.error(e.message || '下载模板失败')
    }
  }

  // 同步安博通封禁：先做资产匹配预览，再让用户确认
  const openSyncPreview = async (ids) => {
    const target = Array.from(new Set((ids || []).filter(Boolean)))
    if (!target.length) {
      toast.info('请先选择待同步的记录')
      return
    }
    if (target.length > 200) {
      toast.error('单次最多同步 200 条，请分批操作')
      return
    }
    // 请求序号：关闭弹窗或发起新请求后，旧响应不得再把弹窗重新打开
    const seq = syncPreviewSeq.current + 1
    syncPreviewSeq.current = seq
    setSyncPreview(null)
    setSyncPreviewLoading(true)
    try {
      const res = await banWorkflowApi.syncPreview(target)
      if (syncPreviewSeq.current !== seq) return
      setSyncPreview(res)
    } catch (e) {
      if (syncPreviewSeq.current === seq) toast.error(e.message || '资产匹配预览失败')
    } finally {
      if (syncPreviewSeq.current === seq) setSyncPreviewLoading(false)
    }
  }

  // 关闭预览：同时作废在途请求，避免响应回来后弹窗又弹出
  const closeSyncPreview = () => {
    syncPreviewSeq.current += 1
    setSyncPreview(null)
    setSyncPreviewLoading(false)
  }

  // 确认封禁：仅提交预览中可同步的记录（设备由后端按记录级「封堵设备」解析）
  const doConfirmSync = async () => {
    const ids = (syncPreview?.items || []).filter((it) => it.syncable).map((it) => it.id)
    if (!ids.length) {
      toast.warning('没有可同步的记录')
      return
    }
    setSyncSubmitting(true)
    try {
      const res = await banWorkflowApi.syncBans(ids)
      setSyncPreview(null)
      setSyncResult(res)
      setSelected([])
      load()
      if (res.success > 0) {
        toast.success(`已同步安博通封禁 ${res.success} 条`)
      } else {
        toast.warning('同步失败，请查看结果中的失败原因')
      }
    } catch (e) {
      toast.error(e.message || '同步安博通封禁失败')
    } finally {
      setSyncSubmitting(false)
    }
  }

  const selectedRecords = list.items.filter((r) => selected.includes(r.id))
  const pendingSelected = selectedRecords.filter((r) => r.status === 'pending_sync')

  const columns = [
    {
      key: 'ip', header: 'IP', width: '150px',
      render: (r) => (
        <button className="font-mono text-[13px] font-medium text-foreground transition hover:text-primary" onClick={(e) => { e.stopPropagation(); openDetail(r.id) }}>
          {r.ip}
        </button>
      ),
    },
    { key: 'risk_level', header: '风险等级', width: '90px', render: (r) => <Badge variant={riskVariant(r.risk_level)}>{r.risk_level || '未知'}</Badge> },
    {
      key: 'ban_source', header: '封禁方式', width: '95px',
      render: (r) => <Badge variant={SOURCE_VARIANT[r.ban_source] || 'neutral'}>{r.ban_source_label || r.ban_source || '--'}</Badge>,
    },
    {
      key: 'ban_device', header: '封禁设备', width: '110px',
      render: (r) => <span className="block max-w-[100px] truncate text-muted-foreground" title={r.ban_device}>{r.ban_device || '--'}</span>,
    },
    { key: 'status', header: '当前状态', width: '95px', render: (r) => <Badge variant={STATUS_VARIANT[r.status] || 'neutral'}>{r.status_label}</Badge> },
    { key: 'ban_level', header: '封禁等级', width: '85px', render: (r) => <span>{LEVEL_LABELS[r.ban_level] || r.ban_level || '--'}</span> },
    {
      key: 'ban_duration', header: '封禁时长', width: '100px',
      render: (r) => (
        <span className="font-mono text-[13px] text-muted-foreground">
          {fmtDuration(r.ban_duration, r.is_permanent)}
        </span>
      ),
    },
    {
      key: 'reason', header: '封禁原因', width: '210px',
      render: (r) => <span className="block max-w-[200px] truncate text-muted-foreground" title={r.reason}>{r.reason || '--'}</span>,
    },
    { key: 'created_at', header: '开始封禁时间', width: '150px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{fmtTime(r.created_at)}</span> },
    { key: 'expire_time', header: '解封时间', width: '150px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{r.is_permanent ? '永久' : fmtTime(r.expire_time)}</span> },
    {
      key: 'remaining', header: '剩余时长', width: '100px',
      render: (r) => (
        r.status === 'active'
          ? <span className={`font-mono text-[13px] ${r.remaining_ms != null && r.remaining_ms < 3600000 ? 'text-warning' : ''}`}>{r.is_permanent ? '永久' : fmtRemaining(r.remaining_ms)}</span>
          : <span className="text-muted-foreground">--</span>
      ),
    },
    { key: 'alert_count', header: '关联告警', width: '85px', render: (r) => <span className="tabular-nums">{r.alert_count}</span> },
    {
      key: 'actions', header: '操作', width: canEdit && admin ? '180px' : (canEdit || admin ? '150px' : '70px'),
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-primary" title="详情" onClick={() => openDetail(r.id)}>
            <Search className="h-4 w-4" />
          </button>
          {canEdit && r.status === 'pending_sync' && (
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-warning"
              title="同步安博通封禁（先预览资产匹配）"
              onClick={() => openSyncPreview([r.id])}
            >
              <ShieldCheck className="h-4 w-4" />
            </button>
          )}
          {canEdit && r.status === 'active' && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-success" title="解封" onClick={() => { setUnbanTarget(r); setUnbanReason('') }}>
              <LockOpen className="h-4 w-4" />
            </button>
          )}
          {admin && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-destructive" title="删除（仅管理员）" onClick={() => doDelete(r)}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ]

  const t = detail && detail.id ? detail : null

  // 主体内容（embedded 模式下直接渲染，不套页面容器）
  const content = (
    <>
      {/* 筛选区 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <CompactSelect size="lg" className="w-[130px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            {STATUS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </CompactSelect>
          <input
            className={`${inputBaseCls} h-[34px] w-[220px]`}
            placeholder="IP 关键词"
            value={ip}
            onChange={(e) => { setIp(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === 'Enter') load() }}
          />
          {canEdit && (
            <Button size="sm" variant="primary" onClick={() => { setManualIpTouched(false); setManualOpen(true) }}>
              <Plus className="h-3.5 w-3.5" /> 手动封禁
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={openImport}>
              <Upload className="h-3.5 w-3.5" /> 导入
            </Button>
          )}
          {admin && (
            <Button size="sm" variant="ghost" onClick={openExport} loading={exporting}>
              <Download className="h-3.5 w-3.5" /> 导出
            </Button>
          )}
          {embedded && (
            <Button size="sm" variant="ghost" onClick={load}>
              <RotateCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          )}
          {canEdit && pendingSelected.length > 0 && (
            <div className="ml-auto flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5">
              <span className="text-xs text-muted-foreground">
                已选 {selected.length} 项，其中待同步 <span className="font-medium text-warning">{pendingSelected.length}</span> 条
              </span>
              <Button size="sm" variant="primary" onClick={() => openSyncPreview(pendingSelected.map((r) => r.id))}>
                <ShieldCheck className="h-3.5 w-3.5" /> 同步安博通封禁（{pendingSelected.length}）
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>取消选择</Button>
            </div>
          )}
        </div>
      </Card>

      {/* 封禁表格 */}
      <Card className="p-0" bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={list.items}
          loading={loading}
          rowKey="id"
          selectable={canEdit || admin}
          selectedKeys={selected}
          onSelectChange={setSelected}
          onRowClick={(r) => openDetail(r.id)}
          emptyText="暂无封禁记录"
          emptyDescription="工作流自动封禁、审批通过或导入的 IP 将出现在这里；导入记录需手动同步安博通封禁"
          emptyIcon={Inbox}
        />
        <div className="px-4">
          <Pagination page={page} pageSize={pageSize} total={list.total} onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} pageSizeOptions={[10, 20, 50, 100]} />
        </div>
      </Card>

      {/* 详情抽屉 */}
      <Modal
        open={!!detail}
        size="lg"
        maxWidth="max-w-3xl"
        title={t ? `封禁记录 #${t.id} · ${t.ip}` : '封禁详情'}
        onClose={() => setDetail(null)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>
            {canEdit && t?.status === 'pending_sync' && (
              <Button variant="primary" onClick={() => { const id = t.id; setDetail(null); openSyncPreview([id]) }}>
                <ShieldCheck className="h-4 w-4" /> 同步安博通封禁
              </Button>
            )}
          </>
        )}
      >
        {detailLoading || !t ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-muted p-3 text-sm lg:grid-cols-3">
              <div><span className="text-muted-foreground">状态：</span><Badge variant={STATUS_VARIANT[t.status] || 'neutral'}>{t.status_label}</Badge></div>
              <div><span className="text-muted-foreground">封禁方式：</span><Badge variant={SOURCE_VARIANT[t.ban_source] || 'neutral'}>{t.ban_source_label || t.ban_source || '--'}</Badge></div>
              <div><span className="text-muted-foreground">风险等级：</span><Badge variant={riskVariant(t.risk_level)}>{t.risk_level || '未知'}</Badge></div>
              <div><span className="text-muted-foreground">封禁等级：</span>{LEVEL_LABELS[t.ban_level] || t.ban_level || '--'}</div>
              <div><span className="text-muted-foreground">封禁时长：</span>{fmtDuration(t.ban_duration, t.is_permanent)}</div>
              <div><span className="text-muted-foreground">开始封禁时间：</span><span className="font-mono text-xs">{fmtTime(t.created_at)}</span></div>
              <div><span className="text-muted-foreground">解封时间：</span><span className="font-mono text-xs">{t.is_permanent ? '永久' : fmtTime(t.expire_time)}</span></div>
              <div><span className="text-muted-foreground">封禁设备：</span>{t.ban_device || '--'}</div>
              {t.ticket_id && (
                <div>
                  <span className="text-muted-foreground">来源工单：</span>
                  <button
                    className="inline-flex items-center gap-1 text-primary transition hover:underline"
                    onClick={() => {
                      if (!guardNavPermission('ticket', 'view', '工单详情')) return
                      setDetail(null) // 先关详情弹窗再跳转，保证点击必有反馈
                      navigate(`/tickets/${t.ticket_id}`)
                    }}
                  >
                    <ExternalLink className="h-3 w-3" /> {t.ticket_no || `#${t.ticket_id}`}
                  </button>
                </div>
              )}
              <div><span className="text-muted-foreground">剩余时长：</span>{t.is_permanent ? '永久' : fmtRemaining(t.remaining_ms)}</div>
              <div><span className="text-muted-foreground">封禁工具记录：</span><span className="font-mono text-xs">{t.record_id || '--'}</span></div>
              {t.unban_time && <div><span className="text-muted-foreground">解封时间：</span><span className="font-mono text-xs">{fmtTime(t.unban_time)}</span></div>}
              {t.unban_operator && <div><span className="text-muted-foreground">解封操作人：</span>{t.unban_operator}</div>}
            </div>
            {t.reason && (
              <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">封禁原因：</span>{t.reason}
              </div>
            )}
            {t.unban_reason && (
              <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">解封原因：</span>{t.unban_reason}
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              <DetailSection title="智能体研判结论" data={t.agent_decision} />
              <DetailSection title="审批记录" data={t.approval_ticket ? {
                状态: t.approval_ticket.status_label,
                审批人: t.approval_ticket.approver || '--',
                意见: t.approval_ticket.approval_comment || '--',
                时间: fmtTime(t.approval_ticket.approved_at),
                建议方案: t.approval_ticket.ban_plan,
              } : null} />
            </div>

            {/* 关联告警列表 */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">关联告警（{t.related_alerts?.length || 0}）</span>
                <button
                  className="flex items-center gap-1 text-xs text-primary transition hover:underline"
                  onClick={() => { if (!guardNavPermission('alert', 'view', '告警列表')) return; navigate(`/alerts?keyword=${encodeURIComponent(t.ip)}`) }}
                >
                  <ExternalLink className="h-3 w-3" /> 跳转告警列表
                </button>
              </div>
              {(t.related_alerts || []).length === 0 ? (
                <div className="rounded-lg border border-border bg-muted py-6 text-center text-sm text-muted-foreground">暂无关联告警</div>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {t.related_alerts.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                      <Badge variant={riskVariant(a.risk_level_name)}>{a.risk_level_name || '未知'}</Badge>
                      <span className="min-w-0 flex-1 truncate" title={a.alert_name}>{a.alert_name || '--'}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{fmtTime(a.occur_timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 解封二次确认 */}
      <Modal
        open={!!unbanTarget}
        title={`解封 IP ${unbanTarget?.ip || ''}`}
        onClose={() => { setUnbanTarget(null); setUnbanReason('') }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setUnbanTarget(null); setUnbanReason('') }}>取消</Button>
            <Button variant="primary" loading={submitting} onClick={doUnban}>
              <ShieldBan className="h-4 w-4" /> 确认解封
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          <div>解封后该 IP 恢复访问；已下发设备的记录会先联动设备移除黑名单条目（失败则保留生效中），操作将记录操作人与时间（<span className="text-destructive">原因必填</span>）。</div>
          <textarea
            className={`${inputBaseCls} min-h-[72px] w-full`}
            placeholder="解封原因（必填，如：误报、业务需要、白名单申请等）"
            value={unbanReason}
            onChange={(e) => setUnbanReason(e.target.value)}
          />
        </div>
      </Modal>

      {/* 手动封禁表单 */}
      <Modal
        open={manualOpen}
        title="手动发起封禁"
        onClose={() => setManualOpen(false)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setManualOpen(false)}>取消</Button>
            <Button variant="primary" loading={manualSubmitting} onClick={doManualBan}>
              <ShieldBan className="h-4 w-4" /> 下发封禁
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">目标 IP / CIDR / 范围（必填，可多值）</label>
            <input
              className={`${inputBaseCls} h-[38px] w-full font-mono${manualIpTouched && manualIpError ? ' !border-destructive ring-1 ring-destructive' : ''}`}
              placeholder="如 203.0.113.50 / 10.0.0.0/8 / 1.2.3.4-1.2.3.20"
              value={manualForm.ip}
              onChange={(e) => setManualForm((f) => ({ ...f, ip: e.target.value }))}
              onBlur={() => setManualIpTouched(true)}
            />
            {manualIpTouched && manualIpError && (
              <div className="mt-1 text-[11px] text-destructive">{manualIpError}</div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">封禁等级</label>
              <CompactSelect
                block
                size="lg"
                value={manualForm.ban_level}
                onChange={(e) => setManualForm((f) => ({ ...f, ban_level: e.target.value }))}
              >
                {Object.entries(LEVEL_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </CompactSelect>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">封禁时长（天）</label>
              <input
                type="number"
                min="0.0001"
                step="0.5"
                className={`${inputBaseCls} h-[38px] w-full ${manualForm.is_permanent ? 'opacity-50' : ''}`}
                disabled={manualForm.is_permanent}
                value={manualForm.ban_duration_days}
                onChange={(e) => setManualForm((f) => ({ ...f, ban_duration_days: e.target.value }))}
              />
              {/* 快捷天数（点击填入，仍可手动输入任意天数/小数） */}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {DURATION_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={manualForm.is_permanent}
                    onClick={() => setManualForm((f) => ({ ...f, ban_duration_days: String(d) }))}
                    className={`rounded border px-1.5 py-0.5 text-[11px] transition disabled:opacity-50 ${
                      Number(manualForm.ban_duration_days) === d
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {d}天
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">支持小数：0.5 天 = 12 小时</div>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={manualForm.is_permanent}
              onChange={(e) => setManualForm((f) => ({ ...f, is_permanent: e.target.checked }))}
            />
            永久封禁（不自动解封）
          </label>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">封禁原因（必填）</label>
            <textarea
              className={`${inputBaseCls} min-h-[72px] w-full`}
              placeholder="如：威胁情报确认恶意IP、人工研判攻击源等"
              value={manualForm.reason}
              onChange={(e) => setManualForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">归属地区（可选）</label>
            <input
              className={`${inputBaseCls} h-[38px] w-full`}
              placeholder="如 美国 / 中国上海"
              value={manualForm.region}
              onChange={(e) => setManualForm((f) => ({ ...f, region: e.target.value }))}
            />
          </div>
          <div className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            将通过默认「安博通阻断器」下发设备封禁，记录标记为「手动封禁」，到期由定时任务联动设备自动解封。
          </div>
        </div>
      </Modal>
      {/* 导入封禁记录（CSV/Excel）：逐行校验字段，仅入库为「待同步」，不自动下发 */}
      <Modal
        open={importOpen}
        title="导入封禁记录"
        maxWidth="max-w-2xl"
        onClose={() => { if (!importing) setImportOpen(false) }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importing}>
              {importResult ? '关闭' : '取消'}
            </Button>
            <Button variant="primary" loading={importing} disabled={!importFile || importing} onClick={doImport}>
              <Upload className="h-4 w-4" /> 开始导入
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5 text-xs text-primary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-0.5">
              <div>
                支持 .csv / .xlsx / .xls；必需列：
                <span className="font-medium">IP地址、封禁原因</span>。
                可选列：封禁等级、封禁时长(天)、是否永久、归属地区、
                <span className="font-medium">封堵设备</span>（留空使用默认安博通阻断器）。
              </div>
              <div>
                导入后记录为「待同步」，<span className="font-medium">不会自动下发安博通</span>；
                请勾选后点击「同步安博通封禁」。
              </div>
              <div>字段不合法、文件内重复或已在封禁中的行会计入失败/跳过，并在下方列出原因。</div>
              <button type="button" onClick={doDownloadTemplate} className="mt-1 underline hover:no-underline">
                下载导入模板查看格式
              </button>
            </div>
          </div>

          {/* 文件选择 */}
          <div className="rounded-lg border border-dashed border-border bg-muted/50 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent">
                <Upload className="h-3.5 w-3.5" /> 选择文件
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onClick={(e) => { e.target.value = '' }}
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] || null)
                    setImportResult(null)
                    setImportError('')
                    setImportProgress({ phase: 'idle', percent: 0 })
                  }}
                />
              </label>
              {importFile ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={importFile.name}>
                  {importFile.name} · {fmtSize(importFile.size)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">未选择文件</span>
              )}
            </div>
          </div>

          {importProgress.phase !== 'idle' && (
            <ImportProgressBar progress={importProgress} fileName={importFile?.name} />
          )}

          {importError && (
            <div className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{importError}</span>
            </div>
          )}

          {importResult && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: '总计', value: importResult.total ?? 0, tone: 'text-foreground' },
                  { label: '成功', value: importResult.imported ?? 0, tone: 'text-success' },
                  { label: '失败', value: importResult.failed ?? 0, tone: 'text-destructive' },
                  { label: '跳过', value: importResult.skipped ?? 0, tone: 'text-warning' },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-border bg-muted px-2 py-1.5 text-center">
                    <div className={`text-base font-semibold ${s.tone}`}>{s.value}</div>
                    <div className="text-[11px] text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>

              {importResult.imported > 0 && (
                <div className="flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>已入库为「待同步」{importResult.imported} 条，勾选记录即可同步安博通封禁。</span>
                </div>
              )}

              {importResult.errors?.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" /> 失败 {importResult.failed} 条
                    {importResult.errors_truncated && (
                      <span className="font-normal">（仅显示前 {importResult.errors.length} 条）</span>
                    )}
                  </div>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {importResult.errors.map((e, i) => (
                      <li key={`err-${i}`} className="break-all">
                        第 {e.row} 行{e.ip ? ` · ${e.ip}` : ''}：{e.msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {importResult.skipped_items?.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-warning">
                    <SkipForward className="h-3.5 w-3.5" /> 跳过 {importResult.skipped} 条
                    {importResult.skipped_truncated && (
                      <span className="font-normal">（仅显示前 {importResult.skipped_items.length} 条）</span>
                    )}
                  </div>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {importResult.skipped_items.map((e, i) => (
                      <li key={`skip-${i}`} className="break-all">
                        第 {e.row} 行{e.ip ? ` · ${e.ip}` : ''}：{e.msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {importResult.unknown_headers?.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  未识别的表头（已忽略）：{importResult.unknown_headers.join('、')}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 同步安博通封禁：资产匹配预览 + 用户确认后下发 */}
      <Modal
        open={syncPreviewLoading || !!syncPreview}
        title="同步安博通封禁"
        size="lg"
        maxWidth="max-w-4xl"
        onClose={() => {
          if (syncSubmitting) return
          closeSyncPreview()
        }}
        footer={syncPreviewLoading ? (
          <Button variant="ghost" onClick={closeSyncPreview}>取消</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={closeSyncPreview} disabled={syncSubmitting}>取消</Button>
            <Button
              variant="primary"
              loading={syncSubmitting}
              disabled={!syncPreview || !syncPreview.syncable}
              onClick={doConfirmSync}
            >
              <ShieldCheck className="h-4 w-4" /> 确认封禁（{syncPreview?.syncable ?? 0}）
            </Button>
          </>
        )}
      >
        {syncPreviewLoading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span>正在匹配资产并校验待封禁 IP...</span>
          </div>
        ) : syncPreview && (
          <div className="space-y-3 text-sm">
            {syncPreview.device_error ? (
              <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-all">
                  默认封堵设备不可用：{syncPreview.device_error}
                  （未指定「封堵设备」的记录将无法同步）
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs text-success">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  默认执行设备：{syncPreview.device?.name || '安博通阻断器'}
                  （动作：封禁 IP）；未指定「封堵设备」的记录使用默认设备，已指定则按记录中的设备下发。
                </span>
              </div>
            )}

            <div className="grid grid-cols-5 gap-2">
              {[
                { label: '待处理', value: syncPreview.total ?? 0, tone: 'text-foreground' },
                { label: '资产匹配', value: syncPreview.matched ?? 0, tone: 'text-info' },
                { label: '未匹配', value: syncPreview.unmatched ?? 0, tone: 'text-warning' },
                { label: '可同步', value: syncPreview.syncable ?? 0, tone: 'text-success' },
                { label: '不可同步', value: syncPreview.blocked ?? 0, tone: 'text-destructive' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-muted px-2 py-1.5 text-center">
                  <div className={`text-base font-semibold ${s.tone}`}>{s.value}</div>
                  <div className="text-[11px] text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              已按工单资产匹配逻辑匹配资产（资产发现优先，其次资产清单）。
              未匹配到资产的 IP 仍可封禁，请确认匹配结果后再点击「确认封禁」。
            </div>

            <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
              {syncPreview.items.map((it) => (
                <div
                  key={it.id}
                  className={`rounded-lg border px-3 py-2.5 ${it.syncable ? 'border-border bg-card' : 'border-warning/40 bg-warning/5'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-foreground">{it.ip || `#${it.id}`}</span>
                    {it.status_label && (
                      <Badge variant={STATUS_VARIANT[it.status] || 'neutral'}>{it.status_label}</Badge>
                    )}
                    {it.ban_level_label && (
                      <Badge variant={it.ban_level === 'critical' || it.ban_level === 'high' ? 'danger' : it.ban_level === 'medium' ? 'warning' : 'info'}>
                        {it.ban_level_label}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{fmtDuration(it.ban_duration, it.is_permanent)}</span>
                    <span className="text-xs text-muted-foreground">
                      封堵设备：{it.device_name || '默认'}
                    </span>
                    {!it.syncable && <Badge variant="warning">不可同步</Badge>}
                  </div>
                  {it.reason && (
                    <div className="mt-1 break-all text-xs text-muted-foreground">原因：{it.reason}</div>
                  )}
                  <div className="mt-1.5">
                    {it.asset_match?.matched ? (
                      <div className="space-y-1">
                        {(it.asset_match.assets || []).map((a, i) => (
                          <div key={i} className="rounded-md border border-border bg-muted/60 px-2 py-1.5">
                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <Badge variant="info">{a.source_label}</Badge>
                              <span className="font-medium text-foreground">{a.asset_name || '--'}</span>
                              <span className="font-mono text-muted-foreground">{a.asset_ip}</span>
                            </div>
                            {Object.keys(a.details || {}).length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                                {Object.entries(a.details).slice(0, 10).map(([k, v]) => (
                                  <span key={k} className="break-all">{ASSET_DETAIL_LABELS[k] || k}：{v}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-warning">未匹配到资产（仍可继续封禁）</span>
                    )}
                    {it.asset_match?.error && (
                      <div className="mt-1 text-[11px] text-destructive">{it.asset_match.error}</div>
                    )}
                  </div>
                  {it.message && (
                    <div className="mt-1 flex items-start gap-1 text-[11px] text-warning">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{it.message}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* 同步结果：成功 / 失败 / 跳过及原因 */}
      <Modal
        open={!!syncResult}
        title="同步安博通封禁结果"
        maxWidth="max-w-2xl"
        onClose={() => setSyncResult(null)}
        footer={<Button variant="primary" onClick={() => setSyncResult(null)}>确定</Button>}
      >
        {syncResult && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: '成功', value: syncResult.success ?? 0, tone: 'text-success' },
                { label: '失败', value: syncResult.failed ?? 0, tone: 'text-destructive' },
                { label: '跳过', value: syncResult.skipped ?? 0, tone: 'text-warning' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-muted px-2 py-1.5 text-center">
                  <div className={`text-base font-semibold ${s.tone}`}>{s.value}</div>
                  <div className="text-[11px] text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            {syncResult.device_error && (
              <div className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-all">{syncResult.device_error}</span>
              </div>
            )}

            <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
              {(syncResult.items || []).map((it) => (
                <div
                  key={it.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                >
                  {it.success ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : it.skipped ? (
                    <SkipForward className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  )}
                  <span className="w-32 shrink-0 font-mono text-foreground">{it.ip || `#${it.id}`}</span>
                  <span className="min-w-0 flex-1 break-all text-muted-foreground">{it.message || '--'}</span>
                  {it.success && <span className="shrink-0 text-success">已下发</span>}
                  {!it.success && !it.skipped && <span className="shrink-0 text-destructive">失败</span>}
                  {it.skipped && <span className="shrink-0 text-warning">跳过</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* 导出：范围选择 + 字段选择 */}
      <Modal
        open={exportOpen}
        title="导出封禁记录"
        maxWidth="max-w-lg"
        onClose={() => setExportOpen(false)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)} disabled={exporting}>取消</Button>
            <Button
              variant="primary"
              loading={exporting}
              disabled={exportScope === 'selected' && selected.length === 0}
              onClick={doExport}
            >
              <Download className="h-4 w-4" /> 开始导出
            </Button>
          </>
        )}
      >
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">导出范围</div>
            <div className="space-y-1.5">
              {[
                {
                  v: 'filtered',
                  label: status || ip ? '当前筛选结果（应用筛选条件）' : '当前筛选结果（未设置筛选，等同全部记录）',
                },
                {
                  v: 'selected',
                  label: selected.length ? `仅选中项（${selected.length} 条）` : '仅选中项（未选择）',
                  disabled: selected.length === 0,
                },
                { v: 'all', label: '全部记录（忽略筛选）' },
              ].map((o) => (
                <label
                  key={o.v}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${
                    exportScope === o.v
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border text-foreground hover:bg-accent'
                  } ${o.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="ban-export-scope"
                    className="h-3.5 w-3.5 accent-primary"
                    value={o.v}
                    checked={exportScope === o.v}
                    disabled={o.disabled}
                    onChange={() => setExportScope(o.v)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">导出字段（不选则导出全部字段）</span>
              <div className="flex gap-2 text-[11px]">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setExportFields(EXPORT_FIELDS.map((f) => f.key))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:underline"
                  onClick={() => setExportFields([])}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-2">
              {EXPORT_FIELDS.map((f) => (
                <label key={f.key} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={exportFields.includes(f.key)}
                    onChange={(e) => setExportFields((prev) => (
                      e.target.checked ? [...prev, f.key] : prev.filter((k) => k !== f.key)
                    ))}
                  />
                  <span className="text-foreground">{f.label}</span>
                </label>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              导出为 CSV（UTF-8 BOM），可直接用 Excel 打开；封禁时长按天。
            </div>
          </div>
        </div>
      </Modal>
    </>
  )

  if (embedded) return content
  return (
    <PageContainer>
      <PageHeader
        title="封禁工作台"
        description="自动封禁与审批封禁的 IP 记录：到期自动解封（每分钟扫描），手动解封需填写原因并记录操作人"
        actions={(
          <Button size="sm" variant="ghost" onClick={load}>
            <RotateCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        )}
      />
      {content}
    </PageContainer>
  )
}
