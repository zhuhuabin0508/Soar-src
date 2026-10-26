// 工单流程模板编辑页：全屏左右分栏，支持「列表 / 画布」双模式（记忆上次选择）
// - 列表模式：左栏节点竖排列表 + 右栏节点编辑
// - 画布模式：reactflow 拓扑视图（分层自动布局、拖拽连线创建路由）+ 右栏属性面板
// - 顶部：模板名称/描述/发起分组 + 保存（Ctrl+S）/发布；脏状态检测 + 离开二次确认
// - 编辑时前端实时校验（与后端发布校验同规则）：左栏节点标红/标黄 + 顶部校验摘要 + 节点面板问题清单
// - 发布前服务端结构校验失败会以 toast 反馈完整错误
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  GitGraph, Plus, Trash2, ArrowUp, ArrowDown, Save, Rocket, ArrowLeft,
  Flag, ChevronRight, GripVertical, AlertTriangle, UsersRound, CheckCircle2, List, History, ShieldBan,
} from 'lucide-react'
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, MarkerType } from 'reactflow'
import { toast } from '../store/toastStore'
import InfoTip from '../components/InfoTip'
import { CcChips, CcSelectModal, ccKey } from '../components/CcPicker'
import TicketFlowVersionsDrawer from '../components/TicketFlowVersionsDrawer'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { inputCls, inputBaseCls, labelCls, hintCls } from '../components/property/FormControls'
import { Button, PageContainer, CompactSelect } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import { condText, normWhen, COND_OP_OPTIONS, isCondOp } from '../utils/ticketFlow'
import ticketApi from '../api/tickets'

// 字段类型定义
const FIELD_TYPES = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '富文本' },
  { value: 'number', label: '数字' },
  { value: 'datetime', label: '日期时间' },
  { value: 'select', label: '下拉选择' },
  { value: 'switch', label: '是否开关' },
  { value: 'ip', label: 'IP 地址' },
  { value: 'url', label: 'URL' },
  { value: 'file', label: '附件' },
  { value: 'reference', label: '引用联动' },
  { value: 'duration', label: '时长' },
]

// 告警一键发起时的字段映射来源（AlertEvent 列）
const ALERT_FIELD_OPTIONS = [
  { value: '', label: '不映射' },
  { value: 'alert_name', label: '告警名称' },
  { value: 'occur_timestamp', label: '发生时间' },
  { value: 'device_type', label: '告警平台（设备类型）' },
  { value: 'src_ip', label: '源 IP 地址' },
  { value: 'dst_ip', label: '目标 IP 地址' },
  { value: 'host_ip', label: '主机 IP' },
  { value: 'risk_level_name', label: '风险等级' },
  { value: 'threat_class', label: '威胁大类' },
  { value: 'threat_type', label: '威胁类型' },
  { value: 'attack_state_name', label: '攻击状态' },
  { value: 'description', label: '告警描述' },
  { value: 'recommendation', label: '处置建议' },
  { value: 'src_region_name', label: '源区域' },
  { value: 'dst_region_name', label: '目标区域' },
  { value: 'protocol', label: '协议' },
]

// 生成节点内唯一字段 key
const nextFieldKey = (fields) => {
  let i = fields.length + 1
  const keys = new Set(fields.map((f) => f.key))
  while (keys.has(`f${i}`)) i += 1
  return `f${i}`
}

// 平铺节点全部字段（顶层 + 匹配规则扩展字段）：key 唯一性集合与路由条件字段选择共用
const flatFields = (fields) => {
  const out = []
  ;(fields || []).forEach((f) => {
    out.push(f)
    ;(f.rules || []).forEach((r) => (r.fields || []).forEach((rf) => out.push(rf)))
  })
  return out
}

// 引用联动字段：被引用字段多选（勾选 chips，候选=全流程平铺字段）
function RefFieldsPicker({ value, onChange, excludeKey, allFields, disabled }) {
  const cur = value || []
  const cands = (allFields || []).filter((x) => x.key && x.key !== excludeKey)
  const toggle = (rk, checked) => onChange(checked ? [...cur, rk] : cur.filter((x) => x !== rk))
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-background p-2">
      {cands.map((x) => (
        <label key={x.key}
          className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs ${
            cur.includes(x.key) ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
          }`}>
          <input type="checkbox" className="h-3.5 w-3.5 accent-primary" disabled={disabled}
            checked={cur.includes(x.key)} onChange={(e) => toggle(x.key, e.target.checked)} />
          {x.label || x.key}
          <span className="opacity-60">（{x._node}）</span>
        </label>
      ))}
      {!cands.length && <span className="px-1 py-0.5 text-xs text-muted-foreground">暂无其他字段可引用</span>}
    </div>
  )
}

// 节点路由条件归一化：旧单条件 when 结构统一转为 {logic, conds}（保存原样入库，后端两种都兼容）
const normNodeRoutes = (ns) => (ns || []).map((n) => ({
  ...n,
  routes: (n.routes || []).map((r) => (r.when ? { ...r, when: normWhen(r.when) } : r)),
  // 并行会签节点：补齐 sign_groups / finish_policy（旧模板无该类型，兼容防御）
  ...(n.type === 'parallel' ? { sign_groups: n.sign_groups || [], finish_policy: n.finish_policy || 'all' } : {}),
}))

// 下拉选项编辑器：本地暂存原始文本，失焦时才提交为选项数组。
// 直接受控（split → trim → filter → join 回填）会在按回车时立即清除尾部
// 空行并回写 value，光标被弹回行尾，表现为「回车无法换行」。
function FieldOptionsInput({ value, disabled, onCommit }) {
  const [text, setText] = useState((value || []).join('\n'))
  const focusedRef = useRef(false)

  // 外部选项变化时同步到本地文本（聚焦输入中不覆盖，避免打断编辑）
  useEffect(() => {
    if (!focusedRef.current) setText((value || []).join('\n'))
  }, [value])

  return (
    <textarea
      className={`${inputCls} resize-y`}
      rows={2}
      disabled={disabled}
      placeholder="每行一个选项，如：&#10;是&#10;否"
      value={text}
      onFocus={() => { focusedRef.current = true }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focusedRef.current = false
        const opts = text.split('\n').map((s) => s.trim()).filter(Boolean)
        setText(opts.join('\n'))
        onCommit(opts)
      }}
    />
  )
}

// ===== 画布模式（reactflow 拓扑视图） =====
// 节点卡片：名称 / 绑定分组 / 字段数 / 校验徽标；左右连接桩用于拖拽连线路由
function TicketFlowNodeCard({ data, selected }) {
  const { n, index, gname, errCount, warnCount } = data
  const invalid = errCount > 0
  const warn = !invalid && warnCount > 0
  return (
    <div className={`w-[216px] rounded-lg border bg-card px-3 py-2.5 shadow-sm transition ${invalid ? 'border-destructive' : selected ? 'border-primary ring-2 ring-primary/20' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-2 !border-background !bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${n.type === 'end' ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary'}`}>
          {n.type === 'end' ? '✓' : index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{n.name || n.key}</span>
        {(invalid || warn) && (
          <span className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white ${invalid ? 'bg-destructive' : 'bg-amber-500'}`}>
            {invalid ? errCount : warnCount}
          </span>
        )}
      </div>
      <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
        {n.type === 'end' ? '结束节点'
          : n.type === 'parallel' ? `并行会签 · ${gname || '未绑定分组'} · ${(n.fields || []).length} 字段`
          : `${gname || '未绑定分组'} · ${(n.fields || []).length} 字段`}
      </div>
      {n.type === 'parallel' && (
        <div className="mt-1 truncate text-[10px] font-medium text-violet-500">
          {n.finish_policy === 'any' ? '任一分组提交即流转' : '全部会签完成才流转'}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-2 !border-background !bg-primary" />
    </div>
  )
}

const ticketFlowNodeTypes = { ticketNode: TicketFlowNodeCard }

// 画布：按路由依赖分层自动布局（默认路由实线 / 条件路由虚线）；拖拽位置仅本地暂存不入库
function TicketFlowCanvas({ flowNodes, validation, selectedKey, groups, canEdit, onSelect, onConnectRoute }) {
  const [posOverride, setPosOverride] = useState({})

  const rfNodes = useMemo(() => {
    const byKey = new Map(flowNodes.map((n) => [n.key, n]))
    const incoming = new Map()
    flowNodes.forEach((n) => (n.routes || []).forEach((r) => {
      if (!r.to || !byKey.has(r.to)) return
      if (!incoming.has(r.to)) incoming.set(r.to, [])
      incoming.get(r.to).push(n.key)
    }))
    const layers = new Map()
    const layerOf = (key, stack = new Set()) => {
      if (layers.has(key)) return layers.get(key)
      if (stack.has(key)) return 0
      stack.add(key)
      let l = 0
      ;(incoming.get(key) || []).forEach((from) => { l = Math.max(l, layerOf(from, stack) + 1) })
      layers.set(key, l)
      return l
    }
    const byLayer = new Map()
    flowNodes.forEach((n, i) => {
      const l = layerOf(n.key)
      if (!byLayer.has(l)) byLayer.set(l, [])
      byLayer.get(l).push({ n, i })
    })
    const out = []
    byLayer.forEach((items, l) => {
      items.forEach(({ n, i }) => {
        out.push({
          id: n.key,
          type: 'ticketNode',
          position: posOverride[n.key] || { x: l * 340, y: i * 150 },
          data: {
            n,
            index: i,
            gname: n.type === 'parallel'
              ? (n.sign_groups || []).map((gid) => groups.find((g) => g.id === gid)?.name).filter(Boolean).join('、')
              : groups.find((g) => g.id === n.group_id)?.name,
            errCount: (validation.nodeErrors[n.key] || []).length,
            warnCount: (validation.nodeWarnings[n.key] || []).length,
          },
          deletable: false,
        })
      })
    })
    return out
  }, [flowNodes, groups, validation, posOverride])

  const rfEdges = useMemo(() => {
    const keySet = new Set(flowNodes.map((n) => n.key))
    const out = []
    flowNodes.forEach((n) => (n.routes || []).forEach((r, ri) => {
      if (!r.to || !keySet.has(r.to)) return
      const isDefault = r.when == null
      const label = r.label || (isDefault ? '默认' : condText(r.when))
      const active = n.key === selectedKey || r.to === selectedKey
      const color = active ? '#6366f1' : isDefault ? '#818cf8' : '#94a3b8'
      out.push({
        id: `${n.key}->${r.to}#${ri}`,
        source: n.key,
        target: r.to,
        label,
        labelStyle: { fontSize: 11, fill: '#fff', fontWeight: 500 },
        labelBgStyle: { fill: active ? '#6366f1' : isDefault ? '#475569' : '#334155' },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        style: { stroke: color, strokeWidth: active ? 3 : 2, ...(isDefault ? {} : { strokeDasharray: '6 4' }) },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        deletable: false,
      })
    }))
    return out
  }, [flowNodes, selectedKey])

  // 拖拽位置仅写本地暂存（不回写模板数据，刷新后恢复自动布局）
  const onNodesChange = useCallback((changes) => {
    let pos = null
    changes.forEach((c) => {
      if (c.type === 'position' && c.position) {
        if (!pos) pos = {}
        pos[c.id] = c.position
      }
    })
    if (pos) setPosOverride((s) => ({ ...s, ...pos }))
  }, [])

  const handleConnect = useCallback((conn) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    onConnectRoute(conn.source, conn.target)
  }, [onConnectRoute])

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={ticketFlowNodeTypes}
      onNodesChange={onNodesChange}
      onConnect={canEdit ? handleConnect : undefined}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelect(edge.source)}
      fitView
      minZoom={0.2}
      maxZoom={1.6}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
      className="h-full w-full bg-background"
    >
      <Background color="#374151" gap={16} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="!bg-secondary" maskColor="rgba(17,24,39,0.7)" nodeColor={() => '#6366f1'} />
    </ReactFlow>
  )
}

export default function TicketFlowEdit() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const canEdit = hasPermission('ticket_config', 'edit')

  const [loading, setLoading] = useState(!isNew)
  const [flowId, setFlowId] = useState(id ? Number(id) : null)
  const [meta, setMeta] = useState({ name: '', description: '' })
  const [startGroups, setStartGroups] = useState([])
  const [startPickerOpen, setStartPickerOpen] = useState(false)
  const [ccTargets, setCcTargets] = useState([]) // 模板级固定抄送 [{type, id, name}]
  const [ccPickerOpen, setCcPickerOpen] = useState(false)
  const [nodes, setNodes] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  // 发布校验失败时定位到问题节点（红框高亮，数秒后自动消除）
  const [invalidKeys, setInvalidKeys] = useState([])
  // 高亮定时器统一管理：重复触发时重置计时，组件卸载时清理，避免残留 setState
  const invalidTimer = useRef(null)
  const flashInvalidKeys = useCallback((keys) => {
    setInvalidKeys(keys)
    if (invalidTimer.current) clearTimeout(invalidTimer.current)
    invalidTimer.current = setTimeout(() => setInvalidKeys([]), 8000)
  }, [])
  useEffect(() => () => { if (invalidTimer.current) clearTimeout(invalidTimer.current) }, [])
  // 定位滚动到节点元素：列表视图节点带 data-nodekey，画布 ReactFlow 节点带 data-id
  const scrollNodeIntoView = (key) => {
    document.querySelector(`[data-nodekey="${key}"], .react-flow__node[data-id="${key}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [initial, setInitial] = useState('')
  const [groups, setGroups] = useState([])
  // 模板发布状态（版本历史抽屉展示用）：version / is_draft
  const [flowState, setFlowState] = useState({ version: 0, is_draft: true })
  // 版本历史抽屉
  const [versionsOpen, setVersionsOpen] = useState(false)
  // 视图模式：列表 / 画布（记忆上次选择）
  const [viewMode, setViewMode] = useState(() => (localStorage.getItem('ticketFlowView') === 'canvas' ? 'canvas' : 'list'))

  // 外部数据重载版本号：loadFlow（初始化/版本回滚）完成时 +1，
  // 驱动"回退设置三态"等本地派生 UI 态按新数据重新推导
  const [flowDataRev, setFlowDataRev] = useState(0)

  useEffect(() => {
    ticketApi.listGroups().then((res) => setGroups(res.items || [])).catch(() => {})
  }, [])

  useEffect(() => { localStorage.setItem('ticketFlowView', viewMode) }, [viewMode])

  // 发起分组 chips 数据：复用 CcChips 展示（分组徽标 + 超量折叠 +N）
  const startGroupTargets = startGroups
    .map((gid) => groups.find((g) => g.id === gid))
    .filter(Boolean)
    .map((g) => ({ type: 'group', id: g.id, name: g.name }))

  const serialize = useCallback(
    (m, sg, cc, ns) => JSON.stringify({ name: (m.name || '').trim(), description: (m.description || '').trim(), start_groups: sg, cc_targets: cc, nodes: ns }),
    [],
  )

  // 加载已有模板（初始化与版本回滚后共用）
  const loadFlow = useCallback(() => {
    setLoading(true)
    ticketApi.getFlow(id)
      .then((f) => {
        const nj = f.nodes || {}
        const ns = normNodeRoutes(nj.nodes || [])
        const m = { name: f.name, description: f.description || '' }
        const sg = nj.start_groups || []
        const cc = nj.cc_targets || []
        setMeta(m)
        setStartGroups(sg)
        setCcTargets(cc)
        setNodes(ns)
        setSelectedKey(ns[0]?.key || '')
        setFlowDataRev((v) => v + 1)
        setInitial(serialize(m, sg, cc, ns))
        setFlowState({ version: f.version || 0, is_draft: !!f.is_draft })
      })
      .catch((e) => { toast.error(e.message || '加载流程模板失败'); navigate('/ticket-config/flows') })
      .finally(() => setLoading(false))
  }, [id, navigate, serialize])

  // 初始化 / 路由参数变化
  useEffect(() => {
    if (isNew) {
      const defaultNodes = [
        { key: 'n1', name: '发起节点', type: 'task', group_id: '', fields: [], routes: [{ to: 'n2', label: '', when: null }] },
        { key: 'n2', name: '处理节点', type: 'task', group_id: '', fields: [], routes: [{ to: 'end', label: '', when: null }] },
        { key: 'end', name: '结束', type: 'end', fields: [], routes: [] },
      ]
      setMeta({ name: '', description: '' })
      setStartGroups([])
      setCcTargets([])
      setNodes(defaultNodes)
      setSelectedKey('n1')
      setFlowDataRev((v) => v + 1)
      setInitial(serialize({ name: '', description: '' }, [], [], defaultNodes))
      return
    }
    loadFlow()
  }, [id, isNew, loadFlow])

  const dirty = useMemo(
    () => serialize(meta, startGroups, ccTargets, nodes) !== initial,
    [serialize, meta, startGroups, ccTargets, nodes, initial],
  )

  const payload = useCallback(() => ({
    name: meta.name.trim(),
    description: meta.description.trim(),
    nodes: { start_groups: startGroups, cc_targets: ccTargets, nodes },
  }), [meta, startGroups, ccTargets, nodes])

  const markClean = useCallback(() => {
    setInitial(serialize(meta, startGroups, ccTargets, nodes))
  }, [serialize, meta, startGroups, ccTargets, nodes])

  const handleSave = useCallback(async () => {
    if (!meta.name.trim()) { toast.error('请输入模板名称'); return }
    setSaving(true)
    try {
      if (isNew) {
        const f = await ticketApi.createFlow(payload())
        setFlowId(f.id)
        toast.success('模板已创建（草稿）')
        markClean()
        bypassGuard()
        navigate(`/ticket-config/flows/${f.id}/edit`, { replace: true })
      } else {
        await ticketApi.updateFlow(flowId, payload())
        toast.success('模板已保存（草稿），发布后才能发起工单')
        markClean()
      }
    } catch (e) {
      toast.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, isNew, payload, flowId, markClean, navigate, serialize, startGroups, ccTargets, nodes])

  const bypassGuard = useUnsavedChanges(dirty, { onSave: handleSave })

  const handlePublish = async () => {
    if (!meta.name.trim()) { toast.error('请输入模板名称'); return }
    if (isNew) { toast.error('请先保存模板再发布'); return }
    // 前端实时校验先行拦截（与后端发布校验同规则），失败直接定位问题节点
    if (validation.errors.length) {
      if (issueKeys.length) jumpToIssue()
      toast.error(validation.errors[0])
      return
    }
    setPublishing(true)
    try {
      await ticketApi.updateFlow(flowId, payload())
      const f = await ticketApi.publishFlow(flowId)
      markClean()
      setFlowState({ version: f.version, is_draft: !!f.is_draft })
      toast.success(`发布成功（v${f.version}），现在可以在工单中心发起该流程的工单`)
    } catch (e) {
      // 服务端校验文案形如「第 2 个节点（xx）：未绑定处理分组」，据此高亮定位问题节点
      const msg = e.message || '发布失败，请检查流程结构'
      const idxs = []
      for (const m of msg.matchAll(/第 (\d+) 个节点/g)) {
        const i = Number(m[1]) - 1
        if (nodes[i]) idxs.push(i)
      }
      if (idxs.length) {
        flashInvalidKeys(idxs.map((i) => nodes[i].key))
        setSelectedKey(nodes[idxs[0]].key)
        scrollNodeIntoView(nodes[idxs[0]].key)
      }
      toast.error(msg)
    } finally {
      setPublishing(false)
    }
  }

  // ===== 节点操作 =====
  const taskNodes = nodes.filter((n) => n.type !== 'end')

  const addNode = () => {
    let i = nodes.length + 1
    const keys = new Set(nodes.map((n) => n.key))
    while (keys.has(`n${i}`)) i += 1
    const key = `n${i}`
    const endIdx = nodes.findIndex((n) => n.type === 'end')
    const node = { key, name: `处理节点${i}`, type: 'task', group_id: '', fields: [], routes: [{ to: 'end', label: '', when: null }] }
    const next = [...nodes]
    if (endIdx >= 0) next.splice(endIdx, 0, node)
    else next.push(node)
    setNodes(next)
    setSelectedKey(key)
  }

  const removeNode = (key) => {
    if (nodes.filter((n) => n.type !== 'end').length <= 1) { toast.error('至少保留一个处理节点'); return }
    if (key === 'end') { toast.error('结束节点不可删除'); return }
    const next = nodes
      .filter((n) => n.key !== key)
      .map((n) => ({ ...n, routes: (n.routes || []).filter((r) => r.to !== key) }))
    setNodes(next)
    if (selectedKey === key) setSelectedKey(next.find((n) => n.type !== 'end')?.key || '')
    toast.info('已删除节点，指向该节点的流转路由已同步移除')
  }

  const moveNode = (key, dir) => {
    const idx = nodes.findIndex((n) => n.key === key)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= nodes.length) return
    if (nodes[idx].type === 'end' || nodes[target].type === 'end') return
    const next = [...nodes]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setNodes(next)
  }

  const patchNode = (key, patch) => {
    setNodes((ns) => ns.map((n) => (n.key === key ? { ...n, ...patch } : n)))
  }

  // 画布拖拽连线 → 新增路由：源节点已有默认路由时新增条件路由，否则新增默认路由
  const connectRoute = (fromKey, toKey) => {
    const src = nodes.find((n) => n.key === fromKey)
    const to = nodes.find((n) => n.key === toKey)
    if (!src || !to || src.type === 'end') return
    if ((src.routes || []).some((r) => r.to === toKey)) {
      toast.info(`「${src.name || fromKey}」→「${to.name || toKey}」的路由已存在，如需多条件请在右侧编辑现有路由`)
      return
    }
    const hasDefault = (src.routes || []).some((r) => r.when == null)
    const when = hasDefault ? { logic: 'and', conds: [{ field: src.fields?.[0]?.key || '', op: 'eq', value: '' }] } : null
    setNodes((ns) => ns.map((n) => (n.key === fromKey ? { ...n, routes: [...(n.routes || []), { to: toKey, label: '', when }] } : n)))
    setSelectedKey(fromKey)
    toast.success(`已添加路由「${src.name || fromKey} → ${to.name || toKey}」，可在右侧完善条件`)
  }

  const selected = nodes.find((n) => n.key === selectedKey)

  // 回退设置三态（auto/whitelist/disabled）：空数组（=禁止回退）与"白名单模式尚未勾选"
  // 数据上不可区分，用本地 UI 态记录用户选择；仅在切换节点或外部重载数据（版本回滚等）
  // 时按数据重新推导——不监听 rollback_to 本身，否则用户刚选"白名单"（置 []）就被推导
  // 回 disabled，白名单模式永远无法从零进入
  const [rbMode, setRbMode] = useState('auto')
  useEffect(() => {
    const rb = selected?.rollback_to
    setRbMode(rb == null ? 'auto' : Array.isArray(rb) && rb.length > 0 ? 'whitelist' : 'disabled')
  }, [selectedKey, flowDataRev]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 字段操作 =====
  const addField = () => {
    if (!selected) return
    const fields = selected.fields || []
    // key 唯一性按平铺集合（顶层 + 全部扩展字段）处理
    patchNode(selected.key, { fields: [...fields, { key: nextFieldKey(flatFields(fields)), label: '', type: 'text', required: false, options: [], placeholder: '', default: '', alert_field_mapping: '', auto_asset: true, auto_intel: true, auto_agent: false, rules: [] }] })
  }

  const patchField = (fkey, patch) => {
    if (!selected) return
    patchNode(selected.key, { fields: (selected.fields || []).map((f) => (f.key === fkey ? { ...f, ...patch } : f)) })
  }

  const removeField = (fkey) => {
    if (!selected) return
    patchNode(selected.key, { fields: (selected.fields || []).filter((f) => f.key !== fkey) })
  }

  // ===== 匹配规则操作（下拉/开关字段：选中某值后展开扩展字段） =====
  const withRules = (fkey, fn) => {
    if (!selected) return
    const fields = (selected.fields || []).map((f) => (f.key === fkey ? { ...f, rules: fn(f.rules || []) } : f))
    patchNode(selected.key, { fields })
  }

  const addRule = (fkey) => {
    const f = (selected.fields || []).find((x) => x.key === fkey)
    if (!f) return
    const opts = f.type === 'switch' ? ['是', '否'] : (f.options || [])
    const used = new Set((f.rules || []).map((r) => String(r.value ?? '')))
    const value = opts.find((o) => !used.has(String(o))) ?? ''
    withRules(fkey, (rs) => [...rs, { value, fields: [] }])
  }

  const patchRule = (fkey, ri, patch) => withRules(fkey, (rs) => rs.map((r, i) => (i === ri ? { ...r, ...patch } : r)))
  const removeRule = (fkey, ri) => withRules(fkey, (rs) => rs.filter((_, i) => i !== ri))

  const addRuleField = (fkey, ri) => {
    if (!selected) return
    const allKeys = new Set(flatFields(selected.fields).map((x) => x.key))
    let i = allKeys.size + 1
    while (allKeys.has(`f${i}`)) i += 1
    withRules(fkey, (rs) => rs.map((r, i2) => (
      i2 === ri ? { ...r, fields: [...(r.fields || []), { key: `f${i}`, label: '', type: 'text', required: false, options: [], placeholder: '', default: '' }] } : r
    )))
  }

  const patchRuleField = (fkey, ri, fi, patch) => withRules(fkey, (rs) => rs.map((r, i2) => (
    i2 === ri ? { ...r, fields: (r.fields || []).map((rf, i3) => (i3 === fi ? { ...rf, ...patch } : rf)) } : r
  )))

  const removeRuleField = (fkey, ri, fi) => withRules(fkey, (rs) => rs.map((r, i2) => (
    i2 === ri ? { ...r, fields: (r.fields || []).filter((_, i3) => i3 !== fi) } : r
  )))

  // ===== 路由操作 =====
  const addRoute = () => {
    if (!selected) return
    const routes = selected.routes || []
    patchNode(selected.key, { routes: [...routes, { to: 'end', label: '', when: null }] })
  }

  const patchRoute = (idx, patch) => {
    if (!selected) return
    patchNode(selected.key, { routes: (selected.routes || []).map((r, i) => (i === idx ? { ...r, ...patch } : r)) })
  }

  const removeRoute = (idx) => {
    if (!selected) return
    patchNode(selected.key, { routes: (selected.routes || []).filter((_, i) => i !== idx) })
  }

  // 默认路由唯一：勾选新的默认时，旧默认转为条件路由
  const setRouteDefault = (idx, isDefault) => {
    if (!selected) return
    const mkCond = () => ({ logic: 'and', conds: [{ field: selected.fields?.[0]?.key || '', op: 'eq', value: '' }] })
    const routes = (selected.routes || []).map((r, i) => {
      if (i === idx) return { ...r, when: isDefault ? null : (r.when || mkCond()) }
      if (isDefault && r.when === null) {
        return { ...r, when: mkCond() }
      }
      return r
    })
    patchNode(selected.key, { routes })
  }

  // ===== 路由条件操作（when 内部统一 {logic, conds} 结构） =====
  const patchRouteCond = (idx, ci, patch) => {
    if (!selected) return
    const r = (selected.routes || [])[idx]
    if (!r?.when) return
    const when = normWhen(r.when)
    const conds = when.conds.map((c, i) => (i === ci ? { ...c, ...patch } : c))
    patchRoute(idx, { when: { ...when, conds } })
  }

  const addRouteCond = (idx) => {
    if (!selected) return
    const r = (selected.routes || [])[idx]
    const when = normWhen(r?.when)
    patchRoute(idx, { when: { ...when, conds: [...when.conds, { field: selected.fields?.[0]?.key || '', op: 'eq', value: '' }] } })
  }

  const removeRouteCond = (idx, ci) => {
    if (!selected) return
    const r = (selected.routes || [])[idx]
    const when = normWhen(r?.when)
    patchRoute(idx, { when: { ...when, conds: when.conds.filter((_, i) => i !== ci) } })
  }

  // ===== 实时校验（与后端 validate_flow_structure 规则对齐） =====
  // errors：发布会拦截；warnings：不影响发布的提醒。均无问题时不展示
  const validation = useMemo(() => {
    const errors = []
    const warnings = []
    const nodeErrors = {}
    const nodeWarnings = {}
    const addErr = (key, msg) => {
      errors.push(msg)
      if (!nodeErrors[key]) nodeErrors[key] = []
      nodeErrors[key].push(msg)
    }
    const addWarn = (key, msg) => {
      warnings.push(msg)
      if (!nodeWarnings[key]) nodeWarnings[key] = []
      nodeWarnings[key].push(msg)
    }

    if (nodes.length) {
      const keys = new Set()
      nodes.forEach((n) => {
        if (!n.key || !String(n.key).trim()) addErr(n.key, '存在缺少节点标识（key）的节点')
        else if (keys.has(String(n.key))) addErr(n.key, `节点标识 ${n.key} 重复`)
        else keys.add(String(n.key))
      })

      // 全流程平铺字段 key 集合（引用联动字段指向校验用）
      const allFlatKeys = new Set()
      nodes.forEach((n) => flatFields(n.fields || []).forEach((f) => {
        if (f.key) allFlatKeys.add(String(f.key))
      }))

      const firstNonEnd = nodes.find((n) => n.type !== 'end')
      nodes.forEach((n) => {
        if (n.type === 'end') return
        const name = n.name || n.key
        if (!String(n.name || '').trim()) addErr(n.key, `${name}：缺少节点名称`)
        // 节点类型：task=普通处理 / parallel=并行会签（旧数据缺省 task）
        if (n.type && !['task', 'parallel'].includes(n.type)) {
          addErr(n.key, `${name}：节点类型 ${n.type} 不合法`)
        }
        if (n === firstNonEnd && n.type === 'parallel') {
          addErr(n.key, `${name}：首个处理节点（发起节点）不支持并行会签`)
        }
        if (n.type === 'parallel') {
          // 并行会签：多分组校验
          const sgs = n.sign_groups || []
          if (!sgs.length) {
            addErr(n.key, `${name}：并行会签节点需配置至少一个会签分组`)
          } else {
            if (new Set(sgs).size !== sgs.length) addErr(n.key, `${name}：会签分组存在重复`)
            if (groups.length) {
              sgs.forEach((gid) => {
                const g = groups.find((x) => x.id === gid)
                if (!g) addErr(n.key, `${name}：会签分组（ID=${gid}）不存在`)
                else if (!g.enabled) addErr(n.key, `${name}：会签分组「${g.name}」已停用`)
              })
            }
          }
          if (n.finish_policy && !['all', 'any'].includes(n.finish_policy)) {
            addErr(n.key, `${name}：会签完成策略不合法`)
          }
        } else if (n.group_id == null || n.group_id === '') {
          addErr(n.key, `${name}：未绑定处理分组`)
        } else if (groups.length) {
          const g = groups.find((x) => x.id === n.group_id)
          if (!g) addErr(n.key, `${name}：处理分组不存在（ID=${n.group_id}）`)
          else if (!g.enabled) addErr(n.key, `${name}：处理分组「${g.name}」已停用`)
        }
        // 回退白名单：存在时逐项校验（指向已删节点/自身/结束节点均报错）
        if (Array.isArray(n.rollback_to)) {
          n.rollback_to.forEach((tk) => {
            if (tk === n.key) addErr(n.key, `${name}：回退白名单不能包含自身`)
            else if (!keys.has(String(tk))) addErr(n.key, `${name}：回退白名单指向的节点 ${tk} 不存在`)
            else if (nodes.find((x) => x.key === tk)?.type === 'end') addErr(n.key, `${name}：回退白名单不能指向结束节点`)
          })
        }
        if (n.remind_interval_minutes != null && n.remind_interval_minutes !== ''
          && (n.timeout_minutes == null || n.timeout_minutes === '')) {
          addErr(n.key, `${name}：配置了重复提醒间隔但未配置超时提醒分钟数`)
        }

        // 字段 + 匹配规则扩展字段（key 唯一性按顶层 + 扩展平铺集合）
        const fkeys = new Set()
        const checkField = (f, isRuleField) => {
          const flabel = f.label || f.key
          const fpos = isRuleField ? '扩展字段' : '字段'
          if (!f.key || !String(f.key).trim()) {
            addErr(n.key, `${name}：存在缺少标识（key）的${fpos}`)
          } else if (fkeys.has(String(f.key))) {
            addErr(n.key, `${name}：${fpos}标识 ${f.key} 与节点内其他字段重复`)
          } else {
            fkeys.add(String(f.key))
          }
          if (!String(f.label || '').trim()) addErr(n.key, `${name}：${fpos} ${f.key || '（未命名）'} 缺少显示名（label）`)
          if (f.type === 'select' && !(f.options || []).length) addErr(n.key, `${name}：${fpos} ${flabel} 为下拉选择但未配置选项`)
          // 引用联动：被引用字段须已配置、不引用自身、指向存在的字段（与后端一致）
          if (f.type === 'reference') {
            const rfs = f.ref_fields || []
            if (!rfs.length) {
              addErr(n.key, `${name}：${fpos} ${flabel} 为引用联动但未配置被引用字段`)
            } else {
              rfs.forEach((rk) => {
                if (rk === f.key) addErr(n.key, `${name}：${fpos} ${flabel} 不能引用自身`)
                else if (!allFlatKeys.has(String(rk))) addErr(n.key, `${name}：${fpos} ${flabel} 引用的字段 ${rk} 不存在`)
              })
            }
          }
          return flabel
        }
        ;(n.fields || []).forEach((f) => {
          const flabel = checkField(f, false)
          const rules = f.rules || []
          if (!rules.length) return
          if (!['select', 'switch'].includes(f.type)) {
            addErr(n.key, `${name}：字段 ${flabel} 仅下拉选择/是否开关类型支持匹配规则`)
            return
          }
          const allowed = f.type === 'switch' ? ['是', '否'] : (f.options || []).map(String)
          const seen = new Set()
          rules.forEach((rule, ri) => {
            const rv = rule.value
            if (rv == null || String(rv).trim() === '') {
              addErr(n.key, `${name}：字段 ${flabel} 第 ${ri + 1} 条匹配规则缺少匹配值`)
              return
            }
            if (seen.has(String(rv))) addErr(n.key, `${name}：字段 ${flabel} 匹配规则值 ${rv} 重复`)
            seen.add(String(rv))
            if (allowed.length && !allowed.includes(String(rv))) addErr(n.key, `${name}：字段 ${flabel} 匹配规则值 ${rv} 必须是字段可选项之一`)
            ;(rule.fields || []).forEach((rf) => checkField(rf, true))
          })
        })

        // 路由
        const routes = n.routes || []
        if (!routes.length) {
          addErr(n.key, `${name}：至少需要一条流转路由`)
        } else {
          const ftypes = {}
          ;(n.fields || []).forEach((f) => {
            ftypes[f.key] = f.type
            ;(f.rules || []).forEach((rule) => (rule.fields || []).forEach((rf) => { ftypes[rf.key] = rf.type }))
          })
          let hasDefault = false
          routes.forEach((r) => {
            if (!r.to) {
              addErr(n.key, `${name}：存在未选择去向节点的路由`)
              return
            }
            if (!keys.has(String(r.to))) addErr(n.key, `${name}：流转去向「${r.to}」的节点不存在`)
            if (r.when == null) {
              if (hasDefault) addErr(n.key, `${name}：存在多条默认路由`)
              hasDefault = true
              return
            }
            const { conds } = normWhen(r.when)
            if (!conds.length) {
              addErr(n.key, `${name}：条件路由缺少判断条件`)
              return
            }
            conds.forEach((c) => {
              if (!c.field) {
                addErr(n.key, `${name}：条件路由存在未选择判断字段的条件`)
              } else if (!fkeys.has(String(c.field))) {
                addErr(n.key, `${name}：条件路由的判断字段 ${c.field} 不在节点字段中`)
              } else if (!isCondOp(c.op || 'eq')) {
                addErr(n.key, `${name}：判断字段 ${c.field} 的操作符 ${c.op} 不合法`)
              } else if ((c.op === 'gt' || c.op === 'lt') && !['number', 'datetime'].includes(ftypes[c.field])) {
                addErr(n.key, `${name}：判断字段 ${c.field} 需为数字或日期时间类型才能使用大于/小于`)
              } else if (String(c.value ?? '').trim() === '') {
                addWarn(n.key, `${name}：条件（${c.field} → ${r.to}）未填写判断值，该条件不会命中`)
              }
            })
          })
          if (!hasDefault) addWarn(n.key, `${name}：未配置无条件默认路由，条件都不满足时按首条路由流转`)
        }

        // 节点动作 · 封禁同步（与后端校验一致：字段指向与取值均须有效）
        const bs = n.ban_sync
        if (bs && typeof bs === 'object' && Object.keys(bs).length) {
          const flat = flatFields(n.fields || [])
          const byKey = Object.fromEntries(flat.map((x) => [x.key, x]))
          const sw = byKey[bs.switch_field]
          if (!bs.switch_field || !sw) {
            addErr(n.key, `${name}：封禁同步未配置触发字段，或触发字段不在本节点字段中`)
          } else if (!['select', 'switch'].includes(sw.type)) {
            addErr(n.key, `${name}：封禁同步触发字段 ${bs.switch_field} 需为下拉选择/是否开关类型`)
          } else {
            const allowed = sw.type === 'switch' ? ['是', '否'] : (sw.options || []).map(String)
            const swv = bs.switch_value ?? '是'
            if (!allowed.includes(String(swv))) addErr(n.key, `${name}：封禁同步触发值 ${swv} 必须是字段 ${bs.switch_field} 的可选项之一`)
          }
          if (!bs.ip_field || !byKey[bs.ip_field]) {
            addErr(n.key, `${name}：封禁同步未配置封禁 IP 字段，或该字段不在本节点字段中`)
          }
          const dur = byKey[bs.duration_field]
          if (!bs.duration_field || !dur) {
            addErr(n.key, `${name}：封禁同步未配置封禁时长字段，或该字段不在本节点字段中`)
          } else if (dur.type !== 'duration') {
            addErr(n.key, `${name}：封禁同步时长字段 ${bs.duration_field} 需为时长类型`)
          }
          if (bs.device_field && !byKey[bs.device_field]) {
            addErr(n.key, `${name}：封禁同步设备字段 ${bs.device_field} 不在本节点字段中`)
          }
          if (nodes.find((x) => x.type !== 'end')?.key === n.key) {
            addWarn(n.key, `${name}：发起节点（首处理节点）提交不走流转，封禁同步不会触发`)
          }
        }
      })
    }

    // 发起分组（发布必填；分组存在性待 groups 加载后校验，避免加载期误报）
    if (!startGroups.length) {
      errors.push('未配置可发起工单的分组')
    } else if (groups.length) {
      startGroups.forEach((gid) => {
        const g = groups.find((x) => x.id === gid)
        if (!g) errors.push(`发起分组（ID=${gid}）不存在`)
        else if (!g.enabled) errors.push(`发起分组「${g.name}」已停用`)
      })
    }

    return { errors, warnings, nodeErrors, nodeWarnings }
  }, [nodes, startGroups, groups])

  // 存在问题的节点 key（错误优先，其次提醒）：顶部摘要点击跳转用
  const issueKeys = useMemo(
    () => {
      const err = nodes.filter((n) => (validation.nodeErrors[n.key] || []).length).map((n) => n.key)
      if (err.length) return err
      return nodes.filter((n) => (validation.nodeWarnings[n.key] || []).length).map((n) => n.key)
    },
    [nodes, validation],
  )

  // 全流程平铺字段（引用联动字段的被引用字段候选；附节点名便于区分同名字段）
  const allFlatFields = useMemo(
    () => nodes.flatMap((n) => flatFields(n.fields || []).map((f) => ({ ...f, _node: n.name || n.key }))),
    [nodes],
  )

  // 跳转到第一个问题节点：选中 + 滚动 + 红框闪烁定位
  const jumpToIssue = () => {
    const first = issueKeys[0]
    if (!first) return
    setSelectedKey(first)
    if (validation.errors.length) {
      flashInvalidKeys(issueKeys)
    }
    scrollNodeIntoView(first)
  }

  const groupName = (gid) => groups.find((g) => g.id === gid)?.name

  if (loading) {
    return (
      <PageContainer>
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">加载中...</div>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      {/* 顶部两行：行1 基础信息 + 操作；行2 发起分组 / 抄送 配置条（chips 超量折叠，防多选刷屏换行） */}
      <div className="mb-4 rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 px-6 py-4">
          <button onClick={() => navigate('/ticket-config/flows')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />返回
          </button>
          <div className="h-6 w-px bg-border" />
          <input
            className={`${inputBaseCls} h-9 w-56 font-semibold`}
            placeholder="流程模板名称"
            value={meta.name}
            disabled={!canEdit}
            onChange={(e) => setMeta({ ...meta, name: e.target.value })}
          />
          <input
            className={`${inputBaseCls} h-9 min-w-40 flex-1`}
            placeholder="模板描述（选填）"
            value={meta.description}
            disabled={!canEdit}
            onChange={(e) => setMeta({ ...meta, description: e.target.value })}
          />
          <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
            <button type="button" onClick={() => setViewMode('list')} title="列表模式：按顺序编辑节点"
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition ${viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              <List className="h-3.5 w-3.5" />列表
            </button>
            <button type="button" onClick={() => setViewMode('canvas')} title="画布模式：查看流程拓扑，点击节点编辑"
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition ${viewMode === 'canvas' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              <GitGraph className="h-3.5 w-3.5" />画布
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {nodes.length > 0 && (validation.errors.length > 0 ? (
              <button type="button" onClick={jumpToIssue} title="点击定位到第一个问题节点"
                className="flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20">
                <AlertTriangle className="h-3.5 w-3.5" />{validation.errors.length} 处校验错误
              </button>
            ) : validation.warnings.length > 0 ? (
              <button type="button" onClick={jumpToIssue} title="点击定位到第一个提醒节点"
                className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 transition hover:bg-amber-500/20 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />{validation.warnings.length} 处提醒
              </button>
            ) : (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <CheckCircle2 className="h-3.5 w-3.5" />校验通过
              </span>
            ))}
            {dirty && (
              <span className="flex items-center gap-1 text-xs text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />未保存
              </span>
            )}
            {!isNew && (
              <Button variant="secondary" size="sm" onClick={() => setVersionsOpen(true)} title="发布存档、差异对比与回滚">
                <History className="mr-1 h-3.5 w-3.5" />版本
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={handlePublish} disabled={!canEdit || publishing || isNew}>
              <Rocket className="mr-1 h-3.5 w-3.5" />{publishing ? '发布中' : '保存并发布'}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!canEdit || saving}>
              <Save className="mr-1 h-3.5 w-3.5" />{saving ? '保存中' : '保存'}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-border px-6 py-3">
          {/* 发起分组：授权勾选分组（谁能开单）；与节点「处理分组」（谁干活）区分 */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
              <Flag className="h-3.5 w-3.5" />发起分组
              <InfoTip text="授权勾选分组内的成员可在工单中心使用本流程发起工单（管理员始终可发起）。发布前需至少选择一个分组。各环节由谁处理请在下方节点的「处理分组」中配置，与这里无关。" />
            </span>
            <CcChips
              targets={startGroupTargets}
              max={6}
              emptyText="发布前需至少选择一个分组"
              onRemove={canEdit ? (t) => setStartGroups((s) => s.filter((x) => x !== t.id)) : undefined}
            />
            {canEdit && (
              <button
                type="button"
                onClick={() => setStartPickerOpen(true)}
                className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:text-primary"
              >
                <Plus className="h-3 w-3" />选择分组
              </button>
            )}
          </div>
          {/* 模板级固定抄送：该模板发起的所有工单自动抄送给这些对象（人员/分组）；工单中可手动追加或移除 */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
              <UsersRound className="h-3.5 w-3.5" />抄送
              <InfoTip text="配置该模板发起工单时的固定抄送对象（人员或分组，组内全员均收到抄送）。发起时自动生效，发起人、当前处理人、管理员也可在工单详情中手动追加或移除抄送对象。" />
            </span>
            <CcChips
              targets={ccTargets}
              max={6}
              emptyText="未配置，发起的工单不固定抄送"
              onRemove={canEdit ? (t) => setCcTargets((s) => s.filter((x) => ccKey(x) !== ccKey(t))) : undefined}
            />
            {canEdit && (
              <button
                type="button"
                onClick={() => setCcPickerOpen(true)}
                className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary/60 hover:text-primary"
              >
                <Plus className="h-3 w-3" />添加抄送
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        {/* 左栏：节点列表（列表模式显示；画布模式替换为拓扑画布） */}
        {viewMode === 'list' && (
        <div className="w-72 shrink-0 rounded-md border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-foreground">流程节点（{nodes.length}）</span>
            {canEdit && (
              <button onClick={addNode} className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">
                <Plus className="h-3.5 w-3.5" />新增节点
              </button>
            )}
          </div>
          <div className="space-y-1">
            {nodes.map((n, idx) => {
              const active = n.key === selectedKey
              const nErrs = validation.nodeErrors[n.key] || []
              const nWarns = validation.nodeWarnings[n.key] || []
              const invalid = invalidKeys.includes(n.key) || nErrs.length > 0
              const warn = !invalid && nWarns.length > 0
              return (
                <div key={n.key} data-nodekey={n.key} className="group relative">
                  <button
                    onClick={() => setSelectedKey(n.key)}
                    title={nErrs.length ? `校验错误：\n${nErrs.join('\n')}` : nWarns.length ? `提醒：\n${nWarns.join('\n')}` : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition ${invalid ? 'border-destructive bg-destructive/5' : warn ? 'border-amber-500/60 bg-amber-500/5' : active ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'}`}
                  >
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${n.type === 'end' ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary'}`}>
                      {n.type === 'end' ? '✓' : idx + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">{n.name || n.key}</span>
                        {n.type === 'parallel' && (
                          <span className="shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] font-medium text-violet-500">会签</span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {n.type === 'end' ? '结束节点'
                          : n.type === 'parallel' ? `${(n.sign_groups || []).map((gid) => groupName(gid)).filter(Boolean).join('、') || '未绑定分组'} · 会签`
                          : `${groupName(n.group_id) || '未绑定分组'} · ${(n.fields || []).length} 字段`}
                      </span>
                    </span>
                    {(invalid || warn) && (
                      <span className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white ${invalid ? 'bg-destructive' : 'bg-amber-500'}`}>
                        {invalid ? (nErrs.length || '!') : nWarns.length}
                      </span>
                    )}
                    {active && <ChevronRight className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                  {canEdit && n.type !== 'end' && (
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 hover:opacity-100" style={{ opacity: active ? 1 : undefined }}>
                      <button onClick={() => moveNode(n.key, -1)} disabled={idx === 0} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" title="上移">
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button onClick={() => moveNode(n.key, 1)} disabled={nodes[idx + 1]?.type === 'end'} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" title="下移">
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button onClick={() => removeNode(n.key)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="删除节点">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        )}

        {viewMode === 'canvas' && (
          <div className="relative h-[calc(100vh-330px)] min-h-[460px] min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
            <TicketFlowCanvas
              flowNodes={nodes}
              validation={validation}
              selectedKey={selectedKey}
              groups={groups}
              canEdit={canEdit}
              onSelect={setSelectedKey}
              onConnectRoute={connectRoute}
            />
            {canEdit && (
              <button onClick={addNode} className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-primary shadow-md transition hover:bg-primary/10">
                <Plus className="h-3.5 w-3.5" />新增节点
              </button>
            )}
            <span className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md border border-border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
              拖动节点整理布局（不保存）· 从节点右侧圆点拖线创建路由 · 点击节点在右侧编辑
            </span>
          </div>
        )}

        {/* 右栏：节点编辑（画布模式下作为属性面板，固定宽度内部滚动） */}
        <div className={viewMode === 'canvas' ? 'h-[calc(100vh-330px)] min-h-[460px] w-[620px] shrink-0 overflow-y-auto rounded-md border border-border bg-card' : 'min-w-0 flex-1 rounded-md border border-border bg-card'}>
          {!selected ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              {viewMode === 'canvas' ? '点击画布中的节点，在此编辑其属性' : '请选择左侧节点进行编辑'}
            </div>
          ) : (
            <div className="p-6">
              {/* 本节点实时校验结果（错误红 / 提醒黄） */}
              {(() => {
                const nErrs = validation.nodeErrors[selected.key] || []
                const nWarns = validation.nodeWarnings[selected.key] || []
                if (!nErrs.length && !nWarns.length) return null
                return (
                  <div className="mb-5 space-y-2">
                    {nErrs.length > 0 && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                          <AlertTriangle className="h-3.5 w-3.5" />本节点存在 {nErrs.length} 处校验错误（发布时会被拦截）
                        </div>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-destructive/90">
                          {nErrs.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    )}
                    {nWarns.length > 0 && (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3.5 w-3.5" />本节点 {nWarns.length} 处提醒（不影响发布）
                        </div>
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-amber-600/90 dark:text-amber-400/90">
                          {nWarns.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              })()}
              {/* 基础信息 */}
              <div className="mb-6">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />节点基础信息
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelCls}>节点名称<span className="text-red-500">*</span></label>
                    <input className={inputCls} value={selected.name || ''} disabled={!canEdit || selected.type === 'end'}
                      onChange={(e) => patchNode(selected.key, { name: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>节点标识（key）</label>
                    <input className={`${inputCls} font-mono`} value={selected.key} disabled
                      title="节点标识在流程内唯一且不可修改（已发起工单的快照依赖该标识）" />
                  </div>
                  <div>
                    <label className={labelCls}>节点类型</label>
                    <CompactSelect size="lg" block disabled={!canEdit || selected.type === 'end' || selected.key === nodes.find((x) => x.type !== 'end')?.key}
                      value={selected.type === 'parallel' ? 'parallel' : 'task'}
                      onChange={(e) => {
                        if (e.target.value === 'parallel') {
                          patchNode(selected.key, { type: 'parallel', group_id: '', sign_groups: [], finish_policy: 'all' })
                        } else {
                          patchNode(selected.key, { type: 'task', sign_groups: undefined, finish_policy: undefined })
                        }
                      }}>
                      <option value="task">处理节点（单分组）</option>
                      <option value="parallel">并行会签（多分组）</option>
                    </CompactSelect>
                    {selected.type === 'end' && <p className={hintCls}>结束节点无需绑定分组</p>}
                    {selected.type !== 'end' && selected.key === nodes.find((x) => x.type !== 'end')?.key && (
                      <p className={hintCls}>首个处理节点（发起节点）不支持切换为会签</p>
                    )}
                  </div>
                </div>
                {selected.type !== 'end' && (
                  <div className="mt-4">
                    {selected.type === 'parallel' ? (
                      <>
                        <label className={labelCls}>会签分组<span className="text-red-500">*</span>
                          <span className="ml-2 font-normal text-muted-foreground">勾选多个分组并行处理</span>
                        </label>
                        <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-3">
                          {groups.filter((g) => g.enabled).map((g) => {
                            const sgs = selected.sign_groups || []
                            const checked = sgs.includes(g.id)
                            return (
                              <label key={g.id} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-muted ${checked ? 'bg-primary/10 text-primary' : 'text-foreground'}`}>
                                <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                  checked={checked}
                                  onChange={(e) => patchNode(selected.key, {
                                    sign_groups: e.target.checked ? [...sgs, g.id] : sgs.filter((x) => x !== g.id),
                                  })} />
                                <span className="min-w-0 truncate">{g.name}（{g.member_count || 0} 人）</span>
                              </label>
                            )
                          })}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-4">
                          <div>
                            <label className={labelCls}>会签完成策略</label>
                            <CompactSelect size="lg" block disabled={!canEdit}
                              value={selected.finish_policy || 'all'}
                              onChange={(e) => patchNode(selected.key, { finish_policy: e.target.value })}>
                              <option value="all">全部会签完成才流转</option>
                              <option value="any">任一分组提交即流转</option>
                            </CompactSelect>
                          </div>
                          <div>
                            <label className={labelCls}>会签说明</label>
                            <p className={`${hintCls} pt-2`}>工单到达本节点后全部会签分组同时可见并独立提交；全部完成（或按策略）后流转下一节点</p>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div>
                        <label className={labelCls}>处理分组<span className="text-red-500">*</span></label>
                        <CompactSelect size="lg" block disabled={!canEdit}
                          value={selected.group_id || ''}
                          onChange={(e) => patchNode(selected.key, { group_id: e.target.value ? Number(e.target.value) : '' })}>
                          <option value="">请选择分组</option>
                          {groups.filter((g) => g.enabled).map((g) => (
                            <option key={g.id} value={g.id}>{g.name}（{g.member_count || 0} 人）</option>
                          ))}
                        </CompactSelect>
                      </div>
                    )}
                  </div>
                )}
                {selected.type !== 'end' && (
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>超时提醒（分钟）</label>
                      <input type="number" min="1" className={inputCls} disabled={!canEdit}
                        placeholder="留空 = 不提醒"
                        value={selected.timeout_minutes ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          patchNode(selected.key, { timeout_minutes: v === '' ? null : (Number(v) >= 1 ? Math.floor(Number(v)) : '') })
                        }} />
                      <p className={hintCls}>工单停留本节点超过该时长后，通过通知中心提醒处理分组</p>
                    </div>
                    <div>
                      <label className={labelCls}>重复提醒间隔（分钟）</label>
                      <input type="number" min="0" className={inputCls} disabled={!canEdit}
                        placeholder="留空或 0 = 仅提醒一次"
                        value={selected.remind_interval_minutes ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          patchNode(selected.key, { remind_interval_minutes: v === '' ? null : (Number(v) >= 0 ? Math.floor(Number(v)) : '') })
                        }} />
                      <p className={hintCls}>超时未处理时按该间隔重复提醒，直到工单流转离开本节点</p>
                    </div>
                  </div>
                )}
                {/* 回退设置：默认退回上一处理节点；白名单限制可退目标；空数组禁止回退 */}
                {selected.type !== 'end' && (
                  <div className="mt-4 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className={`${labelCls} mb-0`}>回退设置</label>
                      <CompactSelect size="sm" disabled={!canEdit} className="w-44"
                        value={rbMode}
                        onChange={(e) => {
                          const v = e.target.value
                          setRbMode(v)
                          if (v === 'auto') patchNode(selected.key, { rollback_to: undefined })
                          else if (!Array.isArray(selected.rollback_to)) patchNode(selected.key, { rollback_to: [] })
                        }}>
                        <option value="auto">自动（退回上一处理节点）</option>
                        <option value="whitelist">白名单（限制可退目标）</option>
                        <option value="disabled">禁止回退</option>
                      </CompactSelect>
                      <span className={hintCls}>
                        {rbMode === 'auto' ? '未配置时默认退回上一处理节点'
                          : rbMode === 'disabled' ? '本节点不允许回退'
                          : '仅允许退回勾选的节点（防越级/误退发起节点）；未勾选等同禁止回退'}
                      </span>
                    </div>
                    {rbMode !== 'auto' && (
                      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
                        {rbMode === 'whitelist' && nodes.filter((x) => x.type !== 'end' && x.key !== selected.key).map((x) => {
                          const rbs = selected.rollback_to || []
                          const checked = rbs.includes(x.key)
                          return (
                            <label key={x.key} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-muted ${checked ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                              <input type="checkbox" className="h-4 w-4 accent-amber-500" disabled={!canEdit}
                                checked={checked}
                                onChange={(e) => patchNode(selected.key, {
                                  rollback_to: e.target.checked ? [...rbs, x.key] : rbs.filter((k) => k !== x.key),
                                })} />
                              <span className="min-w-0 truncate" title={x.key}>{x.name || x.key}</span>
                            </label>
                          )
                        })}
                        {rbMode === 'whitelist' && !nodes.some((x) => x.type !== 'end' && x.key !== selected.key) && (
                          <p className={hintCls}>流程中没有其他可回退的处理节点</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {selected.type !== 'end' && (
                <>
                  {/* 字段定义 */}
                  <div className="mb-6">
                    <div className="mb-3 flex items-center justify-between border-t border-border pt-5">
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <GripVertical className="h-4 w-4 text-muted-foreground" />节点字段（{(selected.fields || []).length}）
                      </div>
                      {canEdit && (
                        <Button size="sm" variant="secondary" onClick={addField}>
                          <Plus className="mr-1 h-3.5 w-3.5" />添加字段
                        </Button>
                      )}
                    </div>
                    {!(selected.fields || []).length ? (
                      <div className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                        暂无字段，点击「添加字段」自定义该节点需填写的内容
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {(selected.fields || []).map((f) => (
                          <div key={f.key} className="rounded-md border border-border p-4">
                            <div className="grid grid-cols-4 gap-3">
                              <div>
                                <label className={labelCls}>显示名<span className="text-red-500">*</span></label>
                                <input className={inputCls} placeholder="如：源IP地址" disabled={!canEdit}
                                  value={f.label || ''} onChange={(e) => patchField(f.key, { label: e.target.value })} />
                              </div>
                              <div>
                                <label className={labelCls}>标识（key）</label>
                                <input className={`${inputCls} font-mono`} disabled={!canEdit}
                                  value={f.key} onChange={(e) => patchField(f.key, { key: e.target.value.trim() })} />
                              </div>
                              <div>
                                <label className={labelCls}>类型</label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={f.type || 'text'}
                                  onChange={(e) => patchField(f.key, { type: e.target.value })}>
                                  {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </CompactSelect>
                              </div>
                              <div className="flex items-end justify-between gap-2">
                                <label className="flex cursor-pointer items-center gap-2 pb-2">
                                  <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                    checked={!!f.required} onChange={(e) => patchField(f.key, { required: e.target.checked })} />
                                  <span className="text-sm text-foreground">必填</span>
                                </label>
                                {canEdit && (
                                  <button onClick={() => removeField(f.key)}
                                    className="mb-1 flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                                    <Trash2 className="h-3.5 w-3.5" />删除
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="mt-3 grid grid-cols-4 gap-3">
                              {f.type === 'select' && (
                                <div className="col-span-2">
                                  <label className={labelCls}>下拉选项（每行一个）</label>
                                  <FieldOptionsInput
                                    value={f.options || []}
                                    disabled={!canEdit}
                                    onCommit={(opts) => patchField(f.key, { options: opts })}
                                  />
                                </div>
                              )}
                              {f.type === 'switch' && (
                                <div>
                                  <label className={labelCls}>取值方式</label>
                                  <input className={inputCls} value="是 / 否" disabled />
                                </div>
                              )}
                              {f.type === 'duration' && (
                                <div>
                                  <label className={labelCls}>取值方式</label>
                                  <input className={inputCls} value="数值 + 单位（分钟/小时/天）或永久" disabled />
                                </div>
                              )}
                              {f.type === 'ip' && (
                                <>
                                  <div>
                                    <label className={labelCls}>资产匹配</label>
                                    <label className="flex cursor-pointer items-center gap-2 py-[7px]"
                                      title="发起工单时自动在资产库中匹配该 IP（与告警「关联资产」同一套口径）；仅标识（key）或告警字段映射为 src_ip / dst_ip 的字段生效，默认开启">
                                      <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                        checked={(f.auto_asset ?? (f.auto_enrich !== false)) !== false}
                                        onChange={(e) => patchField(f.key, { auto_asset: e.target.checked })} />
                                      <span className="text-sm text-foreground">资产库匹配</span>
                                    </label>
                                  </div>
                                  <div>
                                    <label className={labelCls}>威胁情报</label>
                                    <label className="flex cursor-pointer items-center gap-2 py-[7px]"
                                      title="发起工单时自动查询该 IP 的威胁情报；仅标识（key）或告警字段映射为 src_ip / dst_ip 的字段生效，默认开启">
                                      <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                        checked={(f.auto_intel ?? (f.auto_enrich !== false)) !== false}
                                        onChange={(e) => patchField(f.key, { auto_intel: e.target.checked })} />
                                      <span className="text-sm text-foreground">威胁情报查询</span>
                                    </label>
                                  </div>
                                  <div>
                                    <label className={labelCls}>智能体研判</label>
                                    <label className="flex cursor-pointer items-center gap-2 py-[7px]"
                                      title="发起工单时调用「IP风险智能研判与封禁决策」智能体研判该 IP，安全上下文仅展示风险等级、处置建议与决策依据；仅标识（key）或告警字段映射为 src_ip / dst_ip 的字段生效，默认关闭，需配置 BAN_ANALYST_AGENT_ID">
                                      <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                        checked={f.auto_agent === true}
                                        onChange={(e) => patchField(f.key, { auto_agent: e.target.checked })} />
                                      <span className="text-sm text-foreground">IP 风险智能研判</span>
                                    </label>
                                  </div>
                                </>
                              )}
                              {f.type === 'reference' && (
                                <div className="col-span-4">
                                  <label className={labelCls}>被引用字段<span className="text-red-500">*</span></label>
                                  <RefFieldsPicker
                                    value={f.ref_fields || []}
                                    disabled={!canEdit}
                                    excludeKey={f.key}
                                    allFields={allFlatFields}
                                    onChange={(rfs) => patchField(f.key, { ref_fields: rfs })}
                                  />
                                  <div className="mt-2 flex flex-wrap items-center gap-4">
                                    <label className="flex cursor-pointer items-center gap-2"
                                      title="开启后处理人可手动填写选项之外的值；关闭则只能从已填过的值中选择">
                                      <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                        checked={f.allow_custom === true} onChange={(e) => patchField(f.key, { allow_custom: e.target.checked })} />
                                      <span className="text-sm text-foreground">允许填写选项之外的值</span>
                                    </label>
                                    <p className={hintCls}>选项 = 本工单内被引用字段已填写过的值，有新值后选项自动更新</p>
                                  </div>
                                </div>
                              )}
                              <div>
                                <label className={labelCls}>占位提示</label>
                                <input className={inputCls} disabled={!canEdit} placeholder="选填"
                                  value={f.placeholder || ''} onChange={(e) => patchField(f.key, { placeholder: e.target.value })} />
                              </div>
                              {!['select', 'switch', 'file', 'reference', 'duration'].includes(f.type) && (
                                <div>
                                  <label className={labelCls}>默认值</label>
                                  <input className={inputCls} disabled={!canEdit}
                                    value={f.default || ''} onChange={(e) => patchField(f.key, { default: e.target.value })} />
                                </div>
                              )}
                              <div>
                                <label className={labelCls}>告警字段映射</label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={f.alert_field_mapping || ''}
                                  onChange={(e) => patchField(f.key, { alert_field_mapping: e.target.value })}
                                  title="告警一键发起工单时，自动预填该告警字段">
                                  {ALERT_FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </CompactSelect>
                              </div>
                            </div>
                            {['select', 'switch'].includes(f.type) && (
                              <div className="mt-3 rounded bg-muted p-3">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium text-muted-foreground">匹配规则：选项命中后展开扩展字段（如「是否已封堵」选「是」时展开封堵信息）</span>
                                  {canEdit && (
                                    <button onClick={() => addRule(f.key)}
                                      disabled={f.type === 'select' && !(f.options || []).length}
                                      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50">
                                      <Plus className="h-3.5 w-3.5" />添加规则
                                    </button>
                                  )}
                                </div>
                                {f.type === 'select' && !(f.options || []).length && (
                                  <p className={hintCls}>请先在上方配置下拉选项，再添加匹配规则</p>
                                )}
                                <div className="space-y-2">
                                  {(f.rules || []).map((rule, ri) => {
                                    const ropts = f.type === 'switch' ? ['是', '否'] : (f.options || [])
                                    const valueOk = ropts.includes(String(rule.value ?? ''))
                                    return (
                                      <div key={ri} className="rounded border border-border bg-background p-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="shrink-0 text-xs font-medium text-muted-foreground">当选择</span>
                                          <div className="w-40">
                                            <CompactSelect size="lg" block disabled={!canEdit} value={rule.value ?? ''}
                                              onChange={(e) => patchRule(f.key, ri, { value: e.target.value })}>
                                              <option value="">请选择选项</option>
                                              {ropts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                                              {rule.value !== '' && rule.value != null && !valueOk && (
                                                <option value={rule.value}>{rule.value}（已失效）</option>
                                              )}
                                            </CompactSelect>
                                          </div>
                                          <span className="shrink-0 text-xs font-medium text-muted-foreground">时，展开以下扩展字段</span>
                                          {canEdit && (
                                            <button onClick={() => removeRule(f.key, ri)}
                                              className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                                              <Trash2 className="h-3.5 w-3.5" />删除规则
                                            </button>
                                          )}
                                        </div>
                                        <div className="mt-3 space-y-2">
                                          {(rule.fields || []).map((rf, fi) => (
                                            <div key={fi} className="rounded bg-secondary p-2.5">
                                              <div className="grid grid-cols-12 gap-2">
                                                <div className="col-span-3">
                                                  <label className={labelCls}>显示名<span className="text-red-500">*</span></label>
                                                  <input className={inputCls} placeholder="如：封堵时间" disabled={!canEdit}
                                                    value={rf.label || ''} onChange={(e) => patchRuleField(f.key, ri, fi, { label: e.target.value })} />
                                                </div>
                                                <div className="col-span-2">
                                                  <label className={labelCls}>标识（key）</label>
                                                  <input className={`${inputCls} font-mono`} disabled={!canEdit}
                                                    value={rf.key} onChange={(e) => patchRuleField(f.key, ri, fi, { key: e.target.value.trim() })} />
                                                </div>
                                                <div className="col-span-2">
                                                  <label className={labelCls}>类型</label>
                                                  <CompactSelect size="lg" block disabled={!canEdit} value={rf.type || 'text'}
                                                    onChange={(e) => patchRuleField(f.key, ri, fi, { type: e.target.value })}>
                                                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                                  </CompactSelect>
                                                </div>
                                                <div className={['select', 'switch', 'file', 'reference', 'duration'].includes(rf.type) ? 'col-span-4' : 'col-span-2'}>
                                                  <label className={labelCls}>占位提示</label>
                                                  <input className={inputCls} disabled={!canEdit} placeholder="选填"
                                                    value={rf.placeholder || ''} onChange={(e) => patchRuleField(f.key, ri, fi, { placeholder: e.target.value })} />
                                                </div>
                                                {!['select', 'switch', 'file', 'reference', 'duration'].includes(rf.type) && (
                                                  <div className="col-span-2">
                                                    <label className={labelCls}>默认值</label>
                                                    <input className={inputCls} disabled={!canEdit}
                                                      value={rf.default || ''} onChange={(e) => patchRuleField(f.key, ri, fi, { default: e.target.value })} />
                                                  </div>
                                                )}
                                                <div className="col-span-1 flex items-end justify-between">
                                                  <label className="flex cursor-pointer items-center gap-1 pb-2" title="选项命中展开后必填">
                                                    <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                                      checked={!!rf.required} onChange={(e) => patchRuleField(f.key, ri, fi, { required: e.target.checked })} />
                                                    <span className="text-sm text-foreground">必填</span>
                                                  </label>
                                                  {canEdit && (
                                                    <button onClick={() => removeRuleField(f.key, ri, fi)}
                                                      className="mb-1 rounded p-1 text-destructive hover:bg-destructive/10" title="删除扩展字段">
                                                      <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                  )}
                                                </div>
                                              </div>
                                              {rf.type === 'select' && (
                                                <div className="mt-2">
                                                  <label className={labelCls}>下拉选项（每行一个）</label>
                                                  <FieldOptionsInput value={rf.options || []} disabled={!canEdit}
                                                    onCommit={(opts2) => patchRuleField(f.key, ri, fi, { options: opts2 })} />
                                                </div>
                                              )}
                                              {rf.type === 'reference' && (
                                                <div className="mt-2">
                                                  <label className={labelCls}>被引用字段<span className="text-red-500">*</span></label>
                                                  <RefFieldsPicker
                                                    value={rf.ref_fields || []}
                                                    disabled={!canEdit}
                                                    excludeKey={rf.key}
                                                    allFields={allFlatFields}
                                                    onChange={(rfs) => patchRuleField(f.key, ri, fi, { ref_fields: rfs })}
                                                  />
                                                  <label className="mt-2 flex w-fit cursor-pointer items-center gap-2">
                                                    <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                                      checked={rf.allow_custom === true} onChange={(e) => patchRuleField(f.key, ri, fi, { allow_custom: e.target.checked })} />
                                                    <span className="text-sm text-foreground">允许填写选项之外的值</span>
                                                  </label>
                                                </div>
                                              )}
                                            </div>
                                          ))}
                                          {canEdit && (
                                            <button onClick={() => addRuleField(f.key, ri)}
                                              className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary">
                                              <Plus className="h-3.5 w-3.5" />添加扩展字段
                                            </button>
                                          )}
                                          {!(rule.fields || []).length && (
                                            <p className={hintCls}>暂无扩展字段：命中该规则时不展开内容</p>
                                          )}
                                        </div>
                                      </div>
                                    )
                                  })}
                                  {!(f.rules || []).length && (
                                    <p className={hintCls}>暂无规则：选择任何选项时均不展开字段</p>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 流转路由 */}
                  <div>
                    <div className="mb-3 flex items-center justify-between border-t border-border pt-5">
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <GripVertical className="h-4 w-4 text-muted-foreground" />流转路由（{(selected.routes || []).length}）
                      </div>
                      {canEdit && (
                        <Button size="sm" variant="secondary" onClick={addRoute}>
                          <Plus className="mr-1 h-3.5 w-3.5" />添加路由
                        </Button>
                      )}
                    </div>
                    {!(selected.routes || []).length ? (
                      <div className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                        至少配置一条流转路由，否则该节点无法流转
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {(selected.routes || []).map((r, idx) => {
                          const isDefault = r.when === null || r.when === undefined
                          const toNode = nodes.find((n) => n.key === r.to)
                          const toInvalid = !r.to || !toNode
                          const flatOpts = flatFields(selected.fields)
                          const topKeySet = new Set((selected.fields || []).map((f) => f.key))
                          const when = isDefault ? null : normWhen(r.when)
                          return (
                            <div key={idx} className="rounded-md border border-border p-4">
                              <div className="flex items-center gap-3">
                                <span className="shrink-0 rounded bg-muted px-2 py-1 text-xs font-medium text-foreground">路由 {idx + 1}</span>
                                <div className={`w-48 rounded-md ${toInvalid ? 'ring-1 ring-destructive' : ''}`}>
                                  <CompactSelect size="lg" block disabled={!canEdit} value={r.to || ''} onChange={(e) => patchRoute(idx, { to: e.target.value })}>
                                    <option value="">选择去向节点</option>
                                    {nodes.map((n) => <option key={n.key} value={n.key}>{n.name || n.key}{n.type === 'end' ? '（结束）' : ''}</option>)}
                                  </CompactSelect>
                                </div>
                                <div className="w-48">
                                  <input className={inputCls} disabled={!canEdit} placeholder="路由名称（如：需应急）"
                                    value={r.label || ''} onChange={(e) => patchRoute(idx, { label: e.target.value })} />
                                </div>
                                <label className="flex shrink-0 cursor-pointer items-center gap-2">
                                  <input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canEdit}
                                    checked={isDefault} onChange={(e) => setRouteDefault(idx, e.target.checked)} />
                                  <span className="text-sm text-foreground">无条件（默认路由）</span>
                                </label>
                                <div className="flex-1" />
                                {toNode && toNode.type !== 'end' && (
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {toNode.type === 'parallel'
                                      ? `→ 「${toNode.name}」由「${(toNode.sign_groups || []).map((gid) => groupName(gid)).filter(Boolean).join('、') || '未绑定分组'}」并行会签${toNode.finish_policy === 'any' ? '（任一即过）' : '（全部完成）'}`
                                      : `→ 「${toNode.name}」由「${groupName(toNode.group_id) || '未绑定分组'}」处理`}
                                  </span>
                                )}
                                {canEdit && (
                                  <button onClick={() => removeRoute(idx)}
                                    className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                                    <Trash2 className="h-3.5 w-3.5" />删除
                                  </button>
                                )}
                              </div>
                              {!isDefault && when && (
                                <div className="mt-3 rounded bg-muted p-3">
                                  <div className="flex flex-wrap items-center gap-3">
                                    <span className="shrink-0 text-xs font-medium text-muted-foreground">满足方式</span>
                                    <div className="w-40">
                                      <CompactSelect size="lg" block disabled={!canEdit} value={when.logic}
                                        onChange={(e) => patchRoute(idx, { when: { ...when, logic: e.target.value } })}>
                                        <option value="and">全部满足（且）</option>
                                        <option value="or">任一满足（或）</option>
                                      </CompactSelect>
                                    </div>
                                    {canEdit && (
                                      <button onClick={() => addRouteCond(idx)}
                                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">
                                        <Plus className="h-3.5 w-3.5" />添加条件
                                      </button>
                                    )}
                                  </div>
                                  <div className="mt-2 space-y-2">
                                    {when.conds.map((c, ci) => {
                                      const cf = flatOpts.find((x) => x.key === c.field)
                                      const fieldInvalid = !c.field || !flatOpts.some((f) => f.key === c.field)
                                      // 大于/小于仅对数字、日期时间字段开放（与其余字段类型无意义）
                                      const cmpOk = !cf || ['number', 'datetime'].includes(cf.type)
                                      const opOpts = cmpOk ? COND_OP_OPTIONS : COND_OP_OPTIONS.filter((o) => !['gt', 'lt'].includes(o.value))
                                      const isPick = cf && (cf.type === 'select' || cf.type === 'switch') && (c.op === 'eq' || c.op === 'ne')
                                      const isNum = cf?.type === 'number' && ['eq', 'ne', 'gt', 'lt'].includes(c.op || 'eq')
                                      const placeholder = {
                                        eq: '字段值等于该值时命中',
                                        ne: '字段值不等于该值时命中',
                                        gt: '字段值大于该数值时命中',
                                        lt: '字段值小于该数值时命中',
                                        in: '多个值用逗号分隔，任一命中',
                                        contains: '字段值包含该文本时命中',
                                      }[c.op || 'eq']
                                      return (
                                        <div key={ci} className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-background p-2.5">
                                          <div className={`w-52 rounded-md ${fieldInvalid ? 'ring-1 ring-destructive' : ''}`}>
                                            <label className={labelCls}>判断字段</label>
                                            <CompactSelect size="lg" block disabled={!canEdit} value={c.field || ''}
                                              onChange={(e) => patchRouteCond(idx, ci, { field: e.target.value })}>
                                              <option value="">选择本节点字段</option>
                                              {flatOpts.map((f) => (
                                                <option key={f.key} value={f.key}>{f.label || f.key}（{f.key}{topKeySet.has(f.key) ? '' : ' · 扩展'}）</option>
                                              ))}
                                            </CompactSelect>
                                          </div>
                                          <div className="w-32">
                                            <label className={labelCls}>操作符</label>
                                            <CompactSelect size="lg" block disabled={!canEdit} value={c.op || 'eq'}
                                              onChange={(e) => patchRouteCond(idx, ci, { op: e.target.value })}>
                                              {opOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                              {c.op && !isCondOp(c.op) && <option value={c.op}>{c.op}（已失效）</option>}
                                            </CompactSelect>
                                          </div>
                                          <div className="min-w-44 flex-1">
                                            <label className={labelCls}>判断值</label>
                                            {isPick ? (() => {
                                              const opts = cf.type === 'switch' ? ['是', '否'] : (cf.options || [])
                                              return (
                                                <CompactSelect size="lg" block disabled={!canEdit} value={c.value ?? ''}
                                                  onChange={(e) => patchRouteCond(idx, ci, { value: e.target.value })}>
                                                  <option value="">请选择</option>
                                                  {opts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                                                </CompactSelect>
                                              )
                                            })() : (
                                              <input className={inputCls} type={isNum ? 'number' : 'text'} disabled={!canEdit} placeholder={placeholder}
                                                value={c.value ?? ''} onChange={(e) => patchRouteCond(idx, ci, { value: e.target.value })} />
                                            )}
                                          </div>
                                          {canEdit && when.conds.length > 1 && (
                                            <button onClick={() => removeRouteCond(idx, ci)}
                                              className="mb-1 shrink-0 rounded p-1 text-destructive hover:bg-destructive/10" title="删除该条件">
                                              <Trash2 className="h-4 w-4" />
                                            </button>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                  <p className={`${hintCls} mt-2`}>
                                    条件字段可选本节点字段（含规则扩展字段）；按从上到下顺序匹配路由，提交时命中即建议走此路由，处理人可确认调整
                                  </p>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* 节点动作 · 封禁同步（可选）：提交时命中触发条件，把封禁信息同步到工作台已封禁 IP 列表 */}
                  {selected.type !== 'parallel' && (() => {
                    const bs = selected.ban_sync || {}
                    const flat = flatFields(selected.fields || [])
                    const byKey = Object.fromEntries(flat.map((x) => [x.key, x]))
                    const swFields = flat.filter((x) => ['select', 'switch'].includes(x.type))
                    const durFields = flat.filter((x) => x.type === 'duration')
                    const swDef = byKey[bs.switch_field]
                    const swOpts = swDef
                      ? (swDef.type === 'switch' ? ['是', '否'] : (swDef.options || []).map(String))
                      : ['是']
                    const patchBS = (patch) => patchNode(selected.key, { ban_sync: { ...bs, ...patch } })
                    return (
                      <div className="mt-6">
                        <div className="mb-3 flex items-center justify-between border-t border-border pt-5">
                          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <ShieldBan className="h-4 w-4 text-muted-foreground" />节点动作 · 封禁同步
                          </div>
                          {canEdit && (
                            <label className="flex cursor-pointer items-center gap-2"
                              title="开启后本节点提交流转时按触发条件同步封禁信息到工作台">
                              <input type="checkbox" className="h-4 w-4 accent-primary"
                                checked={!!selected.ban_sync}
                                onChange={(e) => patchNode(selected.key, e.target.checked
                                  ? { ban_sync: { switch_field: '', switch_value: '是', ip_field: '', device_field: '', duration_field: '' } }
                                  : { ban_sync: null })} />
                              <span className="text-sm text-foreground">提交流转时同步封禁</span>
                            </label>
                          )}
                        </div>
                        {selected.ban_sync ? (
                          <div className="rounded-md border border-border p-4">
                            <div className="grid grid-cols-5 gap-3">
                              <div>
                                <label className={labelCls}>触发字段<span className="text-red-500">*</span></label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={bs.switch_field || ''}
                                  onChange={(e) => patchBS({ switch_field: e.target.value, switch_value: '' })}
                                  title="本节点下拉选择/是否开关字段，命中触发值时执行同步">
                                  <option value="">选择下拉/开关字段</option>
                                  {swFields.map((x) => <option key={x.key} value={x.key}>{x.label || x.key}（{x.key}）</option>)}
                                  {bs.switch_field && !swDef && <option value={bs.switch_field}>{bs.switch_field}（已失效）</option>}
                                </CompactSelect>
                              </div>
                              <div>
                                <label className={labelCls}>触发值</label>
                                <CompactSelect size="lg" block disabled={!canEdit || !swDef} value={bs.switch_value || '是'}
                                  onChange={(e) => patchBS({ switch_value: e.target.value })}>
                                  {swOpts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                                </CompactSelect>
                              </div>
                              <div>
                                <label className={labelCls}>封禁 IP 字段<span className="text-red-500">*</span></label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={bs.ip_field || ''}
                                  onChange={(e) => patchBS({ ip_field: e.target.value })}>
                                  <option value="">选择字段</option>
                                  {flat.map((x) => <option key={x.key} value={x.key}>{x.label || x.key}（{x.key}）</option>)}
                                </CompactSelect>
                              </div>
                              <div>
                                <label className={labelCls}>封禁设备字段</label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={bs.device_field || ''}
                                  onChange={(e) => patchBS({ device_field: e.target.value })}>
                                  <option value="">不指定</option>
                                  {flat.map((x) => <option key={x.key} value={x.key}>{x.label || x.key}（{x.key}）</option>)}
                                </CompactSelect>
                              </div>
                              <div>
                                <label className={labelCls}>封禁时长字段<span className="text-red-500">*</span></label>
                                <CompactSelect size="lg" block disabled={!canEdit} value={bs.duration_field || ''}
                                  onChange={(e) => patchBS({ duration_field: e.target.value })}
                                  title="须为时长类型字段，决定封禁时长与解封时间">
                                  <option value="">选择时长字段</option>
                                  {durFields.map((x) => <option key={x.key} value={x.key}>{x.label || x.key}（{x.key}）</option>)}
                                  {bs.duration_field && !byKey[bs.duration_field] && (
                                    <option value={bs.duration_field}>{bs.duration_field}（已失效）</option>
                                  )}
                                </CompactSelect>
                              </div>
                            </div>
                            <p className={`${hintCls} mt-2`}>
                              本节点提交流转时，若「触发字段」命中「触发值」且封禁 IP / 时长已填写，则将封禁 IP、设备、时长同步到工作台「已封禁 IP」列表（来源=工单同步，仅记录不调用设备），详情中可跳转回本工单
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-md border border-dashed border-border py-4 text-center text-sm text-muted-foreground">
                            未启用：本节点提交时不同步封禁信息到工作台
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {/* 模板固定抄送选择弹窗：已配置的对象在弹窗中置灰不重复选 */}
      <CcSelectModal
        open={ccPickerOpen}
        onClose={() => setCcPickerOpen(false)}
        title="配置模板固定抄送"
        excludeKeys={ccTargets.map(ccKey)}
        onConfirm={(targets) => setCcTargets((s) => [...s, ...targets.filter((t) => !s.some((x) => ccKey(x) === ccKey(t)))])}
      />
      {/* 发起分组选择弹窗（仅分组）：已授权分组置灰不重复选 */}
      <CcSelectModal
        open={startPickerOpen}
        onClose={() => setStartPickerOpen(false)}
        title="选择发起分组"
        groupsOnly
        excludeKeys={startGroups.map((gid) => `group:${gid}`)}
        onConfirm={(targets) => setStartGroups((s) => {
          const ids = new Set(s)
          targets.forEach((t) => ids.add(t.id))
          return [...ids]
        })}
      />
      {/* 版本历史抽屉：发布存档列表 + 与当前编辑内容的差异 + 回滚（回滚后重载编辑数据） */}
      <TicketFlowVersionsDrawer
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        flowId={flowId}
        current={payload()}
        currentVersion={flowState.version}
        isDraft={flowState.is_draft}
        dirty={dirty}
        canEdit={canEdit}
        onRolledBack={loadFlow}
      />
    </PageContainer>
  )
}
