// 工单流程模板版本历史抽屉：发布存档列表 + 与当前编辑内容的节点级 diff + 回滚。
// - 每次发布自动存档（后端 ticket_flow_versions）；列表为摘要，展开时懒加载详情（含 nodes）
// - diff 纯前端计算（utils/ticketFlow.diffFlow）：方向为「该版本 → 当前编辑内容」，
//   当前内容变化（含未保存修改/回滚后重载）会自动重算
// - 回滚：存档覆盖当前模板并回到草稿态，父组件重载编辑数据；未保存修改会被覆盖（二次确认）
import { useState, useEffect, useMemo, useCallback } from 'react'
import { History, RotateCcw, ChevronDown, CheckCircle2, Plus, Minus, Pencil } from 'lucide-react'
import { Drawer } from './Dialog'
import { confirm } from './ConfirmDialog'
import { toast } from '../store/toastStore'
import { diffFlow } from '../utils/ticketFlow'
import ticketApi from '../api/tickets'

const fmtTime = (t) => {
  if (!t) return '--'
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }) } catch { return String(t) }
}

export default function TicketFlowVersionsDrawer({
  open,
  onClose,
  flowId,
  // 当前编辑器内容（payload 形态：{name, description, nodes: {start_groups, cc_targets, nodes}}）
  current,
  currentVersion,
  isDraft,
  dirty,
  canEdit,
  onRolledBack,
}) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(null) // 展开对比的版本号
  const [details, setDetails] = useState({}) // version → 存档详情（含 nodes），懒加载缓存
  const [rolling, setRolling] = useState(null)

  const load = useCallback(() => {
    if (!flowId) return
    setLoading(true)
    ticketApi.listFlowVersions(flowId)
      .then((res) => setVersions(res.items || []))
      .catch((e) => toast.error(e.message || '加载版本历史失败'))
      .finally(() => setLoading(false))
  }, [flowId])

  useEffect(() => { if (open) load() }, [open, load])

  const toggleExpand = (v) => {
    if (expanded === v) { setExpanded(null); return }
    setExpanded(v)
    if (!details[v]) {
      ticketApi.getFlowVersion(flowId, v)
        .then((d) => setDetails((s) => ({ ...s, [v]: d })))
        .catch((e) => toast.error(e.message || '加载版本详情失败'))
    }
  }

  // 展开版本的存档 → 当前编辑内容 的差异（current 变化自动重算）。
  // current 是父组件每次渲染新建的 payload() 对象，直接作依赖会导致每次渲染全量重算
  // diff；以序列化串作为稳定依赖（stringify 远轻于节点级 diff 遍历）
  const currentKey = useMemo(() => JSON.stringify(current), [current])
  const diff = useMemo(() => {
    if (expanded == null) return undefined // undefined=未展开，null=加载中
    const d = details[expanded]
    if (!d) return null
    return diffFlow({ name: d.name, description: d.description, nodes: d.nodes }, current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, details, currentKey])

  const handleRollback = (v) => {
    confirm({
      title: '回滚到历史版本',
      message: `将用 v${v} 的存档内容覆盖当前模板（名称/描述/节点/路由），并回到草稿态，检查后需重新发布才生效。${dirty ? '注意：当前未保存的修改将被覆盖。' : ''}`,
      variant: 'danger',
      confirmText: '回滚',
    }).then((ok) => {
      if (!ok) return
      setRolling(v)
      ticketApi.rollbackFlowVersion(flowId, v)
        .then(() => {
          toast.success(`已回滚到 v${v}（草稿态），检查后请重新发布`)
          onRolledBack?.()
          load()
        })
        .catch((e) => toast.error(e.message || '回滚失败'))
        .finally(() => setRolling(null))
    })
  }

  return (
    <Drawer open={open} onClose={onClose} title="版本历史" width="w-[620px]">
      {/* 当前状态摘要 */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        <span>
          当前：{isDraft
            ? <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-500">草稿</span>
            : <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-500">已发布 v{currentVersion}</span>}
          {dirty && <span className="ml-1.5 text-amber-500">· 有未保存修改</span>}
        </span>
        <span className="ml-auto">发布自动存档 · 展开可对比当前内容</span>
      </div>

      {loading && versions.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
      ) : versions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          暂无发布存档<br />
          <span className="text-xs">每次发布会自动存档一个版本，供历史查看与回滚</span>
        </div>
      ) : (
        <div className="space-y-2">
          {versions.map((v) => (
            <div key={v.version} className="rounded-md border border-border bg-card transition hover:border-primary/40">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleExpand(v.version)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  title={expanded === v.version ? '收起差异' : '展开与当前内容的差异'}
                >
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded === v.version ? 'rotate-180' : ''}`} />
                  <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">v{v.version}</span>
                  {!isDraft && v.version === currentVersion && (
                    <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-500">当前发布</span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtTime(v.published_at)}</span>
                  <span className="shrink-0 truncate text-xs text-muted-foreground" title={v.published_by}>{v.published_by || '--'}</span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{v.node_count} 节点</span>
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => handleRollback(v.version)}
                    disabled={rolling === v.version}
                    className="btn-secondary btn-sm shrink-0"
                    title="用该版本内容覆盖当前模板，回到草稿态"
                  >
                    <RotateCcw className="h-3 w-3" />{rolling === v.version ? '回滚中' : '回滚'}
                  </button>
                )}
              </div>

              {expanded === v.version && (
                <div className="border-t border-border px-4 py-3">
                  {diff === null ? (
                    <div className="py-2 text-center text-xs text-muted-foreground">加载版本详情…</div>
                  ) : diff === undefined ? null : diff.identical ? (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-500">
                      <CheckCircle2 className="h-3.5 w-3.5" />与当前编辑内容一致
                    </span>
                  ) : (
                    <div className="space-y-1.5 text-xs">
                      <p className="text-[11px] text-muted-foreground">相对该版本，当前编辑内容的差异：</p>
                      {diff.general.map((g) => (
                        <div key={g} className="flex items-center gap-1.5 text-muted-foreground">
                          <Pencil className="h-3 w-3 shrink-0" />{g}
                        </div>
                      ))}
                      {diff.added.map((n) => (
                        <div key={`a-${n.key}`} className="flex items-center gap-1.5 text-emerald-500">
                          <Plus className="h-3 w-3 shrink-0" />新增节点「{n.name}」<span className="font-mono text-muted-foreground">{n.key}</span>
                        </div>
                      ))}
                      {diff.removed.map((n) => (
                        <div key={`r-${n.key}`} className="flex items-center gap-1.5 text-destructive">
                          <Minus className="h-3 w-3 shrink-0" />移除节点「{n.name}」<span className="font-mono text-muted-foreground">{n.key}</span>
                        </div>
                      ))}
                      {diff.changed.map((c) => (
                        <div key={`c-${c.key}`} className="flex flex-wrap items-center gap-1.5 text-amber-600 dark:text-amber-400">
                          <Pencil className="h-3 w-3 shrink-0" />
                          <span>变更节点「{c.name}」：</span>
                          <span className="text-muted-foreground">{c.diffs.join('；')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}
