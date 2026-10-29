// 反馈管理页（admin）：全量反馈的筛选 / 批量处理 / 详情处理抽屉
// 功能：多条件筛选 + 复选框批量操作 + 详情抽屉（字段/附件 lightbox/回复/改状态/重新打开/时间线）
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bug, Eye, RotateCcw, Paperclip, MessageSquareWarning, X, Search, XCircle,
  Trash2, Plus, Clock, Calendar, AlertTriangle,
} from 'lucide-react'
import { feedbackApi } from '../api/client'
import { toast } from '../store/toastStore'
import {
  PageContainer, PageHeader, DataTable, Pagination, Button,
  CompactSelect, DatePicker,
} from '../components/ui'
import {
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  FEEDBACK_PRIORITIES,
  typeMeta,
  statusMeta,
  priorityMeta,
  actionLabel,
  fmtTime,
  fmtSize,
  isImageAttachment,
} from '../utils/feedback'
import { isAdmin } from '../utils/permissions'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'

const PAGE_SIZE = 20

// 标签
function Tag({ cls, children }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  )
}

// 字段展示行
function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:gap-4">
      <div className="w-28 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground">
        {children || <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  )
}

// 处理历史时间线：左侧圆点 + 竖线
function HistoryTimeline({ histories }) {
  const list = [...(histories || [])].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  )
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无处理记录</p>
  }
  return (
    <ol className="relative ml-1.5 border-l border-border">
      {list.map((h) => (
        <li key={h.id} className="relative ml-6 pb-5 last:pb-0">
          <span className="absolute -left-[29px] top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/15" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {actionLabel(h.action)}
            </span>
            {(h.from_status || h.to_status) && (
              <span className="text-xs text-muted-foreground">
                {statusMeta(h.from_status).label} → {statusMeta(h.to_status).label}
              </span>
            )}
            {h.operator_name && (
              <span className="text-xs text-muted-foreground">操作人：{h.operator_name}</span>
            )}
          </div>
          {h.content && (
            <div className="mt-1.5 border-l-2 border-primary/30 bg-muted py-1.5 pl-3 pr-2">
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {h.content}
              </p>
            </div>
          )}
          <div className="mt-1 text-xs tabular-nums text-muted-foreground">
            {fmtTime(h.created_at)}
          </div>
        </li>
      ))}
    </ol>
  )
}

// 简易 lightbox：全屏遮罩 + 大图，点击任意处关闭
function Lightbox({ src, alt, onClose }) {
  if (!src) return null
  return (
    <div
      className="fixed inset-0 z-[120] flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt || ''}
        className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭大图"
        className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}

// 通用确认对话框：删除等危险操作二次确认
function ConfirmDialog({
  open,
  title = '确认操作',
  message,
  confirmText = '确定',
  cancelText = '取消',
  loading = false,
  onConfirm,
  onClose,
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {message && (
              <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant="danger" size="sm" loading={loading} onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}

// 紧凑统计条：4 个数字卡 + 状态分布迷你堆叠条，整体一行 ≤90px
function StatsBar({ stats, loading }) {
  const s = stats || {}
  const total = s.total ?? 0
  const statusItems = FEEDBACK_STATUSES.map((st) => ({
    ...st,
    count: s.by_status?.[st.value] || 0,
    cls: statusMeta(st.value).cls,
  }))
  const typeItems = FEEDBACK_TYPES.map((t) => ({
    ...t,
    count: s.by_type?.[t.value] || 0,
    cls: typeMeta(t.value).cls,
  }))
  const sum = (arr) => arr.reduce((a, b) => a + b.count, 0)

  return (
    <div className="mb-3 flex flex-wrap items-stretch gap-2">
      {/* 数字卡 */}
      <StatCard icon={Bug} color="primary" label="总反馈" value={s.total ?? 0} loading={loading} />
      <StatCard icon={Clock} color="amber" label="待处理" value={s.pending_count ?? 0} loading={loading} />
      <StatCard icon={Plus} color="emerald" label="今日新增" value={s.today ?? 0} loading={loading} />
      <StatCard icon={Calendar} color="blue" label="本周新增" value={s.this_week ?? 0} loading={loading} />

      {/* 状态分布迷你堆叠条 */}
      <div className="flex min-w-[220px] flex-1 flex-col justify-center rounded-lg border border-border bg-card px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">状态分布</span>
          <span className="text-[10px] text-muted-foreground">共 {total} 条</span>
        </div>
        {total > 0 ? (
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {statusItems.map((it) =>
              it.count > 0 ? (
                <div
                  key={it.value}
                  className={it.cls}
                  style={{ width: `${(it.count / total) * 100}%` }}
                  title={`${it.label}: ${it.count}`}
                />
              ) : null
            )}
          </div>
        ) : (
          <div className="flex h-2.5 w-full items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
            暂无数据
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {statusItems.map((it) => (
            <span key={it.value} className="flex items-center gap-1 text-[10px]">
              <span className={`h-2 w-2 rounded-full ${it.cls}`} />
              <span className="text-muted-foreground">{it.label}</span>
              <span className="font-medium tabular-nums text-foreground">{it.count}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 类型分布迷你堆叠条 */}
      <div className="flex min-w-[180px] flex-col justify-center rounded-lg border border-border bg-card px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">类型分布</span>
          <span className="text-[10px] text-muted-foreground">共 {sum(typeItems)} 条</span>
        </div>
        {sum(typeItems) > 0 ? (
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {typeItems.map((it) =>
              it.count > 0 ? (
                <div
                  key={it.value}
                  className={it.cls}
                  style={{ width: `${(it.count / sum(typeItems)) * 100}%` }}
                  title={`${it.label}: ${it.count}`}
                />
              ) : null
            )}
          </div>
        ) : (
          <div className="flex h-2.5 w-full items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
            暂无数据
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {typeItems.map((it) => (
            <span key={it.value} className="flex items-center gap-1 text-[10px]">
              <span className={`h-2 w-2 rounded-full ${it.cls}`} />
              <span className="text-muted-foreground">{it.label}</span>
              <span className="font-medium tabular-nums text-foreground">{it.count}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// 单个数字卡：图标 + 标签 + 数值
function StatCard({ icon: Icon, color, label, value, loading }) {
  const colorCls = {
    primary: 'bg-primary/15 text-primary',
    amber: 'bg-amber-500/15 text-amber-400',
    emerald: 'bg-emerald-500/15 text-emerald-400',
    blue: 'bg-blue-500/15 text-blue-400',
  }[color] || 'bg-muted text-muted-foreground'
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className={`flex h-8 w-8 items-center justify-center rounded-md ${colorCls}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground truncate">{label}</div>
        <div className="text-base font-semibold leading-tight tabular-nums text-foreground">
          {loading ? '—' : value}
        </div>
      </div>
    </div>
  )
}

// 详情处理抽屉：右侧 720px，上反馈信息 + 下处理区 + 时间线
function AdminDetailDrawer({ open, onClose, feedbackId, onChanged }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  // 处理区状态
  const [nextStatus, setNextStatus] = useState('')
  const [replyContent, setReplyContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [reopening, setReopening] = useState(false)
  // 图片放大
  const [lightbox, setLightbox] = useState(null)
  // 删除确认
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [assignees, setAssignees] = useState([])
  const [assigning, setAssigning] = useState(false)
  const canAssign = isAdmin()

  const load = useCallback(async () => {
    if (!feedbackId) return
    setLoading(true)
    try {
      const d = await feedbackApi.detail(feedbackId)
      setDetail(d)
      setNextStatus(d?.status || '')
      setReplyContent('')
    } catch (err) {
      toast.error(err.message || '加载反馈详情失败')
    } finally {
      setLoading(false)
    }
  }, [feedbackId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  useEffect(() => {
    if (!open || !canAssign) return
    feedbackApi.assignees()
      .then((d) => setAssignees(d.items || d || []))
      .catch(() => setAssignees([]))
  }, [open, canAssign])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape' && !lightbox) onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, lightbox])

  useLockBackgroundScroll(open)

  if (!open) return null

  const t = typeMeta(detail?.type)
  const s = statusMeta(detail?.status)
  const p = priorityMeta(detail?.priority)
  const canReopen =
    detail && (detail.status === 'closed' || detail.status === 'resolved')

  const handleAssign = async (assigneeId) => {
    if (!detail || assigning) return
    const next = assigneeId === '' || assigneeId == null ? null : Number(assigneeId)
    if ((detail.assignee_id || null) === next) return
    setAssigning(true)
    try {
      const d = await feedbackApi.assign(detail.id, next)
      setDetail(d)
      toast.success(next ? '已分配处理人' : '已取消分配')
      if (onChanged) onChanged()
    } catch (err) {
      toast.error(err.message || '分配失败')
    } finally {
      setAssigning(false)
    }
  }

  // 提交回复（可选同时改状态）
  const handleSubmitReply = async () => {
    if (!detail || submitting) return
    if (!replyContent.trim() && nextStatus === detail.status) {
      toast.warning('请填写回复内容或变更状态')
      return
    }
    setSubmitting(true)
    try {
      if (replyContent.trim()) {
        await feedbackApi.reply(detail.id, { content: replyContent.trim() })
      }
      if (nextStatus && nextStatus !== detail.status) {
        await feedbackApi.setStatus(detail.id, nextStatus)
      }
      toast.success('处理已提交')
      await load()
      if (onChanged) onChanged()
    } catch (err) {
      toast.error(err.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReopen = async () => {
    if (!detail || reopening) return
    setReopening(true)
    try {
      await feedbackApi.reopen(detail.id)
      toast.success('反馈已重新打开')
      await load()
      if (onChanged) onChanged()
    } catch (err) {
      toast.error(err.message || '重新打开失败')
    } finally {
      setReopening(false)
    }
  }

  const handleDelete = async () => {
    if (!detail || deleting) return
    setDeleting(true)
    try {
      await feedbackApi.remove(detail.id)
      toast.success('反馈已删除')
      setConfirmDelete(false)
      if (onChanged) await onChanged()
      onClose()
    } catch (err) {
      toast.error(err.message || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[100] flex justify-end">
        <style>{`
          @keyframes adminFeedbackSlideIn {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
        `}</style>
        {/* 遮罩层 */}
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
        {/* 抽屉主体：小屏撑满，≥sm 限 720px */}
        <div className="relative flex h-full w-full flex-col border-l border-border bg-card shadow-2xl animate-[adminFeedbackSlideIn_0.2s_ease-out] sm:max-w-[720px]">
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
            <h2 className="flex items-center gap-2 truncate text-base font-semibold text-foreground">
              反馈详情
              {detail && (
                <>
                  <span className="font-mono text-xs text-muted-foreground">#{detail.id}</span>
                  <Tag cls={s.cls}>{s.label}</Tag>
                </>
              )}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 内容区 */}
          <div
            data-allow-scroll
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5"
          >
            {loading || !detail ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                加载中...
              </div>
            ) : (
              <>
                {/* ===== 上：反馈信息 ===== */}
                <div className="mb-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Tag cls={t.cls}>{t.label}</Tag>
                    <Tag cls={p.cls}>{p.label}</Tag>
                  </div>
                  <h3 className="text-base font-semibold leading-relaxed text-foreground">
                    {detail.title}
                  </h3>
                </div>

                <div className="divide-y divide-border rounded-lg border border-border bg-muted px-4 py-1">
                  <Field label="提交人">
                    {detail.user_name || `#${detail.user_id}`}
                  </Field>
                  <Field label="所属模块">{detail.module}</Field>
                  {detail.type === 'bug' && (
                    <>
                      <Field label="复现步骤">{detail.reproduce_steps}</Field>
                      <Field label="期望结果">{detail.expected_result}</Field>
                      <Field label="实际结果">{detail.actual_result}</Field>
                    </>
                  )}
                  <Field label="详细描述">{detail.description}</Field>
                  <Field label="联系方式">{detail.contact}</Field>
                  <Field label="允许回访">
                    {detail.allow_visit ? '允许回访' : '不允许回访'}
                  </Field>
                  <Field label="提交页面">
                    {detail.page_title}
                    {detail.page_url && (
                      <a
                        href={detail.page_url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 break-all text-primary hover:underline"
                      >
                        {detail.page_url}
                      </a>
                    )}
                  </Field>
                  <Field label="提交时间">{fmtTime(detail.created_at)}</Field>
                </div>

                {/* 附件（图片点击放大 lightbox） */}
                <div className="mt-5">
                  <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                    附件
                    {Array.isArray(detail.attachments) && (
                      <span className="text-xs text-muted-foreground">
                        ({detail.attachments.length})
                      </span>
                    )}
                  </h4>
                  {Array.isArray(detail.attachments) && detail.attachments.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {detail.attachments.map((a, i) => {
                        const url = feedbackApi.attachmentUrl(detail.id, a.path)
                        return isImageAttachment(a.name) ? (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setLightbox({ src: url, alt: a.name })}
                            title={`${a.name}（点击放大）`}
                            className="group/att overflow-hidden rounded-md border border-border transition-colors hover:border-primary"
                          >
                            <img
                              src={url}
                              alt={a.name}
                              loading="lazy"
                              className="h-24 w-full object-cover bg-muted"
                            />
                            <div className="truncate px-2 py-1 text-[11px] text-muted-foreground">
                              {a.name} · {fmtSize(a.size)}
                            </div>
                          </button>
                        ) : (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs transition-colors hover:border-primary"
                          >
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate" title={a.name}>
                              {a.name}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {fmtSize(a.size)}
                            </span>
                          </a>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">无附件</p>
                  )}
                </div>

                {/* ===== 下：处理区 ===== */}
                <div className="mt-6 border-t border-border pt-5">
                  <h4 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <MessageSquareWarning className="h-3.5 w-3.5 text-muted-foreground" />
                    处理
                  </h4>

                  <div className="mb-3 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      状态
                      <CompactSelect
                        size="md"
                        value={nextStatus}
                        onChange={(e) => setNextStatus(e.target.value)}
                      >
                        {FEEDBACK_STATUSES.map((st) => (
                          <option key={st.value} value={st.value}>
                            {st.label}
                          </option>
                        ))}
                      </CompactSelect>
                    </label>
                    {canAssign ? (
                      <label className="flex items-center gap-2 text-sm text-muted-foreground">
                        处理人
                        <CompactSelect
                          size="md"
                          value={detail.assignee_id || ''}
                          disabled={assigning}
                          onChange={(e) => handleAssign(e.target.value)}
                        >
                          <option value="">未分配</option>
                          {detail.assignee_id && !assignees.some((u) => u.id === detail.assignee_id) && (
                            <option value={detail.assignee_id}>
                              {detail.assignee_name || '已停用账号'}
                            </option>
                          )}
                          {assignees.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name || u.username}
                            </option>
                          ))}
                        </CompactSelect>
                      </label>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        处理人：{detail.assignee_name || '未分配'}
                      </span>
                    )}
                    {canReopen && (
                      <Button size="sm" variant="secondary" loading={reopening} onClick={handleReopen}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        重新打开
                      </Button>
                    )}
                  </div>

                  <textarea
                    rows={3}
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    maxLength={2000}
                    placeholder="填写回复内容（提交后将通知反馈提交者）"
                    className="w-full resize-y rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground transition focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />

                  <div className="mt-3 flex justify-end">
                    <Button variant="primary" size="sm" loading={submitting} onClick={handleSubmitReply}>
                      提交回复
                    </Button>
                  </div>
                </div>

                {/* ===== 处理历史时间线 ===== */}
                <div className="mt-6 border-t border-border pt-5 mb-2">
                  <h4 className="mb-3 text-sm font-medium text-foreground">处理历史</h4>
                  <HistoryTimeline histories={detail.histories} />
                </div>

                {/* ===== 危险操作：删除反馈 ===== */}
                <div className="mt-6 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-destructive">删除反馈</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      删除后将级联清理附件/历史/通知，操作不可恢复
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* 图片放大层（置于抽屉之上） */}
      <Lightbox src={lightbox?.src} alt={lightbox?.alt} onClose={() => setLightbox(null)} />
      {/* 删除确认 */}
      <ConfirmDialog
        open={confirmDelete}
        title="确认删除该反馈？"
        message={`将永久删除反馈 #${detail?.id} 及其附件、历史、通知，操作不可恢复。`}
        confirmText="确认删除"
        cancelText="取消"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </>,
    document.body,
  )
}

// 筛选输入通用样式：h-9 基准控件 + 悬停主色反馈
const filterInputCls =
  'h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition hover:border-primary/45 focus:border-primary'

// ===== 反馈管理列表页（admin） =====
function FeedbackAdmin() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 筛选草稿（点「筛选」才提交）
  const [draft, setDraft] = useState({
    type: '',
    status: '',
    priority: '',
    module: '',
    submitter: '',
    start_date: '',
    end_date: '',
    keyword: '',
  })
  // 已提交的筛选
  const [filters, setFilters] = useState({ ...draft })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  // 批量选择
  const [selectedKeys, setSelectedKeys] = useState([])
  const [batching, setBatching] = useState(false)

  const [detailId, setDetailId] = useState(null)

  // 顶部统计：独立加载，不阻塞列表
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // 行内删除确认
  const [rowDeleteId, setRowDeleteId] = useState(null)
  const [rowDeleting, setRowDeleting] = useState(false)

  // 批量删除确认
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  const canAssign = isAdmin()
  const [assignees, setAssignees] = useState([])
  const [assigningId, setAssigningId] = useState(null)

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const s = await feedbackApi.stats()
      setStats(s || {})
    } catch (err) {
      // 静默失败：统计出错不打扰用户主流程
      setStats(null)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 转换筛选参数：日期转 ISO 时间范围，空值剔除
      const { start_date, end_date, ...rest } = filters
      const params = {
        page,
        size: pageSize,
        ...rest,
      }
      if (start_date) params.start_time = `${start_date}T00:00:00`
      if (end_date) params.end_time = `${end_date}T23:59:59`
      const data = await feedbackApi.adminList(params)
      setRows(Array.isArray(data?.items) ? data.items : [])
      setTotal(Number(data?.total) || 0)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filters])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!canAssign) return
    feedbackApi.assignees()
      .then((d) => setAssignees(d.items || []))
      .catch(() => setAssignees([]))
  }, [canAssign])

  // 首次挂载加载统计；列表加载完成后同步刷新
  useEffect(() => {
    loadStats()
  }, [load, loadStats])

  const handleRowDelete = async () => {
    if (!rowDeleteId || rowDeleting) return
    setRowDeleting(true)
    try {
      await feedbackApi.remove(rowDeleteId)
      toast.success('反馈已删除')
      setRowDeleteId(null)
      // 如删除后当前页变空，回到上一页
      if (rows.length === 1 && page > 1) {
        setPage(page - 1)
      } else {
        await load()
      }
      await loadStats()
    } catch (err) {
      toast.error(err.message || '删除失败')
    } finally {
      setRowDeleting(false)
    }
  }

  const applyFilter = () => {
    setFilters({ ...draft })
    setPage(1)
  }

  const resetFilter = () => {
    const empty = {
      type: '', status: '', priority: '', module: '',
      submitter: '', start_date: '', end_date: '', keyword: '',
    }
    setDraft(empty)
    setFilters({ ...empty })
    setPage(1)
  }

  // 批量操作
  const runBatch = async (action, tip) => {
    if (selectedKeys.length === 0 || batching) return
    setBatching(true)
    try {
      await feedbackApi.batch(selectedKeys, action)
      toast.success(`${tip}成功（${selectedKeys.length} 条）`)
      setSelectedKeys([])
      await load()
      await loadStats()
    } catch (err) {
      toast.error(err.message || `${tip}失败`)
    } finally {
      setBatching(false)
    }
  }

  // 批量删除：二次确认后调用 runBatch('delete', ...)
  const handleBatchDelete = async () => {
    setConfirmBatchDelete(false)
    await runBatch('delete', '批量删除')
  }

  const handleListAssign = async (row, assigneeId) => {
    if (!canAssign || assigningId) return
    const next = assigneeId === '' || assigneeId == null ? null : Number(assigneeId)
    if ((row.assignee_id || null) === next) return
    setAssigningId(row.id)
    try {
      const d = await feedbackApi.assign(row.id, next)
      setRows((prev) => prev.map((r) => (
        r.id === row.id
          ? { ...r, assignee_id: d.assignee_id, assignee_name: d.assignee_name }
          : r
      )))
      toast.success(next ? '已分配处理人' : '已取消分配')
    } catch (err) {
      toast.error(err.message || '分配失败')
    } finally {
      setAssigningId(null)
    }
  }

  const columns = [
    {
      key: 'id',
      header: 'ID',
      width: '70px',
      render: (r) => <span className="font-mono text-primary">#{r.id}</span>,
    },
    {
      key: 'type',
      header: '类型',
      width: '95px',
      render: (r) => {
        const m = typeMeta(r.type)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'title',
      header: '标题',
      render: (r) => (
        <span className="max-w-[240px] truncate text-foreground" title={r.title}>
          {r.title}
        </span>
      ),
    },
    {
      key: 'module',
      header: '模块',
      render: (r) => (
        <span className="max-w-[180px] truncate text-muted-foreground" title={r.module}>
          {r.module || '-'}
        </span>
      ),
    },
    {
      key: 'user',
      header: '提交人',
      width: '110px',
      render: (r) => (
        <span className="text-foreground">{r.user_name || `#${r.user_id}`}</span>
      ),
    },
    {
      key: 'assignee',
      header: '处理人',
      width: canAssign ? '132px' : '100px',
      className: '!overflow-visible align-middle',
      render: (r) => (
        canAssign ? (
          <CompactSelect
            variant="ghost"
            value={r.assignee_id || ''}
            disabled={assigningId === r.id}
            title="仅超管可分配处理人"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation()
              handleListAssign(r, e.target.value)
            }}
          >
            <option value="">未分配</option>
            {r.assignee_id && !assignees.some((u) => u.id === r.assignee_id) && (
              <option value={r.assignee_id}>{r.assignee_name || '已停用账号'}</option>
            )}
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
            ))}
          </CompactSelect>
        ) : (
          <span className="inline-flex h-7 items-center text-foreground">{r.assignee_name || '未分配'}</span>
        )
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: '95px',
      render: (r) => {
        const m = statusMeta(r.status)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'priority',
      header: '优先级',
      width: '85px',
      render: (r) => {
        const m = priorityMeta(r.priority)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'created_at',
      header: '提交时间',
      width: '165px',
      render: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(r.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: '140px',
      render: (r) => (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setDetailId(r.id)
            }}
            className="inline-flex items-center gap-1 text-xs text-primary transition-colors hover:underline"
          >
            <Eye className="h-3.5 w-3.5" />
            查看
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setRowDeleteId(r.id)
            }}
            className="inline-flex items-center gap-1 text-xs text-destructive transition-colors hover:underline"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      ),
    },
  ]

  return (
    <PageContainer className="flex flex-col">
      <PageHeader
        title="反馈管理"
        actions={
          selectedKeys.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
                已选 {selectedKeys.length} 条
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={batching}
                  onClick={() => runBatch('processed', '标记处理中')}
                >
                  标记处理中
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={batching}
                  onClick={() => runBatch('close', '批量关闭')}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  批量关闭
                </Button>
              </div>
              <span className="h-5 w-px bg-border" aria-hidden />
              <Button
                size="sm"
                variant="danger"
                loading={batching}
                onClick={() => setConfirmBatchDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                批量删除
              </Button>
            </div>
          )
        }
      />

      {/* 顶部紧凑统计 */}
      <StatsBar stats={stats} loading={statsLoading} />

      {/* 筛选区：基准卡片条（下拉/日期均为自绘弹层，规避原生弹层黑闪） */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5">
        <CompactSelect
          size="lg"
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value })}
        >
          <option value="">全部类型</option>
          {FEEDBACK_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </CompactSelect>
        <CompactSelect
          size="lg"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
        >
          <option value="">全部状态</option>
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </CompactSelect>
        <CompactSelect
          size="lg"
          value={draft.priority}
          onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
        >
          <option value="">全部优先级</option>
          {FEEDBACK_PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </CompactSelect>
        <input
          type="text"
          value={draft.module}
          onChange={(e) => setDraft({ ...draft, module: e.target.value })}
          placeholder="模块（模糊）"
          className={`${filterInputCls} w-32`}
        />
        <input
          type="text"
          value={draft.submitter}
          onChange={(e) => setDraft({ ...draft, submitter: e.target.value })}
          placeholder="提交人（ID/用户名）"
          className={`${filterInputCls} w-40`}
        />
        <div className="flex items-center gap-1.5">
          <DatePicker
            value={draft.start_date}
            onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
            placeholder="开始日期"
            title="开始日期"
          />
          <span className="text-xs text-muted-foreground">至</span>
          <DatePicker
            value={draft.end_date}
            onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
            placeholder="结束日期"
            title="结束日期"
          />
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={draft.keyword}
            onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilter()
            }}
            placeholder="关键词（标题/描述）"
            className={`${filterInputCls} w-44 pl-8`}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={applyFilter}>
            筛选
          </Button>
          <Button size="sm" variant="secondary" onClick={resetFilter}>
            重置
          </Button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 表格 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          columns={columns}
          data={rows}
          loading={loading}
          rowKey="id"
          selectable
          selectedKeys={selectedKeys}
          onSelectChange={setSelectedKeys}
          onRowClick={(r) => setDetailId(r.id)}
          emptyText="暂无反馈记录"
        />
      </div>

      {/* 分页 */}
      {!loading && total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s)
            setPage(1)
          }}
          pageSizeOptions={[10, 20, 50, 100]}
        />
      )}

      {/* 详情处理抽屉 */}
      <AdminDetailDrawer
        open={detailId != null}
        onClose={() => setDetailId(null)}
        feedbackId={detailId}
        onChanged={load}
      />

      {/* 行内删除确认 */}
      <ConfirmDialog
        open={rowDeleteId != null}
        title="确认删除该反馈？"
        message={`将永久删除反馈 #${rowDeleteId ?? ''} 及其附件、历史、通知，操作不可恢复。`}
        confirmText="确认删除"
        cancelText="取消"
        loading={rowDeleting}
        onConfirm={handleRowDelete}
        onClose={() => setRowDeleteId(null)}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={confirmBatchDelete}
        title={`确认批量删除 ${selectedKeys.length} 条反馈？`}
        message="将永久删除所选反馈及其附件、历史、通知，操作不可恢复。"
        confirmText="确认删除"
        cancelText="取消"
        loading={batching}
        onConfirm={handleBatchDelete}
        onClose={() => setConfirmBatchDelete(false)}
      />
    </PageContainer>
  )
}

export default FeedbackAdmin
