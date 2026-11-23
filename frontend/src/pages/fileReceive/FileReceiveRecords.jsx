// 运营管理 - 文件接收记录
// 列表：时间/来源/状态/类型/关键词筛选 + 全部业务字段展开 + 详情/下载/重试/删除
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, Eye,
  FileArchive, FileText, HardDrive, Inbox, Loader2, RefreshCw, RotateCcw,
  Settings2, Trash2, X,
} from 'lucide-react'
import {
  Badge, Button, Card, CompactSelect, DataTable, PageContainer, PageHeader,
  Pagination, SearchInput,
} from '../../components/ui'
import { confirm } from '../../components/ConfirmDialog'
import { inputCls } from '../../components/property/FormControls'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import { fileReceiveApi } from '../../api/fileReceive'
import FileReceiveDetailDrawer from './FileReceiveDetailDrawer'
import FileReceiveSourcesDrawer from './FileReceiveSourcesDrawer'
import FileReceiveGuideDrawer from './FileReceiveGuideDrawer'
import {
  ACTIVE_STATUSES, FILE_ICON_COLOR, STATUS_META, formatDateInput,
  formatSize, formatTime,
} from './constants'

const PAGE_SIZE = 20

function defaultRange() {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 6)
  return { start: formatDateInput(start), end: formatDateInput(end) }
}

const INITIAL_DRAFT = {
  ...defaultRange(),
  source_code: '',
  status: '',
  file_ext: '',
  biz_type: '',
  keyword: '',
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, variant: 'neutral', spinning: false }
  return (
    <Badge variant={meta.variant}>
      {meta.spinning && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {meta.label}
    </Badge>
  )
}

function FileIcon({ ext }) {
  const cls = FILE_ICON_COLOR[ext] || 'text-muted-foreground'
  if (['zip', 'rar', '7z'].includes(ext)) return <FileArchive className={`h-4 w-4 shrink-0 ${cls}`} />
  return <FileText className={`h-4 w-4 shrink-0 ${cls}`} />
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function StatCard({ icon: Icon, label, value, hint, tone = 'text-primary' }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground">{value}</div>
          {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
        </div>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary ${tone}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
    </Card>
  )
}

function BizFieldsPreview({ fields }) {
  const entries = Object.entries(fields || {})
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {entries.slice(0, 2).map(([key, value]) => (
        <span
          key={key}
          className="inline-flex max-w-full items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`}
        >
          <span className="shrink-0 text-foreground/70">{key}</span>
          <span className="truncate">{Array.isArray(value) ? value.join(', ') : String(value)}</span>
        </span>
      ))}
      {entries.length > 2 && (
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">+{entries.length - 2}</span>
      )}
    </div>
  )
}

function ExpandedFields({ row }) {
  const entries = Object.entries(row.biz_fields || {})
  return (
    <div className="space-y-3">
      <div className="grid gap-x-8 gap-y-1 text-xs md:grid-cols-2 xl:grid-cols-4">
        <div><span className="text-muted-foreground">推送时间：</span>{formatTime(row.push_time)}</div>
        <div className="truncate"><span className="text-muted-foreground">Content-Type：</span>{row.content_type || '—'}</div>
        <div className="truncate md:col-span-2"><span className="text-muted-foreground">SHA-256：</span><span className="font-mono">{row.file_sha256}</span></div>
      </div>
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-medium text-foreground">全部业务字段</div>
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground">未携带扩展业务字段</div>
        ) : (
          <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
            {entries.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[140px_1fr] gap-2 py-0.5 text-xs">
                <span className="truncate text-muted-foreground" title={key}>{key}</span>
                <span className="min-w-0 break-words text-foreground">
                  {Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function FileReceiveRecords() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({
    today_total: 0, today_success: 0, success_rate: 0, today_bytes: 0, in_progress: 0,
  })
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [draft, setDraft] = useState(INITIAL_DRAFT)
  const [query, setQuery] = useState(INITIAL_DRAFT)
  const [meta, setMeta] = useState({ sources: [], statuses: [], biz_types: [], allowed_exts: [] })
  const [expandedKeys, setExpandedKeys] = useState([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [sourcesStartCreate, setSourcesStartCreate] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [actingId, setActingId] = useState(null)

  const canDownload = hasPermission('file_receive', 'download')
  const canManage = hasPermission('file_receive', 'manage')
  const canDelete = hasPermission('file_receive', 'delete')

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await fileReceiveApi.meta())
    } catch {
      // 元数据失败不阻断列表
    }
  }, [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const result = await fileReceiveApi.list({
        page,
        page_size: pageSize,
        start_time: query.start || undefined,
        end_time: query.end || undefined,
        source_code: query.source_code || undefined,
        status: query.status || undefined,
        file_ext: query.file_ext || undefined,
        biz_type: query.biz_type || undefined,
        keyword: query.keyword || undefined,
      })
      setItems(result.items || [])
      setTotal(result.total || 0)
      if (result.summary) setSummary(result.summary)
    } catch (err) {
      if (!silent) toast.error(err.message || '加载接收记录失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, pageSize, query])

  useEffect(() => { loadMeta() }, [loadMeta])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!items.some((row) => ACTIVE_STATUSES.has(row.status))) return undefined
    const timer = setInterval(() => { load(true) }, 5000)
    return () => clearInterval(timer)
  }, [items, load])

  const applyFilters = () => {
    setPage(1)
    setQuery({ ...draft })
  }

  const resetFilters = () => {
    const next = { ...INITIAL_DRAFT }
    setDraft(next)
    setQuery(next)
    setPage(1)
  }

  const openDetail = async (row) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    try {
      setDetail(await fileReceiveApi.detail(row.id))
    } catch (err) {
      toast.error(err.message || '加载详情失败')
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleDownload = async (row) => {
    setActingId(row.id)
    try {
      await fileReceiveApi.download(row.id, row.file_name)
    } catch (err) {
      toast.error(err.message || '下载失败')
    } finally {
      setActingId(null)
    }
  }

  const handleRetry = async (row) => {
    setActingId(row.id)
    try {
      await fileReceiveApi.retry(row.id)
      toast.success('已触发重试')
      await load()
      if (detailOpen && detail?.record?.id === row.id) {
        setDetail(await fileReceiveApi.detail(row.id))
      }
    } catch (err) {
      toast.error(err.message || '重试失败')
    } finally {
      setActingId(null)
    }
  }

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: `删除接收记录「${row.file_name}」？`,
      message: '仅删除平台记录，物理文件按保留策略清理；操作不可恢复。',
      confirmText: '确认删除',
    })
    if (!ok) return
    setActingId(row.id)
    try {
      await fileReceiveApi.remove(row.id)
      toast.success('记录已删除')
      if (detailOpen && detail?.record?.id === row.id) setDetailOpen(false)
      await load()
    } catch (err) {
      toast.error(err.message || '删除失败')
    } finally {
      setActingId(null)
    }
  }

  const openSources = (startCreate = false) => {
    setSourcesStartCreate(startCreate)
    setSourcesOpen(true)
  }

  const toggleExpand = (id) => {
    setExpandedKeys((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const sourceOptions = useMemo(() => meta.sources || [], [meta.sources])
  const statusOptions = useMemo(
    () => (meta.statuses?.length ? meta.statuses : Object.entries(STATUS_META).map(([value, v]) => ({ value, label: v.label }))),
    [meta.statuses],
  )

  const columns = [
    {
      key: 'expand',
      header: '',
      width: '38px',
      render: (row) => (
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); toggleExpand(row.id) }}
          aria-label={expandedKeys.includes(row.id) ? '收起业务字段' : '展开业务字段'}
        >
          {expandedKeys.includes(row.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ),
    },
    {
      key: 'request_id',
      header: '请求 ID',
      width: '150px',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-[11px]" title={row.request_id}>{row.request_id}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); copyText(row.request_id) }}
            aria-label="复制请求 ID"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      ),
    },
    {
      key: 'source',
      header: '来源系统',
      width: '150px',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{row.source_name}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{row.source_code}</div>
        </div>
      ),
    },
    {
      key: 'biz',
      header: '业务单号',
      width: '140px',
      render: (row) => (
        <span className="block truncate font-mono text-[11px]" title={row.biz_no}>{row.biz_no}</span>
      ),
    },
    {
      key: 'biz_fields',
      header: '业务字段',
      width: '210px',
      render: (row) => <BizFieldsPreview fields={row.biz_fields} />,
    },
    {
      key: 'file',
      header: '文件',
      width: '230px',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon ext={row.file_ext} />
          <div className="min-w-0">
            <div className="truncate text-xs" title={row.file_name}>{row.file_name}</div>
            <div className="text-[10px] text-muted-foreground">
              {String(row.file_ext || '').toUpperCase()} · {row.file_size > 0 ? formatSize(row.file_size) : '大小待完成统计'}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: '100px',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'completed_at',
      header: '接收完成时间',
      width: '150px',
      render: (row) => (
        <span className="text-[11px] text-muted-foreground">
          {row.completed_at
            ? formatTime(row.completed_at)
            : row.status === 'UPLOADING'
              ? (row.total_parts > 0 ? `已收 ${row.received_parts}/${row.total_parts} 片` : `已收 ${row.received_parts} 片`)
              : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: '150px',
      render: (row) => (
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => openDetail(row)} title="查看详情">
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {canDownload && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDownload(row)}
              disabled={!row.storage_path || actingId === row.id}
              title="下载文件"
            >
              {actingId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </Button>
          )}
          {canManage && row.status === 'FAILED' && row.retryable && (
            <Button variant="ghost" size="sm" onClick={() => handleRetry(row)} disabled={actingId === row.id} title="重试">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" size="sm" onClick={() => handleDelete(row)} disabled={actingId === row.id} title="删除">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <PageContainer>
      <PageHeader
        title="文件接收记录"
        extra={(
          <span className="text-xs text-muted-foreground">
            外部系统需先在「来源管理」生成密钥，并携带签名上传
          </span>
        )}
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => setGuideOpen(true)}>
              <BookOpen className="mr-1 h-3.5 w-3.5" /> 上传指导
            </Button>
            {canManage && (
              <Button variant="secondary" size="sm" onClick={() => openSources(false)}>
                <Settings2 className="mr-1 h-3.5 w-3.5" /> 来源管理
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </Button>
          </>
        )}
      />

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard icon={Inbox} label="今日接收" value={summary.today_total ?? 0} hint="按接收时间统计" />
          <StatCard
            icon={CheckCircle2}
            label="今日成功率"
            value={`${((summary.success_rate || 0) * 100).toFixed(1)}%`}
            hint={`成功 ${summary.today_success ?? 0} 笔`}
            tone="text-emerald-500"
          />
          <StatCard icon={Loader2} label="进行中" value={summary.in_progress ?? 0} hint="待上传/上传/合并/校验" tone="text-sky-500" />
          <StatCard icon={AlertCircle} label="今日失败" value={summary.today_failed ?? 0} hint="可在列表中重试" tone="text-destructive" />
          <StatCard icon={HardDrive} label="今日接收容量" value={formatSize(summary.today_bytes || 0)} hint="接收成功文件" tone="text-violet-500" />
        </div>

        <Card bodyClassName="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-36">
              <div className="mb-1 text-[11px] text-muted-foreground">开始日期</div>
              <input
                type="date"
                className={`${inputCls} h-8 text-xs`}
                value={draft.start}
                onChange={(e) => setDraft((prev) => ({ ...prev, start: e.target.value }))}
              />
            </div>
            <div className="w-36">
              <div className="mb-1 text-[11px] text-muted-foreground">结束日期</div>
              <input
                type="date"
                className={`${inputCls} h-8 text-xs`}
                value={draft.end}
                onChange={(e) => setDraft((prev) => ({ ...prev, end: e.target.value }))}
              />
            </div>
            <div className="w-44">
              <div className="mb-1 text-[11px] text-muted-foreground">来源系统</div>
              <CompactSelect block value={draft.source_code} onChange={(e) => setDraft((prev) => ({ ...prev, source_code: e.target.value }))}>
                <option value="">全部来源</option>
                {sourceOptions.map((s) => (
                  <option key={s.source_code} value={s.source_code}>{s.source_name}</option>
                ))}
              </CompactSelect>
            </div>
            <div className="w-36">
              <div className="mb-1 text-[11px] text-muted-foreground">状态</div>
              <CompactSelect block value={draft.status} onChange={(e) => setDraft((prev) => ({ ...prev, status: e.target.value }))}>
                <option value="">全部状态</option>
                {statusOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </CompactSelect>
            </div>
            <div className="w-32">
              <div className="mb-1 text-[11px] text-muted-foreground">文件类型</div>
              <CompactSelect block value={draft.file_ext} onChange={(e) => setDraft((prev) => ({ ...prev, file_ext: e.target.value }))}>
                <option value="">全部类型</option>
                {(meta.allowed_exts || []).map((ext) => (
                  <option key={ext} value={ext}>.{ext}</option>
                ))}
              </CompactSelect>
            </div>
            {(meta.biz_types || []).length > 1 && (
              <div className="w-36">
                <div className="mb-1 text-[11px] text-muted-foreground">业务类型</div>
                <CompactSelect block value={draft.biz_type} onChange={(e) => setDraft((prev) => ({ ...prev, biz_type: e.target.value }))}>
                  <option value="">全部业务</option>
                  {(meta.biz_types || []).map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </CompactSelect>
              </div>
            )}
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">关键词</div>
              <SearchInput
                className="w-64"
                value={draft.keyword}
                onChange={(value) => setDraft((prev) => ({ ...prev, keyword: value }))}
                onClear={() => setDraft((prev) => ({ ...prev, keyword: '' }))}
                placeholder="请求 ID / 文件名 / 业务单号"
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
              />
            </div>
            <Button variant="primary" size="sm" onClick={applyFilters}>查询</Button>
            <Button variant="secondary" size="sm" onClick={resetFilters}>
              <X className="mr-1 h-3.5 w-3.5" /> 重置
            </Button>
          </div>
        </Card>

        <Card bodyClassName="p-0">
          <DataTable
            columns={columns}
            data={items}
            loading={loading}
            rowKey="id"
            onRowClick={openDetail}
            rowClickHint="点击查看详情"
            expandedKeys={expandedKeys}
            renderExpandedRow={(row) => <ExpandedFields row={row} />}
            emptyIcon={Inbox}
            emptyText="暂无接收记录"
            emptyDescription="外部系统推送文件后，接收任务会显示在这里"
          />
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
            pageSizeOptions={[10, 20, 50, 100]}
          />
        </Card>
      </div>

      <FileReceiveDetailDrawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        detail={detail}
        loading={detailLoading}
        onDownload={handleDownload}
        onRetry={handleRetry}
        canDownload={canDownload}
        canManage={canManage}
      />

      <FileReceiveSourcesDrawer
        open={sourcesOpen}
        startCreate={sourcesStartCreate}
        onChanged={loadMeta}
        onClose={() => {
          setSourcesOpen(false)
          setSourcesStartCreate(false)
        }}
      />

      <FileReceiveGuideDrawer
        open={guideOpen}
        canManage={canManage}
        onClose={() => setGuideOpen(false)}
        onGoSources={() => {
          setGuideOpen(false)
          openSources(true)
        }}
      />
    </PageContainer>
  )
}
