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
  Flag, ChevronRight, GripVertical, AlertTriangle, UsersRound, CheckCircle2, List, History, Zap,
} from 'lucide-react'
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, MarkerType } from 'reactflow'
import { toast } from '../store/toastStore'
import InfoTip from '../components/InfoTip'
import { CcChips, CcSelectModal, ccKey } from '../components/CcPicker'
import TicketFlowVersionsDrawer from '../components/TicketFlowVersionsDrawer'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { inputCls, inputBaseCls, labelCls, hintCls } from '../components/property/FormControls'
import {Button, PageContainer, CompactSelect, AutoGrowTextarea } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import { condText, normWhen, COND_OP_OPTIONS, isCondOp, evalParamExpr, normParamPresets } from '../utils/ticketFlow'
import ticketApi from '../api/tickets'
import { devices as devicesApi } from '../api/client'

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
// 设备动作拆解：judge_field 命中本节点顶层 select/switch 字段的动作挂到该字段的 device_action 上
// （编辑器形态：配置入口在字段卡上），引用前序节点字段的存量动作保留在节点级 device_actions
const normNodeRoutes = (ns) => (ns || []).map((n) => {
  const rest = { ...(n || {}) }
  const actions = (Array.isArray(rest.device_actions) ? rest.device_actions : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      device_id: x.device_id,
      action_id: x.action_id,
      judge_field: x.judge_field || '',
      judge_value: x.judge_value || '是',
      ...(x.param_presets && typeof x.param_presets === 'object' ? { param_presets: x.param_presets } : {}),
      ...(x.param_config && typeof x.param_config === 'object' ? { param_config: x.param_config } : {}),
    }))
  if (!actions.length && rest.device_action && typeof rest.device_action === 'object' && Object.keys(rest.device_action).length) {
    actions.push(rest.device_action)
  }
  delete rest.device_action
  // 判断字段命中本节点顶层下拉/开关字段 → 字段挂载；其余（引用前序节点/无判断字段）留在节点级
  const fieldAction = new Map()
  const nodeActions = []
  actions.forEach((a) => {
    const hit = (rest.fields || []).find((f) => f && f.type === 'select' && f.key === a.judge_field)
      || (rest.fields || []).find((f) => f && f.type === 'switch' && f.key === a.judge_field)
    if (hit && !fieldAction.has(hit.key)) {
      fieldAction.set(hit.key, {
        device_id: a.device_id,
        action_id: a.action_id,
        judge_value: a.judge_value || '是',
        param_presets: a.param_presets && typeof a.param_presets === 'object' ? a.param_presets : null,
        param_config: a.param_config && typeof a.param_config === 'object' ? a.param_config : null,
      })
    } else {
      nodeActions.push(a)
    }
  })
  const fields = (rest.fields || []).map((f) => ({
    ...f,
    device_action: fieldAction.get(f?.key) || null,
    rules: (f.rules || []).map((r) => {
      if (!r || typeof r !== 'object' || !('device_action' in r)) return r
      const next = { ...r }
      delete next.device_action
      return next
    }),
  }))
  return {
    ...rest,
    fields,
    device_actions: nodeActions,
    routes: (rest.routes || []).map((r) => (r.when ? { ...r, when: normWhen(r.when) } : r)),
    ...(rest.type === 'parallel' ? { sign_groups: rest.sign_groups || [], finish_policy: rest.finish_policy || 'all' } : {}),
  }
})

// param_config 归一化：过滤无效条目；「可编辑且无默认值模板」等于未配置，不落键（空配置整体省略）
const normParamConfig = (pc) => {
  if (!pc || typeof pc !== 'object' || Array.isArray(pc)) return null
  const out = {}
  Object.entries(pc).forEach(([pname, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    const display = ['editable', 'readonly', 'hidden'].includes(entry.display) ? entry.display : 'editable'
    const template = String(entry.default_template ?? '').trim()
    if (display === 'editable' && !template) return
    out[pname] = { display, ...(template ? { default_template: template } : {}) }
  })
  return Object.keys(out).length ? out : null
}

// 保存组装（normNodeRoutes 的逆变换）：字段级 device_action 合并回节点 device_actions（judge_field=字段key），
// 字段副本剥离该键；未选完设备/动作的绑定不保存（发布校验会先行拦截）
const buildPayloadNodes = (ns) => (ns || []).map((n) => {
  const deviceActions = [...(Array.isArray(n?.device_actions) ? n.device_actions : [])]
  const fields = (n?.fields || []).map((f) => {
    if (!f) return f
    const { device_action: da, ...rest } = f
    if (da && typeof da === 'object' && da.device_id && da.action_id) {
      // 参数快捷选项（{参数名: [{label, value}]}）与参数配置（{参数名: {display, default_template}}）
      // 随动作条目持久化；保存时归一化（过滤未填完整的空行/空条目），空配置不落键
      const cleanPresets = normParamPresets(da.param_presets)
      const cleanPConf = normParamConfig(da.param_config)
      deviceActions.push({
        device_id: da.device_id,
        action_id: da.action_id,
        judge_field: f.key,
        judge_value: da.judge_value || '是',
        ...(cleanPresets ? { param_presets: cleanPresets } : {}),
        ...(cleanPConf ? { param_config: cleanPConf } : {}),
      })
    }
    return rest
  })
  return { ...n, fields, device_actions: deviceActions }
})

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
    <AutoGrowTextarea
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

// 节点设备动作配置集合：节点级（存量：判断字段引用前序节点）+ 字段级（select/switch 字段直接绑定）
function collectDeviceCfgs(n) {
  const list = Array.isArray(n?.device_actions) ? n.device_actions : []
  const cfgs = list.filter((c) => c?.device_id)
  ;(n?.fields || []).forEach((f) => {
    if (f?.device_action?.device_id) cfgs.push(f.device_action)
  })
  if (!cfgs.length && n?.device_action?.device_id) cfgs.push(n.device_action)
  return cfgs
}

function firstDeviceName(n, actionMap) {
  const cfg = collectDeviceCfgs(n)[0]
  if (!cfg) return ''
  return (actionMap?.[cfg.device_id] || []).find((a) => a.id === cfg.action_id)?.name || ''
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
        {collectDeviceCfgs(n).length > 0 && (
          <span className="shrink-0 rounded bg-cyan-500/15 px-1 py-0.5 text-[10px] font-medium text-cyan-600">设备</span>
        )}
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
      {collectDeviceCfgs(n).length > 0 && (
        <div className="mt-1 truncate text-[10px] font-medium text-cyan-600">
          {data.actionName ? `设备 · ${data.actionName}` : '设备动作'}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-2 !border-background !bg-primary" />
    </div>
  )
}

const ticketFlowNodeTypes = { ticketNode: TicketFlowNodeCard }

// 画布：按路由依赖分层自动布局（默认路由实线 / 条件路由虚线）；拖拽位置仅本地暂存不入库
function TicketFlowCanvas({ flowNodes, validation, selectedKey, groups, actionMap, canEdit, onSelect, onConnectRoute }) {
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
          position: posOverride[n.key] || { x: l * 340, y: i * 172 },
          data: {
            n,
            index: i,
            actionName: firstDeviceName(n, actionMap),
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
  }, [flowNodes, groups, actionMap, validation, posOverride])

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
  const [deviceList, setDeviceList] = useState([])
  const [actionMap, setActionMap] = useState({})
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
    devicesApi.list().then((list) => setDeviceList(Array.isArray(list) ? list : [])).catch(() => {})
  }, [])

  useEffect(() => {
    const ids = [...new Set(nodes.flatMap((n) => collectDeviceCfgs(n).map((c) => c.device_id)).filter(Boolean))]
    ids.forEach((deviceId) => {
      if (Object.prototype.hasOwnProperty.call(actionMap, deviceId)) return
      devicesApi.listActions(deviceId)
        .then((list) => setActionMap((m) => ({ ...m, [deviceId]: Array.isArray(list) ? list : [] })))
        .catch(() => setActionMap((m) => (m[deviceId] ? m : { ...m, [deviceId]: [] })))
    })
  }, [nodes, actionMap])

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
    nodes: { start_groups: startGroups, cc_targets: ccTargets, nodes: buildPayloadNodes(nodes) },
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

        // 设备动作校验（ban_sync 旧配置已下线，后端保留执行兼容存量模板，前端不再校验）
        // 主口径：select/switch 字段卡上直接绑定（f.device_action）；存量节点级动作（判断字段引用前序节点）兼容校验
        const checkBind = (da, label, jf) => {
          if (!da.device_id || !da.action_id) {
            addErr(n.key, `${name}：${label}未选择设备或动作`)
            return
          }
          if (deviceList.length) {
            const dev = deviceList.find((d) => d.id === da.device_id)
            if (!dev || !dev.enabled) addErr(n.key, `${name}：${label}绑定的设备不存在或已禁用`)
            else if (actionMap[da.device_id]) {
              const act = actionMap[da.device_id].find((a) => a.id === da.action_id)
              if (!act || !act.enabled) addErr(n.key, `${name}：${label}绑定的动作不存在、未启用或不属于该设备`)
            }
          }
          if (jf) {
            const allowed = jf.type === 'switch' ? ['是', '否'] : (jf.options || []).map(String)
            const jv = da.judge_value || '是'
            if (allowed.length && !allowed.includes(String(jv))) addErr(n.key, `${name}：${label}的触发取值「${jv}」不是该字段的可选项`)
          }
        }
        let hasFieldBind = false
        ;(n.fields || []).forEach((f) => {
          const da = f?.device_action
          if (!da || typeof da !== 'object') return
          hasFieldBind = true
          if (n.type === 'parallel' || n.type === 'end') {
            addErr(n.key, `${name}：会签节点与结束节点的字段不能绑定设备动作`)
            return
          }
          if (!['select', 'switch'].includes(f.type)) {
            addErr(n.key, `${name}：字段「${f.label || f.key}」绑定了设备动作，但字段类型需为下拉选择或是否开关`)
            return
          }
          checkBind(da, `字段「${f.label || f.key}」的设备动作`, f)
          // 动作 schema（参数快捷选项 / 参数配置校验共用）
          const pickedAct = (actionMap[da.device_id] || []).find((a) => a.id === da.action_id)
          let actSchema = []
          if (pickedAct) {
            try { actSchema = JSON.parse(pickedAct.params_schema || '[]') } catch { actSchema = [] }
            if (!Array.isArray(actSchema)) actSchema = []
          }
          // 参数快捷选项校验：label/value 非空，且配置的参数名须存在于动作 schema
          const pp = da.param_presets
          if (pp && typeof pp === 'object' && !Array.isArray(pp)) {
            Object.entries(pp).forEach(([pname, list]) => {
              if (!Array.isArray(list)) {
                addErr(n.key, `${name}：字段「${f.label || f.key}」的参数快捷选项格式不正确`)
                return
              }
              if (actSchema.length && !actSchema.some((x) => x && x.name === pname)) {
                addErr(n.key, `${name}：字段「${f.label || f.key}」的快捷选项配置了动作中不存在的参数「${pname}」`)
              }
              list.forEach((it) => {
                if (!it || typeof it !== 'object') {
                  addErr(n.key, `${name}：字段「${f.label || f.key}」的快捷选项格式不正确`)
                } else if (!String(it.label ?? '').trim()) {
                  addErr(n.key, `${name}：字段「${f.label || f.key}」的参数「${pname}」存在未命名快捷选项`)
                } else if (it.value === '' || it.value == null) {
                  addErr(n.key, `${name}：字段「${f.label || f.key}」的快捷选项「${it.label}」未配置实际值`)
                } else if (evalParamExpr(it.value) === null) {
                  addErr(n.key, `${name}：字段「${f.label || f.key}」的快捷选项「${it.label}」的值无法解析`)
                }
              })
            })
          }
          // 参数配置校验：参数名须存在于动作 schema；只读/隐藏且无默认值模板（动作也无默认值）→ 提交时参数将为空
          const pcfg = da.param_config
          if (pcfg && typeof pcfg === 'object' && !Array.isArray(pcfg)) {
            Object.entries(pcfg).forEach(([pname, entry]) => {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                addErr(n.key, `${name}：字段「${f.label || f.key}」的参数配置格式不正确`)
                return
              }
              if (actSchema.length && !actSchema.some((x) => x && x.name === pname)) {
                addErr(n.key, `${name}：字段「${f.label || f.key}」的参数配置引用了动作中不存在的参数「${pname}」`)
                return
              }
              if (['readonly', 'hidden'].includes(entry.display)
                && !String(entry.default_template ?? '').trim()
                && !(actSchema.find((x) => x && x.name === pname) || {}).default) {
                addErr(n.key, `${name}：字段「${f.label || f.key}」的参数「${pname}」设为${entry.display === 'hidden' ? '隐藏' : '只读'}但未配置默认值模板（动作也无默认值），提交时该参数将为空`)
              }
            })
          }
        })
        const actions = Array.isArray(n.device_actions) ? n.device_actions : []
        actions.forEach((da, i) => {
          const label = `第 ${i + 1} 个设备动作`
          if (n.type === 'parallel' || n.type === 'end') {
            addErr(n.key, `${name}：会签节点与结束节点不能绑定设备动作`)
            return
          }
          checkBind(da, label, null)
          if (!da.judge_field) {
            addErr(n.key, `${name}：${label}未选择判断字段（存量动作请改到字段的设备动作绑定中配置）`)
          } else {
            // 存量动作判断字段：本节点 select/switch 已拆到字段挂载形态，此处兼容前面节点及本节点其他类型
            const candidates = [
              ...(n.fields || []),
              ...nodes.filter((x) => x.key !== n.key && x.type !== 'end').flatMap((x) => x.fields || []),
            ]
            const jf = candidates.find((f) => f.key === da.judge_field && ['select', 'switch'].includes(f.type))
            if (!jf) addErr(n.key, `${name}：${label}的判断字段须是下拉选择或是否开关类型`)
            else if (!(n.fields || []).some((f) => f.key === da.judge_field)) {
              const allowed = jf.type === 'switch' ? ['是', '否'] : (jf.options || []).map(String)
              const jv = da.judge_value || '是'
              if (allowed.length && !allowed.includes(String(jv))) addErr(n.key, `${name}：${label}的建议执行取值不是判断字段的可选项`)
            }
          }
        })
        if ((actions.length || hasFieldBind) && n.type !== 'parallel' && n.type !== 'end' && nodes.find((x) => x.type !== 'end')?.key === n.key) {
          addWarn(n.key, `${name}：发起节点（首处理节点）提交不走流转，设备动作不会在发起时执行`)
        }

        // 节点动作 · 设备动作（与后端发布校验一致：设备/动作指向、触发条件、参数映射）
        const das = n.device_actions
        if (Array.isArray(das) && das.length) {
          const flatDA = flatFields(n.fields || [])
          const flatKeySet = new Set(flatDA.map((x) => String(x.key)))
          const typeByKey = Object.fromEntries(flatDA.map((x) => [String(x.key), x.type]))
          const seenDA = new Set()
          das.forEach((da, di) => {
            const dpos = `第 ${di + 1} 个设备动作`
            if (!da.id) {
              addErr(n.key, `${name}：${dpos}缺少标识`)
            } else if (seenDA.has(String(da.id))) {
              addErr(n.key, `${name}：${dpos}标识 ${da.id} 重复`)
            } else {
              seenDA.add(String(da.id))
            }
            if (!da.device_id) {
              addErr(n.key, `${name}：${dpos}未选择执行设备`)
            } else if (!da.action_id) {
              addErr(n.key, `${name}：${dpos}未选择设备动作`)
            } else if (deviceList.length) {
              const dev = deviceList.find((x) => x.id === da.device_id)
              if (!dev) addErr(n.key, `${name}：${dpos}执行设备不存在（ID=${da.device_id}）`)
              else if (!dev.enabled) addWarn(n.key, `${name}：${dpos}设备「${dev.name}」已停用，运行时无法执行`)
            }
            // 触发条件：判断字段指向 / 操作符 / gt-lt 类型（与路由条件同规则）
            if (da.when) {
              const { conds } = normWhen(da.when)
              if (!conds.length) {
                addErr(n.key, `${name}：${dpos}触发条件缺少判断条件`)
              }
              conds.forEach((c) => {
                if (!c.field) {
                  addErr(n.key, `${name}：${dpos}触发条件存在未选择判断字段的条件`)
                } else if (!flatKeySet.has(String(c.field))) {
                  addErr(n.key, `${name}：${dpos}触发条件的判断字段 ${c.field} 不在节点字段中`)
                } else if (!isCondOp(c.op || 'eq')) {
                  addErr(n.key, `${name}：${dpos}判断字段 ${c.field} 的操作符 ${c.op} 不合法`)
                } else if ((c.op === 'gt' || c.op === 'lt') && !['number', 'datetime'].includes(typeByKey[String(c.field)])) {
                  addErr(n.key, `${name}：${dpos}判断字段 ${c.field} 需为数字或日期时间类型才能使用大于/小于`)
                } else if (String(c.value ?? '').trim() === '') {
                  addWarn(n.key, `${name}：${dpos}触发条件未填写判断值，该条件不会命中`)
                }
              })
            }
            // 参数映射：映射目标须为本节点字段
            Object.entries(da.params || {}).forEach(([pname, pfield]) => {
              if (pfield && !flatKeySet.has(String(pfield))) {
                addErr(n.key, `${name}：${dpos}参数 ${pname} 映射的字段 ${pfield} 不在节点字段中`)
              }
            })
          })
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
  }, [nodes, startGroups, groups, deviceList, actionMap])

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
                        {collectDeviceCfgs(n).length > 0 && (
                          <span className="shrink-0 rounded bg-cyan-500/15 px-1 py-0.5 text-[10px] font-medium text-cyan-600">设备</span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {n.type === 'end' ? '结束节点'
                          : n.type === 'parallel' ? `${(n.sign_groups || []).map((gid) => groupName(gid)).filter(Boolean).join('、') || '未绑定分组'} · 会签`
                          : `${groupName(n.group_id) || '未绑定分组'} · ${(n.fields || []).length} 字段${(() => { const an = firstDeviceName(n, actionMap); return an ? ` · ${an}` : '' })()}`}
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
              actionMap={actionMap}
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
                          patchNode(selected.key, { type: 'parallel', group_id: '', sign_groups: [], finish_policy: 'all', device_actions: [] })
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
                                  onChange={(e) => {
                                    const type = e.target.value
                                    // 切换出下拉/开关类型时自动解绑设备动作（判断字段须为这两种类型）
                                    const clear = f.device_action && !['select', 'switch'].includes(type)
                                    patchField(f.key, clear ? { type, device_action: null } : { type })
                                  }}>
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
                            {['select', 'switch'].includes(f.type) && selected.type !== 'parallel' && selected.type !== 'end' && (() => {
                              // 字段级设备动作绑定：处理人填写命中触发值时调用设备（保存时合并为节点 device_actions，judge_field=该字段 key）
                              const da = f.device_action
                              const enabledDevices = deviceList.filter((d) => d.enabled)
                              const acts = (da?.device_id && actionMap[da.device_id]) || []
                              const enabledActs = acts.filter((a) => a.enabled)
                              const picked = enabledActs.find((a) => a.id === da?.action_id) || acts.find((a) => a.id === da?.action_id)
                              let schema = []
                              if (picked) {
                                try { schema = JSON.parse(picked.params_schema || '[]') } catch { schema = [] }
                                if (!Array.isArray(schema)) schema = []
                              }
                              const patchDa = (patch) => patchField(f.key, { device_action: { ...da, ...patch } })
                              const valueOpts = f.type === 'switch' ? ['是', '否'] : (f.options || []).map(String)
                              return (
                                <div className="mt-3 rounded-md border border-cyan-500/40 bg-cyan-500/5 p-3">
                                  <div className="mb-2 flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 text-xs font-medium text-cyan-700">
                                      <Zap className="h-3.5 w-3.5" />设备动作：{da ? '处理人选择触发值时填写参数并调用设备' : '可绑定设备动作，处理人选择触发值时调用'}
                                    </span>
                                    {canEdit && (da ? (
                                      <button type="button" onClick={() => patchField(f.key, { device_action: null })}
                                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                                        <Trash2 className="h-3.5 w-3.5" />解绑
                                      </button>
                                    ) : (
                                      <button type="button" onClick={() => patchField(f.key, {
                                        device_action: {
                                          device_id: '',
                                          action_id: '',
                                          judge_value: f.type === 'switch' ? '是' : (valueOpts[0] ?? '是'),
                                        },
                                      })}
                                        disabled={f.type === 'select' && !valueOpts.length}
                                        title={f.type === 'select' && !valueOpts.length ? '请先配置下拉选项' : '在该字段上绑定设备动作'}
                                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50">
                                        <Plus className="h-3.5 w-3.5" />绑定设备动作
                                      </button>
                                    ))}
                                  </div>
                                  {da ? (
                                    <>
                                      <div className="grid grid-cols-3 gap-3">
                                        <div>
                                          <label className={labelCls}>设备<span className="text-red-500">*</span></label>
                                          <CompactSelect size="lg" block disabled={!canEdit} value={da.device_id || ''}
                                            onChange={(e) => patchDa({ device_id: e.target.value ? Number(e.target.value) : '', action_id: '' })}>
                                            <option value="">选择已启用的设备</option>
                                            {enabledDevices.map((d) => (
                                              <option key={d.id} value={d.id}>{d.name}（{d.type}{d.vendor ? ` · ${d.vendor}` : ''}）</option>
                                            ))}
                                          </CompactSelect>
                                        </div>
                                        <div>
                                          <label className={labelCls}>动作<span className="text-red-500">*</span></label>
                                          <CompactSelect size="lg" block disabled={!canEdit || !da.device_id} value={da.action_id || ''}
                                            onChange={(e) => patchDa({ action_id: e.target.value ? Number(e.target.value) : '' })}>
                                            <option value="">{da.device_id ? '选择已启用的动作' : '请先选择设备'}</option>
                                            {enabledActs.map((a) => (
                                              <option key={a.id} value={a.id}>{a.name}（{a.action_type}）</option>
                                            ))}
                                          </CompactSelect>
                                        </div>
                                        <div>
                                          <label className={labelCls}>触发值</label>
                                          <CompactSelect size="lg" block disabled={!canEdit} value={da.judge_value || '是'}
                                            onChange={(e) => patchDa({ judge_value: e.target.value })}
                                            title="处理人填写该值时才调用设备">
                                            {valueOpts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                                            {da.judge_value && !valueOpts.includes(String(da.judge_value)) && (
                                              <option value={da.judge_value}>{da.judge_value}（已失效）</option>
                                            )}
                                          </CompactSelect>
                                        </div>
                                      </div>
                                      <p className={`${hintCls} mt-2`}>
                                        {schema.length
                                          ? `处理人选择「${da.judge_value || '是'}」时填写并调用：${schema.map((p) => `${p.description || p.name}${p.required ? '' : '（选填）'}`).join('、')}；选其他值不调用`
                                          : (picked ? `处理人选择「${da.judge_value || '是'}」时直接调用，无需填写参数；选其他值不调用。` : '选择设备与动作后，处理人选择触发值时填写参数并调用；选其他值不调用。')}
                                      </p>
                                      {schema.length > 0 && da.action_id && (() => {
                                        const pp = (da.param_presets && typeof da.param_presets === 'object' && !Array.isArray(da.param_presets)) ? da.param_presets : {}
                                        const pc = (da.param_config && typeof da.param_config === 'object' && !Array.isArray(da.param_config)) ? da.param_config : {}
                                        // 已配置参数 = 有 param_config 条目或快捷选项；未配置的保持零负担（处理人直接输入）
                                        const hasCfg = (p) => (pc[p.name] && typeof pc[p.name] === 'object')
                                          || (Array.isArray(pp[p.name]) && pp[p.name].length)
                                        const cfgParams = schema.filter((p) => hasCfg(p))
                                        const restParams = schema.filter((p) => !hasCfg(p))
                                        const setParamPresets = (pname, list) => {
                                          const next = { ...pp }
                                          if (Array.isArray(list) && list.length) next[pname] = list
                                          else delete next[pname] // 清空即整体移除，避免残留空数组
                                          patchDa({ param_presets: next })
                                        }
                                        const setParamCfg = (pname, entry) => {
                                          const next = { ...pc }
                                          if (entry) next[pname] = entry
                                          else delete next[pname]
                                          patchDa({ param_config: next })
                                        }
                                        const DISPLAY_OPTS = [
                                          { value: 'editable', label: '可编辑' },
                                          { value: 'readonly', label: '只读' },
                                          { value: 'hidden', label: '隐藏' },
                                        ]
                                        return (
                                          <div className="mt-2.5 rounded border border-cyan-500/25 bg-background/70 p-2.5">
                                            <div className="mb-2 flex items-center gap-1.5">
                                              <span className="text-xs font-medium text-cyan-700">参数配置</span>
                                              <InfoTip content="按需配置参数在工单中的呈现与传值，三个维度可叠加：① 展示方式——可编辑 / 只读（处理人不可修改）/ 隐藏（完全不展示，按默认值提交）；② 默认值模板——支持变量 {ticket_no} 工单号、{ticket_title} 标题、{creator} 发起人、{f:字段key} 取工单字段值，如「工单同步：{ticket_no}」；③ 快捷选项——选项名映射实际值（支持 3*24*3600 表达式）。未配置的参数由处理人直接输入，无需在此设置。" />
                                            </div>
                                            {cfgParams.map((p) => {
                                              const presets = pp[p.name] || []
                                              const entry = (pc[p.name] && typeof pc[p.name] === 'object' && !Array.isArray(pc[p.name])) ? pc[p.name] : {}
                                              const display = entry.display || 'editable'
                                              const template = entry.default_template || ''
                                              const patchPresets = (list) => setParamPresets(p.name, list)
                                              const patchEntry = (patch) => setParamCfg(p.name, { ...entry, ...patch })
                                              return (
                                                <div key={p.name} className="mb-2.5 last:mb-0 rounded border border-border/70 bg-background p-2">
                                                  <div className="flex items-center justify-between gap-2">
                                                    <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
                                                      {p.description || p.name}{p.required ? ' *' : ''}
                                                      <span className="ml-1 font-mono opacity-60">{p.name}</span>
                                                    </span>
                                                    {canEdit && (
                                                      <button type="button"
                                                        onClick={() => { setParamCfg(p.name, null); setParamPresets(p.name, []) }}
                                                        className="shrink-0 rounded px-1 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                                                        title="移除该参数的全部配置（展示方式 / 默认值模板 / 快捷选项）">
                                                        移除
                                                      </button>
                                                    )}
                                                  </div>
                                                  <div className="mt-1.5 grid grid-cols-[4rem_1fr] items-center gap-x-2 gap-y-1">
                                                    <span className="text-[10px] text-muted-foreground">展示方式</span>
                                                    <CompactSelect size="sm" block disabled={!canEdit} value={display}
                                                      onChange={(e) => patchEntry({ display: e.target.value })}
                                                      title="控制该参数在工单详情中的展示：只读=可见不可改；隐藏=不可见，提交时按默认值传设备">
                                                      {DISPLAY_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                    </CompactSelect>
                                                    <span className="text-[10px] text-muted-foreground">默认值</span>
                                                    <input className={`${inputCls} h-8 min-w-0 text-xs`} disabled={!canEdit}
                                                      placeholder="值模板，如：工单同步：{ticket_no}"
                                                      title="支持变量：{ticket_no} 工单号、{ticket_title} 标题、{creator} 发起人、{f:字段key} 取工单字段值"
                                                      value={template}
                                                      onChange={(e) => patchEntry({ default_template: e.target.value })} />
                                                  </div>
                                                  {display === 'hidden' && (
                                                    <p className="mt-1 text-[10px] text-amber-600">隐藏参数处理人不可见，提交时按默认值模板传给设备；未配置模板时使用动作默认值</p>
                                                  )}
                                                  <div className="mt-1.5">
                                                    <div className="flex items-center justify-between gap-2">
                                                      <span className="text-[10px] text-muted-foreground">
                                                        快捷选项{display !== 'editable' && '（参数只读/隐藏时不生效）'}
                                                      </span>
                                                      {canEdit && (
                                                        <button type="button"
                                                          onClick={() => patchPresets([...presets, { label: '', value: '' }])}
                                                          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-cyan-700 hover:bg-cyan-500/10">
                                                          <Plus className="h-3 w-3" />添加选项
                                                        </button>
                                                      )}
                                                    </div>
                                                    <div className="mt-1 space-y-1.5">
                                                      {presets.map((it, pi) => {
                                                        const evaluated = evalParamExpr(it.value)
                                                        const showEval = evaluated !== null
                                                          && String(evaluated) !== String(it.value ?? '').trim()
                                                        return (
                                                          <div key={pi} className="flex items-center gap-1.5">
                                                            <input className={`${inputCls} h-8 min-w-0 flex-1 text-xs`} disabled={!canEdit}
                                                              placeholder="选项名，如：3天" value={it.label || ''}
                                                              onChange={(e) => patchPresets(presets.map((x, i) => (i === pi ? { ...x, label: e.target.value } : x)))} />
                                                            <span className="shrink-0 text-[10px] text-muted-foreground">→</span>
                                                            <input className={`${inputCls} h-8 min-w-0 flex-[1.6] font-mono text-xs`} disabled={!canEdit}
                                                              placeholder="实际值，如 3*24*3600" value={it.value ?? ''}
                                                              onChange={(e) => patchPresets(presets.map((x, i) => (i === pi ? { ...x, value: e.target.value } : x)))} />
                                                            {showEval && (
                                                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title="表达式求值结果">
                                                                {String(evaluated)}
                                                              </span>
                                                            )}
                                                            {canEdit && (
                                                              <button type="button"
                                                                onClick={() => patchPresets(presets.filter((_, i) => i !== pi))}
                                                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-destructive hover:bg-destructive/10"
                                                                title="删除该快捷选项">
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                              </button>
                                                            )}
                                                          </div>
                                                        )
                                                      })}
                                                    </div>
                                                  </div>
                                                </div>
                                              )
                                            })}
                                            {canEdit && restParams.length > 0 && (
                                              <CompactSelect size="lg" block value=""
                                                onChange={(e) => {
                                                  const pname = e.target.value
                                                  if (pname) setParamCfg(pname, { display: 'editable' })
                                                }}>
                                                <option value="">{cfgParams.length ? '+ 配置其他参数…' : '+ 选择参数配置…'}</option>
                                                {restParams.map((p) => (
                                                  <option key={p.name} value={p.name}>{p.description || p.name}（{p.name}）</option>
                                                ))}
                                              </CompactSelect>
                                            )}
                                            {!cfgParams.length && (
                                              <p className="text-[11px] text-muted-foreground">未配置：所有参数由处理人在工单中直接输入（追溯类参数可设只读 + 默认值模板，需转换的参数如封禁时长可配置快捷选项）</p>
                                            )}
                                          </div>
                                        )
                                      })()}
                                    </>
                                  ) : (
                                    <p className={hintCls}>
                                      未绑定：该字段仅作为普通表单项填写。绑定后，处理人选择触发值时会在工单详情页展开设备参数表单
                                      {f.type === 'select' && !valueOpts.length && '（请先在上方配置下拉选项）'}
                                    </p>
                                  )}
                                </div>
                              )
                            })()}
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

                  {/* 存量设备动作（判断字段引用前序节点）：配置入口已迁移到字段卡上，此处只读展示 + 可删除 */}
                  {selected.type !== 'end' && selected.type !== 'parallel' && (selected.device_actions || []).length > 0 && (
                    <div className="mt-6">
                      <div className="mb-3 flex items-center justify-between border-t border-border pt-5">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Zap className="h-4 w-4 text-muted-foreground" />存量设备动作（{(selected.device_actions || []).length}）
                        </div>
                      </div>
                      <div className="space-y-3">
                        {(selected.device_actions || []).map((da, di) => {
                          const dev = deviceList.find((d) => d.id === da.device_id)
                          const act = (actionMap[da.device_id] || []).find((a) => a.id === da.action_id)
                          const jf = [
                            ...(selected.fields || []),
                            ...nodes.filter((x) => x.key !== selected.key && x.type !== 'end').flatMap((x) => x.fields || []),
                          ].find((f) => f.key === da.judge_field)
                          return (
                            <div key={di} className="rounded-md border border-dashed border-border bg-muted/40 p-4">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground">动作 {di + 1}</span>
                                <span className="text-xs text-muted-foreground">
                                  {dev ? `${dev.name}` : `设备 #${da.device_id || '?'}`}
                                  {' · '}
                                  {act ? `${act.name}（${act.action_type}）` : `动作 #${da.action_id || '?'}`}
                                  {da.judge_field
                                    ? ` · 判断字段 ${jf ? `${jf.label || jf.key}（${da.judge_field}）= ${da.judge_value || '是'}` : da.judge_field}（已失效）`
                                    : ' · 未绑定判断字段（不会执行）'}
                                </span>
                                <div className="flex-1" />
                                {canEdit && (
                                  <button type="button" className="flex shrink-0 items-center gap-1 text-xs font-medium text-destructive hover:text-destructive"
                                    onClick={() => patchNode(selected.key, {
                                      device_actions: (selected.device_actions || []).filter((_, i) => i !== di),
                                    })}>
                                    <Trash2 className="h-3.5 w-3.5" />删除
                                  </button>
                                )}
                              </div>
                              <p className={`${hintCls} mt-2`}>
                                该动作的判断字段引用前序节点，为存量配置。如需调整，请删除后在字段卡（下拉选择/是否开关类型）上重新绑定设备动作。
                              </p>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

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
                                    条件字段可选本节点字段（含规则扩展字段）；按从上到下顺序匹配路由，提交时命中即锁定走此路由（处理人不可改选），未命中任何条件时走默认路由
                                  </p>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* 节点动作 · 设备动作（含工作台同步）：block_ip 类动作执行成功后自动同步封禁台账，
                      旧的独立"封禁同步"配置已下线（后端保留执行以兼容存量已发布模板） */}
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
