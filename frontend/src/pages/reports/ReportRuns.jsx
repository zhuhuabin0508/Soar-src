// 报告运行中心：查看运行记录、数据源采集结果、校验结论与产物下载
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, RotateCcw } from 'lucide-react'
import { reportApi } from '../../api/reports'
import {
  Badge, Button, Card, CompactSelect, DataTable, PageContainer, PageHeader, Pagination, StatusBadge,
} from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import {
  ARTIFACT_STATUS, IssueList, PdfPreviewPanel, RUN_STATUS, StatusOf, fmtDuration, fmtTime,
} from './shared'

const PAGE_SIZE = 20

export default function ReportRuns() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [pdfTarget, setPdfTarget] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await reportApi.runs.list({ status, page, page_size: pageSize })
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message || '运行记录加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, page, pageSize])

  useEffect(() => { load() }, [load])

  const openDetail = async (run) => {
    try {
      const res = await reportApi.runs.detail(run.id)
      setDetail(res)
    } catch (err) {
      toast.error(err.message || '运行详情加载失败')
    }
  }

  const retry = async (run) => {
    try {
      const created = await reportApi.runs.retry(run.id)
      toast.success(`已重新提交运行 #${created.id}`)
      setDetail(null)
      load()
    } catch (err) {
      toast.error(err.message || '重试失败')
    }
  }

  const columns = useMemo(() => [
    { key: 'id', header: '运行', width: '8%', render: (row) => `#${row.id}` },
    {
      key: 'config',
      header: '配置',
      width: '18%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-foreground">{row.config_name || `配置 #${row.config_id}`}</div>
          <div className="text-xs text-muted-foreground">v{row.config_version_no}</div>
        </div>
      ),
    },
    { key: 'trigger', header: '触发', width: '10%', render: (row) => (row.trigger_type === 'schedule' ? '定时' : '手动') },
    { key: 'status', header: '状态', width: '12%', render: (row) => <StatusOf map={RUN_STATUS} value={row.status} /> },
    { key: 'duration', header: '耗时', width: '10%', render: (row) => fmtDuration(row.duration_ms) },
    { key: 'created_at', header: '开始时间', width: '18%', render: (row) => fmtTime(row.started_at || row.created_at) },
    {
      key: 'actions',
      header: '操作',
      width: '20%',
      render: (row) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => openDetail(row)}>详情</Button>
          {row.artifact_id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const artifactName = `report_${row.id}.docx`
                reportApi.runs.download(row.id, artifactName).catch((e) => toast.error(e.message))
              }}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {(row.status === 'failed' || row.status === 'partial') && hasPermission('report', 'execute') && (
            <Button size="sm" variant="ghost" onClick={() => retry(row)}>
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ], [])

  return (
    <PageContainer>
      <PageHeader
        title="运行中心"
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
            {Object.entries(RUN_STATUS).map(([value, meta]) => (
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
          onRowClick={openDetail}
          emptyText="暂无运行记录"
          emptyDescription="在报告配置的「预览与发布」中发布后，可立即运行或等待定时触发"
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
        open={!!detail}
        title={detail ? `运行详情 #${detail.run.id}` : ''}
        size="xl"
        onClose={() => setDetail(null)}
        footer={(
          <>
            {detail?.artifact && (
              <Button
                variant="ghost"
                onClick={() => setPdfTarget({
                  runId: detail.run.id,
                  filename: `${(detail.artifact.file_name || `report_${detail.run.id}.docx`).replace(/\.docx$/i, '')}.pdf`,
                })}
              >
                PDF 预览
              </Button>
            )}
            {detail?.artifact && (
              <Button
                variant="ghost"
                onClick={() => reportApi.runs
                  .download(detail.run.id, detail.artifact.file_name)
                  .catch((e) => toast.error(e.message))}
              >
                <Download className="mr-1 h-3.5 w-3.5" />下载报告
              </Button>
            )}
            {(detail?.run.status === 'failed' || detail?.run.status === 'partial') && hasPermission('report', 'execute') && (
              <Button variant="primary" onClick={() => retry(detail.run)}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />重试
              </Button>
            )}
            <Button onClick={() => setDetail(null)}>关闭</Button>
          </>
        )}
      >
        {detail && <RunDetail detail={detail} />}
      </Modal>

      <Modal
        open={!!pdfTarget}
        title={pdfTarget ? `PDF 预览 #${pdfTarget.runId}` : ''}
        size="xl"
        onClose={() => setPdfTarget(null)}
        footer={<Button onClick={() => setPdfTarget(null)}>关闭</Button>}
      >
        {pdfTarget && (
          <PdfPreviewPanel
            load={() => reportApi.runs.pdf(pdfTarget.runId)}
            filename={pdfTarget.filename}
          />
        )}
      </Modal>
    </PageContainer>
  )
}

function RunDetail({ detail }) {
  const { run, sources = [], artifact } = detail
  const validation = run.validation || {}
  const issues = validation.issues || []
  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusOf map={RUN_STATUS} value={run.status} />
        <span className="text-muted-foreground">配置 v{run.config_version_no}</span>
        <span className="text-muted-foreground">触发：{run.trigger_type === 'schedule' ? '定时' : '手动'}</span>
        <span className="text-muted-foreground">耗时 {fmtDuration(run.duration_ms)}</span>
        <span className="text-muted-foreground">{fmtTime(run.started_at)} → {fmtTime(run.finished_at)}</span>
        {artifact && <Badge variant="info">{ARTIFACT_STATUS[artifact.status]?.label || artifact.status}</Badge>}
      </div>

      {run.error_code && (
        <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
          {run.error_code}: {run.error_message}
        </p>
      )}

      {!!Object.keys(run.params || {}).length && (
        <div>
          <p className="mb-1 font-medium text-foreground">运行参数</p>
          <pre className="rounded border border-border bg-muted/40 p-2 font-mono text-xs">
            {JSON.stringify(run.params, null, 2)}
          </pre>
        </div>
      )}

      <Card title="数据源采集" bodyClassName="p-0">
        <DataTable
          rowKey="id"
          data={sources}
          emptyText="无采集记录"
          columns={[
            { key: 'source_key', header: '数据源', width: '18%', render: (r) => <span className="font-mono">{r.source_key}</span> },
            { key: 'source_type', header: '类型', width: '12%', render: (r) => r.source_type },
            {
              key: 'status',
              header: '结果',
              width: '12%',
              render: (r) => <StatusBadge color={r.status === 'success' ? 'success' : 'danger'} label={r.status === 'success' ? '成功' : (r.error_code || '失败')} />,
            },
            { key: 'latency', header: '耗时', width: '10%', render: (r) => fmtDuration(r.latency_ms) },
            { key: 'retry', header: '重试', width: '8%', render: (r) => r.retry_count ?? 0 },
            { key: 'http', header: 'HTTP', width: '8%', render: (r) => r.status_code || '—' },
            { key: 'error', header: '错误信息', width: '32%', render: (r) => r.error_message || '—' },
          ]}
        />
      </Card>

      <Card title="校验结论" description={`L2 采集与 L3 渲染前校验`}>
        <IssueList issues={issues} />
        {validation.checks && (
          <pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
            {JSON.stringify(validation.checks, null, 2)}
          </pre>
        )}
      </Card>

      {run.snapshot && Object.keys(run.snapshot).length > 0 && (
        <Card title="数据快照" description="用于复现该次报告的数据上下文">
          <pre className="max-h-56 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
            {JSON.stringify(run.snapshot, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  )
}
