// 我的反馈页：当前用户提交的 BUG / 优化建议列表
// 功能：类型/状态筛选 + 列表 + 详情抽屉（完整字段/附件/回复/时间线）+ 重新打开 + 提交反馈入口
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Inbox, Eye, RotateCcw, MessageSquareWarning, Paperclip, Download, X } from 'lucide-react'
import { feedbackApi } from '../api/client'
import { toast } from '../store/toastStore'
import FeedbackDrawer from '../components/FeedbackDrawer'
import { PageContainer, PageHeader, DataTable, Pagination, Button, CompactSelect } from '../components/ui'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'
import {
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  typeMeta,
  statusMeta,
  priorityMeta,
  actionLabel,
  fmtTime,
  fmtSize,
  isImageAttachment,
} from '../utils/feedback'

const PAGE_SIZE = 20

// 字段展示行（详情抽屉内）
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

// 标签（类型/状态/优先级通用）
function Tag({ cls, children }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  )
}

// 处理历史时间线：左侧圆点 + 竖线，按时间正序
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
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {h.content}
            </p>
          )}
          <div className="mt-1 text-xs tabular-nums text-muted-foreground">
            {fmtTime(h.created_at)}
          </div>
        </li>
      ))}
    </ol>
  )
}

// 详情抽屉：右侧 640px，完整字段 + 附件 + 管理员回复 + 时间线
function DetailDrawer({ open, onClose, feedbackId, onReopened }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [reopening, setReopening] = useState(false)

  const load = useCallback(async () => {
    if (!feedbackId) return
    setLoading(true)
    try {
      const d = await feedbackApi.detail(feedbackId)
      setDetail(d)
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
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useLockBackgroundScroll(open)

  if (!open) return null

  const t = typeMeta(detail?.type)
  const s = statusMeta(detail?.status)
  const p = priorityMeta(detail?.priority)
  const replies = (detail?.histories || []).filter((h) => h.action === 'reply')
  const canReopen =
    detail && (detail.status === 'closed' || detail.status === 'resolved')

  const handleReopen = async () => {
    if (!detail || reopening) return
    setReopening(true)
    try {
      await feedbackApi.reopen(detail.id)
      toast.success('反馈已重新打开')
      await load()
      if (onReopened) onReopened()
    } catch (err) {
      toast.error(err.message || '重新打开失败')
    } finally {
      setReopening(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end">
      <style>{`
        @keyframes myFeedbackSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      {/* 抽屉主体：小屏撑满，≥sm 限 640px */}
      <div className="relative flex h-full w-full flex-col border-l border-border bg-card shadow-2xl animate-[myFeedbackSlideIn_0.2s_ease-out] sm:max-w-[640px]">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 className="flex items-center gap-2 truncate text-base font-semibold text-foreground">
            反馈详情
            {detail && <Tag cls={s.cls}>{s.label}</Tag>}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {canReopen && (
              <Button size="sm" variant="secondary" loading={reopening} onClick={handleReopen}>
                <RotateCcw className="h-3.5 w-3.5" />
                重新打开
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div data-allow-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {loading || !detail ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              加载中...
            </div>
          ) : (
            <>
              {/* 标题与标签 */}
              <div className="mb-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Tag cls={t.cls}>{t.label}</Tag>
                  <Tag cls={p.cls}>{p.label}</Tag>
                  <span className="text-xs text-muted-foreground">#{detail.id}</span>
                </div>
                <h3 className="text-base font-semibold leading-relaxed text-foreground">
                  {detail.title}
                </h3>
              </div>

              {/* 完整字段 */}
              <div className="divide-y divide-border rounded-lg border border-border bg-muted px-4 py-1">
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
                  {detail.allow_visit ? '允许管理员回访' : '不允许回访'}
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
                <Field label="更新时间">{fmtTime(detail.updated_at)}</Field>
              </div>

              {/* 附件列表 */}
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
                  <div className="flex flex-col gap-2">
                    {detail.attachments.map((a, i) => {
                      const url = feedbackApi.attachmentUrl(detail.id, a.path)
                      return isImageAttachment(a.name) ? (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          title={`${a.name}（点击查看大图）`}
                          className="group/block overflow-hidden rounded-md border border-border transition-colors hover:border-primary"
                        >
                          <img
                            src={url}
                            alt={a.name}
                            loading="lazy"
                            className="max-h-40 w-full object-contain bg-muted"
                          />
                          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                            <span className="truncate">{a.name}</span>
                            <span className="shrink-0 tabular-nums">{fmtSize(a.size)}</span>
                          </div>
                        </a>
                      ) : (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm transition-colors hover:border-primary"
                        >
                          <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-foreground" title={a.name}>
                            {a.name}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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

              {/* 管理员回复 */}
              <div className="mt-5">
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <MessageSquareWarning className="h-3.5 w-3.5 text-muted-foreground" />
                  管理员回复
                </h4>
                {replies.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {replies.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-md border border-primary/25 bg-primary/5 px-4 py-3"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-primary">
                            {r.operator_name || '管理员'}
                          </span>
                          <span className="tabular-nums">{fmtTime(r.created_at)}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                          {r.content}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">暂无回复</p>
                )}
              </div>

              {/* 处理历史时间线 */}
              <div className="mt-5 mb-2">
                <h4 className="mb-3 text-sm font-medium text-foreground">处理历史</h4>
                <HistoryTimeline histories={detail.histories} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ===== 我的反馈列表页 =====
function MyFeedback() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 筛选（已提交）与筛选草稿（下拉即时生效，保持简单）
  const [filters, setFilters] = useState({ type: '', status: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  // 提交抽屉 / 详情抽屉
  const [submitOpen, setSubmitOpen] = useState(false)
  const [detailId, setDetailId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await feedbackApi.mine({
        page,
        size: pageSize,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      })
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

  const applyFilters = (next) => {
    setFilters(next)
    setPage(1)
  }

  // 表格列定义
  const columns = [
    {
      key: 'type',
      header: '类型',
      width: '100px',
      render: (r) => {
        const m = typeMeta(r.type)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'title',
      header: '标题',
      render: (r) => (
        <span className="max-w-[280px] truncate text-foreground" title={r.title}>
          {r.title}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: '100px',
      render: (r) => {
        const m = statusMeta(r.status)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'priority',
      header: '优先级',
      width: '90px',
      render: (r) => {
        const m = priorityMeta(r.priority)
        return <Tag cls={m.cls}>{m.label}</Tag>
      },
    },
    {
      key: 'created_at',
      header: '提交时间',
      width: '170px',
      render: (r) => (
        <span className="text-muted-foreground tabular-nums">{fmtTime(r.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: '90px',
      render: (r) => (
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
      ),
    },
  ]

  return (
    <PageContainer className="flex flex-col">
      <PageHeader
        title="我的反馈"
        actions={
          <Button variant="primary" size="sm" onClick={() => setSubmitOpen(true)}>
            <MessageSquareWarning className="h-4 w-4" />
            提交反馈
          </Button>
        }
      />

      {/* 筛选栏 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <CompactSelect
          value={filters.type}
          onChange={(e) => applyFilters({ ...filters, type: e.target.value })}
          size="lg"
        >
          <option value="">全部类型</option>
          {FEEDBACK_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </CompactSelect>
        <CompactSelect
          value={filters.status}
          onChange={(e) => applyFilters({ ...filters, status: e.target.value })}
          size="lg"
        >
          <option value="">全部状态</option>
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </CompactSelect>
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

      {/* 空态：去提交 */}
      {!loading && rows.length === 0 && !error && (
        <div className="mt-2">
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Inbox className="h-6 w-6" />
            </div>
            <div className="text-sm font-medium text-foreground">暂无反馈记录</div>
            <div className="text-xs text-muted-foreground">
              发现系统 BUG 或有优化想法？欢迎提交反馈
            </div>
            <Button variant="primary" size="sm" className="mt-1" onClick={() => setSubmitOpen(true)}>
              <MessageSquareWarning className="h-4 w-4" />
              去提交
            </Button>
          </div>
        </div>
      )}

      {/* 提交反馈抽屉（本页独立渲染） */}
      <FeedbackDrawer open={submitOpen} onClose={() => setSubmitOpen(false)} onSubmitted={load} />

      {/* 详情抽屉 */}
      <DetailDrawer
        open={detailId != null}
        onClose={() => setDetailId(null)}
        feedbackId={detailId}
        onReopened={load}
      />
    </PageContainer>
  )
}

export default MyFeedback
