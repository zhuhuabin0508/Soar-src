// 工作流版本历史面板：在编辑器右侧展示「版本历史 / 版本对比 / 变更审计」三个 Tab。
//
// 能力：
// - 版本历史：列出所有版本快照（版本号 / 变更说明 / 修改人 / 修改时间），
//   支持创建版本、回滚到指定版本（覆盖当前画布）、展开查看节点/连线摘要。
// - 版本对比：选择两个版本，计算并展示节点增删、节点配置变更、连线变更，
//   用颜色区分新增(绿)/删除(红)/修改(黄)。
// - 变更审计：从版本历史推算审计日志（相邻版本差异），展示时间、操作人、
//   操作类型（创建/更新/发布/回滚）与变更摘要。
//
// 后端版本列表已返回 snapshot（含 graph_config），因此对比与审计可直接基于
// 列表数据计算，无需逐个拉取详情。
import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  GitBranch, History, RotateCcw, GitCompare, ScrollText,
  Plus, RefreshCw, Clock, User, ChevronDown, ChevronRight,
  ArrowLeftRight, FileText, CircleDot,
} from 'lucide-react'
import { workflows as workflowsApi } from '../api/client'
import { useWorkflowStore } from '../store/workflowStore'
import { toast } from '../store/toastStore'
import { confirm } from './ConfirmDialog'
import { CompactSelect, PillTabs } from './ui'

// 格式化时间
function fmtTime(t) {
  if (!t) return ''
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(t)
  }
}

// 从 graph_config 中提取节点数组，兼容 nodes / node 两种字段
function getNodes(graphConfig) {
  if (!graphConfig || typeof graphConfig !== 'object') return []
  if (Array.isArray(graphConfig.nodes)) return graphConfig.nodes
  if (Array.isArray(graphConfig.node)) return graphConfig.node
  return []
}

// 从 graph_config 中提取连线数组，兼容 edges / connections / links
function getEdges(graphConfig) {
  if (!graphConfig || typeof graphConfig !== 'object') return []
  if (Array.isArray(graphConfig.edges)) return graphConfig.edges
  if (Array.isArray(graphConfig.connections)) return graphConfig.connections
  if (Array.isArray(graphConfig.links)) return graphConfig.links
  return []
}

// 节点摘要：节点数 + 连线数
function graphSummary(graphConfig) {
  return { nodes: getNodes(graphConfig).length, edges: getEdges(graphConfig).length }
}

// 节点显示名：优先 data.label，其次 id
function nodeLabel(n) {
  return n?.data?.label || n?.id || '未命名节点'
}

// 连线唯一键：source(+handle) -> target(+handle)
function edgeKey(e) {
  const s = e.source ?? ''
  const t = e.target ?? ''
  const sh = e.sourceHandle ? `:${e.sourceHandle}` : ''
  const th = e.targetHandle ? `:${e.targetHandle}` : ''
  return `${s}${sh}->${t}${th}`
}

// 截断长值用于差异展示
function shortVal(v) {
  if (v === undefined || v === null) return '∅'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 48 ? s.slice(0, 48) + '…' : s
}

// 计算两个 graph_config 的差异（A=基准/旧，B=对比/新）
// 返回 { added, removed, modified, addedEdges, removedEdges }
//   - added: B 中有但 A 中没有的节点
//   - removed: A 中有但 B 中没有的节点
//   - modified: 两版本都存在但 data/type 不同的节点（含 changedKeys 列表）
function diffGraphs(gcA, gcB) {
  const nodesA = getNodes(gcA)
  const nodesB = getNodes(gcB)
  const mapA = new Map(nodesA.map((n) => [n.id, n]))
  const mapB = new Map(nodesB.map((n) => [n.id, n]))
  const added = []
  const removed = []
  const modified = []
  mapB.forEach((n, id) => {
    if (!mapA.has(id)) {
      added.push(n)
      return
    }
    const a = mapA.get(id)
    if (a.type !== n.type || JSON.stringify(a.data) !== JSON.stringify(n.data)) {
      const changedKeys = []
      const allKeys = new Set([
        ...Object.keys(a.data || {}),
        ...Object.keys(n.data || {}),
      ])
      allKeys.forEach((k) => {
        if (JSON.stringify(a.data?.[k]) !== JSON.stringify(n.data?.[k])) {
          changedKeys.push(k)
        }
      })
      modified.push({ node: n, before: a, changedKeys })
    }
  })
  mapA.forEach((n, id) => {
    if (!mapB.has(id)) removed.push(n)
  })
  const edgesA = getEdges(gcA)
  const edgesB = getEdges(gcB)
  const setA = new Set(edgesA.map(edgeKey))
  const setB = new Set(edgesB.map(edgeKey))
  const addedEdges = edgesB.filter((e) => !setA.has(edgeKey(e)))
  const removedEdges = edgesA.filter((e) => !setB.has(edgeKey(e)))
  return { added, removed, modified, addedEdges, removedEdges }
}

// 从版本历史（升序）推算审计日志条目
// 每个条目：{ version, operation, summary }
function buildAuditLog(versionsAsc) {
  return versionsAsc
    .map((v, i) => {
      const note = (v.change_note || '').toLowerCase()
      let operation = '更新'
      if (i === 0) {
        operation = '创建'
      } else if (note.includes('回滚') || note.includes('rollback')) {
        operation = '回滚'
      } else if (note.includes('发布') || note.includes('publish')) {
        operation = '发布'
      }
      let summary = ''
      if (i === 0) {
        const s = graphSummary(v.snapshot?.graph_config)
        summary = `初始版本（${s.nodes} 节点，${s.edges} 连线）`
      } else {
        const prev = versionsAsc[i - 1]
        const d = diffGraphs(prev.snapshot?.graph_config, v.snapshot?.graph_config)
        const parts = []
        if (d.added.length) parts.push(`新增 ${d.added.length} 节点`)
        if (d.removed.length) parts.push(`删除 ${d.removed.length} 节点`)
        if (d.modified.length) parts.push(`修改 ${d.modified.length} 节点配置`)
        if (d.addedEdges.length) parts.push(`新增 ${d.addedEdges.length} 连线`)
        if (d.removedEdges.length) parts.push(`删除 ${d.removedEdges.length} 连线`)
        summary = parts.length ? parts.join('，') : '无结构变更'
      }
      return { version: v, operation, summary }
    })
    .reverse() // 最新在前
}

// 操作类型 → 徽章样式映射
const OP_STYLE = {
  创建: 'bg-info/15 text-info',
  更新: 'bg-primary/15 text-primary',
  发布: 'bg-success/15 text-success',
  回滚: 'bg-warning/15 text-warning',
  删除: 'bg-destructive/15 text-destructive',
}

const TABS = [
  { key: 'history', label: '版本历史', icon: History },
  { key: 'compare', label: '版本对比', icon: GitCompare },
  { key: 'audit', label: '变更审计', icon: ScrollText },
]

function WorkflowVersionHistory({ workflowId }) {
  const [tab, setTab] = useState('history')
  const [versions, setVersions] = useState([]) // 降序（最新在前）
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 展开详情的版本 id
  const [expandedId, setExpandedId] = useState(null)
  // 操作中的版本 id（创建/回滚）
  const [actingIds, setActingIds] = useState({})

  // 回滚后需要把快照灌入画布
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow)

  // 拉取版本列表
  const load = useCallback(async () => {
    if (!workflowId) {
      setVersions([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await workflowsApi.versions(workflowId)
      const list = Array.isArray(data) ? data : (data?.items || data?.versions || [])
      // 按 version_number 降序
      const sorted = [...list].sort((a, b) => {
        const va = Number(a?.version_number) || 0
        const vb = Number(b?.version_number) || 0
        return vb - va
      })
      setVersions(sorted)
    } catch (err) {
      setError(err.message || '加载版本列表失败')
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    load()
  }, [load])

  // 创建版本：输入变更说明后调用 POST
  const handleCreate = useCallback(async () => {
    const note = window.prompt('请输入版本变更说明', '')
    if (note === null) return
    setActingIds((m) => ({ ...m, __create: true }))
    try {
      await workflowsApi.createVersion(workflowId, note)
      toast.success('版本创建成功')
      await load()
    } catch (err) {
      setError(err.message || '创建版本失败')
    } finally {
      setActingIds((m) => ({ ...m, __create: false }))
    }
  }, [workflowId, load])

  // 回滚到指定版本：确认后调用 rollback，并用返回的工作流快照覆盖当前画布
  const handleRollback = useCallback(
    async (versionId, versionNumber) => {
      const ok = await confirm({
        message: `回滚将覆盖当前画布内容，是否继续？（回滚到版本 v${versionNumber}）`,
        variant: 'danger',
        confirmText: '确定回滚',
      })
      if (!ok) return
      setActingIds((m) => ({ ...m, [versionId]: true }))
      try {
        const resp = await workflowsApi.rollbackVersion(workflowId, versionId)
        // 回滚响应：{ workflow: { name, graph_config, enabled }, version_number, message }
        const wf = resp?.workflow || {}
        loadWorkflow({
          id: workflowId,
          name: wf.name ?? '',
          graph_config: wf.graph_config || { nodes: [], edges: [] },
        })
        toast.success(`已回滚到 v${resp?.version_number ?? versionNumber}`)
        await load()
      } catch (err) {
        setError(err.message || '回滚失败')
      } finally {
        setActingIds((m) => ({ ...m, [versionId]: false }))
      }
    },
    [workflowId, load, loadWorkflow]
  )

  // 最新版本号
  const currentVersionNumber = versions[0]?.version_number
  // 升序版本（用于审计推算）
  const versionsAsc = useMemo(
    () => [...versions].sort((a, b) => (Number(a?.version_number) || 0) - (Number(b?.version_number) || 0)),
    [versions]
  )

  if (!workflowId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-center text-sm text-muted-foreground">请先保存工作流</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：当前版本号 + 刷新 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              版本管理
            </h2>
            {currentVersionNumber != null && (
              <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
                当前 v{currentVersionNumber}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="刷新版本列表"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <PillTabs items={TABS} value={tab} onChange={setTab} />
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/20 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* 内容区 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {loading && versions.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">加载中…</div>
        ) : tab === 'history' ? (
          <HistoryTab
            versions={versions}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            actingIds={actingIds}
            onCreate={handleCreate}
            onRollback={handleRollback}
            creating={!!actingIds.__create}
          />
        ) : tab === 'compare' ? (
          <CompareTab versions={versions} />
        ) : (
          <AuditTab versionsAsc={versionsAsc} />
        )}
      </div>
    </div>
  )
}

// ============ Tab 1：版本历史 ============
function HistoryTab({ versions, expandedId, setExpandedId, actingIds, onCreate, onRollback, creating }) {
  if (versions.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="btn-primary btn-sm w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          {creating ? '创建中…' : '创建第一个版本'}
        </button>
        <p className="py-4 text-center text-xs text-muted-foreground">
          暂无版本记录
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      {/* 创建版本按钮 */}
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="btn-secondary btn-sm w-full"
      >
        <Plus className="h-3.5 w-3.5" />
        {creating ? '创建中…' : '创建版本'}
      </button>

      {/* 版本列表 */}
      {versions.map((v) => {
        const vid = v.id
        const expanded = expandedId === vid
        const isActing = actingIds[vid]
        const snapshot = v.snapshot || {}
        const summary = graphSummary(snapshot.graph_config)
        return (
          <div
            key={vid}
            className="rounded-md border border-border bg-card transition hover:bg-muted"
          >
            <div className="flex flex-col gap-1 px-2.5 py-2">
              {/* 第一行：版本号 + 变更说明 */}
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
                  v{v.version_number}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {v.change_note || '（无变更说明）'}
                </span>
              </div>
              {/* 第二行：修改人 + 修改时间 */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {fmtTime(v.created_at) || '-'}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" />
                  <span className="truncate">{v.created_by || '未知'}</span>
                </span>
              </div>
              {/* 操作按钮 */}
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : vid)}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {expanded ? '收起' : '详情'}
                </button>
                <button
                  type="button"
                  onClick={() => onRollback(vid, v.version_number)}
                  disabled={!!isActing}
                  className="inline-flex items-center gap-1 rounded border border-warning/50 px-2 py-0.5 text-xs text-warning transition hover:border-red-600 hover:text-destructive disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                  {isActing ? '回滚中…' : '回滚'}
                </button>
              </div>
            </div>

            {/* 展开内容：快照摘要 */}
            {expanded && (
              <div className="border-t border-border p-2.5">
                <div className="flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">名称：</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {snapshot.name || '（未命名）'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <CircleDot className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">节点：</span>
                      <span className="font-mono text-primary">{summary.nodes}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">连线：</span>
                      <span className="font-mono text-primary">{summary.edges}</span>
                    </div>
                  </div>
                  {snapshot.enabled === false && (
                    <div className="text-xs text-warning">快照状态：已停用</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============ Tab 2：版本对比 ============
function CompareTab({ versions }) {
  // 选中的两个版本 id：a=基准(旧)，b=对比(新)
  const [aId, setAId] = useState(null)
  const [bId, setBId] = useState(null)

  // 默认选最新两个版本（a=次新，b=最新）
  useEffect(() => {
    if (versions.length >= 2) {
      setAId(versions[1].id)
      setBId(versions[0].id)
    } else if (versions.length === 1) {
      setAId(versions[0].id)
      setBId(versions[0].id)
    }
  }, [versions])

  const va = versions.find((v) => v.id === aId)
  const vb = versions.find((v) => v.id === bId)

  const diff = useMemo(() => {
    if (!va || !vb) return null
    return diffGraphs(va.snapshot?.graph_config, vb.snapshot?.graph_config)
  }, [va, vb])

  if (versions.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        暂无版本可供对比
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 版本选择 */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">基准版本 A</label>
          <CompactSelect
            value={aId ?? ''}
            onChange={(e) => setAId(Number(e.target.value))}
            size="lg"
            block
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_number}{v.change_note ? ` · ${v.change_note}` : ''}
              </option>
            ))}
          </CompactSelect>
        </div>
        <GitCompare className="mt-4 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">对比版本 B</label>
          <CompactSelect
            value={bId ?? ''}
            onChange={(e) => setBId(Number(e.target.value))}
            size="lg"
            block
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_number}{v.change_note ? ` · ${v.change_note}` : ''}
              </option>
            ))}
          </CompactSelect>
        </div>
      </div>

      {/* 概要统计 */}
      {diff && (
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="rounded border border-success/30 bg-success/10 px-1 py-1.5">
            <div className="font-mono text-sm text-success">{diff.added.length}</div>
            <div className="text-xs text-muted-foreground">新增节点</div>
          </div>
          <div className="rounded border border-destructive/30 bg-destructive/10 px-1 py-1.5">
            <div className="font-mono text-sm text-destructive">{diff.removed.length}</div>
            <div className="text-xs text-muted-foreground">删除节点</div>
          </div>
          <div className="rounded border border-warning/30 bg-warning/10 px-1 py-1.5">
            <div className="font-mono text-sm text-warning">{diff.modified.length}</div>
            <div className="text-xs text-muted-foreground">修改节点</div>
          </div>
        </div>
      )}

      {/* 差异明细 */}
      {diff && (
        <div className="flex flex-col gap-2">
          {/* 新增节点 */}
          {diff.added.length > 0 && (
            <DiffGroup title="新增节点" color="success" count={diff.added.length}>
              {diff.added.map((n) => (
                <DiffLine key={n.id} sign="+" color="success" text={`${nodeLabel(n)} (${n.type || 'node'})`} />
              ))}
            </DiffGroup>
          )}
          {/* 删除节点 */}
          {diff.removed.length > 0 && (
            <DiffGroup title="删除节点" color="destructive" count={diff.removed.length}>
              {diff.removed.map((n) => (
                <DiffLine key={n.id} sign="−" color="destructive" text={`${nodeLabel(n)} (${n.type || 'node'})`} />
              ))}
            </DiffGroup>
          )}
          {/* 修改节点配置 */}
          {diff.modified.length > 0 && (
            <DiffGroup title="配置变更" color="warning" count={diff.modified.length}>
              {diff.modified.map(({ node, before, changedKeys }) => (
                <div key={node.id} className="flex flex-col gap-0.5 py-1">
                  <div className="text-xs text-warning">
                    ~ {nodeLabel(node)}
                    <span className="ml-1 text-muted-foreground">({node.id})</span>
                  </div>
                  {changedKeys.map((k) => (
                    <div key={k} className="flex flex-wrap items-center gap-1 pl-3 text-xs">
                      <span className="rounded bg-muted px-1 font-mono text-muted-foreground">{k}</span>
                      <span className="text-destructive line-through">{shortVal(before.data?.[k])}</span>
                      <ArrowLeftRight className="h-2.5 w-2.5 text-muted-foreground" />
                      <span className="text-success">{shortVal(node.data?.[k])}</span>
                    </div>
                  ))}
                </div>
              ))}
            </DiffGroup>
          )}
          {/* 连线变更 */}
          {(diff.addedEdges.length > 0 || diff.removedEdges.length > 0) && (
            <DiffGroup
              title="连线变更"
              color="info"
              count={diff.addedEdges.length + diff.removedEdges.length}
            >
              {diff.addedEdges.map((e, i) => (
                <DiffLine key={`ae-${i}`} sign="+" color="success" text={edgeKey(e)} mono />
              ))}
              {diff.removedEdges.map((e, i) => (
                <DiffLine key={`re-${i}`} sign="−" color="destructive" text={edgeKey(e)} mono />
              ))}
            </DiffGroup>
          )}
          {/* 无差异 */}
          {diff.added.length === 0 &&
            diff.removed.length === 0 &&
            diff.modified.length === 0 &&
            diff.addedEdges.length === 0 &&
            diff.removedEdges.length === 0 && (
              <div className="py-6 text-center text-xs text-muted-foreground">
                两个版本无差异
              </div>
            )}
        </div>
      )}
    </div>
  )
}

// 差异分组容器
function DiffGroup({ title, color, count, children }) {
  const colorCls = {
    success: 'text-success',
    destructive: 'text-destructive',
    warning: 'text-warning',
    info: 'text-info',
  }[color] || 'text-muted-foreground'
  return (
    <div className="rounded border border-border bg-card">
      <div className={`flex items-center justify-between border-b border-border px-2 py-1 text-xs font-medium ${colorCls}`}>
        <span>{title}</span>
        <span className="font-mono">{count}</span>
      </div>
      <div className="px-2 py-1">{children}</div>
    </div>
  )
}

// 差异单行：带符号前缀
function DiffLine({ sign, color, text, mono }) {
  const colorCls = {
    success: 'text-success',
    destructive: 'text-destructive',
    warning: 'text-warning',
  }[color] || 'text-foreground'
  return (
    <div className={`flex items-center gap-1.5 py-0.5 text-xs ${colorCls}`}>
      <span className="w-3 shrink-0 font-mono">{sign}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? 'font-mono' : ''}`}>{text}</span>
    </div>
  )
}

// ============ Tab 3：变更审计 ============
function AuditTab({ versionsAsc }) {
  const audit = useMemo(() => buildAuditLog(versionsAsc), [versionsAsc])

  if (audit.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        暂无审计记录
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0 p-3">
      {/* 审计说明 */}
      <div className="mb-2 rounded border border-border bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
        审计日志基于版本历史推算：对比相邻版本快照差异得到变更摘要。每个版本对应一次操作记录。
      </div>
      {/* 时间线 */}
      <div className="relative flex flex-col gap-0">
        {audit.map((entry, idx) => {
          const v = entry.version
          const opCls = OP_STYLE[entry.operation] || OP_STYLE.更新
          return (
            <div key={v.id} className="relative flex gap-2 pb-3">
              {/* 时间线轴 + 圆点 */}
              <div className="flex flex-col items-center">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-card ${
                  entry.operation === '创建' ? 'bg-info' :
                  entry.operation === '发布' ? 'bg-success' :
                  entry.operation === '回滚' ? 'bg-warning' :
                  entry.operation === '删除' ? 'bg-destructive' : 'bg-primary'
                }`} />
                {idx < audit.length - 1 && (
                  <span className="w-px flex-1 bg-border" />
                )}
              </div>
              {/* 内容卡片 */}
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${opCls}`}>
                    {entry.operation}
                  </span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                    v{v.version_number}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {fmtTime(v.created_at) || '-'}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-foreground">
                  {entry.summary}
                </div>
                {v.change_note && (
                  <div className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                    <FileText className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                    <span className="min-w-0 break-words">{v.change_note}</span>
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="h-2.5 w-2.5" />
                  <span className="truncate">{v.created_by || '未知'}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default WorkflowVersionHistory
