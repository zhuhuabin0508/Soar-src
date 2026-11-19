// 数据源条目页：三层信息架构第二层（来源 IP 接入实例）
// 列表首列：来源 IP 或自定义名称；列含设备类型/绑定模板/所属接收器/今日接收与解析成功/三态状态/最近活跃。
// 点击行进入详情页（基本信息 / 解析模板 / 日志预览三 Tab）。支持 ?receiver= 按接收器筛选（接收器页跳转）。
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronRight, Inbox, ListTree, Radio, RefreshCw } from 'lucide-react'
import { toast } from '../../store/toastStore'
import { Drawer, Modal } from '../../components/Dialog'
import { devices as devicesApi } from '../../api/client'
import { Button, DataTable, Pagination, Badge, EmptyState } from '../../components/ui'
import FilterBar from '../../components/FilterBar'
import {
  SOURCE_TYPE_META, PROTOCOL_TAG_CLS, ENTRY_STATUS_META, DEVICE_TYPE_LABELS,
} from './receiverMeta'

const PAGE_SIZE = 20
const fmtCount = (n) => (n ?? 0).toLocaleString()
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—')

// 状态指标 chips：圆点色 + 激活态配色（规范：已接入=绿 / 待配置=橙 / 解析异常=红 / 已停用=灰）
const STATUS_CHIPS = [
  { key: 'active', label: '已接入', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
  { key: 'pending', label: '待配置', dot: 'bg-warning', active: 'bg-warning/15 text-warning ring-warning/40' },
  { key: 'parse_error', label: '解析异常', dot: 'bg-destructive', active: 'bg-destructive/15 text-destructive ring-destructive/40' },
  { key: 'disabled', label: '已停用', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40' },
]

// 绑定模板来源徽标
const BOUND_SOURCE_LABELS = {
  entry: { label: '条目', cls: 'bg-primary/15 text-primary', title: '条目级固定模板（优先级最高）' },
  receiver: { label: '接收器', cls: 'bg-secondary text-muted-foreground', title: '跟随所属接收器的默认模板' },
  auto: { label: '自动', cls: 'bg-cyan-500/15 text-cyan-400', title: '由系统按元数据/特征自动匹配模板' },
}

export default function SourceEntryList() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [receivers, setReceivers] = useState([])
  const [items, setItems] = useState([])
  const [statusCounts, setStatusCounts] = useState({ pending: 0, active: 0, parse_error: 0, disabled: 0 })
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  // 筛选：接收器（URL ?receiver= 预置）、状态、搜索
  const [receiverId, setReceiverId] = useState(() => searchParams.get('receiver') || '')
  const [status, setStatus] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await devicesApi.logReceivers.entriesGlobal({
        page, page_size: PAGE_SIZE,
        receiver_id: receiverId || undefined,
        status: status || undefined,
        search: search || undefined,
      })
      setItems(res?.items || [])
      setTotal(res?.total || 0)
      setStatusCounts(res?.status_counts || statusCounts)
    } catch (err) {
      toast.error(err.message || '加载数据源条目失败')
    } finally {
      setLoading(false)
    }
  }, [page, receiverId, status, search]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  // 接收器下拉（筛选用）
  useEffect(() => {
    devicesApi.logReceivers.list()
      .then((res) => setReceivers(Array.isArray(res) ? res : res?.items || []))
      .catch(() => {})
  }, [])

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setSearch(searchInput.trim()) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const applyFilter = (setter) => (v) => { setter(v); setPage(1) }

  // 是否存在筛选条件（空态区分「无数据」与「筛选无结果」两分）
  const hasFilter = !!(receiverId || status || search)
  const clearFilters = () => {
    setSearchInput('')
    setSearch('')
    setReceiverId('')
    setStatus('')
    setPage(1)
  }

  // 失败样本原文查看
  const [sampleView, setSampleView] = useState(null)

  // 失败样本下钻抽屉（今日接收/解析成功列点击：原因四分类 + 按原因筛选）
  const [drill, setDrill] = useState(null) // { entryId, name }
  const [drillData, setDrillData] = useState(null)
  const [drillReason, setDrillReason] = useState('')
  const [drillPage, setDrillPage] = useState(1)
  const [drillLoading, setDrillLoading] = useState(false)

  // 失败样本下钻：该来源条目起失败明细 + 原因分类统计（分页，可按原因筛选）
  const loadDrill = useCallback((entryId, reason, page) => {
    setDrillLoading(true)
    devicesApi.logReceivers.entryFailureSamples(entryId, { reason, page, page_size: 15 })
      .then((res) => { setDrillData(res); setDrillPage(page) })
      .catch((e) => toast.error(e.message || '失败样本加载失败'))
      .finally(() => setDrillLoading(false))
  }, [])

  const openDrill = (row) => {
    setDrill({ entryId: row.id, name: row.name !== row.source_ip ? row.name : row.source_ip })
    setDrillReason('')
    setDrillData(null)
    loadDrill(row.id, '', 1)
  }

  const applyDrillReason = (reason) => {
    const next = reason === drillReason ? '' : reason
    setDrillReason(next)
    if (drill) loadDrill(drill.entryId, next, 1)
  }

  const columns = [
    {
      key: 'name', header: '来源 IP / 名称', width: '210px',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold">
            {r.name !== r.source_ip ? r.name : r.source_ip}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={r.source_ip}>
            {r.name !== r.source_ip ? r.source_ip : (r.auto_created ? '自动发现' : '手工创建')}
          </div>
        </div>
      ),
    },
    {
      key: 'device_type', header: '设备类型', width: '110px',
      render: (r) => (r.device_type
        ? <span className="text-xs">{DEVICE_TYPE_LABELS[r.device_type] || r.device_type}</span>
        : <span className="text-xs text-muted-foreground" title="未绑定设备">--</span>),
    },
    {
      key: 'strategy', header: '绑定模板', width: '180px',
      render: (r) => {
        const src = BOUND_SOURCE_LABELS[r.bound_strategy_source] || BOUND_SOURCE_LABELS.auto
        return (
          <div className="flex min-w-0 items-center gap-1.5">
            {r.bound_strategy_name ? (
              <>
                <span className="truncate text-xs" title={`${src.title} · ${r.bound_strategy_name}`}>{r.bound_strategy_name}</span>
                <span className={`shrink-0 rounded px-1 py-0.5 text-xs font-medium ${src.cls}`} title={src.title}>{src.label}</span>
              </>
            ) : (
              <span className="rounded px-1 py-0.5 text-xs font-medium text-cyan-400" title="由系统按元数据/特征自动匹配模板">自动匹配</span>
            )}
          </div>
        )
      },
    },
    {
      key: 'receiver', header: '所属接收器', width: '170px',
      render: (r) => (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs" title={r.receiver_name}>{r.receiver_name}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${PROTOCOL_TAG_CLS[r.receiver_protocol] || 'bg-secondary text-muted-foreground'}`}>
            {SOURCE_TYPE_META[r.receiver_protocol]?.label || r.receiver_protocol}
          </span>
        </div>
      ),
    },
    {
      key: 'today', header: '今日接收 / 解析成功', width: '150px', numeric: true,
      render: (r) => (
        <button
          type="button"
          disabled={!r.today_received}
          onClick={(e) => { e.stopPropagation(); openDrill(r) }}
          title={r.today_received
            ? '点击查看该条目的失败样本与原因分类'
            : '今日暂无接收，无失败样本'}
          className={`rounded px-1 py-0.5 -mx-1 tabular-nums transition ${
            r.today_received
              ? 'cursor-pointer hover:bg-primary/10 hover:text-primary'
              : 'cursor-default'}`}
        >
          <span className={r.today_received ? '' : 'text-muted-foreground'}>{fmtCount(r.today_received)}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className={r.today_received && !r.today_parsed ? 'text-destructive' : r.today_parsed ? '' : 'text-muted-foreground'}>
            {fmtCount(r.today_parsed)}
          </span>
        </button>
      ),
    },
    {
      key: 'status', header: '状态', width: '100px',
      render: (r) => {
        const st = ENTRY_STATUS_META[r.status] || { label: r.status, cls: 'bg-secondary text-muted-foreground' }
        return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${st.cls}`} title={st.desc}>{st.label}</span>
      },
    },
    {
      key: 'last_received_at', header: '最近活跃', width: '150px',
      render: (r) => <span className="text-xs text-muted-foreground">{fmtTime(r.last_received_at)}</span>,
    },
    {
      key: 'go', header: '', width: '50px',
      render: () => <ChevronRight className="h-4 w-4 text-muted-foreground" />,
    },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">数据源条目</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{fmtCount(total)}</span> 个条目
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">接收器按来源 IP 自动发现的接入实例</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新数据源条目">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {/* 筛选栏：搜索 + 接收器 + 状态 */}
        <FilterBar
          search={{ value: searchInput, onChange: setSearchInput, placeholder: '搜索来源 IP / 名称' }}
          filters={[
            {
              key: 'receiver', label: '接收器', value: receiverId,
              onChange: applyFilter(setReceiverId),
              options: [{ value: '', label: '全部接收器' }, ...receivers.map((r) => ({ value: r.id, label: r.name }))],
            },
            {
              key: 'status', label: '状态', value: status,
              onChange: applyFilter(setStatus),
              options: [{ value: '', label: '全部状态' }, ...Object.entries(ENTRY_STATUS_META).map(([v, m]) => ({ value: v, label: m.label }))],
            },
          ]}
        />

        {/* 状态指标条：状态分布（点击快速筛选，再点取消）+ 汇总指标 */}
        {!loading && total > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {STATUS_CHIPS.map((chip) => {
              const active = status === chip.key
              const count = statusCounts[chip.key] ?? 0
              return (
                <button
                  key={chip.key} type="button"
                  onClick={() => applyFilter(setStatus)(active ? '' : chip.key)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    active
                      ? `border-transparent ring-1 ${chip.active}`
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  title={active ? '点击取消该状态筛选' : `点击筛选「${chip.label}」的条目`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                      chip.key === 'active' && count > 0 ? 'animate-pulse' : ''
                    }`}
                  />
                  {chip.label}
                  <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{fmtCount(count)}</span>
                </button>
              )
            })}
            <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5" title="当前已配置的接收器数量">
                <Radio className="h-3.5 w-3.5 text-primary/80" />
                接收器
                <span
                  className={`font-semibold tabular-nums ${
                    receivers.length > 0 ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {receivers.length > 0 ? fmtCount(receivers.length) : '--'}
                </span>
              </span>
            </div>
          </div>
        )}

        {/* 条目列表 */}
        <div className="overflow-hidden rounded-lg border border-border">
          <DataTable
            className="table-stagger"
            columns={columns}
            data={items}
            loading={loading}
            rowKey="id"
            onRowClick={(r) => navigate(`/source-entries/${r.id}`)}
            rowClickHint="点击查看条目详情"
            emptyIcon={ListTree}
            emptyText={hasFilter ? '未找到匹配的数据源条目' : '暂无数据源条目'}
            emptyDescription={hasFilter
              ? '调整关键词或清除筛选条件后再试'
              : '请先在「接收器」页配置监听端点，设备日志到达后按来源 IP 自动生成条目'}
            emptyAction={hasFilter ? (
              <button type="button" onClick={clearFilters} className="btn-secondary btn-sm">清除筛选</button>
            ) : (
              <button type="button" onClick={() => navigate('/receivers')} className="btn-primary btn-sm">
                <Radio className="mr-1 h-3.5 w-3.5" /> 前往接收器配置
              </button>
            )}
          />
        </div>
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      </div>

      {/* 失败样本下钻抽屉（今日接收/解析成功列点击）：原因四分类 + 按原因筛选 */}
      <Drawer
        open={!!drill}
        title={drill ? `失败样本下钻 · ${drill.name}` : ''}
        onClose={() => setDrill(null)}
        width="w-[760px]"
        footer={drillData && (
          <div className="flex w-full items-center justify-between">
            <span className="text-xs text-muted-foreground">
              共 {drillData.total} 条{drillReason ? ` · 已按「${drillData.reason_labels?.[drillReason] || drillReason}」筛选` : ' · 点击上方原因标签可筛选'}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={drillPage <= 1 || drillLoading} onClick={() => loadDrill(drill.entryId, drillReason, drillPage - 1)}>上一页</Button>
              <Button size="sm" variant="ghost" disabled={drillPage * 15 >= drillData.total || drillLoading} onClick={() => loadDrill(drill.entryId, drillReason, drillPage + 1)}>下一页</Button>
            </div>
          </div>
        )}
      >
        {drillLoading && !drillData ? (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        ) : !drillData ? (
          <EmptyState icon={Inbox} title="暂无失败样本" description="该来源条目没有解析失败的原始日志留存" />
        ) : (
          <div className="space-y-4">
            {/* 原因分类统计（点击筛选，再点取消） */}
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(drillData.stats || {}).map(([k, n]) => {
                const active = drillReason === k
                return (
                  <button
                    key={k}
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      active ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}
                    title="点击按此原因筛选"
                    onClick={() => applyDrillReason(k)}
                  >
                    {drillData.reason_labels?.[k] || k}
                    <span className={`ml-1.5 tabular-nums ${n > 0 ? (k === 'no_template' || k === 'other' ? 'text-destructive' : 'text-warning') : 'text-muted-foreground'}`}>
                      {n.toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* 样本列表 */}
            {(drillData.items || []).length === 0 ? (
              <EmptyState icon={Inbox} title="当前筛选条件下没有失败样本" description="更换原因分类或清除筛选查看全部" />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted text-left text-muted-foreground">
                      <th className="px-2 py-2 font-semibold">失败原因</th>
                      <th className="px-2 py-2 font-semibold">解析状态</th>
                      <th className="px-2 py-2 font-semibold">错误信息</th>
                      <th className="px-2 py-2 font-semibold">接收时间</th>
                      <th className="px-2 py-2 font-semibold">原文</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.items.map((it) => (
                      <tr key={it.id} className="border-b border-border transition last:border-0 hover:bg-accent">
                        <td className="px-2 py-2"><Badge variant="danger">{it.reason_label}</Badge></td>
                        <td className="px-2 py-2 font-mono text-muted-foreground">{it.parse_status || '-'}</td>
                        <td className="max-w-[240px] truncate px-2 py-2 text-muted-foreground" title={it.error_msg}>{it.error_msg || '-'}</td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{fmtTime(it.received_at)}</td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="rounded px-1.5 py-0.5 text-xs text-primary transition hover:bg-primary/10"
                            title="查看失败样本原始日志"
                            onClick={() => setSampleView({ reason_label: it.reason_label, error_msg: it.error_msg, raw_data: it.raw_data })}
                          >
                            查看
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Drawer>

      {/* 失败样本原文查看 */}
      <Modal
        open={!!sampleView}
        title="失败样本原文"
        onClose={() => setSampleView(null)}
        size="lg"
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Badge variant="danger">{sampleView?.reason_label}</Badge>
            <span className="min-w-0 flex-1 break-all">{sampleView?.error_msg}</span>
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {sampleView?.raw_data || '（无原始数据）'}
          </pre>
        </div>
      </Modal>
    </div>
  )
}
