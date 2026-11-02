/**
 * 工具调用垂直时间线
 *
 * 替换原 ToolCallItem 列表，改为垂直时间线：
 * - 左侧竖线连接各节点
 * - 圆点图标按状态着色（绿色 ✓ / 蓝色 spinner / 红色 ✗）
 * - 工具名等宽字体 + 时间戳 + 耗时
 * - 详情默认折叠，点击展开输入参数和返回结果
 *
 * Props:
 * - toolCalls: Array<{ name, status, result, message, call_id, started_at?, completed_at? }>
 */
import { useState } from 'react'
import { Check, Loader2, AlertTriangle, ChevronRight, Download, FileText } from 'lucide-react'
import { agentFiles } from '../../api/client'

/** 解析 generate_document 工具的成功结果为下载信息（result 可能是对象或 JSON 字符串）。 */
function parseDocFile(tc) {
  if (tc.name !== 'generate_document' || tc.result == null) return null
  let result = tc.result
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return null }
  }
  if (result && typeof result === 'object' && result.ok && result.file_id) return result
  return null
}

function ToolNode({ tc, idx, total }) {
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const running = tc.status === 'running'
  const isError = !!(tc.message && (tc.message.includes('错误') || tc.message.includes('error')))
  const isLast = idx === total - 1

  // generate_document 成功 → 渲染文档下载卡片（预览入口）
  const docFile = parseDocFile(tc)

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await agentFiles.download(docFile.file_id, docFile.file_name)
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(e.message || '下载失败')
    } finally {
      setDownloading(false)
    }
  }

  // 序列化结果
  let resultStr = ''
  if (tc.result !== null && tc.result !== undefined) {
    if (typeof tc.result === 'string') {
      resultStr = tc.result
    } else {
      try {
        resultStr = JSON.stringify(tc.result, null, 2)
      } catch {
        resultStr = String(tc.result)
      }
    }
  }

  // 计算耗时
  let duration = ''
  if (tc.started_at && tc.completed_at) {
    const ms = new Date(tc.completed_at) - new Date(tc.started_at)
    if (ms > 0) {
      duration = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
    }
  }

  // 时间戳
  const timestamp = tc.started_at
    ? new Date(tc.started_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : ''

  return (
    <div className="relative flex gap-3 pb-3 last:pb-0">
      {/* 左侧时间线 */}
      <div className="flex flex-col items-center">
        {/* 节点圆点 */}
        <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          running
            ? 'border-primary bg-primary/15'
            : isError
            ? 'border-destructive bg-destructive/15'
            : 'border-emerald-500 bg-emerald-500/15'
        }`}>
          {running
            ? <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
            : isError
            ? <AlertTriangle className="h-2.5 w-2.5 text-destructive" />
            : <Check className="h-2.5 w-2.5 text-emerald-500" />}
        </div>
        {/* 连接线 */}
        {!isLast && (
          <div className="mt-0.5 w-0.5 flex-1 bg-border" />
        )}
      </div>

      {/* 右侧内容 */}
      <div className="min-w-0 flex-1 pt-0.5">
        {/* 工具名行 */}
        <button
          type="button"
          onClick={() => (resultStr || tc.message) && setOpen((v) => !v)}
          className={`flex w-full items-center gap-2 text-left ${resultStr || tc.message ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {(resultStr || tc.message) && (
            <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
          )}
          <span className="font-mono text-xs text-foreground">{tc.name}</span>
          {timestamp && (
            <span className="text-[10px] text-muted-foreground">{timestamp}</span>
          )}
          {duration && (
            <span className="rounded bg-secondary px-1 text-[9px] text-muted-foreground">{duration}</span>
          )}
          {tc.message && !resultStr && (
            <span className="truncate text-[10px] text-muted-foreground">{tc.message}</span>
          )}
          {(resultStr || tc.message) && (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {open ? '收起' : '详情'}
            </span>
          )}
        </button>
        {/* generate_document 成功：展示文档文件卡片与下载入口（无需展开详情即可见） */}
        {docFile && (
          <div className="mt-1 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5">
            <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span className="truncate text-xs font-medium text-foreground" title={docFile.file_name}>
              {docFile.file_name}
            </span>
            {docFile.file_size != null && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {(docFile.file_size / 1024).toFixed(1)} KB
              </span>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              <Download className="h-3 w-3" />
              {downloading ? '下载中…' : '下载'}
            </button>
          </div>
        )}
        {/* 展开详情 */}
        {open && (resultStr || tc.message) && (
          <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
            {resultStr || tc.message}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ToolTimeline({ toolCalls = [], embedded = false }) {
  if (!toolCalls.length) return null
  // embedded：嵌入「执行过程」面板内部使用（外层已提供圆角浅灰底与内边距）
  return (
    <div className={embedded ? '' : 'mt-1.5 rounded-lg border border-border bg-card p-2.5'}>
      <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>执行链路</span>
        <span className="text-muted-foreground">({toolCalls.length} 步)</span>
      </div>
      <div>
        {toolCalls.map((tc, idx) => (
          <ToolNode key={tc.call_id || idx} tc={tc} idx={idx} total={toolCalls.length} />
        ))}
      </div>
    </div>
  )
}
