// 报告审核：产物列表、下载、通过 / 驳回并记录审核意见
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Download, FileText, RefreshCw, X } from 'lucide-react'
import { reportApi } from '../../api/reports'
import {
  Button, Card, CompactSelect, DataTable, PageContainer, PageHeader, Pagination,
} from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import { ARTIFACT_STATUS, Field, PdfPreviewPanel, StatusOf, fmtTime, inputCls } from './shared'

const PAGE_SIZE = 20

export default function ReportAudits() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [status, setStatus] = useState('pending_review')
  const [loading, setLoading] = useState(false)
  const [reviewTarget, setReviewTarget] = useState(null)
  const [reviewAction, setReviewAction] = useState('approve')
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pdfTarget, setPdfTarget] = useState(null)
  const [exportFormat, setExportFormat] = useState('docx')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await reportApi.artifacts.list({ status, page, page_size: pageSize })
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message || '报告产物加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, page, pageSize])

  useEffect(() => { load() }, [load])

  const openReview = (row, action) => {
    setReviewTarget(row)
    setReviewAction(action)
    setComment('')
  }

  const submitReview = async () => {
    if (!reviewTarget) return
    if (reviewAction === 'reject' && !comment.trim()) {
      toast.warning('驳回时请填写审核意见')
      return
    }
    setSubmitting(true)
    try {
      await reportApi.artifacts.review(reviewTarget.id, reviewAction, comment)
      toast.success(reviewAction === 'approve' ? '已通过审核' : '已驳回')
      setReviewTarget(null)
      load()
    } catch (err) {
      toast.error(err.message || '审核失败')
    } finally {
      setSubmitting(false)
    }
  }

  const columns = useMemo(() => [
    { key: 'id', header: '产物', width: '8%', render: (row) => `#${row.id}` },
    { key: 'run', header: '运行', width: '10%', render: (row) => (row.run_id ? `#${row.run_id}` : '—') },
    {
      key: 'file_name',
      header: '文件',
      width: '22%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-foreground">{row.file_name}</div>
          <div className="text-xs text-muted-foreground">{Math.round((row.file_size || 0) / 1024)} KB</div>
        </div>
      ),
    },
    { key: 'status', header: '状态', width: '12%', render: (row) => <StatusOf map={ARTIFACT_STATUS} value={row.status} /> },
    { key: 'created_at', header: '生成时间', width: '16%', render: (row) => fmtTime(row.created_at) },
    { key: 'review', header: '审核意见', width: '12%', render: (row) => row.review_comment || '—' },
    {
      key: 'actions',
      header: '操作',
      width: '20%',
      render: (row) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPdfTarget({
              id: row.id,
              filename: `${(row.file_name || `report_${row.id}.docx`).replace(/\.docx$/i, '')}.pdf`,
            })}
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
          {hasPermission('report', 'export') && (
            <div className="flex items-center gap-1">
              <CompactSelect
                size="sm"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value)}
                title="导出格式"
              >
                <option value="docx">DOCX</option>
                <option value="pdf">PDF</option>
                <option value="html">HTML</option>
              </CompactSelect>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => reportApi.artifacts
                  .download(row.id, row.file_name, exportFormat)
                  .catch((e) => toast.error(e.message))}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {['draft', 'pending_review'].includes(row.status) && hasPermission('report', 'publish') && (
            <>
              <Button size="sm" variant="ghost" onClick={() => openReview(row, 'approve')}>
                <Check className="h-3.5 w-3.5 text-success" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openReview(row, 'reject')}>
                <X className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ], [])

  return (
    <PageContainer>
      <PageHeader
        title="报告审核"
        actions={(
          <Button variant="ghost" onClick={load} loading={loading}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />刷新
          </Button>
        )}
      />

      <Card bodyClassName="p-3" className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <CompactSelect value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            {Object.entries(ARTIFACT_STATUS).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </CompactSelect>
        </div>
      </Card>

      <Card bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={items}
          loading={loading}
          rowKey="id"
          emptyText="暂无报告产物"
          emptyDescription="运行成功后会自动生成 docx 产物并进入待审核列表"
        />
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
        />
      </Card>

      <Modal
        open={!!reviewTarget}
        title={reviewAction === 'approve' ? '审核通过' : '驳回报告'}
        onClose={() => setReviewTarget(null)}
        footer={(
          <>
            <Button onClick={() => setReviewTarget(null)}>取消</Button>
            <Button
              variant={reviewAction === 'approve' ? 'primary' : 'danger'}
              loading={submitting}
              onClick={submitReview}
            >
              确认{reviewAction === 'approve' ? '通过' : '驳回'}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            报告：{reviewTarget?.file_name}
          </p>
          <Field label="审核意见" required={reviewAction === 'reject'}>
            <textarea
              className={inputCls}
              rows={4}
              value={comment}
              placeholder={reviewAction === 'reject' ? '请说明驳回原因与修改建议' : '可选'}
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!pdfTarget}
        title={pdfTarget ? `PDF 预览 #${pdfTarget.id}` : ''}
        size="xl"
        onClose={() => setPdfTarget(null)}
        footer={<Button onClick={() => setPdfTarget(null)}>关闭</Button>}
      >
        {pdfTarget && (
          <PdfPreviewPanel
            load={() => reportApi.artifacts.pdf(pdfTarget.id)}
            filename={pdfTarget.filename}
          />
        )}
      </Modal>
    </PageContainer>
  )
}
