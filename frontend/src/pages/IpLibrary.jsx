// IP地址库：概览统计 + 查询为主（不做全量列表浏览）
// - 概览：4 库卡片（网段数 / 覆盖 IP 数 / 最近导入）
// - 查询：单输入框智能识别 IP / 网段 / 关键词，高级筛选（库/国家/运营商/省份）
// - 结果：命中网段列表分页（50/页），行点击看全字段详情
// - 导入：CSV 上传 → Celery 异步任务 → 轮询批次进度；批次历史 Drawer
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Database, Download, Globe2, History, Loader2, RefreshCw, Search,
  SlidersHorizontal, Upload, X,
} from 'lucide-react'
import { ipLibraryApi } from '../api/ipLibrary'
import { toast } from '../store/toastStore'
import {
  PageContainer, PageHeader, Button, Card, DataTable, Pagination,
} from '../components/ui'
import { Modal, Drawer } from '../components/Dialog'
import { inputCls } from '../components/property/FormControls'
import { hasPermission } from '../utils/permissions'

// 库徽标配色（概览卡片 / 结果表 / 查询结果共用）
const LIB_THEME = {
  cloud_cn: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  geo_cn: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  holder_cn: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  overseas: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}
const LIB_ICON = { cloud_cn: Globe2, geo_cn: Database, holder_cn: Database, overseas: Globe2 }

// 全库联合查询时的结果列（从 14 个业务列中取安全运营最关心的子集）
const MERGED_COLS = [
  { key: 'isp', header: '运营商/云服务商' },
  { key: 'cloud_provider', header: '云服务商' },
  { key: 'country_geo', header: '国家地区' },
  { key: 'province', header: '省份' },
  { key: 'city', header: '城市' },
  { key: 'holder_name', header: '注册持有者' },
  { key: 'reg_status', header: '登记状态' },
]

// 批次状态 → 中文 + 颜色点
const BATCH_STATUS = {
  pending: { label: '排队中', cls: 'bg-muted-foreground' },
  running: { label: '导入中', cls: 'bg-sky-500 animate-pulse' },
  success: { label: '成功', cls: 'bg-emerald-500' },
  failed: { label: '失败', cls: 'bg-red-500' },
}
const PHASE_LABEL = { parsing: '解析 CSV', importing: '写入数据库', finalizing: '收尾清理' }

function fmtInt(n) {
  return (n ?? 0).toLocaleString('en-US')
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtSize(n) {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function cellOrDash(key) {
  return (row) => row[key] || '—'
}

function LibBadge({ type, label }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${LIB_THEME[type] || 'bg-muted text-muted-foreground'}`}>
      {label}
    </span>
  )
}

// ============================================================================
// 概览统计卡片
// ============================================================================
function LibraryCard({ lib }) {
  const Icon = LIB_ICON[lib.library_type] || Database
  const last = lib.last_batch
  const lastStatus = BATCH_STATUS[last?.status]
  return (
    <Card className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${LIB_THEME[lib.library_type] || ''}`}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="truncate text-sm font-semibold text-foreground">{lib.label}</div>
        </div>
      </div>
      <div className="mt-3 flex items-end gap-6">
        <div>
          <div className="text-xs text-muted-foreground">网段数</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{fmtInt(lib.segment_count)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">覆盖 IP 数</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{fmtInt(lib.covered_ips)}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        <span className="truncate">
          {last
            ? `最近导入：${fmtTime(last.created_at)}`
            : '尚未导入'}
        </span>
        {last && lastStatus && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${lastStatus.cls}`} />
            {lastStatus.label}
          </span>
        )}
      </div>
    </Card>
  )
}

// ============================================================================
// 导入 Modal（上传 → Celery 异步 → 轮询批次进度）
// ============================================================================
function ImportModal({ open, libraries, onClose, onFinish }) {
  const [lib, setLib] = useState('cloud_cn')
  const [mode, setMode] = useState('full')
  const [file, setFile] = useState(null)
  const [fileError, setFileError] = useState('')
  // stage: pick 选择文件 / uploading 上传中 / running 后台导入中 / success / failed
  const [stage, setStage] = useState('pick')
  const [progress, setProgress] = useState({ percent: 0, phase: '', note: '', batch: null })
  const [error, setError] = useState('')
  const pollRef = useRef(null)
  const pickRef = useRef(null)
  const canImport = hasPermission('ip_library', 'edit')

  useEffect(() => {
    if (open) {
      setLib('cloud_cn')
      setMode('full')
      setFile(null)
      setFileError('')
      setStage('pick')
      setProgress({ percent: 0, phase: '', note: '', batch: null })
      setError('')
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [open])

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const startPoll = (batchId) => {
    stopPoll()
    pollRef.current = setInterval(async () => {
      try {
        const b = await ipLibraryApi.batch(batchId)
        setProgress({ percent: b.percent, phase: b.phase, note: b.note, batch: b })
        if (b.status === 'success') {
          stopPoll()
          setStage('success')
          onFinish()
        } else if (b.status === 'failed') {
          stopPoll()
          setStage('failed')
        }
      } catch { /* 单次轮询失败忽略，下次重试 */ }
    }, 1500)
  }

  function validateAndSet(f) {
    if (!f) return
    if (!(f.name || '').toLowerCase().endsWith('.csv')) {
      setFileError('仅支持 .csv 文件（数据源导出格式）')
      setFile(null)
      return
    }
    setFileError('')
    setFile(f)
  }

  async function handleConfirm() {
    if (!file) return
    setError('')
    setStage('uploading')
    try {
      const { batch_id: batchId } = await ipLibraryApi.importCsv(file, lib, mode)
      setStage('running')
      startPoll(batchId)
    } catch (e) {
      setError(e.message || '上传失败')
      setStage('pick')
    }
  }

  const busy = stage === 'uploading' || stage === 'running'
  const libLabel = libraries.find((l) => l.library_type === lib)?.label || lib

  return (
    <Modal
      open={open}
      title="导入 IP 地址库 CSV"
      onClose={busy ? undefined : onClose}
      size="md"
      footer={
        <>
          {(stage === 'success' || stage === 'failed') && (
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          )}
          {stage === 'pick' && (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
              <Button variant="primary" size="sm" disabled={!file} onClick={handleConfirm}>
                <Upload className="h-4 w-4" /> 开始导入
              </Button>
            </>
          )}
        </>
      }
    >
      {!canImport && <div className="text-sm text-muted-foreground">无导入权限（需要 IP地址库 编辑权限）</div>}
      {canImport && stage === 'pick' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">目标库</span>
              <select className={inputCls} value={lib} onChange={(e) => setLib(e.target.value)}>
                {libraries.map((l) => (
                  <option key={l.library_type} value={l.library_type}>{l.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">导入模式</span>
              <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="full">全量对齐（删除文件外旧记录）</option>
                <option value="incremental">增量更新（仅新增/更新）</option>
              </select>
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">CSV 文件（首行中文表头）</span>
            {!file ? (
              <button
                type="button"
                onClick={() => pickRef.current?.click()}
                className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Upload className="h-6 w-6" />
                <span className="text-sm">点击选择 .csv 文件</span>
              </button>
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{file.name}</div>
                  <div className="text-xs text-muted-foreground">{fmtSize(file.size)}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setFile(null); pickRef.current?.click() }}>重选</Button>
              </div>
            )}
            <input ref={pickRef} type="file" accept=".csv" className="hidden" onChange={(e) => validateAndSet(e.target.files?.[0])} />
            {fileError && <div className="mt-1.5 text-xs text-red-500">{fileError}</div>}
          </div>
        </div>
      )}
      {busy && (
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {stage === 'uploading' ? '正在上传文件…' : (
              `${PHASE_LABEL[progress.phase] || '处理中'}…（${progress.percent}%）`
            )}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full bg-primary transition-all duration-500 ${stage === 'uploading' ? 'animate-pulse' : ''}`}
              style={{ width: `${stage === 'uploading' ? 8 : Math.max(progress.percent, 3)}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            后台异步执行中，可关闭此窗口继续其他操作，进度可在「批次历史」中查看。
          </div>
        </div>
      )}
      {stage === 'success' && progress.batch && (
        <div className="space-y-2 py-2 text-sm">
          <div className="font-medium text-emerald-600 dark:text-emerald-400">
            导入完成：{libLabel} · {(progress.batch.duration_ms / 1000).toFixed(1)}s
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground xsm:grid-cols-3">
            <span>CSV 行数 {fmtInt(progress.batch.csv_rows)}</span>
            <span>唯一网段 {fmtInt(progress.batch.unique_cidrs)}</span>
            <span>新增 {fmtInt(progress.batch.inserted)}</span>
            <span>更新 {fmtInt(progress.batch.updated)}</span>
            <span>删除 {fmtInt(progress.batch.deleted)}</span>
            <span>跳过 {fmtInt(progress.batch.skipped)}</span>
          </div>
          {progress.note && <div className="text-xs text-muted-foreground">{progress.note}</div>}
        </div>
      )}
      {stage === 'failed' && (
        <div className="py-2 text-sm">
          <div className="font-medium text-red-500">导入失败</div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{progress.note || error || '未知原因'}</div>
        </div>
      )}
    </Modal>
  )
}

// ============================================================================
// 批次历史 Drawer
// ============================================================================
function BatchDrawer({ open, onClose, libraries }) {
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(false)
  const libLabel = (t) => libraries.find((l) => l.library_type === t)?.label || t

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ipLibraryApi.batches('', 50)
      setBatches(data.items || [])
    } catch (e) {
      toast.error(e.message || '批次历史加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  return (
    <Drawer
      open={open}
      title="导入批次历史"
      onClose={onClose}
      width="w-[560px]"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>}
    >
      <div className="mb-3 flex justify-end">
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 刷新
        </Button>
      </div>
      {batches.length === 0 && !loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">暂无导入批次</div>
      ) : (
        <div className="space-y-3">
          {batches.map((b) => {
            const st = BATCH_STATUS[b.status] || BATCH_STATUS.pending
            return (
              <div key={b.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.cls}`} />
                    <span className="truncate font-medium text-foreground">{libLabel(b.library_type)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{b.import_mode === 'full' ? '全量' : '增量'}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtTime(b.created_at)}</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground" title={b.filename}>{b.filename}</div>
                {b.status === 'success' || b.status === 'failed' ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs tabular-nums text-muted-foreground">
                    <span>行数 {fmtInt(b.csv_rows)}</span>
                    <span>新增 {fmtInt(b.inserted)}</span>
                    <span>更新 {fmtInt(b.updated)}</span>
                    <span>删除 {fmtInt(b.deleted)}</span>
                    <span>现有 {fmtInt(b.live_count)}</span>
                    <span>{(b.duration_ms / 1000).toFixed(1)}s</span>
                  </div>
                ) : (
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    {PHASE_LABEL[b.phase] || '排队中'} {b.percent}%
                  </div>
                )}
                {b.note && (
                  <div className="mt-1.5 break-all border-t border-border/50 pt-1.5 text-xs text-muted-foreground">{b.note}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Drawer>
  )
}

// ============================================================================
// 主页面
// ============================================================================
export default function IpLibrary() {
  const [meta, setMeta] = useState({ libraries: [], attr_labels: {} })
  const [metaLoading, setMetaLoading] = useState(false)

  // 查询条件
  const [q, setQ] = useState('')
  const [libFilter, setLibFilter] = useState('')
  const [country, setCountry] = useState('')
  const [isp, setIsp] = useState('')
  const [province, setProvince] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // 查询结果
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [detail, setDetail] = useState(null)

  const [importOpen, setImportOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const canImport = hasPermission('ip_library', 'edit')

  const loadMeta = useCallback(async () => {
    setMetaLoading(true)
    try {
      setMeta(await ipLibraryApi.meta())
    } catch (e) {
      toast.error(e.message || '概览加载失败')
    } finally {
      setMetaLoading(false)
    }
  }, [])

  useEffect(() => { loadMeta() }, [loadMeta])

  const buildParams = useCallback((pageOverride) => ({
    library_type: libFilter,
    q: q.trim(),
    country: country.trim(),
    isp: isp.trim(),
    province: province.trim(),
    page: pageOverride ?? page,
    page_size: pageSize,
  }), [libFilter, q, country, isp, province, page, pageSize])

  const runQuery = useCallback(async (pageOverride) => {
    const params = buildParams(pageOverride)
    if (!params.q && !params.country && !params.isp && !params.province) {
      toast.error('请输入 IP / 网段 / 关键词，或设置筛选条件')
      return
    }
    setLoading(true)
    if (pageOverride != null) setPage(pageOverride)
    try {
      const data = await ipLibraryApi.list(params)
      setRows(data.items || [])
      setTotal(data.total || 0)
      setSearched(true)
    } catch (e) {
      toast.error(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  const handleSearch = () => { setPage(1); runQuery(1) }

  const handleExport = async () => {
    const params = buildParams()
    if (!params.q && !params.country && !params.isp && !params.province) {
      toast.error('导出需要至少一个查询条件')
      return
    }
    try {
      await ipLibraryApi.exportCsv(params, 'ip_library')
      toast.success('导出已开始下载')
    } catch (e) {
      toast.error(e.message || '导出失败')
    }
  }

  const advancedDirty = !!(country || isp || province)

  // 结果表列：单库 = 该库全部字段；全库 = 安全运营常用子集
  const resultColumns = useMemo(() => {
    const libBadgeCol = {
      key: 'library_type', header: '库', width: 170,
      render: (row) => (
        <LibBadge
          type={row.library_type}
          label={meta.libraries.find((l) => l.library_type === row.library_type)?.label || row.library_type}
        />
      ),
    }
    const cidrCol = {
      key: 'cidr', header: '网段', width: 145, className: 'font-medium tabular-nums',
    }
    if (libFilter) {
      const fields = meta.libraries.find((l) => l.library_type === libFilter)?.fields || []
      return [libBadgeCol, cidrCol, ...fields.map((f) => ({
        key: f.key, header: f.label, render: cellOrDash(f.key),
      }))]
    }
    return [libBadgeCol, cidrCol, ...MERGED_COLS.map((c) => ({ ...c, render: cellOrDash(c.key) }))]
  }, [libFilter, meta])

  // 详情抽屉：按行所属库展示全部字段
  const detailFields = useMemo(() => {
    if (!detail) return []
    const lib = meta.libraries.find((l) => l.library_type === detail.library_type)
    return lib?.fields || []
  }, [detail, meta])

  return (
    <PageContainer>
      <PageHeader
        title="IP地址库"
        description="中国大陆云服务 / APNIC 运营商地理 / APNIC 注册持有者 / 境外 IPv4 网段数据：支持 IP 精确归属、网段与关键词查询"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={loadMeta} disabled={metaLoading}>
              {metaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setBatchOpen(true)}>
              <History className="h-4 w-4" /> 批次历史
            </Button>
            {canImport && (
              <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" /> 导入 CSV
              </Button>
            )}
          </>
        }
      />

      {/* 概览统计卡片 */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {meta.libraries.map((lib) => <LibraryCard key={lib.library_type} lib={lib} />)}
      </div>

      {/* 查询区 + 结果区 */}
      <Card className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[280px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${inputCls} pl-9`}
              placeholder="输入 IP（如 1.2.3.4）/ 网段（如 8.8.8.0/24）/ 关键词（运营商、持有者、国家、省市）"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
            <SlidersHorizontal className="h-4 w-4" /> 筛选
            {advancedDirty && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" />}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSearch} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} 查询
          </Button>
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={!searched || loading}>
            <Download className="h-4 w-4" /> 导出结果
          </Button>
        </div>

        {showAdvanced && (
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border/60 pt-3 md:grid-cols-4">
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">库</span>
              <select className={inputCls} value={libFilter} onChange={(e) => setLibFilter(e.target.value)}>
                <option value="">全部库</option>
                {meta.libraries.map((l) => (
                  <option key={l.library_type} value={l.library_type}>{l.label}</option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">国家地区</span>
              <input className={inputCls} placeholder="如：Japan" value={country} onChange={(e) => setCountry(e.target.value)} />
            </label>
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">运营商</span>
              <input className={inputCls} placeholder="如：中国电信" value={isp} onChange={(e) => setIsp(e.target.value)} />
            </label>
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">省份</span>
              <input className={inputCls} placeholder="如：福建省" value={province} onChange={(e) => setProvince(e.target.value)} />
            </label>
          </div>
        )}

        <div className="mt-4">
          <DataTable
            columns={resultColumns}
            data={rows}
            loading={loading}
            emptyText={searched ? '未查询到匹配的网段' : '输入 IP / 网段 / 关键词开始查询'}
            emptyDescription={searched ? '可调整关键词或筛选条件后重试' : '支持单 IP 精确归属、CIDR 网段重叠、运营商/持有者/国家关键词包含匹配'}
            onRowClick={(row) => setDetail(row)}
            rowClassName={() => 'whitespace-nowrap'}
          />
          {searched && total > 0 && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={(p) => runQuery(p)}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1); runQueryWithSize(s, 1) }}
            />
          )}
        </div>
      </Card>

      <ImportModal
        open={importOpen}
        libraries={meta.libraries}
        onClose={() => { setImportOpen(false) }}
        onFinish={loadMeta}
      />
      <BatchDrawer
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        libraries={meta.libraries}
      />

      {/* 查询结果详情：全部字段（含该库特有列） */}
      <Drawer
        open={!!detail}
        title={detail ? `${meta.libraries.find((l) => l.library_type === detail.library_type)?.label || ''} · ${detail.cidr}` : '网段详情'}
        onClose={() => setDetail(false)}
        width="w-[560px]"
        footer={<Button variant="secondary" size="sm" onClick={() => setDetail(false)}>关闭</Button>}
      >
        {detail && (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {detailFields.map((f) => (
              <div key={f.key} className="min-w-0 border-b border-border/60 pb-3">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="mt-1 break-all text-sm font-medium text-foreground">{detail[f.key] || '—'}</dd>
              </div>
            ))}
            <div className="min-w-0 border-b border-border/60 pb-3">
              <dt className="text-xs text-muted-foreground">入库时间</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">{fmtTime(detail.updated_at)}</dd>
            </div>
          </dl>
        )}
      </Drawer>
    </PageContainer>
  )

  // 页内分页大小变更：先更新 state 再以新参数查询
  function runQueryWithSize(newSize, newPage) {
    const params = {
      library_type: libFilter,
      q: q.trim(),
      country: country.trim(),
      isp: isp.trim(),
      province: province.trim(),
      page: newPage,
      page_size: newSize,
    }
    setLoading(true)
    Promise.resolve(ipLibraryApi.list(params))
      .then((data) => {
        setRows(data.items || [])
        setTotal(data.total || 0)
        setSearched(true)
      })
      .catch((e) => toast.error(e.message || '查询失败'))
      .finally(() => setLoading(false))
  }
}
