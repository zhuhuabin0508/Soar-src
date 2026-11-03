// 封禁工作流实例管理页：统计卡片 + 熔断状态 + 筛选区 + 分页表格 + 节点时间线详情抽屉
// 支持按状态/IP/时间范围/触发规则筛选；运行中实例可手动取消（已下发封禁的不可取消）
import { useState, useEffect, useCallback } from 'react'
import {
  Zap, ShieldBan, Clock4, AlertTriangle, RotateCw, Search, Ban,
  CheckCircle2, XCircle, MinusCircle, Loader2, ShieldAlert, Inbox, Activity,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import {Button, PageContainer, PageHeader, Card, DataTable, Badge, Pagination, EmptyState, CompactSelect, DatePicker, AutoGrowTextarea } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'

const STATUS_OPTIONS = [
  { v: 'running', label: '运行中' }, { v: 'waiting_approval', label: '等待审批' },
  { v: 'success', label: '已完成' }, { v: 'error', label: '异常' },
  { v: 'skipped', label: '已跳过' }, { v: 'cancelled', label: '已取消' }, { v: 'escalated', label: '已升级' },
]
const STATUS_VARIANT = {
  running: 'info', waiting_approval: 'warning', success: 'success', error: 'danger',
  skipped: 'neutral', cancelled: 'neutral', escalated: 'danger',
}
const NODE_STATUS_ICON = {
  success: CheckCircle2, fail: XCircle, skipped: MinusCircle, running: Loader2, pending: Clock4,
}
const NODE_STATUS_CLS = {
  success: 'text-success', fail: 'text-destructive', skipped: 'text-muted-foreground',
  running: 'text-info animate-spin', pending: 'text-muted-foreground',
}

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')
const fmtMs = (ms) => {
  if (ms == null) return '--'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

// 统计卡片
function StatCard({ icon: Icon, label, value, valueClass }) {
  return (
    <div className="card flex items-center gap-3 px-5 py-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className={`mt-0.5 text-xl font-semibold tabular-nums ${valueClass || 'text-foreground'}`}>{value}</div>
      </div>
    </div>
  )
}

// 节点时间线（详情抽屉内）
function NodeTimeline({ nodes }) {
  if (!nodes.length) return <div className="py-8 text-center text-sm text-muted-foreground">暂无节点执行记录</div>
  return (
    <div className="space-y-0">
      {nodes.map((n, idx) => {
        const Icon = NODE_STATUS_ICON[n.status] || Clock4
        return (
          <div key={n.id} className="relative flex gap-3 pb-4">
            {idx < nodes.length - 1 && <div className="absolute top-6 left-[11px] h-full w-px bg-border" />}
            <div className={`z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted ${NODE_STATUS_CLS[n.status] || ''}`}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{n.node_name}</span>
                <Badge variant={n.status === 'success' ? 'success' : n.status === 'fail' ? 'danger' : 'neutral'}>
                  {n.status === 'success' ? '成功' : n.status === 'fail' ? '失败' : n.status === 'skipped' ? '跳过' : n.status}
                </Badge>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtMs(n.duration_ms)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{fmtTime(n.start_time)}</span>
                {n.end_time && <span>→ {fmtTime(n.end_time)}</span>}
              </div>
              {n.error_msg && (
                <div className="mt-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{n.error_msg}</div>
              )}
              {n.output != null && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer select-none text-xs text-muted-foreground transition hover:text-foreground">节点输出</summary>
                  <pre className="mt-1 max-h-52 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                    {typeof n.output === 'string' ? n.output : JSON.stringify(n.output, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// 智能体调用记录（含 token 消耗与完整请求响应）
function AgentInvocations({ invocations }) {
  if (!invocations.length) return null
  return (
    <div className="space-y-3">
      {invocations.map((a) => (
        <div key={a.id} className="rounded-lg border border-border bg-muted p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">调用 #{a.id}</span>
            <Badge variant={a.status === 'success' ? 'success' : 'danger'}>{a.status === 'success' ? '成功' : '失败'}</Badge>
            {a.model_name && <span className="text-muted-foreground">模型：{a.model_name}</span>}
            {a.input_tokens != null && <span className="text-muted-foreground">输入 {a.input_tokens} tokens</span>}
            {a.output_tokens != null && <span className="text-muted-foreground">输出 {a.output_tokens} tokens</span>}
            <span className="ml-auto font-mono text-muted-foreground">{fmtMs(a.duration_ms)}</span>
          </div>
          {a.error_msg && <div className="mt-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{a.error_msg}</div>}
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            <details open>
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">请求体</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                {typeof a.request_body === 'string' ? a.request_body : JSON.stringify(a.request_body, null, 2)}
              </pre>
            </details>
            <details open={!a.error_msg}>
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">响应体</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                {a.response_body ? (typeof a.response_body === 'string' ? a.response_body : JSON.stringify(a.response_body, null, 2)) : '--'}
              </pre>
            </details>
          </div>
        </div>
      ))}
    </div>
  )
}

function JsonBlock({ title, data }) {
  if (!data) return null
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

export default function BanWorkflowInstances({ embedded = false }) {
  const canEdit = hasPermission('ban_workflow', 'edit')
  const [filters, setFilters] = useState({ status: '', ip: '', rule_id: '', start_time: '', end_time: '', keyword: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [list, setList] = useState({ total: 0, items: [] })
  const [rules, setRules] = useState([])
  const [stats, setStats] = useState(null)
  const [circuit, setCircuit] = useState(null)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState(null) // 实例详情
  const [detailLoading, setDetailLoading] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [resetting, setResetting] = useState(false)

  const setF = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(1) }

  const load = useCallback(() => {
    setLoading(true)
    banWorkflowApi.instances({ ...filters, page, page_size: pageSize })
      .then((res) => setList({ total: res.total || 0, items: res.items || [] }))
      .catch((e) => toast.error(e.message || '实例列表加载失败'))
      .finally(() => setLoading(false))
  }, [filters, page])

  const loadMeta = useCallback(() => {
    banWorkflowApi.rules().then(setRules).catch(() => {})
    banWorkflowApi.stats().then((s) => { setStats(s); setCircuit(s.circuit) }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadMeta() }, [loadMeta])

  const openDetail = (id) => {
    setDetailLoading(true)
    setDetail({ id })
    banWorkflowApi.instance(id)
      .then(setDetail)
      .catch((e) => { toast.error(e.message || '实例详情加载失败'); setDetail(null) })
      .finally(() => setDetailLoading(false))
  }

  const doCancel = () => {
    if (!cancelTarget) return
    banWorkflowApi.cancelInstance(cancelTarget.id, cancelReason || '手动取消')
      .then(() => {
        toast.success(`实例 #${cancelTarget.id} 已取消`)
        setCancelTarget(null); setCancelReason('')
        load()
      })
      .catch((e) => toast.error(e.message || '取消失败'))
  }

  const doResetCircuit = () => {
    setResetting(true)
    banWorkflowApi.resetCircuitBreaker()
      .then(() => { toast.success('熔断已恢复，工作流恢复触发'); loadMeta() })
      .catch((e) => toast.error(e.message || '恢复失败'))
      .finally(() => setResetting(false))
  }

  const columns = [
    { key: 'id', header: '实例ID', width: '80px', render: (r) => <span className="font-mono text-[13px]">#{r.id}</span> },
    {
      key: 'alert_name', header: '触发告警', width: '200px',
      render: (r) => (
        <button className="max-w-[190px] truncate text-left font-medium text-foreground transition hover:text-primary" title={r.alert_name} onClick={(e) => { e.stopPropagation(); openDetail(r.id) }}>
          {r.alert_name || r.alert_uuid || '--'}
        </button>
      ),
    },
    { key: 'src_ip', header: '源IP', width: '140px', render: (r) => <span className="font-mono text-[13px]">{r.src_ip || '--'}</span> },
    {
      key: 'status', header: '状态', width: '100px',
      render: (r) => <Badge variant={STATUS_VARIANT[r.status] || 'neutral'}>{r.status_label}</Badge>,
    },
    { key: 'current_node', header: '当前节点', width: '110px', render: (r) => <span className="truncate text-muted-foreground">{r.current_node_label || '--'}</span> },
    {
      key: 'final_result', header: '处置结果', width: '100px',
      render: (r) => r.final_result_label ? <Badge variant={r.final_result === 'banned' ? 'danger' : r.final_result === 'monitoring' ? 'info' : 'neutral'}>{r.final_result_label}</Badge> : <span className="text-muted-foreground">--</span>,
    },
    { key: 'trigger_rule', header: '触发规则', width: '130px', render: (r) => <span className="truncate text-muted-foreground">{r.trigger_rule_name || '--'}</span> },
    { key: 'duration', header: '耗时', width: '80px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{fmtMs(r.duration_ms)}</span> },
    { key: 'created_at', header: '创建时间', width: '150px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{fmtTime(r.created_at)}</span> },
    {
      key: 'actions', header: '操作', width: '110px',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-primary" title="详情" onClick={() => openDetail(r.id)}>
            <Search className="h-4 w-4" />
          </button>
          {canEdit && !['success', 'error', 'skipped', 'cancelled', 'escalated'].includes(r.status) && !(r.status === 'success' && r.final_result === 'banned') && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-destructive" title="取消实例" onClick={() => setCancelTarget(r)}>
              <Ban className="h-4 w-4" />
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
      {!embedded && (
        <PageHeader
          title="封禁工作流实例"
          description="告警入库自动触发的 IP 风险研判与封禁实例：全链路节点日志、智能体调用与处置结果可审计"
          actions={(
            <Button size="sm" variant="ghost" onClick={() => { load(); loadMeta() }}>
              <RotateCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          )}
        />
      )}

      {/* 统计卡片 */
      }
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Zap} label="今日触发实例" value={stats?.today_instances ?? '--'} />
        <StatCard icon={ShieldBan} label="今日自动封禁" value={stats?.today_auto_bans ?? '--'} valueClass="text-destructive" />
        <StatCard icon={Clock4} label="待审批工单" value={stats?.pending_approvals ?? '--'} valueClass={(stats?.pending_approvals ?? 0) > 0 ? 'text-warning' : 'text-foreground'} />
        <StatCard icon={AlertTriangle} label="今日异常实例" value={stats?.today_errors ?? '--'} valueClass={(stats?.today_errors ?? 0) > 0 ? 'text-destructive' : 'text-foreground'} />
      </div>

      {/* 熔断告警条 */}
      {circuit?.paused && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-destructive">熔断已触发：智能体研判连续失败 {circuit.fail_streak} 次，新实例触发已暂停</div>
            <div className="mt-0.5 text-xs text-muted-foreground">请检查智能体服务后点击「恢复触发」，恢复后新告警将继续自动研判</div>
          </div>
          {canEdit && (
            <Button variant="primary" size="sm" loading={resetting} onClick={doResetCircuit}>恢复触发</Button>
          )}
        </div>
      )}

      {/* 筛选区 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <CompactSelect size="lg" className="w-[130px]" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
            <option value="">全部状态</option>
            {STATUS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </CompactSelect>
          <CompactSelect size="lg" className="w-[150px]" value={filters.rule_id} onChange={(e) => setF({ rule_id: e.target.value })}>
            <option value="">全部触发规则</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.rule_name}</option>)}
          </CompactSelect>
          <DatePicker type="datetime" value={filters.start_time} onChange={(e) => setF({ start_time: e.target.value })} />
          <span className="text-xs text-muted-foreground">至</span>
          <DatePicker type="datetime" value={filters.end_time} onChange={(e) => setF({ end_time: e.target.value })} />
          <input className={`${inputBaseCls} h-[34px] w-[200px]`} placeholder="IP / 告警UUID" value={filters.keyword} onChange={(e) => setF({ keyword: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') load() }} />
        </div>
      </Card>

      {/* 实例表格 */}
      <Card className="p-0" bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={list.items}
          loading={loading}
          rowKey="id"
          selectable={false}
          onRowClick={(r) => openDetail(r.id)}
          emptyText="暂无工作流实例"
          emptyDescription="告警入库后命中触发规则将自动创建实例"
          emptyIcon={Inbox}
        />
        <div className="px-4">
          <Pagination page={page} pageSize={pageSize} total={list.total} onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} pageSizeOptions={[10, 20, 50, 100]} />
        </div>
      </Card>
    </>
  )

  return (
    <>
      {embedded ? content : (
        <PageContainer>
          {content}
        </PageContainer>
      )}

      {/* 详情抽屉：节点时间线 + 智能体调用 + 审批/封禁/监控记录 */}
      <Modal open={!!detail} size="lg" maxWidth="max-w-4xl" title={t ? `实例 #${t.id} · ${t.status_label}` : '实例详情'} onClose={() => setDetail(null)}>
        {detailLoading || !t ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
        ) : (
          <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
            {/* 基础信息 */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-muted p-3 text-sm lg:grid-cols-3">
              <div><span className="text-muted-foreground">源IP：</span><span className="font-mono">{t.src_ip || '--'}</span></div>
              <div className="truncate" title={t.alert_name}><span className="text-muted-foreground">触发告警：</span>{t.alert_name || '--'}</div>
              <div><span className="text-muted-foreground">处置结果：</span>{t.final_result_label || '--'}</div>
              <div className="truncate lg:col-span-2" title={t.alert_uuid}><span className="text-muted-foreground">告警UUID：</span><span className="font-mono text-xs">{t.alert_uuid || '--'}</span></div>
              <div><span className="text-muted-foreground">总耗时：</span><span className="font-mono">{fmtMs(t.duration_ms)}</span></div>
              <div><span className="text-muted-foreground">开始：</span><span className="font-mono text-xs">{fmtTime(t.started_at)}</span></div>
              <div><span className="text-muted-foreground">结束：</span><span className="font-mono text-xs">{fmtTime(t.finished_at)}</span></div>
            </div>
            {t.error_msg && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t.error_msg}</div>
            )}

            {/* 节点时间线 */}
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Activity className="h-4 w-4 text-primary" /> 节点执行时间线
              </div>
              <NodeTimeline nodes={t.node_logs || []} />
            </div>

            {/* 智能体调用记录 */}
            {(t.agent_invocations || []).length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Zap className="h-4 w-4 text-primary" /> 智能体调用记录（含 token 消耗）
                </div>
                <AgentInvocations invocations={t.agent_invocations} />
              </div>
            )}

            {/* 审批 / 封禁 / 监控记录 */}
            {t.approval_ticket && (
              <div>
                <div className="mb-1.5 text-sm font-semibold text-foreground">审批记录</div>
                <div className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    <div><span className="text-muted-foreground">工单：</span>#{t.approval_ticket.id}</div>
                    <div><span className="text-muted-foreground">状态：</span>{t.approval_ticket.status}</div>
                    <div><span className="text-muted-foreground">审批人：</span>{t.approval_ticket.approver || '--'}</div>
                    <div><span className="text-muted-foreground">时间：</span><span className="font-mono text-xs">{fmtTime(t.approval_ticket.approved_at)}</span></div>
                  </div>
                  {t.approval_ticket.approval_comment && <div className="text-muted-foreground">意见：{t.approval_ticket.approval_comment}</div>}
                </div>
              </div>
            )}
            {t.ban_record && (
              <div>
                <div className="mb-1.5 text-sm font-semibold text-foreground">封禁记录</div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-border bg-muted p-3 text-sm">
                  <div><span className="text-muted-foreground">IP：</span><span className="font-mono">{t.ban_record.ip}</span></div>
                  <div><span className="text-muted-foreground">等级：</span>{t.ban_record.ban_level}</div>
                  <div><span className="text-muted-foreground">时长：</span>{t.ban_record.is_permanent ? '永久' : `${Math.round((t.ban_record.ban_duration || 0) / 60)} 分钟`}</div>
                  <div><span className="text-muted-foreground">状态：</span>{t.ban_record.status}</div>
                  <div><span className="text-muted-foreground">工具记录：</span><span className="font-mono text-xs">{t.ban_record.record_id || '--'}</span></div>
                  <div><span className="text-muted-foreground">到期：</span><span className="font-mono text-xs">{fmtTime(t.ban_record.expire_time)}</span></div>
                </div>
              </div>
            )}
            {t.monitor_log && (
              <div>
                <div className="mb-1.5 text-sm font-semibold text-foreground">持续监控记录</div>
                <div className="rounded-lg border border-border bg-muted p-3 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    <div><span className="text-muted-foreground">IP：</span><span className="font-mono">{t.monitor_log.ip}</span></div>
                    <div><span className="text-muted-foreground">风险等级：</span>{t.monitor_log.risk_level || '--'}</div>
                  </div>
                  {t.monitor_log.advice && <div className="mt-1 text-muted-foreground">建议：{t.monitor_log.advice}</div>}
                  <JsonBlock title="研判原因" data={t.monitor_log.reasons} />
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 取消实例确认 */}
      <Modal
        open={!!cancelTarget}
        title={`取消实例 #${cancelTarget?.id || ''}`}
        onClose={() => { setCancelTarget(null); setCancelReason('') }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setCancelTarget(null); setCancelReason('') }}>再想想</Button>
            <Button variant="danger" onClick={doCancel}>确认取消</Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          <div>取消后该实例终止执行，关联的待审批工单将一并关闭。已下发封禁的实例不可取消，请前往封禁工作台解封。</div>
          <AutoGrowTextarea
            className={`${inputBaseCls} min-h-[72px] w-full`}
            placeholder="取消原因（可选）"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </div>
      </Modal>
    </>
  )
}
