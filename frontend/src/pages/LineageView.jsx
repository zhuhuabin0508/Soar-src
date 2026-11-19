// 数据血缘视图：用 reactflow 拓扑图展示 设备 → 接收器 → 条目 → 模板 的数据血缘
// 节点按类型分列布局，显示健康状态徽章（healthy/disabled/warning/offline）
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, MarkerType } from 'reactflow'
import 'reactflow/dist/style.css'
import { Server, Radio, ListTree, FileJson, RefreshCw } from 'lucide-react'
import { EmptyState } from '../components/ui'
import { request } from '../api/client'
import { toast } from '../store/toastStore'

// 节点类型 → 图标 + 颜色
const TYPE_META = {
  device: { icon: Server, color: '#3b82f6', label: '设备' },
  receiver: { icon: Radio, color: '#8b5cf6', label: '接收器' },
  entry: { icon: ListTree, color: '#06b6d4', label: '数据源条目' },
  strategy: { icon: FileJson, color: '#10b981', label: '解析模板' },
}

// 健康状态 → 徽章颜色
const HEALTH_STYLE = {
  healthy: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  disabled: 'bg-gray-500/15 text-gray-500',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  offline: 'bg-red-500/15 text-red-600 dark:text-red-400',
}
const HEALTH_LABEL = { healthy: '正常', disabled: '已停用', warning: '有失败', offline: '离线' }

// 自定义节点
function LineageNode({ data }) {
  const { label, nodeType, health, meta } = data
  const tm = TYPE_META[nodeType] || TYPE_META.device
  const Icon = tm.icon
  return (
    <div className="flex w-[200px] flex-col rounded-lg border border-border bg-background p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-border !opacity-0" />
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-border !opacity-0" />
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md" style={{ backgroundColor: `${tm.color}22` }}>
          <Icon className="h-4 w-4" style={{ color: tm.color }} />
        </div>
        <div className="flex-1 truncate text-sm font-medium text-foreground" title={label}>{label}</div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{tm.label}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${HEALTH_STYLE[health] || HEALTH_STYLE.disabled}`}>
          {HEALTH_LABEL[health] || health}
        </span>
      </div>
      {meta && (
        <div className="mt-1.5 space-y-0.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
          {meta.type && <div>类型：{meta.type}</div>}
          {meta.ip && <div className="truncate" title={meta.ip}>IP：{meta.ip}</div>}
          {meta.protocol && <div>协议：{meta.protocol}{meta.port ? `:${meta.port}` : ''}</div>}
          {meta.version && <div>版本：v{meta.version}</div>}
          {typeof meta.alert_count === 'number' && meta.alert_count > 0 && (
            <div>今日告警：{meta.alert_count}</div>
          )}
          {typeof meta.fail_count === 'number' && meta.fail_count > 0 && (
            <div className="text-amber-600 dark:text-amber-400">今日失败：{meta.fail_count}</div>
          )}
        </div>
      )}
    </div>
  )
}

const nodeTypes = { lineage: LineageNode }

// 分层布局：按 type 分列，y 递增
const COLUMN_X = { device: 0, receiver: 320, entry: 640, strategy: 960 }

function layoutNodes(nodes) {
  const counters = { device: 0, receiver: 0, entry: 0, strategy: 0 }
  return nodes.map((n) => {
    const col = COLUMN_X[n.type] !== undefined ? n.type : 'device'
    const y = counters[col] * 130
    counters[col] += 1
    return {
      id: n.id,
      type: 'lineage',
      position: { x: COLUMN_X[col], y },
      data: { label: n.label, nodeType: n.type, health: n.health, meta: n.meta },
      draggable: true,
    }
  })
}

const edgeStyle = {
  stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '0',
}

export default function LineageView() {
  const navigate = useNavigate()
  const [data, setData] = useState({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await request('/ingest/lineage')
      setData(res)
    } catch (e) {
      toast.error(e.message || '血缘数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const rfNodes = layoutNodes(data.nodes || [])
  const rfEdges = (data.edges || [])
    .filter((e) => e && e.source && e.target)
    .map((e, i) => ({
      id: e.id || `edge-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'smoothstep',
      style: edgeStyle,
      markerEnd: { type: MarkerType.ArrowClosed },
    }))

  const counts = (data.nodes || []).reduce((acc, n) => {
    acc[n.type] = (acc[n.type] || 0) + 1
    return acc
  }, {})

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">数据血缘视图</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{(data.nodes || []).length}</span> 个节点
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">设备 → 接收器 → 数据源条目 → 解析模板 的拓扑血缘与健康状态</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新血缘数据">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {/* 统计条 */}
        {!loading && (
          <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>设备 {counts.device || 0}</span>
            <span>接收器 {counts.receiver || 0}</span>
            <span>数据源条目 {counts.entry || 0}</span>
            <span>解析模板 {counts.strategy || 0}</span>
            <span>连线 {rfEdges.length}</span>
            <span className="ml-auto flex items-center gap-3">
              {Object.entries(HEALTH_LABEL).map(([k, v]) => (
                <span key={k} className="flex items-center gap-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${HEALTH_STYLE[k]}`} />
                  {v}
                </span>
              ))}
            </span>
          </div>
        )}

        {/* 拓扑图：加载中渲染分列骨架屏占位，无数据给接入引导，正常渲染拓扑图 */}
        <div className="min-h-[480px] flex-1 rounded-lg border border-border bg-background">
          {loading ? (
            <div className="flex h-full flex-col gap-4 p-4">
              <div className="flex items-center justify-between">
                <div className="h-4 w-44 rounded skeleton-shimmer" />
                <div className="h-4 w-56 rounded skeleton-shimmer" />
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 md:grid-cols-4">
                {['device', 'receiver', 'entry', 'strategy'].map((t) => (
                  <div key={t} className="flex flex-col gap-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 shrink-0 rounded-md skeleton-shimmer" />
                          <div className="h-3.5 w-24 rounded skeleton-shimmer" />
                        </div>
                        <div className="mt-2.5 flex items-center justify-between">
                          <div className="h-2.5 w-10 rounded skeleton-shimmer" />
                          <div className="h-4 w-14 rounded skeleton-shimmer" />
                        </div>
                        <div className="mt-2.5 space-y-1.5 border-t border-border pt-2">
                          <div className="h-2.5 w-full rounded skeleton-shimmer" />
                          <div className="h-2.5 w-2/3 rounded skeleton-shimmer" />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : rfNodes.length === 0 ? (
            <EmptyState
              icon={Server}
              title="暂无血缘数据"
              description="请先通过设备列表的「新建设备」完成设备接入，并创建接收器"
              action={(
                <button type="button" onClick={() => navigate('/devices')} className="btn-primary btn-sm">
                  前往设备对接
                </button>
              )}
            />
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewPadding={0.15}
              minZoom={0.2}
              maxZoom={1.5}
              nodesConnectable={false}
              edgesFocusable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#cbd5e1" gap={16} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) => (TYPE_META[n.data?.nodeType]?.color) || '#94a3b8'}
                maskColor="rgba(241,245,249,0.7)"
              />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  )
}
