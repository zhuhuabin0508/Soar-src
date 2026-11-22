// 工单列表展开行：完整工单详情摘要 + 价值评分入口
//
// 列表行点击「展开」后按需拉取工单详情，展示基础信息、各节点提交的工单字段、
// 处理时间线与价值评分面板（已完成工单可直接评分/查看已提交结果）。
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowUpRight, Clock3, FileText, Loader2, RefreshCw, ShieldCheck, UserRound,
} from 'lucide-react'
import { Button } from './ui'
import ticketApi from '../api/tickets'
import TicketScorePanel from './TicketScorePanel'
import { fieldDefMap, fieldValueText } from '../utils/ticketFlow'

const STATUS_LABEL = {
  processing: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
}

const PRIORITY_LABEL = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '紧急',
}

const ACTION_LABEL = {
  create: '发起工单',
  submit: '提交流转',
  cancel: '取消工单',
  end: '结束',
  rollback: '退回',
  urge: '催办',
  transfer: '转办',
  claim: '认领',
  comment: '内部评论',
  pause: '暂停',
  resume: '恢复',
}

const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '--')

const displayValue = (value) => {
  if (Array.isArray(value)) return value.join('、') || '--'
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return fieldValueText(null, value)
}

function MetaItem({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium text-foreground" title={typeof children === 'string' ? children : undefined}>
        {children || '--'}
      </div>
    </div>
  )
}

function FieldValues({ nodeName, node, values }) {
  const defs = fieldDefMap(node?.fields)
  const rows = Object.entries(values || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!rows.length) return null
  return (
    <div className="rounded-md border border-border/70 bg-background/60">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground">
        <FileText className="h-3 w-3 text-muted-foreground" />
        {nodeName || '工单字段'}
        <span className="rounded bg-muted px-1.5 text-[11px] font-normal text-muted-foreground">{rows.length} 项</span>
      </div>
      <div className="grid gap-x-4 gap-y-1.5 px-2.5 py-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([key, value]) => (
          <div key={key} className="min-w-0">
            <div className="truncate text-[11px] text-muted-foreground" title={defs[key]?.label || key}>
              {defs[key]?.label || key}
            </div>
            <div className="break-words text-xs text-foreground">{displayValue(value)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TicketExpandedPanel({ ticketId, onScored }) {
  const navigate = useNavigate()
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(() => {
    let alive = true
    setLoading(true)
    setError('')
    ticketApi.getTicket(ticketId)
      .then((res) => { if (alive) setTicket(res) })
      .catch((e) => { if (alive) setError(e.message || '加载工单详情失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [ticketId, reloadKey])

  useEffect(() => load(), [load])

  if (loading && !ticket) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />加载工单详情...
      </div>
    )
  }
  if (error && !ticket) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <span>{error}</span>
        <Button variant="secondary" size="sm" onClick={() => setReloadKey((n) => n + 1)}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />重试
        </Button>
      </div>
    )
  }
  if (!ticket) return null

  const snapshot = ticket.flow_snapshot || {}
  const nodes = snapshot.nodes || []
  const records = ticket.records || []
  const startNode = nodes.find((n) => n.type !== 'end')
  const createRecord = records.find((r) => r.action === 'create') || records[0]
  const fieldSections = records
    .filter((r) => ['create', 'submit'].includes(r.action) && r.field_values && Object.keys(r.field_values).length)
    .map((r) => ({
      key: `${r.id}`,
      nodeKey: r.node_key,
      nodeName: r.node_name || nodes.find((n) => n.key === r.node_key)?.name,
      node: nodes.find((n) => n.key === r.node_key),
      values: r.field_values,
    }))

  return (
    <div className="space-y-3">
      {/* 基础信息 */}
      <div className="grid gap-3 rounded-md border border-border bg-card px-3 py-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <MetaItem label="工单号">
          <span className="font-mono text-primary">{ticket.ticket_no}</span>
        </MetaItem>
        <MetaItem label="状态">{STATUS_LABEL[ticket.status] || ticket.status}</MetaItem>
        <MetaItem label="优先级">{PRIORITY_LABEL[ticket.priority] || ticket.priority}</MetaItem>
        <MetaItem label="流程">{ticket.flow_name}</MetaItem>
        <MetaItem label="发起人">
          <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" />{ticket.created_by_name}</span>
        </MetaItem>
        <MetaItem label="当前节点">
          {ticket.status === 'processing' || ticket.status === 'paused'
            ? `${ticket.current_node_name || '--'}${ticket.current_group_name ? `（${ticket.current_group_name}）` : ''}`
            : '--'}
        </MetaItem>
        <MetaItem label="发起时间">
          <span className="inline-flex items-center gap-1 tabular-nums"><Clock3 className="h-3 w-3" />{fmtTime(ticket.created_at)}</span>
        </MetaItem>
        <MetaItem label="完结时间">{fmtTime(ticket.closed_at)}</MetaItem>
        <MetaItem label="关联告警">{ticket.related_alert_id ? `#${ticket.related_alert_id}` : '--'}</MetaItem>
        <MetaItem label="评分状态">
          {ticket.score?.already_scored ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              已完成评分 · {ticket.score.score?.final_score} 分（{ticket.score.score?.grade_label || ticket.score.score?.grade}）
            </span>
          ) : ticket.status === 'completed' ? (
            <span className="text-amber-600 dark:text-amber-400">待评分</span>
          ) : '--'}
        </MetaItem>
      </div>

      {/* 工单字段：发起节点默认展开，后续节点折叠 */}
      {fieldSections.length > 0 && (
        <div className="space-y-2">
          {fieldSections.map((section, index) => (
            index === 0 ? (
              <FieldValues key={section.key} nodeName={section.nodeName} node={section.node} values={section.values} />
            ) : (
              <details key={section.key} className="rounded-md border border-border/70 bg-background/60">
                <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-foreground">
                  {section.nodeName || section.nodeKey} · 提交字段（{Object.keys(section.values).length} 项）
                </summary>
                <div className="border-t border-border/60 p-0">
                  <FieldValues nodeName={section.nodeName} node={section.node} values={section.values} />
                </div>
              </details>
            )
          ))}
          {!createRecord && startNode && (
            <div className="text-xs text-muted-foreground">暂无可展示的工单字段</div>
          )}
        </div>
      )}

      {/* 处理时间线（最近 10 条，完整记录进详情页） */}
      <div className="rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-foreground">处理记录</span>
          <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{records.length} 条</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
            onClick={() => navigate(`/tickets/${ticket.id}`)}
          >
            查看完整工单详情<ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
        <div className="max-h-56 space-y-2 overflow-y-auto px-3 py-2">
          {records.length === 0 && <div className="py-3 text-center text-xs text-muted-foreground">暂无处理记录</div>}
          {records.slice(-10).map((r) => (
            <div key={r.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {ACTION_LABEL[r.action] || r.action}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                  <span className="font-medium text-foreground">{r.node_name || r.node_key || '--'}</span>
                  <span>{r.handler_name || '--'}</span>
                  <span className="tabular-nums">{fmtTime(r.created_at)}</span>
                </div>
                {r.comment && <div className="mt-0.5 break-words text-foreground">{r.comment}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 价值评分 */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">工单价值评分</span>
          {!ticket.score?.already_scored && ticket.status === 'completed' && ticket.score?.can_score && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">待评分</span>
          )}
        </div>
        <TicketScorePanel
          ticketId={ticket.id}
          initialState={ticket.score}
          compact
          onScored={(res) => {
            if (res?.score) {
              setTicket((t) => (t ? { ...t, score: res } : t))
            }
            onScored?.(res)
          }}
        />
      </div>
    </div>
  )
}
