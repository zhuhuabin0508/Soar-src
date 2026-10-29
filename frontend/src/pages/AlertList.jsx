// 告警列表页：统计卡片 + 筛选区 + 后端分页表格 + 详情抽屉
// 筛选/排序/分页全部走后端；默认时间范围为最近 24 小时（基于 occur_timestamp）
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  BellRing, Flame, AlertOctagon, MonitorSmartphone, Download, RefreshCw, ChevronDown, CalendarRange,
  Check, Search, ShieldCheck, X, SlidersHorizontal, Columns3, Bookmark, Trash2, ClipboardCheck, ScrollText,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { Modal } from '../components/Dialog'
import { Button, Card, DataTable, Badge, Pagination, Sparkline, CompactSelect, DatePicker } from '../components/ui'
import { inputBaseCls } from '../components/property/FormControls'
import { hasPermission, guardNavPermission } from '../utils/permissions'
import { alertApi } from '../api/alert'
import strategyApi from '../api/strategy'
import usersApi from '../api/users'
import AlertDetailDrawer from './AlertDetailDrawer'

// 状态机流转规则（与后端一致）
const TRANSITIONS = {
  0: [0, 10, 70, 20, 30, 40, 50, 60, 80],
  10: [10, 70, 0, 20, 30, 40, 50, 60, 80],
  70: [70, 0, 10, 20, 30, 40, 50, 60, 80],
  20: [20, 70],
  30: [30, 70, 0], 40: [40, 70, 0], 50: [50, 70, 0], 60: [60, 70, 0], 80: [80, 70, 0],
}
const DEAL_STATUS_OPTIONS = [
  { v: 0, label: '未处置' }, { v: 10, label: '生成事件' }, { v: 20, label: '已关闭' },
  { v: 30, label: '已加白' }, { v: 40, label: '已驳回' }, { v: 50, label: '已忽略' },
  { v: 60, label: '已遏制' }, { v: 70, label: '处置中' }, { v: 80, label: '误报' },
]

// ===== 标准模型枚举（下拉选项中文标签）=====
const RISK_LEVELS = [
  { v: 0, label: '严重' }, { v: 1, label: '高危' }, { v: 2, label: '中危' },
  { v: 3, label: '低危' }, { v: 4, label: '信息' }, { v: 5, label: '未知' },
]
const ATTACK_STATES = [{ v: 0, label: '尝试' }, { v: 1, label: '失败' }, { v: 2, label: '成功' }, { v: 3, label: '失利' }]
const DEAL_STATUSES = [
  { v: 0, label: '未处置' }, { v: 10, label: '生成事件' }, { v: 20, label: '已完成' }, { v: 30, label: '已加白' },
  { v: 40, label: '已驳回' }, { v: 50, label: '已忽略' }, { v: 60, label: '已遏制' }, { v: 70, label: '处置中' }, { v: 80, label: '误报' },
]
const STAGES = [
  { v: 0, label: '默认' }, { v: 10, label: '存在风险' }, { v: 20, label: '扫描探测' }, { v: 30, label: '遭受攻击' },
  { v: 40, label: '主机异常' }, { v: 50, label: '内网扩散' }, { v: 60, label: 'C&C通信' }, { v: 70, label: '黑产牟利' }, { v: 80, label: '窃取数据' },
]
const DIRECTIONS = [{ v: 0, label: '无' }, { v: 1, label: '内到外' }, { v: 2, label: '外到内' }, { v: 3, label: '内对内' }]
const PARSE_STATUSES = [{ v: 'success', label: '成功' }, { v: 'partial', label: '部分解析' }, { v: 'fail', label: '失败' }]

// 状态指标条 chips：风险等级 + 常用处置状态（点击联动对应多选筛选，再点取消）
const RISK_CHIPS = [
  { v: 0, label: '严重', dot: 'bg-red-500', active: 'bg-red-500/15 text-red-500 ring-red-500/40', pulse: true },
  { v: 1, label: '高危', dot: 'bg-orange-500', active: 'bg-orange-500/15 text-orange-500 ring-orange-500/40' },
  { v: 2, label: '中危', dot: 'bg-amber-500', active: 'bg-amber-500/15 text-amber-500 ring-amber-500/40' },
  { v: 3, label: '低危', dot: 'bg-blue-500', active: 'bg-blue-500/15 text-blue-500 ring-blue-500/40' },
  { v: 4, label: '信息', dot: 'bg-sky-500', active: 'bg-sky-500/15 text-sky-500 ring-sky-500/40' },
]
const DEAL_CHIPS = [
  { v: 0, label: '未处置', dot: 'bg-amber-500', active: 'bg-amber-500/15 text-amber-500 ring-amber-500/40' },
  { v: 70, label: '处置中', dot: 'bg-blue-500', active: 'bg-blue-500/15 text-blue-500 ring-blue-500/40' },
  { v: 10, label: '生成事件', dot: 'bg-violet-500', active: 'bg-violet-500/15 text-violet-500 ring-violet-500/40' },
  { v: 20, label: '已完成', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
]

// 风险等级徽章颜色：严重红/高危橙/中危黄/低危蓝/信息灰/未知灰
function RiskBadge({ level, name }) {
  const variant = { 0: 'danger', 1: 'danger', 2: 'warning', 3: 'info', 4: 'neutral', 5: 'neutral' }[level] || 'neutral'
  return <Badge variant={variant}>{name || '未知'}</Badge>
}

// 多选下拉（复选框 + 已选计数）
function MultiSelect({ placeholder, options, values, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const toggle = (v) => {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  }
  const label = values.length
    ? `${placeholder} ${values.length}`
    : placeholder

  return (
    <div className="relative" ref={ref}>
      <button
        className={`${inputBaseCls} flex h-[34px] w-full items-center justify-between gap-1 text-left ${values.length ? 'border-primary/60 text-foreground' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-[38px] left-0 z-dropdown max-h-64 w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.v}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-accent"
              onClick={() => toggle(o.v)}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded border ${values.includes(o.v) ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                {values.includes(o.v) && <Check className="h-3 w-3" />}
              </span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 统计卡片（含涨跌对比；clickable 点击下钻应用筛选；spark 24h 迷你趋势线）
function StatCard({ icon: Icon, label, value, delta, onClick, clickable, valueClass, title, active, spark, loading }) {
  return (
    <div
      className={`card flex items-center gap-3 px-5 py-4 ${clickable ? `cursor-pointer transition hover:border-primary/40 hover:shadow-md ${active ? 'border-primary/40 ring-1 ring-primary/20' : ''}` : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? (title || '点击查看') : undefined}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        {loading ? (
          <div className="mt-2 h-5 w-16 rounded skeleton-shimmer" />
        ) : (
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className={`text-xl font-semibold tabular-nums ${valueClass || 'text-foreground'}`}>{value}</span>
            {delta != null && delta !== 0 && (
              <span className={`text-[11px] tabular-nums ${delta > 0 ? 'text-destructive' : 'text-success'}`}>
                {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}
              </span>
            )}
          </div>
        )}
      </div>
      {!loading && spark && <Sparkline data={spark} className="ml-auto text-primary/60" />}
    </div>
  )
}

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')
const fmtNum = (n) => (n == null ? '--' : Number(n).toLocaleString('zh-CN'))

// IP 数组 JSON → 首个 + "+N"（悬停全部）
function IpCell({ raw }) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.startsWith('[')) {
    try { list = JSON.parse(raw) } catch { list = [raw] }
  } else if (raw) list = [raw]
  if (list.length === 0) return <span className="text-muted-foreground">--</span>
  return (
    <span className="font-mono text-[13px]" title={list.join(', ')}>
      {list[0]}{list.length > 1 && <span className="ml-0.5 text-primary">+{list.length - 1}</span>}
    </span>
  )
}

// ===== 通用单元格（空值灰显 --；悬停查看完整内容）=====
function TextCell({ v, mono, muted }) {
  if (v == null || v === '') return <span className="text-muted-foreground">--</span>
  const text = String(v)
  return (
    <span className={`${mono ? 'font-mono text-[13px]' : ''} ${muted ? 'text-muted-foreground' : ''}`} title={text}>
      {text}
    </span>
  )
}
function NumCell({ v }) {
  if (v == null || v === '' || v === -1) return <span className="text-muted-foreground" title="未统计">--</span>
  const n = Number(v)
  if (n === 0) return <span className="tabular-nums text-muted-foreground">0</span>
  return <span className="tabular-nums">{n.toLocaleString('zh-CN')}</span>
}
function TimeCell({ v }) {
  if (!v) return <span className="text-muted-foreground">--</span>
  return <span className="font-mono text-[13px] text-muted-foreground">{fmtTime(v)}</span>
}
function JsonCell({ v }) {
  // 后端已反序列化的数组/对象 → 紧凑单行展示，悬停看全部
  let text = ''
  if (Array.isArray(v)) text = v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
  else if (v != null && typeof v === 'object') text = JSON.stringify(v)
  else if (v != null && v !== '') text = String(v)
  if (!text) return <span className="text-muted-foreground">--</span>
  return <span className="font-mono text-[12px] text-muted-foreground" title={text}>{text}</span>
}

// 关联本地资产库单元格：命中资产名称可点击，跳转资产列表并按命中 IP 搜索
function AssetLinkCell({ id, name, ip }) {
  const navigate = useNavigate()
  if (!id) return <span className="text-muted-foreground">--</span>
  return (
    <button
      className="block max-w-full truncate text-left text-[13px] font-medium text-primary underline-offset-2 hover:underline"
      title={ip ? `${name || `资产 #${id}`}（${ip}）` : name || `资产 #${id}`}
      onClick={(e) => { e.stopPropagation(); if (!guardNavPermission('asset_list', 'view', '资产清单')) return; navigate(`/assets/list?keyword=${encodeURIComponent(ip || name || '')}`) }}
    >
      {name || `资产 #${id}`}
    </button>
  )
}

// ===== 全量列注册表（顺序即展示顺序；def=默认显示；cat=列选择器分组）=====
// 告警名称与操作列固定显示，在组件内合并；列表接口已返回全量普通字段
const COL_DEFS = [
  { key: 'uuid', header: 'UUID', width: '150px', cat: '标识', render: (r) => <TextCell v={r.uuid} mono muted /> },
  { key: 'seq_id', header: '序列号', width: '130px', cat: '标识', render: (r) => <TextCell v={r.seq_id} mono muted /> },
  { key: 'risk_level', header: '风险等级', width: '90px', cat: '等级', def: true, render: (r) => <RiskBadge level={r.risk_level} name={r.risk_level_name} /> },
  { key: 'severity', header: '严重度', width: '80px', cat: '等级', numeric: true, render: (r) => <NumCell v={r.severity} /> },
  { key: 'confidence', header: '置信度', width: '80px', cat: '等级', numeric: true, render: (r) => <NumCell v={r.confidence} /> },
  { key: 'device_type', header: '设备类型', width: '110px', cat: '设备与解析', def: true, render: (r) => <TextCell v={r.device_type} muted /> },
  { key: 'strategy_id', header: '解析策略ID', width: '104px', cat: '设备与解析', numeric: true, render: (r) => <NumCell v={r.strategy_id} /> },
  { key: 'rule_id', header: '命中规则', width: '110px', cat: '设备与解析', render: (r) => <TextCell v={r.rule_id} mono muted /> },
  { key: 'log_type', header: '日志类型', width: '110px', cat: '设备与解析', render: (r) => <TextCell v={r.log_type} muted /> },
  { key: 'alert_rule_name', header: '告警规则', width: '120px', cat: '设备与解析', def: true, render: (r) => <TextCell v={r.alert_rule_name} muted /> },
  { key: 'devices', header: '设备详情', width: '170px', cat: '设备与解析', render: (r) => <JsonCell v={r.devices} /> },
  { key: 'agent_id', header: 'Agent ID', width: '130px', cat: '设备与解析', render: (r) => <TextCell v={r.agent_id} mono muted /> },
  { key: 'attack_state', header: '攻击状态', width: '90px', cat: '威胁分类', def: true, render: (r) => <TextCell v={r.attack_state_name} /> },
  { key: 'threat_class', header: '威胁大类', width: '110px', cat: '威胁分类', render: (r) => <TextCell v={r.threat_class} /> },
  { key: 'threat_type', header: '威胁类型', width: '120px', cat: '威胁分类', render: (r) => <TextCell v={r.threat_type} /> },
  { key: 'threat_sub_type', header: '威胁子类型', width: '120px', cat: '威胁分类', render: (r) => <TextCell v={r.threat_sub_type} /> },
  {
    key: 'ip', header: '源IP → 目的IP', width: '230px', cat: '源与目的', def: true,
    render: (r) => (
      <span className="flex items-center gap-1.5">
        <IpCell raw={r.src_ip} />
        <span className="text-muted-foreground">→</span>
        <IpCell raw={r.dst_ip} />
      </span>
    ),
  },
  { key: 'src_ip', header: '源IP', width: '130px', cat: '源与目的', render: (r) => <IpCell raw={r.src_ip} /> },
  { key: 'dst_ip', header: '目的IP', width: '130px', cat: '源与目的', render: (r) => <IpCell raw={r.dst_ip} /> },
  { key: 'src_port', header: '源端口', width: '90px', cat: '源与目的', numeric: true, render: (r) => <TextCell v={r.src_port} mono /> },
  { key: 'dst_port', header: '目的端口', width: '90px', cat: '源与目的', numeric: true, render: (r) => <TextCell v={r.dst_port} mono /> },
  { key: 'direction', header: '方向', width: '80px', cat: '源与目的', def: true, render: (r) => <TextCell v={r.direction_name} muted /> },
  { key: 'protocol', header: '协议', width: '80px', cat: '源与目的', def: true, render: (r) => <span className="font-mono text-[13px] uppercase">{r.protocol || '--'}</span> },
  { key: 'stage', header: '告警阶段', width: '100px', cat: '威胁分类', def: true, render: (r) => <TextCell v={r.stage_name} /> },
  { key: 'attck_technique', header: 'ATT&CK技术', width: '150px', cat: '威胁分类', render: (r) => <JsonCell v={r.attck_technique} /> },
  { key: 'risk_tag', header: '风险标签', width: '140px', cat: '威胁分类', render: (r) => <JsonCell v={r.risk_tag} /> },
  { key: 'xff_client_ip', header: 'XFF客户端IP', width: '140px', cat: '源与目的', render: (r) => <TextCell v={r.xff_client_ip} mono /> },
  { key: 'src_country', header: '源国家', width: '90px', cat: '源与目的', render: (r) => <TextCell v={r.src_country} /> },
  { key: 'src_province', header: '源省份', width: '90px', cat: '源与目的', render: (r) => <TextCell v={r.src_province} /> },
  { key: 'src_city', header: '源城市', width: '90px', cat: '源与目的', render: (r) => <TextCell v={r.src_city} /> },
  { key: 'src_ip_tag_name', header: '源IP标签', width: '96px', cat: '源与目的', render: (r) => <TextCell v={r.src_ip_tag_name} /> },
  { key: 'src_region_name', header: '源区域', width: '110px', cat: '源与目的', render: (r) => <TextCell v={r.src_region_name} /> },
  { key: 'src_asset_id', header: '源资产ID', width: '120px', cat: '源与目的', render: (r) => <TextCell v={r.src_asset_id} mono muted /> },
  { key: 'src_region_id', header: '源区域ID', width: '120px', cat: '源与目的', render: (r) => <TextCell v={r.src_region_id} mono muted /> },
  { key: 'dst_region_name', header: '目的区域', width: '110px', cat: '源与目的', render: (r) => <TextCell v={r.dst_region_name} /> },
  { key: 'dst_asset_id', header: '目的资产ID', width: '120px', cat: '源与目的', render: (r) => <TextCell v={r.dst_asset_id} mono muted /> },
  { key: 'dst_region_id', header: '目的区域ID', width: '120px', cat: '源与目的', render: (r) => <TextCell v={r.dst_region_id} mono muted /> },
  { key: 'host_ip', header: '主机IP', width: '130px', cat: '资产与主体', render: (r) => <IpCell raw={r.host_ip} /> },
  { key: 'relate_asset', header: '关联资产', width: '130px', cat: '资产与主体', def: true, render: (r) => <AssetLinkCell id={r.relate_asset_id} name={r.relate_asset_name} ip={r.relate_asset_ip} /> },
  { key: 'asset_id', header: '资产ID', width: '120px', cat: '资产与主体', render: (r) => <TextCell v={r.asset_id} mono muted /> },
  { key: 'region_id', header: '区域ID', width: '120px', cat: '资产与主体', render: (r) => <TextCell v={r.region_id} mono muted /> },
  { key: 'relate_asset_type_name', header: '资产类型', width: '90px', cat: '资产与主体', render: (r) => <TextCell v={r.relate_asset_type_name} /> },
  { key: 'group_id', header: '分组ID', width: '120px', cat: '资产与主体', render: (r) => <TextCell v={r.group_id} mono muted /> },
  { key: 'subject_type', header: '主体类型', width: '100px', cat: '资产与主体', render: (r) => <TextCell v={r.subject_type} /> },
  { key: 'user_name', header: '用户名', width: '110px', cat: '资产与主体', render: (r) => <TextCell v={r.user_name} /> },
  { key: 'account_id', header: '账号ID', width: '120px', cat: '资产与主体', render: (r) => <TextCell v={r.account_id} mono muted /> },
  { key: 'account_name', header: '账号名', width: '110px', cat: '资产与主体', render: (r) => <TextCell v={r.account_name} /> },
  { key: 'occur_timestamp', header: '发生时间', width: '160px', cat: '时间', def: true, render: (r) => <TimeCell v={r.occur_timestamp} /> },
  { key: 'first_timestamp', header: '首次发生', width: '160px', cat: '时间', render: (r) => <TimeCell v={r.first_timestamp} /> },
  { key: 'last_timestamp', header: '最近发生', width: '160px', cat: '时间', render: (r) => <TimeCell v={r.last_timestamp} /> },
  { key: 'upload_timestamp', header: '上报时间戳', width: '160px', cat: '时间', render: (r) => <TimeCell v={r.upload_timestamp} /> },
  { key: 'upload_time', header: '上报时间', width: '160px', cat: '时间', render: (r) => <TimeCell v={r.upload_time} /> },
  { key: 'upload_time_raw', header: '上报时间(原始)', width: '150px', cat: '时间', render: (r) => <TextCell v={r.upload_time_raw} mono muted /> },
  { key: 'time_region', header: '时区', width: '90px', cat: '时间', render: (r) => <TextCell v={r.time_region} /> },
  {
    key: 'deal_status', header: '处置状态', width: '110px', cat: '处置', def: true,
    render: (r) => {
      // -1/null = 尚未处置（默认状态），与 0（未处置）同样显示橙色徽章
      const unhandled = r.deal_status === -1 || r.deal_status == null
      const label = r.deal_status_name || (unhandled || r.deal_status === 0 ? '未处置' : '未知')
      const variant = unhandled || r.deal_status === 0 ? 'warning' : r.deal_status === 20 ? 'success' : 'neutral'
      return (
        <div className="flex flex-col gap-0.5">
          <Badge variant={variant}>
            {label}
          </Badge>
          {r.assignee_name && (
            <span className="truncate text-[11px] text-muted-foreground" title={`指派: ${r.assignee_name}`}>
              {r.assignee_name}
            </span>
          )}
        </div>
      )
    },
  },
  { key: 'assignee_name', header: '处理人', width: '100px', cat: '处置', render: (r) => <TextCell v={r.assignee_name} /> },
  { key: 'handled_at', header: '处置时间', width: '160px', cat: '处置', render: (r) => <TimeCell v={r.handled_at} /> },
  {
    key: 'parse_status', header: '解析状态', width: '90px', cat: '设备与解析', def: true,
    render: (r) => (
      <span className={`text-xs font-medium ${r.parse_status === 'success' ? 'text-success' : r.parse_status === 'partial' ? 'text-warning' : 'text-destructive'}`}>
        {r.parse_status === 'success' ? '成功' : r.parse_status === 'partial' ? '部分解析' : '失败'}
      </span>
    ),
  },
  { key: 'created_at', header: '入库时间', width: '160px', cat: '时间', render: (r) => <TimeCell v={r.created_at} /> },
  { key: 'description', header: '告警描述', width: '220px', cat: '内容', render: (r) => <TextCell v={r.description} muted /> },
  { key: 'recommendation', header: '处置建议', width: '220px', cat: '内容', render: (r) => <TextCell v={r.recommendation} muted /> },
  { key: 'proof_type', header: '举证类型', width: '100px', cat: '内容', render: (r) => <TextCell v={r.proof_type} /> },
  { key: 'tenant', header: '租户', width: '110px', cat: '租户', render: (r) => <TextCell v={r.tenant} /> },
  { key: 'customer', header: '客户', width: '110px', cat: '租户', render: (r) => <TextCell v={r.customer} /> },
  { key: 'data_version', header: '数据版本', width: '90px', cat: '租户', render: (r) => <TextCell v={r.data_version} /> },
  { key: 'extensions', header: '扩展字段', width: '240px', cat: '扩展', render: (r) => <JsonCell v={r.extensions} /> },
]

const DEFAULT_VISIBLE_KEYS = COL_DEFS.filter((c) => c.def).map((c) => c.key)
const COLS_STORAGE_KEY = 'alert-list-visible-columns'
// 列配置存储版本：新增默认显示列时 +1，并在加载时把新列并入旧配置
// （旧配置不可能显式隐藏过当时尚不存在的列，并入不会覆盖用户选择）
const COLS_STORAGE_VERSION = 2
const COLS_V2_ADDED_DEF_KEYS = ['relate_asset']

// 读取用户列配置；兼容 v1 纯数组与旧版「已隐藏列」存储
function loadVisibleCols() {
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      let keys = null
      let ver = 1
      if (Array.isArray(parsed)) {
        keys = parsed // v1：纯 key 数组
      } else if (parsed && Array.isArray(parsed.keys)) {
        keys = parsed.keys // v2+：{v, keys}
        ver = parsed.v || 1
      }
      if (keys) {
        keys = keys.filter((k) => COL_DEFS.some((c) => c.key === k))
        if (ver < COLS_STORAGE_VERSION) {
          keys = [...keys, ...COLS_V2_ADDED_DEF_KEYS.filter((k) => !keys.includes(k))]
        }
        return keys
      }
    }
    const oldHidden = JSON.parse(localStorage.getItem('alert-list-hidden-columns') || 'null')
    if (Array.isArray(oldHidden)) {
      localStorage.removeItem('alert-list-hidden-columns')
      return DEFAULT_VISIBLE_KEYS.filter((k) => !oldHidden.includes(k))
    }
  } catch { /* 存储损坏时回退默认 */ }
  return DEFAULT_VISIBLE_KEYS
}

export default function AlertList() {
  const navigate = useNavigate()
  const canExport = hasPermission('alert', 'export')
  const canStartTicket = hasPermission('ticket', 'edit')

  // 一键发起工单：携带告警上下文跳转工单中心，按流程字段映射自动预填
  const startTicket = (r) => {
    if (!guardNavPermission('ticket', 'view', '工单中心')) return
    const pickIp = (v) => {
      if (!v) return ''
      if (typeof v === 'string' && v.trim().startsWith('[')) {
        try { return JSON.parse(v)[0] || v } catch { return v }
      }
      return v
    }
    navigate('/tickets', {
      state: {
        alertPrefill: {
          alert: {
            id: r.id,
            uuid: r.uuid,
            alert_name: r.alert_name || '',
            occur_timestamp: r.occur_timestamp || '',
            device_type: r.device_type || '',
            src_ip: pickIp(r.src_ip),
            dst_ip: pickIp(r.dst_ip),
            host_ip: pickIp(r.host_ip),
            risk_level_name: r.risk_level_name || '',
            threat_class: r.threat_class || '',
            threat_type: r.threat_type || '',
            attack_state_name: r.attack_state_name || '',
            description: r.description || '',
            recommendation: r.recommendation || '',
            src_region_name: r.src_region_name || '',
            dst_region_name: r.dst_region_name || '',
            protocol: r.protocol || '',
          },
          title: `处置工单：${r.alert_name || r.uuid || ('#' + r.id)}`,
        },
      },
    })
  }

  // ===== 筛选状态（全部传后端）=====
  const now = useMemo(() => new Date(), [])
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  const [filters, setFilters] = useState({
    start_time: iso(new Date(now.getTime() - 24 * 3600 * 1000)),
    end_time: '',
    risk_levels: [], attack_states: [], deal_statuses: [], stages: [], directions: [],
    keyword: '', parse_status: '', device_type: '',
    sort: 'occur_timestamp', order: 'desc',
  })
  const [quickRange, setQuickRange] = useState('24h')
  // 支持 URL 参数预置过滤（监控页策略统计跳转：device_type / parse_status；
  // 告警规则统计卡下钻：start_time / end_time）
  const [searchParams] = useSearchParams()
  const urlDeviceType = searchParams.get('device_type') || ''
  const urlParseStatus = searchParams.get('parse_status') || ''
  const urlKeyword = searchParams.get('keyword') || ''
  const urlStartTime = searchParams.get('start_time') || ''
  const urlEndTime = searchParams.get('end_time') || ''
  useEffect(() => {
    if (urlDeviceType || urlParseStatus || urlKeyword || urlStartTime || urlEndTime) {
      setFilters((f) => ({
        ...f,
        device_type: urlDeviceType,
        parse_status: urlParseStatus,
        keyword: urlKeyword || f.keyword,
        ...(urlStartTime ? { start_time: urlStartTime, end_time: urlEndTime } : {}),
      }))
      if (urlStartTime) setQuickRange('')
    }
  }, [urlDeviceType, urlParseStatus, urlKeyword, urlStartTime, urlEndTime])

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [list, setList] = useState({ total: 0, items: [] })
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState([])
  const [deviceTypes, setDeviceTypes] = useState([]) // 已启用策略的设备类型
  const [drawerId, setDrawerId] = useState(null)
  const [users, setUsers] = useState([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [batchForm, setBatchForm] = useState({ to_status: 70, assignee_id: '', comment: '' })
  const canHandle = hasPermission('alert', 'handle')

  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }))
    setActiveScheme('') // 手动改动后与已存方案不再一致，清除方案标记
    setPage(1)
  }

  // ===== 列自定义（全量列注册表 + localStorage 持久化；告警名称/操作列固定显示） =====
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols)
  const [colOpen, setColOpen] = useState(false)
  const [colSearch, setColSearch] = useState('')
  const colRef = useRef(null)
  useEffect(() => {
    localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify({ v: COLS_STORAGE_VERSION, keys: visibleCols }))
  }, [visibleCols])
  useEffect(() => {
    const onDoc = (e) => { if (colRef.current && !colRef.current.contains(e.target)) setColOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const toggleCol = (key) => setVisibleCols((v) => (v.includes(key) ? v.filter((k) => k !== key) : [...v, key]))

  // 列选择器：搜索过滤 + 按分组归类（保持注册表顺序）
  const colGroups = useMemo(() => {
    const q = colSearch.trim().toLowerCase()
    const byCat = new Map()
    for (const c of COL_DEFS) {
      if (q && !c.header.toLowerCase().includes(q) && !c.key.toLowerCase().includes(q)) continue
      if (!byCat.has(c.cat)) byCat.set(c.cat, [])
      byCat.get(c.cat).push(c)
    }
    return [...byCat.entries()]
  }, [colSearch])

  // ===== 筛选方案（保存/应用/删除，localStorage 持久化） =====
  const [savedSchemes, setSavedSchemes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('alert-list-saved-filters')) || [] } catch { return [] }
  })
  const [activeScheme, setActiveScheme] = useState('')
  const [schemeSaveOpen, setSchemeSaveOpen] = useState(false)
  const [schemeName, setSchemeName] = useState('')
  const persistSchemes = (list) => {
    setSavedSchemes(list)
    localStorage.setItem('alert-list-saved-filters', JSON.stringify(list))
  }
  const applyScheme = (name) => {
    const s = savedSchemes.find((x) => x.name === name)
    if (!s) { setActiveScheme(''); return }
    setFilters({ ...s.filters })
    setQuickRange(s.quickRange || '')
    setActiveScheme(name)
    setPage(1)
  }
  const saveScheme = () => {
    const name = schemeName.trim()
    if (!name) { toast.error('请输入方案名称'); return }
    persistSchemes([...savedSchemes.filter((s) => s.name !== name), { name, filters: { ...filters }, quickRange }])
    setActiveScheme(name)
    setSchemeSaveOpen(false)
    setSchemeName('')
    toast.success(`筛选方案「${name}」已保存`)
  }
  const removeScheme = (name) => {
    persistSchemes(savedSchemes.filter((s) => s.name !== name))
    if (activeScheme === name) setActiveScheme('')
    toast.success(`方案「${name}」已删除`)
  }

  // ===== 高级筛选（默认收起，避免筛选控件挤在一行） =====
  const [showMoreFilters, setShowMoreFilters] = useState(false)

  const setQuick = (key) => {
    setQuickRange(key)
    const nowD = new Date()
    let st = null
    if (key === '1h') st = new Date(nowD.getTime() - 3600 * 1000)
    else if (key === '24h') st = new Date(nowD.getTime() - 24 * 3600 * 1000)
    else if (key === 'today') st = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate())
    else if (key === '7d') st = new Date(nowD.getTime() - 7 * 24 * 3600 * 1000)
    if (st) setF({ start_time: iso(st), end_time: '' })
  }

  const load = useCallback(() => {
    setLoading(true)
    alertApi.list(page, pageSize, filters)
      .then((res) => setList({ total: res.total || 0, items: res.items || [] }))
      .catch((e) => toast.error(e.message || '告警加载失败'))
      .finally(() => setLoading(false))
  }, [page, pageSize, filters])

  const loadStats = useCallback(() => {
    alertApi.stats()
      .then(setStats)
      .catch(() => { /* 卡片失败不打扰列表 */ })
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    loadStats()
    strategyApi.list().then((items) => {
      setDeviceTypes([...new Set((items || []).filter((s) => s.status === 'enabled').map((s) => s.device_type).filter(Boolean))])
    }).catch(() => {})
    if (canHandle) {
      usersApi.list().then((items) => {
        setUsers((items || []).filter((u) => u.is_active !== false))
      }).catch(() => {})
    }
  }, [loadStats])

  // 时间范围变化时重置到第 1 页
  useEffect(() => { setPage(1) }, [filters.start_time, filters.end_time])

  const handleSort = (key) => {
    if (key !== 'occur_timestamp' && key !== 'risk_level' && key !== 'severity') return
    if (filters.sort === key) {
      setF({ order: filters.order === 'desc' ? 'asc' : 'desc' })
    } else {
      setF({ sort: key, order: 'desc' })
    }
  }

  const handleExport = () => {
    setExporting(true)
    alertApi.export(filters)
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `告警列表_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString().slice(-6)}.csv`
        a.click()
        URL.revokeObjectURL(url)
        toast.success(`已导出 ${list.total} 条告警记录`)
      })
      .catch((e) => toast.error(e.message || '导出失败'))
      .finally(() => setExporting(false))
  }

  const submitBatchHandle = () => {
    if (!selected.length) { toast.error('请先勾选告警'); return }
    setBatchSubmitting(true)
    alertApi.batchHandle({
      alert_ids: selected,
      to_status: batchForm.to_status,
      assignee_id: batchForm.assignee_id ? Number(batchForm.assignee_id) : null,
      comment: batchForm.comment,
    }).then((res) => {
      const ok = res.succeeded?.length || 0
      const skip = res.skipped?.length || 0
      toast.success(`处置完成：成功 ${ok} 条${skip ? `，跳过 ${skip} 条（状态不允许）` : ''}`)
      setSelected([])
      setBatchOpen(false)
      setBatchForm({ to_status: 70, assignee_id: '', comment: '' })
      load()
    }).catch((e) => toast.error(e.message || '批量处置失败'))
    .finally(() => setBatchSubmitting(false))
  }

  const resetFilters = () => {
    setFilters({
      start_time: iso(new Date(Date.now() - 24 * 3600 * 1000)), end_time: '',
      risk_levels: [], attack_states: [], deal_statuses: [], stages: [], directions: [],
      keyword: '', parse_status: '', device_type: '',
      sort: 'occur_timestamp', order: 'desc',
    })
    setQuickRange('24h')
    setPage(1)
  }

  const SortHeader = ({ label, sortKey, align }) => {
    const active = filters.sort === sortKey
    return (
      <button
        className={`flex items-center gap-1 font-semibold transition hover:text-primary ${align === 'right' ? 'flex-row-reverse ml-auto' : ''} ${active ? 'text-primary' : ''}`}
        onClick={() => handleSort(sortKey)}
      >
        {label}
        <ChevronDown className={`h-3 w-3 transition ${active && filters.order === 'asc' ? 'rotate-180' : ''} ${active ? 'opacity-100' : 'opacity-30'}`} />
      </button>
    )
  }

  // 固定列：告警名称（首列，聚合计数 > 1 时展示累计条数徽标）+ 操作（末列）；中间列来自全量注册表按用户勾选
  const alertNameCol = {
    key: 'alert_name', header: '告警名称', width: '220px',
    render: (r) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <button
          className="max-w-[168px] truncate text-left font-medium text-foreground transition hover:text-primary"
          title={r.alert_name || r.log_type || ''}
          onClick={(e) => { e.stopPropagation(); setDrawerId(r.id) }}
        >
          {r.alert_name || r.log_type || '--'}
        </button>
        {r.aggregation_count > 1 && (
          <span
            className="inline-flex shrink-0 items-center rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10.5px] font-medium text-primary"
            title={`同类告警聚合：${r.aggregation_count} 条合并展示`}
          >
            ×{r.aggregation_count.toLocaleString('zh-CN')}
          </span>
        )}
      </span>
    ),
  }
  const actionsCol = {
    key: 'actions', header: '操作', width: canStartTicket && canExport ? '165px' : (canStartTicket || canExport ? '125px' : '90px'),
    render: (r) => (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn-secondary btn-sm" title="详情" onClick={() => setDrawerId(r.id)}>
          <Search className="h-3.5 w-3.5" />
        </button>
        {canStartTicket && (
          <button type="button" className="btn-secondary btn-sm" title="发起工单（按流程字段映射自动预填）" onClick={() => startTicket(r)}>
            <ClipboardCheck className="h-3.5 w-3.5" />
          </button>
        )}
        {canExport && (
          <button type="button" className="btn-secondary btn-sm" title="导出当前筛选" onClick={handleExport}>
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    ),
  }

  const hasActiveFilters = filters.risk_levels.length || filters.attack_states.length || filters.deal_statuses.length
    || filters.stages.length || filters.directions.length || filters.keyword || filters.parse_status || filters.device_type
    || filters.end_time

  // 可见列：告警名称（固定）+ 注册表勾选列（注册表顺序）+ 操作（固定）
  const visibleColumns = [alertNameCol, ...COL_DEFS.filter((c) => visibleCols.includes(c.key)), actionsCol]

  // 高级筛选中的激活条件数（「更多筛选」按钮徽标）
  const advancedActiveCount = (
    (filters.risk_levels.length ? 1 : 0) + (filters.attack_states.length ? 1 : 0)
    + (filters.deal_statuses.length ? 1 : 0) + (filters.stages.length ? 1 : 0)
    + (filters.directions.length ? 1 : 0) + (filters.parse_status ? 1 : 0)
    + (filters.device_type ? 1 : 0)
  )

  // 当前激活筛选的可视化标签（逐个可移除；一眼看清当前过滤了什么）
  const filterChips = useMemo(() => {
    const chips = []
    const multiDefs = [
      ['risk_levels', '风险等级', RISK_LEVELS],
      ['attack_states', '攻击状态', ATTACK_STATES],
      ['deal_statuses', '处置状态', DEAL_STATUSES],
      ['stages', '告警阶段', STAGES],
      ['directions', '访问方向', DIRECTIONS],
    ]
    for (const [key, label, options] of multiDefs) {
      const vals = filters[key] || []
      if (vals.length) {
        const names = vals.map((v) => options.find((o) => o.v === v)?.label || v).join('、')
        chips.push({ key, text: `${label}: ${names}`, clear: () => setF({ [key]: [] }) })
      }
    }
    if (filters.parse_status) {
      chips.push({ key: 'parse_status', text: `解析状态: ${PARSE_STATUSES.find((o) => o.v === filters.parse_status)?.label || filters.parse_status}`, clear: () => setF({ parse_status: '' }) })
    }
    if (filters.device_type) {
      chips.push({ key: 'device_type', text: `设备类型: ${filters.device_type}`, clear: () => setF({ device_type: '' }) })
    }
    if (filters.keyword) {
      chips.push({ key: 'keyword', text: `关键词: ${filters.keyword}`, clear: () => setF({ keyword: '' }) })
    }
    if (!quickRange && (filters.start_time || filters.end_time)) {
      chips.push({ key: 'time', text: `自定义时间段`, clear: () => setQuick('24h') })
    }
    return chips
  }, [filters, quickRange])

  // 状态指标条统计：从当前页数据派生（列表为服务端分页，计数仅代表当前页分布）
  const pageStats = useMemo(() => {
    const risk = {}
    const deal = {}
    for (const r of list.items) {
      risk[r.risk_level] = (risk[r.risk_level] || 0) + 1
      // -1/null 与 0 同为「未处置」
      const ds = r.deal_status == null || r.deal_status === -1 ? 0 : r.deal_status
      deal[ds] = (deal[ds] || 0) + 1
    }
    return { risk, deal }
  }, [list.items])

  // chip 点击：在对应多选筛选中切换该值（再点取消）
  const toggleChipFilter = (key, v) => {
    const cur = filters[key] || []
    setF({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] })
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">告警列表</h1>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{fmtNum(list.total)}</span> 条告警
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新告警列表">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          {canExport && (
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className="btn-primary btn-sm"
              title="按当前筛选条件导出 CSV"
            >
              <Download className={`mr-1 h-3.5 w-3.5 ${exporting ? 'animate-spin' : ''}`} /> 导出 CSV
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">

      {/* 统计卡片（可点击下钻：切换时间范围 / 应用风险等级筛选 / 跳转错误队列） */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          loading={loading && !stats}
          icon={BellRing}
          label="今日告警总数"
          value={fmtNum(stats?.today_total)}
          delta={stats?.delta}
          spark={stats?.trend_24h}
          clickable
          active={quickRange === 'today' && filters.risk_levels.length === 0}
          title="时间范围切换到「今天」，查看全部今日告警（点击查看）"
          onClick={() => { setQuick('today'); setF({ risk_levels: [] }) }}
        />
        <StatCard
          loading={loading && !stats}
          icon={Flame}
          label="今日高危及以上"
          value={fmtNum(stats?.today_high)}
          valueClass="text-warning"
          clickable
          active={quickRange === 'today' && filters.risk_levels.length === 2 && [0, 1].every((v) => filters.risk_levels.includes(v))}
          title="时间范围「今天」+ 风险等级筛选为严重/高危（点击查看）"
          onClick={() => { setQuick('today'); setF({ risk_levels: [0, 1] }) }}
        />
        <StatCard
          loading={loading && !stats}
          icon={AlertOctagon}
          label="解析失败数"
          value={fmtNum(stats?.today_fail)}
          valueClass={(stats?.today_fail ?? 0) > 0 ? 'text-destructive' : 'text-foreground'}
          clickable
          title="查看解析错误队列（点击查看）"
          onClick={() => navigate('/ingest-monitor?tab=errors')}
        />
        <StatCard loading={loading && !stats} icon={MonitorSmartphone} label="接入设备类型数" value={fmtNum(stats?.device_type_count)} />
      </div>

      {/* 筛选区：第一行常用筛选（时间 + 关键词 + 方案），高级筛选收纳展开，激活条件以标签展示 */}
      <Card className="mb-4" bodyClassName="p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* 时间范围快捷 */}
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1">
            {[['1h', '1小时'], ['24h', '24小时'], ['today', '今天'], ['7d', '7天']].map(([key, label]) => (
              <button
                key={key}
                className={`rounded-md px-2.5 py-1 text-xs transition ${quickRange === key ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setQuick(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <DatePicker
            type="datetime"
            className="w-[185px]"
            value={filters.start_time}
            onChange={(e) => { setQuickRange(''); setF({ start_time: e.target.value }) }}
            title="开始时间（基于发生时间）"
          />
          <span className="text-xs text-muted-foreground">至</span>
          <DatePicker
            type="datetime"
            className="w-[185px]"
            value={filters.end_time}
            onChange={(e) => { setQuickRange(''); setF({ end_time: e.target.value }) }}
            title="结束时间"
          />
          <input
            className={`${inputBaseCls} h-[34px] min-w-[180px] flex-1`}
            placeholder="搜索：源IP / 目的IP / 告警名称"
            value={filters.keyword}
            onChange={(e) => setF({ keyword: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') load() }}
          />

          {/* 高级筛选展开/收起（有激活条件时显示计数徽标） */}
          <Button
            size="sm"
            variant={showMoreFilters ? 'primary' : 'secondary'}
            onClick={() => setShowMoreFilters((v) => !v)}
            title="展开或收起高级筛选"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> 更多筛选
            {advancedActiveCount > 0 && (
              <span className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${showMoreFilters ? 'bg-white/25' : 'bg-primary/15 text-primary'}`}>
                {advancedActiveCount}
              </span>
            )}
          </Button>

          {/* 筛选方案：下拉应用 / 保存当前 / 删除 */}
          <div className="flex items-center gap-1.5">
            <CompactSelect
              size="lg"
              className="w-[128px]"
              value={activeScheme}
              onChange={(e) => applyScheme(e.target.value)}
              title="应用已保存的筛选方案"
            >
              <option value="">已存方案…</option>
              {savedSchemes.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </CompactSelect>
            <Button size="sm" variant="secondary" onClick={() => setSchemeSaveOpen(true)} title="把当前筛选保存为方案，下次一键应用">
              <Bookmark className="h-3.5 w-3.5" /> 保存
            </Button>
            {activeScheme && (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                title={`删除方案「${activeScheme}」`}
                onClick={() => removeScheme(activeScheme)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          {hasActiveFilters ? (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={resetFilters}>清除筛选</Button>
          ) : null}
        </div>

        {/* 高级筛选（默认收起；展开后单行排布，避免全部挤在第一行） */}
        {showMoreFilters && (
          <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-border pt-3">
            <MultiSelect placeholder="风险等级" options={RISK_LEVELS} values={filters.risk_levels} onChange={(v) => setF({ risk_levels: v })} />
            <MultiSelect placeholder="攻击状态" options={ATTACK_STATES} values={filters.attack_states} onChange={(v) => setF({ attack_states: v })} />
            <MultiSelect placeholder="处置状态" options={DEAL_STATUSES} values={filters.deal_statuses} onChange={(v) => setF({ deal_statuses: v })} />
            <MultiSelect placeholder="告警阶段" options={STAGES} values={filters.stages} onChange={(v) => setF({ stages: v })} />
            <MultiSelect placeholder="访问方向" options={DIRECTIONS} values={filters.directions} onChange={(v) => setF({ directions: v })} />
            <CompactSelect size="lg" className="w-[118px]" value={filters.parse_status} onChange={(e) => setF({ parse_status: e.target.value })}>
              <option value="">解析状态</option>
              {PARSE_STATUSES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </CompactSelect>
            <CompactSelect size="lg" className="w-[150px]" value={filters.device_type} onChange={(e) => setF({ device_type: e.target.value })}>
              <option value="">全部设备类型</option>
              {deviceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </CompactSelect>
          </div>
        )}

        {/* 激活筛选标签（当前过滤一目了然，可单独移除） */}
        {filterChips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">当前筛选：</span>
            {filterChips.map((c) => (
              <span
                key={c.key}
                className="inline-flex max-w-[260px] items-center gap-1 rounded-full border border-primary/30 bg-primary/5 py-0.5 pl-2.5 pr-1 text-xs text-foreground"
                title={c.text}
              >
                <span className="truncate">{c.text}</span>
                <button
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  title="移除该筛选"
                  onClick={c.clear}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* 状态指标条：风险等级 / 处置状态 点击快速筛选（计数为当前页分布）+ 今日汇总 */}
      {!loading && list.items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">本页分布：</span>
          {RISK_CHIPS.map((chip) => {
            const active = filters.risk_levels.includes(chip.v)
            const count = pageStats.risk[chip.v] || 0
            return (
              <button
                key={`risk-${chip.v}`} type="button"
                onClick={() => toggleChipFilter('risk_levels', chip.v)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                  active
                    ? `border-transparent ring-1 ${chip.active}`
                    : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
                title={active ? '点击取消该筛选' : `点击筛选「${chip.label}」级告警`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${chip.pulse && count > 0 ? 'animate-pulse' : ''}`} />
                {chip.label}
                <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
              </button>
            )
          })}
          <span className="mx-1 h-4 w-px bg-border" />
          {DEAL_CHIPS.map((chip) => {
            const active = filters.deal_statuses.includes(chip.v)
            const count = pageStats.deal[chip.v] || 0
            return (
              <button
                key={`deal-${chip.v}`} type="button"
                onClick={() => toggleChipFilter('deal_statuses', chip.v)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                  active
                    ? `border-transparent ring-1 ${chip.active}`
                    : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
                title={active ? '点击取消该筛选' : `点击筛选「${chip.label}」的告警`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
                {chip.label}
                <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
              </button>
            )
          })}
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5" title="今日 0 点至现在的告警总数">
              <BellRing className="h-3.5 w-3.5 text-primary/80" />
              今日告警
              <span className={`font-semibold tabular-nums ${stats?.today_total > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                {stats?.today_total > 0 ? stats.today_total.toLocaleString('zh-CN') : '--'}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5" title="今日「严重 / 高危」级告警数">
              <Flame className="h-3.5 w-3.5 text-primary/80" />
              今日高危及以上
              <span className={`font-semibold tabular-nums ${stats?.today_high > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                {stats?.today_high > 0 ? stats.today_high.toLocaleString('zh-CN') : '--'}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* 告警表格（后端分页；表头工具行含列自定义） */}
      <Card className="p-0" bodyClassName="p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            共 <span className="font-medium tabular-nums text-foreground">{fmtNum(list.total)}</span> 条告警
            {selected.length > 0 && <span className="ml-2 text-primary">已选 {selected.length} 条</span>}
          </span>
          {/* 显示列选择器（全量字段可选；搜索 + 分组 + 滚动；选择结果存本机，下次进入保持） */}
          <div className="relative" ref={colRef}>
            <Button size="sm" variant="ghost" onClick={() => setColOpen((v) => !v)} title="自定义列表显示的列（标准模型全部字段可选）">
              <Columns3 className="h-3.5 w-3.5" /> 显示列
              <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums text-primary">
                {visibleCols.length}/{COL_DEFS.length}
              </span>
            </Button>
            {colOpen && (
              <div className="absolute right-0 top-9 z-dropdown w-80 rounded-lg border border-border bg-popover p-2 shadow-lg">
                <input
                  className={`${inputBaseCls} mb-1.5 h-8 w-full text-xs`}
                  placeholder="搜索列名…"
                  value={colSearch}
                  onChange={(e) => setColSearch(e.target.value)}
                  autoFocus
                />
                <div className="max-h-[360px] overflow-y-auto">
                  {colGroups.map(([cat, cols]) => (
                    <div key={cat} className="mb-1">
                      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{cat}</div>
                      {cols.map((c) => {
                        const shown = visibleCols.includes(c.key)
                        return (
                          <button
                            key={c.key}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-accent"
                            onClick={() => toggleCol(c.key)}
                          >
                            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${shown ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                              {shown && <Check className="h-3 w-3" />}
                            </span>
                            <span className="truncate">{c.header}</span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {colGroups.length === 0 && (
                    <div className="px-2 py-4 text-center text-xs text-muted-foreground">没有匹配的列</div>
                  )}
                </div>
                <div className="mt-1 flex items-center justify-between border-t border-border px-2 pt-2">
                  <span className="text-[11px] text-muted-foreground">已显示 {visibleCols.length} / {COL_DEFS.length} 列</span>
                  <button
                    className="text-xs text-primary transition hover:underline"
                    onClick={() => setVisibleCols(DEFAULT_VISIBLE_KEYS)}
                  >
                    恢复默认
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <DataTable
          className="table-stagger"
          columns={visibleColumns}
          data={list.items}
          loading={loading}
          rowKey="id"
          selectable={canHandle}
          selectedKeys={selected}
          onSelectChange={setSelected}
          onRowClick={(r) => setDrawerId(r.id)}
          emptyText={hasActiveFilters ? '未找到匹配的告警' : '暂无告警'}
          emptyDescription={
            hasActiveFilters
              ? '当前筛选条件下没有匹配的告警，调整时间范围或清除筛选后再试'
              : '当前时间范围内没有匹配的告警记录；设备未接入、解析失败或时间范围过窄都可能导致为空'
          }
          emptyIcon={ShieldCheck}
          emptyAction={(
            hasActiveFilters ? (
              <button type="button" onClick={resetFilters} className="btn-secondary btn-sm">清除筛选</button>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button type="button" onClick={() => navigate('/alert-rules')} className="btn-primary btn-sm">
                    <ScrollText className="mr-1 h-3.5 w-3.5" /> 查看告警规则
                  </button>
                  <button type="button" onClick={() => setQuick('7d')} className="btn-secondary btn-sm">
                    <CalendarRange className="mr-1 h-3.5 w-3.5" /> 扩大时间范围（7 天）
                  </button>
                  <button type="button" onClick={() => navigate('/ingest-monitor?tab=errors')} className="btn-secondary btn-sm">
                    <AlertOctagon className="mr-1 h-3.5 w-3.5" /> 查看解析失败
                  </button>
                </div>
                <span className="text-xs text-muted-foreground">排查建议：确认接收器已监听且设备日志已到达；解析失败的日志会进入错误队列</span>
              </div>
            )
          )}
        />
        <div className="px-4">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={list.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            pageSizeOptions={[10, 20, 50, 100]}
          />
        </div>
      </Card>

      {/* 详情抽屉（60% 宽，Tab） */}
      <AlertDetailDrawer
        open={drawerId != null}
        alertId={drawerId}
        onClose={() => setDrawerId(null)}
        onHandled={load}
      />

      {/* 批量处置浮窗 */}
      {canHandle && selected.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-3 shadow-2xl">
            <span className="text-sm font-medium text-foreground">已选 {selected.length} 条告警</span>
            <Button size="sm" variant="primary" onClick={() => setBatchOpen(true)}>
              <ShieldCheck className="h-3.5 w-3.5" /> 批量处置
            </Button>
            <button className="text-muted-foreground transition hover:text-foreground" onClick={() => setSelected([])}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 保存筛选方案弹窗 */}
      <Modal
        open={schemeSaveOpen}
        title="保存筛选方案"
        onClose={() => setSchemeSaveOpen(false)}
        maxWidth="max-w-sm"
        footer={(
          <>
            <button className="btn-secondary" onClick={() => setSchemeSaveOpen(false)}>取消</button>
            <button className="btn-primary btn-sm" onClick={saveScheme}>保存方案</button>
          </>
        )}
      >
        <label className="mb-1 block text-xs text-muted-foreground">方案名称</label>
        <input
          className={inputBaseCls}
          value={schemeName}
          onChange={(e) => setSchemeName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveScheme() }}
          placeholder="如：高危未处置（近 7 天）"
          autoFocus
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          保存当前时间范围、筛选条件与排序，下次从「已存方案」下拉一键应用；同名方案将被覆盖。方案保存在本机浏览器中。
        </p>
      </Modal>

      {/* 批量处置弹窗 */}
      {batchOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setBatchOpen(false)} />
          <div className="relative w-[480px] rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h3 className="mb-4 text-base font-semibold text-foreground">批量处置告警</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">目标处置状态</label>
                <CompactSelect
                  size="lg"
                  block
                  value={batchForm.to_status}
                  onChange={(e) => setBatchForm((f) => ({ ...f, to_status: Number(e.target.value) }))}
                >
                  {DEAL_STATUS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </CompactSelect>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">指派处理人（可选）</label>
                <CompactSelect
                  size="lg"
                  block
                  value={batchForm.assignee_id}
                  onChange={(e) => setBatchForm((f) => ({ ...f, assignee_id: e.target.value }))}
                >
                  <option value="">不指派</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                </CompactSelect>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">处置备注</label>
                <textarea
                  className={`${inputBaseCls} min-h-[60px] w-full resize-none`}
                  placeholder="输入处置备注..."
                  value={batchForm.comment}
                  onChange={(e) => setBatchForm((f) => ({ ...f, comment: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setBatchOpen(false)}>取消</Button>
              <Button variant="primary" loading={batchSubmitting} onClick={submitBatchHandle}>
                确认处置
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
