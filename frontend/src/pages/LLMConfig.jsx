import { Fragment, useEffect, useState, useCallback, useMemo } from 'react'
import {
  BarChart3, Check, X, Trash2, Copy, Eye, EyeOff, Plus, RefreshCw,
  Activity, Zap, Timer, TrendingUp, TrendingDown, AlertTriangle,
  ChevronDown, ChevronRight, ExternalLink, History, Files,
} from 'lucide-react'
import { llmConfigs as llmApi } from '../api/client'
import { systemConfigApi } from '../api/systemConfig'
import {
  Section,
  TextInput,
  SelectInput,
  CheckRow,
} from '../components/property/FormControls'
import { Modal } from '../components/Dialog'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { LLM_TUTORIAL } from '../components/tutorialContent'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { DataTable, Pagination, CompactSelect } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'

// ============ 常量映射 ============
// 模型类型 → 中文 + 颜色
const MODEL_TYPE_META = {
  chat: { label: '对话', cls: 'bg-success/20 text-success' },
  embedding: { label: '向量化', cls: 'bg-primary/20 text-primary' },
  vision: { label: '视觉', cls: 'bg-purple-500/20 text-purple-400' },
  rerank: { label: '重排序', cls: 'bg-warning/20 text-warning' },
}
// 健康状态 → 中文 + 颜色
const HEALTH_META = {
  healthy: { label: '正常', cls: 'bg-success/20 text-success', dot: 'bg-success' },
  unhealthy: { label: '异常', cls: 'bg-destructive/20 text-destructive', dot: 'bg-destructive' },
  untested: { label: '未测试', cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
}
// 来源映射
const TRIGGER_LABELS = {
  agent_test: '智能体对话',
  manual_test: '手动测试',
  workflow: '工作流',
  api: 'API 调用',
  knowledge_vector: '知识库向量化',
}

function fmtTime(t) {
  if (!t) return '-'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return t }
}
function fmtRelative(t) {
  if (!t) return '-'
  const diff = Date.now() - new Date(t).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
function maskKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}
function copyText(text) {
  if (!text) return
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast.success('已复制')).catch(() => {}) }
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast.success('已复制') } catch {} document.body.removeChild(ta) }
}

// ============ Provider 元信息（前端镜像，用于图标显示） ============
const PROVIDER_ICONS = {
  anthropic: '🅰️', openai: '🟢', azure: '🔷', google: '🔵',
  deepseek: '🐳', moonshot: '🌙', zhipu: '🌟', volcengine: '🌋',
  baidu: '🔴', alibaba: '🟠', tencent: '🐧', minimax: '🔵',
  siliconflow: '💎', ollama: '🦙', other: '⚙️',
}

// ============ 迷你折线图（Sparkline，纯 SVG） ============
function Sparkline({ data, color = '#6366f1', height = 40, width = 120 }) {
  if (!data || data.length < 2) return <div className="text-[10px] text-muted-foreground">暂无趋势</div>
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const stepX = width / (data.length - 1)
  const points = data.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={width} cy={height - ((data[data.length - 1] - min) / range) * height} r="2" fill={color} />
    </svg>
  )
}

// ============ 健康状态徽章 ============
function HealthBadge({ status }) {
  const meta = HEALTH_META[status] || HEALTH_META.untested
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}
// 模型类型徽章
function ModelTypeBadge({ type }) {
  const meta = MODEL_TYPE_META[type] || MODEL_TYPE_META.chat
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
}
// Provider 图标 + 名称
function ProviderCell({ provider, providers }) {
  const icon = PROVIDER_ICONS[provider] || '⚙️'
  const tpl = providers?.[provider]
  const label = tpl?.label || provider
  return (
    <div className="flex items-center gap-1.5 truncate" title={tpl ? `${label}\n${tpl.docs || ''}` : label}>
      <span className="text-base">{icon}</span>
      <span className="truncate text-muted-foreground">{label}</span>
    </div>
  )
}

// ============ 调用监控 Tab ============
function MonitorTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState(7)
  const [triggerType, setTriggerType] = useState('')
  // 明细弹窗
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailConfig, setDetailConfig] = useState(null)
  const [calls, setCalls] = useState([])
  const [callsLoading, setCallsLoading] = useState(false)
  const [callFilter, setCallFilter] = useState({ trigger_type: '', status: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await llmApi.monitorStats(days, triggerType)
      setData(res)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [days, triggerType])

  useEffect(() => { load() }, [load])

  const openDetail = async (cfg) => {
    setDetailConfig(cfg)
    setDetailOpen(true)
    setCallsLoading(true)
    try {
      const res = await llmApi.monitorCalls(cfg.model_config_id, 100, 0, callFilter.trigger_type, callFilter.status)
      setCalls(res?.calls || [])
    } catch {
      setCalls([])
    } finally {
      setCallsLoading(false)
    }
  }
  // 切换明细筛选后重新加载
  const reloadCalls = async () => {
    if (!detailConfig) return
    setCallsLoading(true)
    try {
      const res = await llmApi.monitorCalls(detailConfig.model_config_id, 100, 0, callFilter.trigger_type, callFilter.status)
      setCalls(res?.calls || [])
    } catch { setCalls([]) } finally { setCallsLoading(false) }
  }

  const stats = data?.stats || []
  const summary = data?.summary || {}
  const errorTop = data?.error_top || []
  const sourceDist = data?.source_dist || []
  const dailyTrend = data?.daily_trend || []

  const dayOptions = [1, 7, 14, 30]

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围：</span>
          {dayOptions.map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${days === d ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{d} 天</button>
          ))}
          <span className="ml-2 text-xs text-muted-foreground">来源：</span>
          <CompactSelect value={triggerType} onChange={(e) => setTriggerType(e.target.value)} size="lg">
            <option value="">全部</option>
            {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </CompactSelect>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary btn-sm">{loading ? '刷新中…' : '刷新'}</button>
      </div>

      {error && <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      {/* 关键指标摘要卡片 */}
      {!loading && stats.length > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">总调用次数</span>
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">{summary.total_calls ?? 0}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{summary.total_success ?? 0} 成功 / {summary.total_failed ?? 0} 失败</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">平均成功率</span>
              <TrendingUp className={`h-4 w-4 ${(summary.avg_success_rate ?? 0) >= 0.9 ? 'text-success' : 'text-warning'}`} />
            </div>
            <div className={`text-2xl font-bold ${(summary.avg_success_rate ?? 0) >= 0.9 ? 'text-success' : 'text-warning'}`}>{((summary.avg_success_rate ?? 0) * 100).toFixed(1)}<span className="text-sm text-muted-foreground">%</span></div>
            <div className="mt-1 text-[11px] text-muted-foreground">最近 {days} 天</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">平均响应耗时</span>
              <Timer className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">{summary.avg_latency_ms ?? 0}<span className="text-sm text-muted-foreground"> ms</span></div>
            <div className="mt-1 text-[11px] text-muted-foreground">所有模型平均</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">总 Token 消耗</span>
              <Zap className="h-4 w-4 text-warning" />
            </div>
            <div className="text-2xl font-bold text-foreground">{(summary.total_tokens ?? 0).toLocaleString()}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">入 + 出合计</div>
          </div>
        </div>
      )}

      {/* 趋势图 + 来源分布 */}
      {!loading && stats.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* 调用次数 + Token 趋势 */}
          <div className="rounded-lg border border-border bg-card p-4 lg:col-span-2">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-primary" />调用趋势</h3>
            {dailyTrend.length < 2 ? (
              <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">数据不足以绘制趋势</div>
            ) : (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">每日调用次数</div>
                  <Sparkline data={dailyTrend.map((d) => d.total)} color="#6366f1" height={50} width={500} />
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">每日 Token 用量</div>
                  <Sparkline data={dailyTrend.map((d) => d.tokens)} color="#f59e0b" height={50} width={500} />
                </div>
              </div>
            )}
          </div>
          {/* 来源分布 */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><BarChart3 className="h-4 w-4 text-primary" />来源分布</h3>
            {sourceDist.length === 0 ? (
              <div className="text-xs text-muted-foreground">暂无数据</div>
            ) : (
              <div className="flex flex-col gap-2">
                {sourceDist.map((s) => {
                  const total = sourceDist.reduce((a, b) => a + b.count, 0) || 1
                  const pct = Math.round((s.count / total) * 100)
                  return (
                    <div key={s.source} className="flex items-center gap-2">
                      <span className="w-24 truncate text-xs text-muted-foreground">{TRIGGER_LABELS[s.source] || s.source}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-12 text-right text-[11px] font-mono text-foreground">{s.count}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top3 失败原因 */}
      {!loading && errorTop.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />Top3 失败原因</h3>
          <div className="flex flex-col gap-2">
            {errorTop.map((e, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md border border-destructive/20 bg-background px-3 py-2">
                <span className="shrink-0 rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-bold text-destructive">#{i + 1}</span>
                <code className="flex-1 break-all text-[11px] text-destructive/90">{e.error}</code>
                <span className="shrink-0 text-[11px] font-mono text-muted-foreground">{e.count} 次</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 统计表格 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中…</div>
      ) : stats.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
          <BarChart3 className="h-10 w-10" />
          <div className="text-sm">暂无调用记录</div>
          <div className="text-xs">进行智能体对话或测试模型配置后，此处将显示调用统计</div>
        </div>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1200px] table-fixed border-collapse text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">配置名称</th>
                <th className="w-32 px-4 py-3 text-left font-medium">模型</th>
                <th className="w-20 px-4 py-3 text-right font-medium">调用次数</th>
                <th className="w-20 px-4 py-3 text-right font-medium">失败</th>
                <th className="w-24 px-4 py-3 text-right font-medium">成功率</th>
                <th className="w-24 px-4 py-3 text-right font-medium">平均耗时</th>
                <th className="w-24 px-4 py-3 text-right font-medium">最大耗时</th>
                <th className="w-28 px-4 py-3 text-right font-medium">输入Token</th>
                <th className="w-28 px-4 py-3 text-right font-medium">输出Token</th>
                <th className="w-36 px-4 py-3 text-left font-medium">最近调用</th>
                <th className="w-20 px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, idx) => (
                <tr key={s.model_config_id || idx} className={`border-t border-border hover:bg-primary/5 ${idx % 2 === 0 ? 'bg-card' : 'bg-card'}`}>
                  <td className="truncate px-4 py-3 text-foreground">{s.config_name}</td>
                  <td className="truncate px-4 py-3 text-muted-foreground">{s.model_name || '-'}</td>
                  <td className="px-4 py-3 text-right font-mono text-foreground">{s.total_calls}</td>
                  <td className="px-4 py-3 text-right font-mono text-destructive">{s.failed > 0 ? s.failed : '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.success_rate >= 0.9 ? 'bg-success/20 text-success' : s.success_rate >= 0.5 ? 'bg-warning/20 text-warning' : 'bg-destructive/20 text-destructive'}`}>
                      {(s.success_rate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{s.avg_latency_ms}ms</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{s.max_latency_ms}ms</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{s.total_input_tokens}</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{s.total_output_tokens}</td>
                  <td className="px-4 py-3 text-muted-foreground" title={fmtTime(s.last_call_at)}>{fmtRelative(s.last_call_at)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => openDetail(s)} className="btn-secondary btn-sm">明细</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 调用明细弹窗 */}
      <Modal open={detailOpen} title={`调用明细：${detailConfig?.config_name || ''}`} onClose={() => setDetailOpen(false)} maxWidth="max-w-4xl"
        footer={<button onClick={() => setDetailOpen(false)} className="btn-primary">关闭</button>}>
        {/* 明细内筛选 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <CompactSelect value={callFilter.trigger_type} onChange={(e) => setCallFilter((p) => ({ ...p, trigger_type: e.target.value }))} size="lg">
            <option value="">全部来源</option>
            {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </CompactSelect>
          <CompactSelect value={callFilter.status} onChange={(e) => setCallFilter((p) => ({ ...p, status: e.target.value }))} size="lg">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </CompactSelect>
          <button onClick={reloadCalls} className="btn-secondary btn-sm">应用</button>
        </div>
        {callsLoading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">加载中…</div>
        ) : calls.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无调用记录</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="w-32 px-3 py-2 text-left font-medium">时间</th>
                  <th className="w-16 px-3 py-2 text-left font-medium">状态</th>
                  <th className="w-20 px-3 py-2 text-right font-medium">耗时</th>
                  <th className="w-16 px-3 py-2 text-right font-medium">入Token</th>
                  <th className="w-16 px-3 py-2 text-right font-medium">出Token</th>
                  <th className="w-20 px-3 py-2 text-left font-medium">来源</th>
                  <th className="w-24 px-3 py-2 text-left font-medium">来源IP</th>
                  <th className="px-3 py-2 text-left font-medium">错误信息</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, idx) => (
                  <tr key={c.id || idx} className={`border-t border-border ${c.status === 'failed' ? 'bg-destructive/5' : idx % 2 === 0 ? 'bg-card' : ''}`}>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground" title={fmtTime(c.created_at)}>{fmtTime(c.created_at)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${c.status === 'success' ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'}`}>
                        {c.status === 'success' ? '成功' : '失败'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">{c.latency_ms || '-'}ms</td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">{c.input_tokens ?? '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">{c.output_tokens ?? '-'}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">{TRIGGER_LABELS[c.trigger_type] || c.trigger_type || '-'}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{c.source_ip || '-'}</td>
                    <td className="truncate px-3 py-2 text-[11px] text-destructive" title={c.error_message || ''}>
                      {c.error_message ? c.error_message.slice(0, 100) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ============ 测试历史弹窗 ============
function TestHistoryModal({ open, configId, configName, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!configId) return
    setLoading(true)
    try {
      const res = await llmApi.testHistory(configId, 50)
      setHistory(res?.history || [])
    } catch { setHistory([]) } finally { setLoading(false) }
  }, [configId])

  useEffect(() => { if (open) load() }, [open, load])

  return (
    <Modal open={open} title={`测试历史：${configName || ''}`} onClose={onClose} maxWidth="max-w-2xl"
      footer={<button onClick={onClose} className="btn-primary">关闭</button>}>
      {loading ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">加载中…</div>
      ) : history.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无测试记录</div>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="w-40 px-3 py-2 text-left font-medium">时间</th>
                <th className="w-20 px-3 py-2 text-left font-medium">状态</th>
                <th className="w-24 px-3 py-2 text-right font-medium">延迟</th>
                <th className="px-3 py-2 text-left font-medium">错误信息</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, idx) => (
                <tr key={h.id || idx} className={`border-t border-border ${h.status === 'failed' ? 'bg-destructive/5' : idx % 2 === 0 ? 'bg-card' : ''}`}>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground" title={fmtTime(h.created_at)}>{fmtRelative(h.created_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${h.status === 'success' ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'}`}>
                      {h.status === 'success' ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">{h.latency_ms ?? '-'}ms</td>
                  <td className="truncate px-3 py-2 text-[11px] text-destructive" title={h.error_message || ''}>{h.error_message ? h.error_message.slice(0, 80) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ============ 主组件 ============
function LLMConfig() {
  const [activeTab, setActiveTab] = useState('configs') // configs | monitor
  const [rows, setRows] = useState([])
  const [providers, setProviders] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tutorialOpen, setTutorialOpen] = useState(false)

  // 编辑相关
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '', provider: 'anthropic', api_key: '', base_url: '', model_name: '', model_type: 'chat', is_default: false,
    temperature: '', max_tokens: '', top_p: '', reasoning_effort: '', timeout: '', max_retries: '', org_id: '', project_id: '', enabled: true,
  })
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 编辑弹窗内测试连接
  const [testingInDialog, setTestingInDialog] = useState(false)
  const [dialogTestResult, setDialogTestResult] = useState(null)

  // 筛选 / 分页 / 批量选择
  const [{ search, filterProvider, filterType, filterStatus, filterDefault }, setFilters] = usePersistedFilters('llm_config', {
    search: '', filterProvider: '', filterType: '', filterStatus: '', filterDefault: '',
  })
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const [deleting, setDeleting] = useState(false)

  const filteredRows = useMemo(() => {
    let r = rows
    if (search) {
      const q = search.toLowerCase()
      r = r.filter((x) => [x.name, x.provider, x.model_name].some((v) => (v || '').toLowerCase().includes(q)))
    }
    if (filterProvider) r = r.filter((x) => x.provider === filterProvider)
    if (filterType) r = r.filter((x) => (x.model_type || 'chat') === filterType)
    if (filterStatus) r = r.filter((x) => (x.health_status || 'untested') === filterStatus)
    if (filterDefault === 'yes') r = r.filter((x) => x.is_default)
    if (filterDefault === 'no') r = r.filter((x) => !x.is_default)
    return r
  }, [rows, search, filterProvider, filterType, filterStatus, filterDefault])
  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  const load = useCallback(async () => {
    try {
      const [data, pvData] = await Promise.all([llmApi.list(), llmApi.providers()])
      setRows(Array.isArray(data) ? data : [])
      setProviders(pvData?.providers || {})
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm({
      name: '', provider: 'anthropic', api_key: '', base_url: '', model_name: '', model_type: 'chat', is_default: false,
      temperature: '', max_tokens: '', top_p: '', reasoning_effort: '', timeout: '', max_retries: '', org_id: '', project_id: '', enabled: true,
    })
    setDialogTestResult(null)
    setAdvancedOpen(false)
    setShowApiKey(false)
    setEditOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      name: row.name || '', provider: row.provider || 'anthropic', api_key: '',
      base_url: row.base_url || '', model_name: row.model_name || '', model_type: row.model_type || 'chat', is_default: !!row.is_default,
      temperature: row.temperature ?? '', max_tokens: row.max_tokens ?? '', top_p: row.top_p ?? '',
      reasoning_effort: row.reasoning_effort || '',
      timeout: row.timeout ?? '', max_retries: row.max_retries ?? '', org_id: row.org_id || '', project_id: row.project_id || '',
      enabled: row.enabled !== false,
    })
    setDialogTestResult(null)
    setAdvancedOpen(false)
    setShowApiKey(false)
    setEditOpen(true)
  }

  const setField = (field) => (value) => setForm((prev) => ({ ...prev, [field]: value }))

  // 选择 Provider 后自动填充 Base URL
  const handleProviderChange = (provider) => {
    const tpl = providers[provider]
    setForm((prev) => ({
      ...prev,
      provider,
      base_url: tpl?.base_url || prev.base_url,
      model_name: '',
    }))
  }

  const handleSave = async () => {
    if (!form.name.trim()) { toast.warning('请填写配置名称'); return }
    // 校验 API Key 格式（sk- 前缀仅提示，不强制）
    if (form.api_key && !form.api_key.startsWith('sk-') && form.provider !== 'ollama' && form.provider !== 'azure') {
      // 非强制提示
    }
    setSaving(true)
    try {
      const body = {
        name: form.name, provider: form.provider, api_key: form.api_key,
        base_url: form.base_url, model_name: form.model_name, model_type: form.model_type, is_default: form.is_default,
        temperature: form.temperature === '' ? null : Number(form.temperature),
        max_tokens: form.max_tokens === '' ? null : Number(form.max_tokens),
        top_p: form.top_p === '' ? null : Number(form.top_p),
        reasoning_effort: form.reasoning_effort || null,
        timeout: form.timeout === '' ? null : Number(form.timeout),
        max_retries: form.max_retries === '' ? null : Number(form.max_retries),
        org_id: form.org_id || null, project_id: form.project_id || null,
        enabled: form.enabled,
      }
      let savedId
      if (editing && !body.api_key) delete body.api_key
      if (editing) { savedId = editing.id; await llmApi.update(editing.id, body) }
      else { const r = await llmApi.create(body); savedId = r?.id }
      setEditOpen(false)
      await load()
      // 自动测试：保存后立即测试连通性（仅对启用且有 Key 的配置）
      if (savedId && form.enabled) {
        toast.info('正在自动测试连通性…')
        try {
          const res = await llmApi.test(savedId)
          if (res?.success) toast.success(`自动测试通过 · 延迟 ${res.latency_ms ?? '-'}ms`)
          else toast.warning(`自动测试失败：${res?.error || '未知错误'}`)
          await load()
        } catch (err) {
          toast.warning(`自动测试失败：${err.message || err}`)
        }
      }
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row) => {
    const _ok = await confirm({ message: `确定删除模型配置「${row.name || row.id}」吗？`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try { await llmApi.remove(row.id); setSelectedKeys((prev) => prev.filter((k) => k !== row.id)); await load() } catch (err) { toast.error(`删除失败：${err.message || err}`) }
  }

  const handleCopy = async (row) => {
    try {
      await llmApi.copy(row.id)
      toast.success('已复制配置')
      await load()
    } catch (err) { toast.error(`复制失败：${err.message || err}`) }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个模型配置吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await llmApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个配置`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [testResultOpen, setTestResultOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyConfig, setHistoryConfig] = useState(null)
  const [healthChecking, setHealthChecking] = useState(false)
  const [revealedKey, setRevealedKey] = useState({})  // { [id]: { key, loading } }

  // 健康检查间隔配置（秒）：从系统配置读取，支持热更新
  const [healthInterval, setHealthInterval] = useState(300)  // 已保存的值
  const [healthIntervalInput, setHealthIntervalInput] = useState('300')  // 输入框值
  const [savingInterval, setSavingInterval] = useState(false)
  const [intervalLoaded, setIntervalLoaded] = useState(false)

  const handleTest = async (row) => {
    setTesting(row.id)
    try {
      const res = await llmApi.test(row.id)
      setTestResult({ ...res, configName: row.name })
      setTestResultOpen(true)
      // 测试后刷新列表以更新健康状态
      await load()
    } catch (err) {
      setTestResult({ success: false, error: err.message || String(err), configName: row.name })
      setTestResultOpen(true)
      await load()
    } finally {
      setTesting(null)
    }
  }

  // 手动触发全量健康检查
  const handleHealthCheck = async () => {
    setHealthChecking(true)
    try {
      const res = await llmApi.healthCheck()
      toast.success(`健康检查完成：${res.healthy ?? 0} 正常 / ${res.unhealthy ?? 0} 异常 / 共 ${res.checked ?? 0} 个`)
      await load()
    } catch (err) {
      toast.error(`健康检查失败：${err.message || err}`)
    } finally {
      setHealthChecking(false)
    }
  }

  // 加载健康检查间隔配置
  const loadHealthInterval = useCallback(async () => {
    try {
      const list = await systemConfigApi.list()
      const item = (list || []).find((c) => c.key === 'model.health_check_interval')
      if (item && item.value) {
        const v = Number(item.value)
        if (Number.isFinite(v)) {
          setHealthInterval(v)
          setHealthIntervalInput(String(v))
        }
      }
    } catch (err) {
      // 静默失败：无权限或接口异常不打扰用户主流程
    } finally {
      setIntervalLoaded(true)
    }
  }, [])

  useEffect(() => {
    loadHealthInterval()
  }, [loadHealthInterval])

  // 保存健康检查间隔
  const handleSaveInterval = async () => {
    const v = Number(healthIntervalInput)
    if (!Number.isFinite(v) || v < 60 || v > 3600) {
      toast.warning('间隔范围 60 - 3600 秒')
      return
    }
    if (v === healthInterval) return  // 未变化
    setSavingInterval(true)
    try {
      await systemConfigApi.update({ 'model.health_check_interval': String(v) })
      setHealthInterval(v)
      toast.success(`健康检查间隔已更新为 ${v} 秒，下次循环生效`)
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSavingInterval(false)
    }
  }

  // 查看完整 API Key（审计记录）
  const handleRevealKey = async (row) => {
    setRevealedKey((p) => ({ ...p, [row.id]: { loading: true } }))
    try {
      const res = await llmApi.revealApiKey(row.id)
      setRevealedKey((p) => ({ ...p, [row.id]: { key: res.api_key || '', loading: false } }))
      toast.info('已显示完整 API Key（本次查看已记录审计日志）')
    } catch (err) {
      setRevealedKey((p) => ({ ...p, [row.id]: { loading: false } }))
      toast.error(`查看失败：${err.message || err}`)
    }
  }

  // 编辑弹窗内测试连接（先保存再测试；若已存在则直接测试）
  const handleTestInDialog = async () => {
    if (!editing) {
      toast.info('请先保存配置后再测试')
      return
    }
    setTestingInDialog(true)
    setDialogTestResult(null)
    try {
      const res = await llmApi.test(editing.id)
      setDialogTestResult(res)
      // 测试后刷新列表
      await load()
    } catch (err) {
      setDialogTestResult({ success: false, error: err.message || String(err) })
    } finally {
      setTestingInDialog(false)
    }
  }

  // 表格列定义
  const columns = [
    { key: 'id', header: 'ID', width: '60px', render: (r) => <span className="font-mono text-primary">#{r.id}</span> },
    { key: 'name', header: '名称', render: (r) => (
      <div className="flex flex-col gap-0.5">
        <span className="truncate text-foreground">{r.name || '-'}</span>
        {!r.enabled && <span className="text-[10px] text-muted-foreground">已禁用</span>}
      </div>
    ) },
    { key: 'provider', header: 'Provider', width: '160px', render: (r) => <ProviderCell provider={r.provider} providers={providers} /> },
    {
      key: 'model_type', header: '类型', width: '90px',
      render: (r) => <ModelTypeBadge type={r.model_type || 'chat'} />,
    },
    { key: 'model_name', header: '模型', render: (r) => <span className="truncate text-muted-foreground">{r.model_name || '-'}</span> },
    {
      key: 'api_key', header: 'API Key', width: '200px',
      render: (r) => {
        const rv = revealedKey[r.id]
        const showFull = rv?.key !== undefined && !rv?.loading
        const keyDisplay = showFull ? rv.key : maskKey(r.api_key)
        const last4 = r.api_key && r.api_key.length >= 4 ? r.api_key.slice(-4) : ''
        return (
          <div className="flex items-center gap-1">
            <span className="truncate font-mono text-xs text-muted-foreground" title={showFull ? '完整 Key 已显示' : `后4位: ${last4}`}>
              {keyDisplay}
            </span>
            <button type="button" onClick={(e) => { e.stopPropagation(); handleRevealKey(r) }} disabled={rv?.loading}
              className="text-muted-foreground hover:text-primary disabled:opacity-40" title={showFull ? '已显示明文' : '查看完整 Key（审计记录）'}>
              {rv?.loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); copyText(showFull ? rv.key : r.api_key) }}
              className="text-muted-foreground hover:text-primary" title="复制">
              <Copy className="h-3 w-3" />
            </button>
            {showFull && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setRevealedKey((p) => { const n = { ...p }; delete n[r.id]; return n }) }}
                className="text-muted-foreground hover:text-foreground" title="隐藏">
                <EyeOff className="h-3 w-3" />
              </button>
            )}
          </div>
        )
      },
    },
    {
      key: 'health_status', header: '状态', width: '110px',
      render: (r) => (
        <div className="flex flex-col gap-0.5" title={r.last_test_error || ''}>
          <HealthBadge status={r.health_status} />
          {r.last_test_at && <span className="text-[10px] text-muted-foreground" title={fmtTime(r.last_test_at)}>{fmtRelative(r.last_test_at)}</span>}
        </div>
      ),
    },
    {
      key: 'is_default', header: '默认', width: '70px',
      render: (r) => r.is_default
        ? <span className="rounded bg-success/20 px-2 py-0.5 text-[11px] font-medium text-success">默认</span>
        : <span className="text-xs text-muted-foreground">-</span>,
    },
    {
      key: '__actions', header: '操作', width: '300px',
      render: (r) => (
        <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => handleTest(r)} disabled={testing === r.id} className="btn-secondary btn-sm" title="测试连通性">
            {testing === r.id ? '测试中…' : '测试'}
          </button>
          <button type="button" onClick={() => { setHistoryConfig(r); setHistoryOpen(true) }} className="btn-secondary btn-sm" title="测试历史"><History className="h-3 w-3" /></button>
          <button type="button" onClick={() => handleCopy(r)} className="btn-secondary btn-sm" title="复制配置"><Files className="h-3 w-3" /></button>
          <button type="button" onClick={() => openEdit(r)} className="btn-secondary btn-sm">编辑</button>
          <button type="button" onClick={() => handleDelete(r)} className="btn-danger btn-sm">删除</button>
        </div>
      ),
    },
  ]

  const tabs = [
    { key: 'configs', label: '模型配置' },
    { key: 'monitor', label: '调用监控' },
  ]

  const selectCls = 'rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary'

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">模型设置</h1>
          {activeTab === 'configs' && <span className="text-xs text-muted-foreground">共 {filteredRows.length} 个</span>}
        </div>
        {activeTab === 'configs' && (
          <div className="flex shrink-0 items-center gap-2">
            <TutorialButton onClick={() => setTutorialOpen(true)} />
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1" title="自动健康检查的循环间隔（60-3600 秒，保存后下次循环生效）">
              <span className="text-xs text-muted-foreground">检查间隔</span>
              <input
                type="number"
                min={60}
                max={3600}
                value={healthIntervalInput}
                onChange={(e) => setHealthIntervalInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveInterval() }}
                disabled={!intervalLoaded || savingInterval}
                className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
              />
              <span className="text-xs text-muted-foreground">秒</span>
              <button
                type="button"
                onClick={handleSaveInterval}
                disabled={!intervalLoaded || savingInterval || Number(healthIntervalInput) === healthInterval}
                className="btn-primary btn-sm px-2 py-0.5"
              >
                {savingInterval ? '保存中…' : '保存'}
              </button>
            </div>
            <button type="button" onClick={handleHealthCheck} disabled={healthChecking} className="btn-secondary btn-sm" title="对所有启用的配置执行一次连通性探测">
              {healthChecking ? '检查中…' : '健康检查'}
            </button>
            <button type="button" onClick={load} className="btn-secondary btn-sm">刷新</button>
            <button type="button" onClick={openCreate} className="btn-primary btn-sm"><Plus className="mr-1 h-3.5 w-3.5" />新建配置</button>
          </div>
        )}
      </header>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-6">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-3 text-sm transition ${activeTab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'monitor' ? (
          <MonitorTab />
        ) : (
          <>
            {error && <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
            <FilterBar
              search={{ value: search, onChange: (v) => { setFilters({ search: v }); setPage(1) }, placeholder: '搜索名称 / Provider / 模型...' }}
              filters={[
                { key: 'provider', label: 'Provider', value: filterProvider, onChange: (v) => { setFilters({ filterProvider: v }); setPage(1) },
                  options: [{ value: '', label: '全部' }, ...Object.entries(providers).map(([k, v]) => ({ value: k, label: v.label || k }))] },
                { key: 'type', label: '类型', value: filterType, onChange: (v) => { setFilters({ filterType: v }); setPage(1) },
                  options: [{ value: '', label: '全部' }, ...Object.entries(MODEL_TYPE_META).map(([k, v]) => ({ value: k, label: v.label }))] },
                { key: 'status', label: '状态', value: filterStatus, onChange: (v) => { setFilters({ filterStatus: v }); setPage(1) },
                  options: [{ value: '', label: '全部' }, ...Object.entries(HEALTH_META).map(([k, v]) => ({ value: k, label: v.label }))] },
                { key: 'default', label: '默认', value: filterDefault, onChange: (v) => { setFilters({ filterDefault: v }); setPage(1) },
                  options: [{ value: '', label: '全部' }, { value: 'yes', label: '默认' }, { value: 'no', label: '非默认' }] },
              ]}
            />
            <div className="overflow-hidden rounded-lg border border-border">
              <DataTable
                columns={columns}
                data={paged}
                loading={loading}
                selectable
                selectedKeys={selectedKeys}
                onSelectChange={setSelectedKeys}
                rowKey="id"
                onRowClick={(r) => openEdit(r)}
                rowClickHint="点击编辑"
                emptyText="暂无模型配置"
              />
            </div>
            <Pagination page={page} pageSize={pageSize} total={filteredRows.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
            <BatchActions selectedCount={selectedKeys.length} onClear={clear}
              actions={[{ key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting }]}
            />
          </>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Modal open={editOpen} title={editing ? `编辑模型配置：${editing.name || ''}` : '新建模型配置'} onClose={() => setEditOpen(false)} maxWidth="max-w-2xl"
        footer={<>
          {editing && (
            <button type="button" onClick={handleTestInDialog} disabled={testingInDialog} className="mr-auto btn-secondary btn-sm">
              {testingInDialog ? '测试中…' : '测试连接'}
            </button>
          )}
          <button type="button" onClick={() => setEditOpen(false)} className="btn-secondary">取消</button>
          <button type="button" onClick={handleSave} disabled={saving} className="btn-primary">{saving ? '保存中…' : '保存'}</button>
        </>}>
        {/* 基础配置 */}
        <Section title="基础配置">
          <TextInput label="名称" value={form.name} onChange={setField('name')} placeholder="如：Claude 默认配置" />
          <SelectInput label="Provider" value={form.provider} onChange={handleProviderChange} options={Object.entries(providers).map(([k, v]) => ({ value: k, label: `${v.icon || ''} ${v.label || k}` }))} />
          <SelectInput label="模型类型" value={form.model_type} onChange={setField('model_type')} options={[
            { value: 'chat', label: '对话模型 (chat)' },
            { value: 'embedding', label: '向量化模型 (embedding)' },
            { value: 'vision', label: '视觉模型 (vision)' },
            { value: 'rerank', label: '重排序模型 (rerank)' },
          ]} hint={form.model_type === 'embedding' ? '向量化模型用于知识库 Embedding，测试时走 /embeddings 端点。' : '对话模型用于智能体对话与节点执行。'} />
          {/* Model Name 支持下拉 + 自定义 */}
          <ModelNameInput form={form} providers={providers} setField={setField} />
        </Section>
        {/* 鉴权配置 */}
        <Section title="凭证" hint={editing ? 'API Key 留空表示不修改现有值。点击眼睛图标可从后端拉取当前 Key 明文（审计记录）。' : ''}>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput label="API Key" value={form.api_key} onChange={setField('api_key')} placeholder={editing ? '（留空不修改）' : 'sk-...'} type={showApiKey ? 'text' : 'password'} />
            </div>
            <button type="button" onClick={async () => {
              if (editing && !form.api_key) {
                // 编辑模式下 Key 为空时，从后端拉取明文
                try {
                  const res = await llmApi.revealApiKey(editing.id)
                  setField('api_key')(res.api_key || '')
                  setShowApiKey(true)
                  toast.info('已从后端拉取当前 API Key 明文（审计记录）')
                } catch (err) {
                  toast.error(`拉取失败：${err.message || err}`)
                }
              } else {
                setShowApiKey((p) => !p)
              }
            }} className="mb-1 rounded-md border border-border bg-secondary px-2 py-2 text-muted-foreground hover:text-foreground" title={showApiKey ? '隐藏' : (editing && !form.api_key ? '拉取并显示当前 Key' : '显示')}>
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => copyText(form.api_key)} disabled={!form.api_key} className="mb-1 rounded-md border border-border bg-secondary px-2 py-2 text-muted-foreground hover:text-primary disabled:opacity-40" title="复制">
              <Copy className="h-4 w-4" />
            </button>
          </div>
          {form.api_key && !form.api_key.startsWith('sk-') && form.provider !== 'ollama' && form.provider !== 'azure' && (
            <div className="mt-1 text-[11px] text-warning">⚠ API Key 通常以 sk- 开头，请确认格式正确</div>
          )}
          <TextInput label="Base URL" value={form.base_url} onChange={setField('base_url')} placeholder="https://api.anthropic.com" />
          {providers[form.provider]?.docs && (
            <a href={providers[form.provider].docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              <ExternalLink className="h-3 w-3" /> Provider 文档
            </a>
          )}
        </Section>
        {/* 高级参数（折叠） */}
        <div className="mb-2">
          <button type="button" onClick={() => setAdvancedOpen((p) => !p)} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            高级参数
          </button>
        </div>
        {advancedOpen && (
          <Section title="调用参数">
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="Temperature" value={String(form.temperature)} onChange={(v) => setField('temperature')(v)} placeholder="0.7" />
              <TextInput label="Max Tokens" value={String(form.max_tokens)} onChange={(v) => setField('max_tokens')(v)} placeholder="1024" />
              <TextInput label="Top P" value={String(form.top_p)} onChange={(v) => setField('top_p')(v)} placeholder="0.9" />
              <TextInput label="超时（秒）" value={String(form.timeout)} onChange={(v) => setField('timeout')(v)} placeholder="30" />
              <TextInput label="最大重试" value={String(form.max_retries)} onChange={(v) => setField('max_retries')(v)} placeholder="2" />
              {providers[form.provider]?.need_org && <TextInput label="组织 ID" value={form.org_id} onChange={setField('org_id')} placeholder="org-..." />}
              {providers[form.provider]?.need_project && <TextInput label="项目 ID" value={form.project_id} onChange={setField('project_id')} placeholder="project-..." />}
              {form.provider !== 'anthropic' && (
                <SelectInput
                  label="思考深度"
                  value={form.reasoning_effort}
                  onChange={setField('reasoning_effort')}
                  hint="推理模型的思考深度（reasoning effort）。GLM/o 系列/DeepSeek-R1 等推理模型可调低以显著缩短思考耗时；普通模型保持「模型默认」即可。"
                  options={[
                    { value: '', label: '模型默认（不传）' },
                    { value: 'minimal', label: 'minimal（几乎不思考）' },
                    { value: 'low', label: 'low（浅思考，推荐）' },
                    { value: 'medium', label: 'medium（中等）' },
                    { value: 'high', label: 'high（深度思考）' },
                  ]}
                />
              )}
            </div>
          </Section>
        )}
        {/* 其它 */}
        <Section title="其它">
          <CheckRow label="设为默认配置" checked={form.is_default} onChange={setField('is_default')} hint="按模型类型设置默认：新建智能体时默认选中该类型默认模型。" />
          <CheckRow label="启用" checked={form.enabled} onChange={setField('enabled')} hint="禁用后不可被智能体调用。" />
        </Section>
        {/* 弹窗内测试结果 */}
        {dialogTestResult && (
          <div className={`mt-3 rounded-md border px-4 py-3 ${dialogTestResult.success ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10'}`}>
            <div className="flex items-center gap-2">
              {dialogTestResult.success ? <Check className="h-4 w-4 text-success" /> : <X className="h-4 w-4 text-destructive" />}
              <span className={`text-sm ${dialogTestResult.success ? 'text-success' : 'text-destructive'}`}>
                {dialogTestResult.success ? `连接成功 · 延迟 ${dialogTestResult.latency_ms ?? '-'}ms` : '连接失败'}
              </span>
            </div>
            {dialogTestResult.success && dialogTestResult.response && (
              <pre className="mt-2 rounded bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">{dialogTestResult.response}</pre>
            )}
            {!dialogTestResult.success && dialogTestResult.error && (
              <pre className="mt-2 rounded bg-background p-2 font-mono text-[11px] text-destructive ring-1 ring-border">{dialogTestResult.error}</pre>
            )}
          </div>
        )}
      </Modal>

      {/* 测试结果弹窗 */}
      <Modal open={testResultOpen} title={`LLM 连通性测试：${testResult?.configName || ''}`} onClose={() => setTestResultOpen(false)} maxWidth="max-w-lg"
        footer={<button type="button" onClick={() => setTestResultOpen(false)} className="btn-primary">关闭</button>}>
        {testResult?.success ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-4 py-3">
              <Check className="h-4 w-4 text-success" /><span className="text-sm text-success">连接成功 · 延迟 {testResult.latency_ms ?? '-'}ms</span>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">模型回复</div>
              <pre className="w-full overflow-auto rounded-md bg-background p-4 font-mono text-xs text-foreground ring-1 ring-border">{testResult.response || '(空)'}</pre>
            </div>
            {testResult.model && <div className="text-xs text-muted-foreground">模型: {testResult.model}</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
              <X className="h-4 w-4 text-destructive" /><span className="text-sm text-destructive">连接失败</span>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">错误信息</div>
              <pre className="w-full overflow-auto rounded-md bg-background p-4 font-mono text-xs text-destructive ring-1 ring-border">{testResult?.error || '未知错误'}</pre>
            </div>
            <div className="text-[11px] text-muted-foreground">常见原因：API Key 无效、Base URL 错误、模型名不存在、网络不通</div>
          </div>
        )}
      </Modal>

      {/* 测试历史 */}
      <TestHistoryModal open={historyOpen} configId={historyConfig?.id} configName={historyConfig?.name} onClose={() => setHistoryOpen(false)} />

      {/* 使用教程 */}
      <TutorialDrawer open={tutorialOpen} onClose={() => setTutorialOpen(false)} title="模型设置使用教程" subtitle="了解如何配置模型、测试连通性和查看调用监控" sections={LLM_TUTORIAL} />
    </div>
  )
}

// ============ Model Name 下拉 + 自定义输入组件 ============
function ModelNameInput({ form, providers, setField }) {
  const tpl = providers[form.provider]
  const modelOptions = tpl?.models?.[form.model_type] || []
  const [useCustom, setUseCustom] = useState(!modelOptions.includes(form.model_name))

  // 切换 Provider/类型时重置自定义状态
  useEffect(() => {
    const opts = tpl?.models?.[form.model_type] || []
    setUseCustom(!opts.includes(form.model_name))
  }, [form.provider, form.model_type, form.model_name, tpl])

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Model Name</label>
        {modelOptions.length > 0 && (
          <button type="button" onClick={() => setUseCustom((p) => !p)} className="text-[11px] text-primary hover:underline">
            {useCustom ? '选择常用' : '自定义输入'}
          </button>
        )}
      </div>
      {!useCustom && modelOptions.length > 0 ? (
        <CompactSelect value={form.model_name} onChange={(e) => setField('model_name')(e.target.value)} size="lg" block>
          <option value="">请选择模型</option>
          {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
        </CompactSelect>
      ) : (
        <input type="text" value={form.model_name} onChange={(e) => setField('model_name')(e.target.value)}
          placeholder={form.model_type === 'embedding' ? '如：doubao-embedding-text-240715' : '如：claude-3-5-sonnet-20240620'}
          className="w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
      )}
    </div>
  )
}

export default LLMConfig
