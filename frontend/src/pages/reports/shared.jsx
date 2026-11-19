// 报告中心公共常量与小组件：状态映射 / 时间格式化 / 表单字段包装
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button, StatusBadge } from '../../components/ui'

export const TEMPLATE_STATUS = {
  draft: { color: 'warning', label: '草稿' },
  published: { color: 'success', label: '已发布' },
  archived: { color: 'neutral', label: '已归档' },
}

export const VERSION_STATUS = {
  draft: { color: 'warning', label: '草稿' },
  published: { color: 'success', label: '已发布' },
  deprecated: { color: 'neutral', label: '已废弃' },
}

export const CONFIG_STATUS = {
  draft: { color: 'warning', label: '草稿' },
  published: { color: 'success', label: '已发布' },
  disabled: { color: 'neutral', label: '已停用' },
}

export const RUN_STATUS = {
  pending: { color: 'warning', label: '排队中' },
  collecting: { color: 'info', label: '采集中' },
  extracting: { color: 'info', label: '抽取中' },
  rendering: { color: 'info', label: '渲染中' },
  validating: { color: 'info', label: '校验中' },
  succeeded: { color: 'success', label: '成功' },
  partial: { color: 'warning', label: '部分成功' },
  failed: { color: 'danger', label: '失败' },
}

export const ARTIFACT_STATUS = {
  draft: { color: 'warning', label: '草稿' },
  pending_review: { color: 'warning', label: '待审核' },
  approved: { color: 'success', label: '已通过' },
  rejected: { color: 'danger', label: '已驳回' },
}

export function StatusOf({ map, value }) {
  const meta = map[String(value || '').toLowerCase()] || { color: 'neutral', label: value || '—' }
  return <StatusBadge color={meta.color} label={meta.label} />
}

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

// 表单字段：标题 + 必填星号 + 说明
export function Field({ label, required, hint, error, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-destructive">{error}</span>}
      {hint && <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-primary'

export const monoCls = `${inputCls} font-mono text-xs`

// 问题列表：校验结果统一渲染（错误红 / 警告黄）
export function IssueList({ issues = [], emptyText = '校验通过，未发现问题' }) {
  if (!issues.length) {
    return <p className="text-xs text-success">{emptyText}</p>
  }
  return (
    <ul className="space-y-1">
      {issues.map((issue, index) => {
        const isError = (issue.severity || 'error') === 'error'
        return (
          <li
            key={`${issue.code || 'issue'}-${index}`}
            className={`rounded border px-2 py-1 text-xs ${
              isError
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-warning/30 bg-warning/10 text-warning'
            }`}
          >
            <span className="font-mono text-xs opacity-80">{issue.code || 'ISSUE'}</span>
            <span className="ml-2">{issue.message || String(issue)}</span>
            {issue.path && <span className="ml-2 font-mono text-xs opacity-60">{issue.path}</span>}
          </li>
        )
      })}
    </ul>
  )
}

// PDF 保真预览：按需拉取服务端转换结果，内联 iframe 展示并支持下载
export function PdfPreviewPanel({ load, filename = 'preview.pdf', autoLoad = false }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const blobRef = useRef(null)
  const autoLoadedRef = useRef(false)

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])

  const loadPdf = async () => {
    setLoading(true)
    setError(null)
    try {
      const blob = await load()
      blobRef.current = blob
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
    } catch (err) {
      setError({ message: err.message || 'PDF 加载失败', code: err.code })
    } finally {
      setLoading(false)
    }
  }

  // 模板预览等场景打开即加载；ref 防止 StrictMode/重复渲染触发多次转换
  useEffect(() => {
    if (autoLoad && !autoLoadedRef.current) {
      autoLoadedRef.current = true
      loadPdf()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad])

  const download = async () => {
    try {
      const blob = blobRef.current || await load()
      blobRef.current = blob
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(href)
    } catch (err) {
      setError({ message: err.message || 'PDF 下载失败', code: err.code })
    }
  }

  const unavailable = error?.code === 'PDF_UNAVAILABLE'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" loading={loading} onClick={loadPdf}>
          {url ? '重新加载 PDF' : '加载 PDF'}
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>下载 PDF</Button>
      </div>
      {error && (
        <div
          className={`rounded border px-2 py-1.5 text-xs ${
            unavailable
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          }`}
        >
          {unavailable
            ? '当前部署未启用 PDF 转换：请安装 LibreOffice（libreoffice-writer + fonts-noto-cjk），或配置 REPORT_SOFFICE_BIN 指定 soffice 路径。'
            : error.message}
        </div>
      )}
      {url ? (
        <iframe
          title="PDF 预览"
          src={url}
          className="h-[70vh] w-full rounded border border-border bg-white"
        />
      ) : (
        <p className="text-xs text-muted-foreground">点击「加载 PDF」生成并预览服务端转换结果。</p>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// JSON 树：可折叠展示样例数据，点击节点生成 JSONPath（数组元素以 [*] 表示）
// --------------------------------------------------------------------------- //
export function JsonTree({ data, onSelect, selectedPath = '' }) {
  return (
    <div className="max-h-[60vh] overflow-auto rounded border border-border bg-muted/20 p-2 font-mono text-xs">
      <JsonTreeNode
        label="$"
        value={data}
        path="$"
        depth={0}
        onSelect={onSelect}
        selectedPath={selectedPath}
      />
    </div>
  )
}

function JsonTreeNode({ label, value, path, depth, onSelect, selectedPath }) {
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr
  const [open, setOpen] = useState(depth < 3)
  const selected = selectedPath === path

  const selectCls = `flex min-w-0 flex-1 items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-primary/10 ${
    selected ? 'bg-primary/15 ring-1 ring-primary/40' : ''
  }`

  // 叶子节点：直接点选生成路径
  if (!isArr && !isObj) {
    return (
      <button type="button" className={selectCls} onClick={() => onSelect?.(path)}>
        {label !== null && <span className="shrink-0 text-sky-600 dark:text-sky-400">{label}:</span>}
        <span className="truncate text-muted-foreground">{fmtLeaf(value)}</span>
        <span className="ml-auto shrink-0 pl-3 text-[10px] text-muted-foreground/60">{path}</span>
      </button>
    )
  }

  const isEmpty = isArr ? value.length === 0 : Object.keys(value).length === 0
  const summary = isArr ? `Array[${value.length}]` : `{${Object.keys(value).length}}`

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(!open)}
          disabled={isEmpty}
        >
          {isEmpty ? (
            <span className="inline-block w-3.5" />
          ) : open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <button type="button" className={selectCls} onClick={() => onSelect?.(path)}>
          {label !== null && <span className="shrink-0 text-sky-600 dark:text-sky-400">{label}:</span>}
          <span className={isEmpty ? 'text-muted-foreground/60' : 'text-muted-foreground'}>{summary}</span>
          <span className="ml-auto shrink-0 pl-3 text-[10px] text-muted-foreground/60">{path}</span>
        </button>
      </div>
      {open && !isEmpty && (
        <div className="ml-2 border-l border-border pl-2">
          {isArr
            ? renderArrayItems(value, path, depth, onSelect, selectedPath)
            : Object.entries(value).map(([k, v]) => (
                <JsonTreeNode
                  key={k}
                  label={k}
                  value={v}
                  path={`${path}.${k}`}
                  depth={depth + 1}
                  onSelect={onSelect}
                  selectedPath={selectedPath}
                />
              ))}
        </div>
      )}
    </div>
  )
}

// 数组节点：元素为对象时用第一个元素展示结构，路径以 [*] 表示"每一项"
function renderArrayItems(array, path, depth, onSelect, selectedPath) {
  const sample = array[0]
  const isObjectSample = sample !== null && typeof sample === 'object' && !Array.isArray(sample)
  if (!isObjectSample) {
    return (
      <div className="space-y-0.5 px-1.5 py-0.5">
        {array.slice(0, 5).map((item, index) => (
          <div key={index} className="truncate text-muted-foreground">{fmtLeaf(item)}</div>
        ))}
        {array.length > 5 && <div className="text-muted-foreground/60">… 共 {array.length} 项</div>}
      </div>
    )
  }
  return Object.entries(sample).map(([k, v]) => (
    <JsonTreeNode
      key={k}
      label={k}
      value={v}
      path={`${path}[*].${k}`}
      depth={depth + 1}
      onSelect={onSelect}
      selectedPath={selectedPath}
    />
  ))
}

function fmtLeaf(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value
    return `"${shown}"`
  }
  return String(value)
}
