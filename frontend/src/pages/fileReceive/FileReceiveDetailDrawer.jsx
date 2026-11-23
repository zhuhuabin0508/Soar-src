// 文件接收详情抽屉：基础信息 / 业务字段 / 文件信息 / 分片 / 状态轨迹
import { Badge, Button, EmptyState } from '../../components/ui'
import { Drawer } from '../../components/Dialog'
import {
  AlertCircle, CheckCircle2, Clock, Download, FileText, Loader2, RotateCcw, ShieldCheck,
} from 'lucide-react'
import { formatSize, formatTime, STATUS_META, bizTypeLabel } from './constants'

function Row({ label, children, mono = false }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`min-w-0 break-words text-xs text-foreground ${mono ? 'font-mono' : ''}`}>
        {children ?? '—'}
      </div>
    </div>
  )
}

function Section({ title, children, extra }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  )
}

function renderFieldValue(value) {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default function FileReceiveDetailDrawer({
  open,
  onClose,
  detail,
  loading = false,
  onDownload,
  onRetry,
  canDownload = false,
  canManage = false,
}) {
  const record = detail?.record
  const file = detail?.file
  const parts = detail?.parts
  const events = detail?.events || []
  const statusMeta = record ? STATUS_META[record.status] : null

  const footer = record ? (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="truncate text-xs text-muted-foreground">
        {record.error_code ? `错误码：${record.error_code}` : `请求 ID：${record.request_id}`}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canManage && record.status === 'FAILED' && record.retryable && (
          <Button variant="secondary" size="sm" onClick={() => onRetry?.(record)}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重试
          </Button>
        )}
        {canDownload && record.storage_path && (
          <Button variant="primary" size="sm" onClick={() => onDownload?.(record)}>
            <Download className="mr-1 h-3.5 w-3.5" /> 下载文件
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
      </div>
    </div>
  ) : null

  return (
    <Drawer open={open} title="文件接收详情" onClose={onClose} width="w-[760px]" footer={footer}>
      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载详情中...
        </div>
      ) : !record ? (
        <EmptyState title="暂无详情" description="请稍后重试或刷新列表" />
      ) : (
        <div className="space-y-3">
          <Section
            title="基本信息"
            extra={statusMeta && (
              <Badge variant={statusMeta.variant}>
                {statusMeta.spinning && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {statusMeta.label}
              </Badge>
            )}
          >
            <Row label="请求 ID" mono>{record.request_id}</Row>
            <Row label="接收任务 ID" mono>{record.id}</Row>
            <Row label="来源系统">{record.source_name}（{record.source_code}）</Row>
            <Row label="业务类型">{bizTypeLabel(record.biz_type)}</Row>
            <Row label="业务单号" mono>{record.biz_no}</Row>
            <Row label="推送时间">{formatTime(record.push_time)}</Row>
            <Row label="接收时间">{formatTime(record.received_at)}</Row>
            <Row label="完成时间">{formatTime(record.completed_at)}</Row>
            <Row label="客户端 IP" mono>{record.client_ip || '—'}</Row>
            {record.is_duplicate && (
              <Row label="重复推送">
                与记录 {record.dedupe_of_id || '—'} 内容重复，已复用物理存储
              </Row>
            )}
            {record.error_code && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 break-words">
                  <div className="font-medium">{record.error_code}</div>
                  <div className="mt-0.5">{record.error_message || '接收失败'}</div>
                </div>
              </div>
            )}
          </Section>

          <Section title="业务字段">
            <div className="grid gap-x-6 md:grid-cols-2">
              {Object.keys(record.biz_fields || {}).length === 0 ? (
                <div className="py-2 text-xs text-muted-foreground">未携带扩展业务字段</div>
              ) : (
                Object.entries(record.biz_fields || {}).map(([key, value]) => (
                  <Row key={key} label={key} mono={typeof value !== 'string'}>
                    {renderFieldValue(value)}
                  </Row>
                ))
              )}
            </div>
          </Section>

          <Section title="文件信息">
            <div className="flex items-center gap-3 rounded-md bg-secondary/60 p-3">
              <FileText className="h-8 w-8 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{file?.file_name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {String(file?.file_ext || '').toUpperCase()} · {file?.file_size > 0 ? formatSize(file.file_size) : '大小待完成统计'}
                </div>
              </div>
            </div>
            <div className="mt-2">
              <Row label="声明类型">{file?.content_type || '—'}</Row>
              <Row label="检测类型">{file?.detected_mime || '—'}</Row>
              <Row label="SHA-256" mono>
                {file?.file_sha256 || (record.status === 'SUCCESS' ? '—' : '待完成计算')}
              </Row>
              <Row label="存储路径" mono>{file?.storage_path || '—'}</Row>
              <Row label="存储后端">{file?.storage_backend || 'local'}</Row>
              <Row label="压缩包巡检">
                {file?.archive_check === 'passed' ? '通过' : file?.archive_check === 'skipped' ? '跳过（依赖缺失）' : file?.archive_check === 'failed' ? '未通过' : '不适用'}
              </Row>
              <Row label="病毒扫描">{file?.scan_status === 'passed' ? '通过' : file?.scan_status === 'failed' ? '检出风险' : '未启用'}</Row>
            </div>
          </Section>

          <Section
            title="接收进度"
            extra={(
              <span className="text-xs text-muted-foreground">
                {parts?.total > 0
                  ? `${parts?.received || 0}/${parts.total} 片`
                  : `已收 ${parts?.received || 0} 片（总数待完成）`}
              </span>
            )}
          >
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.round(((parts?.received || 0) / Math.max(1, parts?.total || 1)) * 100))}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>已上传字节：{formatSize(parts?.uploaded_bytes)}</span>
              <span>文件大小：{file?.file_size > 0 ? formatSize(file.file_size) : '待完成统计'}</span>
              <span>分片大小：{formatSize(record.chunk_size)}</span>
            </div>
            {parts?.items?.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-primary">查看分片明细</summary>
                <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border">
                  {parts.items.map((p) => (
                    <div key={p.part_no} className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] last:border-b-0">
                      <span className="font-mono">#{p.part_no}</span>
                      <span className="text-muted-foreground">{formatSize(p.part_size)}</span>
                      <span className="max-w-[260px] truncate font-mono text-muted-foreground">{p.part_sha256}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Section>

          <Section title="状态轨迹">
            {events.length === 0 ? (
              <div className="py-2 text-xs text-muted-foreground">暂无状态事件</div>
            ) : (
              <ol className="space-y-3">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      {event.status_to === 'SUCCESS' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : event.status_to === 'FAILED' ? (
                        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                      ) : event.status_to === 'VERIFYING' ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                      ) : (
                        <Clock className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 border-b border-border/60 pb-2 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-foreground">{event.message || event.event_type}</span>
                        {event.status_to && <Badge variant="neutral">{event.status_to}</Badge>}
                        <span className="ml-auto text-[11px] text-muted-foreground">{formatTime(event.created_at)}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {event.event_type} · {event.actor || 'system'}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  )
}
