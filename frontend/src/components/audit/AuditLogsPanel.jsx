// 审计日志共享面板：系统监控「审计日志」Tab 与系统管理「审计日志」独立页复用
// 展示：时间 / 操作人 / 操作类型 / 对象类型 / 对象名称 / 结果 / 来源 IP / 变更详情（diff）
// 供筛选：操作类型 / 资源类型 / 结果 / 用户名 / IP / 时间范围，支持 CSV 导出（管理员只读）
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { ClipboardList, Copy } from 'lucide-react'
import { toast } from '../../store/toastStore'
import { systemMonitorApi } from '../../api/systemMonitor'
import { CompactSelect, DatePicker } from '../ui'

// 资源类型中文映射
export const RESOURCE_LABELS = {
  workflow: '工作流', tool: '工具', agent: '智能体', user: '用户', role: '角色',
  auth: '认证', asset: '资产', banned_ip: '封禁 IP', knowledge_base: '知识库',
  skill: '技能', llm_config: 'LLM 配置', system_config: '系统配置', session: '会话',
  audit_log: '审计日志', backup: '备份', notification: '通知', execution: '执行',
  device: '设备', strategy: '解析模板', log_receiver: '接收器', log_source_entry: '数据源条目',
}
// 操作类型中文映射 + 颜色
export const ACTION_META = {
  login: { label: '登录', cls: 'bg-primary/20 text-primary', icon: '🔑' },
  logout: { label: '登出', cls: 'bg-muted text-muted-foreground', icon: '🚪' },
  create: { label: '创建', cls: 'bg-success/20 text-success', icon: '➕' },
  update: { label: '更新', cls: 'bg-info/20 text-info', icon: '✏️' },
  delete: { label: '删除', cls: 'bg-destructive/20 text-destructive', icon: '🗑️' },
  execute: { label: '执行', cls: 'bg-primary/20 text-primary', icon: '⚡' },
  export: { label: '导出', cls: 'bg-warning/20 text-warning', icon: '📤' },
  upload: { label: '导入', cls: 'bg-warning/20 text-warning', icon: '📥' },
  publish: { label: '发布', cls: 'bg-success/20 text-success', icon: '🚀' },
  rollback: { label: '回滚', cls: 'bg-warning/20 text-warning', icon: '↩️' },
}
export const ACTION_OPTIONS = ['login', 'logout', 'create', 'update', 'delete', 'execute', 'export', 'upload', 'publish', 'rollback']
const RESOURCE_OPTIONS = Object.keys(RESOURCE_LABELS)

export function ActionBadge({ action }) {
  const meta = ACTION_META[action] || { label: action || '-', cls: 'bg-secondary text-muted-foreground', icon: '' }
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
}

export function ResultBadge({ result }) {
  const isSuccess = result === 'success' || result === 'ok' || result === true
  const isFailed = result === 'failed' || result === 'fail' || result === 'error'
  if (isSuccess) return <span className="rounded bg-success/20 px-2 py-0.5 text-[11px] font-medium text-success">成功</span>
  if (isFailed) return <span className="rounded bg-destructive/20 px-2 py-0.5 text-[11px] font-medium text-destructive">失败</span>
  return <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{result || '-'}</span>
}

// ============ 面板内部工具 ============
const PAGE_SIZE = 50

function fmtTime(t) {
  if (!t) return '-'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}

function fmtDetail(detail) {
  if (detail == null || detail === '') return ''
  if (typeof detail === 'string') {
    try { return JSON.stringify(JSON.parse(detail), null, 2) } catch { return detail }
  }
  try { return JSON.stringify(detail, null, 2) } catch { return String(detail) }
}

// JSON 语法高亮
function highlightJson(jsonStr) {
  const safe = String(jsonStr).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return safe.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*([eE][+-]?\d+)?)/g, (match) => {
    let cls = 'text-warning'
    if (/^"/.test(match)) cls = /:$/.test(match) ? 'text-primary' : 'text-success'
    else if (/true|false/.test(match)) cls = 'text-info'
    else if (/null/.test(match)) cls = 'text-muted-foreground'
    return `<span class="${cls}">${match}</span>`
  })
}

function copyText(text) {
  if (!text) return
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast.success('已复制')).catch(() => {}) }
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast.success('已复制') } catch {} document.body.removeChild(ta) }
}

// 时间快捷范围
function getQuickRange(key) {
  const now = new Date()
  const fmt = (d) => d.toISOString().slice(0, 16)
  switch (key) {
    case 'today': { const s = new Date(now); s.setHours(0, 0, 0, 0); return { start: fmt(s), end: fmt(now) } }
    case '24h': { const s = new Date(now.getTime() - 24 * 3600000); return { start: fmt(s), end: fmt(now) } }
    case '7d': { const s = new Date(now.getTime() - 7 * 86400000); return { start: fmt(s), end: fmt(now) } }
    case '30d': { const s = new Date(now.getTime() - 30 * 86400000); return { start: fmt(s), end: fmt(now) } }
    default: return { start: '', end: '' }
  }
}

// 从 detail JSON 提取对象名称（设备/接收器/条目/模板等业务审计的 name / strategy_name）
function extractObjectName(log) {
  const raw = log?.detail
  if (!raw) return ''
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw
    return d?.name || d?.strategy_name || ''
  } catch { return '' }
}

// ============ 审计日志面板 ============
export default function AuditLogsPanel() {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [onlyFailed, setOnlyFailed] = useState(false)

  // 默认最近 24 小时
  const defaultRange = useMemo(() => getQuickRange('24h'), [])
  const [filters, setFilters] = useState({ action: '', resource_type: '', username: '', ip_address: '', result: '', start_time: defaultRange.start, end_time: defaultRange.end })
  const [input, setInput] = useState({ ...filters, quickRange: '24h' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = { limit: PAGE_SIZE, offset }
      Object.assign(params, filters)
      if (onlyFailed) params.result = 'failed'
      const res = await systemMonitorApi.auditLogs(params)
      setLogs(res?.logs || []); setTotal(res?.total ?? 0); setError('')
    } catch (err) { setError(err.message || '加载失败') } finally { setLoading(false) }
  }, [offset, filters, onlyFailed])

  useEffect(() => { load() }, [load])

  const handleQuery = () => { setOffset(0); setFilters({ action: input.action, resource_type: input.resource_type, username: input.username, ip_address: input.ip_address, result: input.result, start_time: input.start_time, end_time: input.end_time }); setExpandedId(null) }
  const handleReset = () => { const r = getQuickRange('24h'); setInput({ action: '', resource_type: '', username: '', ip_address: '', result: '', start_time: r.start, end_time: r.end, quickRange: '24h' }); setOffset(0); setFilters({ action: '', resource_type: '', username: '', ip_address: '', result: '', start_time: r.start, end_time: r.end }); setOnlyFailed(false); setExpandedId(null) }
  const handleQuickRange = (key) => { const r = getQuickRange(key); setInput((p) => ({ ...p, quickRange: key, start_time: r.start, end_time: r.end })) }

  const handleExport = () => {
    const url = systemMonitorApi.auditLogsExportUrl({ ...filters, ...(onlyFailed ? { result: 'failed' } : {}) })
    const token = localStorage.getItem('soar_token')
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error('导出失败'); const d = r.headers.get('content-disposition') || ''; const m = d.match(/filename="?(.+?)"?$/); return r.blob().then((b) => ({ blob: b, filename: m ? m[1] : `audit_logs_${Date.now()}.csv` })) })
      .then(({ blob, filename }) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href) })
      .catch(() => toast.error('导出失败'))
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selectCls = 'h-9 rounded-md border border-border bg-secondary px-2.5 text-xs text-foreground outline-none transition hover:border-primary/45 focus:border-primary'
  const inputCls = 'h-9 min-w-0 flex-1 rounded-md border border-border bg-secondary px-2.5 text-xs text-foreground outline-none transition placeholder:text-muted-foreground hover:border-primary/45 focus:border-primary'

  return (
    <div className="flex flex-col gap-4">
      {/* 筛选栏：基准卡片条 */}
      <div className="rounded-md border border-border bg-card px-4 py-2.5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围：</span>
          {[['24h', '最近24小时'], ['today', '今天'], ['7d', '最近7天'], ['30d', '最近30天'], ['custom', '自定义']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => handleQuickRange(k)} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${input.quickRange === k ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/50'}`}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CompactSelect size="lg" value={input.action} onChange={(e) => setInput((p) => ({ ...p, action: e.target.value }))}>
            <option value="">全部操作</option>
            {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{ACTION_META[a]?.label || a}</option>)}
          </CompactSelect>
          <CompactSelect size="lg" value={input.resource_type} onChange={(e) => setInput((p) => ({ ...p, resource_type: e.target.value }))}>
            <option value="">全部资源</option>
            {RESOURCE_OPTIONS.map((r) => <option key={r} value={r}>{RESOURCE_LABELS[r]}</option>)}
          </CompactSelect>
          <CompactSelect size="lg" value={input.result} onChange={(e) => setInput((p) => ({ ...p, result: e.target.value }))}>
            <option value="">全部结果</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </CompactSelect>
          <input value={input.username} onChange={(e) => setInput((p) => ({ ...p, username: e.target.value }))} placeholder="用户名..." className={inputCls} onKeyDown={(e) => e.key === 'Enter' && handleQuery()} />
          <input value={input.ip_address} onChange={(e) => setInput((p) => ({ ...p, ip_address: e.target.value }))} placeholder="IP 地址..." className={inputCls} onKeyDown={(e) => e.key === 'Enter' && handleQuery()} />
          {input.quickRange === 'custom' && (
            <>
              <DatePicker type="datetime" value={input.start_time} onChange={(e) => setInput((p) => ({ ...p, start_time: e.target.value }))} />
              <DatePicker type="datetime" value={input.end_time} onChange={(e) => setInput((p) => ({ ...p, end_time: e.target.value }))} />
            </>
          )}
          <button type="button" onClick={handleQuery} className="btn-primary btn-sm">查询</button>
          <button type="button" onClick={handleReset} className="btn-secondary btn-sm">重置</button>
          <button type="button" onClick={handleExport} className="btn-secondary btn-sm">导出 CSV</button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyFailed} onChange={(e) => { setOnlyFailed(e.target.checked); setOffset(0) }} className="h-3.5 w-3.5 accent-destructive" />
            <span className="text-destructive">仅看失败</span>
          </label>
        </div>
      </div>

      {error && <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* 日志表格 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
      ) : logs.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground"><ClipboardList className="h-10 w-10" /><div className="text-sm">未查询到符合条件的日志</div></div>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[980px] table-fixed border-collapse text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="w-36 px-4 py-3 text-left font-medium">时间</th>
                <th className="w-24 px-4 py-3 text-left font-medium">用户名</th>
                <th className="w-20 px-4 py-3 text-left font-medium">操作类型</th>
                <th className="w-24 px-4 py-3 text-left font-medium">资源类型</th>
                <th className="w-32 px-4 py-3 text-left font-medium">对象名称</th>
                <th className="w-20 px-4 py-3 text-left font-medium">结果</th>
                <th className="px-4 py-3 text-left font-medium">IP / 失败原因</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => {
                const expanded = expandedId === log.id
                const detail = fmtDetail(log.detail)
                const isFailed = log.result === 'failed' || log.result === 'error'
                const objectName = extractObjectName(log)
                return (
                  <Fragment key={log.id}>
                    <tr onClick={() => setExpandedId(expanded ? null : log.id)} className={`cursor-pointer border-t border-border transition-colors hover:bg-primary/5 ${isFailed ? 'bg-destructive/5' : idx % 2 === 0 ? 'bg-muted' : 'bg-card'}`}>
                      <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">{fmtTime(log.created_at)}</td>
                      <td className="truncate px-4 py-3 tabular-nums text-foreground">{log.username || '-'}</td>
                      <td className="px-4 py-3"><ActionBadge action={log.action} /></td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{RESOURCE_LABELS[log.resource_type] || log.resource_type || '-'}</td>
                      <td className="truncate px-4 py-3 text-foreground" title={objectName || (log.resource_id != null ? `ID: ${log.resource_id}` : '')}>
                        {objectName || <span className="font-mono text-xs text-primary">{log.resource_id ?? '-'}</span>}
                      </td>
                      <td className="px-4 py-3"><ResultBadge result={log.result} /></td>
                      <td className="truncate px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground">
                        {isFailed && log.detail ? (typeof log.detail === 'string' ? log.detail.slice(0, 60) : JSON.stringify(log.detail).slice(0, 60)) : (log.ip_address || '-')}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-t border-border bg-background">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">详情（点击行收起）</span>
                            <button onClick={() => copyText(detail || '')} className="flex items-center gap-1 text-[11px] text-primary hover:underline"><Copy className="h-3 w-3" /> 复制</button>
                          </div>
                          {detail ? (
                            <pre className="max-h-72 w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-4 font-mono text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: highlightJson(detail) }} />
                          ) : <div className="text-xs text-muted-foreground">暂无详情</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {!loading && logs.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">共 {total} 条，第 {currentPage} / {totalPages} 页</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setExpandedId(null) }} disabled={offset === 0} className="btn-secondary btn-sm">上一页</button>
            <button type="button" onClick={() => { setOffset(offset + PAGE_SIZE); setExpandedId(null) }} disabled={offset + PAGE_SIZE >= total} className="btn-secondary btn-sm">下一页</button>
          </div>
        </div>
      )}
    </div>
  )
}
