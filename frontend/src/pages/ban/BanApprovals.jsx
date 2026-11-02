// 统一审批中心：合并「封禁审批工单」与「工作流人工审批」两个来源
// 待审批（默认）/ 已处理 / 已超时 三个子 Tab + 关键词筛选 + 来源标识
// 封禁工单：同意 → 执行封禁；驳回（需填原因）→ 转持续监控；升级 → 转人工调查
// 工作流工单：同意 / 驳回（唤醒 Celery 阻塞任务继续执行）
import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2, XCircle, ArrowUpCircle, Search, Inbox, Clock4, Loader2, RotateCw, ShieldQuestion, Workflow as WorkflowIcon, ShieldBan, Trash2,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { confirm } from '../../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, Card, DataTable, Badge, Pagination } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'
import { getApprovals, approveExecution, rejectExecution, deleteExecution } from '../../api/approvals'

const TABS = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已处理' },
  { key: 'timeout', label: '已超时' },
]
const TICKET_VARIANT = {
  pending: 'warning', approved: 'success', rejected: 'danger', escalated: 'danger', timeout: 'neutral',
}
const ACTION_LABELS = { ban: '封禁', monitor: '持续监控' }

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')
const fmtRemaining = (ms) => {
  if (ms == null) return '--'
  if (ms <= 0) return '已超时'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}
const fmtDuration = (sec) => {
  if (sec == null) return '--'
  if (sec >= 86400) return `${Math.round(sec / 86400)} 天`
  if (sec >= 3600) return `${Math.round(sec / 3600)} 小时`
  return `${Math.round(sec / 60)} 分钟`
}
const riskVariant = (level) => (
  { 严重: 'danger', 高危: 'danger', 中危: 'warning', 低危: 'info' }[level] || 'neutral'
)

// 旧工作流审批项 → 统一行结构（source: 'workflow'）
function mapWorkflowItem(it) {
  const alert = it.alert_data || {}
  const decision = it.agent_decision || {}
  const ctxPayload = it.context?.payload || {}
  const outcome = it.review_meta?.outcome || it.context?.outcome
  return {
    source: 'workflow',
    id: `wf-${it.execution_id}`,
    execution_id: it.execution_id,
    workflow_name: it.workflow_name,
    ip: alert.src_ip || ctxPayload.src_ip || '',
    risk_level: alert.risk_level_name || alert.risk_level || '',
    alert_name: alert.alert_name || alert.alert_type || it.workflow_name || '工作流审批',
    action: decision.action || '',
    need_confirm: true,
    is_permanent: false,
    ban_duration: null,
    created_at: it.created_at,
    remaining_ms: null,
    status: it.status === 'waiting_for_approval' ? 'pending' : (outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'approved'),
    status_label: it.status === 'waiting_for_approval' ? '待审批' : outcome === 'approved' ? '已同意' : outcome === 'rejected' ? '已驳回' : '已处理',
    raw: it,
  }
}

function DetailSection({ title, data }) {
  if (!data) return null
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

export default function BanApprovals({ embedded = false }) {
  const canApprove = hasPermission('approval', 'approve')
  // 删除按钮按工单来源分流：工作流工单需 approval:delete，封禁工单需 ban_workflow:delete
  const canDeleteWf = hasPermission('approval', 'delete')
  const canDeleteBan = hasPermission('ban_workflow', 'delete')
  const [tab, setTab] = useState('pending')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [list, setList] = useState({ total: 0, items: [], counts: {} })
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // 审批操作弹窗：{type: 'approve'|'reject'|'escalate', ticket}
  const [action, setAction] = useState(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    // 并行拉取：封禁工单（服务端分页） + 旧工作流审批（客户端合并）
    const banP = banWorkflowApi.approvals({ tab, keyword, page, page_size: pageSize })
    const wfP = getApprovals({ status: 'all', limit: 200 }).catch(() => [])
    Promise.all([banP, wfP])
      .then(([banRes, wfItems]) => {
        // 旧工作流项按子 Tab 过滤 + 关键词过滤
        let wf = (wfItems || []).map(mapWorkflowItem)
        if (tab === 'pending') {
          wf = wf.filter((x) => x.status === 'pending')
        } else if (tab === 'approved') {
          wf = wf.filter((x) => x.status !== 'pending' && x.status !== 'timeout')
        } else {
          wf = []
        }
        if (keyword) {
          const k = keyword.toLowerCase()
          wf = wf.filter((x) => (x.ip || '').toLowerCase().includes(k) || (x.alert_name || '').toLowerCase().includes(k) || (x.workflow_name || '').toLowerCase().includes(k))
        }
        // 合并：旧工单置顶（通常量少），再接封禁工单当前页
        const items = [...wf, ...(banRes.items || []).map((x) => ({ ...x, source: 'ban' }))]
        setList({ total: (banRes.total || 0) + wf.length, items, counts: banRes.counts || {} })
      })
      .catch((e) => toast.error(e.message || '审批列表加载失败'))
      .finally(() => setLoading(false))
  }, [tab, keyword, page])

  useEffect(() => { load() }, [load])

  const openDetail = (row) => {
    // 工作流工单：直接用行内 raw 渲染；封禁工单：拉取详情接口
    if (row.source === 'workflow') {
      setDetail({ ...row, isWorkflow: true })
      return
    }
    setDetailLoading(true)
    setDetail({ id: row.id })
    banWorkflowApi.approval(row.id)
      .then((d) => setDetail({ ...d, source: 'ban' }))
      .catch((e) => { toast.error(e.message || '工单详情加载失败'); setDetail(null) })
      .finally(() => setDetailLoading(false))
  }

  const submitAction = () => {
    if (!action) return
    if (action.type === 'reject' && !comment.trim()) {
      toast.error('驳回需填写原因')
      return
    }
    setSubmitting(true)
    const { ticket } = action
    let p
    if (ticket.source === 'workflow') {
      // 工作流工单：唤醒 Celery 阻塞任务
      p = action.type === 'approve'
        ? approveExecution(ticket.execution_id)
        : action.type === 'reject' ? rejectExecution(ticket.execution_id) : Promise.reject(new Error('工作流工单不支持升级'))
      p = p.then(() => ({ final_result_label: action.type === 'approve' ? '已同意执行' : '已驳回' }))
    } else {
      p = action.type === 'approve'
        ? banWorkflowApi.approveTicket(ticket.id, comment)
        : action.type === 'reject'
          ? banWorkflowApi.rejectTicket(ticket.id, comment)
          : banWorkflowApi.escalateTicket(ticket.id, comment)
    }
    p.then((res) => {
      const msg = action.type === 'approve'
        ? `已同意，${res.final_result_label || '已执行'}`
        : action.type === 'reject' ? '已驳回' : '已升级转人工调查'
      toast.success(msg)
      setAction(null); setComment('')
      load()
      if (detail && detail.id === ticket.id) openDetail(ticket)
    })
      .catch((e) => toast.error(e.message || '操作失败'))
      .finally(() => setSubmitting(false))
  }

  // 删除工单（需 ban_workflow:delete / approval:delete）：封禁工单走 ban-workflow 接口，工作流工单走旧接口
  const doDelete = async (r) => {
    const isWf = r.source === 'workflow'
    const ok = await confirm({
      title: `删除工单 ${r.ip || r.alert_name || (isWf ? `#${r.execution_id}` : `#${r.id}`)}`,
      message: isWf
        ? '删除后该执行记录从工作台移除，操作仅限管理员。确定删除？'
        : '删除后该审批工单从工作台移除（待审批工单关联的封禁记录将置为已取消），操作仅限管理员。确定删除？',
      danger: true,
    })
    if (!ok) return
    try {
      if (isWf) {
        await deleteExecution(r.execution_id)
      } else {
        await banWorkflowApi.deleteApproval(r.id)
      }
      toast.success('工单已删除')
      load()
      if (detail && (detail.id === r.id || detail.execution_id === r.execution_id)) setDetail(null)
    } catch (e) {
      toast.error(e.message || '删除失败')
    }
  }

  const columns = [
    {
      key: 'source', header: '来源', width: '90px',
      render: (r) => (
        <Badge variant={r.source === 'ban' ? 'danger' : 'info'}>
          {r.source === 'ban' ? '封禁流程' : '工作流'}
        </Badge>
      ),
    },
    { key: 'ip', header: 'IP', width: '130px', render: (r) => <span className="font-mono text-[13px] font-medium">{r.ip || '--'}</span> },
    { key: 'risk_level', header: '风险等级', width: '85px', render: (r) => <Badge variant={riskVariant(r.risk_level)}>{r.risk_level || '未知'}</Badge> },
    {
      key: 'alert_name', header: '告警名称', width: '180px',
      render: (r) => (
        <button className="max-w-[170px] truncate text-left font-medium text-foreground transition hover:text-primary" title={r.alert_name} onClick={(e) => { e.stopPropagation(); openDetail(r) }}>
          {r.alert_name || '--'}
        </button>
      ),
    },
    {
      key: 'action', header: '建议动作', width: '100px',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <Badge variant={r.action === 'ban' ? 'danger' : 'info'}>{ACTION_LABELS[r.action] || r.action || '--'}</Badge>
          {r.need_confirm && <span className="text-[11px] text-muted-foreground">需确认</span>}
        </span>
      ),
    },
    {
      key: 'ban_duration', header: '封禁时长', width: '90px',
      render: (r) => <span className="text-muted-foreground">{r.source === 'ban' ? (r.is_permanent ? '永久' : fmtDuration(r.ban_duration)) : '--'}</span>,
    },
    { key: 'created_at', header: '创建时间', width: '145px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{fmtTime(r.created_at)}</span> },
    {
      key: 'remaining', header: '剩余审批时间', width: '100px',
      render: (r) => (
        r.status === 'pending' && r.source === 'ban'
          ? <span className={`font-mono text-[13px] ${r.remaining_ms != null && r.remaining_ms < 2 * 3600000 ? 'text-destructive' : 'text-muted-foreground'}`}>{fmtRemaining(r.remaining_ms)}</span>
          : <span className="text-muted-foreground">--</span>
      ),
    },
    { key: 'status', header: '状态', width: '85px', render: (r) => <Badge variant={TICKET_VARIANT[r.status] || 'neutral'}>{r.status_label}</Badge> },
    {
      key: 'actions', header: '操作', width: tab === 'pending' && canApprove ? '235px' : ((canDeleteWf || canDeleteBan) ? '110px' : '70px'),
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-primary" title="查看详情" onClick={() => openDetail(r)}>
            <Search className="h-4 w-4" />
          </button>
          {tab === 'pending' && canApprove && r.status === 'pending' && (
            <>
              <button className="flex h-8 items-center gap-1 rounded-md bg-success/10 px-2 text-xs font-medium text-success transition hover:bg-success/20" onClick={() => { setAction({ type: 'approve', ticket: r }); setComment('') }}>
                <CheckCircle2 className="h-3.5 w-3.5" /> 同意
              </button>
              <button className="flex h-8 items-center gap-1 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition hover:bg-destructive/20" onClick={() => { setAction({ type: 'reject', ticket: r }); setComment('') }}>
                <XCircle className="h-3.5 w-3.5" /> 驳回
              </button>
            </>
          )}
          {(r.source === 'workflow' ? canDeleteWf : canDeleteBan) && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-destructive" title="删除工单" onClick={() => doDelete(r)}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ]

  const t = detail && (detail.id || detail.execution_id) ? detail : null

  // 主体内容（embedded 模式下直接渲染，不套页面容器）
  const content = (
    <>
      {/* Tab + 搜索 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1">
            {TABS.map((tb) => (
              <button
                key={tb.key}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition ${tab === tb.key ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => { setTab(tb.key); setPage(1) }}
              >
                {tb.label}
                {tb.key === 'pending' && list.items.filter((x) => x.status === 'pending').length > 0 && tab !== 'pending' && (
                  <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                    {list.items.filter((x) => x.status === 'pending').length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <input
            className={`${inputBaseCls} h-[34px] w-[220px]`}
            placeholder="IP / 告警名称"
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === 'Enter') load() }}
          />
          {embedded && (
            <Button size="sm" variant="ghost" onClick={load}>
              <RotateCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          )}
        </div>
      </Card>

      {/* 工单表格 */}
      <Card className="p-0" bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={list.items}
          loading={loading}
          rowKey={(r) => r.id}
          selectable={false}
          onRowClick={(r) => openDetail(r)}
          emptyText={tab === 'pending' ? '暂无待审批工单' : '暂无记录'}
          emptyDescription={tab === 'pending' ? '高危境外 IP 将自动封禁，国内 IP 需确认的工单与工作流人工审批节点会出现在这里' : '当前 Tab 暂无工单记录'}
          emptyIcon={Inbox}
        />
        <div className="px-4">
          <Pagination page={page} pageSize={pageSize} total={list.total} onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} pageSizeOptions={[10, 20, 50, 100]} />
        </div>
      </Card>

      {/* 详情抽屉：封禁工单（接口详情）或工作流工单（行内上下文） */}
      <Modal open={!!detail} size="lg" maxWidth="max-w-3xl" title={t ? `${t.isWorkflow ? `工作流工单 #${t.execution_id}` : `审批工单 #${t.id}`} · ${t.status_label || ''}` : '工单详情'} onClose={() => setDetail(null)}
        footer={t && t.status === 'pending' && canApprove ? (
          <div className="flex items-center justify-end gap-2">
            {!t.isWorkflow && (
              <Button variant="ghost" onClick={() => { setAction({ type: 'escalate', ticket: t }); setComment('') }}>
                <ArrowUpCircle className="h-4 w-4" /> 升级调查
              </Button>
            )}
            <Button variant="danger" onClick={() => { setAction({ type: 'reject', ticket: t }); setComment('') }}>
              <XCircle className="h-4 w-4" /> 驳回
            </Button>
            <Button variant="primary" onClick={() => { setAction({ type: 'approve', ticket: t }); setComment('') }}>
              <CheckCircle2 className="h-4 w-4" /> {t.isWorkflow ? '同意执行' : '同意封禁'}
            </Button>
          </div>
        ) : undefined}
      >
        {detailLoading || !t ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
        ) : t.isWorkflow ? (
          /* 工作流工单详情：工作流信息 + 告警数据 + 智能体结论 */
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-muted p-3 text-sm lg:grid-cols-3">
              <div className="flex items-center gap-1.5"><WorkflowIcon className="h-3.5 w-3.5 text-primary" /><span className="text-muted-foreground">工作流：</span>{t.workflow_name || '--'}</div>
              <div><span className="text-muted-foreground">IP：</span><span className="font-mono font-medium">{t.ip || '--'}</span></div>
              <div><span className="text-muted-foreground">状态：</span>{t.status_label}</div>
              <div className="truncate lg:col-span-2" title={t.alert_name}><span className="text-muted-foreground">告警：</span>{t.alert_name || '--'}</div>
              <div><span className="text-muted-foreground">创建：</span><span className="font-mono text-xs">{fmtTime(t.created_at)}</span></div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <DetailSection title="告警数据" data={t.raw?.alert_data} />
              <DetailSection title="智能体结论" data={t.raw?.agent_decision} />
            </div>
            <DetailSection title="执行上下文" data={t.raw?.context} />
            {(t.raw?.agent_messages || []).length > 0 && <DetailSection title="智能体消息" data={t.raw?.agent_messages} />}
          </div>
        ) : (
          /* 封禁工单详情 */
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-muted p-3 text-sm lg:grid-cols-3">
              <div><span className="text-muted-foreground">IP：</span><span className="font-mono font-medium">{t.ip}</span></div>
              <div><span className="text-muted-foreground">风险等级：</span><Badge variant={riskVariant(t.risk_level)}>{t.risk_level || '未知'}</Badge></div>
              <div><span className="text-muted-foreground">建议动作：</span>{ACTION_LABELS[t.action] || t.action || '--'}</div>
              <div className="truncate lg:col-span-2" title={t.alert_name}><span className="text-muted-foreground">告警：</span>{t.alert_name || '--'}</div>
              <div><span className="text-muted-foreground">封禁时长：</span>{t.is_permanent ? '永久' : fmtDuration(t.ban_duration)}</div>
              <div><span className="text-muted-foreground">创建：</span><span className="font-mono text-xs">{fmtTime(t.created_at)}</span></div>
              <div><span className="text-muted-foreground">截止：</span><span className="font-mono text-xs">{fmtTime(t.deadline)}</span></div>
              {t.approver && <div><span className="text-muted-foreground">审批人：</span>{t.approver}</div>}
            </div>
            {t.approval_comment && (
              <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">审批意见：</span>{t.approval_comment}
                {t.approved_at && <span className="ml-2 font-mono text-xs text-muted-foreground">{fmtTime(t.approved_at)}</span>}
              </div>
            )}
            {(t.reasons || []).length > 0 && (
              <div className="rounded-lg border border-border bg-muted p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldQuestion className="h-3.5 w-3.5" /> 决策依据</div>
                <ul className="list-inside list-disc space-y-0.5 text-sm text-foreground">
                  {t.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              <DetailSection title="智能体研判结论" data={t.agent_decision} />
              <DetailSection title="封禁方案" data={t.ban_plan} />
            </div>
            <DetailSection title="资产信息" data={t.asset_info} />
          </div>
        )}
      </Modal>

      {/* 审批操作确认 */}
      <Modal
        open={!!action}
        title={
          action?.type === 'approve' ? `同意 ${action?.ticket?.ip || action?.ticket?.alert_name || ''}`
            : action?.type === 'reject' ? `驳回工单 ${action?.ticket?.ip || action?.ticket?.alert_name || ''}`
              : `升级调查 ${action?.ticket?.ip || ''}`
        }
        onClose={() => { setAction(null); setComment('') }}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setAction(null); setComment('') }}>取消</Button>
            <Button
              variant={action?.type === 'approve' ? 'primary' : action?.type === 'reject' ? 'danger' : 'secondary'}
              loading={submitting}
              onClick={submitAction}
            >
              {action?.type === 'approve' ? (action?.ticket?.source === 'workflow' ? '确认同意执行' : '确认执行封禁') : action?.type === 'reject' ? '确认驳回' : '确认升级'}
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          {action?.ticket?.source === 'workflow' && action?.type === 'approve' && <div>同意后阻塞中的工作流将继续执行。</div>}
          {action?.ticket?.source === 'workflow' && action?.type === 'reject' && <div>驳回后工作流按拒绝分支继续执行。</div>}
          {action?.ticket?.source !== 'workflow' && action?.type === 'approve' && <div>同意后将按智能体建议的封禁方案下发封禁，该 IP 将出现在已封禁 IP 列表。</div>}
          {action?.ticket?.source !== 'workflow' && action?.type === 'reject' && <div>驳回后实例转持续监控（<span className="text-destructive">原因必填</span>），该 IP 加入监控名单。</div>}
          {action?.type === 'escalate' && <div>升级后实例终止，转人工调查处理。</div>}
          <textarea
            className={`${inputBaseCls} min-h-[72px] w-full`}
            placeholder={action?.type === 'reject' ? '驳回原因（必填）' : '备注（可选）'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      </Modal>
    </>
  )

  if (embedded) return content
  return (
    <PageContainer>
      <PageHeader
        title="审批中心"
        description="封禁审批与工作流人工审批统一入口：同意后执行封禁或继续工作流，驳回转持续监控，超过 24 小时未处理默认驳回"
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
