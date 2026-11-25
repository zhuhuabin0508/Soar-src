// 资产发现：左侧同级来源（综合运管平台 + 1.1~1.4），右侧为当前来源的表与清单
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Boxes, CheckCircle2, FileSpreadsheet, Loader2, RefreshCw, Search, Server, Network, Globe, Cpu,
  Upload, Download, X, ShieldOff, Shield, Monitor, AlertTriangle, ChevronRight, Package,
} from 'lucide-react'
import { govCloudApi } from '../api/govcloud'
import RealtimeQueryModal from './govcloud/RealtimeQueryModal'
import { toast } from '../store/toastStore'
import {
  PageContainer, PageHeader, Button, Badge, EmptyState, Pagination, LoadingState, SearchInput,
} from '../components/ui'
import { Modal, Drawer } from '../components/Dialog'
import { inputCls } from '../components/property/FormControls'
import { hasPermission } from '../utils/permissions'

const TYPE_ICONS = {
  cloud_host: Server,
  bare_metal: Cpu,
  e_government_network: Network,
  elastic_ip: Globe,
  tianqing_endpoint: Monitor,
  tianqing_software: Package,
}

const SOURCE_ICONS = {
  itsm_ops: Globe,
  intranet_mapping: Network,
  qingteng_host: Server,
  qingteng_component: Package,
  qingteng_asset: Boxes,
  jiaotu_yunsuo: Shield,
  tianqing_endpoint: Monitor,
  tianqing_software: Package,
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const HIDE_COLS = new Set([
  'extra_excel', 'batch_id',
  // 青藤内部字段：归一化值与内部主键不展示，避免表格过宽
  'source_id', 'qingteng_device_id', 'name_norm', 'version_norm',
  // 天擎内部字段
  'extra', 'tianqing_device_id',
])

function cellText(v) {
  if (v === '' || v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function sourceTitle(group) {
  if (!group) return ''
  return group.index ? `${group.index} ${group.label}` : group.label
}

// 文件体积人性化展示
function fmtSize(n) {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 详情关键字段置顶排序权重（识别字段优先，其余保持原序）
const DETAIL_PRIORITY = [
  'instance_name', 'inst_name', 'name', 'host_name', 'hostname', 'computer_name',
  'ip', 'ip_address', 'private_ip', 'public_ip', 'manage_ip', 'inner_ip',
]

function ImportDialog({ open, tableName, sourceName, importing, importPhase, onClose, onConfirm }) {
  const [mode, setMode] = useState('full')
  const [file, setFile] = useState(null)
  // 格式错误在字段正下方红字提示（普通录入报错不弹全局弹窗）
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const pickRef = useRef(null)

  useEffect(() => {
    if (open) {
      setMode('full')
      setFile(null)
      setFileError('')
    }
  }, [open])

  if (!open) return null

  // 本地校验：拦截非 .xlsx / .csv 文件（可重选）
  function validateAndSet(f) {
    if (!f) return
    const name = (f.name || '').toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      setFileError('仅支持爬虫产出的 .xlsx / .csv 文件')
      setFile(null)
      return
    }
    setFileError('')
    setFile(f)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    if (importing) return
    validateAndSet(e.dataTransfer.files?.[0])
  }

  return (
    <Modal
      open={open}
      title={`导入「${tableName}」`}
      onClose={importing ? undefined : onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" disabled={importing} onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={importing || !file}
            onClick={() => onConfirm(file, mode)}
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {importing ? importPhase || '导入中' : (mode === 'full' ? '开始全量导入' : '开始增量导入')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">
        来源：{sourceName}。请先选择插入方式，再选择爬虫产出的 .xlsx / .csv。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={importing}
          onClick={() => setMode('full')}
          className={`rounded-lg border p-3 text-left transition-colors ${
            mode === 'full' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className={`h-3.5 w-3.5 shrink-0 rounded-full border ${mode === 'full' ? 'border-[4.5px] border-primary bg-background' : 'border-muted-foreground/40'}`} aria-hidden />
            全量导入
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            按 CMDB ID 新增或更新文件中的记录，并删除本次文件里没有的旧记录，与全量爬取对齐。
          </div>
        </button>
        <button
          type="button"
          disabled={importing}
          onClick={() => setMode('incremental')}
          className={`rounded-lg border p-3 text-left transition-colors ${
            mode === 'incremental' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className={`h-3.5 w-3.5 shrink-0 rounded-full border ${mode === 'incremental' ? 'border-[4.5px] border-primary bg-background' : 'border-muted-foreground/40'}`} aria-hidden />
            增量导入
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            只新增或更新文件中的记录，不删除库内已有数据。适合补录、周中追加。
          </div>
        </button>
      </div>
      <div className="mt-4">
        <input
          ref={pickRef}
          type="file"
          accept=".xlsx,.csv"
          className="hidden"
          onChange={(e) => {
            validateAndSet(e.target.files?.[0])
            // 允许重复选择同一文件
            e.target.value = ''
          }}
        />
        {/* 拖拽上传区：点击选择或直接拖入文件 */}
        <button
          type="button"
          disabled={importing}
          onClick={() => pickRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); if (!importing) setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed p-4 text-center transition-colors ${
            importing ? 'cursor-not-allowed opacity-60'
              : dragOver ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/40 hover:bg-muted/50'
          }`}
        >
          <Upload className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">拖拽文件到此处，或点击选择</span>
          <span className="text-xs text-muted-foreground">支持爬虫产出的 .xlsx / .csv 全量爬取文件</span>
        </button>
        {fileError && <p className="mt-1.5 text-xs text-destructive">{fileError}</p>}
        {file && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{file.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtSize(file.size)}</span>
            {!importing && (
              <button
                type="button"
                onClick={() => setFile(null)}
                className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                aria-label="移除已选文件"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

const RESTART_LABELS = { 0: '未知', 1: '无需重启', 2: '重启服务', 3: '重启系统' }

function severityBadgeTone(code) {
  if (code >= 4) return 'danger'
  if (code === 3) return 'warning'
  if (code === 2) return 'info'
  return 'neutral'
}

// 单条命中证据：漏洞/补丁检测给出的版本比对、POC 结果与修复建议
function CveHitCard({ hit }) {
  const versions = (hit.check_details || [])
    .map((d) => {
      if (!d) return ''
      const name = d.name || d.pm || d.package || ''
      const current = d.version || d.currentVersion || ''
      const fixed = d.fixedVersion || d.fixVersion || ''
      return `${name}${current ? ` ${current}` : ''}${fixed ? ` → ${fixed}` : ''}`.trim()
    })
    .filter(Boolean)
  const pocText = (hit.poc_check_results || [])
    .map((r) => (typeof r === 'string' ? r : r?.result || r?.msg || ''))
    .filter(Boolean)
    .join('\n')
  const facts = [
    ['检测方式', hit.check_type || '—'],
    ['影响应用', (hit.apps || []).join('、') || hit.app_version || '—'],
    ['版本信息', versions.join('；') || '—'],
    ['CVSS', hit.cvss_score != null && hit.cvss_score !== '' ? String(hit.cvss_score) : '—'],
    ['EXP/POC', `${hit.has_exp ? '有 EXP' : '无 EXP'} / ${hit.has_poc ? '有 POC' : '无 POC'}`],
    ['属性', [hit.kernel && '内核', hit.remote && '远程', hit.local_escalation && '本地提权'].filter(Boolean).join('、') || '—'],
    ['重启影响', RESTART_LABELS[hit.restart_opts] || '—'],
    ['补丁/KB', hit.kb_num || hit.bullet_id || '—'],
    ['首次检测', hit.first_check_time || '—'],
  ]
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severityBadgeTone(Number(hit.severity_code) || 0)}>{hit.severity || '未知'}</Badge>
        <Badge variant="neutral">{hit.source_label}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={hit.vul_name}>
          {hit.vul_name}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {facts.map(([key, value]) => (
          <div key={key} className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted-foreground">{key}</dt>
            <dd className="min-w-0 flex-1 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {(hit.check_info || pocText) && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
          {hit.check_info || pocText}
        </pre>
      )}
      {(hit.remed_description || hit.remed_desc || hit.remed_cmd) && (
        <div className="mt-2 text-xs text-muted-foreground">
          <span className="text-foreground">修复建议：</span>
          {hit.remed_description || hit.remed_desc || hit.remed_cmd}
        </div>
      )}
      {hit.install_package && (
        <div className="mt-1 break-all text-[11px] text-muted-foreground">安装包：{hit.install_package}</div>
      )}
    </div>
  )
}

// CVE 影响面：按 CVE 实时查询青藤命中主机，并展开每台主机的命中证据
function CveImpactModal({ open, deviceId, deviceName, onClose }) {
  const [cve, setCve] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    if (!open) {
      setCve('')
      setData(null)
      setError('')
      setExpanded({})
      setLoading(false)
    }
  }, [open])

  async function runQuery(force = false) {
    const value = cve.trim().toUpperCase()
    if (!value) {
      setError('请输入 CVE 编号')
      return
    }
    if (!deviceId) {
      setError('当前数据表未关联青藤设备')
      return
    }
    setLoading(true)
    setError('')
    setData(null)
    setExpanded({})
    try {
      const res = await govCloudApi.cveHosts({ deviceId, cve: value, refresh: force })
      setData(res)
    } catch (err) {
      setError(err.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  function submit(e) {
    e.preventDefault()
    runQuery(false)
  }

  function toggle(key) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`CVE 影响面${deviceName ? ` · ${deviceName}` : ''}`}
      size="xl"
      footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          className={inputCls}
          placeholder="输入 CVE 编号，如 CVE-2024-21762"
          value={cve}
          onChange={(e) => setCve(e.target.value)}
          autoFocus
        />
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          查询
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => runQuery(true)}
          disabled={loading || !cve.trim()}
          title="忽略 10 分钟缓存，重新拉取青藤漏洞/补丁索引"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新索引
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        命中关系来自青藤漏洞检测与补丁检测结果，索引缓存 10 分钟；进程/组件清单不含 CVE，不参与判定。
      </p>
      {loading && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">正在构建风险索引并匹配主机，首次查询可能需要几十秒…</p>
          <LoadingState rows={4} cols={3} />
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {data && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-mono text-sm font-semibold text-foreground">{data.cve}</span>
            <span>
              影响主机 <b className="text-foreground">{data.summary?.host_count || 0}</b> 台
            </span>
            <span>
              命中记录 <b className="text-foreground">{data.summary?.hit_count || 0}</b> 条
            </span>
            <span>索引构建 {data.built_at || '—'}</span>
          </div>
          {!data.covered && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              青藤漏洞库/补丁库未收录该 CVE，或匹配字段缺失，暂无命中主机。
            </div>
          )}
          {data.warnings?.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {data.warnings.join('；')}
            </div>
          )}
          {data.covered && data.hosts?.length === 0 && (
            <EmptyState
              title="暂无命中主机"
              description="该 CVE 在青藤规则库中存在，但当前没有主机命中记录。"
            />
          )}
          <div className="flex flex-col gap-2">
            {data.hosts?.map((host) => {
              const key = host.agent_id || host.host_ip
              const openHost = !!expanded[key]
              const maxSeverity = Math.max(0, ...(host.hits || []).map((h) => Number(h.severity_code) || 0))
              return (
                <div key={key} className="overflow-hidden rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-muted/40"
                  >
                    <ChevronRight
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${openHost ? 'rotate-90' : ''}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-foreground">{host.host_ip || '—'}</span>
                        <span className="truncate text-xs text-muted-foreground">{host.host_name || host.remark || ''}</span>
                        {Number(host.online_status) === 0 && <Badge variant="neutral">离线</Badge>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>{host.biz_group || '未分组'}</span>
                        {host.owner && <span>负责人 {host.owner}</span>}
                        {host.location && <span>{host.location}</span>}
                      </div>
                    </div>
                    <Badge variant={severityBadgeTone(maxSeverity)}>{host.hit_count} 条命中</Badge>
                  </button>
                  {openHost && (
                    <div className="flex flex-col gap-2 border-t border-border bg-muted/20 p-3">
                      {(host.hits || []).map((hit, idx) => (
                        <CveHitCard key={`${hit.source}-${hit.vul_id}-${idx}`} hit={hit} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Modal>
  )
}

export default function GovCloudAssets() {
  const canView = hasPermission('asset_discovery', 'view')
  const canEdit = hasPermission('asset_discovery', 'edit')
  const canImport = hasPermission('asset_discovery', 'import')
  const canExport = hasPermission('asset_discovery', 'export')
  const [importOpen, setImportOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const [fieldLabels, setFieldLabels] = useState({})
  const [groups, setGroups] = useState([])
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [cons, setCons] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importPhase, setImportPhase] = useState('')
  // 青藤主机 API 同步中（登录青藤平台 → 分页拉取 linux/win 主机 → 入库）
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState(null)
  const [realtimeOpen, setRealtimeOpen] = useState(false)
  // 资产明细当前模块 tab（空 = 全部）
  const [assetModule, setAssetModule] = useState('')
  // 组件同步轮询开关：页面卸载后停止继续请求
  const syncPollRef = useRef(false)
  useEffect(() => () => { syncPollRef.current = false }, [])
  const [exporting, setExporting] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [cveOpen, setCveOpen] = useState(false)
  const [listColumns, setListColumns] = useState([])
  // 来源元数据加载标记（仅用于骨架屏展示）
  const [metaLoading, setMetaLoading] = useState(true)
  // 对齐状态筛选（指标条 chip 点击，仅前端过滤数据表卡片）
  const [consFilter, setConsFilter] = useState('')

  const currentGroup = useMemo(() => {
    const fromUrl = searchParams.get('source')
    if (fromUrl) return groups.find((g) => g.code === fromUrl) || groups[0]
    return groups[0]
  }, [groups, searchParams])

  const tables = currentGroup?.tables || []
  const active = searchParams.get('table') || tables[0]?.code || ''

  // 对齐状态统计 + 资产总量（从当前来源数据表派生，供指标条与头部计数展示）
  const consStats = useMemo(() => {
    const ok = tables.filter((t) => t.consistent).length
    return { ok, bad: tables.length - ok, total: tables.reduce((n, t) => n + (t.total || 0), 0) }
  }, [tables])

  // 指标条筛选后的可见数据表卡片
  const visibleTables = useMemo(() => {
    if (consFilter === 'ok') return tables.filter((t) => t.consistent)
    if (consFilter === 'bad') return tables.filter((t) => !t.consistent)
    return tables
  }, [tables, consFilter])

  // 当前卡片：优先 URL 选中；若被「已对齐/未对齐」筛选隐藏，自动落到第一张可见卡片
  const currentTable = visibleTables.find((t) => t.code === active) || visibleTables[0]
  const sourceEnabled = Boolean(currentGroup?.enabled && tables.length)
  // 青藤来源：数据来自设备管理配置的青藤平台 API 同步（不支持 Excel 导入）
  const isQingteng = currentGroup?.code === 'qingteng_host'
  const isQingtengComponent = currentGroup?.code === 'qingteng_component'
  const isQingtengAsset = currentGroup?.code === 'qingteng_asset'
  const isQingtengApi = isQingteng || isQingtengComponent || isQingtengAsset
  const isTianqing = currentGroup?.code === 'tianqing_endpoint'
  const isTianqingSoftware = currentGroup?.code === 'tianqing_software'
  const isApiSync = isQingtengApi || isTianqing || isTianqingSoftware
  const currentModuleLabel = currentTable?.modules?.find((m) => m.value === assetModule)?.label || ''

  const displayColumns = useMemo(() => {
    const ordered = []
    const seen = new Set()
    const fromMeta = listColumns.length ? listColumns : (currentTable?.excel_columns || [])
    fromMeta.forEach((c) => {
      if (!c?.key || HIDE_COLS.has(c.key) || seen.has(c.key)) return
      seen.add(c.key)
      ordered.push({ key: c.key, label: c.label || fieldLabels[c.key] || c.key })
    })
    items.forEach((row) => {
      Object.keys(row || {}).forEach((k) => {
        if (HIDE_COLS.has(k) || seen.has(k)) return
        seen.add(k)
        ordered.push({ key: k, label: fieldLabels[k] || k })
      })
    })
    return ordered
  }, [listColumns, currentTable?.excel_columns, items, fieldLabels])

  // 数值/日期列启发式：采样当前页数据，80% 以上命中即按数值列处理（右对齐 + 等宽数字）。
  // 编号/ID 类字段虽为数字串，但承担识别职责，保持左对齐不参与扫描比较。
  const rightAlignKeys = useMemo(() => {
    if (!items.length) return new Set()
    const NUM_RE = /^-?[\d,]+(\.\d+)?%?$/
    const DT_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?/
    const set = new Set()
    displayColumns.forEach((col) => {
      const key = col.key
      const lower = key.toLowerCase()
      if (lower === 'id' || lower.endsWith('_id') || lower.includes('_id')) return
      const vals = items.map((r) => r[key]).filter((v) => v !== '' && v != null)
      if (!vals.length) return
      const hit = vals.filter((v) =>
        typeof v === 'number' || NUM_RE.test(String(v).trim()) || DT_RE.test(String(v).trim()))
      if (hit.length / vals.length >= 0.8) set.add(key)
    })
    return set
  }, [displayColumns, items])

  useEffect(() => {
    if (!canView) return
    Promise.all([govCloudApi.meta(), govCloudApi.summary()])
      .then(([m, s]) => {
        setFieldLabels(m.field_labels || {})
        setGroups(s.groups?.length ? s.groups : (m.groups || []))
      })
      .catch((e) => toast.error(e.message || '加载元数据失败'))
      .finally(() => setMetaLoading(false))
  }, [canView])

  // URL keyword 预填（如工单安全上下文「在资产发现中查看」跳转）：仅首次挂载读取，
  // 预填后 keyword 状态变化会驱动列表按该关键词过滤
  useEffect(() => {
    const kw = (searchParams.get('keyword') || '').trim()
    if (kw) setKeyword(kw)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async (pageOverride) => {
    // 点击事件会传入 event，只有显式数字才覆盖页码
    const targetPage = Number.isInteger(pageOverride) ? pageOverride : page
    if (!canView || !sourceEnabled || !currentTable?.code) {
      setLoading(false)
      setItems([])
      setTotal(0)
      setCons(null)
      setListColumns([])
      return
    }
    setLoading(true)
    try {
      const type = currentTable.code
      const [list, c, sum] = await Promise.all([
        govCloudApi.list({
          resource_type: type,
          keyword,
          module: isQingtengAsset ? assetModule : '',
          page: targetPage,
          page_size: pageSize,
        }),
        govCloudApi.consistency(type),
        govCloudApi.summary(),
      ])
      setItems(list.items || [])
      setTotal(list.total || 0)
      setListColumns(list.columns || currentTable.excel_columns || [])
      setCons(c)
      if (sum.groups) setGroups(sum.groups)
    } catch (e) {
      toast.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [canView, sourceEnabled, currentTable?.code, keyword, isQingtengAsset, assetModule, page, pageSize])

  useEffect(() => { if (canView) load() }, [load, canView])

  function selectSource(code) {
    const next = groups.find((g) => g.code === code)
    const firstTable = next?.tables?.[0]?.code
    const params = { source: code }
    if (firstTable) params.table = firstTable
    setSearchParams(params)
    setPage(1)
    setKeyword('')
    setConsFilter('')
    setAssetModule('')
  }

  function selectTable(code) {
    const params = { table: code }
    if (currentGroup?.code) params.source = currentGroup.code
    setSearchParams(params)
    setPage(1)
    setKeyword('')
    setAssetModule('')
  }

  async function handleImport(file, mode) {
    if (!file || !currentTable?.code) return
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      toast.error('请上传爬虫产出的 .xlsx / .csv 文件')
      return
    }
    const tableName = currentTable.excel_name || currentTable.label
    const isFull = mode !== 'incremental'
    setImporting(true)
    setImportPhase('上传中…')
    try {
      const result = await govCloudApi.importExcel(file, currentTable.code, ({ phase, percent }) => {
        if (phase === 'uploading') setImportPhase(`上传中 ${percent || 0}%`)
        if (phase === 'processing') setImportPhase('服务端处理中，请稍候…')
      }, isFull ? 'full' : 'incremental')
      if (isFull) {
        if (result.consistent) {
          toast.success(`${tableName} 全量已对齐：Excel ${result.excel_rows} 行 / 库内 ${result.live_count} 条`)
        } else {
          toast.error(result.note || '全量导入完成但一致性校验未通过')
        }
      } else {
        toast.success(`${tableName} 增量完成：新增 ${result.inserted} / 更新 ${result.updated} / 库内 ${result.live_count} 条`)
      }
      setImportOpen(false)
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '导入失败')
    } finally {
      setImporting(false)
      setImportPhase('')
    }
  }

  async function handleExport() {
    if (!currentTable?.code) return
    const name = currentTable.excel_name || currentTable.label
    setExporting(true)
    try {
      const module = isQingtengAsset ? assetModule : ''
      await govCloudApi.exportCsv(currentTable.code, keyword, name, module)
      const scope = [keyword ? `关键词：${keyword}` : '', module ? `模块：${module}` : '']
        .filter(Boolean).join('，')
      toast.success(`已导出「${name}」${scope ? `（${scope}）` : ' 全部数据'}`)
    } catch (e) {
      toast.error(e.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // 青藤主机同步：登录设备管理中配置的青藤平台，API 拉取 linux / win 主机清单入库。
  // 当前卡片带 device_id 时只同步该设备，否则同步全部已启用的青藤设备。
  async function handleSync() {
    const deviceIds = currentTable?.device_id ? [currentTable.device_id] : []
    setSyncing(true)
    try {
      const result = await govCloudApi.syncQingteng(deviceIds)
      const results = result?.results || []
      const okItems = results.filter((r) => r.success)
      const failItems = results.filter((r) => !r.success)
      okItems.forEach((r) => {
        toast.success(
          `${r.device_name} 同步完成：拉取 ${r.excel_rows} 行 / 库内 ${r.live_count} 条${r.consistent ? '（已对齐）' : ''}`,
        )
      })
      failItems.forEach((r) => toast.error(`${r.device_name} 同步失败：${r.error || '未知错误'}`))
      if (!results.length) toast.success('同步完成')
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  // 天擎终端同步：登录设备管理中配置的天擎平台，通过 ODP 拉取全网终端入库。
  async function handleTianqingSync() {
    const deviceIds = currentTable?.device_id ? [currentTable.device_id] : []
    setSyncing(true)
    try {
      const result = await govCloudApi.syncTianqing(deviceIds)
      const results = result?.results || []
      const okItems = results.filter((r) => r.success)
      const failItems = results.filter((r) => !r.success)
      okItems.forEach((r) => {
        toast.success(
          `${r.device_name} 同步完成：接口 ${r.api_total ?? r.excel_rows} 台 / 库内 ${r.live_count} 台${r.consistent ? '（已对齐）' : ''}`,
        )
      })
      failItems.forEach((r) => toast.error(`${r.device_name} 同步失败：${r.error || '未知错误'}`))
      if (!results.length) toast.success('同步完成')
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '天擎终端同步失败')
    } finally {
      setSyncing(false)
    }
  }

  // 天擎组件异步同步：逐台终端拉取已安装软件，终端量大时耗时较长
  async function handleTianqingSoftwareSync() {
    const deviceIds = currentTable?.device_id ? [currentTable.device_id] : []
    setSyncing(true)
    setSyncProgress({ status: 'pending', phase: '派发任务', percent: 0 })
    syncPollRef.current = true
    let lastStatus = null
    try {
      const result = await govCloudApi.syncTianqingSoftware({ deviceIds })
      const batches = result?.batches || []
      if (!batches.length) throw new Error('未创建同步批次')
      const nameByBatch = new Map(batches.map((b) => [b.batch_id, b.device_name]))
      // 逐台终端拉取，万级终端耗时较长：前端轮询 30 分钟，未完成则提示稍后刷新
      const deadline = Date.now() + 30 * 60 * 1000
      let final = null
      while (syncPollRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        if (!syncPollRef.current) break
        const statuses = await Promise.all(
          batches.map((b) => govCloudApi.tianqingSoftwareSyncStatus({ batchId: b.batch_id })),
        )
        lastStatus = statuses.find((s) => s.status === 'running') || statuses[0]
        setSyncProgress(lastStatus)
        if (statuses.every((s) => ['success', 'partial', 'failed'].includes(s.status))) {
          final = statuses
          break
        }
      }
      if (!final) {
        toast.info(`天擎组件同步仍在后台进行（${lastStatus?.percent ?? 0}%），可稍后刷新查看进度`)
        return
      }
      final.forEach((s) => {
        const name = nameByBatch.get(s.id) || s.resource_type
        if (s.status === 'failed') {
          toast.error(`${name} 组件同步失败：${s.note || '未知错误'}`)
        } else {
          toast.success(
            `${name} 组件同步${s.status === 'partial' ? '部分完成' : '完成'}：拉取 ${s.excel_rows} 条 / 库内 ${s.live_count} 条`,
          )
        }
      })
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '组件同步失败')
    } finally {
      syncPollRef.current = false
      setSyncing(false)
      setSyncProgress(null)
    }
  }

  // 青藤组件异步同步：创建批次后轮询进度（phase/percent），完成后刷新列表
  async function handleComponentSync() {
    const deviceIds = currentTable?.device_id ? [currentTable.device_id] : []
    setSyncing(true)
    setSyncProgress({ status: 'pending', phase: '派发任务', percent: 0 })
    syncPollRef.current = true
    try {
      const result = await govCloudApi.syncQingtengComponents({ deviceIds })
      const batches = result?.batches || []
      if (!batches.length) throw new Error('未创建同步批次')
      const nameByBatch = new Map(batches.map((b) => [b.batch_id, b.device_name]))
      // 后端任务上限 65 分钟（time_limit=3900s），前端轮询留出余量
      const deadline = Date.now() + 70 * 60 * 1000
      let final = null
      while (syncPollRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (!syncPollRef.current) break
        const statuses = await Promise.all(
          batches.map((b) => govCloudApi.componentSyncStatus({ batchId: b.batch_id })),
        )
        const running = statuses.find((s) => s.status === 'running') || statuses[0]
        setSyncProgress(running)
        if (statuses.every((s) => ['success', 'partial', 'failed'].includes(s.status))) {
          final = statuses
          break
        }
      }
      if (!final) {
        toast.error('组件同步耗时较长，请稍后刷新查看结果')
        return
      }
      final.forEach((s) => {
        const name = nameByBatch.get(s.id) || s.resource_type
        if (s.status === 'failed') {
          toast.error(`${name} 组件同步失败：${s.note || '未知错误'}`)
        } else {
          toast.success(
            `${name} 组件同步${s.status === 'partial' ? '部分完成' : '完成'}：拉取 ${s.excel_rows} 行 / 库内 ${s.live_count} 条`,
          )
        }
      })
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '组件同步失败')
    } finally {
      syncPollRef.current = false
      setSyncing(false)
      setSyncProgress(null)
    }
  }

  // 青藤资产明细异步同步：当前模块 tab 有值时只同步该模块，否则同步全部
  async function handleAssetModuleSync() {
    const deviceIds = currentTable?.device_id ? [currentTable.device_id] : []
    const modules = assetModule ? [assetModule] : []
    setSyncing(true)
    setSyncProgress({ status: 'pending', phase: '派发任务', percent: 0 })
    syncPollRef.current = true
    try {
      const result = await govCloudApi.syncQingtengModules({ deviceIds, modules })
      const batches = result?.batches || []
      if (!batches.length) throw new Error('未创建同步批次')
      const nameByBatch = new Map(batches.map((b) => [b.batch_id, b.device_name]))
      const deadline = Date.now() + 70 * 60 * 1000
      let final = null
      while (syncPollRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (!syncPollRef.current) break
        const statuses = await Promise.all(
          batches.map((b) => govCloudApi.moduleSyncStatus({ batchId: b.batch_id })),
        )
        const running = statuses.find((s) => s.status === 'running') || statuses[0]
        setSyncProgress(running)
        if (statuses.every((s) => ['success', 'partial', 'failed'].includes(s.status))) {
          final = statuses
          break
        }
      }
      if (!final) {
        toast.error('资产同步耗时较长，请稍后刷新查看结果')
        return
      }
      final.forEach((s) => {
        const name = nameByBatch.get(s.id) || s.resource_type
        if (s.status === 'failed') {
          toast.error(`${name} 资产同步失败：${s.note || '未知错误'}`)
        } else {
          toast.success(
            `${name} 资产同步${s.status === 'partial' ? '部分完成' : '完成'}：拉取 ${s.excel_rows} 行 / 库内 ${s.live_count} 条`,
          )
        }
      })
      setPage(1)
      await load(1)
    } catch (e) {
      toast.error(e.message || '资产同步失败')
    } finally {
      syncPollRef.current = false
      setSyncing(false)
      setSyncProgress(null)
    }
  }

  async function openDetail(id) {
    try {
      const rec = await govCloudApi.get(currentTable.code, id)
      setDetail(rec)
      setDetailOpen(true)
    } catch (e) {
      toast.error(e.message || '加载详情失败')
    }
  }

  if (!canView) {
    return (
      <PageContainer>
        <PageHeader title="资产发现" />
        <EmptyState
          icon={ShieldOff}
          title="没有访问权限"
          description="请联系管理员在「角色管理」中授予「资产发现」查看权限。"
        />
      </PageContainer>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">资产发现</h1>
          {sourceEnabled && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{consStats.total.toLocaleString()}</span> 条资产
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">
            发现来源同级展示，综合运管平台每周全量爬取，青藤 / 天擎按设备 API 同步
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading || importing || syncing || !sourceEnabled}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          {canView && sourceEnabled && isQingteng && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCveOpen(true)}
              disabled={!currentTable?.device_id}
              title="按 CVE 实时查询青藤命中的主机与命中证据"
            >
              <Search className="h-3.5 w-3.5" />
              CVE 影响面
            </Button>
          )}
          {canView && sourceEnabled && isQingtengApi && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRealtimeOpen(true)}
              disabled={!currentTable?.device_id}
              title="实时查询青藤接口（结果不落库）"
            >
              <Search className="h-3.5 w-3.5" />
              实时查询
            </Button>
          )}
          {canExport && sourceEnabled && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExport}
              disabled={exporting || loading || importing || syncing || !currentTable || total === 0}
              title="导出当前数据表为 CSV（遵循搜索条件，含全部数据）"
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {exporting
                ? '导出中'
                : isQingtengAsset
                  ? `导出${currentModuleLabel || '资产明细'}`
                  : `导出${currentTable?.excel_name || ' CSV'}`}
            </Button>
          )}
          {canEdit && sourceEnabled && (isQingteng || isQingtengComponent || isQingtengAsset || isTianqing || isTianqingSoftware) ? (
            <Button
              variant="primary"
              size="sm"
              disabled={syncing || loading || importing || !currentTable}
              onClick={
                isTianqing
                  ? handleTianqingSync
                  : isTianqingSoftware
                    ? handleTianqingSoftwareSync
                    : isQingtengAsset
                      ? handleAssetModuleSync
                      : isQingtengComponent ? handleComponentSync : handleSync
              }
              title={
                isTianqing
                  ? '登录设备管理中配置的天擎平台，通过 ODP 拉取全网终端清单入库'
                  : isTianqingSoftware
                    ? '按已同步的天擎终端逐台拉取已安装软件清单（终端量大时耗时较长）'
                    : isQingtengAsset
                      ? '异步同步该设备的资产明细模块（当前 tab 有值时只同步该模块）'
                      : isQingtengComponent
                        ? '异步同步该青藤设备的组件清单（安装包 / 软件应用 / 数据库 / Jar 包 / Web 框架）'
                        : '登录设备管理中配置的青藤平台，API 拉取 linux / win 主机清单入库'
              }
            >
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {syncing
                ? ((isQingtengComponent || isQingtengAsset || isTianqingSoftware) && syncProgress?.percent != null
                  ? `同步中 ${syncProgress.percent}%`
                  : '同步中')
                : isTianqing
                  ? '同步天擎终端'
                  : isTianqingSoftware
                    ? '同步天擎组件'
                    : isQingtengAsset
                      ? (currentModuleLabel ? `同步${currentModuleLabel}` : '同步资产明细')
                      : isQingtengComponent ? '同步组件' : `同步${currentTable?.excel_name || '青藤主机'}`}
            </Button>
          ) : canImport && sourceEnabled && !isTianqing && !isTianqingSoftware ? (
            <Button
              variant="primary"
              size="sm"
              disabled={importing || syncing || !currentTable}
              onClick={() => setImportOpen(true)}
            >
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {importing ? importPhase || '导入中' : `导入${currentTable?.excel_name || ' Excel'}`}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-6">
        <aside className="w-[240px] shrink-0 overflow-y-auto">
          <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            发现来源
          </div>
          <div className="space-y-1">
            {metaLoading && groups.length === 0
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2.5">
                    <div className="h-4 w-4 shrink-0 rounded skeleton-shimmer" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-3 w-3/4 rounded skeleton-shimmer" />
                      <div className="h-2 w-1/2 rounded skeleton-shimmer" />
                    </div>
                  </div>
                ))
              : groups.map((g) => {
                  const Icon = SOURCE_ICONS[g.code] || Globe
              const on = g.code === currentGroup?.code
              const count = (g.tables || []).reduce((n, t) => n + (t.total || 0), 0)
              return (
                <button
                  key={g.code}
                  type="button"
                  onClick={() => selectSource(g.code)}
                  className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    on
                      ? 'border-primary bg-primary/10'
                      : 'border-transparent hover:bg-muted'
                  }`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium leading-snug ${on ? 'text-primary' : 'text-foreground'}`}>
                      {sourceTitle(g)}
                    </span>
                    <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                      {g.enabled ? `${count.toLocaleString()} 条` : '即将接入'}
                    </span>
                  </span>
                  {!g.enabled && (
                    <Badge variant="neutral" className="shrink-0">待接入</Badge>
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mb-3">
            <h2 className="text-base font-semibold text-foreground">{sourceTitle(currentGroup)}</h2>
            {currentGroup?.description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{currentGroup.description}</p>
            )}
          </div>

          {!sourceEnabled ? (
            metaLoading ? (
              <div className="space-y-3">
                <div className="h-5 w-44 rounded skeleton-shimmer" />
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card p-3">
                      <div className="h-4 w-2/3 rounded skeleton-shimmer" />
                      <div className="mt-3 h-6 w-16 rounded skeleton-shimmer" />
                    </div>
                  ))}
                </div>
                <div className="h-24 w-full rounded-lg skeleton-shimmer" />
              </div>
            ) : (
              <EmptyState
                icon={SOURCE_ICONS[currentGroup?.code] || Globe}
                title={`${sourceTitle(currentGroup) || '该来源'}尚未接入`}
                description="与综合运管平台资产发现同级，数据接入后将在此展示清单与导入。"
                bordered
              />
            )
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 max-h-[min(420px,42%)] overflow-y-auto">
              <div className="card-stagger mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {visibleTables.length === 0 ? (
                  <div className="col-span-full rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                    当前筛选下无数据表，点击指标条可取消筛选
                  </div>
                ) : visibleTables.map((t) => {
                  const Icon = TYPE_ICONS[t.code] || TYPE_ICONS[String(t.code).split(':')[0]] || FileSpreadsheet
                  const on = t.code === currentTable?.code
                  return (
                    <button
                      key={t.code}
                      type="button"
                      onClick={() => selectTable(t.code)}
                      className={`card-hover rounded-lg border p-3 text-left transition-colors ${
                        on ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {isQingteng
                            ? <Server className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />
                            : isQingtengComponent
                              ? <Package className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />
                              : isQingtengAsset
                                ? <Boxes className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />
                                : isTianqing
                                  ? <Monitor className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />
                                  : isTianqingSoftware
                                    ? <Package className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />
                                    : <FileSpreadsheet className={`h-4 w-4 shrink-0 ${on ? 'text-primary' : 'text-primary/70'}`} />}
                          <span className={`truncate text-sm font-medium ${on ? 'text-primary' : 'text-foreground'}`}>
                            {t.excel_name || t.label}
                          </span>
                        </div>
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`text-lg font-semibold tabular-nums ${t.total > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {t.total == null ? '--' : t.total.toLocaleString()}
                        </span>
                        <Badge variant={t.consistent ? 'success' : 'warning'}>
                          {t.consistent ? '已对齐' : '未对齐'}
                        </Badge>
                      </div>
                      {isQingteng && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          API 同步 · linux / win 主机
                        </div>
                      )}
                      {isQingtengComponent && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          API 同步 · 组件清单
                        </div>
                      )}
                      {isQingtengAsset && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          API 同步 · 账号 / Web / 站点
                        </div>
                      )}
                      {isTianqing && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          API 同步 · 天擎终端
                        </div>
                      )}
                      {isTianqingSoftware && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          API 同步 · 终端已安装软件
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>

              {cons && (
                <div className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                  cons.consistent
                    ? 'border-success/30 bg-success/10 text-foreground'
                    : 'border-warning/30 bg-warning/10 text-foreground'
                }`}>
                  {cons.consistent
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                  <div>
                    <div className="font-medium">
                      {currentTable?.excel_name || currentTable?.label}：{cons.message}
                    </div>
                    {cons.last_batch && (
                      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {isApiSync ? '最近同步' : '最近导入'} {cons.last_batch.filename} ·
                        {isApiSync ? ' 拉取' : ' Excel'} {(cons.excel_rows ?? 0).toLocaleString()} 行 ·
                        唯一 ID {(cons.unique_source_ids ?? 0).toLocaleString()} · 库内 {(cons.live_count ?? 0).toLocaleString()} ·
                        {fmtTime(cons.last_batch.created_at)}
                        {cons.last_batch.note ? ` · ${cons.last_batch.note}` : ''}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 异步同步进度：组件 / 资产明细 / 天擎组件等长任务展示阶段与百分比 */}
              {syncing && syncProgress?.percent != null && (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm text-foreground">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
                  <div className="min-w-0">
                    <div className="font-medium">
                      {syncProgress.phase || '同步中'} · {syncProgress.percent}%
                      {syncProgress.stats?.terminals_total
                        ? `（终端 ${syncProgress.stats.terminals_done || 0}/${syncProgress.stats.terminals_total}）`
                        : ''}
                    </div>
                    {syncProgress.stats?.terminals_failed > 0 && (
                      <div className="mt-0.5 text-xs text-warning">
                        拉取失败终端 {syncProgress.stats.terminals_failed} 台，完成后保留其旧数据
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 青藤资产明细：按模块 tab 浏览（全部 / 系统账号 / 用户组 / Web 应用 / Web 站点） */}
              {isQingtengAsset && currentTable?.modules?.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  {[{ value: '', label: '全部' }, ...currentTable.modules].map((m) => {
                    const on = assetModule === m.value
                    return (
                      <button
                        key={m.value || 'all'}
                        type="button"
                        onClick={() => { setAssetModule(m.value); setPage(1) }}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          on
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                        }`}
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              )}

              {/* 单行内联筛选栏（轻量筛选形态）：关键词 + 对齐状态筛选 chips + 汇总统计 */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SearchInput
                  className="min-w-[220px] max-w-md flex-1"
                  placeholder={
                    isQingtengAsset
                      ? `搜索${currentModuleLabel ? `「${currentModuleLabel}」` : '「资产明细」'}名称 / IP / 主机名`
                      : isTianqingSoftware
                        ? `搜索「${currentTable?.excel_name || '天擎组件'}」软件名 / 版本 / 主机名 / IP`
                        : isTianqing
                          ? `搜索「${currentTable?.excel_name || '天擎终端'}」计算机名 / IP / MAC / 终端 ID`
                          : `搜索「${currentTable?.excel_name || '当前表'}」名称 / IP / 部门 / CMDB ID`
                  }
                  value={keyword}
                  onChange={(v) => { setKeyword(v); setPage(1) }}
                  onClear={() => { setKeyword(''); setPage(1) }}
                />
                {tables.length > 0 && [
                  { key: 'ok', label: '已对齐', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
                  { key: 'bad', label: '未对齐', dot: 'bg-warning', active: 'bg-warning/15 text-warning ring-warning/40' },
                ].map((chip) => {
                  const chipOn = consFilter === chip.key
                  const count = chip.key === 'ok' ? consStats.ok : consStats.bad
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      onClick={() => setConsFilter(chipOn ? '' : chip.key)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                        chipOn
                          ? `border-transparent ring-1 ${chip.active}`
                          : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                      }`}
                      title={
                        chipOn
                          ? '点击取消该筛选'
                          : chip.key === 'ok'
                            ? '只看最近一次同步成功且库内数量一致的设备卡片'
                            : '只看最近一次同步部分完成/失败或库内数量不一致的设备卡片'
                      }
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
                      {chip.label}
                      <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                    </button>
                  )
                })}
                {importing && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent bg-info/15 px-3 py-1 text-xs font-medium text-info ring-1 ring-info/40">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
                    导入中
                  </span>
                )}
                <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5" title="当前来源各数据表资产总量">
                    <Boxes className="h-3.5 w-3.5 text-primary/80" />
                    资产总量
                    <span className={`font-semibold tabular-nums ${consStats.total > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {consStats.total > 0 ? consStats.total.toLocaleString() : '--'}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5" title="当前来源数据表数量">
                    <FileSpreadsheet className="h-3.5 w-3.5 text-primary/80" />
                    数据表
                    <span className={`font-semibold tabular-nums ${tables.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {tables.length > 0 ? tables.length : '--'}
                    </span>
                  </span>
                </div>
              </div>

              </div>
              <div className="mt-3 flex min-h-0 w-full min-w-0 flex-1 flex-col">
              {loading ? (
                <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
                  <LoadingState rows={6} cols={Math.max(4, Math.min(displayColumns.length || 5, 8))} />
                </div>
              ) : items.length === 0 ? (
                <div className="min-h-0 flex-1 overflow-auto">
                <EmptyState
                  icon={isQingteng ? Server : isQingtengComponent ? Package : isQingtengAsset ? Boxes : isTianqing ? Monitor : isTianqingSoftware ? Package : FileSpreadsheet}
                  title={keyword ? '未找到匹配的资产' : `${currentTable?.excel_name || '当前表'}暂无数据`}
                  description={
                    keyword
                      ? '调整关键词或清除筛选条件后再试'
                      : isQingteng
                        ? (canEdit ? '点击同步从青藤平台拉取主机清单' : '等待管理员从青藤平台同步主机清单')
                        : isQingtengComponent
                          ? (canEdit ? '点击同步从青藤平台拉取组件清单' : '等待管理员从青藤平台同步组件清单')
                          : isQingtengAsset
                            ? (canEdit ? '点击同步从青藤平台拉取资产明细' : '等待管理员从青藤平台同步资产明细')
                            : isTianqing
                              ? (canEdit ? '点击同步从天擎 ODP 拉取终端清单' : '等待管理员从天擎平台同步终端清单')
                              : isTianqingSoftware
                                ? (canEdit ? '点击同步按终端拉取已安装软件清单' : '等待管理员从天擎平台同步组件清单')
                                : (canEdit ? '请导入对应全量爬取 Excel（Sheet「原始数据」）' : '等待管理员导入全量爬取结果')
                  }
                  bordered
                  action={
                    keyword ? (
                      <Button variant="secondary" size="sm" onClick={() => { setKeyword(''); setPage(1) }}>
                        清除筛选
                      </Button>
                    ) : canEdit && isTianqing ? (
                      <Button variant="primary" size="sm" disabled={syncing} onClick={handleTianqingSync}>
                        <RefreshCw className="h-3.5 w-3.5" /> 同步天擎终端
                      </Button>
                    ) : canEdit && isTianqingSoftware ? (
                      <Button variant="primary" size="sm" disabled={syncing} onClick={handleTianqingSoftwareSync}>
                        <RefreshCw className="h-3.5 w-3.5" /> 同步天擎组件
                      </Button>
                    ) : canEdit && isQingtengAsset ? (
                      <Button variant="primary" size="sm" disabled={syncing} onClick={handleAssetModuleSync}>
                        <RefreshCw className="h-3.5 w-3.5" /> {currentModuleLabel ? `同步${currentModuleLabel}` : '同步资产明细'}
                      </Button>
                    ) : canEdit && isQingtengComponent ? (
                      <Button variant="primary" size="sm" disabled={syncing} onClick={handleComponentSync}>
                        <RefreshCw className="h-3.5 w-3.5" /> 同步青藤组件
                      </Button>
                    ) : canEdit && isQingteng ? (
                      <Button variant="primary" size="sm" disabled={syncing} onClick={handleSync}>
                        <RefreshCw className="h-3.5 w-3.5" /> 同步青藤主机
                      </Button>
                    ) : canImport && !isTianqing ? (
                      <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
                        <Upload className="h-3.5 w-3.5" /> 导入 Excel
                      </Button>
                    ) : undefined
                  }
                />
                </div>
              ) : (
                <div className="table-stagger min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-border">
                  <table className="w-max min-w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 text-xs text-muted-foreground">
                      <tr>
                        {displayColumns.map((col) => (
                          <th
                            key={col.key}
                            className={`whitespace-nowrap border-b border-border bg-muted px-3 py-2 font-medium ${
                              rightAlignKeys.has(col.key) ? 'text-right' : ''
                            }`}
                          >
                            {col.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row) => (
                        <tr
                          key={row.id}
                          className="cursor-pointer border-t border-border table-row-hover"
                          onClick={() => openDetail(row.id)}
                        >
                          {displayColumns.map((col) => (
                            <td
                              key={col.key}
                              className={`max-w-[280px] truncate whitespace-nowrap px-3 py-2 ${
                                rightAlignKeys.has(col.key) ? 'text-right tabular-nums' : ''
                              }`}
                              title={cellText(row[col.key])}
                            >
                              {cellText(row[col.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {total > 0 && (
                <div className="shrink-0">
                  <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} showPageSize={false} />
                </div>
              )}
              </div>
            </div>
          )}
        </section>
      </div>

      <ImportDialog
        open={importOpen}
        tableName={currentTable?.excel_name || currentTable?.label || '当前表'}
        sourceName={sourceTitle(currentGroup)}
        importing={importing}
        importPhase={importPhase}
        onClose={() => { if (!importing) setImportOpen(false) }}
        onConfirm={handleImport}
      />
      {/* 资产详情：右侧抽屉（保留列表背景上下文，便于对照相邻行浏览） */}
      <Drawer
        open={detailOpen}
        title={detail?.instance_name || detail?.inst_name || detail?.name || detail?.computer_name || '资产详情'}
        onClose={() => setDetailOpen(false)}
        width="w-[640px]"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setDetailOpen(false)}>关闭</Button>
        }
      >
        {detail && (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {Object.entries(detail)
              .filter(([k]) => !HIDE_COLS.has(k))
              .sort(([a], [b]) => {
                const pa = DETAIL_PRIORITY.indexOf(a)
                const pb = DETAIL_PRIORITY.indexOf(b)
                return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb)
              })
              .map(([k, v]) => (
                <div key={k} className="min-w-0 border-b border-border/60 pb-3">
                  <dt className="text-xs text-muted-foreground">{fieldLabels[k] || k}</dt>
                  <dd className="mt-1 break-all text-sm font-medium text-foreground">{cellText(v)}</dd>
                </div>
              ))}
          </dl>
        )}
      </Drawer>

      <CveImpactModal
        open={cveOpen}
        deviceId={currentTable?.device_id}
        deviceName={currentTable?.label || currentTable?.excel_name}
        onClose={() => setCveOpen(false)}
      />

      <RealtimeQueryModal
        open={realtimeOpen}
        deviceId={currentTable?.device_id}
        deviceName={currentTable?.label || currentTable?.excel_name}
        groupCode={currentGroup?.code}
        initialModule={
          isQingtengAsset
            ? (assetModule || 'account')
            : isQingtengComponent ? 'pkg' : 'process'
        }
        onClose={() => setRealtimeOpen(false)}
      />
    </div>
  )
}
