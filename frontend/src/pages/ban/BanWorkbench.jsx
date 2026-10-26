// 封禁工作台（已封禁 IP 模块）：状态筛选 + 来源标识（自动/审批/手动）+ 手动封禁 + 解封 + 删除（admin）
// 详情含封禁方案、智能体研判结论、审批记录、关联告警（点击跳转告警列表按 IP 过滤）
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldBan, Search, Inbox, LockOpen, Loader2, RotateCw, ExternalLink, Plus, Trash2,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { confirm } from '../../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, Card, DataTable, Badge, Pagination, CompactSelect } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission, isAdmin, guardNavPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'

const STATUS_OPTIONS = [
  { v: 'active', label: '生效中' }, { v: 'pending_approval', label: '待审批' },
  { v: 'expired', label: '已解封' }, { v: 'unbanned', label: '已解封' }, { v: 'cancelled', label: '已取消' },
]
const STATUS_VARIANT = {
  active: 'danger', pending_approval: 'warning', expired: 'neutral', unbanned: 'neutral', cancelled: 'neutral',
}
const LEVEL_LABELS = { critical: '严重', high: '高', medium: '中', low: '低' }
// 封禁来源徽章：自动（工作流直接封禁）/ 审批（人工确认后封禁）/ 手动（工作台发起）/ 聊天（智能体聊天发起）/ 工单（工单流转同步）
const SOURCE_VARIANT = { auto: 'danger', approval: 'warning', manual: 'info', chat: 'secondary', ticket: 'primary' }
const DURATION_OPTIONS = [
  { v: 1800, label: '30 分钟' }, { v: 3600, label: '1 小时' }, { v: 21600, label: '6 小时' },
  { v: 43200, label: '12 小时' }, { v: 86400, label: '1 天' }, { v: 604800, label: '7 天' },
]

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')
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
    ip: '', ban_level: 'medium', ban_duration: 3600, is_permanent: false, reason: '', region: '',
  })
  const [manualSubmitting, setManualSubmitting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    banWorkflowApi.bannedIps({ status, ip, page, page_size: pageSize })
      .then((res) => setList({ total: res.total || 0, items: res.items || [] }))
      .catch((e) => toast.error(e.message || '封禁列表加载失败'))
      .finally(() => setLoading(false))
  }, [status, ip, page])

  useEffect(() => { load() }, [load])

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
    if (!manualForm.reason.trim()) { toast.error('请填写封禁原因'); return }
    setManualSubmitting(true)
    banWorkflowApi.createManualBan({
      ip: manualForm.ip.trim(),
      ban_level: manualForm.ban_level,
      ban_duration: Number(manualForm.ban_duration) || 3600,
      is_permanent: manualForm.is_permanent,
      reason: manualForm.reason.trim(),
      region: manualForm.region.trim(),
    })
      .then((rec) => {
        toast.success(`IP ${rec.ip} 已下发封禁（手动封禁）`)
        setManualOpen(false)
        setManualForm({ ip: '', ban_level: 'medium', ban_duration: 3600, is_permanent: false, reason: '', region: '' })
        load()
      })
      .catch((e) => toast.error(e.message || '手动封禁失败'))
      .finally(() => setManualSubmitting(false))
  }

  // 删除封禁记录（仅 admin）
  const doDelete = async (r) => {
    const ok = await confirm({
      title: `删除封禁记录 ${r.ip}`,
      message: '删除后该记录从工作台移除（不影响已下发的封禁设备侧状态），操作将记录审计日志。确定删除？',
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
      key: 'actions', header: '操作', width: canEdit && admin ? '145px' : (canEdit || admin ? '110px' : '70px'),
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-primary" title="详情" onClick={() => openDetail(r.id)}>
            <Search className="h-4 w-4" />
          </button>
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
            <Button size="sm" variant="primary" onClick={() => setManualOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> 手动封禁
            </Button>
          )}
          {embedded && (
            <Button size="sm" variant="ghost" onClick={load}>
              <RotateCw className="h-3.5 w-3.5" /> 刷新
            </Button>
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
          selectable={false}
          onRowClick={(r) => openDetail(r.id)}
          emptyText="暂无封禁记录"
          emptyDescription="工作流自动封禁或审批通过的 IP 将出现在这里"
          emptyIcon={Inbox}
        />
        <div className="px-4">
          <Pagination page={page} pageSize={pageSize} total={list.total} onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} pageSizeOptions={[10, 20, 50, 100]} />
        </div>
      </Card>

      {/* 详情抽屉 */}
      <Modal open={!!detail} size="lg" maxWidth="max-w-3xl" title={t ? `封禁记录 #${t.id} · ${t.ip}` : '封禁详情'} onClose={() => setDetail(null)}>
        {detailLoading || !t ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…</div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border bg-muted p-3 text-sm lg:grid-cols-3">
              <div><span className="text-muted-foreground">状态：</span><Badge variant={STATUS_VARIANT[t.status] || 'neutral'}>{t.status_label}</Badge></div>
              <div><span className="text-muted-foreground">封禁方式：</span><Badge variant={SOURCE_VARIANT[t.ban_source] || 'neutral'}>{t.ban_source_label || t.ban_source || '--'}</Badge></div>
              <div><span className="text-muted-foreground">风险等级：</span><Badge variant={riskVariant(t.risk_level)}>{t.risk_level || '未知'}</Badge></div>
              <div><span className="text-muted-foreground">封禁等级：</span>{LEVEL_LABELS[t.ban_level] || t.ban_level || '--'}</div>
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
          <div>解封后该 IP 恢复访问，操作将记录操作人与时间（<span className="text-destructive">原因必填</span>）。</div>
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
            <label className="mb-1 block text-xs text-muted-foreground">目标 IP（IPv4/IPv6，必填）</label>
            <input
              className={`${inputBaseCls} h-[38px] w-full font-mono`}
              placeholder="如 203.0.113.50"
              value={manualForm.ip}
              onChange={(e) => setManualForm((f) => ({ ...f, ip: e.target.value }))}
            />
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
              <label className="mb-1 block text-xs text-muted-foreground">封禁时长</label>
              <CompactSelect
                block
                size="lg"
                value={manualForm.ban_duration}
                disabled={manualForm.is_permanent}
                onChange={(e) => setManualForm((f) => ({ ...f, ban_duration: Number(e.target.value) }))}
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </CompactSelect>
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
            下发后将调用封禁工具执行，记录标记为「手动封禁」，到期由定时任务自动解封。
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
