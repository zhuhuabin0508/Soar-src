import { useEffect, useState, useCallback, useMemo } from 'react'
import { ClipboardList, BookOpen, Bot, CircleAlert } from 'lucide-react'
import { assetsApi } from '../api/assets'
import { useAuthStore } from '../store/authStore'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { inputCls, inputBaseCls } from '../components/property/FormControls'
import { CompactSelect } from '../components/ui'
import { validateIPExpression, looksLikeIPKey } from '../utils/ipValidation'

// 重要性配色
const CRITICALITY_META = {
  low: { label: '低', cls: 'bg-primary/15 text-primary' },
  medium: { label: '中', cls: 'bg-warning/15 text-warning' },
  high: { label: '高', cls: 'bg-warning/15 text-warning' },
  critical: { label: '严重', cls: 'bg-destructive/20 text-destructive' },
}

// 来源标识配色
const SOURCE_META = {
  kb_ingest: { label: 'KB梳理', cls: 'bg-primary/15 text-primary' },
  agent_add: { label: '对话录入', cls: 'bg-primary/15 text-primary' },
  manual: { label: '手动添加', cls: 'bg-secondary text-muted-foreground' },
}

const CRITICALITY_OPTIONS = [
  { value: '', label: '全部重要性' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '严重' },
]

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'kb_ingest', label: 'KB梳理' },
  { value: 'agent_add', label: '对话录入' },
  { value: 'manual', label: '手动添加' },
]

function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// ============ 详情弹窗 ============
function DetailModal({ open, record, onClose, onEdit, onDelete, canManage, canDelete }) {
  if (!record) return null
  const critMeta = CRITICALITY_META[record.criticality] || {
    label: record.criticality, cls: 'bg-secondary text-muted-foreground',
  }
  const srcMeta = SOURCE_META[record.source] || {
    label: record.source || '-', cls: 'bg-secondary text-muted-foreground',
  }

  const fields = [
    { label: 'IP 地址', value: record.ip || record.identifier || '-', mono: true },
    { label: '资产名称', value: record.name || '-' },
    { label: '资产类型', value: record.asset_type || '-' },
    { label: '重要性', value: critMeta.label, badge: critMeta.cls },
    { label: '来源', value: srcMeta.label, badge: srcMeta.cls },
    { label: '归属部门', value: record.department || '-' },
    { label: '负责人', value: record.owner || '-' },
    { label: '物理位置', value: record.location || '-' },
    { label: '来源知识库', value: record.kb_name || (record.kb_id ? `知识库-${record.kb_id}` : '-') },
    { label: '创建时间', value: fmtTime(record.created_at) },
    { label: '更新时间', value: fmtTime(record.updated_at) },
  ]

  return (
    <Modal
      open={open}
      title={`资产详情：${record.name || record.identifier || ''}`}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">关闭</button>
          {canManage && (
            <button type="button" onClick={() => onEdit(record)} className="btn-primary btn-sm">
              编辑
            </button>
          )}
          {canDelete && (
            <button type="button" onClick={() => onDelete(record)} className="btn-danger btn-sm">
              删除
            </button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {fields.map((f) => (
          <div key={f.label} className="flex flex-col">
            <span className="text-xs text-muted-foreground">{f.label}</span>
            {f.badge ? (
              <span className={`mt-0.5 inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium ${f.badge}`}>
                {f.value}
              </span>
            ) : (
              <span className={`mt-0.5 text-sm text-foreground ${f.mono ? 'font-mono' : ''}`}>
                {f.value}
              </span>
            )}
          </div>
        ))}
      </div>
      {record.extra_fields && Object.keys(record.extra_fields).length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 text-xs text-muted-foreground">灵活字段（extra_fields）</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(record.extra_fields).map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs"
              >
                <span className="text-muted-foreground">{k}:</span>
                <span className="text-foreground">{String(v)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {record.raw_content && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-1 text-xs text-muted-foreground">原始 KB 片段（溯源）</div>
          <pre className="max-h-40 overflow-auto rounded bg-card p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {record.raw_content}
          </pre>
        </div>
      )}
    </Modal>
  )
}

// ============ 新增/编辑弹窗 ============
function AssetFormModal({ open, form, setForm, onSubmit, onClose, submitting, isEdit }) {
  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }))
  const [touched, setTouched] = useState({ ip: false, extra: false })

  useEffect(() => {
    if (open) setTouched({ ip: false, extra: false })
  }, [open])

  // 即时校验：IP 地址（与后端统一规则：IPv4/IPv6、CIDR、范围、通配、多值）
  const ipError = validateIPExpression(form.ip, 'IP 地址')

  // 即时校验：灵活字段 JSON 中 key 形如 ip/cidr 的文本值
  const extraErrors = useMemo(() => {
    const text = (form.extra_fields_text || '').trim()
    if (!text) return []
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return [] // JSON 语法错误由提交时统一提示
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const out = []
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string' && val.trim() && looksLikeIPKey(key)) {
        const msg = validateIPExpression(val, key)
        if (msg) out.push(msg)
      }
    }
    return out
  }, [form.extra_fields_text])

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑资产' : '手动新增资产'}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">取消</button>
          <button type="button" onClick={onSubmit} disabled={submitting} className="btn-primary">
            {submitting ? '保存中...' : '保存'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">IP 地址 * <span className="text-muted-foreground">（作为唯一标识）</span></label>
          <input
            className={`${inputCls}${touched.ip && ipError ? ' border-destructive ring-1 ring-destructive' : ''}`}
            value={form.ip || ''}
            onChange={(e) => set('ip', e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, ip: true }))}
            placeholder="192.0.2.10"
          />
          {touched.ip && ipError && (
            <div className="mt-1 text-[11px] text-destructive">{ipError}</div>
          )}
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">资产名称</label>
          <input className={inputCls} value={form.name || ''}
            onChange={(e) => set('name', e.target.value)} placeholder="展示用名称" />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">资产类型</label>
          <input className={inputCls} value={form.asset_type || ''}
            onChange={(e) => set('asset_type', e.target.value)} placeholder="服务器/工作站/网络设备..." />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">重要性</label>
          <CompactSelect value={form.criticality || 'medium'}
            onChange={(e) => set('criticality', e.target.value)} size="lg" block>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="critical">严重</option>
          </CompactSelect>
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">归属部门</label>
          <input className={inputCls} value={form.department || ''}
            onChange={(e) => set('department', e.target.value)} />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">负责人</label>
          <input className={inputCls} value={form.owner || ''}
            onChange={(e) => set('owner', e.target.value)} />
        </div>
        <div className="flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">物理位置</label>
          <input className={inputCls} value={form.location || ''}
            onChange={(e) => set('location', e.target.value)} />
        </div>
        <div className="col-span-2 flex flex-col">
          <label className="mb-1 text-xs text-muted-foreground">灵活字段（JSON，可选）</label>
          <textarea
            className={`${inputCls} h-20 font-mono${touched.extra && extraErrors.length ? ' border-destructive ring-1 ring-destructive' : ''}`}
            value={form.extra_fields_text || ''}
            onChange={(e) => set('extra_fields_text', e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, extra: true }))}
            placeholder='{"序列号": "SN001", "购入日期": "2024-01-01"}'
          />
          {touched.extra && extraErrors.length > 0 && (
            <div className="mt-1 text-[11px] text-destructive">
              {extraErrors.map((msg) => <div key={msg}>{msg}</div>)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ============ 主页面 ============
function Assets() {
  const user = useAuthStore((s) => s.user)
  const canManage = user?.role === 'admin' || user?.role === 'analyst'
  const canDelete = user?.role === 'admin'

  const [records, setRecords] = useState([])
  const [stats, setStats] = useState({ total: 0, by_source: {}, by_criticality: {}, by_type: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 分页
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  // 过滤条件
  const [keyword, setKeyword] = useState('')
  const [criticalityFilter, setCriticalityFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')

  // 详情弹窗
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRecord, setDetailRecord] = useState(null)

  // 新增/编辑弹窗
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState({})
  const [isEdit, setIsEdit] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 扫描
  const [scanning, setScanning] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 批量导入
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importStrategy, setImportStrategy] = useState('skip')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)

  // 自定义字段管理
  const [cfOpen, setCfOpen] = useState(false)
  const [cfList, setCfList] = useState([])
  const [cfLoading, setCfLoading] = useState(false)
  const [cfForm, setCfForm] = useState({ field_key: '', field_label: '', field_type: 'text', options: '' })
  const [cfSubmitting, setCfSubmitting] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
        keyword,
        criticality: criticalityFilter,
        source: sourceFilter,
      }
      const [listData, st] = await Promise.all([
        assetsApi.list(params),
        assetsApi.stats(),
      ])
      setRecords(listData?.items || [])
      setTotal(listData?.total || 0)
      setTotalPages(listData?.pages || 0)
      setStats(st || { total: 0, by_source: {}, by_criticality: {}, by_type: {} })
      setError('')
    } catch (err) {
      setError(err.message || '加载资产失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, criticalityFilter, sourceFilter])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // 过滤条件变化时回到第一页
  useEffect(() => {
    setPage(1)
  }, [keyword, criticalityFilter, sourceFilter])

  const handleDetail = (record) => {
    setDetailRecord(record)
    setDetailOpen(true)
  }

  const handleCreate = () => {
    setIsEdit(false)
    setForm({
      ip: '',
      name: '',
      asset_type: '',
      department: '',
      owner: '',
      location: '',
      criticality: 'medium',
      extra_fields_text: '',
    })
    setFormOpen(true)
  }

  const handleEdit = (record) => {
    setDetailOpen(false)
    setIsEdit(true)
    setForm({
      id: record.id,
      ip: record.ip || record.identifier || '',
      name: record.name || '',
      asset_type: record.asset_type || '',
      department: record.department || '',
      owner: record.owner || '',
      location: record.location || '',
      criticality: record.criticality || 'medium',
      extra_fields_text: record.extra_fields
        ? JSON.stringify(record.extra_fields, null, 2)
        : '',
    })
    setFormOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.ip?.trim()) {
      toast.warning('请填写 IP 地址（作为资产唯一标识）')
      return
    }
    // IP 格式硬拦截（与后端统一规则）
    const ipMsg = validateIPExpression(form.ip.trim(), 'IP 地址')
    if (ipMsg) {
      toast.error(ipMsg)
      return
    }
    let extraFields = null
    if (form.extra_fields_text?.trim()) {
      try {
        extraFields = JSON.parse(form.extra_fields_text)
      } catch {
        toast.error('灵活字段不是有效的 JSON 格式')
        return
      }
      if (!extraFields || typeof extraFields !== 'object' || Array.isArray(extraFields)) {
        toast.error('灵活字段必须是 JSON 对象')
        return
      }
      // 灵活字段中 key 形如 ip/cidr 的文本值同样拦截
      for (const [key, val] of Object.entries(extraFields)) {
        if (typeof val === 'string' && val.trim() && looksLikeIPKey(key)) {
          const msg = validateIPExpression(val, key)
          if (msg) {
            toast.error(msg)
            return
          }
        }
      }
    }
    setSubmitting(true)
    try {
      const body = {
        ip: form.ip.trim(),
        name: form.name?.trim() || '',
        asset_type: form.asset_type?.trim() || '',
        department: form.department?.trim() || '',
        owner: form.owner?.trim() || '',
        location: form.location?.trim() || '',
        criticality: form.criticality,
        extra_fields: extraFields,
      }
      if (isEdit) {
        await assetsApi.update(form.id, body)
      } else {
        await assetsApi.create(body)
      }
      setFormOpen(false)
      await loadAll()
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (record) => {
    if (!record) return
    const _ok = await confirm({ message: `确定删除资产「${record.name || record.identifier}」吗？此操作不可恢复。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok)
      return
    try {
      await assetsApi.remove(record.id)
      setDetailOpen(false)
      await loadAll()
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await assetsApi.scan()
      toast.success(`扫描任务已提交（任务ID: ${result.task_id}）\n将在后台异步扫描所有资产管理智能体的新知识库。`)
    } catch (err) {
      toast.error(`触发扫描失败：${err.message || err}`)
    } finally {
      setScanning(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      await assetsApi.exportCsv()
    } catch (err) {
      toast.error(`导出失败：${err.message || err}`)
    } finally {
      setExporting(false)
    }
  }

  const openImport = () => {
    setImportFile(null)
    setImportStrategy('skip')
    setImportResult(null)
    setImportOpen(true)
  }

  const handleDownloadTemplate = async () => {
    setDownloadingTemplate(true)
    try {
      await assetsApi.downloadImportTemplate()
    } catch (err) {
      toast.error(`下载模板失败：${err.message || err}`)
    } finally {
      setDownloadingTemplate(false)
    }
  }

  const handleImport = async () => {
    if (!importFile) {
      toast.warning('请选择要导入的文件')
      return
    }
    setImporting(true)
    setImportResult(null)
    try {
      const result = await assetsApi.importAssets(importFile, importStrategy)
      setImportResult(result)
      await loadAll()
    } catch (err) {
      toast.error(`导入失败：${err.message || err}`)
    } finally {
      setImporting(false)
    }
  }

  // ===== 自定义字段管理 =====
  const openCustomFields = async () => {
    setCfOpen(true)
    setCfForm({ field_key: '', field_label: '', field_type: 'text', options: '' })
    await loadCustomFields()
  }

  const loadCustomFields = async () => {
    setCfLoading(true)
    try {
      const list = await assetsApi.listCustomFields()
      setCfList(Array.isArray(list) ? list : [])
    } catch (err) {
      toast.error(`加载自定义字段失败：${err.message || err}`)
    } finally {
      setCfLoading(false)
    }
  }

  const handleCreateCustomField = async () => {
    if (!cfForm.field_key.trim() || !cfForm.field_label.trim()) {
      toast.error('字段键名和显示标签都不能为空')
      return
    }
    if (cfForm.field_type === 'select' && !cfForm.options.trim()) {
      toast.warning('下拉选择类型字段必须填写选项（每行一个）')
      return
    }
    setCfSubmitting(true)
    try {
      const data = {
        field_key: cfForm.field_key.trim(),
        field_label: cfForm.field_label.trim(),
        field_type: cfForm.field_type,
        options: cfForm.field_type === 'select'
          ? cfForm.options.split('\n').map((s) => s.trim()).filter(Boolean)
          : null,
      }
      await assetsApi.createCustomField(data)
      setCfForm({ field_key: '', field_label: '', field_type: 'text', options: '' })
      await loadCustomFields()
    } catch (err) {
      toast.error(`创建失败：${err.message || err}`)
    } finally {
      setCfSubmitting(false)
    }
  }

  const handleDeleteCustomField = async (id, label) => {
    const _ok = await confirm({ message: `确定删除自定义字段「${label}」吗？已录入的该字段值会保留在资产数据中，但不再显示为独立列。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await assetsApi.deleteCustomField(id)
      await loadCustomFields()
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 统计卡片
  const statCards = [
    { key: 'total', label: '资产总数', value: stats.total || 0, icon: <ClipboardList className="h-4 w-4" />, cls: 'text-primary' },
    { key: 'kb_ingest', label: 'KB梳理', value: (stats.by_source || {}).kb_ingest || 0, icon: <BookOpen className="h-4 w-4" />, cls: 'text-primary' },
    { key: 'agent_add', label: '对话录入', value: (stats.by_source || {}).agent_add || 0, icon: <Bot className="h-4 w-4" />, cls: 'text-primary' },
    { key: 'critical', label: '严重资产', value: (stats.by_criticality || {}).critical || 0, icon: <CircleAlert className="h-4 w-4" />, cls: 'text-destructive' },
  ]

  return (
    <div className="flex h-full flex-col">
      {/* 页头 */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">资产管理</h1>
          <span className="text-xs text-muted-foreground">
            共 {total} 条 / 第 {page}/{totalPages || 1} 页
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button type="button" onClick={handleScan} disabled={scanning} className="btn-secondary btn-sm">
              {scanning ? '提交中...' : '扫描新KB'}
            </button>
          )}
          {canManage && (
            <button type="button" onClick={handleCreate} className="btn-primary btn-sm">
              + 新增资产
            </button>
          )}
          {canManage && (
            <button type="button" onClick={openCustomFields} className="btn-secondary btn-sm">
              自定义字段
            </button>
          )}
          <button type="button" onClick={handleExport} disabled={exporting} className="btn-secondary btn-sm">
            {exporting ? '导出中...' : '导出 CSV'}
          </button>
          {canManage && (
            <button type="button" onClick={openImport} className="btn-secondary btn-sm">
              导入
            </button>
          )}
          <button type="button" onClick={loadAll} className="btn-secondary btn-sm">
            刷新
          </button>
        </div>
      </header>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-4">
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

      {/* 过滤栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-6 py-3">
        <input
          className={`${inputBaseCls} max-w-xs`}
          placeholder="搜索名称/IP/负责人..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <CompactSelect value={criticalityFilter}
          onChange={(e) => setCriticalityFilter(e.target.value)} size="lg" block>
          {CRITICALITY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </CompactSelect>
        <CompactSelect value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)} size="lg" block>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </CompactSelect>
      </div>

      {/* 列表区 */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : records.length === 0 ? (
          <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ClipboardList className="h-10 w-10" />
            <div className="text-sm">
              {keyword || criticalityFilter || sourceFilter
                ? '没有匹配的资产记录' : '暂无资产记录，可点击「扫描新KB」或「新增资产」'}
            </div>
          </div>
        ) : (
          <div className="w-full overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-card text-muted-foreground">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">IP</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">名称</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">类型</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">部门</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">负责人</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">重要性</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">来源</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const critMeta = CRITICALITY_META[r.criticality] || { label: r.criticality, cls: 'bg-secondary text-muted-foreground' }
                  const srcMeta = SOURCE_META[r.source] || { label: r.source || '-', cls: 'bg-secondary text-muted-foreground' }
                  return (
                    <tr key={r.id} className="border-t border-border hover:bg-card">
                      <td className="px-4 py-3 font-mono text-foreground">{r.ip || r.identifier}</td>
                      <td className="px-4 py-3 text-foreground">{r.name || '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.asset_type || '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.department || '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.owner || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${critMeta.cls}`}>
                          {critMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${srcMeta.cls}`}>
                          {srcMeta.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <button type="button" onClick={() => handleDetail(r)}
                          className="text-xs text-primary hover:underline">
                          详情
                        </button>
                        {canManage && (
                          <button type="button" onClick={() => handleEdit(r)}
                            className="ml-2 text-xs text-muted-foreground hover:underline">
                            编辑
                          </button>
                        )}
                        {canDelete && (
                          <button type="button" onClick={() => handleDelete(r)}
                            className="ml-2 text-xs text-destructive hover:underline">
                            删除
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn-secondary btn-sm"
            >
              上一页
            </button>
            <span className="text-sm text-muted-foreground">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="btn-secondary btn-sm"
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      <DetailModal
        open={detailOpen}
        record={detailRecord}
        onClose={() => setDetailOpen(false)}
        onEdit={handleEdit}
        onDelete={handleDelete}
        canManage={canManage}
        canDelete={canDelete}
      />

      {/* 新增/编辑弹窗 */}
      <AssetFormModal
        open={formOpen}
        form={form}
        setForm={setForm}
        onSubmit={handleSubmit}
        onClose={() => setFormOpen(false)}
        submitting={submitting}
        isEdit={isEdit}
      />

      {/* 批量导入弹窗 */}
      <Modal
        open={importOpen}
        title="批量导入资产"
        onClose={() => setImportOpen(false)}
        maxWidth="max-w-xl"
        footer={
          <>
            <button type="button" onClick={() => setImportOpen(false)} className="btn-secondary">
              关闭
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || !importFile}
              className="btn-primary"
            >
              {importing ? '导入中...' : '开始导入'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {/* 步骤说明 */}
          <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">导入步骤：</p>
            <ol className="mt-1 list-inside list-decimal space-y-0.5">
              <li>点击「下载模板」获取 CSV 模板（含当前所有自定义字段列）</li>
              <li>在模板中填写资产数据（首行表头勿改，从第二行开始填）</li>
              <li>IP 列支持多种格式：单个 IP、CIDR 网段（如 192.0.2.0/24）、IP 范围（如 198.51.100.1-198.51.100.50 或 203.0.113.1-100），会自动展开为每 IP 一条资产</li>
              <li>选择冲突策略后上传文件</li>
            </ol>
          </div>

          {/* 模板下载 */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              disabled={downloadingTemplate}
              className="btn-secondary btn-sm"
            >
              {downloadingTemplate ? '下载中...' : '下载模板（CSV）'}
            </button>
            <span className="text-xs text-muted-foreground">
              模板含标准字段 + 自定义字段列，支持 .csv / .xlsx / .xls
            </span>
          </div>

          {/* 冲突策略 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              冲突策略（IP 已存在时）
            </label>
            <CompactSelect
              value={importStrategy}
              onChange={(e) => setImportStrategy(e.target.value)}
              size="lg"
              block
            >
              <option value="skip">跳过（保留原数据）</option>
              <option value="overwrite">覆盖（更新已有记录）</option>
              <option value="error">报错中止</option>
            </CompactSelect>
          </div>

          {/* 文件选择 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              选择文件 <span className="text-destructive">*</span>
            </label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setImportFile(e.target.files[0] || null)}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90"
            />
            {importFile && (
              <p className="mt-1 text-xs text-muted-foreground">
                已选择：{importFile.name}（{(importFile.size / 1024).toFixed(1)} KB）
              </p>
            )}
          </div>

          {/* 导入结果 */}
          {importResult && (
            <div className="rounded-md border border-border bg-card p-3">
              <p className="mb-2 text-sm font-medium text-foreground">导入结果</p>
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded bg-muted p-2">
                  <div className="text-lg font-bold text-foreground">{importResult.total}</div>
                  <div className="text-xs text-muted-foreground">总计</div>
                </div>
                <div className="rounded bg-primary/10 p-2">
                  <div className="text-lg font-bold text-primary">{importResult.inserted}</div>
                  <div className="text-xs text-muted-foreground">新增</div>
                </div>
                <div className="rounded bg-warning/10 p-2">
                  <div className="text-lg font-bold text-warning">{importResult.updated}</div>
                  <div className="text-xs text-muted-foreground">更新</div>
                </div>
                <div className="rounded bg-muted p-2">
                  <div className="text-lg font-bold text-muted-foreground">{importResult.skipped}</div>
                  <div className="text-xs text-muted-foreground">跳过</div>
                </div>
              </div>
              {importResult.errors && importResult.errors.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto rounded bg-destructive/10 p-2 text-xs text-destructive">
                  <p className="mb-1 font-medium">错误详情（前 20 条）：</p>
                  {importResult.errors.slice(0, 20).map((e, i) => (
                    <div key={i}>第 {e.row} 行：{e.msg}</div>
                  ))}
                  {importResult.errors.length > 20 && (
                    <div className="mt-1 opacity-70">...还有 {importResult.errors.length - 20} 条错误</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 自定义字段管理弹窗 */}
      <Modal
        open={cfOpen}
        title="自定义字段管理"
        onClose={() => setCfOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <button type="button" onClick={() => setCfOpen(false)} className="btn-secondary">
            关闭
          </button>
        }
      >
        <div className="space-y-4">
          {/* 说明 */}
          <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
            <p>自定义字段是全局共享的扩展字段，所有资产均可使用。</p>
            <p className="mt-1">字段值存储在资产的 extra_fields 中，导出/导入模板会自动包含这些字段列。</p>
          </div>

          {/* 新增字段表单 */}
          <div className="rounded-md border border-border bg-card p-3">
            <p className="mb-3 text-sm font-medium text-foreground">新增字段</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">字段键名（英文）*</label>
                <input
                  className={inputCls}
                  value={cfForm.field_key}
                  onChange={(e) => setCfForm({ ...cfForm, field_key: e.target.value })}
                  placeholder="如 mac_address"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">显示标签（中文）*</label>
                <input
                  className={inputCls}
                  value={cfForm.field_label}
                  onChange={(e) => setCfForm({ ...cfForm, field_label: e.target.value })}
                  placeholder="如 MAC 地址"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">字段类型</label>
                <CompactSelect
                  value={cfForm.field_type}
                  onChange={(e) => setCfForm({ ...cfForm, field_type: e.target.value })}
                  size="lg"
                  block
                >
                  <option value="text">文本</option>
                  <option value="number">数字</option>
                  <option value="date">日期</option>
                  <option value="select">下拉选择</option>
                </CompactSelect>
              </div>
              {cfForm.field_type === 'select' && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">选项（每行一个）*</label>
                  <textarea
                    className={`${inputCls} h-20`}
                    value={cfForm.options}
                    onChange={(e) => setCfForm({ ...cfForm, options: e.target.value })}
                    placeholder={'选项1\n选项2\n选项3'}
                  />
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleCreateCustomField}
                disabled={cfSubmitting}
                className="btn-primary btn-sm"
              >
                {cfSubmitting ? '创建中...' : '+ 添加字段'}
              </button>
            </div>
          </div>

          {/* 已有字段列表 */}
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">已有字段（{cfList.length}）</p>
            {cfLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">加载中...</div>
            ) : cfList.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">暂无自定义字段</div>
            ) : (
              <div className="space-y-2">
                {cfList.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-foreground">{f.field_label}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {f.field_key}
                      </span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                        {f.field_type === 'text' ? '文本' : f.field_type === 'number' ? '数字' : f.field_type === 'date' ? '日期' : '下拉选择'}
                      </span>
                      {f.options && f.options.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          选项：{f.options.join(' / ')}
                        </span>
                      )}
                    </div>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => handleDeleteCustomField(f.id, f.field_label)}
                        className="text-xs text-destructive hover:underline"
                      >
                        删除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default Assets
